/* Load index.html's <script> blocks into a Node VM with just enough DOM for the
   pure functions (ephemeris, panchang) to run headless. */
const fs = require('fs');
const vm = require('vm');
function stubEl() {
  return {
    innerHTML: '', innerText: '', textContent: '', value: '', style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    children: [], appendChild() {}, removeChild() {}, setAttribute() {},
    getAttribute() { return null; }, addEventListener() {}, removeEventListener() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    closest() { return null; }, scrollIntoView() {}, focus() {}, click() {}, remove() {},
    getBoundingClientRect() { return { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }; },
    getContext() { return null; },
  };
}
function loadPage(file) {
  const html = fs.readFileSync(file, 'utf8');
  const scripts = [];
  const re = /<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) scripts.push(m[1]);
  const doc = {
    readyState: 'complete', body: stubEl(), documentElement: stubEl(), head: stubEl(),
    getElementById() { return stubEl(); }, querySelector() { return null; },
    querySelectorAll() { return []; }, createElement() { return stubEl(); },
    createTextNode() { return stubEl(); }, createDocumentFragment() { return stubEl(); },
    addEventListener() {}, removeEventListener() {},
  };
  const store = new Map();
  const ctx = {
    console, Math, Date, JSON, Object, Array, String, Number, Boolean, RegExp, Error,
    TypeError, Map, Set, WeakMap, WeakSet, Promise, Symbol, isFinite, isNaN, parseInt,
    parseFloat, Int32Array, Float64Array, Float32Array, Uint8Array, Uint16Array,
    Uint32Array, ArrayBuffer, DataView, Intl, encodeURIComponent, decodeURIComponent,
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    document: doc, navigator: { userAgent: 'node', language: 'en-IN' },
    location: { hash: '', href: 'http://localhost/', search: '', replace() {} },
    history: { replaceState() {}, pushState() {} },
    localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k), clear: () => store.clear() },
    addEventListener() {}, removeEventListener() {},
    requestAnimationFrame: fn => setTimeout(fn, 0), cancelAnimationFrame() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    MutationObserver: function () { return { observe() {}, disconnect() {} }; },
    ResizeObserver: function () { return { observe() {}, disconnect() {} }; },
    IntersectionObserver: function () { return { observe() {}, disconnect() {} }; },
    fetch: () => Promise.reject(new Error('offline')), indexedDB: undefined,
    performance: { now: () => Number(process.hrtime.bigint() / 1000n) / 1000 },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    devicePixelRatio: 1, innerWidth: 1280, innerHeight: 900,
    alert() {}, confirm() { return false; }, prompt() { return null; },
    URL, Blob: function () {}, TextEncoder, TextDecoder, btoa, atob,
  };
  ctx.window = ctx; ctx.globalThis = ctx; ctx.self = ctx;
  vm.createContext(ctx);
  scripts.forEach((src, i) => { try { vm.runInContext(src, ctx, { filename: 'script#' + (i + 1) }); } catch (e) { } });
  return ctx;
}
module.exports = { loadPage };
