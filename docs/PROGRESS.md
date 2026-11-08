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
| 4 | Best in-between route (F3, revised by D-018) | ✅ best compromise, free wins, time-budget slider |
| 5 | Google Maps hand-off + phone install (F4) | ✅ v0.1 published on GitHub Pages — waiting for Thomas's phone test |
| 6 | "While driving" re-check (F5) | — |
| 7 | Western Europe | — |

## Open questions

| # | Question | Status |
|---|---|---|
| OPEN-1 | Value of X | ✅ 10 €/h |
| OPEN-2 | Consumptions & energy prices | ✅ 15 kWh/100 km, 6 L/100 km; home ≈0,14 €/kWh (Tempo HC), motorway 0,54 €/kWh |
| OPEN-3 | Live traffic | ✅ yes, TomTom free account (option a) — account created, key works ✅ |
| OPEN-4 | 110 km/h cap | ✅ e-208 only |
| OPEN-5 | e-208 version / usable battery capacity | ✅ 2022, ~46 kWh usable; 18 kWh/100 km motorway, 15 other roads |

## Audit (tests/audit.mjs), 12 trips from home, Fri 13 Nov 08:00, 5008 — after D-025..D-027
- 8/12 trips: no route found by the auditor beats the app. Best compromise identical on 10/12 (Bordeaux, Brive: audit
  version 1–2 min faster, same route). Remaining small gaps: Nantes (+6 min, −2.27 € option missing); very slow toll-free
  variants on Lille/Clermont/Reims (fixed afterwards: 3 toll-free alternatives requested).
- Pricing bugs found and fixed by the audit: Lyon (A6 unpriced → crash), Lille (A1 priced 1.60 € instead of 18.90 €).
- Requests per trip (complete method): 35–105. Valhalla answers this server again (economical method: Brive 15 requests,
  same best compromise as the complete method).
- Full output: docs/results/2026-11-08_audit-12-trips.txt

## Findings from optimizer v3, complete method (Fri 13 Nov 08:00, 5008)
- Bordeaux: A10 to Poitiers sud then free roads: +16 min, −22.31 € (best compromise) — 62 TomTom requests, 19 s.
- Brive: free roads to Allaines then motorway: +5 min, −8.92 € — 25 requests, 7 s.
- Demangevelle: avoiding the A86 Duplex: +15 min, −8.43 € — 36 requests.
  → after D-024: Duplex avoided via A13/A12/N12 for +5 min, −9.71 €; best compromise +10 min, −13.12 € (44 requests).
  Bordeaux 64 requests, Brive 30 (results unchanged).

## Findings from optimizer v2 (Fri 13 Nov 08:00)
- Bordeaux/5008: motorway to Poitiers nord then N10: +26 min, −24.65 € (best compromise).
- Brive/5008: free roads to Allaines then A10/A71: +6 min, −8.96 €.
- Demangevelle/5008: free roads to Châtillon-Laborde then A5: +29 min, −14.55 €.
- e-208: some partly free routes are both faster AND cheaper than TomTom's fastest (less energy → less charging).

## Next
- Thomas tests the app on his phone (install on home screen, Google Maps hand-off).
- Run the auditor on more trips (other origins) and fix remaining gaps (Nantes).
- Compare economical vs complete method on the test trips once Valhalla accepts this server again.
- Backlog: breaks / charging stops (with locations), comfort penalty (postponed), while-driving re-check,
  Escota/Arcos tolls, A86 Duplex reverse direction, unnamed stations on Vinci page 4 (Toulouse–Bayonne), Western Europe.
- Valhalla public server refuses this server since the precomputation (ECONNREFUSED); the app falls back to the
  complete method automatically. Phones are not affected by this server-side block.

## Known limitations
- Avoiding the A86 Duplex: via A12/N12 +5 min (Friday 8:00); Thomas confirms this is his usual route.
- A few variants crossing the Cofiroute/Vinci boundary at Tours are still unpriced (flagged "(!)").
- Escota, Arcos, A86 Duplex reverse direction (Vélizy→Rueil/Vaucresson) not encoded yet.
- e-208 charging time is a simple model (45 kW average, 10 min per stop, 10→80 %); no charger location yet.
- Legs 2 and 3 of partial-toll variants use current traffic, not traffic at the predicted time.
- Toll prices change every 1 February → yearly data refresh needed.
