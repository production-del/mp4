/**
 * Day-assigner — Phase 3e of the 3-month planner.
 *
 * Takes the orchestrator's per-station, per-week ordered batches and slots
 * each into a specific working day (Mon–Fri) of its week, enforcing per-day
 * station-time capacity. Family-clustering carries forward: orchestrator
 * order is preserved, so same-family batches stay adjacent on the line even
 * when they spill across day boundaries.
 *
 * Why a separate post-pass (vs. redoing the DP at daily granularity)
 * ─────────────────────────────────────────────────────────────────
 * The per-product weekly DP decides *when to make a batch and how big*.
 * Day assignment decides *which day of that week the batch slots into* —
 * a within-week ordering problem, not a sizing problem. Bringing daily
 * granularity into the DP would multiply state by ~5 (Mon/Tue/.../Fri)
 * without changing batch quantities or week selection in any meaningful
 * way. Two cleanly separable passes win on cost AND clarity.
 *
 * Algorithm
 * ─────────
 * For each station, walk batches in chronological order (orchestrator
 * already sorted them by week, then by within-week reorder for family
 * clustering). For each week:
 *   1. **Profit-aware pre-trim (Phase 4l.9).** Sum production+changeover
 *      minutes across this week's batches and compare against the week's
 *      total available minutes (sum of days × per-day capacity). If we
 *      exceed, rank every batch by *profit per minute*
 *      (`profitPerItem × quantity / totalMinutes`) ascending and drop the
 *      lowest-value batches until the week fits. Drops are re-emitted as
 *      `week_overflow` warnings (the calendar surfaces them as overdue
 *      chips on today). Batches with `profitPerItem == null` rank at
 *      profit = 0 — missing-data SKUs are de-prioritised so the team is
 *      nudged to fill in `data/_profit-input.tsv`.
 *   2. Start at Monday with `dayUsed = 0`.
 *   3. For each surviving batch (orchestrator order preserved so family-
 *      clustering survives the trim): compute
 *      `total = production_minutes + changeover_minutes`.
 *      If `dayUsed + total ≤ capacity`, assign to current day, increment
 *      `dayUsed`. Else advance to next day, retry on a fresh capacity.
 *   4. If even a fresh day can't hold the batch (production > daily cap),
 *      emit `oversize_batch` warning and assign anyway with overrun
 *      reported in `usedMinutes > capacityMinutes`.
 *   5. If we run off Friday with batches remaining (per-day packing
 *      failure that survived the pre-trim — e.g. clustering forced a
 *      bad split), emit `week_overflow` warning; remaining batches are
 *      NOT assigned.
 *
 * Greedy by orchestrator-order preserves family-clustering across day
 * boundaries (the cheapest changeover stays adjacent), at the cost of
 * potentially leaving day capacity unused in front of a batch that
 * happens to be too big to follow. That's an acceptable tradeoff at
 * MVP — the orchestrator's reorder is the primary lever for changeover
 * cost; this pass is about feasibility against time-of-day capacity.
 */

import { fromLocalISODate, toLocalISODate } from '@/lib/planning/working-day';
import type { Station } from '@/lib/planning/engine-io';
import type {
  ScheduledBatchWithMeta,
  StationTimeline,
} from './optimiser-orchestrator';

// ─── Public types ────────────────────────────────────────────

/** YYYY-MM-DD (local) — a working day on which batches are scheduled. */
export type WorkingDay = string;

export interface ResourceCapacity {
  /** Working minutes available per day. Default 480 (8 hours). */
  minutesPerDay: number;
  /** Optional per-day overrides — holidays, half-days, etc. Keyed by YYYY-MM-DD. */
  perDayOverride?: Record<WorkingDay, number>;
}

export interface DayAssignerInput {
  /** Output of `orchestrateBatchPlan`. Day-assigner reads its `perStation` map. */
  perStation: Map<Station, StationTimeline>;
  /**
   * Per-station daily capacity. Stations omitted here use
   * `DEFAULT_STATION_CAPACITY_MINUTES_PER_DAY` (480 min = 8 hours).
   */
  stationCapacity?: Partial<Record<Station, ResourceCapacity>>;
  /**
   * Function returning the working days (YYYY-MM-DD) for a given week.
   * Default: Mon–Fri of `weekStart`, no holiday handling.
   */
  workingDaysOf?: (weekStart: string) => WorkingDay[];
}

export interface AssignedBatch extends ScheduledBatchWithMeta {
  scheduledDate: WorkingDay;
  durationMinutes: number;
  changeoverMinutes: number;
}

export interface DayLoad {
  batches: AssignedBatch[];
  usedMinutes: number;
  capacityMinutes: number;
}

export interface DailyStationTimeline {
  station: Station;
  /** Per-day load. Keys are YYYY-MM-DD; days without batches are absent. */
  byDay: Map<WorkingDay, DayLoad>;
}

export type DayAssignerWarning =
  | {
      kind: 'oversize_batch';
      station: Station;
      weekStart: string;
      scheduledDate: WorkingDay;
      productCode: string;
      durationMinutes: number;
      capacityMinutes: number;
      message: string;
    }
  | {
      kind: 'week_overflow';
      station: Station;
      weekStart: string;
      productCode: string;
      productName: string;
      quantity: number;
      durationMinutes: number;
      /**
       * Why the batch was dropped:
       *   'profit_trim'   — pre-trim chose to drop this batch because its
       *                     profit-per-minute was lowest among the week's
       *                     batches and the week was over capacity.
       *   'day_packing'   — survived the trim but ran off Friday during
       *                     per-day assignment (typically family-clustering
       *                     forced a split that couldn't fit).
       */
      reason: 'profit_trim' | 'day_packing';
      /** Total batch profit (AUD = profitPerItem × quantity). `null` when SKU has no profit data. */
      batchProfit: number | null;
      message: string;
    };

export interface DayAssignerOutput {
  perStation: Map<Station, DailyStationTimeline>;
  warnings: DayAssignerWarning[];
}

// ─── Defaults ────────────────────────────────────────────────

export const DEFAULT_STATION_CAPACITY_MINUTES_PER_DAY = 480; // 8 hours

const STATIONS_ALL: ReadonlyArray<Station> = [
  'hand-packing',
  'elephant',
  'dust',
  'bottlo',
];

/** Mon–Fri (working days) of the week starting at `weekStart` (a Monday ISO date). */
function defaultWorkingDaysOf(weekStart: string): WorkingDay[] {
  const monday = fromLocalISODate(weekStart);
  const days: WorkingDay[] = [];
  for (let i = 0; i < 5; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    days.push(toLocalISODate(d));
  }
  return days;
}

function capacityFor(
  cap: ResourceCapacity | undefined,
  day: WorkingDay,
): number {
  if (!cap) return DEFAULT_STATION_CAPACITY_MINUTES_PER_DAY;
  return cap.perDayOverride?.[day] ?? cap.minutesPerDay;
}

function productionMinutes(batch: ScheduledBatchWithMeta): number {
  const rate = batch.productMeta.rateUnitsPerHour;
  if (rate <= 0) return 0;
  return (batch.quantity / rate) * 60;
}

// ─── Public API ──────────────────────────────────────────────

export function assignBatchesToDays(
  input: DayAssignerInput,
): DayAssignerOutput {
  const workingDaysOf = input.workingDaysOf ?? defaultWorkingDaysOf;
  const perStationOut = new Map<Station, DailyStationTimeline>();
  const warnings: DayAssignerWarning[] = [];

  for (const station of STATIONS_ALL) {
    const timeline = input.perStation.get(station);
    const dailyTimeline: DailyStationTimeline = {
      station,
      byDay: new Map(),
    };
    perStationOut.set(station, dailyTimeline);
    if (!timeline || timeline.batches.length === 0) continue;

    const stationCap = input.stationCapacity?.[station];

    // Walk batches and changeovers in lockstep — the orchestrator guarantees
    // they're parallel arrays of equal length, sorted chronologically with
    // within-week family-clustering already applied.
    let i = 0;
    const N = timeline.batches.length;
    // Group iteration by week so we can reset the day cursor at week boundaries.
    while (i < N) {
      const weekStart = timeline.batches[i].weekStart;
      const days = workingDaysOf(weekStart);

      // ─── Collect this week's batches (indexes into timeline) ──
      const weekIdxs: number[] = [];
      let j = i;
      while (j < N && timeline.batches[j].weekStart === weekStart) {
        weekIdxs.push(j);
        j += 1;
      }

      // Helper: total minutes (production + changeover) for a batch at idx.
      const minutesAt = (idx: number): number => {
        const prodMin = productionMinutes(timeline.batches[idx]);
        const changeMin = timeline.changeovers[idx].costMinutes;
        return prodMin + changeMin;
      };

      // ─── Profit-aware pre-trim (Phase 4l.9) ───────────────────
      // If the week as a whole over-runs the sum of daily capacities, drop
      // batches in ascending order of profit-per-minute until we fit. This
      // pushes the optimiser to spend constrained packaging minutes on the
      // most-valuable demand (joint profit × quantity signal). Survivors
      // keep their orchestrator order so within-week family-clustering is
      // preserved among them.
      const weekCapacityTotal = days.reduce(
        (s, d) => s + capacityFor(stationCap, d),
        0,
      );
      let weekDemandTotal = weekIdxs.reduce((s, idx) => s + minutesAt(idx), 0);
      const droppedIdxs = new Set<number>();
      if (weekDemandTotal > weekCapacityTotal && weekIdxs.length > 0) {
        // Rank every batch by profit-per-minute ascending. Missing profit
        // data ranks at 0 → these get dropped first, which is the right
        // signal: the team needs to fill them in.
        const ranked = weekIdxs
          .map((idx) => {
            const b = timeline.batches[idx];
            const profitPer = b.productMeta.profitPerItem;
            const profit =
              typeof profitPer === 'number' && Number.isFinite(profitPer)
                ? profitPer
                : 0;
            const batchProfit = profit * b.quantity;
            const mins = minutesAt(idx);
            const profitPerMin = mins > 0 ? batchProfit / mins : 0;
            return { idx, mins, batchProfit, profitPerMin, hasProfit: profitPer !== null && profitPer !== undefined };
          })
          .sort((a, b) => {
            if (a.profitPerMin !== b.profitPerMin) {
              return a.profitPerMin - b.profitPerMin;
            }
            // Tiebreak: prefer to drop SKUs with no profit data (signals to
            // the team to fill them in) over priced SKUs at the same rate.
            if (a.hasProfit !== b.hasProfit) {
              return a.hasProfit ? 1 : -1;
            }
            // Final tiebreak: drop later-week-position batches first so
            // earlier ones (often family-cluster heads) stay.
            return b.idx - a.idx;
          });
        for (const entry of ranked) {
          if (weekDemandTotal <= weekCapacityTotal) break;
          droppedIdxs.add(entry.idx);
          weekDemandTotal -= entry.mins;
          const dropBatch = timeline.batches[entry.idx];
          warnings.push({
            kind: 'week_overflow',
            station,
            weekStart,
            productCode: dropBatch.productMeta.productCode,
            productName: dropBatch.productMeta.productName,
            quantity: dropBatch.quantity,
            durationMinutes: entry.mins,
            reason: 'profit_trim',
            batchProfit: entry.hasProfit ? entry.batchProfit : null,
            message: `Week ${weekStart} on ${station}: dropped ${dropBatch.productMeta.productCode} (${entry.mins.toFixed(0)} min, ${
              entry.hasProfit ? `$${entry.batchProfit.toFixed(0)} batch profit` : 'no profit data'
            }) — week over capacity by ${(weekDemandTotal + entry.mins - weekCapacityTotal).toFixed(0)} min before this drop.`,
          });
        }
      }

      // ─── Per-day packing pass over survivors ─────────────────
      let dayIdx = 0;
      let currentDay = days[dayIdx];
      let dayCapacity = capacityFor(stationCap, currentDay);
      let dayUsed = 0;

      for (const idx of weekIdxs) {
        if (droppedIdxs.has(idx)) continue;
        const batch = timeline.batches[idx];
        const prodMin = productionMinutes(batch);
        const changeMin = timeline.changeovers[idx].costMinutes;
        const totalMin = prodMin + changeMin;

        if (dayUsed > 0 && dayUsed + totalMin > dayCapacity) {
          // Doesn't fit on the current day. Advance.
          dayIdx += 1;
          if (dayIdx >= days.length) {
            // Out of days for this week — overflow that the profit trim
            // didn't catch (per-day packing failed despite week total
            // fitting). Surface as a day-packing overflow.
            const profitPer = batch.productMeta.profitPerItem;
            const hasProfit =
              typeof profitPer === 'number' && Number.isFinite(profitPer);
            warnings.push({
              kind: 'week_overflow',
              station,
              weekStart,
              productCode: batch.productMeta.productCode,
              productName: batch.productMeta.productName,
              quantity: batch.quantity,
              durationMinutes: totalMin,
              reason: 'day_packing',
              batchProfit: hasProfit ? (profitPer as number) * batch.quantity : null,
              message: `Week ${weekStart} on ${station}: ran out of working days; batch ${batch.productMeta.productCode} (${totalMin.toFixed(0)} min) not assigned.`,
            });
            continue;
          }
          currentDay = days[dayIdx];
          dayCapacity = capacityFor(stationCap, currentDay);
          dayUsed = 0;
        }

        // Oversize check: even a fresh day can't hold this batch.
        if (totalMin > dayCapacity) {
          warnings.push({
            kind: 'oversize_batch',
            station,
            weekStart,
            scheduledDate: currentDay,
            productCode: batch.productMeta.productCode,
            durationMinutes: totalMin,
            capacityMinutes: dayCapacity,
            message: `Batch ${batch.productMeta.productCode} (${totalMin.toFixed(0)} min) exceeds ${station}'s daily capacity (${dayCapacity} min) on ${currentDay}; assigning anyway with overrun.`,
          });
        }

        const assigned: AssignedBatch = {
          ...batch,
          scheduledDate: currentDay,
          durationMinutes: prodMin,
          changeoverMinutes: changeMin,
        };

        let dayBucket = dailyTimeline.byDay.get(currentDay);
        if (!dayBucket) {
          dayBucket = {
            batches: [],
            usedMinutes: 0,
            capacityMinutes: dayCapacity,
          };
          dailyTimeline.byDay.set(currentDay, dayBucket);
        }
        dayBucket.batches.push(assigned);
        dayBucket.usedMinutes += totalMin;
        dayUsed += totalMin;
      }

      i = j;
    }
  }

  return { perStation: perStationOut, warnings };
}
