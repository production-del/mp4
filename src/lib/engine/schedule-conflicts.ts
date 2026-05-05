/**
 * Schedule-conflict detection — Phase 4l.2.
 *
 * Pure function. Given a list of CalendarActivity (with mutations already
 * applied — i.e. their CURRENT scheduled dates) and a consumes-map keyed
 * by productCode, find activities whose required ingredients aren't
 * scheduled to finish in time.
 *
 * Constraint per "finish ≥ 1 day before use" rule:
 *   For consumer C that needs ingredient I:
 *     ∃ activity A with productCode=I and A.finishDate < C.date
 *   → at least one A satisfies this.
 *   Otherwise: ScheduleConflict emitted.
 *
 * What's a consumer:
 *   - packaging activities (consume intermediates per their BOM)
 *   - kitchen-required activities (sub-intermediate consumption)
 * What's a candidate supplier of an ingredient:
 *   - any activity whose productCode matches the ingredient code
 *     (live kitchen, kitchen-required, or even packaging if its output
 *     happens to be an intermediate, though that's atypical)
 *
 * Dismissed activities don't consume and don't supply.
 *
 * For a consumer with NO matching candidates at all, no conflict is
 * emitted — the absence may be legitimate (existing SOH covers the
 * demand). Only emit when candidates exist but are too late.
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
}

// ─── Public API ──────────────────────────────────────────────

export function detectScheduleConflicts(
  input: ConflictDetectionInput,
): ScheduleConflict[] {
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
      consumer.kind !== 'kitchen-required'
    ) {
      continue; // live kitchen activities are not consumers in our model
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

  // Stable order: by consumer date, then consumer code.
  conflicts.sort((a, b) => {
    if (a.consumerDate !== b.consumerDate) {
      return a.consumerDate.localeCompare(b.consumerDate);
    }
    return a.consumerProductCode.localeCompare(b.consumerProductCode);
  });

  return conflicts;
}

// ─── Internals ───────────────────────────────────────────────

function finishDateOf(a: CalendarActivity): string {
  // kitchen-required activities carry an explicit finishDate; everything
  // else is treated as same-day production (finishDate === date).
  return a.finishDate ?? a.date;
}
