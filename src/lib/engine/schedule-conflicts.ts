/**
 * Schedule-conflict detection — Phase 4l.2.
 *
 * Pure function. Given a list of CalendarActivity (with mutations already
 * applied — i.e. their CURRENT scheduled dates) and a consumes-map keyed
 * by productCode, find activities whose required ingredients aren't
 * scheduled to finish in time.
 *
 * Two modes:
 *
 *   1. Legacy mode (no `initialSohByCode`):
 *      Per-(consumer, ingredient): at least one supplier must finish
 *      strictly before the consumer's date. SOH is implicitly assumed
 *      to cover any consumer with no scheduled supplier at all.
 *      Quantities are not considered.
 *
 *   2. SOH-aware mode (`initialSohByCode` provided):
 *      Per-ingredient, walk a unified timeline of supply + demand events
 *      starting from initial SOH. Supply events credit SOH on their
 *      finish-date + 1 day (the buffer rule); demand events debit SOH on
 *      the consumer's date. A consumer is in conflict iff its debit takes
 *      running SOH below zero. This correctly handles partial coverage
 *      (some consumers covered by SOH, later ones not).
 *
 * Dismissed activities don't consume and don't supply in either mode.
 *
 * For a consumer with NO matching candidates at all in legacy mode, no
 * conflict is emitted. SOH-aware mode applies the same rule (consumer
 * with neither SOH nor scheduled supply silently drops out — no
 * candidate to point a "blocked by" at).
 */

import type { CalendarActivity } from '@/lib/planning/calendar-projection';

// ─── Public types ────────────────────────────────────────────

export interface ScheduleConflict {
  /** stableId of the activity whose ingredient isn't ready in time. */
  consumerStableId: string;
  consumerProductCode: string;
  consumerDate: string;
  /** stableId of the latest-finishing candidate ingredient activity. */
  blockedByStableId: string;
  /** What's needed. */
  ingredientCode: string;
  /** Earliest possible finish across all candidates (latest-finishing won't help; we point at the closest one). */
  earliestFinishDate: string;
  /** Human-readable. */
  reason: string;
}

export interface ConflictDetectionInput {
  activities: ReadonlyArray<CalendarActivity>;
  /** productCode → list of intermediate codes its BOM consumes (depth 1). */
  consumesMap: Record<string, string[]>;
  /** stableIds of dismissed activities — excluded from both consumer and supplier roles. */
  dismissedStableIds?: ReadonlySet<string>;

  // ─── SOH-aware mode (optional; opt-in via `initialSohByCode`) ───

  /**
   * Per-ingredient starting SOH. Presence of this field switches the
   * detector to SOH-aware mode. Codes missing from the map default to 0.
   */
  initialSohByCode?: Record<string, number>;

  /**
   * Per-unit ingredient consumption: consumer productCode → ingredient
   * code → qty consumed per unit of consumer. Used in SOH-aware mode to
   * compute each consumer's debit. Missing entries default to 1.
   */
  consumesQtyMap?: Record<string, Record<string, number>>;

  /**
   * Per-activity effective supply quantity, keyed by stableId. For
   * `kitchen-required` activities this is `quantity × yieldRate`; for
   * `po-receiving` it's the PO qty. Missing entries default to the
   * activity's `quantity` field.
   */
  supplyQtyByActivity?: Record<string, number>;
}

// ─── Public API ──────────────────────────────────────────────

export function detectScheduleConflicts(
  input: ConflictDetectionInput,
): ScheduleConflict[] {
  if (input.initialSohByCode !== undefined) {
    return detectSohAware(input);
  }
  return detectLegacy(input);
}

// ─── Legacy path ─────────────────────────────────────────────

function detectLegacy(input: ConflictDetectionInput): ScheduleConflict[] {
  const dismissed = input.dismissedStableIds ?? new Set<string>();

  // Index suppliers by productCode for O(1) lookup. Skip dismissed.
  // `po-placed` chips are NOT suppliers — they're action-moment markers
  // sharing the productCode of their `po-receiving` sister. The receiving
  // chip is the canonical delivery event.
  const suppliersByCode = new Map<string, CalendarActivity[]>();
  for (const a of input.activities) {
    if (dismissed.has(a.stableId)) continue;
    if (a.kind === 'po-placed') continue;
    let arr = suppliersByCode.get(a.productCode);
    if (!arr) {
      arr = [];
      suppliersByCode.set(a.productCode, arr);
    }
    arr.push(a);
  }

  const conflicts: ScheduleConflict[] = [];
  for (const consumer of input.activities) {
    if (dismissed.has(consumer.stableId)) continue;
    if (
      consumer.kind !== 'packaging' &&
      consumer.kind !== 'kitchen-required' &&
      consumer.kind !== 'kitchen'
    ) {
      continue; // PO chips and other non-consumer kinds skipped
    }
    const ingredients = input.consumesMap[consumer.productCode] ?? [];
    for (const ingredient of ingredients) {
      const candidates = suppliersByCode.get(ingredient);
      if (!candidates || candidates.length === 0) continue;
      // At least one candidate must finish strictly before consumer's date
      // (= 1-day buffer rule applied to YYYY-MM-DD comparison).
      const ok = candidates.some(
        (c) => finishDateOf(c) < consumer.date,
      );
      if (ok) continue;
      // No candidate satisfies the constraint. Point at the latest-finishing
      // (closest to satisfying) for diagnostic clarity.
      const closest = candidates.reduce((best, c) =>
        finishDateOf(c) > finishDateOf(best) ? c : best,
      );
      const finish = finishDateOf(closest);
      conflicts.push({
        consumerStableId: consumer.stableId,
        consumerProductCode: consumer.productCode,
        consumerDate: consumer.date,
        blockedByStableId: closest.stableId,
        ingredientCode: ingredient,
        earliestFinishDate: finish,
        reason: `${consumer.productCode} on ${consumer.date} needs ${ingredient} ready by ${consumer.date} (1-day buffer rule); closest run finishes ${finish}.`,
      });
    }
  }

  conflicts.sort(byConsumerDateThenCode);
  return conflicts;
}

// ─── SOH-aware path ──────────────────────────────────────────

interface TimelineEvent {
  /** Date the event takes effect. For supplies this is finishDate + 1 day. */
  effectiveDate: string;
  kind: 'supply' | 'demand';
  qty: number;
  /** The activity behind this event (consumer or supplier). */
  ref: CalendarActivity;
}

function detectSohAware(input: ConflictDetectionInput): ScheduleConflict[] {
  const dismissed = input.dismissedStableIds ?? new Set<string>();
  const initialSohByCode = input.initialSohByCode ?? {};
  const consumesQtyMap = input.consumesQtyMap ?? {};
  const supplyQtyByActivity = input.supplyQtyByActivity ?? {};

  // Collect every ingredient referenced as either a supply (productCode of
  // a non-dismissed, non-po-placed activity) or as a demand (in some
  // consumer's consumesMap entry).
  const allIngredients = new Set<string>();
  for (const a of input.activities) {
    if (dismissed.has(a.stableId)) continue;
    if (a.kind === 'po-placed') continue;
    allIngredients.add(a.productCode);
  }
  for (const codes of Object.values(input.consumesMap)) {
    for (const code of codes) allIngredients.add(code);
  }

  const conflicts: ScheduleConflict[] = [];

  for (const ingredient of allIngredients) {
    const events: TimelineEvent[] = [];

    // Demands: every consumer with `ingredient` in its consumesMap.
    for (const consumer of input.activities) {
      if (dismissed.has(consumer.stableId)) continue;
      if (
        consumer.kind !== 'packaging' &&
        consumer.kind !== 'kitchen-required' &&
        consumer.kind !== 'kitchen'
      ) {
        continue;
      }
      const ingredients = input.consumesMap[consumer.productCode];
      if (!ingredients || !ingredients.includes(ingredient)) continue;
      const qtyPerUnit = consumesQtyMap[consumer.productCode]?.[ingredient] ?? 1;
      const qty = qtyPerUnit * consumer.quantity;
      if (qty <= 0) continue;
      events.push({
        effectiveDate: consumer.date,
        kind: 'demand',
        qty,
        ref: consumer,
      });
    }

    if (events.length === 0) continue; // no consumer of this ingredient — nothing to flag

    // Supplies: every non-po-placed activity producing `ingredient`.
    for (const supplier of input.activities) {
      if (dismissed.has(supplier.stableId)) continue;
      if (supplier.kind === 'po-placed') continue;
      if (supplier.productCode !== ingredient) continue;
      // Effective availability = finishDate + 1 day (the 1-day buffer rule).
      const effectiveDate = isoAddDays(finishDateOf(supplier), 1);
      const qty =
        supplyQtyByActivity[supplier.stableId] ?? supplier.quantity ?? 0;
      if (qty <= 0) continue;
      events.push({
        effectiveDate,
        kind: 'supply',
        qty,
        ref: supplier,
      });
    }

    // Sort: by date asc, supplies before demands on the same date so
    // a supplier whose buffered availability lands exactly on the consumer's
    // date credits SOH first. (Buffer is already baked into supply's
    // effectiveDate, so this is harmless if no same-day overlap exists.)
    events.sort((a, b) => {
      if (a.effectiveDate !== b.effectiveDate) {
        return a.effectiveDate.localeCompare(b.effectiveDate);
      }
      if (a.kind !== b.kind) return a.kind === 'supply' ? -1 : 1;
      return 0;
    });

    let soh = initialSohByCode[ingredient] ?? 0;
    let lastSupplyRef: CalendarActivity | null = null;

    for (const ev of events) {
      if (ev.kind === 'supply') {
        soh += ev.qty;
        lastSupplyRef = ev.ref;
        continue;
      }
      // demand
      soh -= ev.qty;
      if (soh < 0) {
        const blocker = lastSupplyRef ?? findClosestLateSupplier(
          input.activities,
          dismissed,
          ingredient,
          ev.ref.date,
        );
        if (!blocker) {
          // No SOH, no scheduled supply. In legacy mode we'd stay silent
          // here ("absence may be legitimate"); to preserve that semantics
          // we also skip when there's no scheduled supply at all for this
          // ingredient.
          continue;
        }
        const finish = finishDateOf(blocker);
        conflicts.push({
          consumerStableId: ev.ref.stableId,
          consumerProductCode: ev.ref.productCode,
          consumerDate: ev.ref.date,
          blockedByStableId: blocker.stableId,
          ingredientCode: ingredient,
          earliestFinishDate: finish,
          reason: `${ev.ref.productCode} on ${ev.ref.date} needs ${ingredient} ready by ${ev.ref.date} (1-day buffer rule); closest run finishes ${finish}.`,
        });
      }
    }
  }

  conflicts.sort(byConsumerDateThenCode);
  return conflicts;
}

// ─── Internals ───────────────────────────────────────────────

function finishDateOf(a: CalendarActivity): string {
  // kitchen-required activities carry an explicit finishDate; everything
  // else is treated as same-day production (finishDate === date).
  return a.finishDate ?? a.date;
}

function findClosestLateSupplier(
  activities: ReadonlyArray<CalendarActivity>,
  dismissed: ReadonlySet<string>,
  ingredient: string,
  consumerDate: string,
): CalendarActivity | null {
  let best: CalendarActivity | null = null;
  for (const a of activities) {
    if (dismissed.has(a.stableId)) continue;
    if (a.kind === 'po-placed') continue;
    if (a.productCode !== ingredient) continue;
    if (finishDateOf(a) < consumerDate) continue; // already in time → not a blocker
    if (!best || finishDateOf(a) > finishDateOf(best)) best = a;
  }
  return best;
}

function byConsumerDateThenCode(a: ScheduleConflict, b: ScheduleConflict) {
  if (a.consumerDate !== b.consumerDate) {
    return a.consumerDate.localeCompare(b.consumerDate);
  }
  return a.consumerProductCode.localeCompare(b.consumerProductCode);
}

function isoAddDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}
