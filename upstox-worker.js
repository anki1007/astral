/**
 * Astral — Upstox data proxy (Cloudflare Worker)
 * ---------------------------------------------------------------------------
 * The terminal is a static page on a public origin, so it cannot call Upstox
 * directly: Upstox sends no Access-Control-Allow-Origin header to a browser,
 * and the access token must never be shipped in client-side code. This Worker
 * is the only place the token lives. The page calls the Worker; the Worker
 * calls Upstox.
 *
 * DEPLOY
 *   npm i -g wrangler
 *   wrangler init astral-upstox --yes && cd astral-upstox
 *   # replace src/index.js with this file
 *   wrangler secret put UPSTOX_ACCESS_TOKEN     # paste your token
 *   wrangler deploy
 *
 * TOKEN
 *   Use an Upstox *extended* token where your account allows it: it is
 *   read-only and long-lived, which is exactly this use case. A standard
 *   token expires daily at 03:30 IST and must be re-put.
 *
 * OPTIONAL — lock it to your own site so it is not an open relay:
 *   wrangler secret put ALLOWED_ORIGIN          # https://anki1007.github.io
 *
 * ENDPOINTS
 *   GET /health
 *   GET /resolve?sym=RELIANCE
 *   GET /candles?sym=RELIANCE&unit=days&interval=1&from=2000-01-01&to=2026-08-16
 *   GET /quote?syms=RELIANCE,TCS,NIFTY%2050
 */

const UPSTOX = 'https://api.upstox.com';
const INSTRUMENTS_URL = 'https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz';

/* Index tradingsymbols carry a different segment from equities. */
const INDEX_KEYS = {
  'NIFTY 50':          'NSE_INDEX|Nifty 50',
  'NIFTY BANK':        'NSE_INDEX|Nifty Bank',
  'NIFTY FIN SERVICE': 'NSE_INDEX|Nifty Fin Service',
  'NIFTY MID SELECT':  'NSE_INDEX|NIFTY MID SELECT',
  'NIFTY NEXT 50':     'NSE_INDEX|Nifty Next 50',
  'SENSEX':            'BSE_INDEX|SENSEX',
  'INDIA VIX':         'NSE_INDEX|India VIX'
};

function cors(origin, allowed){
  const o = (allowed && allowed !== '*') ? allowed : '*';
  return {
    'Access-Control-Allow-Origin': o,
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400'
  };
}
function json(body, status, hdrs){
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...hdrs }
  });
}

/* Instrument master: ~100k rows, so it is fetched once and cached at the edge
   for a day. Equity keys are ISIN-based and cannot be guessed from the symbol. */
async function instrumentMap(env, ctx){
  const cache = caches.default;
  const cacheKey = new Request('https://astral.internal/instruments-v1');
  const hit = await cache.match(cacheKey);
  if(hit) return hit.json();

  const r = await fetch(INSTRUMENTS_URL, { cf: { cacheTtl: 86400 } });
  if(!r.ok) throw new Error('instrument master ' + r.status);
  const all = await r.json();

  const map = {};
  for(const i of all){
    if(i.segment !== 'NSE_EQ' && i.segment !== 'BSE_EQ') continue;
    if(i.instrument_type && i.instrument_type !== 'EQ') continue;
    const sym = (i.trading_symbol || i.tradingsymbol || '').toUpperCase();
    if(!sym) continue;
    // NSE wins when a symbol exists on both exchanges
    if(!map[sym] || i.segment === 'NSE_EQ') map[sym] = i.instrument_key;
  }
  const res = json(map, 200, { 'Cache-Control': 'public, max-age=86400' });
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return map;
}

async function resolve(sym, env, ctx){
  const s = String(sym || '').trim().toUpperCase();
  if(!s) throw new Error('missing sym');
  if(s.includes('|')) return s;                 // already an instrument_key
  if(INDEX_KEYS[s]) return INDEX_KEYS[s];
  const map = await instrumentMap(env, ctx);
  const key = map[s];
  if(!key) throw new Error('unknown symbol: ' + s);
  return key;
}

async function upstox(path, env){
  const r = await fetch(UPSTOX + path, {
    headers: {
      'Authorization': 'Bearer ' + env.UPSTOX_ACCESS_TOKEN,
      'Accept': 'application/json'
    }
  });
  const text = await r.text();
  let body; try{ body = JSON.parse(text); }catch(e){ body = { raw: text.slice(0, 400) }; }
  if(!r.ok){
    const msg = (body && body.errors && body.errors[0] && body.errors[0].message) || ('HTTP ' + r.status);
    const err = new Error(msg); err.status = r.status; err.body = body; throw err;
  }
  return body;
}

/* Upstox caps a daily-candle request at one decade, so long spans are walked
   in chunks and stitched. Weekly and monthly have no per-request cap. */
async function candles(key, unit, interval, from, to, env){
  const out = [];
  const chunkYears = (unit === 'days') ? 9 : 100;
  let cursorTo = to;
  for(let guard = 0; guard < 12; guard++){
    const toY = +cursorTo.slice(0, 4);
    let chunkFrom = from;
    if(toY - (+from.slice(0, 4)) > chunkYears){
      chunkFrom = (toY - chunkYears) + cursorTo.slice(4);
    }
    const p = `/v3/historical-candle/${encodeURIComponent(key)}/${unit}/${interval}/${cursorTo}/${chunkFrom}`;
    const body = await upstox(p, env);
    const rows = (body && body.data && body.data.candles) || [];
    if(!rows.length) break;
    out.push(...rows);
    if(chunkFrom <= from) break;
    const d = new Date(chunkFrom + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - 1);
    cursorTo = d.toISOString().slice(0, 10);
    if(cursorTo < from) break;
  }
  // Upstox returns newest-first; normalise to oldest-first and de-duplicate.
  // The FULL timestamp is kept, not just the date: intraday units would
  // otherwise collapse every bar of a session onto one key and lose the
  // session entirely. Upstox stamps are IST with an explicit +05:30 offset,
  // so the literal HH:MM in the string is already the IST wall clock.
  const seen = new Set(), asc = [];
  for(const c of out.sort((a, b) => String(a[0]).localeCompare(String(b[0])))){
    const t = String(c[0]);
    if(seen.has(t)) continue;
    seen.add(t);
    asc.push({ t, date: t.slice(0, 10), o: +c[1], h: +c[2], l: +c[3], c: +c[4], v: +c[5] || 0 });
  }
  return asc.filter(r => r.date >= from && r.date <= to && r.c > 0);
}

export default {
  async fetch(req, env, ctx){
    const url = new URL(req.url);
    const origin = req.headers.get('Origin') || '';
    const allowed = env.ALLOWED_ORIGIN || '*';
    const H = cors(origin, allowed);

    if(req.method === 'OPTIONS') return new Response(null, { status: 204, headers: H });
    if(allowed !== '*' && origin && origin !== allowed)
      return json({ status: 'error', message: 'origin not allowed' }, 403, H);
    if(!env.UPSTOX_ACCESS_TOKEN)
      return json({ status: 'error', message: 'UPSTOX_ACCESS_TOKEN is not set on this Worker' }, 500, H);

    try{
      if(url.pathname === '/health'){
        // cheapest authenticated call that proves the token is still valid
        await upstox('/v2/market-quote/ltp?instrument_key=' + encodeURIComponent('NSE_INDEX|Nifty 50'), env);
        return json({ status: 'success', token: 'valid' }, 200, H);
      }

      if(url.pathname === '/resolve'){
        const key = await resolve(url.searchParams.get('sym'), env, ctx);
        return json({ status: 'success', data: { instrument_key: key } }, 200, H);
      }

      if(url.pathname === '/candles'){
        const key = await resolve(url.searchParams.get('sym'), env, ctx);
        const unit     = url.searchParams.get('unit') || 'days';
        const interval = url.searchParams.get('interval') || '1';
        const to       = url.searchParams.get('to')   || new Date().toISOString().slice(0, 10);
        const from     = url.searchParams.get('from') || '2000-01-01';
        const rows = await candles(key, unit, interval, from, to, env);
        return json({ status: 'success', source: 'upstox', instrument_key: key,
                      count: rows.length, data: rows }, 200,
                    { ...H, 'Cache-Control': 'public, max-age=1800' });
      }

      if(url.pathname === '/quote'){
        const syms = (url.searchParams.get('syms') || '').split(',').map(s => s.trim()).filter(Boolean);
        if(!syms.length) return json({ status: 'error', message: 'missing syms' }, 400, H);
        if(syms.length > 500) return json({ status: 'error', message: 'max 500 instruments per call' }, 400, H);
        const keys = [];
        for(const s of syms) keys.push(await resolve(s, env, ctx));
        const body = await upstox('/v2/market-quote/quotes?instrument_key=' +
                                  encodeURIComponent(keys.join(',')), env);
        const out = {};
        for(const [k, v] of Object.entries(body.data || {})){
          out[k] = { symbol: v.symbol, last: v.last_price, ohlc: v.ohlc, volume: v.volume,
                     netChange: v.net_change, ts: v.last_trade_time || v.timestamp };
        }
        return json({ status: 'success', source: 'upstox', data: out }, 200, H);
      }

      return json({ status: 'error', message: 'not found — try /health, /resolve, /candles, /quote' }, 404, H);

    }catch(err){
      // 401 almost always means the daily token lapsed; say so plainly.
      const status = err.status === 401 ? 401 : 502;
      return json({ status: 'error',
                    message: status === 401
                      ? 'Upstox rejected the token (401) — it has expired. Re-run: wrangler secret put UPSTOX_ACCESS_TOKEN'
                      : String(err.message || err) }, status, H);
    }
  }
};
