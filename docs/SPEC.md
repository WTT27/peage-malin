# Specification — Toll-aware route optimizer ("Péage Malin", working name)

Status: **draft v0.1** — 2026-11-08. Owner: Thomas (product), Claude (all code & docs).

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
| Peugeot e-208 | Electric | consumption (kWh/100 km), electricity price (€/kWh — home vs. fast charger) |
| Peugeot 5008 | Diesel | consumption (L/100 km), diesel price (€/L — can be fetched from the free French government fuel price data) |

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
Each route gets a *generalized cost* = total cost (€) + duration (h) × X.
The app recommends the route with the lowest generalized cost and explains the
trade-off in plain words (e.g. "+12 min, −6,40 €").

### F4 — Open in Google Maps
One button opens the selected route in Google Maps (phone app or browser).

### F5 — "While driving" mode (re-check)
Quick re-check from the current position to the destination, for reacting to accidents
or traffic jams. Must be usable in one or two taps (ideally by a passenger — the app
must not encourage handling the phone while driving).
**Open point:** live traffic requires a traffic-aware routing source (see OPEN-3).

## 6. Test trips (reference cases)

From **Caillouet-Orgeville (27)** to:
1. Bordeaux (33)
2. Demangevelle (70)
3. Brive-la-Gaillarde (19)

For each, results will be compared against the official operator toll calculators
and against Google Maps durations.

## 7. Out of scope (for now)

- Trucks, motorbikes, campers, caravans.
- Toll subscriptions / badge discounts (may be added later).
- Charging-stop planning for the e-208 (energy *cost* is computed; *where* to charge
  is left to Google Maps / other apps for now).

## 8. Open questions

See `PROGRESS.md` → "Open questions".
