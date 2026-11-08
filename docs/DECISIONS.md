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

## D-013 — e-208 consumption by road type (2026-11-08)
- 2022 model, ~46 kWh usable. Motorway at 110 km/h: **18 kWh/100 km**; other roads: 15 kWh/100 km.
- Source: Automobile Propre supertest e-208 2022 measured 17,1 kWh/100 km at steady 110 km/h
  (mild weather); Izi by EDF reports 19,5 at 120 km/h average. 18 is a realistic middle; Thomas
  estimated ~20. Adjustable.

## D-014 — Communication rule (2026-11-08)
- Thomas does not read the docs; they are kept for traceability only. All results, questions and
  decisions are reported in the terminal conversation.

## D-015 — Toll price sources (2026-11-08)
- Toll station locations: official ministry dataset (data.gouv.fr).
- APRR/AREA: ready-made CSV on data.gouv.fr (2026 prices).
- Sanef/SAPN and Vinci (ASF, Cofiroute, Escota): their websites block automated download
  (anti-bot page / JavaScript-only links) → Thomas downloads the class 1 PDFs manually once a year,
  Claude extracts them.

## D-016 — Toll engine method (2026-11-08)
- TomTom marks toll stretches; the engine finds priced stations close to the route (official dataset
  + OpenStreetMap exits by number and name) near the start/end of each stretch and looks up the pair price.
  Operator boundaries are handled by splitting; open barriers by fixed prices; Duplex A86 by time table.
  A stretch that cannot be priced is always flagged, never counted as free.

## D-017 — Alternatives = toll-free, TomTom alternatives, and per-stretch skip / leave early / join late (2026-11-08)
- Built from 3 TomTom legs (normal / toll-free / normal). ~20–30 TomTom requests per trip (free quota 2,500/day).

## D-018 — Find in-between routes instead of ranking by €/hour (2026-11-08)
- Thomas's goal: save as much as possible with little time lost; fixed €/h tends to pick extremes.
- Analysis: keep only efficient routes (no other route faster AND cheaper); for each, % of the maximum
  saving vs % of the maximum extra time; best compromise = largest gap; "free wins" (≥1 € for ≤3 min);
  savings ladder by time budget (+5 … +90 min). €/h kept only as a detail.
- Comfort penalty for small roads: postponed on purpose (Thomas: "keep it in mind").

## D-019 — Optimizer v2 search (2026-11-08)
- Corridor model per toll stretch: cut at every priced interchange (max 12), each piece on motorway or
  on free roads, all combinations (skip middle, leave early, join late, several skips). Each motorway run is
  priced as one ticket. Stretches combined additively.
- Escape routes: motorway to exit X then free roads to destination (and the reverse) → finds national
  roads such as the N10 (verified on Bordeaux: Poitiers → Ruffec → Angoulême → Barbezieux).
- Free-road legs start/end on an ordinary road near the exit (OpenStreetMap, Overpass) because TomTom
  stays on the motorway when a leg starts on it. Toll on "free" legs is still priced (avoid is only a preference).
- TomTom calls cached on disk (data/cache, not in git); ~110 calls per trip and vehicle.
