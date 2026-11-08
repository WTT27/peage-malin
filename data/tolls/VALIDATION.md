# Extraction checks (class 1)

| Operator | Check | Extracted | Official | OK |
|---|---|---|---|---|
| SAPN | Caen → Poissy/Orgeval | 18,00 | 18,00 (PDF) | ✅ |
| SAPN | Chaufour-Gaillon → Poissy/Orgeval | 3,00 | 3,00 (PDF) | ✅ |
| Sanef | Calais → Reims | 26,6 | 26,6 (PDF) | ✅ |
| Sanef | Arras Est → Paris/Roissy | 15,6 | 15,6 (PDF) | ✅ |
| Sanef | Paris/Noisy → Reims Est | 14,3 | 14,3 (PDF) | ✅ |
| Sanef | Boulogne Est → L'Isle-Adam | 25,0 | 25,0 (PDF) | ✅ |
| Vinci | Tours centre → Virsac (Bordeaux) | 34,90 | 34,90 (main links list) | ✅ |
| Vinci | Paris → Bordeaux = Paris→Tours (26,00) + Tours→Virsac (34,90) | 60,90 | 60,90 | ✅ sum at network boundary is exact here |
| Cofiroute | Paris (La Folie-Bessin) → Orléans nord | 12,00 | 12,00 (main links) | ✅ |
| Cofiroute | Paris → Tours centre (Monnaie) | 26,00 | 26,00 | ✅ |
| Cofiroute | Paris → Bourges | 24,60 | 24,60 | ✅ |
| Cofiroute | Paris → Le Mans ZI nord | 21,60 | 21,60 | ✅ |
| Cofiroute | Paris → Angers (Corzé) | 32,90 | 32,90 | ✅ |

## Known gaps
- ~~A10 Paris–Tours, A71, A85 missing~~ → solved by the Cofiroute guide (11,004 pairs).
- Escota, Arcos (A355), Duplex A86 PDFs not parsed yet (not on the test trips).
- Vinci page 4 (A61/A62/A64/A65, Toulouse–Bayonne): 29 station names not recognised.
- Vinci rectangular cross-network tables (pages 2, 8, 9) not parsed yet.
- data.gouv.fr APRR CSV turned out messy (glued names) → replaced by the official APRR/AREA PDFs, parsed cleanly (APRR 177 stations / 21,505 pairs, AREA 51 / 955, 0 rejected lines).

## First engine run on the test trips (2026-11-08, Sunday ~16:30, TomTom fastest route, 5008 profile)

| Trip | Route | Toll stretches | Total |
|---|---|---|---|
| → Demangevelle | 430 km, 4 h 07 | SAPN Chaufour-Gaillon → Mantes 3,00 · Duplex A86 Vaucresson → Vélizy 8,40 (Sunday afternoon rate) · APRR Les Eprunes → Montigny-le-Roi 23,00 | **34,40 €** |
| → Bordeaux | 633 km, 5 h 43 | Cofiroute A28 Alençon nord → Tours (St-Christophe) 14,80 · A10 Tours centre (Sorigny) → Virsac 34,90 | **49,70 €** |
| → Brive | 539 km, 4 h 57 | SAPN Chaufour-Gaillon → Mantes 3,00 · Cofiroute A10/A71 Allainville → Vierzon nord 17,20 | **20,20 €** |

Station location coverage: SAPN 21/28, Sanef 87/93, Vinci 223/351, APRR 159/177, AREA 41/51, Cofiroute 244/252.
Still to check against the operators' own simulators / Thomas's real receipts.
