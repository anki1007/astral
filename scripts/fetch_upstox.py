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

ROW SHAPE
---------
Daily rows are [date, o, h, l, c, v]: index 5 is VOLUME, 0 when unknown. It is
appended, never inserted, because every reader in the page indexes [0..4] and
must keep working untouched. scripts/fetch_yahoo.py writes the same six-column
daily row, so the two stores are interchangeable column for column.
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

# The Actions runner keeps UTC. NSE keeps IST. date.today() on the runner is
# the wrong calendar day for five and a half hours out of every twenty-four,
# so every "today" in this file is the IST one.
IST = timedelta(hours=5, minutes=30)


def ist_now() -> datetime:
    return datetime.utcnow() + IST


def ist_today() -> str:
    return ist_now().date().isoformat()

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


def _ohlc(c):
    """One Upstox candle row -> (o, h, l, c) floats, or None when unusable."""
    try:
        o, h, l, cl = float(c[1]), float(c[2]), float(c[3]), float(c[4])
    except (TypeError, ValueError, IndexError):
        return None
    if cl <= 0 or h < l:
        return None
    return o, h, l, cl


def _vol(c):
    """Upstox candles carry volume at index 5 (open interest at 6). Indices
    report none, so an absent or unparseable figure is 0, not a failure."""
    try:
        return max(int(float(c[5])), 0)
    except (TypeError, ValueError, IndexError):
        return 0


def intraday_rows(key: str, tok: str):
    """The CURRENT session's 5-minute candles, oldest first, as compact rows.

    /historical-candle/ stops at the previous session: it does not return the
    day that is trading (or has just closed) until the following day. That one
    gap is why every baked file used to end at T-1, and at T-2 for the whole of
    day T until the evening bake landed. The intraday endpoint is the only
    place the current session exists, so it is folded in here.
    """
    try:
        j = get(f"{UPSTOX}/v3/historical-candle/intraday/{quote(key, safe='')}/minutes/5", tok)
    except Exception as e:                                   # never fatal
        print(f"  intraday {key}: {e}", file=sys.stderr)
        return []
    rows = []
    for c in (j.get("data") or {}).get("candles") or []:
        v = _ohlc(c)
        if v is None:
            continue
        t = str(c[0])
        rows.append([t[:10] + " " + t[11:16]] + [round(x, 2) for x in v])
    rows.sort(key=lambda r: r[0])
    return rows


def session_bar(key: str, tok: str, five=None):
    """Today's DAILY candle [date, o, h, l, c, v], or None before the first print.

    Asked of the intraday endpoint at days/1 first; if that unit is refused the
    same bar is rebuilt from the 5-minute candles, which is exact for OHLC.
    """
    try:
        j = get(f"{UPSTOX}/v3/historical-candle/intraday/{quote(key, safe='')}/days/1", tok, tries=2)
        for c in (j.get("data") or {}).get("candles") or []:
            v = _ohlc(c)
            if v is not None:
                return [str(c[0])[:10]] + [round(x, 2) for x in v] + [_vol(c)]
    except Exception:
        pass
    five = five if five is not None else intraday_rows(key, tok)
    if not five:
        return None
    day = five[-1][0][:10]
    rows = [r for r in five if r[0][:10] == day]
    # Rebuilt from 5-minute bars, which this script keeps OHLC-only, so the
    # session's volume is not recoverable here: 0 means unknown, as documented.
    return [day, rows[0][1], max(r[2] for r in rows), min(r[3] for r in rows), rows[-1][4], 0]


def candles(key: str, unit: str, interval: str, start: str, tok: str):
    """Upstox caps a daily request at one decade, so walk backwards in chunks
    and stitch. Weekly and monthly have no cap but the same loop is harmless."""
    today = ist_today()
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
        # compact rows: [date, o, h, l, c, v] — objects would triple the file
        # size. Index 5 is volume, 0 when the feed reports none (indices do).
        asc.append([d, round(o, 2), round(h, 2), round(l, 2), round(cl, 2), _vol(c)])

    # The session that is trading or has just closed - see intraday_rows().
    # Run mid-session this bar is partial; it heals itself, because the next
    # bake rebuilds the series and by then the historical endpoint has it.
    if unit == "days" and str(interval) == "1" and asc:
        bar = session_bar(key, tok)
        if bar and asc[-1][0] < bar[0] <= today:
            asc.append(bar)
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
    today = ist_today()
    this_year = int(today[:4])
    live5 = intraday_rows(key, tok)          # the current session, see above
    written = []
    for yr in range(start_year, this_year + 1):
        rows, m = [], 1
        while m <= 12:
            frm = f"{yr}-{m:02d}-01"
            nxt = date(yr + 1, 1, 1) if m == 12 else date(yr, m + 1, 1)
            to = (nxt - timedelta(days=1)).isoformat()
            if frm > today:
                break
            url = (f"{UPSTOX}/v3/historical-candle/{quote(key, safe='')}"
                   f"/minutes/5/{min(to, today)}/{frm}")
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
        if yr == this_year:
            rows.extend(r for r in live5 if r[0][:4] == str(yr))
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


def fno_symbols():
    """Every tradable symbol in F&o.csv, minus the index rows which are baked
    separately under their Upstox index names."""
    out = []
    try:
        with open("F&o.csv", encoding="utf-8") as f:
            next(f, None)
            for line in f:
                sym = line.split(",")[0].strip().upper()
                if sym and sym not in INDICES:
                    out.append(sym)
    except OSError as e:
        print(f"F&o.csv unreadable: {e}", file=sys.stderr)
    return out


def split_write(sym, key, rows):
    """Write a stock as a frozen base plus a small current-year file.

    Daily history never changes, but its tail grows every week. Writing one
    file per stock would make git store a fresh copy of all ~215 of them on
    every run — tens of MB a week. Splitting at the year boundary means the
    base is rewritten once a year and only the small recent file churns.
    """
    cut = f"{ist_today()[:4]}-01-01"
    base = [r for r in rows if r[0] < cut]
    recent = [r for r in rows if r[0] >= cut]
    if base:
        with open(os.path.join(OUT_DIR, f"{sym}.json"), "w", encoding="utf-8") as f:
            json.dump({"symbol": sym, "instrument_key": key, "interval": "1d",
                       "source": "upstox", "from": base[0][0], "to": base[-1][0],
                       "count": len(base), "bars": base}, f, separators=(",", ":"))
    if recent:
        with open(os.path.join(OUT_DIR, f"{sym}_recent.json"), "w", encoding="utf-8") as f:
            json.dump({"symbol": sym, "instrument_key": key, "interval": "1d",
                       "source": "upstox", "from": recent[0][0], "to": recent[-1][0],
                       "count": len(recent), "bars": recent}, f, separators=(",", ":"))


def bake_live(symbols, tok):
    """Today's 5-minute candles plus a quote snapshot, written to _live.json.

    The full history bake walks 26 years and takes minutes, which is fine
    weekly and impossible every quarter hour. This does the opposite: one
    intraday call and one quote call per symbol, a file measured in kilobytes,
    cheap enough to run right through the session.

    A static page cannot hold a broker token, so this is how live Upstox data
    reaches it — the token stays in Actions and only the resulting prices are
    published. Latency is the cron interval, not a tick feed.
    """
    today = ist_today()
    out = {"generated": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
           "source": "upstox", "date": today, "quotes": {}, "intraday": {}, "daily": {}}
    keys = {}
    for sym in symbols:
        try:
            keys[sym] = resolve(sym)
        except Exception as e:
            print(f"{sym:<12} resolve failed: {e}", file=sys.stderr)

    # Quotes: one batched call for everything we can resolve.
    if keys:
        try:
            qs = quote(",".join(keys.values()), safe="")
            j = get(f"{UPSTOX}/v2/market-quote/quotes?instrument_key={qs}", tok)
            by_key = {}
            for ik, v in (j.get("data") or {}).items():
                by_key[str(v.get("instrument_token") or ik)] = v
                by_key[str(ik)] = v
            for sym, k in keys.items():
                v = by_key.get(k) or by_key.get(k.replace("|", ":")) or None
                if v is None:
                    # Upstox echoes the key in its own punctuation; match on the tail.
                    tail = k.split("|")[-1].upper()
                    for kk, vv in by_key.items():
                        if kk.upper().endswith(tail):
                            v = vv
                            break
                if v is None:
                    continue
                o = v.get("ohlc") or {}
                last, chg = v.get("last_price"), v.get("net_change")
                # ohlc.close is THIS session's close once the market has shut,
                # so it equalled last_price all evening and the page showed a
                # flat 0.00% day. net_change is measured from the true previous
                # close, so that is where the previous close comes from.
                prev = o.get("close")
                if isinstance(last, (int, float)) and isinstance(chg, (int, float)):
                    prev = round(last - chg, 2)
                out["quotes"][sym] = {
                    "last": last, "open": o.get("open"),
                    "high": o.get("high"), "low": o.get("low"),
                    "prevClose": prev, "netChange": chg,
                    "ts": v.get("last_trade_time"),
                }
            print(f"quotes: {len(out['quotes'])}/{len(keys)}")
        except Exception as e:
            print(f"quotes FAILED: {e}", file=sys.stderr)

    # Intraday: the current session's 5-minute candles.
    for sym, k in keys.items():
        try:
            rows = intraday_rows(k, tok)
            if rows:
                out["intraday"][sym] = rows
                # The session's own daily bar, so the page can put today on a
                # DAILY chart without waiting for the evening history bake.
                day = rows[-1][0][:10]
                d = [r for r in rows if r[0][:10] == day]
                out["daily"][sym] = [day, d[0][1], max(r[2] for r in d),
                                     min(r[3] for r in d), d[-1][4]]
                print(f"{sym:<12} {len(rows):>4} intraday bars  {rows[0][0]} -> {rows[-1][0]}")
        except Exception as e:
            print(f"{sym:<12} intraday FAILED: {e}", file=sys.stderr)
        time.sleep(0.25)
    if out["intraday"]:
        # Stamp the file with the session it actually holds, not the wall clock:
        # a run before the open would otherwise label yesterday's bars as today.
        out["date"] = max(r[-1][0][:10] for r in out["intraday"].values())
    else:
        # No session today (weekend / holiday / before the open): the quotes
        # are the last session's, so date the file by their trade time.
        stamps = []
        for q in out["quotes"].values():
            try:
                stamps.append(datetime.utcfromtimestamp(int(q["ts"]) / 1000) + IST)
            except (KeyError, TypeError, ValueError):
                pass
        if stamps:
            out["date"] = max(stamps).date().isoformat()

    os.makedirs(OUT_DIR, exist_ok=True)
    with open(os.path.join(OUT_DIR, "_live.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stocks", default="", help="comma-separated NSE symbols to bake as well")
    ap.add_argument("--start", default=START)
    ap.add_argument("--intraday", default="", help="comma-separated symbols to also bake as 5-minute year shards")
    ap.add_argument("--live", default="", help="comma-separated symbols for the cheap intraday+quote snapshot; skips the history bake")
    args = ap.parse_args()

    tok = token()
    os.makedirs(OUT_DIR, exist_ok=True)

    if args.live.strip():
        syms = [x.strip().upper() for x in args.live.split(",") if x.strip()]
        got = bake_live(syms, tok)
        print(f"_live.json written: {len(got['quotes'])} quotes, {len(got['intraday'])} intraday")
        return

    targets = list(INDICES.keys())
    if args.stocks.strip().lower() == "all":
        targets += fno_symbols()
    else:
        targets += [s.strip().upper() for s in args.stocks.split(",") if s.strip()]

    manifest, failures = {}, []
    for sym in targets:
        try:
            key = resolve(sym)
            rows = candles(key, "days", "1", args.start, tok)
            if len(rows) < 100:
                raise RuntimeError(f"only {len(rows)} bars")
            if sym in INDICES:
                with open(os.path.join(OUT_DIR, f"{sym}.json"), "w", encoding="utf-8") as f:
                    json.dump({"symbol": sym, "instrument_key": key, "interval": "1d",
                               "source": "upstox", "from": rows[0][0], "to": rows[-1][0],
                               "count": len(rows), "bars": rows}, f, separators=(",", ":"))
            else:
                split_write(sym, key, rows)
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
