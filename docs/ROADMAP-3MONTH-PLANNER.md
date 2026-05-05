# 3-Month Production Planner — Roadmap

This branch (`feature/calendar-planner`) extends the Byron Planner to drive optimal 3-month production scheduling end-to-end: SOH + demand → BOM-cascaded plan → optimised batches → calendar with toggleable layers → timed POs that hit price breaks.

The mockup at [`docs/mockup.html`](./mockup.html) shows the target UI.

---

## Guiding constraints

Honour the existing project's six principles (see [INTEGRATION-BRIEF.md](./INTEGRATION-BRIEF.md)):

1. Unleashed is an edge adapter, not the domain model
2. Canonical inputs (demand from CSV, never derived)
3. One type per concept; discriminated unions for variants
4. ISO date strings at boundaries, `Date` only inside React
5. Pure engines, thin hooks
6. One-shot migrations, no compat layers

Anything new in this roadmap that violates these gets reworked, not merged.

---

## Phase 1 — Forward demand projection (week 1)

The existing engines (`analyzeKitchenBatches`, `projectComponentSOH`) already iterate over arbitrary date ranges — there's no horizon cap to remove. What's actually missing is a **forward demand forecaster** that turns the daily-refreshed Unleashed sales rate (`data/demand.csv`'s `AVE` column → monthly demand per product) plus any dated `Demand` events into a `WeeklyDemand[]` covering the configured horizon. That structure becomes the input to Phase 3's batch optimiser.

The `data/demand.csv` is a daily-refreshed Unleashed export — a *rate per product* across rolling windows, not a time series. It does not need migrating.

**Files to add / touch**
- `src/lib/planning/engine-io.ts` — add `WeeklyDemand` and `PlanningHorizon` types
- `src/lib/planning/forecast-demand.ts` — new pure function `forecastWeeklyDemand(rates, datedEvents, horizon) → WeeklyDemand[]`
- `src/__tests__/engine/forecast-demand.test.ts` — new

**Behaviour**
- Monthly rate spreads across the horizon: per-week qty = `monthlyRate × 12 / 52`
- Dated `Demand` events bucket into the week containing `needByDate` (Monday-anchored)
- A week's `quantity` = rate-derived + event-derived; `sources` records which contributed
- Horizon length and start-week come from a `PlanningHorizon` config (default 12 weeks, anchored on the upcoming Monday)

**Acceptance**
- Forecaster returns exactly `horizon.weeks` rows per product code
- A product with no rate and no events still produces a row per week with `quantity: 0`
- Rate-only product distributes evenly across weeks (within rounding)
- An event mid-horizon adds to that week's quantity without inflating others
- `sources` array is correct: `['rate']`, `['event']`, or `['rate','event']`

**Operational follow-up (not in Phase 1)**
- `/api/demand-data` caches until restart — should check CSV mtime so a fresh daily export is picked up without manual `?refresh=true`

## Phase 2 — Cascading BOM explosion (week 1–2)

Today's `bomMap` is one level deep. Finished-good demand must drive raw-material POs through every intermediate level.

**Files to touch**
- New: `src/lib/engine/bom-explode.ts` — pure function, recursive, cycle-detecting
- `src/lib/engine/kitchen-projection.ts` — call exploder
- `src/__tests__/engine/bom-explode.test.ts` — new (depth ≥3, cycle case, missing-component case)

**Acceptance**
- Walnut Granola demand → drives Roasted Walnut intermediate → drives Walnut Raw PO
- Cycle detection throws with a readable error listing the cycle path
- Missing component yields a `PlanWarning`, not a crash

## Phase 3 — Batch optimiser (week 2–3)

The keystone module. Pure engine, pluggable cost function. Inputs sourced from [`docs/CAPACITY-DATA.md`](./CAPACITY-DATA.md) — the spreadsheet at `data/kitchen capacity and family plans.xlsx`.

**New modules**
- `src/lib/planning/capacity-data.ts` — loader for the spreadsheet → typed records
- `src/lib/engine/changeover.ts` — pure `costToSwitch(prevBatch, nextBatch, station)` using the family / extended-family / size hierarchy
- `src/lib/engine/batch-optimiser.ts` — the optimiser itself

**Type sketch**

```typescript
type Station = 'hand-packing' | 'elephant' | 'dust' | 'bottlo';
type ExtendedFamily =
  | 'FAM Fungi' | 'FAM MF - Clusters' | 'FAM MF - Granola'
  | 'FAM MF - Munchies' | 'FAM MF - Nuts' | 'FAM MF - Tea';

interface ProductMeta {
  productCode: string;
  family: string;                            // intermediate code, e.g. 'XHBC'
  extendedFamily: ExtendedFamily | null;     // null = unmapped → full-clean against everything (decision #1)
  packageSize: 'SML' | 'MED' | 'LRG' | string;
  station: Station;
  rateUnitsPerHour: number;                  // station default, overridable per product (decision #4)
}

interface RateOverride {
  productCode: string;
  station: Station;
  unitsPerHour: number;
  reason?: string;
}

interface ChangeoverCostMatrix {
  // Per station, in minutes. Direct from Packaging Line Capacity sheet.
  [station: string]: {
    sizeSwitch: number;
    familySameSize: number;
    extendedFamily: number;
    fullClean: number;
  };
}

interface BatchOptimiserInput {
  productCode: string;
  meta: ProductMeta;
  demand: WeeklyDemand[];                    // full horizon, weekly
  shelfLifeDays: number;
  capacityByDate: Record<string, ResourceCapacity>;   // daily, per resource
  warehouseCapByDate: Record<string, number>;          // daily storage cap
  changeoverMatrix: ChangeoverCostMatrix;
  // The optimiser sees the *previous* batch on the same station so it can
  // price the changeover; for cross-product runs this drives the family-
  // clustering behaviour without any explicit rule.
  previousBatchOnStation: { meta: ProductMeta; finishDate: string } | null;
}

interface BatchOptimiserOutput {
  batches: ScheduledBatch[];
  rationale: string[];                       // "1 run covers 11 weeks; shelf-life 90d permits"
  unmetDemand: { week: string; qty: number }[];
  interRunDays: number[];                    // gaps between consecutive runs, for telemetry
}
```

**Objective: minimise total cost.** Cost terms:
- `+ changeoverMinutes(prev, curr, station)` — variable per (prev, curr, station) using the matrix in `CAPACITY-DATA.md §4`. **This is the lever that drives family-clustering.** Bottlo's 10 / 15 / 40 / 120 gradient is steep enough that the optimiser will reorder runs to keep mates together; Hand packing's 2 / 2 / 2 / 5 won't push much.
- `+ storage_overflow_penalty` — per-day, per-unit over the warehouse cap (decision #4: daily buckets)
- `+ shelf_life_violation_penalty` — large; effectively a hard constraint
- `– price_break_savings` — negative cost = reward
- (later) `+ peak_storage_penalty` if smoothing becomes necessary

**Hard constraints**: shelf-life ceiling, vessel/oven/IBC capacity per day (from `Kitchen capacities` + `Kitchen processes`), demand coverage by required date.

**Tuning the "don't repeat for 3 months" behaviour.** Same as before — emerges from the cost function via per-station changeover costs, not a hard rule. Long-shelf-life SKUs land at one run/quarter because the changeover cost dominates storage. Short-shelf-life SKUs stay frequent because shelf-life caps coverage.

**Family clustering as a free win.** Once `costToSwitch` is wired through, scheduling Bottlo runs by extended family (and within that, by family same-size) emerges automatically — the optimiser sees that switching XHBC → XHBC (same family) costs 10 min, while XHBC → ICW (different extended family) costs 120 min, and prefers the cheap sequence wherever it can without breaking demand-by-date constraints.

**`costToSwitch` rule (decision #2: non-cumulative max).** The cost of a single changeover equals the **maximum** of the applicable changeover-cost terms, never the sum. A size switch is considered to include the cleaning required for an extended-family switch.

```typescript
function costToSwitch(prev: ProductMeta, curr: ProductMeta, station: Station): number {
  if (prev.productCode === curr.productCode) return 0;
  const m = changeoverMatrix[station];
  // Decision #1: missing extended family → full clean
  if (!prev.extendedFamily || !curr.extendedFamily ||
      prev.extendedFamily !== curr.extendedFamily) return m.fullClean;
  const candidates: number[] = [];
  if (prev.family !== curr.family) candidates.push(m.extendedFamily);
  if (prev.packageSize !== curr.packageSize) candidates.push(m.sizeSwitch);
  if (prev.family === curr.family && prev.packageSize === curr.packageSize)
    candidates.push(m.familySameSize);
  return candidates.length === 0 ? 0 : Math.max(...candidates);
}
```

**Wastage handling (decision #3).** The BOM exploder splits each component's quantity into `quantityClean` and `wastage`. The optimiser plans against `quantityClean + wastage`; reports use `wastage` separately for visibility. Phase 2 owns the split.

**IBC capacity (decision #5).** Working constant: `IBC_CAPACITY_KG = 300` until the unit semantics on `Kitchen processes.max /soak ibc` are pinned down.

**Loader behaviour for bad data (decision #6).** When the spreadsheet has `dehydrate` in the packing-equipment column, emit a load-time warning naming the product code and drop just that value (don't fail the load).

**Algorithm**: dynamic programming over the daily grid. State = `(day, inventory, lastBatchMetaOnStation)`. The third dimension is what makes changeover cost path-dependent. Start with a greedy seed (largest demand first, family-clustered), then local-search swaps.

**Sub-phasing.** Phase 3 is delivered in four passes:

- **3a — Changeover cost function** *(landed)*. `src/lib/engine/changeover.ts` with the locked spec. 20 tests.
- **3b — Capacity-data loader** *(landed)*. `src/lib/planning/capacity-data.ts` parses the spreadsheet into typed records. 24 tests.
- **3c — Single-product optimiser** *(landed)*. `src/lib/engine/batch-optimiser.ts` with `optimiseSingleProduct(input)` — weekly DP over `(week, inventory)`, shelf-life-window cap, storage cap, demand-coverage hard constraint. 17 tests covering long-shelf-life-collapses-to-one-run, short-shelf-life-forces-frequent-runs, storage-bound-forces-extra-runs, infeasibility, cost-minimisation tuning. **Single-product**: changeover cost is folded into a per-product `setupCost` parameter that the orchestrator (3d) provides; this module doesn't know about other products.
- **3d — Multi-product orchestration** *(pending)*. New `src/lib/engine/optimiser-orchestrator.ts` that:
  1. Takes the per-product feeds (from forecaster + BOM exploder).
  2. Computes an initial schedule per product via `optimiseSingleProduct` with default setupCosts.
  3. Resolves station-level interleaving: for each station, walks the merged timeline and computes actual `costToSwitch` between adjacent batches.
  4. Re-optimises iteratively — adjust per-product setupCosts to reflect actual cross-product changeover costs and re-run, until the schedule stabilises (or a max iteration count).
  5. Outputs the unified schedule + rationale that surfaces "Bottlo run sequence: XHBC → XHCP saved 105 min vs alternative ordering."
  
  This is a fixed-point iteration / Lagrangian-style coupling, not a fresh full-DP. The single-product DP does the heavy lifting; the orchestrator only mediates the shared-station coupling.

**Acceptance**
- Two adjacent small demands collapse into one batch when changeover savings > storage cost
- Output batches never violate shelf life or vessel capacity
- A long-shelf-life SKU with realistic changeover cost plans 1–2 runs across 12 weeks (rather than weekly)
- Property test: total batch volume ≥ total demand (no shortfall unless `unmetDemand` reports it)
- `interRunDays` reported for every SKU so the UI can flag SKUs touched more often than expected
- (3d) Bottlo runs of the same extended family land adjacent to each other in the schedule when shelf-life and storage permit, demonstrably reducing total Bottlo minutes vs. the baseline single-product output.

## Phase 3e — Daily resource scheduling (post-checkpoint)

The orchestrator (Phase 3d) places batches into weekly buckets and orders them within the week to minimise changeovers. It does NOT assign each batch to a specific working day, and it does NOT enforce per-day station-time or kitchen-resource capacity. Phase 3e closes that gap.

**Why two passes (not redo the DP)** — the per-product weekly DP is about *when to make a batch and how big*. Daily assignment is about *which day of that week the batch slots into*. Different concerns, cleanly separable. Redoing the DP at daily granularity would explode the state space (84 days × inventory × prev-batch ≫ 12 weeks × inventory) without changing the batch decisions in any meaningful way.

**New module: `src/lib/engine/day-assigner.ts`**

```typescript
type WorkingDay = string; // YYYY-MM-DD

interface ResourceCapacity {
  /** Working minutes available per day; e.g. station hours/day × 60. */
  minutesPerDay: number;
  /** Optional override per specific day (holidays, half-days, …). */
  perDayOverride?: Record<WorkingDay, number>;
}

interface DayAssignerInput {
  /** Output of the orchestrator: per-station, per-week ordered batches. */
  perStation: Map<Station, StationTimeline>;
  /** Per-station daily capacity (default: 8h/day = 480 min). */
  stationCapacity: Record<Station, ResourceCapacity>;
  /** Working calendar — skip weekends and holidays. */
  workingDays: (weekStart: string) => WorkingDay[]; // returns the Mon-Fri of that week
  /** Per-product duration calculator: returns minutes given quantity + station. */
  durationOf: (batch: ScheduledBatchWithMeta, station: Station) => number;
}

interface DayAssignerOutput {
  /** Each batch annotated with the specific day it runs and its duration. */
  perStation: Map<Station, DailyStationTimeline>;
  /** Per-day capacity overruns surfaced as warnings; not auto-resolved. */
  warnings: DayAssignerWarning[];
}

interface DailyStationTimeline {
  station: Station;
  /** Per-day load: which batches (in order) and total minutes used. */
  byDay: Map<WorkingDay, { batches: AssignedBatch[]; usedMinutes: number; capacityMinutes: number }>;
}

interface AssignedBatch extends ScheduledBatchWithMeta {
  scheduledDate: WorkingDay;
  durationMinutes: number;
  /** Changeover minutes from the previous batch on this station this day. */
  changeoverMinutes: number;
}
```

**Algorithm.** For each station, walk weeks chronologically. Within a week, take the orchestrator-ordered batches and greedily pack into Mon–Fri:
1. Start day = Monday of week, capacity = `minutesPerDay`.
2. For each batch in orchestrator order: compute duration + carry-over changeover. If it fits today, assign; else move to next day, reset capacity, retry. If even a fresh day can't hold it (huge batch on a low-capacity day), emit `oversize_batch` warning and assign anyway with overrun reported.
3. If the week's Friday gets filled and there are remaining batches, emit `week_overflow` warning naming the batches that didn't fit.

Greedy-by-orchestrator-order preserves family-clustering benefits across day boundaries.

**Kitchen-resource caps (mixing bowls, IBCs, dehydrator trays).** Defer to Phase 3f. They're per-batch resource holds with durations measured in days (a soak runs 1+ days) — different shape from station-time-per-day. Not blocking for the calendar UI: the calendar can show station-day assignments first, kitchen-resource overlay can come later.

**Acceptance**
- Every batch in orchestrator output gets a specific `scheduledDate` (working day).
- No day's `usedMinutes` exceeds `capacityMinutes` without a warning.
- Family-clustering preserved: when same-family batches are adjacent in orchestrator order, they remain adjacent after day-assignment (grouped on the same day or contiguous days).
- A week with too much demand emits `week_overflow` warnings naming the batches that didn't fit, rather than silently dropping or compressing.

## Phase 4 — Calendar UI (week 3–4)

New route. Reads engine output, no new business logic in the component.

**Files to add**
- `src/app/calendar/page.tsx` — top-level
- `src/app/calendar/components/CalendarGrid.tsx` — month/3-month view
- `src/app/calendar/components/LayerToggles.tsx` — Kitchen / Production / Packaging / POs / Receiving
- `src/app/calendar/components/ActivityChip.tsx` — colour-coded by `kind`
- `src/app/calendar/components/ActivityDrawer.tsx` — edit / reschedule / dismiss
- `src/app/calendar/hooks/useCalendarPlan.ts` — projects `PlanItem[]` → `CalendarActivity[]`
- New: `src/lib/planning/calendar-projection.ts` — pure projection function

**Type sketch**
```typescript
type ActivityKind = 'kitchen' | 'production' | 'packaging' | 'po-placed' | 'po-receiving';
interface CalendarActivity {
  id: string;
  kind: ActivityKind;
  date: string;                    // ISO local
  title: string;
  planItemId: string;
  consumes?: { productCode: string; qty: number }[];
  drives?: { activityId: string; description: string }[];
  dismissed: boolean;
  edited: boolean;
}
```

**Acceptance**
- All five layers render, each toggleable independently
- Click activity → drawer with consumes/drives/edit/reschedule/dismiss
- Dismissed activities visually fade but stay in DOM (toggle restores)
- Reschedule re-runs the engine and shows the diff before commit

## Phase 5 — PO timing solver (week 4–5)

Given a required-by date, lead time, price-break tiers, and warehouse capacity, choose order date and qty.

**New: `src/lib/engine/po-solver.ts`**

```typescript
interface POSolverInput {
  productCode: string;
  required: { date: string; qty: number }[];
  leadTimeDays: number;
  priceBreaks: { minQty: number; pricePerUnit: number }[];
  warehouseCapByDate: Record<string, number>;
  shelfLifeDays: number;
}
```

**Acceptance**
- Mockup hint "Bump Walnut PO 12 May → 18 May for 500kg break" is reproducible from a fixture
- Solver respects warehouse capacity per arrival date
- Multi-required-by case: chooses single bulk order vs. split based on storage cost vs. price-break savings

## Phase 6 — Push to Unleashed (week 5–6)

Wire confirmed POs and assemblies through the existing adapter.

**Files to touch**
- `src/lib/unleashed/server.ts` — add `pushPurchaseOrder()` if not already present
- `src/app/calendar/components/ActivityDrawer.tsx` — "Confirm & push" button on PO activities
- New e2e test: draft → confirm → push (mocked Unleashed)

**Acceptance**
- One-click push from the calendar drawer
- Local state marks pushed POs as `committed: true`; engine treats them as fixed in next re-plan

---

## Out of scope (for now)

- Multi-site planning (one warehouse assumed)
- Labour scheduling (kitchen capacity is per-equipment, not per-person)
- Recipe versioning over time (current BOM is treated as constant within the horizon)
- Mobile UI (desktop-first; calendar is dense)

## Resolved decisions

1. **Re-plan trigger** → **manual only.** Re-plan button on the calendar header. Engine never auto-runs on Unleashed sync. `dismissed` and `edited` flags persist across runs; calendar shows a "stale: source data updated <when>" banner when Unleashed has synced since the last plan.

2. **Demand input + optimiser goal** → **weekly demand rows across the full horizon, optimiser maximises inter-run interval.**

   *Today:* weekly production tasks cover roughly monthly demand. Each SKU is touched ~monthly.

   *Target:* a single packaging/production run covers ≈3 months of demand wherever shelf-life and storage permit. Same SKU shouldn't reappear for 3+ months unless constraints force it.

   This is two changes:
   - **Input:** `demand.csv` gains a `weekStart` (ISO Monday) column with one row per `(productCode, weekStart)` covering the full horizon. One-shot migration in Phase 1 splits any legacy monthly rows evenly across their weeks.
   - **Optimiser objective (Phase 3):** standard total-cost minimisation (changeovers + storage + shelf-life − price-break savings). The "fewer, longer-spaced runs" goal is achieved by **tuning per-product `changeoverHours`** so that combining demand into one larger run beats splitting it. Hard constraints — shelf-life, vessel capacity, daily storage cap, demand-by-date — do the rest.

   Emergent behaviour (when costs are tuned correctly): long-shelf-life, low-storage-footprint SKUs collapse to 1 run per 3 months because that's cheapest. Short-shelf-life SKUs stay frequent because the shelf-life constraint forces them. Storage-tight SKUs land in between. The optimiser surfaces *why* in its `rationale[]` output ("split into 2 runs: storage cap binds at week 6").

3. **PO modifiability** → **pushed POs are fully mutable.** The engine can propose any of: quantity change, date change, line split, or merge. New `PlanItem` variant `po-modification`:

   ```typescript
   type ProposedDelta =
     | { kind: 'qty-change';   newQty: number }
     | { kind: 'date-change';  newArrivalDate: string }   // ISO local
     | { kind: 'qty-and-date'; newQty: number; newArrivalDate: string }
     | { kind: 'split';        into: { qty: number; arrivalDate: string }[] }
     | { kind: 'cancel'; }
   interface POModification {
     kind: 'po-modification';
     originalPOId: string;
     delta: ProposedDelta;
     rationale: string;          // e.g. "+200kg hits 500kg price break ($-340)"
   }
   ```

   Calendar renders modifications with a distinct chip style (dashed border on the existing PO chip). Confirming pushes the update to Unleashed via the existing adapter; cancelling drops the proposal and the engine is free to re-propose on the next manual re-plan. Phase 5 produces them; Phase 6 pushes them.

4. **Capacity model** → **daily buckets.** Optimiser constraints are per-day per-resource (vessel, oven, packaging line). Calendar drawer shows daily load; the bottom-strip heatmap rolls up to weekly for at-a-glance scanning. `BatchOptimiserInput` gains `capacityByDate: Record<string, ResourceCapacity>` instead of a single weekly cap.

## Resolved (post-checkpoint)

- **Horizon length** — staying at **12 weeks** for now. User confirmed: "lets start with 12 weeks and expand horizon once comfortable." Phase 4 UI surfaces the horizon as a setting; we'll bump the default once the system is in use.
- **Daily resource granularity** — confirmed. **Phase 3e** added below to extend the orchestrator with per-day station-time scheduling and daily resource-cap enforcement. Per-product DP stays weekly (it's about batch sizing, not within-week assignment); the day-assigner is a post-pass.
- **Wastage rates source** — resolved. Spreadsheet now carries a `wastage rates` tab with per-edge clean + wastage absolute values. Loader parses it (Phase 3b extension, landed) and attaches split to each `BOMComponent`. Exploder (Phase 2) uses the split when present, falls back to legacy `wastageRates` parameter otherwise.
