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

**Objective (in priority order)**
1. **Minimise number of runs over the horizon** — primary goal. Equivalently, maximise minimum inter-run gap. This is what "don't repeat for 3 months" means.
2. Subject to hard constraints: shelf-life, vessel capacity, per-day storage cap, demand coverage by required date.
3. Among feasible plans with equal run count, prefer:
   - Larger price-break captures on driven POs (negative cost)
   - Lower changeover cost (fewer adjacent kitchen-production switches)
   - Lower peak storage occupancy

**Algorithm**: dynamic programming over the daily grid. State = `(day, inventory, days_since_last_run)`. Start with greedy "make max batch every shelf-life days," then local-search to compress runs further where storage permits.

**Acceptance**
- A long-shelf-life SKU (e.g. `shelfLifeDays: 90`, low storage footprint) plans **one** run covering the full 12 weeks
- A short-shelf-life SKU (e.g. `shelfLifeDays: 14`) plans the minimum runs that respect the shelf-life ceiling
- A storage-constrained SKU plans more runs than shelf-life would require, with `rationale` citing storage cap
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
   - **Optimiser objective (Phase 3):** primary cost-function term is **number of runs over the horizon** (minimise) — equivalently, **inter-run interval** (maximise). Constraints that override this:
     - Shelf-life: can't make more than `shelfLifeDays` of demand in one run
     - Storage capacity: per-warehouse, per-day cap on inventory
     - Vessel/line capacity: physical max per single run
     - Demand timing: can't run *after* the demand week it's meant to cover

   Emergent behaviour: long-shelf-life, low-storage-footprint SKUs collapse to 1 run per 3 months. Short-shelf-life SKUs (e.g. fresh items, if any) stay weekly. The optimiser surfaces *why* in its `rationale[]` output ("3 runs needed: shelf-life 30d caps coverage").

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
