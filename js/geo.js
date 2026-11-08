// Geometry helpers (lat/lon in degrees, distances in km)
const R = 6371;
const rad = (d) => (d * Math.PI) / 180;

export function km(a, b) {
  const la1 = rad(a[0]), la2 = rad(b[0]);
  const dla = la2 - la1, dlo = rad(b[1] - a[1]);
  const h = Math.sin(dla / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dlo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function cumulative(pts) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + km(pts[i - 1], pts[i]));
  return cum;
}

export function routePoints(route) {
  const pts = [];
  for (const leg of route.legs) for (const p of leg.points) pts.push([p.latitude, p.longitude]);
  return pts;
}

export function bbox(pts, padLat = 0.02, padLon = 0.03) {
  let a = 90, b = -90, c = 180, d = -180;
  for (const p of pts) {
    if (p[0] < a) a = p[0];
    if (p[0] > b) b = p[0];
    if (p[1] < c) c = p[1];
    if (p[1] > d) d = p[1];
  }
  return [a - padLat, b + padLat, c - padLon, d + padLon];
}

export const inBox = (p, bx) => p[0] >= bx[0] && p[0] <= bx[1] && p[1] >= bx[2] && p[1] <= bx[3];

export function hm(min) {
  const m = Math.round(min);
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}

export const eur = (x) => x.toFixed(2).replace('.', ',') + ' €';
