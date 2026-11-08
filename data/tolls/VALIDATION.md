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

## Known gaps
- Vinci PDF has no intra-network grid for **A10 Paris–Tours, A71 Orléans–Bourges, A85**: only cross-network
  tables (pages 8–9, skipped for now). Needed for the Bordeaux and Brive trips.
- Vinci page 4 (A61/A62/A64/A65, Toulouse–Bayonne): 29 station names not recognised.
- Vinci rectangular cross-network tables (pages 2, 8, 9) not parsed yet.
- data.gouv.fr APRR CSV is a third-party extraction with broken station names (6,962 "stations",
  names glued together) → must be cleaned or re-extracted from APRR PDFs.
