#!/usr/bin/env python3
"""
Bake daily history for the non-NSE instruments into data/yahoo/*.json.

WHY THIS EXISTS
---------------
The page reaches Yahoo only through free CORS relays, and by September 2026
all but one of those relays were down or rate-limited — and the survivor is
too slow for a 26-year payload. So Gold, Silver, the US indices and the other
commodities could not be forecast or backtested at all. A server has no CORS
problem, so this job fetches Yahoo directly after each close and publishes the
result next to the NSE files, in the same compact shape. The page reads it
same-origin and only falls back to a relay for bars newer than the bake.

No credential is involved: Yahoo's chart endpoint is public.

WHAT IT WRITES
--------------
    data/yahoo/<KEY>.json        daily,    full history, rows [date,o,h,l,c,v]
    data/yahoo/<KEY>_60m.json    hourly,   last 730d,    rows ["YYYY-MM-DD HH:MM",o,h,l,c,v]
    data/yahoo/<KEY>_5m.json     5-minute, last 60d,     rows ["YYYY-MM-DD HH:MM",o,h,l,c,v]
    data/yahoo/_index.json       per instrument per interval: from / to / count

Row index 5 is VOLUME, 0 when the feed does not report one. Cash indices and
index futures routinely report 0 on intraday bars; that is "no volume", not an
error. Every existing reader indexes [0..4] only, so appending it is safe.

Intraday stamps are EXCHANGE-LOCAL wall clock (from meta.gmtoffset), matching
the IST convention of the NSE 5-minute shards, so one client-side parser
serves both stores.

Yahoo's own ceilings, verified: interval=5m accepts range up to 60d, 60m up to
730d, 1d the full history. Asking for more is refused outright, not truncated.

USAGE
    python scripts/fetch_yahoo.py            # every instrument below
    python scripts/fetch_yahoo.py GOLD,SPX   # a subset
"""

import json
import os
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import quote
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
START_TS = 883612800            # 1998-01-01, the engines' own history floor
OUT_DIR = os.path.join("data", "yahoo")

# universe key (as the page names it) -> Yahoo symbol
INSTRUMENTS = {
    "GOLD":   "GC=F",
    "SILVER": "SI=F",
    "COPPER": "HG=F",
    "CRUDE":  "CL=F",
    "NATGAS": "NG=F",
    "DOW":    "^DJI",
    "NASDAQ": "^IXIC",
    "SPX":    "^GSPC",
}


def _via_relay(url):
    """r.jina.ai fetches the page from its own servers, so it gets through
    where a cloud IP is refused. It prefixes a plain-text header unless asked
    otherwise; either way the JSON is cut out of what comes back."""
    p = subprocess.run(["curl", "-s", "-f", "-m", "90", "-A", UA,
                        "-H", "X-Return-Format: text",
                        "https://r.jina.ai/" + url],
                       capture_output=True, timeout=120)
    if p.returncode != 0 or not p.stdout:
        raise RuntimeError("relay returned nothing")
    t = p.stdout.decode("utf-8", "replace")
    i = t.find('{"chart"')
    if i < 0:
        i = t.find("{")
    if i < 0:
        raise RuntimeError("relay returned no JSON")
    return json.loads(t[i:])


def get(url, tries=4):
    """Yahoo answers curl but returns 429 to Python's own HTTP client (it
    fingerprints the TLS handshake), so curl goes first; urllib is kept only
    for a machine without curl."""
    for attempt in range(tries):
        try:
            p = subprocess.run(["curl", "-s", "-f", "-m", "60", "-A", UA,
                                "-H", "Accept: application/json", url],
                               capture_output=True, timeout=90)
            if p.returncode == 0 and p.stdout:
                return json.loads(p.stdout.decode("utf-8"))
        except FileNotFoundError:
            break                                   # no curl here: use urllib
        except (subprocess.TimeoutExpired, ValueError):
            pass
        time.sleep(3 * (attempt + 1))
    req = Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    for attempt in range(tries):
        try:
            with urlopen(req, timeout=60) as r:
                return json.loads(r.read().decode("utf-8"))
        except HTTPError as e:
            if e.code in (429, 500, 502, 503, 504):
                time.sleep(3 * (attempt + 1))
                continue
            raise RuntimeError(f"HTTP {e.code}")
        except (URLError, TimeoutError):
            time.sleep(3 * (attempt + 1))
    try:                                   # last resort: the relay
        return _via_relay(url)
    except Exception as e:
        raise RuntimeError(f"gave up after {tries} attempts; relay: {e}")


# interval -> (Yahoo range parameter, output filename suffix). Daily is fetched
# with explicit period1/period2 instead, because range=max is not honoured for
# every one of these symbols.
INTRADAY = [("60m", "730d", "_60m"), ("5m", "60d", "_5m")]


def _parse(r, intraday):
    """One Yahoo chart result -> compact rows, deduped and sorted.

    Every bar is named on the EXCHANGE's own calendar, not UTC: a New York
    session stamped 09:30 EDT is 13:30 UTC, and futures sessions open the
    previous evening, so the exchange offset is what names the day — and, for
    intraday, the wall-clock minute a trader would recognise.
    """
    off = int((r.get("meta") or {}).get("gmtoffset") or 0)
    ts = r.get("timestamp") or []
    q = ((r.get("indicators") or {}).get("quote") or [{}])[0]
    vol = q.get("volume") or []
    out, seen = [], {}
    for i, t in enumerate(ts):
        try:
            o, h, l, c = (float(q["open"][i]), float(q["high"][i]),
                          float(q["low"][i]), float(q["close"][i]))
        except (TypeError, ValueError, KeyError, IndexError):
            continue
        if min(o, h, l, c) <= 0 or h < l:
            continue
        try:
            v = int(vol[i] or 0)
        except (TypeError, ValueError, IndexError):
            v = 0                       # indices and futures often report none
        dt = datetime.fromtimestamp(t + off, tz=timezone.utc)
        k = dt.strftime("%Y-%m-%d %H:%M") if intraday else dt.date().isoformat()
        row = [k, round(o, 4), round(h, 4), round(l, 4), round(c, 4), max(v, 0)]
        if k in seen:                   # Yahoo repeats the running bar
            out[seen[k]] = row
            continue
        seen[k] = len(out)
        out.append(row)
    out.sort(key=lambda x: x[0])
    return out


def bars_for(sym, interval="1d", rng=None):
    base = (f"https://query2.finance.yahoo.com/v8/finance/chart/{quote(sym, safe='')}"
            f"?interval={interval}")
    if rng:
        url = f"{base}&range={rng}"
    else:
        url = f"{base}&period1={START_TS}&period2={int(time.time())}&events=div%2Csplit"
    j = get(url)
    res = ((j or {}).get("chart") or {}).get("result") or []
    if not res:
        err = ((j or {}).get("chart") or {}).get("error") or {}
        raise RuntimeError(err.get("description") or "no result")
    return _parse(res[0], intraday=(interval not in ("1d", "1wk", "1mo")))


def write_series(key, sym, interval, suffix, rows, floor):
    if len(rows) < floor:
        raise RuntimeError(f"only {len(rows)} bars")
    path = os.path.join(OUT_DIR, f"{key}{suffix}.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"symbol": key, "yahoo": sym, "interval": interval, "source": "yahoo",
                   "from": rows[0][0], "to": rows[-1][0], "count": len(rows),
                   "bars": rows}, f, separators=(",", ":"))
    kb = os.path.getsize(path) // 1024
    print(f"{key:<8} {interval:<4} {len(rows):>7} bars  {rows[0][0]} -> {rows[-1][0]}  ({kb} KB)")
    return {"from": rows[0][0], "to": rows[-1][0], "count": len(rows)}


def main():
    want = [s.strip().upper() for s in (sys.argv[1] if len(sys.argv) > 1 else "").split(",") if s.strip()]
    keys = want or list(INSTRUMENTS)
    os.makedirs(OUT_DIR, exist_ok=True)
    manifest, failures = {}, []
    for k in keys:
        sym = INSTRUMENTS.get(k)
        if not sym:
            failures.append(f"{k}: unknown key")
            continue
        # Each interval stands alone: an intraday refusal must not cost the
        # daily history, which is what almost every panel actually reads.
        entry = {"yahoo": sym}
        try:
            entry["1d"] = write_series(k, sym, "1d", "", bars_for(sym), 100)
        except Exception as e:
            failures.append(f"{k} 1d: {e}")
            print(f"{k:<8} 1d   FAILED: {e}", file=sys.stderr)
        for interval, rng, suffix in INTRADAY:
            time.sleep(1.0)
            try:
                entry[interval] = write_series(k, sym, interval, suffix,
                                               bars_for(sym, interval, rng), 50)
            except Exception as e:
                failures.append(f"{k} {interval}: {e}")
                print(f"{k:<8} {interval:<4} FAILED: {e}", file=sys.stderr)
        if len(entry) > 1:
            manifest[k] = entry
        time.sleep(1.0)
    # The index is what the app builds its instrument lists from, so it is
    # rebuilt from the FILES ON DISK, not from what this run managed to fetch.
    # Yahoo refuses GitHub's runners outright (and so does the relay), so a
    # scheduled run fetches nothing while the committed data sits there intact
    # — and an index written from that run's empty manifest made Gold and the
    # US indices vanish from the app.
    def _scan(kind, suffix):
        out = {}
        for k in INSTRUMENTS:
            f = os.path.join(OUT_DIR, f"{k}{suffix}.json")
            try:
                with open(f, encoding="utf-8") as fh:
                    j = json.load(fh)
                if j.get("bars"):
                    out.setdefault(k, {})[kind] = {"from": j["from"], "to": j["to"], "count": j["count"]}
            except (OSError, ValueError, KeyError):
                pass
        return out
    onDisk = {}
    for kind, suffix in (("1d", ""), ("60m", "_60m"), ("5m", "_5m")):
        for k, v in _scan(kind, suffix).items():
            onDisk.setdefault(k, {}).update(v)
    for k, v in onDisk.items():
        manifest.setdefault(k, {}).update({kk: vv for kk, vv in v.items() if kk not in manifest.get(k, {})})
    if not manifest:
        print("nothing fetched and nothing on disk — leaving the index alone", file=sys.stderr)
        return
    ipath = os.path.join(OUT_DIR, "_index.json")
    try:
        with open(ipath, encoding="utf-8") as f:
            old = (json.load(f) or {}).get("instruments") or {}
    except (OSError, ValueError):
        old = {}
    if not manifest and old:
        print("nothing fetched this run — keeping the existing index", file=sys.stderr)
        merged = old
    else:
        merged = dict(old)
        merged.update(manifest)
    manifest = merged
    with open(ipath, "w", encoding="utf-8") as f:
        json.dump({"generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                   "source": "yahoo v8 chart (1d full / 60m 730d / 5m 60d)",
                   "row": ["date-or-datetime", "o", "h", "l", "c", "v"],
                   "instruments": manifest, "failures": failures}, f, indent=1)
    got = sum(len(v) - 1 for v in manifest.values())
    print(f"\nbaked {got} series across {len(manifest)}/{len(keys)} instruments"
          + (f", {len(failures)} failure(s)" if failures else ""))
    if not manifest:
        print("nothing fetched this run — the committed files and the index stand", file=sys.stderr)


if __name__ == "__main__":
    main()
