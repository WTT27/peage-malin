# Decision log

Each important decision, with its reason. Newest at the bottom.

## D-001 — Standalone web app + hand-off to Google Maps (2026-11-08)
- **Decision:** build our own free web app; navigation is delegated to Google Maps via a link.
- **Rejected:** browser extension on google.com/maps (desktop only, breaks when Google
  changes its page); Google Routes API toll info (requires a billing account / credit card).
- **Why:** free, works on phone and PC, robust.

## D-002 — France first, then Western Europe (2026-11-08)
- **Why:** toll data must be collected per country/operator; France is the user's main use.

## D-003 — Normal car only, two vehicle profiles: e-208 (electric), 5008 (diesel) (2026-11-08)

## D-004 — Value-of-time rule: "1 hour is worth X €" (2026-11-08)
- Generalized cost = tolls + energy + duration × X. Lowest wins.

## D-005 — UI in French, project documents in English (2026-11-08)
- **Why:** app is for French use; docs follow the language of our working conversation.
  Can be switched to French on request.

## D-006 — Starting value X = 10 €/h; consumptions e-208 15 kWh/100 km, 5008 6 L/100 km; max 110 km/h (2026-11-08)
- Sensitivity check on X planned later.

## D-007 — Live traffic via free TomTom developer account (2026-11-08, revised same day)
- First recorded as option (b) by mistake; Thomas corrected to **option (a)**.
- Free tier: 2,500 non-tile requests/day (routing included). Card-free sign-up to be confirmed
  at account creation; if a card is required → fall back to (b).
- The TomTom key is personal: it will not be stored in any public place.

## D-008 — Valhalla public server as routing source for the prototype (2026-11-08)
- **Why:** free, no key, supports toll avoidance and alternatives. OSRM demo cannot avoid tolls.
  OpenRouteService kept as backup. See FEASIBILITY.md.

## D-009 — 110 km/h cap applies to the e-208 only (2026-11-08)

## D-010 — e-208 energy cost: home charge (Tempo off-peak ≈ 0,14 €/kWh) then 0,54 €/kWh on motorway (2026-11-08)
- Assumes departure at 100 %. Tempo prices from the 1 Aug 2026 grid (to recheck against EDF yearly).
- Possible later improvement: use the actual Tempo colour of the night before departure (public data).

## D-011 — TomTom becomes the main routing source; Valhalla is the backup (2026-11-08)
- TomTom key works (stored in local `.env`, excluded from git). It gives live traffic, toll
  avoidance (`avoid=tollRoads`), alternatives, and a speed cap (`vehicleMaxSpeed=110` for the e-208).
- Its durations look more realistic than Valhalla's (Bordeaux: 5 h 45 vs 6 h 51 with tolls).

## D-012 — Diesel price fetched live from government open data (2026-11-08)
- National average on 2026-11-08: **2,21 €/L** (9,023 stations). Earlier 1,65 €/L figure was wrong.
