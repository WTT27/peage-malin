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

const { loadTolls } = await import('../app/js/tolls.js');
const { analyse, ladder, DEFAULT_VEHICLES, googleMapsUrl } = await import(process.env.ENGINE || '../app/js/optimizer.js');
const { stats } = await import('../app/js/services.js');
globalThis.PM_DEBUG = !!process.env.PM_DEBUG;
await loadTolls();
const [, , dest, veh = 'diesel', when = '2026-11-13T08:00'] = process.argv;
const D = { bordeaux: [44.84123, -0.58004], brive: [45.1585, 1.53324], demangevelle: [47.9258, 6.03171] };
const o = [49.00297, 1.3155];
const t0 = Date.now();
const r = await analyse(o, D[dest], DEFAULT_VEHICLES[veh], new Date(when), () => {}, { estimator: process.env.MODE || 'tomtom' });
if (r.notice) console.log('NOTICE:', r.notice);
const hm = (m) => `${Math.floor(Math.round(m) / 60)} h ${String(Math.round(m) % 60).padStart(2, '0')}`;
console.log(`${dest} ${veh} [${r.mode}]: ${r.count} évalués, ${r.eff.length} efficaces, TomTom ${stats.api} requêtes (+${stats.cached} cache), Valhalla ${stats.valhalla}, confirmés ${r.confirmed}, facteur ${r.factor?.toFixed(2)}, ${Math.round((Date.now() - t0) / 1000)} s`);
for (const e of r.eff) console.log(`  ${e.best ? '⭐' : e.freeWin ? '🟢' : '  '} +${String(Math.round(e.dMin)).padStart(3)}'  -${e.save.toFixed(2).padStart(6)} €  ${hm(e.min)}  ${e.cost.toFixed(2)} €  ${e.label.slice(0, 100)}`);
const best = r.eff.find((e) => e.best);
if (best) console.log('  GoogleMaps:', googleMapsUrl(o, D[dest], best.via));
