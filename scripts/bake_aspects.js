/* Bake every exact major aspect between ten bodies, 2000-01-01 -> 2035-12-31,
 * into data/aspects/exact.json for the terminal's ASPECTS tab and the study page.
 *
 * Read daily at 09:15 IST with the terminal's own VSOP87/ELP ephemeris. An
 * aspect is "exact" on the day its separation sits closest to the angle, within
 * 1.5 degrees. Separation is the same tropical or sidereal, so the angle needs
 * no ayanamsa; the sidereal (Lahiri) positions are stored only for display.
 *
 * Moon is left out on purpose: it makes every aspect to every planet about
 * twice a month, so its windows would overlap constantly. Ketu is always
 * opposite Rahu, so every Ketu aspect is a Rahu aspect seen from the far end.
 *
 * Usage (from the repo root): node scripts/bake_aspects.js index.html data/aspects/exact.json
 */
process.on('uncaughtException', () => {});
const fs = require('fs');
const { loadPage } = require('./loadpage.js');
const [, , PAGE = 'index.html', OUT = 'data/aspects/exact.json'] = process.argv;
const c = loadPage(PAGE);

const BODIES = ['Sun', 'Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Rahu', 'Uranus', 'Neptune', 'Pluto'];
const ANG = [0, 60, 90, 120, 180];
const FROM = '2000-01-01', TO = '2035-12-31';
const iso = (ds, n) => { const [y, m, d] = ds.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const r2 = v => Math.round(v * 100) / 100, r1 = v => Math.round(v * 10) / 10;

function sky(ds) {
  const [y, m, d] = ds.split('-').map(Number);
  const J = c.JD(y, m, d, 9.25);
  let ayn = 0; try { ayn = c.getAyanamsa(J, 'lahiri'); } catch (e) { }
  const lon = [], sid = [], rx = [];
  for (const b of BODIES) {
    const L = c.geoLon(b, J), a = c.geoLon(b, J - 0.5), z = c.geoLon(b, J + 0.5);
    lon.push(L);
    let s = (L - ayn) % 360; if (s < 0) s += 360; sid.push(s);
    let df = z - a; while (df > 180) df -= 360; while (df < -180) df += 360;
    rx.push(b === 'Rahu' ? false : df < 0);        // Rahu is always retrograde; not worth flagging
  }
  return { lon, sid, rx };
}
const sep = (a, b) => { let s = Math.abs(a - b) % 360; return s > 180 ? 360 - s : s; };

const days = [];
for (let ds = iso(FROM, -1); ds <= iso(TO, 1); ds = iso(ds, 1)) days.push(ds);
process.stderr.write('reading ' + days.length + ' days…\n');
const SK = days.map((ds, i) => { if (i % 3000 === 0) process.stderr.write('  ' + i + '\n'); return sky(ds); });

const rows = [];
for (let i = 1; i < days.length - 1; i++) {
  const p = SK[i - 1], t = SK[i], n = SK[i + 1];
  for (let a = 0; a < BODIES.length; a++) for (let b = a + 1; b < BODIES.length; b++) {
    const s0 = sep(p.lon[a], p.lon[b]), s1 = sep(t.lon[a], t.lon[b]), s2 = sep(n.lon[a], n.lon[b]);
    ANG.forEach((ang, k) => {
      const d0 = Math.abs(s0 - ang), d1 = Math.abs(s1 - ang), d2 = Math.abs(s2 - ang);
      if (d1 <= d0 && d1 < d2 && d1 < 1.5)
        rows.push([days[i], a, b, k, r2(d1), (t.rx[a] ? 1 : 0) | (t.rx[b] ? 2 : 0), r1(t.sid[a]), r1(t.sid[b])]);
    });
  }
}
const out = {
  generated: new Date().toISOString().slice(0, 10), from: FROM, to: TO, reading: '09:15 IST, sidereal Lahiri for positions',
  bodies: BODIES, aspects: ['Conjunction', 'Sextile', 'Square', 'Trine', 'Opposition'], angles: ANG,
  columns: ['date', 'a', 'b', 'aspect', 'orb', 'retro_mask(1=a,2=b)', 'sid_a', 'sid_b'], rows,
};
fs.mkdirSync(require('path').dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out));
process.stderr.write('wrote ' + OUT + ': ' + rows.length + ' exact aspects, ' + (fs.statSync(OUT).size / 1024).toFixed(0) + ' KB\n');
process.exit(0);
