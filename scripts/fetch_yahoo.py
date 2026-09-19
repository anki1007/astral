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
    raise RuntimeError(f"gave up after {tries} attempts")


def bars_for(sym):
    now = int(time.time())
    url = (f"https://query2.finance.yahoo.com/v8/finance/chart/{quote(sym, safe='')}"
           f"?period1={START_TS}&period2={now}&interval=1d&events=div%2Csplit")
    j = get(url)
    res = ((j or {}).get("chart") or {}).get("result") or []
    if not res:
        err = ((j or {}).get("chart") or {}).get("error") or {}
        raise RuntimeError(err.get("description") or "no result")
    r = res[0]
    # Date each bar on the exchange's own calendar, not UTC: a New York
    # session stamped 09:30 EDT is 13:30 UTC, but futures sessions open the
    # previous evening, so the exchange offset is what names the day.
    off = int((r.get("meta") or {}).get("gmtoffset") or 0)
    ts = r.get("timestamp") or []
    q = ((r.get("indicators") or {}).get("quote") or [{}])[0]
    out, seen = [], set()
    for i, t in enumerate(ts):
        try:
            o, h, l, c = (float(q["open"][i]), float(q["high"][i]),
                          float(q["low"][i]), float(q["close"][i]))
        except (TypeError, ValueError, KeyError, IndexError):
            continue
        if min(o, h, l, c) <= 0 or h < l:
            continue
        d = datetime.fromtimestamp(t + off, tz=timezone.utc).date().isoformat()
        if d in seen:                     # Yahoo repeats the running bar
            out = [x for x in out if x[0] != d]
        seen.add(d)
        out.append([d, round(o, 4), round(h, 4), round(l, 4), round(c, 4)])
    out.sort(key=lambda x: x[0])
    return out


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
        try:
            rows = bars_for(sym)
            if len(rows) < 100:
                raise RuntimeError(f"only {len(rows)} bars")
            with open(os.path.join(OUT_DIR, f"{k}.json"), "w", encoding="utf-8") as f:
                json.dump({"symbol": k, "yahoo": sym, "interval": "1d", "source": "yahoo",
                           "from": rows[0][0], "to": rows[-1][0], "count": len(rows),
                           "bars": rows}, f, separators=(",", ":"))
            manifest[k] = {"yahoo": sym, "from": rows[0][0], "to": rows[-1][0], "count": len(rows)}
            print(f"{k:<8} {sym:<6} {len(rows):>6} bars  {rows[0][0]} -> {rows[-1][0]}")
        except Exception as e:                   # one bad symbol must not kill the run
            failures.append(f"{k}: {e}")
            print(f"{k:<8} FAILED: {e}", file=sys.stderr)
        time.sleep(1.0)
    with open(os.path.join(OUT_DIR, "_index.json"), "w", encoding="utf-8") as f:
        json.dump({"generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                   "source": "yahoo v8 chart (daily)", "instruments": manifest,
                   "failures": failures}, f, indent=1)
    if not manifest:
        sys.exit("nothing baked — every symbol failed")


if __name__ == "__main__":
    main()
