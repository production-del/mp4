/**
 * Manual activities store — Phase 4l.8.
 *
 * User-created packaging chips that aren't part of the optimiser's output.
 * Currently entered via drag-and-drop from the "Infeasible products" panel:
 * an infeasible-FG row dragged onto a day cell creates a manual chip with
 * `quantity = unmetUnits` and the planner's routed station.
 *
 * Persistence:
 *   - localStorage key: `byron-manual-activities-v1` (this module)
 *   - cookie `byron-manual-activities-v1` (cookie writer in CalendarApp,
 *     read server-side via `next/headers` and injected into
 *     `projection.activities`)
 *
 * Manual chips ride the same downstream cascade as planner-emitted
 * packaging chips: they appear on the calendar, drive intermediate /
 * kitchen-required runs via BOM, drive raw-material PO sizing, and
 * respect mutations (dismiss, reschedule, qty-edit, station change).
 *
 * Shape:
 *   {
 *     id: stable client-generated identifier (productCode + timestamp);
 *         used as `stableId` so mutations on this chip survive re-plans.
 *     productCode, productName: from the source FG row
 *     date:  YYYY-MM-DD where the user dropped it
 *     quantity: how many units to package
 *     station: hand-packing | elephant | dust | bottlo
 *   }
 */

import type { Station } from './engine-io';

export interface ManualActivity {
  id: string;
  productCode: string;
  productName: string;
  date: string;
  quantity: number;
  station: Station;
}

export const MANUAL_ACTIVITIES_STORAGE_KEY = 'byron-manual-activities-v1';

// ─── localStorage I/O ────────────────────────────────────────

export function readManualActivitiesFromStorage(): ManualActivity[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(MANUAL_ACTIVITIES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidManualActivity);
  } catch {
    return [];
  }
}

export function writeManualActivitiesToStorage(activities: ManualActivity[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      MANUAL_ACTIVITIES_STORAGE_KEY,
      JSON.stringify(activities),
    );
  } catch {
    /* quota / disabled storage — silently noop */
  }
}

// ─── Validation ──────────────────────────────────────────────

function isValidManualActivity(v: unknown): v is ManualActivity {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    typeof r.productCode === 'string' &&
    typeof r.productName === 'string' &&
    typeof r.date === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(r.date) &&
    typeof r.quantity === 'number' &&
    Number.isFinite(r.quantity) &&
    r.quantity > 0 &&
    typeof r.station === 'string' &&
    ['hand-packing', 'elephant', 'dust', 'bottlo'].includes(r.station)
  );
}

/**
 * Parse the manual-activities cookie payload. Used server-side via
 * `next/headers` cookie store. Tolerant on malformed input — returns
 * an empty array rather than throwing.
 */
export function parseManualActivitiesCookie(raw: string | undefined): ManualActivity[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(decodeURIComponent(raw));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidManualActivity);
  } catch {
    return [];
  }
}
