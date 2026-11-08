// External services: TomTom routing, Overpass (local roads), Nominatim (addresses), fuel price.
import { km } from './geo.js';
import { builtinLocal } from './tolls.js';

export const stats = { api: 0, cached: 0 };
const cache = new Map();
let nextSlot = 0;   // global rate limiter shared by concurrent requests
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
    const now = Date.now();                     // ~4 requests / second (free tier limit 5/s)
    const slot = Math.max(now, nextSlot);
    nextSlot = slot + 260;
    if (slot > now) await sleep(slot - now);
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
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];
const localCache = (() => { try { return JSON.parse(localStorage.getItem('localPoints') || '{}'); } catch { return {}; } })();
const pk = (p) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`;

let overpassQueue = Promise.resolve();
export function localPoints(points) {       // one Overpass request at a time (server refuses parallel ones)
  const job = overpassQueue.then(() => localPointsNow(points));
  overpassQueue = job.catch(() => {});
  return job;
}

// Fallback when Overpass is busy: TomTom reverse geocoding restricted to ordinary roads
async function reverseRoad(p) {
  const key = getKey();
  const url = `https://api.tomtom.com/search/2/reverseGeocode/${p[0]},${p[1]}.json?key=${encodeURIComponent(key)}` +
    '&radius=1500&returnRoadUse=true&roadUse=%5B%22Arterial%22%2C%22Terminal%22%2C%22LocalStreet%22%5D';
  for (let attempt = 0; attempt < 4; attempt++) {
    const now = Date.now(), slot = Math.max(now, nextSlot);
    nextSlot = slot + 260;
    if (slot > now) await sleep(slot - now);
    stats.api++;
    try {
      const r = await fetch(url);
      if (r.status === 429) { await sleep(1000 * 2 ** attempt); continue; }
      if (!r.ok) return null;
      const a = ((await r.json()).addresses || []).find((x) => x.position &&
        !(x.roadUse || []).some((u) => u === 'Ramp' || u === 'LimitedAccess'));   // not a slip road / motorway
      if (!a) return null;
      const [lat, lon] = a.position.split(',').map(Number);
      return km(p, [lat, lon]) < 2.5 ? [lat, lon] : null;
    } catch { return null; }
  }
  return null;
}

async function localPointsNow(points) {
  for (const p of points) {                   // 1) built-in points (no network)
    if (!(pk(p) in localCache)) { const b = builtinLocal(p, 3); if (b) localCache[pk(p)] = b; }
  }
  const todo = points.filter((p) => !(pk(p) in localCache));
  for (let i = 0; i < todo.length; i += 40) {
    const batch = todo.slice(i, i + 40);
    const q = '[out:json][timeout:90];(' + batch.map((p) =>
      `way(around:1500,${p[0]},${p[1]})[highway~"^(trunk|primary|secondary|tertiary)$"][toll!=yes];`).join('') + ');out geom;';
    let data = null;
    for (let a = 0; a < 2 && !data; a++) {
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 20000);     // do not wait forever for a busy server
        const r = await fetch(OVERPASS[a % OVERPASS.length], { method: 'POST', body: 'data=' + encodeURIComponent(q),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: ctl.signal });
        clearTimeout(timer);
        if (r.ok) data = await r.json();
        else await sleep(1500);
      } catch { await sleep(1500); }
    }
    if (!data) {                              // Overpass unavailable -> TomTom fallback
      const res = await Promise.all(batch.map(reverseRoad));
      batch.forEach((p, j) => { if (res[j]) localCache[pk(p)] = res[j]; });
      continue;
    }
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
