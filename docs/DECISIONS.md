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

## D-007 — No live traffic in the app (2026-11-08)
- **Decision:** option (b): traffic is left to Google Maps after hand-off. No TomTom account.

## D-008 — Valhalla public server as routing source for the prototype (2026-11-08)
- **Why:** free, no key, supports toll avoidance and alternatives. OSRM demo cannot avoid tolls.
  OpenRouteService kept as backup. See FEASIBILITY.md.
