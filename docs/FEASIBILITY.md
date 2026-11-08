# Feasibility study (step 1)

Started 2026-11-08.

## 1. Route calculation (free)

| Service | Key needed | Avoid tolls | Alternatives | Result |
|---|---|---|---|---|
| OSRM public demo | no | **no** (`exclude=toll` rejected) | yes | ❌ unusable for toll-free routes |
| **Valhalla (FOSSGIS public server)** | **no** | **yes** (`use_tolls`, `exclude_tolls`) | yes (up to 2 alternates) | ✅ **chosen for prototype** |
| OpenRouteService | free account (no card), 2000 routes/day | yes (`avoid_features: tollways`, some bug reports) | — | backup option |

Valhalla also returns per-segment details, so we can recompute durations with a
**110 km/h cap** ourselves (its own `top_speed` option had little visible effect in tests).

### First measurements (Valhalla, 2026-11-08)

| Trip | With tolls (fastest) | Toll-free | Difference |
|---|---|---|---|
| → Bordeaux | 635 km, 6 h 51 | ~594 km, 8 h 53 | +2 h 02 |
| → Demangevelle | 431 km, 5 h 04 | 427 km, 7 h 27 | +2 h 23 |
| → Brive | 556 km, 5 h 45 | 512 km, 7 h 13 | +1 h 28 |

These are full-toll vs. zero-toll extremes. The interesting routes are the **partial-toll**
ones in between (step 3). Durations still to be compared with Google Maps.

### TomTom (free account, live traffic) — 2026-11-08, Sunday afternoon

| Trip → Bordeaux | Distance | Duration |
|---|---|---|
| Fastest (with tolls) | 633 km | 5 h 45 |
| Toll-free | 564 km | 7 h 01 |
| e-208 capped at 110 km/h | 545 km | 6 h 16 (different route chosen) |

The toll-free penalty is much smaller with TomTom (+1 h 16) than with Valhalla (+2 h 02).

## 2. Toll prices (France)

- **No single national open dataset** found. Each operator (Vinci/ASF/Cofiroute/Escota,
  APRR/AREA, Sanef/SAPN, ATMB, bridges/viaducts…) publishes a **class 1 price grid as PDF**
  on its website; Vinci's current grid applies from 1 June 2026.
- Closed-system motorways: price depends on the **entry/exit pair**. Open-system barriers
  ("pleine voie"): fixed price at the barrier.
- Prices change around **1 February** each year (+0.86 % average in Feb 2026).
- Commercial APIs (TollGuru, fuel-prices.eu) exist but require keys/payment → rejected.
- **Plan:** write a script that extracts the class 1 grids from the operator PDFs into one data
  file; locate toll stations on the map using OpenStreetMap (`barrier=toll_booth`);
  detect which stations a route passes through → entry/exit → price.
  Check results against the official calculator on autoroutes.fr.
- **Main technical risk:** reliably matching a route to its entry/exit stations.

## 3. Energy prices
- Diesel: French government open data (prix-carburants), free, no key — tested: national average 2,21 €/L on 2026-11-08.
- Electricity: user-set €/kWh (see open question).

## Sources
- Vinci Autoroutes price grids: https://www.vinci-autoroutes.com/fr/tarifs-peage-reseaux-vinci-autoroutes
- OpenRouteService plans: https://openrouteservice.org/?p=176
- Toll price evolution: https://tolltickets.com/fr/blog/france-toll-roads-telepeage-guide/
