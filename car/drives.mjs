// Every drive measured automatically from the car's readings (D-046), no planned trip needed.
// The car reports odometer, battery and outside temperature every ~2 minutes while driving. A drive = readings with no
// pause longer than 25 min and no charging in between. Each 2-minute stretch with an average speed above 95 km/h counts
// as motorway (country roads are limited to 90 km/h), the rest as other roads.
// Energy: the total of the drive comes from the battery % (start → end, 1 % = 0.46 kWh); it is shared between the
// stretches in proportion to the car's finer "residual energy" figure when it moves, else to the % drops.
// Only drives of 20 km or more are kept (the 1 % steps make shorter ones too rough).
const GAP = 25 * 60e3, MW_KMH = 95, MIN_KM = 20;

const tOf = (p) => Date.parse(p.kmAt || p.carAt) || p.at;

export function findDrives(history, batteryKwh = 46, now = Date.now()) {
  const pts = history.filter((p) => p.km != null && p.level != null).sort((a, b) => a.at - b.at);
  const groups = [];
  let g = [];
  for (const p of pts) {
    const q = g[g.length - 1];
    if (q && (p.at - q.at > GAP || p.level > q.level || p.km < q.km)) { groups.push(g); g = []; }
    g.push(p);
  }
  if (g.length) groups.push(g);
  const out = [];
  for (let grp of groups) {
    // trim the parked readings around the drive, keeping the last one before the car moved
    let i0 = 0; while (i0 < grp.length - 1 && grp[i0 + 1].km - grp[i0].km < 0.05) i0++;
    let i1 = grp.length - 1; while (i1 > i0 && grp[i1].km - grp[i1 - 1].km < 0.05) i1--;
    grp = grp.slice(i0, i1 + 1);
    if (grp.length < 3) continue;
    const a = grp[0], b = grp[grp.length - 1], km = b.km - a.km;
    if (km < MIN_KM || now - b.at < GAP) continue;                 // too short, or maybe not finished yet
    const kwh = (a.level - b.level) / 100 * batteryKwh;
    if (kwh <= 0) continue;
    const useRes = grp.every((p) => p.residualWh != null) && a.residualWh - b.residualWh > 0;
    let mwKm = 0, otKm = 0, mwW = 0, otW = 0;
    for (let i = 1; i < grp.length; i++) {
      const p = grp[i - 1], q = grp[i], dkm = q.km - p.km, h = (tOf(q) - tOf(p)) / 3600e3;
      const w = Math.max(0, useRes ? p.residualWh - q.residualWh : p.level - q.level);
      if (h > 0 && dkm / Math.max(h, 1 / 60) > MW_KMH) { mwKm += dkm; mwW += w; } else { otKm += dkm; otW += w; }
    }
    const share = mwW + otW > 0 ? mwW / (mwW + otW) : mwKm / km;
    const temps = grp.map((p) => p.tempC).filter((x) => x != null);
    const k100 = (e, d) => (d > 0 ? +(e / d * 100).toFixed(1) : null);
    out.push({
      at: a.at, endAt: b.at, auto: true, km: +km.toFixed(1), kwh: +kwh.toFixed(2),
      winter: [11, 12, 1, 2, 3].includes(new Date(a.at).getMonth() + 1),
      temp: temps.length ? +(temps.reduce((x, y) => x + y, 0) / temps.length).toFixed(1) : null,
      mwKm: Math.round(mwKm), mwKwh100: k100(kwh * share, mwKm), otherKm: Math.round(otKm), otherKwh100: k100(kwh * (1 - share), otKm),
    });
  }
  return out;
}
