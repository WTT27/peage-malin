// Outside temperature for a trip (D-040): forecast or the month's usual figure. The consumption law that uses it
// (speed + temperature) is in law.js (D-050).

// usual temperature (°C, daytime) by month in northern France, when no forecast is available
const CLIMATE = [5, 6, 9, 12, 16, 19, 22, 22, 18, 14, 9, 6];
export const usualTemp = (date) => CLIMATE[date.getMonth()];

// forecast for the trip (Open-Meteo, free, no key): mean of departure and arrival at the departure hour.
// Positions rounded to 0.1° (~10 km). Up to 15 days ahead; otherwise the month's usual temperature.
export async function tripTemp(o, d, depart) {
  const days = (depart - Date.now()) / 86400e3;
  if (days > -1 && days < 15) {
    try {
      const r1 = (x) => Math.round(x * 10) / 10;
      const day = depart.toLocaleDateString('sv-SE');
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${r1(o[0])},${r1(d[0])}&longitude=${r1(o[1])},${r1(d[1])}`
        + `&hourly=temperature_2m&timezone=Europe%2FParis&start_date=${day}&end_date=${day}`;
      const j = await (await fetch(url, { signal: AbortSignal.timeout(8000) })).json();
      const h = depart.getHours(), list = Array.isArray(j) ? j : [j];
      const ts = list.map((x) => x?.hourly?.temperature_2m?.[h]).filter((x) => typeof x === 'number');
      if (ts.length) return { T: Math.round(ts.reduce((a, b) => a + b, 0) / ts.length), src: 'prévision' };
    } catch { /* offline: usual temperature */ }
  }
  return { T: usualTemp(depart), src: 'moyenne du mois' };
}
