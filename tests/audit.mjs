// Auditor: tries hard (many TomTom requests, independent methods) to find routes better than the app's frontier.
// Usage: node tests/audit.mjs [trip names…]   (diesel, Fri 13 Nov 08:00). TomTom answers cached on disk (data/cache/audit).
// A "gap" = an audit route not dominated by the app's efficient routes (≥ 2 min faster for the same cost, or
// ≥ 1 € cheaper for the same time). Gaps show where the engine's search must be improved.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

const ROOT = new URL('../', import.meta.url).pathname;
const CACHE = ROOT + 'data/cache/audit/';
mkdirSync(CACHE, { recursive: true });
const realFetch = globalThis.fetch;
let apiCalls = 0, cacheHits = 0;
globalThis.fetch = async (url, opts = {}) => {
  if (typeof url === 'string' && !url.startsWith('http')) {
    const body = readFileSync(ROOT + 'app/' + url, 'utf8');
    return { ok: true, status: 200, json: async () => JSON.parse(body) };
  }
  if (!String(url).includes('api.tomtom.com')) return realFetch(url, opts);
  const h = createHash('sha1').update(String(url).replace(/key=[^&]+/, '') + (opts.body || '')).digest('hex');
  const f = CACHE + h + '.json';
  if (existsSync(f)) { cacheHits++; const j = readFileSync(f, 'utf8'); return { ok: true, status: 200, json: async () => JSON.parse(j) }; }
  apiCalls++;
  const r = await realFetch(url, opts);
  if (!r.ok) return r;
  const j = await r.json();
  writeFileSync(f, JSON.stringify(j));
  return { ok: true, status: 200, json: async () => j };
};
const store = {};
globalThis.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); } };
const KEY = readFileSync(ROOT + '.env', 'utf8').match(/TOMTOM_KEY=(\S+)/)[1];
store.tomtomKey = KEY;

const { loadTolls, priceRoute } = await import('../app/js/tolls.js');
const { analyse, DEFAULT_VEHICLES, energy } = await import('../app/js/optimizer.js');
const { routePoints, cumulative, km } = await import('../app/js/geo.js');
const { stats } = await import('../app/js/services.js');
await loadTolls();

const HOME = [49.00297, 1.3155];
const TRIPS = {
  bordeaux: [44.84123, -0.58004], brive: [45.1585, 1.53324], demangevelle: [47.9258, 6.03171],
  lyon: [45.7578, 4.832], nantes: [47.2184, -1.5536], lille: [50.6292, 3.0573], strasbourg: [48.5734, 7.7521],
  rennes: [48.1173, -1.6778], clermont: [45.7772, 3.087], toulouse: [43.6047, 1.4442], reims: [49.2583, 4.0317],
  tours: [47.3941, 0.6848], dijon: [47.322, 5.0415], caen: [49.1829, -0.3707], annecy: [45.8992, 6.1294],
};
const WHEN = '2026-11-13T08:00';
const depart = new Date(WHEN);
const v = DEFAULT_VEHICLES.diesel;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let slot = 0;
async function tt(path, extra = '', body = null) {
  const now = Date.now(); const s = Math.max(now, slot); slot = s + 260; if (s > now) await sleep(s - now);
  const url = `https://api.tomtom.com/routing/1/calculateRoute/${path}/json?key=${KEY}&traffic=true&departAt=${WHEN}:00` +
    `&sectionType=tollRoad&sectionType=motorway&instructionsType=coded${extra}`;
  for (let a = 0; a < 5; a++) {
    const r = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    if (r.status === 429) { await sleep(1500 * (a + 1)); continue; }
    if (!r.ok) return [];
    return (await r.json()).routes || [];
  }
  return [];
}
function evalRoute(r, label) {
  const p = priceRoute(r, depart);
  if (p.unpriced) return null;
  const rp = routePoints(r);
  let mkm = 0;
  for (const s of r.sections || []) if (s.sectionType === 'MOTORWAY') for (let i = s.startPointIndex + 1; i <= s.endPointIndex; i++) mkm += km(rp[i - 1], rp[i]);
  const c = { label, sec: r.summary.travelTimeInSeconds, km: r.summary.lengthInMeters / 1000, mkm, toll: p.toll };
  Object.assign(c, energy(c, v));
  c.cost = c.toll + c.energy; c.min = c.sec / 60 + c.chargeMin;
  const rn = []; for (const i of r.guidance?.instructions || []) { const n = (i.roadNumbers || [])[0]; if (n && /^[AN]\d/.test(n) && !rn.includes(n)) rn.push(n); }
  c.roads = rn.slice(0, 8).join(' ');
  return c;
}

async function audit(name) {
  const d = TRIPS[name], o = HOME, P = (p) => `${p[0]},${p[1]}`;
  const a0 = stats.api;
  const app = await analyse(o, d, v, depart, () => {}, { estimator: 'tomtom' });
  const appReq = stats.api - a0;
  const F = app.eff;
  const ref = F.find((e) => e.isRef);
  const cands = [];
  const add = (rs, label) => rs.forEach((r, i) => { const c = evalRoute(r, label + (rs.length > 1 ? ` #${i}` : '')); if (c) cands.push(c); });
  // 1. alternatives, with and without tolls
  add(await tt(`${P(o)}:${P(d)}`, '&maxAlternatives=5'), 'alternative');
  add(await tt(`${P(o)}:${P(d)}`, '&maxAlternatives=3&avoid=tollRoads'), 'sans péage alt');
  // 2. via points on both sides of the corridor
  const fr = (await tt(`${P(o)}:${P(d)}`))[0];
  const pts = routePoints(fr), cum = cumulative(pts), L = cum[cum.length - 1];
  const at = (x) => { let i = 0; while (cum[i] < x) i++; return i; };
  const jobs = [];
  for (const f of [0.15, 0.3, 0.45, 0.6, 0.75, 0.9]) {
    const i = at(L * f), j = Math.min(pts.length - 1, at(L * f + 2));
    const [la, lo] = pts[i], dy = pts[j][0] - la, dx = (pts[j][1] - lo) * Math.cos(la * Math.PI / 180);
    const n = Math.hypot(dx, dy) || 1;
    for (const off of [-30, -12, 12, 30]) {
      const k = off / 111;
      const w = [la + (dx / n) * k, lo + (-dy / n) * k / Math.cos(la * Math.PI / 180)];   // perpendicular offset
      jobs.push(tt(`${P(o)}:${w[0].toFixed(5)},${w[1].toFixed(5)}:${P(d)}`).then((rs) => add(rs, `via ${Math.round(f * 100)}% ${off > 0 ? '+' : ''}${off} km`)));
    }
  }
  // 3. blocked spots every ~15 km on the toll sections (singly)
  for (const s of fr.sections.filter((x) => x.sectionType === 'TOLL_ROAD')) {
    for (let x = cum[s.startPointIndex] + 7; x < cum[s.endPointIndex] - 3; x += 15) {
      const [la, lo] = pts[at(x)];
      const box = { southWestCorner: { latitude: la - 0.0012, longitude: lo - 0.0018 }, northEastCorner: { latitude: la + 0.0012, longitude: lo + 0.0018 } };
      jobs.push(tt(`${P(o)}:${P(d)}`, '', { avoidAreas: { rectangles: [box] } }).then((rs) => add(rs, `bloque km ${Math.round(x)}`)));
    }
  }
  await Promise.all(jobs);
  // gaps
  const gaps = [];
  for (const c of cands) {
    if (c.cost >= ref.cost - 0.3) continue;
    const dominated = F.some((f) => f.min <= c.min + 2 && f.cost <= c.cost + 1);
    if (!dominated) {
      const sameTime = F.filter((f) => f.min <= c.min + 0.5).sort((a, b) => a.cost - b.cost)[0];
      gaps.push({ c, better: sameTime ? sameTime.cost - c.cost : 0 });
    }
  }
  gaps.sort((a, b) => b.better - a.better);
  const best = F.find((e) => e.best);
  const all = [...F.map((f) => ({ min: f.min, cost: f.cost, label: f.label, app: true })), ...cands];
  const fr2 = all.filter((c) => !all.some((x) => x !== c && x.min <= c.min && x.cost <= c.cost && (x.min < c.min || x.cost < c.cost)));
  const S = Math.max(...fr2.map((c) => ref.cost - c.cost), 1), T = Math.max(...fr2.map((c) => c.min - ref.min), 1);
  const comp = fr2.filter((c) => c.cost < ref.cost - 0.3).map((c) => ({ c, s: (ref.cost - c.cost) / S - (c.min - ref.min) / T })).sort((a, b) => b.s - a.s)[0];
  const fmt = (c) => `+${Math.round(c.min - ref.min)} min −${(ref.cost - c.cost).toFixed(2)} €`;
  console.log(`\n== ${name}: app ${appReq} req, audit ${cands.length} routes | app best: ${best ? fmt(best) + ' ' + best.label.slice(0, 70) : '—'}`);
  console.log(`   best compromise over app+audit: ${comp ? fmt(comp.c) + ' ' + (comp.c.app ? '[app] ' : '[AUDIT] ') + comp.c.label.slice(0, 60) + (comp.c.roads ? ' (' + comp.c.roads + ')' : '') : '—'}`);
  for (const g of gaps.slice(0, 5)) console.log(`   GAP ${fmt(g.c)} (${g.better.toFixed(2)} € better than app at same time) ${g.c.label} | ${g.c.roads}`);
  if (!gaps.length) console.log('   no gap: app frontier not beaten');
  return { name, gaps: gaps.length, appBestIsBest: !!(comp && comp.c.app) };
}

const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(TRIPS);
const res = [];
for (const n of names) res.push(await audit(n));
console.log(`\nSummary: ${res.filter((r) => !r.gaps).length}/${res.length} trips without gap, app best compromise kept on ${res.filter((r) => r.appBestIsBest).length}/${res.length}. TomTom: ${apiCalls} new requests, ${cacheHits} from disk cache.`);
