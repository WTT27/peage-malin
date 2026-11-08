# Specification — Toll-aware route optimizer ("Péage Malin", working name)

Status: **draft v0.2** — 2026-11-08. Owner: Thomas (product), Claude (all code & docs).

## 1. Goal

Help the driver pick the route with the best **total cost vs. duration** trade-off,
taking into account tolls and energy (diesel or electricity), then hand the chosen
route to **Google Maps** for turn-by-turn navigation.

## 2. Form factor (decided — see DECISIONS.md D-001)

- A free web app (installable on the phone home screen, also usable on a PC).
- User interface in **French**.
- No paid service, no subscription, no credit card anywhere.
- Navigation itself is done by Google Maps: the app opens Google Maps with the chosen
  route (origin, waypoints, destination).

## 3. Scope

| Phase | Area |
|---|---|
| 1 (priority) | France |
| 2 | Western Europe (Spain, Italy, Portugal, … — to be detailed later) |

Vehicle class: **normal car only** (French toll class 1).

## 4. Vehicles (user profiles)

| Vehicle | Energy | Parameters needed |
|---|---|---|
| Peugeot e-208 (2022, 50 kWh gross / ~46 kWh usable) | Electric | **18 kWh/100 km on motorway at 110 km/h**, 15 kWh/100 km on other roads; **max 110 km/h** |
| Peugeot 5008 | Diesel | 6 L/100 km; normal speed limits; diesel price fetched live from the free French government fuel price data (≈2,21 €/L on 2026-11-08) |

**e-208 energy cost model:**
- Departure with a **100 % battery charged at home** on EDF Tempo, off-peak hours, blue/white days.
  Home price ≈ **0,14 €/kWh** (Aug 2026 grid: blue HC 0,1356, white HC 0,1536, weighted by
  ~300 blue / ~43 white days). Value editable.
- Energy beyond the home charge is bought on motorway fast chargers at **0,54 €/kWh**.
- Usable battery: ~46 kWh (2022 model) → roughly 250–300 km on home electricity.
- Later: winter correction (consumption +15–30 % in cold weather).

The user picks the vehicle before each search. Default values are proposed, user can edit.

## 5. Features

### F1 — Route cost
For a route: show distance, duration, **toll cost**, **energy cost**, **total cost**.

### F2 — Alternatives
Compute several alternative routes for the same trip, including:
- the fastest route (usually full motorway),
- the toll-free route,
- **partial-toll routes**: entering the motorway later / leaving it earlier, skipping
  the most expensive stretches.

Show them as a list and on a **cost vs. duration chart**.

### F3 — Best route according to the user's value of time
Rule: **"1 hour of my time is worth X €"** (X adjustable; default to be agreed).
Starting value: **X = 10 €/h** (a sensitivity check will follow).
Each route gets a *generalized cost* = total cost (€) + duration (h) × X.
The app recommends the route with the lowest generalized cost and explains the
trade-off in plain words (e.g. "+12 min, −6,40 €").

### F4 — Open in Google Maps
One button opens the selected route in Google Maps (phone app or browser).

### F5 — "While driving" mode (re-check)
Quick re-check from the current position to the destination, for reacting to accidents
or traffic jams. Must be usable in one or two taps (ideally by a passenger — the app
must not encourage handling the phone while driving).
**Decided (D-007, revised):** live traffic via a **free TomTom developer account** (created by
Thomas; 2,500 requests/day free). Traffic-aware durations are used to compare routes. If TomTom
asks for a credit card at sign-up, we stop and fall back to "traffic handled by Google Maps".

## 6. Test trips (reference cases)

From **Caillouet-Orgeville (27)** to:
1. Bordeaux (33)
2. Demangevelle (70)
3. Brive-la-Gaillarde (19)

For each, results will be compared against the official operator toll calculators
and against Google Maps durations.

## 7. Future ideas (backlog)
- **Breaks on long trips**: add time for charging / lunch / toilet breaks, and suggest *where*
  (e.g. charging stations for the e-208, rest areas). Breaks also change the cost (charging price).

## 8. Out of scope (for now)

- Trucks, motorbikes, campers, caravans.
- Toll subscriptions / badge discounts (may be added later).
- Charging-stop planning for the e-208 (energy *cost* is computed; *where* to charge
  is left to Google Maps / other apps for now).

## 9. Open questions

See `PROGRESS.md` → "Open questions".
