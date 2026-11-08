// External services: TomTom routing, Overpass (local roads), Nominatim (addresses), fuel price.
import { km } from './geo.js';
import { nearestLocal } from './tolls.js';

export const stats = { api: 0, cached: 0, valhalla: 0 };
const cache = new Map();

// ---- persistent cache (IndexedDB) so that repeating a trip costs no new requests ----
const TTL_TOMTOM = 3 * 3600e3;          // traffic changes: keep 3 h
const TTL_VALHALLA = 7 * 24 * 3600e3;   // no traffic: keep 7 days
let dbp = null;
function db() {
  if (dbp) return dbp;
  dbp = new Promise((res) => {
    try {
      const rq = indexedDB.open('peage-malin', 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore('c');
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => res(null);
    } catch { res(null); }
  });
  return dbp;
}
async function pget(k, ttl) {
  const d = await db();
  if (!d) return undefined;
  return new Promise((res) => {
    try {
      const rq = d.transaction('c').objectStore('c').get(k);
      rq.onsuccess = () => { const v = rq.result; res(v && Date.now() - v.t < ttl ? v.v : undefined); };
      rq.onerror = () => res(undefined);
    } catch { res(undefined); }
  });
}
async function pset(k, v) {
  const d = await db();
  if (!d) return;
  try { d.transaction('c', 'readwrite').objectStore('c').put({ t: Date.now(), v }, k); } catch { /* full */ }
}
export async function clearCache() {
  const d = await db();
  if (d) try { d.transaction('c', 'readwrite').objectStore('c').clear(); } catch { /* ignore */ }
}
let nextSlot = 0;   // global rate limiter shared by concurrent requests
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function getKey() {
  try { return localStorage.getItem('tomtomKey') || ''; } catch { return ''; }
}
export function setKey(k) {
  try { localStorage.setItem('tomtomKey', k.trim()); } catch { /* private mode */ }
}

// TomTom route; returns an array of routes ([] if no route)
export async function route(o, d, { avoidTolls = false, maxSpeed = null, depart = null, alternatives = 0, instructions = false, avoidBoxes = null } = {}) {
  const key = getKey();
  if (!key) throw new Error('Clé TomTom manquante (voir Réglages)');
  const r6 = (p) => [Math.round(p[0] * 1e5) / 1e5, Math.round(p[1] * 1e5) / 1e5];
  const ck = 'tt' + JSON.stringify([r6(o), r6(d), avoidTolls, maxSpeed, depart && depart.slice(0, 15), alternatives, instructions, avoidBoxes]);
  if (cache.has(ck)) { stats.cached++; return cache.get(ck); }
  const stored = await pget(ck, TTL_TOMTOM);
  if (stored) { stats.cached++; cache.set(ck, stored); return stored; }
  let url = `https://api.tomtom.com/routing/1/calculateRoute/${o[0]},${o[1]}:${d[0]},${d[1]}/json?key=${encodeURIComponent(key)}` +
    `&traffic=true&sectionType=tollRoad&sectionType=motorway&maxAlternatives=${alternatives}`;
  if (avoidTolls) url += '&avoid=tollRoads';
  if (maxSpeed) url += `&vehicleMaxSpeed=${maxSpeed}`;
  if (depart) url += `&departAt=${depart}`;
  if (instructions) url += '&instructionsType=coded';
  for (let attempt = 0; attempt < 6; attempt++) {
    const now = Date.now();                     // ~4 requests / second (free tier limit 5/s)
    const slot = Math.max(now, nextSlot);
    nextSlot = slot + 260;
    if (slot > now) await sleep(slot - now);
    stats.api++;
    // avoidBoxes: [[south, west, north, east], …] areas TomTom must not cross (POST body)
    const r = avoidBoxes ? await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ avoidAreas: { rectangles: avoidBoxes.map(([s, w, n, e]) => ({
        southWestCorner: { latitude: s, longitude: w }, northEastCorner: { latitude: n, longitude: e } })) } }) })
      : await fetch(url);
    if (r.status === 429) { await sleep(1000 * 2 ** attempt); continue; }
    if (r.status === 400 || r.status === 404) { cache.set(ck, []); return []; }
    if (r.status === 403) throw new Error('Clé TomTom refusée ou quota du jour épuisé');
    if (!r.ok) throw new Error(`TomTom: erreur ${r.status}`);
    const routes = (await r.json()).routes || [];
    cache.set(ck, routes);
    pset(ck, routes);
    return routes;
  }
  throw new Error('TomTom: trop de requêtes, réessayer dans une minute');
}

// ---- Valhalla (OpenStreetMap, free, no key): toll-free time estimates ----
const VALHALLA = 'https://valhalla1.openstreetmap.de';
let vSlot = 0;
async function valhalla(path, body) {
  const ck = 'vh' + path + JSON.stringify(body);
  if (cache.has(ck)) return cache.get(ck);
  const stored = await pget(ck, TTL_VALHALLA);
  if (stored) { cache.set(ck, stored); return stored; }
  for (let attempt = 0; attempt < 4; attempt++) {
    const now = Date.now(), slot = Math.max(now, vSlot);
    vSlot = slot + 500;                       // fair use of the public server: ~2 requests / second
    if (slot > now) await sleep(slot - now);
    stats.valhalla++;
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 30000);
      const r = await fetch(VALHALLA + path, { method: 'POST', body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' }, signal: ctl.signal });
      clearTimeout(timer);
      if (r.status === 429 || r.status >= 500) { await sleep(1500 * (attempt + 1)); continue; }
      const j = r.ok ? await r.json() : null;
      cache.set(ck, j); if (j) pset(ck, j);
      return j;
    } catch { await sleep(1500 * (attempt + 1)); }
  }
  return null;
}
const vOpts = (maxSpeed) => ({ auto: { exclude_tolls: true, ...(maxSpeed ? { top_speed: maxSpeed } : {}) } });
const vLoc = (p) => ({ lat: +p[0].toFixed(5), lon: +p[1].toFixed(5) });

// toll-free time/distance between two points: {sec, km} or null
export async function freeEstimate(a, b, maxSpeed) {
  const j = await valhalla('/route', { locations: [vLoc(a), vLoc(b)], costing: 'auto', costing_options: vOpts(maxSpeed),
    directions_type: 'none', units: 'kilometers' });
  if (!j || !j.trip) return null;
  return { sec: j.trip.summary.time, km: j.trip.summary.length };
}

// toll-free matrix (all pairs must be < 150 km apart): returns m[i][j] = {sec, km} | null
export async function freeMatrix(sources, targets, maxSpeed) {
  const j = await valhalla('/sources_to_targets', { sources: sources.map(vLoc), targets: targets.map(vLoc), costing: 'auto',
    costing_options: vOpts(maxSpeed), units: 'kilometers' });
  if (!j || !j.sources_to_targets) return null;
  return j.sources_to_targets.map((row) => row.map((c) => (c && c.time != null ? { sec: c.time, km: c.distance } : null)));
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
    if (!(pk(p) in localCache)) { const b = nearestLocal(p, 3); if (b) localCache[pk(p)] = b; }
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
