/**
 * Calendar projection — Phase 4a of the 3-month planner.
 *
 * Pure projection from the day-assigner's `DailyStationTimeline` map into a
 * flat, JSON-serialisable `CalendarActivity[]` that the React calendar can
 * render directly. Lives here (not in `app/calendar/`) so it stays
 * framework-free and unit-testable.
 *
 * One activity per assigned batch. The `kind` discriminator is currently
 * always `'packaging'` because the orchestrator + day-assigner only produce
 * packaging-station batches today. Future phases (kitchen-side scheduling,
 * PO solver) will introduce additional kinds; the type is open enough to
 * accept them without a refactor.
 *
 * Why a Map → array projection at all: server components serialise their
 * output across the React server-client boundary, which doesn't carry
 * `Map`. Flattening to an array also makes the calendar grid's day-bucket
 * grouping a one-line `Array.filter` per day in the client.
 */

import type { Station } from './engine-io';
import type {
  AssignedBatch,
  DailyStationTimeline,
  DayAssignerOutput,
} from '@/lib/engine/day-assigner';

// ─── Public types ────────────────────────────────────────────

/**
 * Future kinds will include 'po-placed', 'po-receiving'.
 *
 * - 'packaging'        — output of the optimiser; chip per planned batch
 * - 'kitchen'          — live Unleashed assemblies at Lundberg (already-scheduled)
 * - 'kitchen-required' — derived gap from intermediate-demand vs supply;
 *                        a kitchen run that must happen but isn't yet scheduled
 * - 'po-placed'        — derived purchasing chip on the place-by date for a
 *                        raw material expected to run short
 * - 'po-receiving'     — derived purchasing chip on the arrive-by date
 *                        (linked to the matching 'po-placed' chip)
 */
export type CalendarActivityKind =
  | 'packaging'
  | 'kitchen'
  | 'kitchen-required'
  | 'po-placed'
  | 'po-receiving';

export interface CalendarActivity {
  /** Per-render identifier — fine for React keys, do NOT use for persistence. */
  id: string;
  /**
   * Persistence-safe identifier. Survives day-assignment changes and
   * orchestrator re-orderings as long as the (productCode, weekStart,
   * orderInWeek) tuple is stable across re-plans. Used by the
   * client-side mutations store (dismiss, etc.).
   *
   * If the engine reroutes a product to a different station between runs,
   * orderInWeek may change — mutations keyed on the old stableId become
   * stale. The mutation store surfaces stale entries as warnings.
   */
  stableId: string;
  kind: CalendarActivityKind;
  /** YYYY-MM-DD local — the day this activity is scheduled for. */
  date: string;
  /**
   * YYYY-MM-DD Monday for packaging activities (the optimiser places them
   * weekly). For kitchen activities pulled from Unleashed, set to the
   * Monday of the assembly's scheduled date.
   */
  weekStart: string;
  /** Position within the week on this station (0 = first batch of the week). */
  orderInWeek: number;
  /** Packaging station for `kind: 'packaging'` activities; `null` for kitchen. */
  station: Station | null;
  productCode: string;
  productName: string;
  quantity: number;
  /** Production minutes (excluding changeover). 0 when not estimated (kitchen activities). */
  durationMinutes: number;
  /** Changeover minutes from the previous batch on this station. 0 for kitchen. */
  changeoverMinutes: number;
  /**
   * Calendar-day duration for kitchen activities. The chip is anchored on
   * `date` (= start day) and the run runs through `date + durationDays - 1`.
   * 1 for packaging activities (a packaging batch fits in one day).
   */
  durationDays?: number;
  /**
   * For `kind: 'kitchen-required'` only — the day the run finishes (last
   * day of production). Output is usable downstream the day after.
   */
  finishDate?: string;
  /**
   * For `kind: 'kitchen-required'` only — the date the run was originally
   * required-by (= what packaging or another recipe needed). Useful for the
   * drawer to show the user the planning chain.
   */
  requiredByDate?: string;
  /** Optional family info — used for color-coding / family-grouping in UI. */
  family: string | null;
  extendedFamily: string | null;
  /**
   * For `kind: 'kitchen'` only — the Unleashed assembly number, surfaced in
   * the drawer / chip tooltip so the operator can correlate the chip with
   * the source assembly in Unleashed.
   */
  assemblyNumber?: string;
  /**
   * For `kind: 'po-placed'` and `kind: 'po-receiving'` only — purchasing
   * details. The two chips for one PO share these fields and reference each
   * other via `sisterStableId`.
   */
  poInfo?: {
    placeByDate: string;
    arriveByDate: string;
    leadTimeDays: number;
    overdue: boolean;
    /** stableId of the linked chip (place ↔ receive). */
    sisterStableId: string;
    /** stableIds of activities driving this PO requirement. */
    drivenBy: string[];
  };
}

/** Build the stable identity used by the mutation store. */
export function stableIdOf(
  productCode: string,
  weekStart: string,
  orderInWeek: number,
): string {
  return `${productCode}|${weekStart}|${orderInWeek}`;
}

/** Per-day per-station load. Calendar uses this to colour-code utilisation. */
export interface DayLoadSummary {
  date: string;
  station: Station;
  usedMinutes: number;
  capacityMinutes: number;
  /** `usedMinutes / capacityMinutes`, clamped to [0, ∞). >1 means overrun. */
  utilisation: number;
}

export interface CalendarProjection {
  activities: CalendarActivity[];
  dayLoads: DayLoadSummary[];
}

// ─── Public API ──────────────────────────────────────────────

export function projectToCalendar(
  dayAssignerOutput: DayAssignerOutput,
): CalendarProjection {
  const activities: CalendarActivity[] = [];
  const dayLoads: DayLoadSummary[] = [];

  for (const [station, timeline] of dayAssignerOutput.perStation.entries()) {
    pushActivities(station, timeline, activities);
    pushDayLoads(station, timeline, dayLoads);
  }

  // Stable, deterministic order: by date, then station, then within-day order.
  // (At this point all activities are kind='packaging' with non-null station;
  // kitchen activities are merged in by the server page after projection.)
  activities.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    const sa = a.station ?? '';
    const sb = b.station ?? '';
    if (sa !== sb) return sa.localeCompare(sb);
    return 0;
  });
  dayLoads.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return a.station.localeCompare(b.station);
  });

  return { activities, dayLoads };
}

// ─── Internals ───────────────────────────────────────────────

function pushActivities(
  station: Station,
  timeline: DailyStationTimeline,
  out: CalendarActivity[],
): void {
  for (const [date, dayLoad] of timeline.byDay.entries()) {
    for (let i = 0; i < dayLoad.batches.length; i++) {
      const batch = dayLoad.batches[i];
      out.push(toActivity(station, date, i, batch));
    }
  }
}

function toActivity(
  station: Station,
  date: string,
  indexWithinDay: number,
  batch: AssignedBatch,
): CalendarActivity {
  return {
    id: `${date}-${station}-${indexWithinDay}-${batch.productCode}`,
    stableId: stableIdOf(batch.productCode, batch.weekStart, batch.orderInWeek),
    kind: 'packaging',
    date,
    weekStart: batch.weekStart,
    orderInWeek: batch.orderInWeek,
    station,
    productCode: batch.productCode,
    productName: batch.productMeta.productName || batch.productCode,
    quantity: batch.quantity,
    durationMinutes: batch.durationMinutes,
    changeoverMinutes: batch.changeoverMinutes,
    family: batch.productMeta.family,
    extendedFamily: batch.productMeta.extendedFamily,
  };
}

function pushDayLoads(
  station: Station,
  timeline: DailyStationTimeline,
  out: DayLoadSummary[],
): void {
  for (const [date, dayLoad] of timeline.byDay.entries()) {
    out.push({
      date,
      station,
      usedMinutes: dayLoad.usedMinutes,
      capacityMinutes: dayLoad.capacityMinutes,
      utilisation:
        dayLoad.capacityMinutes > 0
          ? dayLoad.usedMinutes / dayLoad.capacityMinutes
          : 0,
    });
  }
}
