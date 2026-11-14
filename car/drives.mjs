// Every drive measured automatically from the car's readings (D-046), no planned trip needed.
// The car reports odometer, battery and outside temperature every ~2 minutes while driving. A drive = readings with no
// pause longer than 25 min and no charging in between. Each 2-minute stretch is classed by its average speed: above
// 95 km/h = motorway (country roads are limited to 90 km/h), below 45 km/h = town (lights, traffic, roundabouts), in
// between = other roads. Route plans learn "other roads" from the 45–95 part only, so that town driving on daily trips
// does not bias long-trip plans (Thomas, 2026-11-14); the town figure is kept for information.
// Energy: the total of the drive comes from the battery % (start → end, 1 % = 0.46 kWh); it is shared between the
// stretches in proportion to the car's finer "residual energy" figure when it moves, else to the % drops.
// Only drives of 20 km or more are kept (the 1 % steps make shorter ones too rough).
const GAP = 25 * 60e3, DONE = 12 * 60e3, MW_KMH = 95, CITY_KMH = 45, MIN_KM = 20, SHOW_KM = 3, OFF = 6 * 60e3;
// Inside a drive, the separate trips ("legs"): the car reports every ~2 min while switched on and nothing while off, so
// a pause of more than 6 min between readings (or a reading with the ignition off) = the car was switched off.
// The legs are shown in the app; the consumption law uses the whole drive (energy adds up, and the longer the
// distance, the smaller the error of the 1 % steps). Drives under 20 km are kept for display only.

// start time: when the first point is a parked reading long before the car moved, ~2 min before the first moving one
const startOf = (L) => (L.length > 1 && L[1].at - L[0].at > OFF ? L[1].at - 120e3 : L[0].at);
const tOf = (p) => Date.parse(p.kmAt || p.carAt) || p.at;

export function findDrives(history, batteryKwh = 46, now = Date.now()) {
  const pts = history.filter((p) => p.km != null && p.level != null).sort((a, b) => a.at - b.at);
  const groups = [];
  let g = [];
  for (const p of pts) {
    const q = g[g.length - 1];
    if (q && (p.at - q.at > GAP || p.level > q.level || p.km < q.km)) {
      groups.push(g); g = [];
      // the car sometimes sends its first reading a few km after leaving: start from the last parked reading
      // (same odometer story, no charging since)
      if (p.at - q.at > GAP && p.km - q.km > 0.05 && p.km - q.km < 30 && p.level <= q.level) g.push(q);
    }
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
    // shown 12 min after the last movement (the computer checks a parked car every 10 min); a drive that goes on after a
    // shorter stop comes back longer with the same start and replaces the first figure
    if (km < SHOW_KM || now - b.at < DONE) continue;
    const kwh = (a.level - b.level) / 100 * batteryKwh;
    if (kwh <= 0) continue;
    const useRes = grp.every((p) => p.residualWh != null) && a.residualWh - b.residualWh > 0;
    const S = { mw: { km: 0, w: 0 }, ot: { km: 0, w: 0 }, city: { km: 0, w: 0 } };
    for (let i = 1; i < grp.length; i++) {
      const p = grp[i - 1], q = grp[i], dkm = q.km - p.km, h = (tOf(q) - tOf(p)) / 3600e3;
      const w = Math.max(0, useRes ? p.residualWh - q.residualWh : p.level - q.level);
      // a stretch across a switch-off (pause) has no meaningful speed: other roads
      const v = h > 0 && q.at - p.at <= OFF ? dkm / Math.max(h, 1 / 60) : 60;
      const s = S[v > MW_KMH ? 'mw' : v < CITY_KMH ? 'city' : 'ot']; s.km += dkm; s.w += w;
    }
    const totW = S.mw.w + S.ot.w + S.city.w, totKm = S.mw.km + S.ot.km + S.city.km;
    const share = (s) => (totW > 0 ? s.w / totW : s.km / totKm);
    const legs = [];
    let s0 = 0;
    for (let i = 1; i <= grp.length; i++) {
      if (i < grp.length && !(grp[i].at - grp[i - 1].at > OFF || (grp[i - 1].ignition === 'Stop' && i - 1 > s0))) continue;
      const L = grp.slice(s0, i), la = L[0], lb = L[L.length - 1], lkm = lb.km - la.km;
      if (lkm >= 0.5) {
        const lw = useRes ? Math.max(0, la.residualWh - lb.residualWh) / (a.residualWh - b.residualWh) : Math.max(0, la.level - lb.level) / (a.level - b.level);
        legs.push({ at: startOf(L), endAt: lb.at, km: +lkm.toFixed(1), kwh100: +(kwh * lw / lkm * 100).toFixed(1) });
      }
      s0 = i - 1;                                    // the last reading of a leg is the start of the next one
    }
    const temps = grp.map((p) => p.tempC).filter((x) => x != null);
    const k100 = (e, d) => (d > 0 ? +(e / d * 100).toFixed(1) : null);
    out.push({
      at: startOf(grp), endAt: b.at, auto: true, km: +km.toFixed(1), kwh: +kwh.toFixed(2),
      winter: [11, 12, 1, 2, 3].includes(new Date(a.at).getMonth() + 1),
      temp: temps.length ? +(temps.reduce((x, y) => x + y, 0) / temps.length).toFixed(1) : null,
      mwKm: Math.round(S.mw.km), mwKwh100: k100(kwh * share(S.mw), S.mw.km),
      otherKm: Math.round(S.ot.km), otherKwh100: k100(kwh * share(S.ot), S.ot.km),
      cityKm: Math.round(S.city.km), cityKwh100: k100(kwh * share(S.city), S.city.km),
      law: km >= MIN_KM, legs: legs.length > 1 ? legs : undefined,
    });
  }
  return out;
}
