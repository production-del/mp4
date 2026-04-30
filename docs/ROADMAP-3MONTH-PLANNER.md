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

## Phase 1 — Forecast horizon (week 1)

Extend the planning engine from single-period to a 12-week rolling window.

**Files to touch**
- `src/lib/engine/serialization.ts` — add `horizonWeeks` to `EngineRequest`, default 12
- `src/lib/engine/kitchen-projection.ts` — iterate week-by-week, carry SOH forward
- `src/lib/engine/purchasing-projection.ts` — same
- `src/__tests__/engine/horizon.test.ts` — new

**Acceptance**
- Engine returns `PlanItem[]` spanning ≥84 days from `today`
- SOH carry-forward is correct across week boundaries (test: known fixture)
- No regressions in existing `kitchen-projection.test.ts` / `serialization.test.ts`

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

The keystone module. Pure, pluggable cost function.

**New: `src/lib/engine/batch-optimiser.ts`**

```typescript
export interface BatchOptimiserInput {
  productCode: string;
  demand: WeeklyDemand[];                      // full horizon, weekly
  vesselCapacity: number;                      // kg/L per run
  minBatchSize: number;
  maxBatchSize: number;
  shelfLifeDays: number;
  changeoverHours: number;
  capacityByDate: Record<string, ResourceCapacity>;   // daily
  warehouseCapByDate: Record<string, number>;          // daily storage cap
}
export interface BatchOptimiserOutput {
  batches: ScheduledBatch[];
  rationale: string[];                         // "1 run covers 11 weeks; shelf-life 90d permits"
  unmetDemand: { week: string; qty: number }[];
  interRunDays: number[];                      // gaps between consecutive runs, for telemetry
}
```

**Objective: minimise total cost.** Cost terms (start simple, add as needed):
- `+ changeoverHours × num_batches` — set high enough that the optimiser naturally clusters demand into fewer, longer-spaced runs
- `+ storage_overflow_penalty` — per-day, per-unit over the warehouse cap
- `+ shelf_life_violation_penalty` — large; effectively a hard constraint
- `– price_break_savings` — negative cost = reward; pulls in driven-PO discounts
- (later) `+ peak_storage_penalty` if smoothing becomes necessary

**Hard constraints**: shelf-life ceiling, vessel min/max, daily storage cap, demand coverage by required date.

**Tuning the "don't repeat for 3 months" behaviour.** The user's goal — single runs covering ≈3 months of demand for long-shelf-life SKUs — emerges from the cost function, not from a hard rule. The lever is `changeoverHours`. If two runs cost less than one big run + storage holding, the optimiser will pick two; if one big run is cheaper, it picks one. Per-product changeover cost lets short-shelf-life SKUs stay frequent without penalty.

**Algorithm**: dynamic programming over the daily grid. State = `(day, inventory)`. Start with a greedy seed, then local-search swaps.

**Acceptance**
- Two adjacent small demands collapse into one batch when changeover savings > storage cost
- Output batches never violate shelf life or vessel capacity
- A long-shelf-life SKU with realistic changeover cost plans 1–2 runs across 12 weeks (rather than weekly)
- Property test: total batch volume ≥ total demand (no shortfall unless `unmetDemand` reports it)
- `interRunDays` reported for every SKU so the UI can flag SKUs touched more often than expected

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

## Still open

- **Horizon length** — confirmed 12 weeks (3 months), but user noted longer planning is preferable. Worth revisiting after Phase 3 lands: does the optimiser stay tractable at 26 weeks? If yes, extend default. If not, surface as a per-run setting.
