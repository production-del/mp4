/**
 * PO chip projection — Phase 4m.4 (client-side).
 *
 * Each `PurchaseRequirement` becomes TWO calendar chips: a `po-placed`
 * action-moment chip and a `po-receiving` delivery chip. Their dates are
 * derived from:
 *
 *   - `req.placeByDate` (the ideal place-by computed from shortage − leadTime)
 *   - `req.leadTimeDays` (the static default from the lead-times file)
 *   - `today` (clamps placement to be no earlier than today)
 *   - `leadTimeOverrideDaysByCode[req.rawMaterialCode]` (user-set transient
 *     override for shipping delays — replaces the static lead time when present)
 *
 * Effective dates:
 *   effectivePlaceBy   = max(idealPlaceBy, today)
 *   effectiveLeadTime  = override ?? req.leadTimeDays
 *   effectiveArriveBy  = effectivePlaceBy + effectiveLeadTime
 *
 * `poInfo.placeByDate / arriveByDate / leadTimeDays` keep the IDEAL,
 * file-default values for the drawer to compare against. `poInfo.overdue`
 * is `idealPlaceBy < today`. The chip's `date` field is the EFFECTIVE
 * date so the conflict detector and heatmap reason about reality.
 *
 * Pure: no DOM, no React, no fs.
 */

import type { CalendarActivity } from './calendar-projection';
import type { PurchaseRequirement } from '@/lib/engine/raw-material-demand';

// ─── Public API ──────────────────────────────────────────────

export interface ProjectPoChipsInput {
  purchaseRequirements: ReadonlyArray<PurchaseRequirement>;
  /** Today's date as YYYY-MM-DD local. */
  today: string;
  /**
   * Per-raw-material lead-time override, keyed by raw material code.
   * Replaces `req.leadTimeDays` when present. Negative values are clamped
   * to 0 (treated as "arrives same day as placed"); non-finite values are
   * ignored.
   */
  leadTimeOverrideDaysByCode?: Record<string, number>;
  /** Optional: vendor name per material, surfaced in the chip's productName tooltip. */
  vendorByCode?: Record<string, string>;
}

export function projectPoChips(input: ProjectPoChipsInput): CalendarActivity[] {
  const out: CalendarActivity[] = [];
  const overrides = input.leadTimeOverrideDaysByCode ?? {};
  for (const req of input.purchaseRequirements) {
    const placeStableId = `po-placed|${req.rawMaterialCode}`;
    const receiveStableId = `po-receiving|${req.rawMaterialCode}`;
    const overrideRaw = overrides[req.rawMaterialCode];
    const effectiveLeadTime =
      typeof overrideRaw === 'number' && Number.isFinite(overrideRaw) && overrideRaw >= 0
        ? Math.round(overrideRaw)
        : req.leadTimeDays;
    const effectivePlaceBy =
      req.placeByDate < input.today ? input.today : req.placeByDate;
    const effectiveArriveBy = isoAddDays(effectivePlaceBy, effectiveLeadTime);
    const overdue = req.placeByDate < input.today;
    const sharedInfo = {
      placeByDate: req.placeByDate, // ideal (may be past)
      arriveByDate: req.arriveByDate, // ideal (computed from shortage)
      leadTimeDays: req.leadTimeDays, // file default — drawer compares
      overdue,
      drivenBy: req.drivenBy,
    };
    out.push({
      id: placeStableId,
      stableId: placeStableId,
      kind: 'po-placed',
      date: effectivePlaceBy,
      weekStart: isoMondayOf(effectivePlaceBy),
      orderInWeek: 0,
      station: null,
      productCode: req.rawMaterialCode,
      productName: req.rawMaterialName,
      quantity: req.quantity,
      durationMinutes: 0,
      changeoverMinutes: 0,
      family: null,
      extendedFamily: null,
      poInfo: { ...sharedInfo, sisterStableId: receiveStableId },
    });
    out.push({
      id: receiveStableId,
      stableId: receiveStableId,
      kind: 'po-receiving',
      date: effectiveArriveBy,
      weekStart: isoMondayOf(effectiveArriveBy),
      orderInWeek: 0,
      station: null,
      productCode: req.rawMaterialCode,
      productName: req.rawMaterialName,
      quantity: req.quantity,
      durationMinutes: 0,
      changeoverMinutes: 0,
      family: null,
      extendedFamily: null,
      poInfo: { ...sharedInfo, sisterStableId: placeStableId },
    });
  }
  // Suppress unused-prop warning until vendor display is wired in the drawer.
  void input.vendorByCode;
  return out;
}

// ─── Internals ───────────────────────────────────────────────

function isoAddDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function isoMondayOf(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const dow = dt.getDay();
  const offset = dow === 0 ? -6 : 1 - dow;
  dt.setDate(dt.getDate() + offset);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}
