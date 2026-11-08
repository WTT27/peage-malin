// External services: TomTom routing, Overpass (local roads), Nominatim (addresses), fuel price.
import { km } from './geo.js';

export const stats = { api: 0, cached: 0 };
const cache = new Map();
let lastCall = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function getKey() {
  try { return localStorage.getItem('tomtomKey') || ''; } catch { return ''; }
}
export function setKey(k) {
  try { localStorage.setItem('tomtomKey', k.trim()); } catch { /* private mode */ }
}

// TomTom route; returns an array of routes ([] if no route)
export async function route(o, d, { avoidTolls = false, maxSpeed = null, depart = null, alternatives = 0 } = {}) {
  const key = getKey();
  if (!key) throw new Error('Clé TomTom manquante (voir Réglages)');
  const ck = JSON.stringify([o, d, avoidTolls, maxSpeed, depart, alternatives]);
  if (cache.has(ck)) { stats.cached++; return cache.get(ck); }
  let url = `https://api.tomtom.com/routing/1/calculateRoute/${o[0]},${o[1]}:${d[0]},${d[1]}/json?key=${encodeURIComponent(key)}` +
    `&traffic=true&sectionType=tollRoad&sectionType=motorway&maxAlternatives=${alternatives}`;
  if (avoidTolls) url += '&avoid=tollRoads';
  if (maxSpeed) url += `&vehicleMaxSpeed=${maxSpeed}`;
  if (depart) url += `&departAt=${depart}`;
  for (let attempt = 0; attempt < 6; attempt++) {
    const wait = 260 - (Date.now() - lastCall); // ~4 requests / second (free tier limit 5/s)
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    stats.api++;
    const r = await fetch(url);
    if (r.status === 429) { await sleep(1000 * 2 ** attempt); continue; }
    if (r.status === 400 || r.status === 404) { cache.set(ck, []); return []; }
    if (r.status === 403) throw new Error('Clé TomTom refusée ou quota du jour épuisé');
    if (!r.ok) throw new Error(`TomTom: erreur ${r.status}`);
    const routes = (await r.json()).routes || [];
    cache.set(ck, routes);
    return routes;
  }
  throw new Error('TomTom: trop de requêtes, réessayer dans une minute');
}

// Points on ordinary roads near motorway points (so that toll-free legs really start off the motorway)
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];
const localCache = (() => { try { return JSON.parse(localStorage.getItem('localPoints') || '{}'); } catch { return {}; } })();
const pk = (p) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`;

export async function localPoints(points) {
  const todo = points.filter((p) => !(pk(p) in localCache));
  for (let i = 0; i < todo.length; i += 25) {
    const batch = todo.slice(i, i + 25);
    const q = '[out:json][timeout:90];(' + batch.map((p) =>
      `way(around:1500,${p[0]},${p[1]})[highway~"^(trunk|primary|secondary|tertiary)$"][toll!=yes];`).join('') + ');out geom;';
    let data = null;
    for (let a = 0; a < 6 && !data; a++) {
      try {
        const r = await fetch(OVERPASS[a % OVERPASS.length], { method: 'POST', body: 'data=' + encodeURIComponent(q),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
        if (r.ok) data = await r.json();
        else await sleep(3000 * (a + 1));
      } catch { await sleep(3000 * (a + 1)); }
    }
    if (!data) { for (const p of batch) localCache[pk(p)] = null; continue; }
    const nodes = [];
    for (const w of data.elements) for (const g of w.geometry || []) nodes.push([g.lat, g.lon]);
    for (const p of batch) {
      let best = null, bd = Infinity;
      for (const n of nodes) { const d = km(p, n); if (d > 0.25 && d < bd) { bd = d; best = n; } }
      localCache[pk(p)] = best && bd < 2.5 ? best : null;
    }
    try { localStorage.setItem('localPoints', JSON.stringify(localCache)); } catch { /* full */ }
  }
  return points.map((p) => localCache[pk(p)] || null);
}

// Address search (OpenStreetMap Nominatim, France first)
export async function geocode(q) {
  const m = q.trim().match(/^(-?\d+(\.\d+)?)\s*,\s*(-?\d+(\.\d+)?)$/);
  if (m) return [{ label: q, pt: [parseFloat(m[1]), parseFloat(m[3])] }];
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=5&accept-language=fr&countrycodes=fr,be,es,it,de,ch,lu&q=${encodeURIComponent(q)}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('Recherche d\'adresse indisponible');
  return (await r.json()).map((x) => ({ label: x.display_name, pt: [parseFloat(x.lat), parseFloat(x.lon)] }));
}

// National average diesel price (French government open data); null if unavailable
export async function dieselPrice() {
  try {
    const url = 'https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets/prix-des-carburants-en-france-flux-instantane-v2/records?select=avg(gazole_prix)%20as%20p&where=gazole_prix%20is%20not%20null&limit=1';
    const r = await fetch(url);
    const p = (await r.json()).results[0].p;
    return p > 1 && p < 4 ? Math.round(p * 1000) / 1000 : null;
  } catch { return null; }
}
