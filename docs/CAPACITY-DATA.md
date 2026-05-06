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

## 8. Resolved decisions (data semantics)

1. **108 SKUs without extended family** → switching into or out of them costs **`fullClean`**. No partial-credit treatment. The optimiser will avoid mixing these into family-clustered runs unless demand forces it.

2. **Combined product + size switch is non-cumulative.** The cost of a switch is the **maximum of the applicable individual costs**, never the sum. A size switch is considered to *include* the cleaning needed for an extended-family switch — so changing both family *and* size on Bottlo costs `max(40, 15) = 40` minutes, not `55`.

   Implementation rule (`changeover.ts`):
   ```
   if prev.extendedFamily !== curr.extendedFamily
      OR either is null: → fullClean
   else (same extended family):
     candidates = []
     if prev.family !== curr.family:  candidates.push(extendedFamily)
     if prev.size   !== curr.size:    candidates.push(sizeSwitch)
     if prev.family === curr.family
        AND prev.size === curr.size:  candidates.push(familySameSize)
     → max(candidates)  // 0 if list is empty (truly identical SKU back-to-back)
   ```

3. **Wastage is split out for visibility.** The BOM exploder produces two parallel quantities per component: `quantityClean` (theoretical use) and `wastage` (the implicit overage in the spreadsheet's `Quantity + Wastage` column). The loader does the split — this is a derived figure, so the loader infers `wastage` by comparing to a separately-maintained clean BOM if one exists, or initially treats the whole figure as `quantityClean` with `wastage: null` until a wastage rate per component is provided. **Follow-up:** confirm whether a clean-BOM source exists separate from this spreadsheet.

4. **Per-product rate overrides need to be supported as a first-class concept.** The "Hand packing beetroot powder" row is a worked example, not the only one — overrides may be added over time. Model:
   ```typescript
   interface RateOverride {
     productCode: string;
     station: Station;
     unitsPerHour: number;
     reason?: string;          // optional human note
   }
   ```
   Stored alongside the station-level defaults; the optimiser looks up overrides first, then falls back to the station default. UI exposes an editor in settings for adding/removing them.

5. **IBC capacity** → **300 kg** as the working assumption. The `max /soak ibc = 500` field in `Kitchen processes` is currently treated as 300 kg (lower of the spreadsheet's stated 200–300 range) for capacity calculations. Single-source-of-truth field will be the loader's `IBC_CAPACITY_KG` constant; revisit once the units are confirmed.

6. **`dehydrate` in packing-equipment column is a typo.** It's a process step, not a packing station. The loader **emits a warning** at load time naming the offending product code(s), then **drops the bad value** (treats the row as having no packing equipment if `dehydrate` was the only entry, otherwise keeps the valid alternates). Hard-fail would be too aggressive given this is real production data.

These shape the loader and the changeover function. Follow-up to track:
- Where does the *clean* BOM live (for the wastage split)? If nowhere yet, we may need to capture wastage rates as a separate manual config.
