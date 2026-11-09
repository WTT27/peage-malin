// Shared test setup for Node: app data files read from disk, TomTom answers cached on disk (data/cache/audit, same
// cache as tests/audit.mjs, so re-runs cost no requests), fake localStorage, TomTom key from .env (never committed).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const ROOT = new URL('../', import.meta.url).pathname;
const CACHE = ROOT + 'data/cache/audit/';
mkdirSync(CACHE, { recursive: true });
export const net = { tomtomNew: 0, tomtomDisk: 0 };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  if (typeof url === 'string' && !url.startsWith('http')) {
    const body = readFileSync(ROOT + 'app/' + url, 'utf8');
    return { ok: true, status: 200, json: async () => JSON.parse(body) };
  }
  if (!String(url).includes('api.tomtom.com')) return realFetch(url, opts);
  const h = createHash('sha1').update(String(url).replace(/key=[^&]+/, '') + (opts.body || '')).digest('hex');
  const f = CACHE + h + '.json';
  if (existsSync(f)) { net.tomtomDisk++; const j = readFileSync(f, 'utf8'); return { ok: true, status: 200, json: async () => JSON.parse(j) }; }
  net.tomtomNew++;
  const r = await realFetch(url, opts);
  if (!r.ok) return r;
  const j = await r.json();
  writeFileSync(f, JSON.stringify(j));
  return { ok: true, status: 200, json: async () => j };
};
const store = {};
globalThis.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
export const KEY = readFileSync(ROOT + '.env', 'utf8').match(/TOMTOM_KEY=(\S+)/)[1];
store.tomtomKey = KEY;

// test trips: same start and destinations as tests/audit.mjs
export const HOME = [49.00297, 1.3155];
export const TRIPS = {
  bordeaux: [44.84123, -0.58004], brive: [45.1585, 1.53324], demangevelle: [47.9258, 6.03171],
  lyon: [45.7578, 4.832], nantes: [47.2184, -1.5536], lille: [50.6292, 3.0573], strasbourg: [48.5734, 7.7521],
  rennes: [48.1173, -1.6778], clermont: [45.7772, 3.087], toulouse: [43.6047, 1.4442], reims: [49.2583, 4.0317],
  tours: [47.3941, 0.6848], dijon: [47.322, 5.0415], caen: [49.1829, -0.3707], annecy: [45.8992, 6.1294],
};
export const WHEN = '2026-11-13T08:00';
export const hm = (m) => `${Math.floor(Math.round(m) / 60)} h ${String(Math.round(m) % 60).padStart(2, '0')}`;
