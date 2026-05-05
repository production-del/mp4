/**
 * Auto-cascade conflict resolver — Phase 4l.3 (push) + 4l.4 (capacity)
 * + 4l.6 (pull-supplier) + 4l.7 (auto strategy + kitchen capacity).
 *
 * Three strategies, all monotone and bounded:
 *
 *   'push' (the original): consumers move LATER. Per conflict, base target
 *     = max(blocker finish across this consumer's unmet ingredients) + 1
 *     day. With `stationDailyMinutes` set, target walks forward past full
 *     days. Pure forward motion → terminates. Kitchen-required consumers
 *     respect `kitchenDailyMinutes` when set.
 *
 *   'pull': suppliers (the BLOCKERS named by each conflict) move EARLIER.
 *     Per blocker, target finish = min(consumer date among conflicts it
 *     blocks) − 1 day. Production span (finishDate − date) is preserved.
 *     Snap backward to weekday. Floor at `earliestDate`. Kitchen-required
 *     blockers respect `kitchenDailyMinutes` when set — walk further back
 *     past kitchen-overloaded days.
 *
 *   'auto': run pull first; for any conflicts pull couldn't fix
 *     (earliestDate floor or kitchen capacity), run push to mop up. Pure
 *     chaining of the two pure passes — no special-case logic.
 *
 * Kitchen capacity model:
 *   - `kitchenDailyMinutes` is the kitchen team's daily budget (e.g. 480
 *     for an 8-hr day). When unset, kitchen capacity is not enforced.
 *   - Each kitchen-required chip is treated as costing
 *     `kitchenStartMinutesPerChip` minutes on its START day (default 240).
 *     This models initiation/cook overhead — soak+dehyd are unattended
 *     once started, per the operator's note.
 *   - Cook-day cost on the finish day is not currently modelled; the
 *     start-day estimate is set high enough to account for typical recipes.
 *
 * The caller decides whether to persist the returned mutations.
 */

import type { CalendarActivity } from '@/lib/planning/calendar-projection';
import {
  applyMutationsToActivities,
  applyReschedule,
  isDismissed,
  type MutationsMap,
} from '@/lib/planning/calendar-mutations';
import {
  detectScheduleConflicts,
  type ScheduleConflict,
} from './schedule-conflicts';

// ─── Public types ────────────────────────────────────────────

export type ResolveStrategy = 'push' | 'pull' | 'auto';

export interface ResolveConflictsInput {
  activities: ReadonlyArray<CalendarActivity>;
  mutations: MutationsMap;
  consumesMap: Record<string, string[]>;
  /**
   * Optional explicit dismissed-set. If omitted, the resolver derives it
   * from the `mutations` map (any entry with `dismissed: true`).
   */
  dismissedStableIds?: ReadonlySet<string>;
  /** Default: 'push'. */
  strategy?: ResolveStrategy;
  /**
   * Per-station daily capacity in minutes (e.g. { bottlo: 480, ... }).
   * When set, packaging chips' target placement walks past full station
   * days. Ignored for kitchen-required chips (they have no station).
   */
  stationDailyMinutes?: Record<string, number>;
  /**
   * Kitchen team's daily minute budget (e.g. 480 for 8 hrs). When set,
   * kitchen-required chips' target placement (push or pull) walks past
   * days that would exceed this budget. Per-chip cost is looked up in
   * `kitchenStartMinutesByProductCode` and falls back to
   * `kitchenStartMinutesDefault` (default 240).
   */
  kitchenDailyMinutes?: number;
  /**
   * Per-recipe initiation minutes consumed on the start day, keyed by
   * productCode. Activities whose productCode isn't in the map use
   * `kitchenStartMinutesDefault`.
   */
  kitchenStartMinutesByProductCode?: Record<string, number>;
  /** Fallback minutes per chip when the map has no entry. Default 240. */
  kitchenStartMinutesDefault?: number;
  /**
   * 'pull' only — chips can't be pulled to a date strictly earlier than
   * this. Default '0000-01-01' (essentially no floor) so tests don't
   * have to pass it. The UI passes the planning-horizon start.
   */
  earliestDate?: string;
  /** Defensive cap on the walk-forward search per chip ('push'). Default 90 days. */
  maxWalkDays?: number;
  /** Defensive cap on outer loop. Default 20. */
  maxIterations?: number;
}

export interface ResolveConflictsOutput {
  /** Final mutations map — pass to localStorage / setState. */
  mutations: MutationsMap;
  /** Number of iterations actually executed (0 = no conflicts to begin with). */
  iterations: number;
  /** Conflicts still present after the loop (empty when fully resolved). */
  remainingConflicts: ScheduleConflict[];
  /** True when the iteration cap was hit before reaching a fixpoint. */
  hitIterationCap: boolean;
  /**
   * stableIds that couldn't be placed:
   *   - 'push': consumer chips with no working day of capacity within
   *     `maxWalkDays`.
   *   - 'pull': blocker chips whose earliest feasible start date would
   *     fall before `earliestDate`, OR a kitchen blocker that ran out of
   *     in-budget kitchen days within the search window.
   *   - 'auto': whatever push couldn't place after pull (push gets the
   *     last word; pull-only unplaceables are not surfaced if push fixed
   *     the underlying conflict).
   */
  unplaceableStableIds: string[];
  /** The strategy that was actually used. */
  strategy: ResolveStrategy;
}

// ─── Public API ──────────────────────────────────────────────

export function resolveScheduleConflicts(
  input: ResolveConflictsInput,
): ResolveConflictsOutput {
  const strategy: ResolveStrategy = input.strategy ?? 'push';

  // 'auto' = chain pull → push using the same pure resolver.
  if (strategy === 'auto') {
    const pullResult = resolveScheduleConflicts({ ...input, strategy: 'pull' });
    if (pullResult.remainingConflicts.length === 0) {
      return { ...pullResult, strategy: 'auto' };
    }
    const pushResult = resolveScheduleConflicts({
      ...input,
      mutations: pullResult.mutations,
      strategy: 'push',
    });
    // Push gets the last word on unplaceable: any blocker pull couldn't
    // pull MAY have been resolved by push moving the consumer instead.
    return {
      mutations: pushResult.mutations,
      iterations: pullResult.iterations + pushResult.iterations,
      remainingConflicts: pushResult.remainingConflicts,
      hitIterationCap: pullResult.hitIterationCap || pushResult.hitIterationCap,
      unplaceableStableIds: pushResult.unplaceableStableIds,
      strategy: 'auto',
    };
  }

  const maxIterations = input.maxIterations ?? 20;
  const maxWalkDays = input.maxWalkDays ?? 90;
  const dismissedSet =
    input.dismissedStableIds ?? deriveDismissedSet(input.activities, input.mutations);
  const stationCapacities = input.stationDailyMinutes;
  const kitchenCap = input.kitchenDailyMinutes;
  const kitchenDefault = input.kitchenStartMinutesDefault ?? 240;
  const kitchenByCode = input.kitchenStartMinutesByProductCode ?? {};
  const kitchenChipCost = (a: CalendarActivity): number =>
    kitchenByCode[a.productCode] ?? kitchenDefault;
  const earliestDate = input.earliestDate ?? '0000-01-01';

  let working: MutationsMap = input.mutations;
  let iterations = 0;
  let lastConflicts: ScheduleConflict[] = [];
  const unplaceable = new Set<string>();

  for (let i = 0; i < maxIterations; i++) {
    iterations = i + 1;
    const mutated = applyMutationsToActivities(input.activities, working);
    const conflicts = detectScheduleConflicts({
      activities: mutated,
      consumesMap: input.consumesMap,
      dismissedStableIds: dismissedSet,
    });
    lastConflicts = conflicts;
    if (conflicts.length === 0) {
      return {
        mutations: working,
        iterations: i, // 0 if first detection was already empty
        remainingConflicts: [],
        hitIterationCap: false,
        unplaceableStableIds: Array.from(unplaceable),
        strategy,
      };
    }

    const stepResult =
      strategy === 'push'
        ? stepPush({
            mutated,
            conflicts,
            working,
            stationCapacities,
            kitchenCap,
            kitchenChipCost,
            maxWalkDays,
            dismissedSet,
            unplaceable,
          })
        : stepPull({
            mutated,
            conflicts,
            working,
            earliestDate,
            kitchenCap,
            kitchenChipCost,
            maxWalkDays,
            dismissedSet,
            unplaceable,
          });

    working = stepResult.working;
    if (!stepResult.changed) {
      // Fixpoint with conflicts still present (typically due to unplaceable).
      return {
        mutations: working,
        iterations,
        remainingConflicts: conflicts,
        hitIterationCap: false,
        unplaceableStableIds: Array.from(unplaceable),
        strategy,
      };
    }
  }

  return {
    mutations: working,
    iterations,
    remainingConflicts: lastConflicts,
    hitIterationCap: true,
    unplaceableStableIds: Array.from(unplaceable),
    strategy,
  };
}

// ─── Strategy: PUSH (consumers later) ───────────────────────

interface StepArgs {
  mutated: CalendarActivity[];
  conflicts: ScheduleConflict[];
  working: MutationsMap;
  unplaceable: Set<string>;
  dismissedSet: ReadonlySet<string>;
  kitchenCap: number | undefined;
  /** Per-chip kitchen-team minute cost — varies by recipe (Phase 4l.8). */
  kitchenChipCost: (a: CalendarActivity) => number;
  maxWalkDays: number;
}

interface PushArgs extends StepArgs {
  stationCapacities: Record<string, number> | undefined;
}

function stepPush(args: PushArgs): { working: MutationsMap; changed: boolean } {
  const {
    mutated,
    conflicts,
    stationCapacities,
    kitchenCap,
    kitchenChipCost,
    maxWalkDays,
    dismissedSet,
    unplaceable,
  } = args;
  let { working } = args;
  const stationLoad = stationCapacities
    ? buildStationDayLoad(mutated, dismissedSet)
    : null;
  const kitchenLoad = kitchenCap !== undefined
    ? buildKitchenDayLoad(mutated, dismissedSet, kitchenChipCost)
    : null;
  const byConsumer = groupByConsumer(conflicts);
  let changed = false;
  for (const [stableId, group] of byConsumer) {
    let maxFinish = '';
    for (const c of group) {
      if (c.earliestFinishDate > maxFinish) maxFinish = c.earliestFinishDate;
    }
    if (!maxFinish) continue;
    const consumerActivity = mutated.find((a) => a.stableId === stableId);
    if (!consumerActivity) continue;
    const baseTarget = isoAddDays(maxFinish, 1);
    const currentDate = consumerActivity.date;
    const target = findCapacityFitForward({
      consumer: consumerActivity,
      baseTarget,
      maxWalkDays,
      stationCapacities,
      stationLoad,
      kitchenCap,
      kitchenChipCost,
      kitchenLoad,
    });
    if (!target) {
      unplaceable.add(stableId);
      continue;
    }
    if (currentDate === target) continue;
    // Update in-flight loads for subsequent placements in this iteration.
    if (stationLoad && consumerActivity.station) {
      const chipMin =
        consumerActivity.durationMinutes + consumerActivity.changeoverMinutes;
      adjustDayLoad(stationLoad, currentDate, consumerActivity.station, -chipMin);
      adjustDayLoad(stationLoad, target, consumerActivity.station, +chipMin);
    }
    if (kitchenLoad && consumerActivity.kind === 'kitchen-required') {
      const cost = kitchenChipCost(consumerActivity);
      adjustKitchenLoad(kitchenLoad, currentDate, -cost);
      adjustKitchenLoad(kitchenLoad, target, +cost);
    }
    working = applyReschedule(working, stableId, target);
    changed = true;
  }
  return { working, changed };
}

// ─── Strategy: PULL (suppliers earlier) ─────────────────────

interface PullArgs extends StepArgs {
  earliestDate: string;
}

function stepPull(args: PullArgs): { working: MutationsMap; changed: boolean } {
  const {
    mutated,
    conflicts,
    earliestDate,
    kitchenCap,
    kitchenChipCost,
    maxWalkDays,
    dismissedSet,
    unplaceable,
  } = args;
  let { working } = args;
  const kitchenLoad = kitchenCap !== undefined
    ? buildKitchenDayLoad(mutated, dismissedSet, kitchenChipCost)
    : null;
  const byBlocker = groupByBlocker(conflicts);
  let changed = false;
  for (const [blockerStableId, group] of byBlocker) {
    let earliestConsumer = '';
    for (const c of group) {
      if (!earliestConsumer || c.consumerDate < earliestConsumer) {
        earliestConsumer = c.consumerDate;
      }
    }
    if (!earliestConsumer) continue;
    const targetFinish = isoAddDays(earliestConsumer, -1);
    const blocker = mutated.find((a) => a.stableId === blockerStableId);
    if (!blocker) continue;
    // PO chips have derived dates — pulling them earlier is meaningless
    // (the actual placement can't happen before today, and the actual
    // arrival is constrained by the lead time). Auto-strategy will fall
    // through to push-consumer instead.
    if (blocker.kind === 'po-placed' || blocker.kind === 'po-receiving') {
      unplaceable.add(blockerStableId);
      continue;
    }
    const currentFinish = blocker.finishDate ?? blocker.date;
    const span = isoDayDelta(blocker.date, currentFinish); // ≥ 0
    const baseTargetStart = isoAddDays(targetFinish, -span);
    // First, snap to weekday backward.
    let snappedStart = previousWorkdayOnOrBefore(baseTargetStart);
    // Then, if kitchen capacity is set and this is a kitchen-required
    // chip, walk further backward past days that would overflow the team.
    if (kitchenCap !== undefined && kitchenLoad && blocker.kind === 'kitchen-required') {
      const cost = kitchenChipCost(blocker);
      let candidate: string | null = snappedStart;
      let walked = 0;
      while (candidate && walked < maxWalkDays) {
        if (candidate < earliestDate) {
          candidate = null;
          break;
        }
        const used = kitchenLoad.get(candidate) ?? 0;
        // Subtract this chip's own current contribution if it's already on
        // this day (a no-op move shouldn't fail capacity check).
        const selfContribution = blocker.date === candidate ? cost : 0;
        if (used - selfContribution + cost <= kitchenCap) break;
        candidate = previousWorkdayOnOrBefore(isoAddDays(candidate, -1));
        walked++;
      }
      if (!candidate) {
        unplaceable.add(blockerStableId);
        continue;
      }
      snappedStart = candidate;
    }
    if (snappedStart < earliestDate) {
      unplaceable.add(blockerStableId);
      continue;
    }
    if (blocker.date === snappedStart) continue;
    // Update in-flight kitchen load for subsequent placements.
    if (kitchenLoad && blocker.kind === 'kitchen-required') {
      const cost = kitchenChipCost(blocker);
      adjustKitchenLoad(kitchenLoad, blocker.date, -cost);
      adjustKitchenLoad(kitchenLoad, snappedStart, +cost);
    }
    working = applyReschedule(working, blockerStableId, snappedStart);
    changed = true;
  }
  return { working, changed };
}

// ─── Internals ───────────────────────────────────────────────

function deriveDismissedSet(
  activities: ReadonlyArray<CalendarActivity>,
  mutations: MutationsMap,
): Set<string> {
  const out = new Set<string>();
  for (const a of activities) {
    if (isDismissed(mutations, a.stableId)) out.add(a.stableId);
  }
  return out;
}

function groupByConsumer(
  conflicts: ScheduleConflict[],
): Map<string, ScheduleConflict[]> {
  const out = new Map<string, ScheduleConflict[]>();
  for (const c of conflicts) {
    let arr = out.get(c.consumerStableId);
    if (!arr) {
      arr = [];
      out.set(c.consumerStableId, arr);
    }
    arr.push(c);
  }
  return out;
}

function groupByBlocker(
  conflicts: ScheduleConflict[],
): Map<string, ScheduleConflict[]> {
  const out = new Map<string, ScheduleConflict[]>();
  for (const c of conflicts) {
    let arr = out.get(c.blockedByStableId);
    if (!arr) {
      arr = [];
      out.set(c.blockedByStableId, arr);
    }
    arr.push(c);
  }
  return out;
}

/** date → station → used minutes (excluding dismissed activities). */
type StationLoad = Map<string, Map<string, number>>;
/** date → kitchen-team minutes (excluding dismissed activities). */
type KitchenLoad = Map<string, number>;

function buildStationDayLoad(
  activities: ReadonlyArray<CalendarActivity>,
  dismissed: ReadonlySet<string>,
): StationLoad {
  const out: StationLoad = new Map();
  for (const a of activities) {
    if (dismissed.has(a.stableId)) continue;
    if (!a.station) continue; // kitchen activities don't use station capacity
    let stations = out.get(a.date);
    if (!stations) {
      stations = new Map();
      out.set(a.date, stations);
    }
    const min = a.durationMinutes + a.changeoverMinutes;
    stations.set(a.station, (stations.get(a.station) ?? 0) + min);
  }
  return out;
}

function buildKitchenDayLoad(
  activities: ReadonlyArray<CalendarActivity>,
  dismissed: ReadonlySet<string>,
  perChipCost: (a: CalendarActivity) => number,
): KitchenLoad {
  const out: KitchenLoad = new Map();
  for (const a of activities) {
    if (dismissed.has(a.stableId)) continue;
    if (a.kind !== 'kitchen-required') continue;
    out.set(a.date, (out.get(a.date) ?? 0) + perChipCost(a));
  }
  return out;
}

function adjustDayLoad(
  load: StationLoad,
  date: string,
  station: string,
  deltaMinutes: number,
): void {
  let stations = load.get(date);
  if (!stations) {
    stations = new Map();
    load.set(date, stations);
  }
  stations.set(station, Math.max(0, (stations.get(station) ?? 0) + deltaMinutes));
}

function adjustKitchenLoad(
  load: KitchenLoad,
  date: string,
  deltaMinutes: number,
): void {
  load.set(date, Math.max(0, (load.get(date) ?? 0) + deltaMinutes));
}

function stationUsedAt(
  load: StationLoad,
  date: string,
  station: string,
): number {
  return load.get(date)?.get(station) ?? 0;
}

interface FitArgs {
  consumer: CalendarActivity;
  baseTarget: string;
  maxWalkDays: number;
  stationCapacities: Record<string, number> | undefined;
  stationLoad: StationLoad | null;
  kitchenCap: number | undefined;
  /** Per-chip kitchen cost lookup. */
  kitchenChipCost: (a: CalendarActivity) => number;
  kitchenLoad: KitchenLoad | null;
}

/**
 * Walk forward from `baseTarget`, skipping weekends and any day where
 * placing the chip would exceed station OR kitchen capacity.
 * Returns the first fitting date, or null if no fit within `maxWalkDays`.
 */
function findCapacityFitForward(args: FitArgs): string | null {
  const consumer = args.consumer;
  const isKitchen = consumer.kind === 'kitchen-required';
  const station = consumer.station;
  const stationCap =
    station && args.stationCapacities ? args.stationCapacities[station] ?? 0 : 0;
  const stationChipMin = consumer.durationMinutes + consumer.changeoverMinutes;
  // Short-circuit: chip is bigger than a full day's station budget — nothing
  // will ever fit, so just return the base weekday so the user sees overrun
  // styling and can intervene.
  if (
    args.stationCapacities &&
    station &&
    stationCap > 0 &&
    stationChipMin > stationCap
  ) {
    return nextWorkdayOnOrAfter(args.baseTarget);
  }
  // Same short-circuit for kitchen capacity: if a single chip's kitchen cost
  // already exceeds the daily kitchen budget, fall back to the base weekday.
  const kitchenChipMin = isKitchen ? args.kitchenChipCost(consumer) : 0;
  if (
    isKitchen &&
    args.kitchenCap !== undefined &&
    kitchenChipMin > args.kitchenCap
  ) {
    return nextWorkdayOnOrAfter(args.baseTarget);
  }

  let candidate = nextWorkdayOnOrAfter(args.baseTarget);
  for (let i = 0; i < args.maxWalkDays; i++) {
    let fits = true;
    // Station check (packaging).
    if (args.stationCapacities && station && args.stationLoad) {
      const used = stationUsedAt(args.stationLoad, candidate, station);
      if (stationCap > 0 && used + stationChipMin > stationCap) fits = false;
    }
    // Kitchen check (kitchen-required).
    if (fits && isKitchen && args.kitchenCap !== undefined && args.kitchenLoad) {
      const used = args.kitchenLoad.get(candidate) ?? 0;
      if (used + kitchenChipMin > args.kitchenCap) fits = false;
    }
    if (fits) return candidate;
    candidate = nextWorkdayOnOrAfter(isoAddDays(candidate, 1));
  }
  return null;
}

/** Returns `iso` if it's a weekday, else the next Mon. */
function nextWorkdayOnOrAfter(iso: string): string {
  let d = iso;
  for (let i = 0; i < 7; i++) {
    if (isWeekday(d)) return d;
    d = isoAddDays(d, 1);
  }
  return d; // unreachable
}

/** Returns `iso` if it's a weekday, else the previous Fri. */
function previousWorkdayOnOrBefore(iso: string): string {
  let d = iso;
  for (let i = 0; i < 7; i++) {
    if (isWeekday(d)) return d;
    d = isoAddDays(d, -1);
  }
  return d; // unreachable
}

function isWeekday(iso: string): boolean {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const dow = dt.getDay(); // 0=Sun, 6=Sat
  return dow >= 1 && dow <= 5;
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

function isoDayDelta(fromIso: string, toIso: string): number {
  const [y1, m1, d1] = fromIso.split('-').map(Number);
  const [y2, m2, d2] = toIso.split('-').map(Number);
  const ms =
    new Date(y2, m2 - 1, d2).getTime() - new Date(y1, m1 - 1, d1).getTime();
  return Math.round(ms / (1000 * 60 * 60 * 24));
}
