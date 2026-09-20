#!/usr/bin/env node
/* Forward test ("paper-trading log") for the astro engine.
 *
 * Runs in the Upstox bake job, after the bake. It loads index.html headless,
 * writes the engine's forecasts for the NEXT 5 SESSIONS (and the astro turn
 * windows for the next 30 sessions) into data/forward/log.json, plus the
 * active PROVEN DAILY patterns (Day Forecast; source "Proven daily") into log.daily, and grades
 * every earlier forecast whose outcome is now in the baked bars. Ten instruments (INSTS: India
 * indices, commodities, US indices), each on its own bars, book class and baselines; each one's
 * next session is the weekday after its own last bar. The book engine reads the sky at 09:15 IST
 * for all of them (no US-session time is modelled). The per-weekday book band is cached in
 * data/forward/cache_bands_<class>_<ay>.json (see bandLoad / bandSave). Git history
 * timestamps each forecast before its session, so the log is honest
 * out-of-sample evidence. A forecast is never changed once written.
 *
 * FIVE SESSIONS AHEAD (entry.seq = 1..5). Each entry is still one (target, inst)
 * pair and is written once: whichever run first reaches that session freezes it,
 * and later runs leave it alone. Each entry also carries the proven daily patterns
 * active on that session (entry.daily) and the turn windows covering it (entry.turns),
 * so the page's Upcoming view needs nothing but this file. The extra four sessions
 * cost four more book-engine reads per instrument (taRead + taTech), which is
 * negligible beside the cached per-weekday band file the first read builds.
 *
 * Grading is unchanged and still measures a ONE-SESSION call: an entry is graded
 * against the close of the last baked bar strictly before its session (prevCloseOf),
 * which for a next-session entry is exactly the lastClose frozen with the forecast,
 * and for an entry logged four sessions early is the close that actually preceded it.
 * So the scoreboards in summary.json keep measuring what they always measured.
 *
 * usage: node scripts/forward_log.js [--root DIR] [--html FILE]
 * Node 20, no dependencies. Always exits 0; failures are recorded in the log.
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const ROOT = path.resolve(arg('--root', process.cwd()));
const HTML = path.resolve(arg('--html', path.join(ROOT, 'index.html')));
const OUT = path.join(ROOT, 'data', 'forward');
const VERSION = 2, HORIZON = 30, SESSIONS = 5, FLAT = 0.1, ASTRO_MIN = 7, SW_MIN = 5, SW_MAJ = 10, CONFIRM_LAG = 20;
// Every instrument with baked daily data. `plan` is its Planet Lat/Lon key (index.html PLAN_INST).
// Each one is predicted and graded on its own bars, book class (taInstClass) and baselines.
const INSTS = [
  { k: 'NIFTY', file: 'data/nse/NIFTY.json', plan: 'NIFTY 50', grp: 'india' },
  { k: 'BANKNIFTY', file: 'data/nse/BANKNIFTY.json', plan: 'BANK NIFTY', grp: 'india' },
  { k: 'GOLD', file: 'data/yahoo/GOLD.json', plan: 'XAUUSD · GOLD', grp: 'com' },
  { k: 'SILVER', file: 'data/yahoo/SILVER.json', plan: 'XAGUSD · SILVER', grp: 'com' },
  { k: 'CRUDE', file: 'data/yahoo/CRUDE.json', plan: 'USOIL · WTI CRUDE', grp: 'com' },
  { k: 'COPPER', file: 'data/yahoo/COPPER.json', plan: 'XCUUSD · COPPER', grp: 'com' },
  { k: 'NATGAS', file: 'data/yahoo/NATGAS.json', plan: 'XNGUSD · NAT GAS', grp: 'com' },
  { k: 'DOW', file: 'data/yahoo/DOW.json', plan: 'DOW', grp: 'us' },
  { k: 'SPX', file: 'data/yahoo/SPX.json', plan: 'SPX', grp: 'us' },
  { k: 'NASDAQ', file: 'data/yahoo/NASDAQ.json', plan: 'NASDAQ', grp: 'us' },
];
// Time budget: past it, instruments not yet built are skipped (recorded per instrument) and the
// next run picks them up. The book-band cache is saved as it grows, so a killed run resumes too.
const BUDGET_MS = (parseFloat(process.env.FWD_BUDGET_MIN) || 30) * 60000, T0 = Date.now();

/* ── book-band cache: data/forward/cache_bands_<class>_<ay>.json ──
 * The engine keeps its per-weekday book band (one rulebook evaluation per weekday since 2000) in
 * localStorage under 'astralDpBook|<ver>|<ay>|<loc>' as {a, c:{<class>: string}}, one char per day
 * from `a` ('.' = not computed, '-' = no band, else the DP_BOOK index). Here that key is backed by
 * one committed file per class: {ver, loc, ay, cls, bands:[[date, bandIndex (-1 = none)], ...]}.
 * Instruments of the same class share it; later runs only compute the new days. */
const BAND_KEY = /^astralDpBook\|([^|]*)\|([^|]*)\|(.*)$/;
const bandFile = (cls, ay) => path.join(OUT, `cache_bands_${String(cls).replace(/[^A-Za-z0-9]+/g, '_')}_${ay}.json`);
function bandLoad(key) {
  const m = BAND_KEY.exec(key); if (!m) return null;
  const [, ver, ay, loc] = m, a = '1999-12-29', c = {}; let any = false;   // a = DP_START - 3 days
  for (const cls of ['equity', 'GOLD', 'SILVER']) {
    const j = readJSON(bandFile(cls, ay), null);
    if (!j || j.ver !== ver || j.loc !== loc || !Array.isArray(j.bands)) { c[cls] = ''; continue; }
    const ch = []; for (const [ds, v] of j.bands) { const d = Math.round((Date.parse(ds + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
      if (d < 0) continue; while (ch.length < d) ch.push('.'); ch[d] = v < 0 ? '-' : String(v); }
    c[cls] = ch.join(''); any = true;
  }
  const n = Math.max(...Object.values(c).map(x => x.length)); for (const k in c) c[k] = c[k].padEnd(n, '.');
  return any ? JSON.stringify({ a, c }) : null;
}
function bandSave(key, val) {
  const m = BAND_KEY.exec(key); if (!m) return; const [, ver, ay, loc] = m; let o;
  try { o = JSON.parse(val); } catch (e) { return; } if (!o || !o.c) return;
  fs.mkdirSync(OUT, { recursive: true });
  for (const [cls, str] of Object.entries(o.c)) {
    const rows = []; for (let d = 0; d < str.length; d++) { const x = str[d]; if (x === '.') continue; rows.push([shift(o.a, d), x === '-' ? -1 : +x]); }
    const txt = `{"ver":${JSON.stringify(ver)},"loc":${JSON.stringify(loc)},"ay":${JSON.stringify(ay)},"cls":${JSON.stringify(cls)},"bands":[\n` + rows.map(r => JSON.stringify(r)).join(',\n') + '\n]}\n';
    const p = bandFile(cls, ay); let old = null; try { old = fs.readFileSync(p, 'utf8'); } catch (e) {}
    if (old !== txt) { const tmp = p + '.tmp'; fs.writeFileSync(tmp, txt); fs.renameSync(tmp, p); }
  }
}

/* ── headless page: index.html's inline scripts in a vm with a DOM stub ── */
function loadPage() {
  const html = fs.readFileSync(HTML, 'utf8');
  const el = () => ({ style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() { return false; }, contains() { return false; } },
    children: [], innerHTML: '', textContent: '', value: '', checked: false, appendChild(c) { return c; }, removeChild() {}, remove() {},
    setAttribute() {}, getAttribute() { return null; }, addEventListener() {}, removeEventListener() {}, querySelector() { return null; },
    querySelectorAll() { return []; }, getBoundingClientRect() { return { left: 0, top: 0, width: 1200, height: 600, right: 1200, bottom: 600 }; },
    closest() { return null; }, focus() {}, blur() {}, click() {}, insertAdjacentHTML() {}, scrollIntoView() {}, getContext() { return null; },
    contains() { return false; }, cloneNode() { return el(); }, offsetWidth: 1200, offsetHeight: 600, clientWidth: 1200, clientHeight: 600,
    nextElementSibling: null, parentNode: null });
  const store = {}, doc = { body: el(), documentElement: el(), head: el(), readyState: 'complete', hidden: false,
    getElementById() { return el(); }, querySelector() { return el(); }, querySelectorAll() { return []; }, createElement() { return el(); },
    createElementNS() { return el(); }, createTextNode() { return el(); }, addEventListener() {}, removeEventListener() {}, createDocumentFragment() { return el(); } };
  // same-origin data/ reads come from disk; everything else is offline
  const fetchLocal = async u => {
    u = String(u).replace(/^\.?\//, '').split('?')[0];
    if (!/^data\//.test(u)) throw new Error('offline: ' + u);
    const p = path.join(ROOT, u);
    if (!fs.existsSync(p)) return { ok: false, status: 404, headers: { get() { return null; } }, json: async () => { throw new Error('404'); }, text: async () => '' };
    const t = fs.readFileSync(p, 'utf8');
    return { ok: true, status: 200, headers: { get() { return null; } }, json: async () => JSON.parse(t), text: async () => t };
  };
  const ctx = { console: { log() {}, info() {}, warn() {}, error() {}, debug() {} }, Math, JSON, Date, Array, Object, String, Number, Boolean, RegExp, Error, Map, Set,
    WeakMap, WeakSet, Symbol, Promise, parseFloat, parseInt, isFinite, isNaN, encodeURIComponent, decodeURIComponent, Intl, Float64Array, Float32Array,
    Int32Array, Uint8Array, Uint32Array, Int16Array, Uint16Array, Int8Array, ArrayBuffer, DataView, BigInt, Reflect, Proxy, TextDecoder, TextEncoder,
    URL, URLSearchParams, AbortController, document: doc, navigator: { userAgent: 'node', language: 'en', clipboard: {} },
    location: { href: 'http://localhost/', search: '', hash: '', origin: 'http://localhost', pathname: '/', protocol: 'http:' },
    localStorage: { getItem: k => { if (!(k in store) && BAND_KEY.test(k)) store[k] = bandLoad(k); return store[k] == null ? null : store[k]; },
      setItem: (k, v) => { store[k] = String(v); if (BAND_KEY.test(k)) bandSave(k, store[k]); }, removeItem: k => { delete store[k]; } },
    sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    setTimeout: () => 0, clearTimeout() {}, setInterval() { return 0; }, clearInterval() {}, requestAnimationFrame() { return 0; }, cancelAnimationFrame() {},
    fetch: fetchLocal, matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }), addEventListener() {}, removeEventListener() {},
    dispatchEvent() {}, getComputedStyle: () => ({ getPropertyValue: () => '' }), ResizeObserver: class { observe() {} disconnect() {} unobserve() {} },
    MutationObserver: class { observe() {} disconnect() {} }, IntersectionObserver: class { observe() {} disconnect() {} }, Image: class {},
    performance: { now: () => Date.now() }, devicePixelRatio: 1, innerWidth: 1400, innerHeight: 900, scrollTo() {}, alert() {}, confirm() { return false; },
    history: { replaceState() {}, pushState() {} }, HTMLElement: class {}, Element: class {}, Node: class {}, CustomEvent: class {}, Event: class {},
    Blob: class {}, FileReader: class {} };
  ctx.window = ctx; ctx.self = ctx; ctx.globalThis = ctx; ctx.top = ctx; ctx.parent = ctx;
  vm.createContext(ctx);
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi; let m; const errs = [];
  while ((m = re.exec(html))) { if (/\bsrc\s*=/.test(m[1])) continue;
    try { vm.runInContext(m[2], ctx); } catch (e) { errs.push(String(e && e.message || e)); } }
  // after load: real (async) timers so the engine's own yields resolve; never throw out of one
  ctx.setTimeout = f => setTimeout(() => { try { f(); } catch (e) {} }, 0);
  return { ctx, errs, E: s => vm.runInContext(s, ctx) };
}

/* ── small helpers ── */
const readJSON = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return d; } };
const iso = d => d.toISOString().slice(0, 10);
const shift = (ds, n) => { const d = new Date(ds + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const isWk = ds => { const w = new Date(ds + 'T00:00:00Z').getUTCDay(); return w > 0 && w < 6; };
// Sessions are weekdays only: an exchange holiday simply grades as "no session".
const nextSess = ds => { let d = shift(ds, 1); while (!isWk(d)) d = shift(d, 1); return d; };
const prevSess = ds => { let d = shift(ds, -1); while (!isWk(d)) d = shift(d, -1); return d; };
const sessAdd = (ds, n) => { let d = ds; for (let k = 0; k < Math.abs(n); k++) d = n > 0 ? nextSess(d) : prevSess(d); return d; };
const onOrAfter = ds => isWk(ds) ? ds : nextSess(ds), onOrBefore = ds => isWk(ds) ? ds : prevSess(ds);
const sign = v => v > 0 ? 1 : v < 0 ? -1 : 0;
const r2 = v => Math.round(v * 100) / 100;
function bars(inst) {
  const j = readJSON(path.join(ROOT, inst.file), null);
  if (!j || !Array.isArray(j.bars)) throw new Error('no bars in ' + inst.file);
  return j.bars.map(b => ({ date: b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4] }))
    .filter(b => b.date && isFinite(b.c) && b.c > 0).sort((a, b) => a.date < b.date ? -1 : 1);
}
function wilson(k, n) { if (!n) return [0, 0]; const z = 1.96, p = k / n, d = 1 + z * z / n, c = (p + z * z / (2 * n)) / d,
  h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d; return [Math.max(0, c - h), Math.min(1, c + h)]; }
function binomUpper(n, k, p) { // P(X >= k), X ~ Bin(n, p)
  if (k <= 0 || n <= 0) return 1; if (p <= 0) return 0; if (p >= 1) return 1;
  const lp = []; let v = n * Math.log(1 - p); const lr = Math.log(p / (1 - p));
  for (let i = 0; i <= n; i++) { lp[i] = v; v += Math.log((n - i) / (i + 1)) + lr; }
  const mx = Math.max(...lp); let a = 0, t = 0; lp.forEach((x, i) => { const e = Math.exp(x - mx); t += e; if (i >= k) a += e; });
  return Math.min(1, a / t);
}
const pct = (k, n) => n ? r2(k / n * 100) : null;
// The close a session is measured against: the last baked bar strictly before it.
// For a next-session entry that IS the lastClose frozen with the forecast; for one
// written several sessions early it is the close that actually preceded its session,
// so every entry grades as the one-session call it was.
function prevCloseOf(B, target, fallback) {
  for (let i = B.length - 1; i >= 0; i--) if (B[i].date < target) return B[i].c;
  return fallback;
}

/* Venue of each instrument: 'in' = NSE/BSE (Mumbai), everything else trades in
   New York (NYSE/Nasdaq, and COMEX/NYMEX for the metals and energies). */
const VENUE = { india: ['Mumbai', 19.076, 72.8777, 9.25], us: ['New York', 40.7128, -74.006, 9.5], com: ['New York', 40.7128, -74.006, 9.5] };
/* The IST hour that equals `openLocal` at the venue on that date — Intl gives
   the venue's real UTC offset, so US daylight saving is handled. */
function istHourFor(venueTz, dateISO, openLocal) {
  if (venueTz === 'Asia/Kolkata') return openLocal;
  const h = Math.floor(openLocal), mi = Math.round((openLocal - h) * 60);
  const asIfUTC = Date.UTC(+dateISO.slice(0, 4), +dateISO.slice(5, 7) - 1, +dateISO.slice(8, 10), h, mi);
  const f = new Intl.DateTimeFormat('en-US', { timeZone: venueTz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const partsAsUTC = t => { const o = {}; for (const x of f.formatToParts(new Date(t))) o[x.type] = x.value;
    return Date.UTC(+o.year, +o.month - 1, +o.day, +(o.hour === '24' ? 0 : o.hour), +o.minute); };
  // the venue's offset ON that date (so DST is handled), then the real UTC instant of its open
  const offset = partsAsUTC(asIfUTC) - asIfUTC;
  const utc = asIfUTC - offset;
  const ist = new Date(utc + 5.5 * 3600000);
  return Math.round((ist.getUTCHours() + ist.getUTCMinutes() / 60) * 12) / 12;
}
const VENUE_TZ = { Mumbai: 'Asia/Kolkata', 'New York': 'America/New_York' };

/* ── 1. direction forecast for the next session ── */
function predictDay(P, inst, B, target, made) {
  const last = B[B.length - 1], cls = P.E(`taInstClass(${JSON.stringify(inst.k)})`);
  // the sky over THIS exchange at ITS open, not 09:15 Mumbai for everyone
  const [vName, vLat, vLon, vOpen] = VENUE[inst.grp] || VENUE.india;
  const hourIST = istHourFor(VENUE_TZ[vName], target, vOpen);
  P.ctx.__q = { target, cls, hour: hourIST, lat: vLat, lon: vLon, venue: vName, openLocal: vOpen };
  const a = P.E(`(()=>{ LAT=__q.lat; LON=__q.lon; S.loc=__q.venue;
    const ev=taRead(__q.target,__q.hour,'lahiri','daily',__q.cls);
    const top=(ev.rules||[]).filter(r=>r.dir&&!taRuleExcluded(r,__q.cls)).sort((x,y)=>y.w-x.w).slice(0,5)
      .map(r=>({sec:r.sec,name:r.name,dir:r.dir,w:Math.round(r.w*100)/100}));
    return {score:ev.score,band:ev.band.t,volatility:ev.volatility||0,turning:ev.turning||0,top}; })()`);
  P.E(`(()=>{ LAT=19.0760; LON=72.8777; S.loc='Mumbai'; })()`);   // leave the engine as we found it
  // chapter-2 technicals on bars up to the last close; the session being predicted
  // has no open yet, so its open is taken as the last close (a flat open)
  const tb = B.map(b => Object.assign({}, b)); tb.push({ date: target, o: last.c, h: last.c, l: last.c, c: last.c });
  P.ctx.__tb = tb;
  const fired = P.E(`taTech(__tb, __tb.length-1, 'daily').map(r=>({sec:r.sec,name:r.name,dir:r.dir,w:r.w}))`);
  const techNet = r2(fired.reduce((s, r) => s + r.dir * r.w, 0));
  const t = sign(techNet), s = sign(a.score), strong = Math.abs(a.score) >= ASTRO_MIN;
  const calls = {
    astroOnly: strong ? s : 0,
    techOnly: t,
    techWithAstroFilter: (!strong || s === t) ? t : 0,
    astroAndTech: (strong && s === t) ? t : 0,
  };
  // tertiles of the engine's volatility weight on NIFTY sessions 2019-2026 (<=2.3 | 2.3-3.2 | >=3.2)
  const vol = a.volatility >= 3.2 ? 'wide' : a.volatility <= 2.3 ? 'quiet' : 'normal';
  return { id: target + '|' + inst.k, target, inst: inst.k, made, lastClose: last.c, lastDate: last.date,
    venue: { place: vName, openLocal: vOpen, hourIST },
    astro: { score: a.score, band: a.band, volatility: a.volatility, turning: a.turning, top: a.top },
    tech: { net: techNet, dir: t, fired: fired.filter(r => r.dir).map(r => ({ sec: r.sec, name: r.name, dir: r.dir })),
            setups: fired.filter(r => !r.dir).map(r => r.name), openAssumed: 'last close' },
    calls, vol, graded: null };
}
function gradeDay(e, B) {
  const b = B.find(x => x.date === e.target);
  if (!b) {
    if (B.length && B[B.length - 1].date > e.target) return { date: e.target, noSession: true };
    return null;
  }
  const pc = prevCloseOf(B, e.target, e.lastClose);
  const cc = (b.c / pc - 1) * 100, oc = (b.c / b.o - 1) * 100;
  const dir = cc > FLAT ? 1 : cc < -FLAT ? -1 : 0, res = {};
  for (const [k, v] of Object.entries(e.calls)) res[k] = v === 0 ? 'aside' : v === dir ? 'hit' : 'miss';
  res.alwaysBullish = dir === 1 ? 'hit' : 'miss';
  res.alwaysNeutral = dir === 0 ? 'hit' : 'miss';
  return { date: b.date, o: b.o, c: b.c, prevClose: r2(pc), ccPct: r2(cc), ocPct: r2(oc), dir, rangePct: r2((b.h - b.l) / pc * 100), results: res };
}

/* ── 2. reversal (turn-date) forecasts for the next 30 sessions ── */
function winAroundRaw(from, to) { return { from: sessAdd(onOrAfter(from), -2), to: sessAdd(onOrBefore(to < from ? from : to), 2) }; }
async function predictTurns(P, inst, target, horizonEnd, made, asOf) {
  const out = [];
  // a window never reaches back before the next session: that part is already known
  // The raw window is the forecast's identity (dedupe key); a cluster already under way is
  // looked up from a week back so its identity does not drift as the days pass.
  const winAround = (f, t) => { const w = winAroundRaw(f, t); w.rawFrom = w.from; w.rawTo = w.to; if (w.from < target) w.from = target; return w; };
  const look = shift(target, -7);
  // (a) Astral "approaching turn dates": clustered astro events, labelled by their measured type
  const X = await P.E(`tnLoad(${JSON.stringify(inst.k)})`);
  if (!X) throw new Error('turn table: ' + P.E(`window.TN.err[${JSON.stringify(inst.k)}]`));
  P.ctx.__q = { k: inst.k, a: look, b: horizonEnd };
  const W = P.E(`(()=>{ const X=window.TN.tables[__q.k], M=X.M;
    return tnCluster(X.events.filter(e=>e.ds>=__q.a&&e.ds<=__q.b)).map(w=>{ const L=tnWinLabel(w,M), G=M.groups[L.key];
      return {from:w.from,to:w.to,label:L.label,edge:L.edge,dir:L.dir,mag:L.mag,
        hist:G&&G.n?{n:G.n,rate:Math.round(G.rate*1000)/1000,base:Math.round(G.base*1000)/1000}:null,
        events:w.ev.map(e=>{ const t=M.types[e.key]; return {ds:e.ds,what:e.what,hint:e.hint,measured:t&&t.edge?t.label:'not proven — past hits ≈ random chance'}; })}; }); })()`);
  for (const w of W) {
    const win = winAround(w.from, w.to); if (win.to < target) continue;
    const type = (w.edge ? (w.mag === 'Major' ? 'MAJOR ' : 'MINOR ') : '') + (w.dir === 'Top' ? 'TOP' : w.dir === 'Bottom' ? 'BOTTOM' : 'TURN');
    out.push({ source: 'astral', inst: inst.k, made, asOf, at: w.from === w.to ? w.from : w.from + '..' + w.to, from: win.from, to: win.to, rawFrom: win.rawFrom, rawTo: win.rawTo,
      type, edge: !!w.edge, hist: w.hist, reasons: w.events.map(e => `${e.ds} ${e.what} (book ${String(e.hint).toUpperCase()}; ${e.measured})`) });
  }
  // (b) Planet Lat / Lon future-date labels (SWING >= 5%, MAJOR >= 10%). The two tabs learn the
  // same planet-state cells (latitude + longitude families), so one build serves both.
  P.ctx.__q = { plan: inst.plan };
  const R = await P.E(`(window.TN.swingPct=${SW_MIN}, window.TN.majPct=${SW_MAJ}, tnLfBuild(tnLfKey(__q.plan,'lat'),__q.plan,'lat'))`);
  if (!R || R.status !== 'ready') throw new Error(`lat/lon: ${R && R.err}`);
  P.ctx.__q = { plan: inst.plan, a: look, b: horizonEnd };
  const days = P.E(`(()=>{ const R=window.TN.lf[tnLfKey(__q.plan,'lat')];
    const F=R.fut.filter(f=>f.ds>=__q.a&&f.ds<=__q.b&&f.ms.length);
    let pick=F.filter(f=>tnLfEdge(f.ms[0])), why='label';
    if(!pick.length){ pick=F.slice().sort((x,y)=>y.score-x.score).slice(0,10); why='strongest'; }
    return pick.sort((x,y)=>x.ds<y.ds?-1:1).map(f=>({ds:f.ds,why,score:Math.round(f.score*10)/10,label:tnLfCellLab(f.ms[0]),edge:tnLfEdge(f.ms[0]),
      states:f.ms.slice(0,3).map(c=>c.k+': '+tnLfCellTxt(c,R)+(tnLfEdge(c)?'':' (not proven — past hits ≈ random chance)'))})); })()`).filter(d => isWk(d.ds));
  // one window per run of picked days whose ±2-session windows overlap
  const runs = [];
  for (const d of days) { const w = winAroundRaw(d.ds, d.ds), r = runs[runs.length - 1];
    if (r && w.from <= r.to) { r.days.push(d); r.to = w.to; } else runs.push({ from: w.from, to: w.to, days: [d] }); }
  for (const r of runs) {
    if (r.to < target) continue;
    const raw = winAroundRaw(r.days[0].ds, r.days[r.days.length - 1].ds);
    const best = r.days.slice().sort((x, y) => y.score - x.score)[0], allEdge = r.days.every(d => d.edge);
    const a = r.days[0].ds, b = r.days[r.days.length - 1].ds;
    out.push({ source: 'latlon', inst: inst.k, made, asOf, at: a === b ? a : a + '..' + b, from: r.from < target ? target : r.from, to: r.to, rawFrom: raw.from, rawTo: raw.to,
      type: allEdge ? best.label : 'TURN', edge: allEdge, pick: best.why === 'label' ? 'measured label' : 'top score (not proven — past hits ≈ random chance)',
      score: best.score, days: r.days.map(d => d.ds),
      reasons: (best.edge ? [] : ['state label ' + best.label + ' (not proven — past hits ≈ random chance)']).concat(best.states) });
  }
  // (c) PROVEN combined latitude + longitude patterns (R.PV; passed 2000-2018 BH, held on 2019+ days and episodes, >=8 swings)
  P.ctx.__q = { plan: inst.plan, a: look, b: horizonEnd };
  const pdays = P.E(`(()=>{ const R=window.TN.lf[tnLfKey(__q.plan,'lat')]; if(!R.PV) return [];
    return R.fut.filter(f=>f.ds>=__q.a&&f.ds<=__q.b&&f.pv&&f.pv.length).map(f=>({ds:f.ds,pats:f.pv.map(r=>({k:r.k,plain:r.plain,lab:r.lab,share:r.share,maj:r.majShare,
      conf:tnLfConfirmed(R,r.k),txt:r.plain+': 2000-2018 '+r.tr.hits+'/'+r.tr.n+' days '+tnPct(r.tr.rate)+' vs '+tnPct(r.tr.chance)+' chance (BH q '+tnPfmt(r.tr.bh)+'); 2019+ '+r.oos.hits+'/'+r.oos.n+' days '+tnPct(r.oos.rate)+' vs '+tnPct(r.oos.chance)+', episodes '+r.ep.hits+'/'+r.ep.n+' '+tnPct(r.ep.rate)+' vs '+tnPct(r.ep.chance)}))})); })()`).filter(d => isWk(d.ds));
  const pruns = [];
  for (const d of pdays) { const w = winAroundRaw(d.ds, d.ds), r = pruns[pruns.length - 1];
    if (r && w.from <= r.to) { r.days.push(d); r.to = w.to; } else pruns.push({ from: w.from, to: w.to, days: [d] }); }
  for (const r of pruns) {
    if (r.to < target) continue;
    const raw = winAroundRaw(r.days[0].ds, r.days[r.days.length - 1].ds), a = r.days[0].ds, b = r.days[r.days.length - 1].ds;
    const pats = new Map(); r.days.forEach(d => d.pats.forEach(p => pats.set(p.k, p)));
    const best = [...pats.values()][0];
    out.push({ source: 'proven', inst: inst.k, made, asOf, at: a === b ? a : a + '..' + b, from: r.from < target ? target : r.from, to: r.to, rawFrom: raw.from, rawTo: raw.to,
      type: (best.maj >= 0.5 ? 'MAJOR ' : 'MINOR ') + best.lab, edge: true, pick: 'Proven lat+lon', days: r.days.map(d => d.ds),
      reasons: [...pats.values()].map(p => p.txt + (p.conf.length ? ' · confirmed on ' + p.conf.join(' / ') : '')) });
  }
  return out;
}
/* ── 2b. proven DAILY patterns (Day Forecast): the ones active on the next session, with their claims ── */
async function predictDaily(P, inst, hist, target, made) {
  P.ctx.__q = { k: inst.k, target };
  const R = await P.E(`dpBuild(__q.k,'lahiri')`);
  if (!R || R.status !== 'ready') throw new Error(String(R && R.err || 'build failed'));
  const act = P.E(`(()=>{ const R=window.DP.res[dpKey(__q.k,'lahiri')], d=R.dOf(__q.target);
    return DP_TGT.flatMap(tg=>R.res[tg.id].proven.filter(r=>dpActive(R,r,d)).map(r=>({study:tg.id,k:r.k,plain:r.plain,s:r.s,claim:dpClaim(tg,r),
      tr:{n:r.tr.n,rate:r.tr.rate,chance:r.tr.chance,bh:r.tr.bh},oos:{n:r.oos.n,rate:r.oos.rate,chance:r.oos.chance,p:r.oos.p},
      weeks:{n:r.blk.n,rate:r.blk.rate,chance:r.blk.chance,p:r.blk.p},conf:dpConfirmed(R,tg.id,r),
      bias:tg.id==='big'&&r.bias?{lab:r.bias.lab,claim:dpBiasShort(r),tr:r.bias.tr,oos:r.bias.oos,n:r.bias.n,avgPct:r.bias.avg,medPct:r.bias.med}:null}))); })()`);
  P.ctx.__b = hist;
  const base = P.E(`dpBaseAsOf(__b)`);   // last 250 gradable sessions before the target + the big-move cut for the target
  const last = hist[hist.length - 1], rd = v => Math.round(v * 10000) / 10000;
  return act.map(a => ({ id: [target, inst.k, a.study, a.k].join('|'), source: 'Proven daily', inst: inst.k, target, made,
    lastClose: last.c, lastDate: last.date, study: a.study, pattern: a.k, plain: a.plain, claim: a.claim, lean: a.s > 0 ? 'more' : 'less',
    backtest: { in: { n: a.tr.n, rate: rd(a.tr.rate), base: rd(a.tr.chance), bhQ: a.tr.bh }, out: { n: a.oos.n, rate: rd(a.oos.rate), base: rd(a.oos.chance), p: a.oos.p },
      weeks: { n: a.weeks.n, rate: rd(a.weeks.rate), base: rd(a.weeks.chance), p: a.weeks.p } },
    base: base[a.study], bigThrPct: base.bigThr, confirmedOn: a.conf,
    // big-move patterns: which way the pattern's past big-move days closed; graded on the session only if it is a big-move day
    bias: a.bias ? { lean: a.bias.lab, claim: a.bias.claim, inSample: { n: a.bias.tr.n, upShare: a.bias.tr.share == null ? null : rd(a.bias.tr.share), base: rd(a.bias.tr.base) },
      out: { n: a.bias.oos.n, upShare: a.bias.oos.share == null ? null : rd(a.bias.oos.share), base: rd(a.bias.oos.base), p: a.bias.oos.p },
      days: a.bias.n, avgMovePct: a.bias.avgPct == null ? null : r2(a.bias.avgPct), medMovePct: a.bias.medPct == null ? null : r2(a.bias.medPct) } : null,
    graded: null }));
}
function gradeDaily(e, B) {
  const b = B.find(x => x.date === e.target);
  if (!b) { if (B.length && B[B.length - 1].date > e.target) return { date: e.target, noSession: true }; return null; }
  const pc = prevCloseOf(B, e.target, e.lastClose), ok = b.o > 0 && b.h >= b.l && !(b.o === b.h && b.h === b.l && b.l === b.c);
  const cc = (b.c / pc - 1) * 100, tr = (Math.max(b.h, pc) - Math.min(b.l, pc)) / pc * 100, gp = Math.abs(b.o - pc) / pc * 100;
  const out = { date: b.date, o: b.o, h: b.h, l: b.l, c: b.c, prevClose: r2(pc), ccPct: r2(cc), trPct: r2(tr), gapPct: r2(gp),
    up: cc > FLAT, big: ok && e.bigThrPct != null ? tr > e.bigThrPct : null, gap: ok ? gp > 0.5 : null };
  const y = e.study === 'dir' ? out.up : e.study === 'big' ? out.big : out.gap;
  out.outcome = y; out.result = y == null ? 'ungradable' : ((e.lean === 'more') === !!y ? 'hit' : 'miss');
  // big-move direction: graded only when the session WAS a big-move day and the pattern named a bias
  if (e.study === 'big' && e.bias) {
    out.moveDir = cc > 0 ? 'up' : cc < 0 ? 'down' : 'flat';
    out.biasResult = out.big !== true ? 'not a big-move day' : !e.bias.lean ? 'no call (coin-flip)' : cc === 0 ? 'flat'
      : ((e.bias.lean === 'UP') === (cc > 0) ? 'hit' : 'miss');
  }
  return out;
}
function swingsOf(P, B) { P.ctx.__b = B; return P.E(`reDetectSwings(__b, ${SW_MIN}, ${SW_MAJ}, true)`); }
function chanceFor(B, sw, len) { // P(a random window of `len` sessions holds a >=5% pivot), 2000 -> last pivot
  const piv = new Uint8Array(B.length), ix = new Map(B.map((b, i) => [b.date, i]));
  let lastP = -1; sw.forEach(s => { const i = ix.get(s.date); if (i != null) { piv[i] = 1; if (i > lastP) lastP = i; } });
  const P = new Int32Array(B.length + 1); for (let i = 0; i < B.length; i++) P[i + 1] = P[i] + piv[i];
  let c = 0, t = 0; for (let i = 0; i + len - 1 <= lastP; i++) { t++; if (P[i + len] - P[i] > 0) c++; }
  return t ? c / t : 0;
}
function gradeTurn(f, B, sw) {
  const last = B[B.length - 1].date; if (last < f.to) return null;         // window still open
  const inWin = sw.filter(s => s.date >= f.from && s.date <= f.to);
  const len = B.filter(b => b.date >= f.from && b.date <= f.to).length || 5;
  const chance = Math.round(chanceFor(B, sw, len) * 10000) / 10000;
  if (inWin.length) {
    const p = inWin.slice().sort((a, b) => b.mag - a.mag)[0], top = p.type === 'H';
    const pd = /TOP|BOTTOM/.test(f.type) ? /TOP/.test(f.type) === top : null;
    const pm = /MAJOR|MINOR/.test(f.type) ? /MAJOR/.test(f.type) === (p.cls === 'MAJOR') : null;
    return { status: 'hit', date: last, sessions: len, chance, pivot: { date: p.date, price: p.price, movePct: p.mag, type: top ? 'TOP' : 'BOTTOM', cls: p.cls },
      typeRight: pd, majorRight: pm };
  }
  const after = B.filter(b => b.date > f.to).length;
  if (after >= CONFIRM_LAG) return { status: 'miss', date: last, sessions: len, chance };
  return null;                                                         // pending confirmation
}

/* ── 3. summary ── */
function summarise(log, B, SW) {
  const days = log.entries.filter(e => e.graded && !e.graded.noSession);
  const S = { version: VERSION, generated: new Date().toISOString(), since: log.since || null,
    lastGraded: days.reduce((m, e) => e.graded.date > m ? e.graded.date : m, '') || null,
    nDays: new Set(days.map(e => e.target)).size, flatBandPct: FLAT, astroMin: ASTRO_MIN, direction: {}, volatility: {}, turns: {}, chance: {}, provenDaily: {} };
  S.insts = INSTS.map(i => ({ k: i.k, grp: i.grp, target: (log.runs.length && (log.runs[log.runs.length - 1].targets || {})[i.k]) || null }));
  S.skyNote = 'the book engine reads the sky at 09:15 IST of the session date for every instrument, US and commodities included; no US-session time is modelled';
  const CALLS = ['astroOnly', 'techOnly', 'techWithAstroFilter', 'astroAndTech'];
  for (const inst of INSTS.map(i => i.k)) {
    const D = days.filter(e => e.inst === inst), row = {};
    const upDays = D.filter(e => e.graded.dir === 1).length, flatDays = D.filter(e => e.graded.dir === 0).length;
    for (const c of CALLS) {
      const made = D.filter(e => e.graded.results[c] !== 'aside'), hits = made.filter(e => e.graded.results[c] === 'hit').length;
      const bull = made.filter(e => e.graded.dir === 1).length, p0 = made.length ? bull / made.length : 0;
      const ci = wilson(hits, made.length);
      row[c] = { n: made.length, hits, hitPct: pct(hits, made.length), ci95: [r2(ci[0] * 100), r2(ci[1] * 100)],
        bullPctSameDays: pct(bull, made.length), vsBullPP: made.length ? r2((hits - bull) / made.length * 100) : null,
        p: made.length ? Math.round(binomUpper(made.length, hits, p0) * 1000) / 1000 : null, aside: D.length - made.length };
    }
    const ciB = wilson(upDays, D.length), ciN = wilson(flatDays, D.length);
    row.alwaysBullish = { n: D.length, hits: upDays, hitPct: pct(upDays, D.length), ci95: [r2(ciB[0] * 100), r2(ciB[1] * 100)] };
    row.alwaysNeutral = { n: D.length, hits: flatDays, hitPct: pct(flatDays, D.length), ci95: [r2(ciN[0] * 100), r2(ciN[1] * 100)] };
    S.direction[inst] = row;
    const V = {};
    for (const k of ['quiet', 'normal', 'wide']) { const r = D.filter(e => e.vol === k).map(e => e.graded.rangePct);
      V[k] = { n: r.length, meanRangePct: r.length ? r2(r.reduce((a, b) => a + b, 0) / r.length) : null }; }
    S.volatility[inst] = V;
    // turn windows
    const T = {}, F = (log.reversals || []).filter(f => f.inst === inst);
    for (const src of ['astral', 'latlon', 'proven']) {
      const all = F.filter(f => f.source === src), g = all.filter(f => f.graded), hits = g.filter(f => f.graded.status === 'hit');
      const ch = g.length ? g.reduce((a, f) => a + f.graded.chance, 0) / g.length : null, ci = wilson(hits.length, g.length);
      const td = hits.filter(f => f.graded.typeRight != null), tOk = td.filter(f => f.graded.typeRight).length;
      const md = hits.filter(f => f.graded.majorRight != null), mOk = md.filter(f => f.graded.majorRight).length;
      T[src] = { made: all.length, graded: g.length, pending: all.length - g.length, hits: hits.length, hitPct: pct(hits.length, g.length),
        ci95: [r2(ci[0] * 100), r2(ci[1] * 100)], chancePct: ch == null ? null : r2(ch * 100),
        p: g.length ? Math.round(binomUpper(g.length, hits.length, ch) * 1000) / 1000 : null,
        typeN: td.length, typeOk: tOk, typePct: pct(tOk, td.length), typeP: td.length ? Math.round(binomUpper(td.length, tOk, 0.5) * 1000) / 1000 : null,
        majorN: md.length, majorOk: mOk };
    }
    S.turns[inst] = T;
    // proven daily patterns: hit rate vs the chance of the claimed outcome (base rate as of each prediction)
    const PD = {}, DL = (log.daily || []).filter(f => f.inst === inst);
    for (const st of ['dir', 'big', 'gap']) {
      const all = DL.filter(f => f.study === st), g = all.filter(f => f.graded && f.graded.result && f.graded.result !== 'ungradable');
      const hits = g.filter(f => f.graded.result === 'hit').length, ci = wilson(hits, g.length);
      const exp = g.length ? g.reduce((a, f) => a + (f.lean === 'more' ? f.base : 1 - f.base), 0) / g.length : null;
      PD[st] = { made: all.length, graded: g.length, pending: all.filter(f => !f.graded).length, hits, hitPct: pct(hits, g.length),
        ci95: [r2(ci[0] * 100), r2(ci[1] * 100)], chancePct: exp == null ? null : r2(exp * 100),
        p: g.length && exp != null ? Math.round(binomUpper(g.length, hits, exp) * 1000) / 1000 : null };
    }
    { const g = DL.filter(f => f.study === 'big' && f.graded && (f.graded.biasResult === 'hit' || f.graded.biasResult === 'miss'));
      const hits = g.filter(f => f.graded.biasResult === 'hit').length, ci = wilson(hits, g.length);
      const exp = g.length ? g.reduce((a, f) => a + (f.bias.lean === 'UP' ? f.bias.out.base : 1 - f.bias.out.base), 0) / g.length : null;
      PD.bigDirection = { made: DL.filter(f => f.study === 'big' && f.bias && f.bias.lean).length, graded: g.length, hits, hitPct: pct(hits, g.length),
        ci95: [r2(ci[0] * 100), r2(ci[1] * 100)], chancePct: exp == null ? null : r2(exp * 100),
        p: g.length && exp != null ? Math.round(binomUpper(g.length, hits, exp) * 1000) / 1000 : null,
        rule: 'on big-move sessions only: close vs previous close in the named direction; chance = its own 2019+ up-share on big-move days' }; }
    const lastD = DL.slice().sort((a, b) => a.target < b.target ? -1 : 1).pop();
    if (B[inst]) { const bb = B[inst], N = bb.length, tr = [];
      let up = 0, n = 0; for (let i = Math.max(1, N - 250); i < N; i++) { n++; if ((bb[i].c / bb[i - 1].c - 1) * 100 > FLAT) up++; }
      let gp = 0, gn = 0; for (let i = Math.max(1, N - 250); i < N; i++) { const b = bb[i], pc = bb[i - 1].c; if (!(b.o > 0) || (b.o === b.h && b.h === b.l && b.l === b.c)) continue; gn++; if (Math.abs(b.o - pc) / pc * 100 > 0.5) gp++; }
      PD.baselines = { window: 'last 250 sessions', upPct: pct(up, n), gapPct: pct(gp, gn), bigPct: 30, bigRule: 'true range above the 70th percentile of the previous 250 sessions',
        lastPrediction: lastD ? { target: lastD.target, base: lastD.base, bigThrPct: lastD.bigThrPct } : null };
    }
    S.provenDaily[inst] = PD;
    if (B[inst] && SW[inst]) S.chance[inst] = { window5: r2(chanceFor(B[inst], SW[inst], 5) * 100), window3: r2(chanceFor(B[inst], SW[inst], 3) * 100),
      pivots: SW[inst].length, from: B[inst][0].date, to: B[inst][B[inst].length - 1].date, rule: `>=${SW_MIN}% swing, >=${SW_MAJ}% major` };
  }
  return S;
}

/* ── main ── */
(async () => {
  const made = new Date().toISOString();
  const logP = path.join(OUT, 'log.json');
  const log = readJSON(logP, null) || { version: VERSION, since: null, entries: [], reversals: [], runs: [] };
  log.version = VERSION; log.entries = log.entries || []; log.reversals = log.reversals || []; log.runs = log.runs || []; log.daily = log.daily || [];
  const run = { at: made, target: null, added: 0, turnsAdded: 0, graded: 0, turnsGraded: 0, dailyAdded: 0, dailyGraded: 0, errors: [] };
  let P = null;
  try { P = loadPage(); if (P.errs.length) run.errors.push('page load: ' + P.errs.slice(0, 3).join(' | ')); }
  catch (e) { run.errors.push('page load failed: ' + e.message); }
  const B = {}, SW = {};
  for (const inst of INSTS) { try { B[inst.k] = bars(inst); } catch (e) { run.errors.push(inst.k + ': ' + e.message); } }
  if (P) {
    const have = new Set(log.entries.map(e => e.id));
    const turnKey = f => [f.inst, f.source, f.rawFrom || f.from, f.rawTo || f.to, f.type].join('|');
    const haveT = new Set(log.reversals.map(turnKey));
    const haveD = new Set(log.daily.map(f => f.id));
    run.targets = {}; run.ms = {};
    const tick = () => Date.now();
    // (1) build every instrument's tables first (Astral turn table, Planet Lat/Lon, proven daily), so each
    //     CONFIRMED check sees all the other instruments, each learned separately
    const built = new Set();
    P.E(`window.TN.swingPct=${SW_MIN}; window.TN.majPct=${SW_MAJ};`);
    for (const inst of INSTS) {
      const bb = B[inst.k]; if (!bb) continue;
      try { SW[inst.k] = swingsOf(P, bb); } catch (e) { run.errors.push(inst.k + ' swings: ' + e.message); }
      if (Date.now() - T0 > BUDGET_MS) { run.errors.push(inst.k + ': deferred to the next run (time budget ' + Math.round(BUDGET_MS / 60000) + ' min)'); continue; }
      const ms = run.ms[inst.k] = {}; let t = tick();
      try { await P.E(`tnLoad(${JSON.stringify(inst.k)})`); } catch (e) {} ms.astral = tick() - t; t = tick();
      P.ctx.__q = { plan: inst.plan };
      try { await P.E(`tnLfBuild(tnLfKey(__q.plan,'lat'),__q.plan,'lat')`); } catch (e) {} ms.latlon = tick() - t; t = tick();
      P.ctx.__q = { k: inst.k };
      try { await P.E(`dpBuild(__q.k,'lahiri')`); } catch (e) {} ms.daily = tick() - t;
      built.add(inst.k);
      console.log(`  built ${inst.k.padEnd(9)} astral ${(ms.astral / 1000).toFixed(1)}s · lat/lon ${(ms.latlon / 1000).toFixed(1)}s · daily ${(ms.daily / 1000).toFixed(1)}s · total ${((Date.now() - T0) / 1000).toFixed(0)}s`);
    }
    // (2) predict: each instrument's next session is the weekday after ITS OWN last bar
    run.ahead = SESSIONS; run.aheadTargets = {};
    for (const inst of INSTS) {
      const bb = B[inst.k]; if (!bb || !built.has(inst.k)) continue;
      const asOf = bb[bb.length - 1].date;
      // the next SESSIONS weekdays after this instrument's own last bar
      const targets = []; { let t = nextSess(asOf); for (let j = 0; j < SESSIONS; j++) { targets.push(t); t = nextSess(t); } }
      const target = targets[0], horizonEnd = sessAdd(target, HORIZON - 1);
      run.targets[inst.k] = target; if (inst.k === 'NIFTY') run.target = target;
      run.aheadTargets[inst.k] = targets;
      // (a) turn windows first, so every window covering one of the five sessions can be stamped onto its entry
      let T = [];
      try {
        T = await predictTurns(P, inst, target, horizonEnd, made, asOf);
        for (const f of T) { const k = turnKey(f); if (haveT.has(k)) continue; haveT.add(k);
          f.id = k; f.graded = null; log.reversals.push(f); run.turnsAdded++; }
      } catch (e) { run.errors.push(inst.k + ' turns: ' + e.message); }
      const winsOn = ds => T.filter(f => f.from <= ds && ds <= f.to).map(f => ({ id: f.id || turnKey(f),
        source: f.source, type: f.type, from: f.from, to: f.to, at: f.at, proven: !!f.edge }));
      // (b) one direction call per session, five sessions out
      for (let j = 0; j < targets.length; j++) {
        const tg = targets[j], hist = bb.filter(b => b.date < tg);
        let D = [];
        try {
          D = await predictDaily(P, inst, hist, tg, made);
          for (const f of D) { f.seq = j + 1; if (haveD.has(f.id)) continue; haveD.add(f.id); log.daily.push(f); run.dailyAdded++; }
        } catch (e) { run.errors.push(inst.k + ' proven daily ' + tg + ': ' + e.message); }
        // never overwrite: a prediction is frozen once written, whichever run first reached that session
        if (have.has(tg + '|' + inst.k)) continue;
        have.add(tg + '|' + inst.k);
        try {
          const en = predictDay(P, inst, hist, tg, made);
          en.seq = j + 1;                       // 1 = the next session ... 5 = four sessions later
          en.turns = winsOn(tg);                // turn windows covering this session
          en.daily = D.map(f => ({ id: f.id, study: f.study, pattern: f.pattern, plain: f.plain, claim: f.claim, lean: f.lean,
            bias: f.bias ? { lean: f.bias.lean, claim: f.bias.claim } : null,
            in: f.backtest ? f.backtest.in : null, out: f.backtest ? f.backtest.out : null }));
          log.entries.push(en); run.added++;
        } catch (e) { run.errors.push(inst.k + ' predict ' + tg + ': ' + e.message); }
      }
    }
    if (!run.target) run.target = Object.values(run.targets).sort().pop() || null;
  }
  for (const f of log.daily) { if (f.graded || !B[f.inst]) continue;
    try { const g = gradeDaily(f, B[f.inst]); if (g) { f.graded = g; run.dailyGraded++; } } catch (x) { run.errors.push(f.id + ' grade: ' + x.message); } }
  // grade whatever the baked bars now settle
  for (const e of log.entries) { if (e.graded || !B[e.inst]) continue;
    try { const g = gradeDay(e, B[e.inst]); if (g) { e.graded = g; run.graded++; } } catch (x) { run.errors.push(e.id + ' grade: ' + x.message); } }
  for (const f of log.reversals) { if (f.graded || !B[f.inst] || !SW[f.inst]) continue;
    try { const g = gradeTurn(f, B[f.inst], SW[f.inst]); if (g) { f.graded = g; run.turnsGraded++; } } catch (x) { run.errors.push(f.id + ' grade: ' + x.message); } }
  if (!log.since && log.entries.length) log.since = log.entries.reduce((m, e) => e.made < m ? e.made : m, log.entries[0].made).slice(0, 10);
  log.entries.sort((a, b) => a.target < b.target ? -1 : a.target > b.target ? 1 : a.inst < b.inst ? -1 : 1);
  log.daily.sort((a, b) => a.target < b.target ? -1 : a.target > b.target ? 1 : a.id < b.id ? -1 : 1);
  log.reversals.sort((a, b) => a.from < b.from ? -1 : a.from > b.from ? 1 : a.id < b.id ? -1 : 1);
  log.runs.push(run); log.runs = log.runs.slice(-60);
  const S = summarise(log, B, SW); S.lastRun = run;
  fs.mkdirSync(OUT, { recursive: true });
  const put = (p, o) => { fs.writeFileSync(p + '.tmp', JSON.stringify(o, null, 1) + '\n'); fs.renameSync(p + '.tmp', p); };   // never a half-written file
  put(logP, log);
  put(path.join(OUT, 'summary.json'), S);

  // concise console report
  console.log(`forward test · ${((Date.now() - T0) / 1000).toFixed(0)}s · targets ${Object.entries(run.targets || {}).map(([k, t]) => k + ' ' + t).join(', ')} · +${run.added} day forecasts (${SESSIONS} sessions ahead) · +${run.turnsAdded} turn windows · graded ${run.graded} days / ${run.turnsGraded} turns · proven daily +${run.dailyAdded} / graded ${run.dailyGraded}`);
  const ahead = new Set(Object.values(run.aheadTargets || {}).flat());
  for (const e of log.entries.filter(e => ahead.has(e.target) && !e.graded))
    console.log(`  ${e.inst.padEnd(9)} ${e.target} s${e.seq || 1} astro ${String(e.astro.score).padStart(4)} ${e.astro.band.padEnd(18)} tech ${String(e.tech.net).padStart(5)} → astroOnly ${e.calls.astroOnly} techOnly ${e.calls.techOnly} filter ${e.calls.techWithAstroFilter} both ${e.calls.astroAndTech} vol ${e.vol} - turns ${(e.turns || []).length} - proven daily ${(e.daily || []).length}`);
  for (const [k, r] of Object.entries(S.direction))
    console.log(`  ${k.padEnd(9)} astroOnly ${r.astroOnly.hits}/${r.astroOnly.n} · techOnly ${r.techOnly.hits}/${r.techOnly.n} · always-bull ${r.alwaysBullish.hits}/${r.alwaysBullish.n} · turns ${Object.entries(S.turns[k]).map(([s, t]) => `${s} ${t.hits}/${t.graded} (${t.pending} pending)`).join(', ')}`);
  for (const f of log.daily.filter(f => (run.targets || {})[f.inst] === f.target)) console.log(`  ${f.inst.padEnd(9)} Proven daily ${f.study}: ${f.claim} — ${f.plain}`);
  for (const [k, r] of Object.entries(S.provenDaily)) console.log(`  ${k.padEnd(9)} proven daily ${['dir', 'big', 'gap'].map(s => `${s} ${r[s].hits}/${r[s].graded} vs ${r[s].chancePct == null ? '—' : r[s].chancePct + '%'} (${r[s].pending} pending)`).join(', ')}`);
  if (run.errors.length) console.log('  errors: ' + run.errors.join(' | '));
  process.exit(0);
})().catch(e => { console.log('forward_log failed: ' + (e && e.stack || e)); process.exit(0); });
