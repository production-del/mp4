/**
 * Changeover cost — Phase 3a of the 3-month planner.
 *
 * Pure: `costToSwitch(prev, curr, station)` returns the minutes lost when
 * switching from one product to another on a given packaging station. The
 * optimiser uses this as its `changeoverHours` cost-function term, which is
 * the primary lever that drives family-clustered scheduling on Bottlo.
 *
 * Locked rules (see `docs/CAPACITY-DATA.md`)
 * ──────────────────────────────────────────
 * - **Decision #1.** If either product's `extendedFamily` is `null`, OR the
 *   two extended families differ, the cost is `fullClean`. Same extended
 *   family always falls through to the cheaper branches.
 * - **Decision #2.** Cost is the **maximum** of the applicable individual
 *   costs, never the sum. A size switch is considered to include the
 *   cleaning needed for an extended-family switch.
 * - Switching to the same product code costs 0 (idle continuation).
 *
 * Default matrix (`DEFAULT_CHANGEOVER_MATRIX`) is the 4×4 numeric block from
 * the `Packaging Line Capacity` sheet. Tests in `changeover.test.ts` lock
 * those numbers down so a future spreadsheet edit can't silently change
 * optimiser behaviour without updating the test fixture too.
 */

import type {
  ChangeoverCostMatrix,
  ProductMeta,
  Station,
} from '@/lib/planning/engine-io';

/**
 * Narrow structural type — the only fields `costToSwitch` actually reads.
 * Lets callers (e.g. the calendar's mutated-changeover recompute) pass
 * chip-shaped objects without needing full `ProductMeta`.
 */
export type ChangeoverProduct = Pick<
  ProductMeta,
  'productCode' | 'family' | 'extendedFamily' | 'packageSize'
>;

/**
 * Numbers from `data/kitchen capacity and family plans.xlsx` →
 * `Packaging Line Capacity` sheet, rows 4–7. Unit: minutes.
 *
 * | Station       | Size switch | Family same-size | Extended family | Full clean |
 * |---------------|-------------|------------------|-----------------|------------|
 * | hand-packing  | 2           | 2                | 2               | 5          |
 * | elephant      | 2           | 5                | 5               | 15         |
 * | dust          | 5           | 5                | 10              | 20         |
 * | bottlo        | 40          | 10               | 15              | 120        |
 *
 * Bottlo's gradient (10 → 15 → 40 → 120) is what makes family-clustering
 * emerge from optimisation; hand-packing's near-flat numbers (2/2/2/5) mean
 * family ordering barely matters there.
 */
export const DEFAULT_CHANGEOVER_MATRIX: ChangeoverCostMatrix = {
  'hand-packing': { sizeSwitch: 2, familySameSize: 2, extendedFamily: 2, fullClean: 5 },
  elephant: { sizeSwitch: 2, familySameSize: 5, extendedFamily: 5, fullClean: 15 },
  dust: { sizeSwitch: 5, familySameSize: 5, extendedFamily: 10, fullClean: 20 },
  bottlo: { sizeSwitch: 40, familySameSize: 10, extendedFamily: 15, fullClean: 120 },
};

/**
 * Cost (minutes) of switching from `prev` to `curr` on `station`, per the
 * locked decisions. Returns 0 for `prev.productCode === curr.productCode`
 * (no real changeover).
 *
 * Pass `prev = null` for the first batch on a station — there's no previous
 * product to switch from, so cost is 0.
 */
export function costToSwitch(
  prev: ChangeoverProduct | null,
  curr: ChangeoverProduct,
  station: Station,
  matrix: ChangeoverCostMatrix = DEFAULT_CHANGEOVER_MATRIX,
): number {
  if (prev === null) return 0;
  if (prev.productCode === curr.productCode) return 0;

  const m = matrix[station];

  // Decision #1: missing extended family on either side, or different extended
  // families → full clean. Same extended family always reaches the cheaper
  // branch below, even if other things differ.
  if (
    prev.extendedFamily === null ||
    curr.extendedFamily === null ||
    prev.extendedFamily !== curr.extendedFamily
  ) {
    return m.fullClean;
  }

  // From here, same extended family is guaranteed. Apply the
  // non-cumulative-max rule (decision #2).
  const candidates: number[] = [];
  if (prev.family !== curr.family) candidates.push(m.extendedFamily);
  if (prev.packageSize !== curr.packageSize) candidates.push(m.sizeSwitch);
  if (
    prev.family === curr.family &&
    prev.packageSize === curr.packageSize
  ) {
    // Same family AND same size, but products differ (we already returned 0
    // above for identical productCode). Different label / strip variant.
    candidates.push(m.familySameSize);
  }

  // Defensive fallback: if we end up with no candidates (shouldn't happen
  // given the productCode equality short-circuit above), return 0 rather
  // than NaN from Math.max() of an empty list.
  return candidates.length === 0 ? 0 : Math.max(...candidates);
}
