#!/usr/bin/env python3
"""
Bake NSE history from Upstox into static JSON the terminal can read directly.

WHY THIS EXISTS
---------------
index.html is a static page on GitHub Pages. It cannot call Upstox: Upstox
sends no Access-Control-Allow-Origin header to a browser, and its token needs
a secret that must never sit in a public repo. So the token stays here, in
GitHub Actions, and this script bakes the answers into data/nse/*.json. The
page then fetches those files SAME-ORIGIN — no CORS, no proxy, no credential
ever reaching the browser. Same pattern scanX already uses for quotes.json.

The payoff is the gap Yahoo cannot fill: Yahoo's ^NSEI starts 2007-09, Upstox
starts Jan 2000. That is seven extra years on the single most important
instrument in the app.

USAGE
    UPSTOX_ACCESS_TOKEN=... python scripts/fetch_upstox.py
    UPSTOX_ACCESS_TOKEN=... python scripts/fetch_upstox.py --stocks RELIANCE,TCS
"""

import argparse
import gzip
import io
import json
import os
import sys
import time
from datetime import date, datetime, timedelta
from urllib.parse import quote
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

# Upstox sits behind Cloudflare, which rejects the stdlib's default
# "Python-urllib/3.x" agent with error 1010 (browser integrity check) before
# the request ever reaches the API. A normal agent string is required.
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")

UPSTOX = "https://api.upstox.com"
INSTRUMENTS_URL = "https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz"
START = "2000-01-01"          # Upstox's own floor for day/week/month candles
OUT_DIR = os.path.join("data", "nse")

# Indices carry Upstox's own names and live in a different segment from equities.
INDICES = {
    "NIFTY":      "NSE_INDEX|Nifty 50",
    "BANKNIFTY":  "NSE_INDEX|Nifty Bank",
    "FINNIFTY":   "NSE_INDEX|Nifty Fin Service",
    "MIDCPNIFTY": "NSE_INDEX|NIFTY MID SELECT",
    "NIFTYNXT50": "NSE_INDEX|Nifty Next 50",
    "SENSEX":     "BSE_INDEX|SENSEX",
}


def token() -> str:
    for name in ("UPSTOX_ACCESS_TOKEN", "UPSTOX_FUNDAMENTAL_ANALYTICS_TOKEN"):
        v = os.environ.get(name, "").strip()
        if v:
            return v
    sys.exit("No token. Set UPSTOX_ACCESS_TOKEN (or UPSTOX_FUNDAMENTAL_ANALYTICS_TOKEN).")


def get(url: str, tok: str, tries: int = 3):
    """GET with the bearer token. Retries transient failures; 401 is fatal and
    said plainly, because it always means the daily token lapsed."""
    req = Request(url, headers={"Authorization": f"Bearer {tok}",
                                "Accept": "application/json",
                                "User-Agent": UA})
    for attempt in range(tries):
        try:
            with urlopen(req, timeout=45) as r:
                return json.loads(r.read().decode("utf-8"))
        except HTTPError as e:
            if e.code == 401:
                sys.exit("Upstox returned 401 — the token has expired. "
                         "Refresh the UPSTOX_ACCESS_TOKEN repository secret.")
            if e.code == 429 or e.code >= 500:
                time.sleep(2 * (attempt + 1))
                continue
            body = e.read().decode("utf-8", "replace")[:200]
            raise RuntimeError(f"HTTP {e.code}: {body}")
        except (URLError, TimeoutError):
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"gave up after {tries} attempts: {url}")


_master = None
def resolve(sym: str) -> str:
    """NSE tradingsymbol -> Upstox instrument_key. Equity keys are ISIN-based
    and cannot be derived from the symbol, so the instrument master is needed."""
    global _master
    s = sym.strip().upper()
    if "|" in s:
        return s
    if s in INDICES:
        return INDICES[s]
    if _master is None:
        sys.stderr.write("fetching instrument master ... ")
        with urlopen(Request(INSTRUMENTS_URL, headers={"User-Agent": UA}), timeout=120) as r:
            raw = r.read()
        rows = json.loads(gzip.GzipFile(fileobj=io.BytesIO(raw)).read().decode("utf-8"))
        _master = {}
        for i in rows:
            if i.get("segment") not in ("NSE_EQ", "BSE_EQ"):
                continue
            if i.get("instrument_type") not in (None, "EQ"):
                continue
            t = (i.get("trading_symbol") or i.get("tradingsymbol") or "").upper()
            if t and (t not in _master or i["segment"] == "NSE_EQ"):
                _master[t] = i["instrument_key"]
        sys.stderr.write(f"{len(_master)} equities\n")
    if s not in _master:
        raise KeyError(f"unknown symbol: {s}")
    return _master[s]


def candles(key: str, unit: str, interval: str, start: str, tok: str):
    """Upstox caps a daily request at one decade, so walk backwards in chunks
    and stitch. Weekly and monthly have no cap but the same loop is harmless."""
    today = date.today().isoformat()
    out, cursor_to, guard = [], today, 0
    while guard < 12:
        guard += 1
        to_y = int(cursor_to[:4])
        chunk_from = start
        if unit == "days" and to_y - int(start[:4]) > 9:
            chunk_from = f"{to_y - 9}{cursor_to[4:]}"
        # instrument keys carry a pipe and often a space ("NSE_INDEX|Nifty 50"),
        # neither of which is legal unescaped in a URL path
        url = (f"{UPSTOX}/v3/historical-candle/{quote(key, safe='')}"
               f"/{unit}/{interval}/{cursor_to}/{chunk_from}")
        body = get(url, tok)
        rows = ((body or {}).get("data") or {}).get("candles") or []
        if not rows:
            break
        out.extend(rows)
        if chunk_from <= start:
            break
        cursor_to = (datetime.strptime(chunk_from, "%Y-%m-%d").date() - timedelta(days=1)).isoformat()
        if cursor_to < start:
            break

    seen, asc = set(), []
    for c in sorted(out, key=lambda r: str(r[0])):
        d = str(c[0])[:10]
        if d in seen or d < start:
            continue
        seen.add(d)
        try:
            o, h, l, cl = float(c[1]), float(c[2]), float(c[3]), float(c[4])
        except (TypeError, ValueError):
            continue
        if cl <= 0:
            continue
        # compact rows: [date, o, h, l, c] — objects would triple the file size
        asc.append([d, round(o, 2), round(h, 2), round(l, 2), round(cl, 2)])
    return asc



def bake_intraday(sym, tok, start_year=2022):
    """5-minute candles, one file per calendar year.

    Sharded deliberately: a single 4-year file would be several MB and git
    would store a fresh copy of the whole thing on every weekly run. With year
    shards only the current year's file ever changes, so history stays small.
    Upstox serves minute data from Jan 2022 and caps a minute request at one
    month, so each year is walked month by month.
    """
    key = resolve(sym)
    this_year = date.today().year
    written = []
    for yr in range(start_year, this_year + 1):
        rows, m = [], 1
        while m <= 12:
            frm = f"{yr}-{m:02d}-01"
            nxt = date(yr + 1, 1, 1) if m == 12 else date(yr, m + 1, 1)
            to = (nxt - timedelta(days=1)).isoformat()
            if frm > date.today().isoformat():
                break
            url = (f"{UPSTOX}/v3/historical-candle/{quote(key, safe='')}"
                   f"/minutes/5/{min(to, date.today().isoformat())}/{frm}")
            try:
                body = get(url, tok)
                for c in ((body or {}).get("data") or {}).get("candles") or []:
                    t = str(c[0])
                    try:
                        o, h, l, cl = float(c[1]), float(c[2]), float(c[3]), float(c[4])
                    except (TypeError, ValueError):
                        continue
                    if cl > 0:
                        # keep date + HH:MM only; the offset is always IST
                        rows.append([t[:10] + " " + t[11:16],
                                     round(o, 2), round(h, 2), round(l, 2), round(cl, 2)])
            except Exception as e:
                print(f"  {sym} {yr}-{m:02d} skipped: {e}", file=sys.stderr)
            m += 1
            time.sleep(0.3)
        if len(rows) < 200:
            print(f"  {sym} 5m {yr}: only {len(rows)} bars, skipped", file=sys.stderr)
            continue
        rows.sort(key=lambda r: r[0])
        seen, uniq = set(), []
        for r in rows:
            if r[0] in seen:
                continue
            seen.add(r[0]); uniq.append(r)
        path = os.path.join(OUT_DIR, f"{sym}_5m_{yr}.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"symbol": sym, "instrument_key": key, "interval": "5m", "year": yr,
                       "source": "upstox", "from": uniq[0][0], "to": uniq[-1][0],
                       "count": len(uniq), "bars": uniq}, f, separators=(",", ":"))
        written.append({"year": yr, "count": len(uniq), "from": uniq[0][0], "to": uniq[-1][0]})
        print(f"{sym} 5m {yr:<6} {len(uniq):>7} bars  {uniq[0][0]} -> {uniq[-1][0]}")
    return written

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stocks", default="", help="comma-separated NSE symbols to bake as well")
    ap.add_argument("--start", default=START)
    ap.add_argument("--intraday", default="", help="comma-separated symbols to also bake as 5-minute year shards")
    args = ap.parse_args()

    tok = token()
    os.makedirs(OUT_DIR, exist_ok=True)

    targets = list(INDICES.keys())
    targets += [s.strip().upper() for s in args.stocks.split(",") if s.strip()]

    manifest, failures = {}, []
    for sym in targets:
        try:
            key = resolve(sym)
            rows = candles(key, "days", "1", args.start, tok)
            if len(rows) < 100:
                raise RuntimeError(f"only {len(rows)} bars")
            path = os.path.join(OUT_DIR, f"{sym}.json")
            with open(path, "w", encoding="utf-8") as f:
                json.dump({"symbol": sym, "instrument_key": key, "interval": "1d",
                           "source": "upstox", "from": rows[0][0], "to": rows[-1][0],
                           "count": len(rows), "bars": rows}, f, separators=(",", ":"))
            manifest[sym] = {"from": rows[0][0], "to": rows[-1][0], "count": len(rows)}
            print(f"{sym:<12} {len(rows):>6} bars  {rows[0][0]} -> {rows[-1][0]}")
        except Exception as e:                     # one bad symbol must not kill the run
            failures.append(f"{sym}: {e}")
            print(f"{sym:<12} FAILED: {e}", file=sys.stderr)
        time.sleep(0.35)                           # stay well inside Upstox rate limits

    intraday = {}
    for sym in [x.strip().upper() for x in args.intraday.split(",") if x.strip()]:
        try:
            got = bake_intraday(sym, tok)
            if got:
                intraday[sym] = got
        except Exception as e:                 # intraday is a bonus, never fatal
            print(f"{sym} 5m FAILED: {e}", file=sys.stderr)
            failures.append(f"{sym} 5m: {e}")

    if not manifest:
        sys.exit("nothing baked — every symbol failed")

    with open(os.path.join(OUT_DIR, "_index.json"), "w", encoding="utf-8") as f:
        json.dump({"generated": datetime.utcnow().isoformat(timespec="seconds") + "Z",
                   "source": "upstox v3 historical-candle",
                   "instruments": manifest, "intraday": intraday,
                   "failures": failures}, f, indent=1)

    print(f"\nbaked {len(manifest)} instruments into {OUT_DIR}/")
    if failures:
        print(f"{len(failures)} failed: {'; '.join(failures[:5])}")


if __name__ == "__main__":
    main()
