// Node test: run the app's JS engine on the test trips and print results (compare with Python optimizer).
import { readFileSync } from 'node:fs';
const realFetch = globalThis.fetch;
globalThis.fetch = (url, opts) => {
  if (typeof url === 'string' && !url.startsWith('http')) {
    const body = readFileSync(new URL('../app/' + url, import.meta.url), 'utf8');
    return Promise.resolve({ ok: true, json: async () => JSON.parse(body) });
  }
  return realFetch(url, opts);
};
const store = {};
globalThis.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); } };
const key = readFileSync(new URL('../.env', import.meta.url), 'utf8').match(/TOMTOM_KEY=(\S+)/)[1];
store.tomtomKey = key;

if (process.env.APPROACH) globalThis.PM_APPROACH = process.env.APPROACH;
const { loadTolls } = await import('../app/js/tolls.js');
const { analyse, ladder, DEFAULT_VEHICLES, googleMapsUrl } = await import(process.env.ENGINE || '../app/js/optimizer.js');
const { stats } = await import('../app/js/services.js');
globalThis.PM_DEBUG = !!process.env.PM_DEBUG;
await loadTolls();
const [, , dest, veh = 'diesel', when = '2026-11-13T08:00'] = process.argv;
const D = { lille: [50.6292, 3.0573], nantes: [47.2184, -1.5536], lyon: [45.7578, 4.832], bordeaux: [44.84123, -0.58004], brive: [45.1585, 1.53324], demangevelle: [47.9258, 6.03171] };
const o = [49.00297, 1.3155];
const t0 = Date.now();
const vv = { ...DEFAULT_VEHICLES[veh], ...JSON.parse(process.env.VEH || '{}') };
const r = await analyse(o, D[dest], vv, new Date(when), () => {});
const hm = (m) => `${Math.floor(Math.round(m) / 60)} h ${String(Math.round(m) % 60).padStart(2, '0')}`;
console.log(`${dest} ${veh}: ${r.count} évalués, ${r.eff.length} efficaces, TomTom ${stats.api} requêtes (+${stats.cached} cache), confirmés ${r.confirmed}, ${Math.round((Date.now() - t0) / 1000)} s`);
for (const e of r.eff) {
  console.log(`  ${e.best ? '⭐' : e.freeWin ? '🟢' : '  '} +${String(Math.round(e.dMin)).padStart(3)}'  -${e.save.toFixed(2).padStart(6)} €  ${hm(e.min)}  ${e.cost.toFixed(2)} €  ${e.label.slice(0, 100)}`);
  if (e.charge) {
    const c = e.charge;
    if (!c.ok) console.log('        ⚠️ pas de borne rapide atteignable trouvée');
    for (const s of c.stops) console.log(`        🔌 ${s.brand} ${s.name} ${s.kw} kW à ${Math.round(s.posKm)} km, ${Math.floor(s.eta)}h${String(Math.round(s.eta % 1 * 60)).padStart(2, '0')}, ${s.arrivePct}→${s.leavePct} %, ${s.kwh.toFixed(1)} kWh × ${s.price} = ${s.eur.toFixed(2)} €, ${s.min} min${s.lunch ? ' 🍽️' : ''}${s.off > 0.3 ? ` (à ${s.off.toFixed(1)} km de la route)` : ''}`);
    if (c.ok) console.log(`        arrivée ${c.arrivePct} % · recharge comptée ${Math.round(e.chargeMin)} min${c.winter ? ' · hiver' : ''}`);
  }
}
const best = r.eff.find((e) => e.best);
if (best) console.log('  GoogleMaps:', googleMapsUrl(o, D[dest], best.via));
