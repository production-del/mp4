# Station assignments to review — profit merge 2026-06-02

Profit values for these 21 SKUs were merged into `_profit-input.tsv` → `product-profit.json`
(via `scripts/build-profit.js`). **Only the profit was set; station letters were left as-is**
per "flag station assignments for later". Review the stations below and correct col 6 (station
letter: H=Hand, E=Elephant, D=Dust, O=bottlO, B=Bulk→hand-packing) in `data/_profit-input.tsv`,
then re-run `node scripts/build-profit.js`.

| Code | Profit | Letter | Planner station | Note |
|---|---|---|---|---|
| BULK-ABBNR-BOX | 60.26 | B | hand-packing | bulk fallback |
| MFBKCARAB9 | 58.16 | E | elephant | |
| MFBUCKWB12 | 26.00 | B | hand-packing | bulk fallback |
| MFCARCLB9 | 145.22 | B | hand-packing | bulk fallback |
| MFCARDASM | 11.96 | H | hand-packing | |
| MFCASHEB6 | 61.34 | B | hand-packing | bulk fallback |
| MFCINNQXL | 100.19 | B | hand-packing | bulk fallback |
| MFCUMSWSM | 2.79 | H | hand-packing | |
| MFGOCHUME | 6.65 | H | hand-packing | |
| MFJASMIME | 3.48 | H | hand-packing | |
| MFLINSEB6.5 | 46.23 | B | hand-packing | bulk fallback |
| MFMAPLEXL | 35.20 | H | hand-packing | |
| MFMIXENB5.5 | 70.86 | B | hand-packing | bulk fallback |
| MFOATSRB5 | 17.99 | B | hand-packing | bulk fallback |
| MFTAMARLG | 8.05 | E | elephant | ⚠ profit data says elephant but planner ran it on hand-packing — see routing note |
| MFTERIMB10 | 141.71 | B | hand-packing | bulk fallback |
| **MFTERIMB5** | 88.12 | H | hand-packing | ⚠ NEW row appended (no prior entry) — station is a guess, confirm |
| MFTUMMTB.8 | 51.94 | B | hand-packing | bulk fallback |
| SDGREENLG | 77.24 | H | hand-packing | |
| SDREDLOB3 | 99.57 | B | hand-packing | bulk fallback |
| **SDYELLOB3** | 131.22 | H | hand-packing | ⚠ NEW row appended — Stardust bulk, station is a guess (sibling SDYELLO* pack on dust) |

## Open routing bug (the reason stations look off)
`product-profit.json.plannerStation` is consulted by the planner's **auto-route fallback only**
(`page.tsx:368-369`) — i.e. for allowlisted SKUs *missing from the family sheet* with no
pre-existing meta. SKUs that DO have a family-sheet/derived meta ignore `plannerStation` and
route via the intermediate's `packingStation` (Pass 1, `page.tsx:567-573`), which is why
**MFTAMARLG carries `elephant` in profit data but the planner scheduled it on hand-packing**.
Fix direction (deferred): have Pass 1 prefer `productProfit.plannerStation` when present, or add
these SKUs to the family sheet with the correct station. Bulk (`B`) SKUs all collapse to
hand-packing by design (no dedicated bulk line) — revisit if a bulk station is added.
