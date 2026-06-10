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

/** Monday of the week after `weekStart` (a Monday ISO date). */
function nextWeekStart(weekStart: string): string {
  const d = fromLocalISODate(weekStart);
  d.setDate(d.getDate() + 7);
  return toLocalISODate(d);
}

// Phase 4l.14 — how many empty weeks past the last scheduled week the
// day-assigner will extend into when draining carried-over (deferred)
// batches. Bounds the cascade so a genuinely un-placeable batch is dropped
// rather than looping. 12 weeks ≈ a full extra quarter of slack.
const MAX_CARRY_EXTENSION_WEEKS = 12;

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
    const N = timeline.batches.length;

    // Phase 4l.14 — batches that don't fit their week (profit-trim or
    // day-packing overflow) are CARRIED FORWARD to the next week with spare
    // capacity instead of being dropped. The old behaviour silently dropped
    // over-capacity batches, which permanently lost the demand and caused
    // stockouts (e.g. MFCYNPEPSM's opening 510 run was trimmed off an
    // over-capacity 06-01 hand-packing week and never replaced). Deferral
    // keeps the run on the calendar — just later, as capacity allows.
    type Carry = { batch: ScheduledBatchWithMeta; originWeek: string };

    // Pack one week: candidate set = carried-over batches (already displaced,
    // so no changeover cost and exempt from re-trimming) + this week's own
    // batches. Returns the batches that STILL didn't fit, to carry onward.
    const packWeek = (
      weekStart: string,
      days: WorkingDay[],
      carried: Carry[],
      weekIdxs: number[],
    ): Carry[] => {
      type Cand = {
        batch: ScheduledBatchWithMeta;
        changeMin: number;
        originWeek: string;
        carriedIn: boolean;
      };
      const cands: Cand[] = [];
      // Carried batches first — older, already-displaced demand gets priority.
      for (const c of carried) {
        cands.push({ batch: c.batch, changeMin: 0, originWeek: c.originWeek, carriedIn: true });
      }
      for (const idx of weekIdxs) {
        cands.push({
          batch: timeline.batches[idx],
          changeMin: timeline.changeovers[idx].costMinutes,
          originWeek: weekStart,
          carriedIn: false,
        });
      }
      const minutesOf = (c: Cand) => productionMinutes(c.batch) + c.changeMin;

      const weekCapacityTotal = days.reduce((s, d) => s + capacityFor(stationCap, d), 0);
      let weekDemandTotal = cands.reduce((s, c) => s + minutesOf(c), 0);
      const overflow: Carry[] = [];
      const dropped = new Set<Cand>();

      // ─── Profit-aware pre-trim (Phase 4l.9) ───────────────────
      // If the week over-runs total daily capacity, defer the lowest
      // profit-per-minute batches (missing profit ranks 0 → deferred first,
      // signalling the team to fill it in). Carried-in batches are EXEMPT —
      // they were displaced once already; re-trimming them risks perpetual
      // deferral. Deferred batches carry to the next week (not dropped).
      if (weekDemandTotal > weekCapacityTotal) {
        const ranked = cands
          .map((c, order) => ({ c, order }))
          .filter((e) => !e.c.carriedIn)
          .map(({ c, order }) => {
            const profitPer = c.batch.productMeta.profitPerItem;
            const profit =
              typeof profitPer === 'number' && Number.isFinite(profitPer) ? profitPer : 0;
            const mins = minutesOf(c);
            return {
              c,
              order,
              mins,
              profitPerMin: mins > 0 ? (profit * c.batch.quantity) / mins : 0,
              hasProfit: profitPer !== null && profitPer !== undefined,
            };
          })
          .sort((a, b) => {
            if (a.profitPerMin !== b.profitPerMin) return a.profitPerMin - b.profitPerMin;
            // Tiebreak: defer SKUs with no profit data first (signals the team
            // to fill it in) over priced SKUs at the same rate.
            if (a.hasProfit !== b.hasProfit) return a.hasProfit ? 1 : -1;
            // Final tiebreak: defer later-position batches first so earlier
            // ones (often family-cluster heads) stay put.
            return b.order - a.order;
          });
        for (const entry of ranked) {
          if (weekDemandTotal <= weekCapacityTotal) break;
          dropped.add(entry.c);
          weekDemandTotal -= entry.mins;
          overflow.push({ batch: entry.c.batch, originWeek: entry.c.originWeek });
        }
      }

      // ─── Per-day packing pass over survivors ─────────────────
      let dayIdx = 0;
      let currentDay = days[dayIdx];
      let dayCapacity = capacityFor(stationCap, currentDay);
      let dayUsed = 0;

      for (const c of cands) {
        if (dropped.has(c)) continue;
        const batch = c.batch;
        const prodMin = productionMinutes(batch);
        const changeMin = c.changeMin;
        const totalMin = prodMin + changeMin;

        if (dayUsed > 0 && dayUsed + totalMin > dayCapacity) {
          // Doesn't fit on the current day. Advance.
          dayIdx += 1;
          if (dayIdx >= days.length) {
            // Out of days this week — carry to the next week instead of
            // dropping (per-day packing overflow that the trim didn't catch).
            overflow.push({ batch, originWeek: c.originWeek });
            continue;
          }
          currentDay = days[dayIdx];
          dayCapacity = capacityFor(stationCap, currentDay);
          dayUsed = 0;
        }

        // Oversize check: even a fresh day can't hold this batch. Assign
        // anyway with overrun (carrying it would never help — no day fits).
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
          // Restamp the week: a carried batch now belongs to the week it
          // actually lands in, so downstream views read consistently.
          weekStart,
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

      return overflow;
    };

    // Walk weeks present in the timeline, threading carried-over overflow
    // from each week into the next.
    let carry: Carry[] = [];
    let i = 0;
    while (i < N) {
      const weekStart = timeline.batches[i].weekStart;
      const weekIdxs: number[] = [];
      let j = i;
      while (j < N && timeline.batches[j].weekStart === weekStart) {
        weekIdxs.push(j);
        j += 1;
      }
      carry = packWeek(weekStart, workingDaysOf(weekStart), carry, weekIdxs);
      i = j;
    }

    // ─── Drain remaining carry into bounded future weeks ─────────
    // Cascaded overflow can spill past the last week that had batches; extend
    // into empty weeks (up to MAX_CARRY_EXTENSION_WEEKS) to place it.
    if (carry.length > 0 && N > 0) {
      let probe = timeline.batches[N - 1].weekStart;
      let guard = 0;
      while (carry.length > 0 && guard < MAX_CARRY_EXTENSION_WEEKS) {
        probe = nextWeekStart(probe);
        guard += 1;
        carry = packWeek(probe, workingDaysOf(probe), carry, []);
      }
    }

    // Anything STILL carried = genuinely no capacity anywhere in the
    // horizon (+ extension). Now it's a real drop — surface it.
    for (const c of carry) {
      const profitPer = c.batch.productMeta.profitPerItem;
      const hasProfit = typeof profitPer === 'number' && Number.isFinite(profitPer);
      const mins = productionMinutes(c.batch);
      warnings.push({
        kind: 'week_overflow',
        station,
        weekStart: c.originWeek,
        productCode: c.batch.productMeta.productCode,
        productName: c.batch.productMeta.productName,
        quantity: c.batch.quantity,
        durationMinutes: mins,
        reason: 'profit_trim',
        batchProfit: hasProfit ? (profitPer as number) * c.batch.quantity : null,
        message: `${c.batch.productMeta.productCode} (${mins.toFixed(0)} min, originated week ${c.originWeek}): no ${station} capacity within the horizon to place this batch even after carry-forward; dropped.`,
      });
    }
  }

  return { perStation: perStationOut, warnings };
}
