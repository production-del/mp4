# Byron Planner — Codebase Audit

**Date:** 2026-05-29
**Subject:** `masterv4-planner` (the live codebase)
**Purpose:** Decide whether the "spaghetti" worry is justified, and produce the basis for a
cleaner rebuild (**mp5**). Companion document: [`MP5-REBUILD-PROMPT.md`](./MP5-REBUILD-PROMPT.md).
**Method:** three parallel exploration passes (architecture / complexity / clean-parts + domain
rules), then direct source verification of the highest-risk rules.

---

## TL;DR — the verdict

The worry is **half-right**. This is not a uniformly tangled codebase. It is two halves:

| Half | State | Verdict |
|---|---|---|
| **The core** — `src/lib/engine/`, `packages/planning-primitives/`, `src/lib/planning/` stores + types, `src/lib/unleashed/`, and the 35-file test suite | Clean, pure, well-typed, well-tested. A deliberate "ontology-first refactor" (the repo's Phase 6) already consolidated state and tightened types here. | **Preserve verbatim.** |
| **The UI/calendar layer** — `src/app/calendar/CalendarApp.tsx` and the per-feature mega-hooks | Genuinely tangled. An **8,740-line** god-component, a **40-prop** interface, **~104 hook calls**, a **1,575-line `ActivityDrawer`** in the same file, prop-drilling, scattered utilities. Grew by accretion — one bolt-on per phase. | **Rebuild.** |

**The refactor that cleaned the lib layer never reached the calendar UI.** That's the whole story.

So: don't start from a blank slate (that throws away the clean, tested core and forces every
hard-won edge case to be re-derived). **Keep the core, rebuild the UI** — driven by the domain
spec catalogued below.

---

## 1. The clean core — PRESERVE

### 1.1 `packages/planning-primitives/` — reference-quality
A self-contained workspace package (19 tests, no runtime deps): branded join-key types, a generic
`createVersionedStore<T>()` (with the session-guarded one-shot-migration trick), `working-day`
time helpers, and `wire` contracts (`LocalISODate`, `WireSafe<T>`, `WireAdapter`). This is the
design template for everything else.

### 1.2 `src/lib/engine/` — pure, deterministic, portable
~22 modules of data-in/data-out planning logic — no I/O, no React, no `Date.now()`. BOM explosion,
batch optimiser, conflict resolver, kitchen-gap simulation, projections, transfer detection,
supply allocation. Designed for a possible Python/FastAPI port (see `serialization.ts` wire round-trips).

### 1.3 The state/type layer in `src/lib/planning/`
The "ontology-first refactor" already did the hard cleanup here:
- **One** versioned localStorage store (`plan-draft-store.ts`) replacing 5 legacy per-feature keys.
- **One** discriminated-union plan type (`plan-item.ts`): `KitchenRunItem | PackagingRunItem | PurchaseOrderItem | TransferItem`.
- A unified `demand.ts` contract, `calendar-mutations.ts` (stable-ID-keyed user overrides),
  `plan-store-sync.ts` (debounced localStorage→Postgres sync), `warehouse-soh.ts` (one class
  wrapping Unleashed SOH quirks), and a clean type contract in `engine-io.ts`.

### 1.4 The test suite — the behaviour contract
**35 test files** (~11.5k LOC), one per engine module plus an end-to-end integration test. Several
(e.g. `changeover.test.ts`) deliberately **lock** numeric behaviour so a spreadsheet edit can't
silently change the optimiser. This suite *is* the encoded domain knowledge — it must survive into mp5.

### 1.5 Design philosophy is already written down
`docs/INTEGRATION-BRIEF.md` codifies six principles from the refactor — they are the rules mp5
should be built to:
1. Unleashed is an adapter at the edge, not the core model.
2. Canonical inputs, not derived ones (demand from CSV, not from history).
3. One type per concept; discriminated unions for variants.
4. Dates at the boundaries, **local ISO strings** in the middle (never `toISOString()` on business dates).
5. Pure engines, thin hooks.
6. One-shot migrations, clean breaks (no forever-compat layers).

…plus an explicit "anti-patterns we learned the hard way" list (multiple localStorage keys,
Unleashed shapes leaking into UI, `toISOString()`, `any`-typed calendars, duplicated dialogs,
compat layers). The calendar UI violates several of these — which is exactly the rebuild target.

---

## 2. The tangle — REBUILD

### 2.1 `src/app/calendar/CalendarApp.tsx` — the god-component
| Metric | Value |
|---|---|
| Total lines | **8,740** |
| Fields on the `CalendarAppProps` interface | **40** (the interface is ~113 *lines* long — the prop *count* is 40, not the 113 first reported) |
| Hook calls (`useState`/`useEffect`/`useMemo`/…), file-wide | **~104** |
| `ActivityDrawer` — a **top-level** component in the *same file* (lines 6025–7599) | **~1,575 lines**, ~40 props |
| `MonthBlock` / `ActivityChip` — also top-level, same file | ~668 / ~579 lines |

It has become a **facade for the entire planning domain** rather than a UI layer. The right drawer
alone stacks **~18 sections**, each tagged with the phase that added it (`4f`, `4h.3`, `4l.2`…`4l.13`,
`4m.1`, `4m.4`): reschedule, edit-quantity, station selector, dismiss, SOH, cluster picker, related
chips, PO details, profit, supply-capped, label-blocked, lead-time, conflicts, committed orders,
overrides. The left rail is a deep manual toggle-tree; chips stack 5+ visual overlay layers.

### 2.2 `src/app/calendar/page.tsx` — 3,813-line server orchestrator
Runs the whole pipeline inline (inside one `buildPayload()` helper: forecast → capacity load →
orchestrate → assign → project → kitchen runs → raw-material). *(Transfers are imported but **not**
wired — Phase 4i.2 is stubbed — so no transfer stage is actually computed here.)* Should be extracted
into a reusable, testable `runPlanningPipeline()` returning one typed view model.

### 2.3 Parallel mega-hooks
`useKitchenPlanner` (736 lines, 23-property return; `src/app/kitchen/hooks/`) and `usePackagingPlanner`
(694 lines, 19-property return; `src/app/packaging/hooks/`) mirror each other, use no shared context,
and force heavy prop-drilling into their pages. Other large UI files:
`logistics/page.tsx` (1,164), `ComponentModal.tsx` (1,352), `PackagingCalendar.tsx` (1,132),
`ComponentTable.tsx` (1,107).

### 2.4 Smaller, concrete debt (verified)
- **`working-day` duplication has already drifted.** `packages/planning-primitives/src/working-day.ts`
  says "keep the two files in lockstep," but `src/lib/planning/working-day.ts` has since grown
  `isWorkday`/`previousWorkday`/`nextWorkday` that the package copy lacks. Two sources of truth,
  silently diverging. → mp5 adopts the package as the single source — which means **porting those three helpers into the package** (it is the copy that *lacks* them), not just deleting the planning file.
- **Scattered utilities.** Date formatting (`fromISO`/`toISO`/`addDaysIso`/`fmt*`) is re-defined as
  local helpers inside `CalendarApp.tsx` (`fromISO`/`toISO`/`addDaysIso` at lines ~578–592 — even though
  the file also *imports* `toLocalISODate`); SOH-access logic recurs across **~12 files (~44 call-sites)**.
  → one `dates` module, one SOH service.
- **5 legacy localStorage migrations still active** in `plan-draft-store.ts`. The repo's own
  principle is "one-shot migration, then delete." mp5 starts clean — no migration code at all.
- **Inline styles everywhere** (CSS-var based) — fine, but a design-token pass would help the eventual UX refresh.

---

## 3. Domain-rules catalog — the invariants mp5 MUST preserve

These are the hard-won, edge-case fixes. Each was a production bug once; a blank-slate rewrite
would lose them. **The authoritative form of each rule is its test** — this table is the checklist,
the tests are the contract. Rows marked ✔ were verified directly against source during this audit (this pass re-verified rows 1–8 and 11–19 and corrected file/line refs that had drifted — see the Verification log in §8).

| # | Rule | Where | Test |
|---|---|---|---|
| 1 | **Changeover = `max` of applicable costs, never sum.** Differing/`null` `extendedFamily` → `fullClean`; else `max(extendedFamily?, sizeSwitch?, familySameSize?)`; same `productCode` → 0. ✔ | `engine/changeover.ts` | `changeover.test.ts` (locks the 4×4 matrix) |
| 2 | **108 SKUs have no extended family** → switching into/out of them = `fullClean`. `fullClean` is *never* triggered within a family/extended-family. ✔ | `changeover.ts`, `capacity-data.ts` | `changeover.test.ts`; count locked by `capacity-data.test.ts` (`toHaveLength(108)`) |
| 3 | **Phantom-demand:** on a shared date, **supplies are credited before demands** (a PO arriving day-X covers day-X consumption). Don't emit zero-qty "phantom" POs when later in-horizon supply covers the deficit. ✔ | `raw-material-demand.ts:258` (supply-before-demand sort) + `:336` (phantom-PO suppression, in `derivePurchaseRequirements`) | `raw-material-demand.test.ts` |
| 4 | **Kitchen-gap coalescing:** emit one gap per `consumptionWindowDays` (runtime default **1** = JIT — note the param's JSDoc and the `kitchen-run-planner` caller still say "5", a stale-doc bug to fix) instead of one horizon-wide gap; credit `ceil((deficit/yield)/batch) × batch × yield` back to the running balance (yield uplift *before* the batch-ceil) so recipe-batch overproduction reduces future gaps. ✔ | `engine/kitchen-gap.ts:329–335` (Phase 4l.12) | `kitchen-gap.test.ts` |
| 5 | **Status gating:** only `Parked` assemblies are movable on the calendar. `blockReschedule = !!assemblyNumber && assemblyStatus !== 'Parked'`. Qty/station edits still apply to committed ones. ✔ | `planning/calendar-mutations.ts:452` (Phase 4l.14) | `calendar-mutations.test.ts` |
| 6 | **Stale-reschedule neutralisation:** a `rescheduledTo` on a now-committed assembly is ignored (also clears stale auto-resolve artifacts); unknown `stableId`s are soft warnings, not errors. ✔ | `calendar-mutations.ts` | `calendar-mutations.test.ts` |
| 7 | **Local-ISO date keying:** persisted dates are `YYYY-MM-DD` local strings; `Date` only in memory. Never `toISOString()` on business dates (shifts AU dates back a day). ✔ | `planning/working-day.ts`, `planning-primitives/working-day.ts` | `working-day.test.ts` |
| 8 | **Working-day integer scheme:** 1–5 = Mon–Fri this week, 6–10 next week…; mapping is relative to current Monday so the schedule auto-advances. Weekend clamp configurable (`'down'`=prev Fri default, `'up'`=next Mon for deadlines). ✔ | `working-day.ts` | `working-day.test.ts` |
| 9 | **SOH is per-warehouse with a global fallback** (`atWarehouse`/`globalOnHand`/`perProduct`). | `planning/warehouse-soh.ts` | — (no dedicated test; core reads exercised via `transfer-detection.test.ts`) |
| 10 | **Today-floor:** overdue runs clamp forward onto today (if ideal start < today → start = today / next workday) rather than starting in the past. The **engine** clamp is *not* capacity-aware; a capacity-aware forward-walk exists only in the **UI** layer. *See §6.* | `engine/kitchen-run-planner.ts:290–302`; UI walk in `page.tsx:1476/1831` | `kitchen-run-planner.test.ts` (`today-floor` describe) |
| 11 | **Yield-adjusted supply:** kitchen output = input × yield before crediting downstream demand. ✔ | `engine/kitchen-run-planner.ts:254–264`, `kitchen-gap.ts:332–335` | `kitchen-gap.test.ts` |
| 12 | **Supply-cap rationing:** when an intermediate is short, ration to packaging consumers in profit-per-unit descending order; remainder caps to zero (no double-count downstream). | `engine/supply-cap.ts` | `supply-cap.test.ts` |
| 13 | **FIFO allocation:** consumers walked in date order; suppliers drawn FIFO by finish-date (SOH first). ✔ *(The configurable source-**warehouse** ranking — non-Lundberg first — lives in `transfer-detection.ts`, not here.)* | `engine/supply-allocator.ts:134–164` | `supply-allocator.test.ts` |
| 14 | **Transfer-gap detection ("FIFO arrows"):** demand at a warehouse with no local stock but stock elsewhere → emit a transfer gap. | `engine/transfer-detection.ts` | `transfer-detection.test.ts` |
| 15 | **Intermediate boundary (double-count avoidance):** `bom-explode.ts` recurses *fully* to raw materials; the boundary is applied **downstream** — consumers take only depth-1 children and skip codes in the `intermediateCodes` set (each intermediate carries its own kitchen activity). That set is built from the capacity spreadsheet (`capacity.intermediates`, ~67 codes), **not** the 9-entry `INTERMEDIATE_REGISTRY` (a kitchen-UI data file at `src/app/kitchen/data/`). ✔ | `raw-material-demand.ts:184–185`, `intermediate-demand.ts:84–85`; set at `calendar/page.tsx:1043` | `intermediate-demand.test.ts`, `raw-material-demand.test.ts` |
| 16 | **Feasibility green/amber/red:** green = local stock; amber = short locally, available globally (transfer); red = globally short (PO). Worsening transitions emit grouped risk events. | `engine-io.ts`, `feasibility-diff.ts`, `risk-events.ts` | **`feasibility-diff.ts` has no test at all** — the only fully-untested engine module; mp5 must add coverage |
| 17 | **SOH-aware schedule conflicts** (running-balance mode, Phase 4l.3). | `engine/schedule-conflicts.ts` | `schedule-conflicts.test.ts` |
| 18 | **Conflict resolution strategies** push/pull/auto — monotone, bounded, capacity-walking. | `engine/resolve-conflicts.ts` | `resolve-conflicts.test.ts` (comprehensive) |
| 19 | **Warehouse assignment by product classification:** `warehouse-assignments.ts` maps intermediate→Lundberg, FG/label→MF Packaging, component→highest-SOH (else TBC). *(The **Bottlo→MF Operations** rule is separate — derived from the assembly's own warehouse in `transfer-detection.ts:44`, not here.)* | `planning/warehouse-assignments.ts`; `engine/transfer-detection.ts:44` | `warehouse-assignments.ts` **untested**; Bottlo rule via `transfer-detection.test.ts` |
| 20 | **Station routing + per-product overrides** (primary + alternates; hard overrides first; e.g. beetroot-powder rate override). | `engine/station-router.ts`, `product-overrides.ts` | `station-router.test.ts`, `product-overrides.test.ts` |
| 21 | **Dismissed-keys holdout, allowlists, adaptive batch sizing.** | `plan-draft-store.ts`, `finished-goods-allowlist.ts`, `kitchen-gap.ts` | `plan-draft-store`, `product-overrides` |

**Coverage gaps to fix in mp5 (verified):** `feasibility-diff.ts` (**no test at all** — the only fully-untested
engine module), `warehouse-soh.ts` and `warehouse-assignments.ts` (no dedicated tests; only indirectly
exercised), and the `src/lib/planning/` copy of `working-day.ts` (only the *package* copy is tested).
*Correction:* `schedule-conflicts` (24 tests / 655 LOC) and `calendar-mutations` (37 tests) are in fact
well-covered — the earlier "thin" label was wrong. mp5 should add the genuinely-missing coverage as it lifts these.

---

## 4. Target architecture for mp5 (the elegant solution)

**Preserve the core verbatim** (§1). Rebuild only presentation + state wiring.

1. **Extract the pipeline.** Move `calendar/page.tsx`'s inline pipeline into a pure
   `runPlanningPipeline(inputs) → CalendarViewModel` in `src/lib/planning/`. Testable in isolation;
   both agents flagged this independently.
2. **Decompose the screen** — every piece its own file:
   - `CalendarApp` → thin layout shell + providers.
   - `LeftRail` (filters/visibility, backed by a filter store — not 20 boolean props).
   - `CalendarGrid` → `WeekRow` → `DayCell` → `ActivityChip`, chip **overlays as composable layers**
     gated by a "detail level" (simple ↔ expert).
   - `ActivityDrawer` → a `<Drawer>` shell + **one component per section** (Reschedule, Quantity,
     Station, Dismiss, Soh, Conflicts, RelatedChips, Profit, Overrides, …). The single biggest win.
   - Side panels: `CapacityHeatmap`, `StockoutPanel`, `RawMaterialRiskPanel`, `FinishedGoodsPanel`.
3. **State via a few contexts/stores**, not a single 40-field props interface drilled everywhere:
   - `PlanDataContext` — read-only, server-computed view model.
   - `MutationsStore` — the *only* writer; wraps `calendar-mutations` + `plan-draft-store`.
   - `UiStateContext` — ephemeral (selection, drawer, filters, detail level).
4. **Shared utilities:** one `dates` module (adopt `planning-primitives`, retire the duplicate);
   one SOH service (behind `WarehouseSOH`); design tokens instead of ad-hoc inline styles.

---

## 5. Phase-2 UX-refresh backlog (captured now, do later on the clean base)

The decomposition above is the *prerequisite* for any of this — once it lands, each item is a
localized change instead of surgery on an 8,740-line file.

- **Light:** prioritise the drawer (primary actions top, diagnostics collapsed); replace the
  left-rail toggle-tree with saved views/presets; chip "detail level" toggle to cut overlay density.
- **Medium:** task-oriented modes ("Resolve conflicts", "Review stockouts", "Approve POs") over the
  same calendar; progressive disclosure; a real responsive/mobile layout.
- **Heavy:** rethink the metaphor (station/team swimlanes or timeline vs month-grid); inline editing
  or a command palette; full design-token system.

---

## 6. Known open issues to carry forward

From project history (preserve-or-fix in mp5 — do not silently lose or reintroduce):

- **Packaging assemblies entered manually in Unleashed** aren't factored into planning.
- **Family-sheet gaps** silently drop FG SKUs → orphan demand (IRPLOCO, MFMIXENB11/B5.5/XL, likely more).
- **Today-floor: the engine clamp is not capacity-aware.** `kitchen-run-planner.ts:290` clamps overdue
  runs onto today; a capacity-aware forward-walk *does* exist in the UI layer (`page.tsx:1476/1831`), but
  the engine fallback just stacks on today (see the FIXME at `calendar-projection.ts:187`). mp5 should
  make the engine-level today-floor walk forward through capacity.
- **Stockout-causing reschedule guard** (the `calendar-mutations.ts:435` BOOKMARK): a stale/edited
  reschedule can push a packaging run past the FG's SOH-floor breach → stockout (observed:
  MFBKCHOCBG ~7 weeks OOS, MFBKCHOCB9). Deferred; current remedy is "Clear all reschedules." mp5
  should implement the preferred fix: **flag** the chip (stockout-risk badge + drawer warning) rather
  than silently delaying.
- **Manually-entered packaging assemblies** and the **adaptive minBatchSize** edge cases.

---

## 7. Recommendation & next steps

1. **Build mp5 as a behaviour-preserving re-architecture** of the UI, keeping the core intact, using
   [`MP5-REBUILD-PROMPT.md`](./MP5-REBUILD-PROMPT.md) as the kickoff spec for a fresh session.
2. **Prove behaviour-preservation** two ways: keep the 35-file test suite green, and build a
   **golden-output parity harness** — capture this app's computed outputs (`CalendarActivity[]`,
   conflicts, demand, PO requirements) for a fixed input snapshot and assert mp5 reproduces them.
3. **Then** tackle the Phase-2 UX backlog deliberately, on the clean foundation.

The biggest lever for the rebuild is not a newer model — it's handing the next session this spec,
the design docs, and the test suite up front. That is what this audit produces.

---

## 8. Verification log (this pass)

The draft above was re-verified directly against current source. Quantitative and file/line claims were
checked by reading the code, not just re-reading the draft. Corrections made:

**Structural (the tangle):**
- `CalendarAppProps` has **40 fields**, not 113. (113 was the interface's *line span*; the member count
  is 40.) Corrected in the TL;DR and §2.1.
- `CalendarApp.tsx` = **8,740 lines** and `page.tsx` = **3,813 lines** — both confirmed exact.
- `ActivityDrawer` / `MonthBlock` / `ActivityChip` are **top-level** functions in the same file (not
  "defined inside the render"); `ActivityDrawer` spans lines 6025–7599 (~1,575 lines, ~40 props).
- Hook calls file-wide: **~104** (confirmed; ~102 was close).
- `useKitchenPlanner` returns **23** properties (not ~35); `usePackagingPlanner` returns 19.
- `page.tsx` does **not** compute a transfers stage — Phase 4i.2 is stubbed (imports kept, unused).
- SOH-access duplication spans **~12 files / ~44 call-sites** (not ~7).

**Domain rules (catalog §3):**
- **Row 3 (phantom-demand):** cited `:225` was a comment; real ordering is `raw-material-demand.ts:258`,
  phantom-PO suppression `:336` (in `derivePurchaseRequirements`). Behaviour confirmed, STRONG test.
- **Row 4 (kitchen-gap):** credit-back is `ceil((deficit/yield)/batch) × batch × yield` (yield uplift
  *before* the batch-ceil). Runtime default `consumptionWindowDays` is 1, but the JSDoc/caller still say
  "5" — a stale-doc inconsistency to fix in mp5.
- **Row 10 (today-floor):** lives in `kitchen-run-planner.ts:290–302`, not `capacity-data`/`kitchen-gap`.
  The "not capacity-aware" limit is real at the *engine* level only; the UI layer already has a walk.
- **Row 11 (yield):** corrected file refs (was the bad `intermediate-registry.ts` path).
- **Row 13 (FIFO):** `supply-allocator` ranks suppliers by FIFO finish-date; the source-*warehouse*
  ranking (non-Lundberg first) is in `transfer-detection.ts`.
- **Row 15 (intermediate boundary):** rewritten. `bom-explode.ts` recurses *fully*; the boundary is a
  downstream depth-1 skip against `intermediateCodes` (from the capacity spreadsheet, ~67 codes) — **not**
  "recursion stops at the 9-entry registry" (which is a kitchen-UI file).
- **Row 19 (warehouse assignment):** by **product classification**, not activity type; the Bottlo→MF
  Operations rule lives in `transfer-detection.ts:44`.

**Coverage (corrected):**
- `feasibility-diff.ts` has **no test at all** (the only fully-untested engine module) — was mislabelled "weak".
- `schedule-conflicts.test.ts` is substantial (24 tests / 655 LOC) — the "thin" label was wrong.
- `warehouse-soh.ts`, `warehouse-assignments.ts`, and the planning copy of `working-day.ts` have no
  dedicated tests (only indirect / package coverage).

**Confirmed accurate as drafted:** changeover max-not-sum + the 108-unmapped-SKU count (locked by
`capacity-data.test.ts`), supply-cap profit-first rationing, transfer-gap detection, status gating
(strictly binary `Parked` vs not — there is **no** "pull-to-move" tier in code), stale-reschedule
neutralisation, the `:435` BOOKMARK, local-ISO keying, the working-day integer scheme, and the
working-day duplication/drift (the package copy is the one missing `isWorkday`/`previousWorkday`/`nextWorkday`).
