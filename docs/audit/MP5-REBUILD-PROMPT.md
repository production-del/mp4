# mp5 — Rebuild Prompt

> Hand this file to a fresh Claude Code session opened in an empty `mp5/` directory, sitting
> beside the existing repo (so `../masterv4-planner` is the read-only reference implementation).
> Paste the whole file as the opening message, or say: *"Read `MP5-REBUILD-PROMPT.md` and begin."*

---

## Your mission

Rebuild **Byron Planner** as **mp5** — same behaviour, clean architecture. The current app
(`../masterv4-planner`) works and is well-tested at its core, but its calendar UI has grown into an
8,740-line god-component. You are doing a **behaviour-preserving re-architecture**: keep the proven
core verbatim, rebuild the tangled presentation/state layer cleanly.

**This is not a from-scratch rewrite.** The hard value — a tested planning engine and dozens of
hard-won domain edge-cases — already exists and must be preserved exactly. Re-deriving it would
reintroduce real production bugs.

Before writing code, read these in order:
1. `../masterv4-planner/docs/audit/AUDIT.md` — the full audit (what's clean, what's tangled, why).
2. `../masterv4-planner/docs/INTEGRATION-BRIEF.md` — the design philosophy (six principles + anti-patterns).
3. `../masterv4-planner/docs/CAPACITY-DATA.md` — data semantics and the locked changeover rules.
4. `../masterv4-planner/docs/ROADMAP-3MONTH-PLANNER.md` — phase history / how the pipeline is staged.

---

## What Byron Planner is

A Next.js 15 / TypeScript production-planning tool for a single operator at a food manufacturer.
It plans a 4-phase pipeline — **FG demand → Kitchen → Purchasing → Execution** — against forecast
demand, stock-on-hand (SOH), and equipment capacity, and presents a drag-and-drop scheduling
calendar.

- **Unleashed** (ERP) is the source of truth for Products, Warehouses, SOH, Assemblies, Purchase
  Orders. The app reads it (HMAC-auth proxy), adds planning concepts Unleashed lacks (demand over
  time, feasibility, batch scheduling, warehouse assignment), and pushes confirmed plans back as
  Assemblies/POs.
- **Kitchen** produces *intermediates*; **Packaging** turns intermediates into finished goods on
  four stations (hand-packing, elephant, dust, bottlo). Changeover cost between products on a
  station is the main scheduling lever.
- Persistence is local-first: localStorage for instant reads, debounced sync to Postgres (Neon),
  optional (degrades gracefully when `DATABASE_URL` is absent).

---

## Prime directive: keep the core, rebuild the UI

### Copy VERBATIM from `../masterv4-planner` (the proven core — do not rewrite)
- `packages/planning-primitives/**` — types, `versioned-store`, `working-day`, `wire`.
- `src/lib/engine/**` — all ~22 pure planning modules + `index.ts`.
- `src/lib/planning/**` — the stores, types, and domain logic (`plan-item.ts`,
  `plan-draft-store.ts`, `calendar-mutations.ts`, `demand.ts`, `plan-store-sync.ts`,
  `engine-io.ts`, `warehouse-soh.ts`, `capacity-data.ts`, `calendar-projection.ts`,
  `forecast-demand.ts`, projections, caches, `push-tasks.ts`, `assembly-meta.ts`,
  `warehouse-assignments.ts`, `finished-goods-allowlist.ts`, `product-overrides.ts`, etc.).
- `src/lib/unleashed/**` and `src/lib/db/**` — ERP client/auth/proxy and Postgres store.
- `src/__tests__/**` — **the entire test suite. This is your behaviour contract.**
- `data/**` — capacity spreadsheet, product overrides/profit JSON, demand CSV.
- Config: `package.json` (deps), `tsconfig.json`, `next.config.ts`, `jest.config.js`,
  `postcss.config.mjs`, workspace setup.

**One cleanup while copying:** the `working-day` module is duplicated and has drifted — the
`src/lib/planning/` copy has `isWorkday`/`previousWorkday`/`nextWorkday` the package lacks.
**Consolidate:** make `packages/planning-primitives/working-day.ts` the single source (port the
three extra helpers into it), and have `src/lib/planning/working-day.ts` re-export from the package.

### Port NEAR-VERBATIM (thin server glue — light touch)
- `src/app/api/**` — they're thin proxies/handlers; copy and adjust imports.
- `layout.tsx`, auth (NextAuth), theme provider/toggle, nav.

### REBUILD CLEAN (the tangle)
- `src/app/calendar/**` — `CalendarApp.tsx` (8,740 lines) and `page.tsx` (3,813 lines).
- The per-feature mega-hooks (`useKitchenPlanner` 736, `usePackagingPlanner` 694) and the large
  page components (`logistics`, `purchasing`, `packaging`, `kitchen`) — decompose as you port them.

---

## Non-negotiable design rules

From `INTEGRATION-BRIEF.md` — build to these from line one:
1. **Unleashed is an adapter at the edge.** ERP PascalCase shapes never reach UI code.
2. **Canonical inputs, not derived** (demand from CSV, never from past assemblies).
3. **One type per concept; discriminated unions for variants.** (`PlanItem` is the model.)
4. **Dates at boundaries, local ISO in the middle.** Never `toISOString()` on a business date —
   use `toLocalISODate`/`fromLocalISODate`. (AU timezone; UTC shifts dates back a day.)
5. **Pure engines, thin hooks.** No business math inside components/hooks — call the engine.
6. **One-shot migrations, clean breaks.** mp5 is a fresh store — **no legacy migration code at all**
   (drop the 5 migrations the old app still carries). Pick the current storage shapes and start there.

Plus, avoid the documented anti-patterns: multiple localStorage keys per concern, Unleashed shapes
in UI, `any`-typed calendars, duplicated dialogs/components, "for safety" compat layers.

---

## Target architecture (the UI you are building)

1. **Extract the pipeline.** Replace the inline logic in `calendar/page.tsx` with a pure
   `runPlanningPipeline(inputs): CalendarViewModel` in `src/lib/planning/`. One typed output object,
   unit-testable, no React.
2. **Decompose the screen** — each piece its own file:
   - `CalendarApp` → thin layout shell + context providers only.
   - `LeftRail` → filters/visibility, backed by a filter store (not ~20 boolean props).
   - `CalendarGrid` → `WeekRow` → `DayCell` → `ActivityChip`. Chip **overlays are composable layers**
     (shortage sparkline, inventory sparkline, SOH-floor line, status letter, FIFO arrows) gated by
     a **"detail level"** control (simple ↔ expert).
   - `ActivityDrawer` → a `<Drawer>` shell + **one component per section** (Reschedule, Quantity,
     Station, Dismiss, Soh, Conflicts, RelatedChips, Profit, SupplyCapped, LeadTime, Overrides,
     CommittedOrders, PoDetails). The current 18-sections-in-one 1,575-line component (a top-level function crammed into the same file) is the #1 thing to break up.
   - Side panels as components: `CapacityHeatmap`, `StockoutPanel`, `RawMaterialRiskPanel`,
     `FinishedGoodsPanel`.
3. **State model — a few contexts/stores, not a single 40-field props interface:**
   - `PlanDataContext` — read-only, the server-computed `CalendarViewModel`.
   - `MutationsStore` — the **only** writer; wraps the copied `calendar-mutations` + `plan-draft-store`.
   - `UiStateContext` — ephemeral UI (selection, drawer open, filters, detail level).
   Components subscribe to what they need; no drilling.
4. **Shared utilities:** one `dates` module (the consolidated `working-day`), one SOH service
   (behind `WarehouseSOH`), and design tokens instead of ad-hoc inline styles.

Keep the rebuild **behaviour-identical** — same screens, same data, same interactions. UX redesign
is an explicit *later* phase (see the audit's Phase-2 backlog); do not redesign now.

---

## Domain-rules catalog — invariants you MUST preserve

The **tests are the authoritative contract**; this is the checklist. Full table with file/test refs
is in `AUDIT.md §3`. The subtle ones that are easy to get wrong:

- **Changeover = `max` of applicable costs, never the sum.** Differing/`null` `extendedFamily` →
  `fullClean`; same extended family → `max(extendedFamily?, sizeSwitch?, familySameSize?)`; identical
  `productCode` → 0. (`engine/changeover.ts`; matrix locked by `changeover.test.ts`.)
- **Phantom-demand:** on a shared date, **supplies credit before demands** (a PO landing day-X covers
  day-X consumption); don't emit zero-qty phantom POs when later in-horizon supply covers the deficit.
- **Kitchen-gap coalescing:** one gap per `consumptionWindowDays` (runtime default 1 = JIT — but the
  param's JSDoc/caller still say "5"; fix that); credit `ceil((deficit/yield)/batch) × batch × yield`
  back to the running balance (yield uplift *before* the batch-ceil).
- **Status gating:** only `Parked` assemblies are movable; committed ones reject `rescheduledTo` but
  still accept qty/station edits. Stale reschedules on committed assemblies are neutralised.
- **Local-ISO date keying** + the **working-day integer scheme** (1–5 = this week, relative to
  current Monday, auto-advancing; weekend clamp `'down'` default / `'up'` for deadlines).
- SOH per-warehouse + global fallback; today-floor baseline; yield-adjusted supply; supply-cap
  profit-first rationing; FIFO allocation (supplier finish-date order); transfer-gap detection with a
  source-warehouse ranking (non-Lundberg first); the intermediate double-count boundary (full BOM
  explosion + a downstream depth-1 `intermediateCodes` skip — *not* "recursion stops at a registry");
  feasibility green/amber/red + grouped risk events; warehouse assignment by product class (+ the
  separate Bottlo→MF Operations rule); station routing + overrides.

---

## Verification (how you prove behaviour-preservation)

1. **Test suite green.** The copied `src/__tests__/**` must pass unchanged. If a test needs editing,
   stop and justify it — a changed test means changed behaviour.
2. **Golden-output parity harness.** The engine is copied verbatim, so the risk is in the *wiring*
   (`runPlanningPipeline`, projection, mutation application). Build a fixture: capture the current
   app's `runPlanningPipeline`-equivalent outputs (`CalendarActivity[]`, conflicts, demand, PO
   requirements) for a fixed input snapshot from `../masterv4-planner`, and assert mp5 reproduces them
   byte-for-byte. Add this as a test.
3. **Manual side-by-side** once the calendar renders: same chips, same colours, same drawer data, and
   the same results for drag/reschedule/dismiss/resolve-conflicts as the old app.
4. **Coverage gaps to close as you go (verified):** `feasibility-diff.ts` (**no test at all** — the only
   fully-untested engine module), `warehouse-soh.ts` + `warehouse-assignments.ts` (no dedicated tests), and
   the `src/lib/planning/working-day.ts` copy (only the package copy is tested). `schedule-conflicts`
   (24 tests) and `calendar-mutations` (37 tests) are already well-covered.

---

## Suggested build order

- **Phase 0 — Scaffold + lift the core.** New Next.js 15 app; copy `packages/`, `src/lib/`,
  `src/__tests__/`, `data/`, config; consolidate the `working-day` duplicate; **get the test suite
  green.** This alone proves the core survived.
- **Phase 1 — Pipeline.** Implement `runPlanningPipeline() → CalendarViewModel`; add the golden-parity test.
- **Phase 2 — Shell + state contexts** (PlanData / Mutations / UiState). Layout, nav, theme, auth. No features yet.
- **Phase 3 — Calendar grid + chips** (composable overlays + detail-level control). Behaviour-identical.
- **Phase 4 — Sectioned ActivityDrawer** (one component per section). The biggest decomposition win.
- **Phase 5 — Side panels + left rail.**
- **Phase 6 — Other routes** (kitchen, packaging, purchasing, purchase-orders, logistics, transfers,
  review, priorities, products, assemblies, settings, tasks), decomposing the mega-hooks the same way.
- **Phase 7 — Parity pass.** Reconcile any diffs vs `../masterv4-planner`; close coverage gaps.
- *(Phase 8 — UX refresh: a separate effort on the clean base. See `AUDIT.md §5`. Do not start here.)*

---

## Known open issues (preserve-or-fix; don't silently lose or reintroduce)

- Manually-entered packaging assemblies in Unleashed aren't factored into planning.
- Family-sheet gaps drop FG SKUs → orphan demand (IRPLOCO, MFMIXENB11/B5.5/XL, likely more).
- Today-floor is not capacity-aware (clamps onto today instead of walking forward through capacity).
- **Stockout-causing reschedule guard** (`calendar-mutations.ts` BOOKMARK): a stale/edited reschedule
  can delay a packaging run past the FG SOH-floor → stockout. Preferred fix in mp5: **flag** the chip
  (stockout-risk badge + drawer warning), don't silently delay.

---

## Definition of done (Phases 0–7)

- All copied tests pass; golden-parity test passes.
- The calendar renders and behaves identically to `../masterv4-planner` for a real dataset.
- No component over ~400 lines; no nested mega-functions; no prop list over ~15; state flows through
  the three contexts, not drilling.
- `working-day` has one source of truth; no legacy migration code; no `toISOString()` on business dates.
- Every domain rule in the catalog maps to a passing test (gaps from §"Verification" closed).
