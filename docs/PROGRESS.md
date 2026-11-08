# Progress

## Current status — 2026-11-08 (night)
Phone app (French, runs entirely in the browser) works end to end: address search, 5008 / e-208, departure time,
efficient in-between routes (free wins, best compromise, "extra time accepted" slider, chart), "Ouvrir dans
Google Maps" with waypoints. Engine v3 with two methods (complete TomTom = default, economical Valhalla = option).
Publishing on GitHub Pages: https://wtt27.github.io/peage-malin/

## Roadmap

| Step | Content | Status |
|---|---|---|
| 0 | Definition, documents | ✅ done |
| 1 | Feasibility study: free routing sources, French toll price data, fuel prices | ✅ done |
| 2 | Toll cost of one route (F1), checked on the 3 test trips | ✅ prototype (Thomas: "numbers seem quite OK") |
| 3 | Alternatives + cost/duration chart (F2) | ✅ in the app; optimizer v2 ✅ (corridor combinations + national-road escapes, efficient routes, ladder); chart → in the app |
| 4 | Value-of-time recommendation (F3) | ✅ prototype + sensitivity 5–50 €/h |
| 5 | Google Maps hand-off + phone install (F4) | ✅ v0.1 (to be tested by Thomas on his phone) |
| 6 | "While driving" re-check (F5) | — |
| 7 | Western Europe | — |

## Open questions

| # | Question | Status |
|---|---|---|
| OPEN-1 | Value of X | ✅ 10 €/h |
| OPEN-2 | Consumptions & energy prices | ✅ 15 kWh/100 km, 6 L/100 km; home ≈0,14 €/kWh (Tempo HC), motorway 0,54 €/kWh |
| OPEN-3 | Live traffic | ✅ yes, TomTom free account (option a) — account created, key works ✅ |
| OPEN-4 | 110 km/h cap | ✅ e-208 only |
| OPEN-5 | e-208 version / usable battery capacity (year of the car?) | waiting for Thomas |

## Findings from optimizer v2 (Fri 13 Nov 08:00)
- Bordeaux/5008: motorway to Poitiers nord then N10: +26 min, −24.65 € (best compromise).
- Brive/5008: free roads to Allaines then A10/A71: +6 min, −8.96 €.
- Demangevelle/5008: free roads to Châtillon-Laborde then A5: +29 min, −14.55 €.
- e-208: some partly free routes are both faster AND cheaper than TomTom's fastest (less energy → less charging).

## Next
- Thomas tests the app on his phone (install on home screen, Google Maps hand-off).
- Compare economical vs complete method on the test trips once Valhalla accepts this server again.
- Backlog: breaks / charging stops, comfort penalty, while-driving re-check, Escota/Arcos tolls, Western Europe.

## Known limitations
- Avoiding the A86 Duplex: v1 estimated +0 min, v2 +13 min (Friday 8:00) — to be checked.
- A few variants crossing the Cofiroute/Vinci boundary at Tours are still unpriced (flagged "(!)").
- Escota, Arcos, A86 Duplex reverse direction (Vélizy→Rueil/Vaucresson) not encoded yet.
- e-208 charging time is a simple model (45 kW average, 10 min per stop, 10→80 %); no charger location yet.
- Legs 2 and 3 of partial-toll variants use current traffic, not traffic at the predicted time.
- Toll prices change every 1 February → yearly data refresh needed.
