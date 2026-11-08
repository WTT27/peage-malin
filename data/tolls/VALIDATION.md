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
