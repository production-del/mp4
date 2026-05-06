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

/** Future kinds will include 'kitchen', 'po-placed', 'po-receiving'. */
export type CalendarActivityKind = 'packaging';

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
  /** YYYY-MM-DD Monday — week the orchestrator placed this batch in. */
  weekStart: string;
  /** Position within the week on this station (0 = first batch of the week). */
  orderInWeek: number;
  station: Station;
  productCode: string;
  productName: string;
  quantity: number;
  /** Production minutes (excluding changeover). */
  durationMinutes: number;
  /** Changeover minutes from the previous batch on this station. */
  changeoverMinutes: number;
  /** Optional family info — used for color-coding / family-grouping in UI. */
  family: string | null;
  extendedFamily: string | null;
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
  activities.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    if (a.station !== b.station) return a.station.localeCompare(b.station);
    return 0; // Already in within-day order from the source map iteration.
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
