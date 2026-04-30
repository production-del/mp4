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
  demand: WeeklyDemand[];           // 12 weeks
  vesselCapacity: number;           // kg/L per run
  minBatchSize: number;
  maxBatchSize: number;
  shelfLifeDays: number;
  changeoverHours: number;          // cost of switching to this product
  storageCapPerWeek: number;
}
export interface BatchOptimiserOutput {
  batches: ScheduledBatch[];
  rationale: string[];              // human-readable: "combined wks 2+3 to save 1 changeover"
  unmetDemand: { week: string; qty: number }[];
}
```

**Cost function (start simple, add terms)**
- `+ changeoverHours × num_batches`
- `+ storage_overflow_penalty`
- `+ shelf_life_violation_penalty` (large)
- `– price_break_savings` (negative cost = reward)

**Algorithm**: dynamic programming over the 12-week grid. Start with a greedy seed, then local-search swaps.

**Acceptance**
- Two adjacent small demands collapse into one batch when changeover savings > storage cost
- Output batches never violate shelf life or vessel capacity
- Property test: total batch volume ≥ total demand (no shortfall unless `unmetDemand` reports it)

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

## Open questions

1. **Re-plan trigger**: explicit button only, or auto on every Unleashed sync?
2. **Demand source over horizon**: extend `data/demand.csv` to weekly granularity, or accept monthly + interpolate?
3. **PO commitment semantics**: once "pushed", does the planner ever propose modifying it, or treat it as immutable?
4. **Capacity model**: weekly aggregate, or daily? Daily is more accurate but UI gets noisy.

Resolve these before Phase 3 starts.
