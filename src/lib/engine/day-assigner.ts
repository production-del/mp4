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
 *   1. Start at Monday with `dayUsed = 0`.
 *   2. For each batch: compute `total = production_minutes + changeover_minutes`.
 *      If `dayUsed + total ≤ capacity`, assign to current day, increment
 *      `dayUsed`. Else advance to next day, retry on a fresh capacity.
 *   3. If even a fresh day can't hold the batch (production > daily cap),
 *      emit `oversize_batch` warning and assign anyway with overrun
 *      reported in `usedMinutes > capacityMinutes`.
 *   4. If we run off Friday with batches remaining, emit `week_overflow`
 *      warning; remaining batches are NOT assigned.
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
      durationMinutes: number;
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
      let dayIdx = 0;
      let currentDay = days[dayIdx];
      let dayCapacity = capacityFor(stationCap, currentDay);
      let dayUsed = 0;

      // Process all batches in this week.
      while (i < N && timeline.batches[i].weekStart === weekStart) {
        const batch = timeline.batches[i];
        const prodMin = productionMinutes(batch);
        const changeMin = timeline.changeovers[i].costMinutes;
        const totalMin = prodMin + changeMin;

        if (dayUsed > 0 && dayUsed + totalMin > dayCapacity) {
          // Doesn't fit on the current day. Advance.
          dayIdx += 1;
          if (dayIdx >= days.length) {
            // Out of days for this week — overflow.
            warnings.push({
              kind: 'week_overflow',
              station,
              weekStart,
              productCode: batch.productMeta.productCode,
              durationMinutes: totalMin,
              message: `Week ${weekStart} on ${station}: ran out of working days; batch ${batch.productMeta.productCode} (${totalMin.toFixed(0)} min) not assigned.`,
            });
            i += 1;
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
        i += 1;
      }
    }
  }

  return { perStation: perStationOut, warnings };
}
