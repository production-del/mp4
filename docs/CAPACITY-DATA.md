# Capacity & Family Data — `data/kitchen capacity and family plans.xlsx`

A dump and interpretation of the spreadsheet that landed in the fork, plus how each sheet feeds the planner. Used as input by Phases 2 (BOM explosion), 3 (batch optimiser), and 4 (calendar UI).

This file replaces several pieces of magic numbers and mock data scattered across `src/app/{kitchen,packaging,purchasing}/data/`. A loader will be added in Phase 3.

---

## Sheets at a glance

| Sheet | Rows | What it is |
|---|---|---|
| `Kitchen capacities` | 17 | Equipment capacity (dehydrators, soak vessels, mixing bowls, intermediate containers) |
| `Kitchen processes` | 2,502 (66 intermediates) | Per-intermediate processing recipe + packing equipment + per-vessel/oven max |
| `Packaging Line Capacity` | 986 (1 active block) | 4 packaging stations × throughput + changeover cost matrix |
| `BOMS` | 3,055 (2,730 lines) | Master BOM. `Family` column populated (= intermediate code); `Extended Family` empty (lives in `family` sheet) |
| `family` | 207 (206 SKUs, 131 families, 6 extended families) | SKU → family → extended family mapping |

---

## 1. Vocabulary (locked)

The terms "family" and "extended family" mean specific things in this domain — call them out explicitly so the type system uses them correctly:

- **Family** = the **intermediate code** that becomes the product (e.g. `XHBC` for Chaga, `IYB` for Yummy Beans). Multiple SKUs can share a family if they're the same content in different package sizes (e.g. `FCHAGALG` 600g and `FCHAGASM` 100g both have family `XHBC`). Same family ≈ same recipe, same intermediate.
- **Extended family** = a **broader equipment-affinity grouping** (e.g. `FAM Fungi`, `FAM MF - Granola`). Six values total — small enough to be a string union in the type system. Different families within the same extended family share enough of the equipment-cleaning footprint that switching between them is cheaper than a full clean.
- **Same size** = same package size class (e.g. both 100g, or both 600g). Switching size mid-run incurs the "size switch" cost on most equipment.

The 4-tier changeover hierarchy on packaging lines (cheapest → most expensive) is therefore:
1. **Family same size** — different SKU, same intermediate, same package size (label/strip swap).
2. **Extended family** — different intermediate but related, typically same size.
3. **Size switch** — different size class, same product family.
4. **Full clean** — different extended family or unrelated.

The cost gradient is steepest on **Bottlo** and almost flat on **Hand packing** — so the optimiser's preference for clustering family-mates pays off most strongly when work is on Bottlo.

---

## 2. Kitchen capacities (equipment)

```
Dehydrators
  Mamma:  196 trays max, 4 trolleys × 70/trolley, max fill 0.7
  Pappa:  378 trays max, 6 trolleys × 70/trolley, max fill 0.9
  Midgy:  160 trays max, 4 trolleys × 50/trolley, max fill 0.8

Intermediate containers
  Small:  30–50 kg  ×56
  Med:    65–85 kg  ×33
  Large: 125–140 kg ×12

Soaking
  IBCs:                   200–300 kg ×8
  Buckwheat tub small:    50 kg      ×1
  Buckwheat tub large:    75 kg      ×1

Mixing
  Mixing bowl:            90 kg      ×4
```

These are **resources** in the optimiser sense. Daily capacity per resource is bounded by the `× quantity` count and the per-load max. Decision #4 (daily capacity buckets) means each of these gets a per-day availability vector.

## 3. Kitchen processes (per-intermediate)

66 intermediates. Per-row columns of interest:
- `Product` — intermediate code (e.g. `IYB`, `IAW`, `XHBC`)
- `process steps` (×3) — `mix`, `soak`, `dehydrate`, `cook` — defines which kitchen resources the intermediate requires
- `PACKING EQUIPMENT` + alternate — primary station + fallback (e.g. `elephant` / `bottlo`)
- `max /soak ibc`, `max soak /tub`, `max mix /bowl` — kg per vessel for that specific product
- `oven capacity/day`, `kilos per tray`, `dehyd hours`, `humidity` — dehydrator parameters

This is where the **product-specific** capacity numbers come from. The `Kitchen capacities` sheet says an IBC holds 200–300kg generically; this sheet says *for `IAW` walnuts*, max per IBC is 500 (likely a different unit — eggs/units rather than kg, since walnuts are also bagged in 18.54-kilo trays). Need to confirm the unit semantics before wiring numbers into the optimiser.

Packing equipment values seen: `bulk`, `dehydrate`, `dust`, `elephant`, `hand` (and `bottlo` as alternate). Note: `dehydrate` appearing as a packing equipment value is suspicious — likely a data-entry inconsistency; should be flagged on load.

## 4. Packaging line capacity

The active block (rows 4–8) is the key data. Columns observed:

| Station | Staff | Hours/day | Units/hr | Size switch | Family same-size | Extended family | Full clean |
|---|---|---|---|---|---|---|---|
| Hand packing | 3 | 8 | 200 | 2 | 2 | 2 | 5 |
| Elephant | 3 | 8 | 187.5 | 2 | 5 | 5 | 15 |
| Dust | 3 | 8 | 187.5 | 5 | 5 | 10 | 20 |
| Bottlo | 5 | 8 | 375 | 40 | 10 | 15 | 120 |
| Hand packing beetroot powder | 3 | — | 75 | — | — | — | — |

Times are minutes per changeover. Hand packing beetroot powder is a per-product override — the planner needs a way to express "this SKU on this line uses a different rate."

Daily throughput (units): hand 1600, elephant 1500, dust 1500, bottlo 3000.

## 5. Family / Extended Family map

- 206 SKUs mapped
- 131 distinct family codes
- 6 distinct extended families: `FAM Fungi`, `FAM MF - Clusters`, `FAM MF - Granola`, `FAM MF - Munchies`, `FAM MF - Nuts`, `FAM MF - Tea`
- **108 SKUs have NO extended family value.** These need a fallback rule (see open questions).

## 6. BOMS

2,730 BOM lines. Schema:
```
Assembled Product Code | Component Product Code | (description)
| Product Group | Quantity + Wastage | SOH | Family | Extended Family
```

`Family` column carries the intermediate code (matches the family sheet). `Extended Family` column is empty across all 2,730 rows — extended-family lookup must come from the `family` sheet.

This is the BOM Phase 2's recursive exploder will consume. Two concerns:
- **Multi-level depth**: a finished good consumes an intermediate (level 1), and that intermediate has its own BOM in the same sheet — depth ≥ 2 is the norm. The Phase 2 exploder needs to handle this.
- **Wastage baked in**: `Quantity + Wastage` is a single number. The engine doesn't currently model wastage separately; either it stays baked in (simple) or we split it out for visibility. **Open question.**

---

## 7. How this feeds the planner

### Phase 2 — BOM exploder
- Source of truth: `BOMS` sheet (replaces the existing `BOMComponent[]` mock seed)
- Recursive walk on `Component Product Code` — if it's also an `Assembled Product Code` row in the same sheet, recurse
- `Family` column lets the exploder annotate each plan-item with its family for downstream changeover cost calculations
- Wastage stays baked into `Quantity + Wastage` until we have a reason to split

### Phase 3 — Batch optimiser
- **Resources** — the `Kitchen capacities` and `Packaging Line Capacity` sheets define the resource set. Each resource gets a daily capacity vector (decision #4).
- **Per-product process recipe** — `Kitchen processes` says which resources a given intermediate touches and at what rate.
- **Changeover cost** — the matrix from `Packaging Line Capacity` × the family/extended-family lookup. The optimiser's `changeoverHours` term becomes a per-pair-of-batches function: `costToSwitch(prevBatch, nextBatch, station)`.
- **Why this matters** — the cost gradient on Bottlo (10 → 15 → 40 → 120) is steep enough that planning Bottlo runs by extended family will dominate other optimiser concerns. Less so for Hand packing (2/2/2/5) where family doesn't matter.

### Phase 4 — Calendar UI
- The packaging-line names (Hand, Elephant, Dust, Bottlo) become **swimlanes** in the calendar's daily view, with capacity utilisation drawn underneath each.
- The family colour-coding from the existing packaging UI extends naturally to the calendar chips.

---

## 8. Open questions for the user

These came out of the data and need answers before Phase 3:

1. **108 SKUs without extended family.** What's the rule? Options:
   - (a) Treat every switch into/out of these as a full clean (conservative, expensive).
   - (b) Treat each unmapped SKU as its own singleton extended family (no penalty within itself, full clean to anything else).
   - (c) These are products that don't go through Bottlo, so the distinction never matters — leave the field optional and only enforce when scheduling on Bottlo.

2. **Combined product + size switch cost.** When changing both family *and* size (e.g. Chaga 600g → Cordyceps 100g, both `FAM Fungi`), is the cost:
   - (a) `max(sizeSwitch, extendedFamilySwitch)` — pessimistic
   - (b) `sizeSwitch + extendedFamilySwitch` — additive
   - (c) Just `sizeSwitch` because the size-switch already includes a clean
   - The spreadsheet doesn't disambiguate.

3. **Wastage in BOMS.** `Quantity + Wastage` is a single column. Keep baked in, or split? Splitting helps with cost visibility ("we throw away 8% of walnuts in soak") but adds engine complexity.

4. **Per-product rate overrides.** "Hand packing beetroot powder" runs at 75 u/hr instead of 200. Are there other product-specific rate overrides not in the file, or is this the only one? Need to confirm the exhaustive list before the optimiser uses station-level rates blindly.

5. **Unit semantics on `Kitchen processes`.** `max /soak ibc` shows `500` for walnuts but `Kitchen capacities` says IBCs hold `200-300 kg`. Is the 500 a unit count (eggs, kilos pre-soak before the swelling, something else)? Wiring the number in without confirming the unit will land bad capacity constraints.

6. **`dehydrate` listed as packing equipment.** Likely a data-entry typo for one or more rows in `Kitchen processes`. Should the loader treat it as an error, ignore the row, or coerce silently? My instinct: surface a load-time warning, ignore the bad value.

Resolve these before Phase 3 is implemented; deferring them won't make them go away and the optimiser's behaviour depends on each one.
