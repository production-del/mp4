/**
 * Raw-material demand + PO requirement derivation — Phase 4m.1.
 *
 * Pure functions. Walks each scheduled activity (packaging or
 * kitchen-required) and identifies its DIRECT-CHILD raw material needs
 * — components at BOM depth 1 that aren't intermediates. Intermediates
 * are deliberately skipped because they have their own kitchen-required
 * activities; those activities will surface their raw-material needs
 * directly. (Same single-level walking approach as
 * `deriveIntermediateDemand`; cascading through the BOM is the
 * orchestrator's job.)
 *
 * Pipeline:
 *
 *   activities + bom + intermediateCodes
 *      → deriveRawMaterialDemand → RawMaterialDemandEvent[]
 *
 *   events + initialSohByCode
 *      → projectRawMaterialSoh → RawMaterialShortage[]
 *
 *   shortages + leadTimeDays
 *      → derivePurchaseRequirements → PurchaseRequirement[]
 *
 * Each step is independently useful and testable. The orchestrator
 * `analyzeRawMaterials` chains all three for callers who just want the
 * end result.
 *
 * No I/O. All input data comes from the caller.
 */

import { explodeBom, type FamilyMeta } from './bom-explode';
import type { BOMComponent } from '@/lib/planning/engine-io';

// ─── Public types ────────────────────────────────────────────

export interface ActivityForRawMaterials {
  /** stableId for provenance (drivenBy). */
  stableId: string;
  productCode: string;
  productName: string;
  quantity: number;
  /** YYYY-MM-DD when this activity needs its raw materials available. */
  date: string;
  /** Used for human-readable labels in shortage output. */
  kind: 'packaging' | 'kitchen-required';
}

/** One row per (activity, raw-material). */
export interface RawMaterialDemandEvent {
  rawMaterialCode: string;
  rawMaterialName: string;
  /** Total quantity (including wastage) the activity consumes. */
  quantity: number;
  /** YYYY-MM-DD — date by which this material must be on hand. */
  requiredByDate: string;
  drivenBy: {
    stableId: string;
    productCode: string;
    productName: string;
    quantity: number;
    date: string;
    kind: 'packaging' | 'kitchen-required';
  };
}

export interface RawMaterialShortage {
  rawMaterialCode: string;
  rawMaterialName: string;
  /** YYYY-MM-DD when projected SOH first goes below zero. */
  shortageDate: string;
  /** Quantity short on the shortage date (positive number). */
  shortageQuantity: number;
  /** Total demand across the projected window (for context). */
  totalDemand: number;
  /** Initial SOH at the start of the projection. */
  initialSoh: number;
  /** stableIds of activities that drove demand on or before the shortage date. */
  drivenBy: string[];
}

export interface PurchaseRequirement {
  rawMaterialCode: string;
  rawMaterialName: string;
  /** YYYY-MM-DD — must arrive by this date to avoid the shortage. */
  arriveByDate: string;
  /** YYYY-MM-DD — backed off by lead time. May fall in the past. */
  placeByDate: string;
  /** Days of lead time used to compute placeBy. */
  leadTimeDays: number;
  /** Quantity required (= shortage quantity for v1, no safety-stock policy yet). */
  quantity: number;
  /** True when placeBy < today. The user should place this PO immediately or revisit the plan. */
  overdue: boolean;
  /** stableIds of activities driving this requirement. */
  drivenBy: string[];
}

export interface AnalyzeInput {
  activities: ReadonlyArray<ActivityForRawMaterials>;
  bom: ReadonlyArray<BOMComponent>;
  /** Codes that ARE intermediates (skipped at depth 1; they have their own activities). */
  intermediateCodes: ReadonlySet<string>;
  /** Optional: family metadata for explodeBom. */
  familyMap?: Record<string, FamilyMeta>;
  /** stableIds to skip — dismissed activities don't drive demand. */
  dismissedStableIds?: ReadonlySet<string>;
  /** Per-raw-material starting SOH (sum across whatever warehouses the caller chose). */
  initialSohByCode: Record<string, number>;
  /** Per-material lead time in days; missing entries use `defaultLeadTimeDays`. */
  leadTimeDaysByCode?: Record<string, number>;
  /** Default lead time when a material isn't in the map. Default 14. */
  defaultLeadTimeDays?: number;
  /**
   * "Today" for the overdue check. When omitted, requirements are never
   * marked overdue (useful for tests).
   */
  today?: string;
}

export interface AnalyzeResult {
  events: RawMaterialDemandEvent[];
  shortages: RawMaterialShortage[];
  requirements: PurchaseRequirement[];
}

// ─── Public API ──────────────────────────────────────────────

/**
 * Walks each activity's BOM and emits one event per (activity, raw-material).
 * Raw materials = depth-1 components that aren't in `intermediateCodes`.
 */
export function deriveRawMaterialDemand(input: {
  activities: ReadonlyArray<ActivityForRawMaterials>;
  bom: ReadonlyArray<BOMComponent>;
  intermediateCodes: ReadonlySet<string>;
  familyMap?: Record<string, FamilyMeta>;
  dismissedStableIds?: ReadonlySet<string>;
}): RawMaterialDemandEvent[] {
  const dismissed = input.dismissedStableIds ?? new Set<string>();
  const out: RawMaterialDemandEvent[] = [];
  for (const activity of input.activities) {
    if (dismissed.has(activity.stableId)) continue;
    const r = explodeBom({
      rootProductCode: activity.productCode,
      rootQuantity: activity.quantity,
      bom: input.bom as BOMComponent[],
      familyMap: input.familyMap ?? {},
    });
    // Sum direct-child paths per raw-material code (diamond BOMs collapse).
    const rawQty = new Map<string, { name: string; qty: number }>();
    for (const c of r.components) {
      if (c.depth !== 1) continue; // depth-1 only
      if (input.intermediateCodes.has(c.productCode)) continue; // skip intermediates
      if (c.totalQuantity <= 0) continue;
      const existing = rawQty.get(c.productCode);
      if (existing) {
        existing.qty += c.totalQuantity;
      } else {
        rawQty.set(c.productCode, {
          name: c.productName || c.productCode,
          qty: c.totalQuantity,
        });
      }
    }
    for (const [code, { name, qty }] of rawQty.entries()) {
      out.push({
        rawMaterialCode: code,
        rawMaterialName: name,
        quantity: qty,
        requiredByDate: activity.date,
        drivenBy: {
          stableId: activity.stableId,
          productCode: activity.productCode,
          productName: activity.productName,
          quantity: activity.quantity,
          date: activity.date,
          kind: activity.kind,
        },
      });
    }
  }
  return out;
}

/**
 * Walk forward through demand events chronologically, deducting from SOH.
 * Emit one shortage row per raw material at the FIRST date its projected
 * SOH would go below zero. Subsequent demand on the same material is
 * accumulated into the same shortage's `totalDemand` for context.
 */
export function projectRawMaterialSoh(input: {
  events: ReadonlyArray<RawMaterialDemandEvent>;
  initialSohByCode: Record<string, number>;
}): RawMaterialShortage[] {
  // Group events by raw-material code; keep them sorted by date for the
  // walk-forward simulation.
  const byCode = new Map<string, RawMaterialDemandEvent[]>();
  for (const ev of input.events) {
    let arr = byCode.get(ev.rawMaterialCode);
    if (!arr) {
      arr = [];
      byCode.set(ev.rawMaterialCode, arr);
    }
    arr.push(ev);
  }
  const out: RawMaterialShortage[] = [];
  for (const [code, events] of byCode.entries()) {
    events.sort((a, b) => a.requiredByDate.localeCompare(b.requiredByDate));
    const initialSoh = input.initialSohByCode[code] ?? 0;
    let soh = initialSoh;
    let shortageDate: string | null = null;
    let shortageQty = 0;
    let totalDemand = 0;
    const drivenBy: string[] = [];
    for (const ev of events) {
      soh -= ev.quantity;
      totalDemand += ev.quantity;
      drivenBy.push(ev.drivenBy.stableId);
      if (shortageDate === null && soh < 0) {
        shortageDate = ev.requiredByDate;
        shortageQty = -soh; // amount short on this date
      }
    }
    if (shortageDate) {
      out.push({
        rawMaterialCode: code,
        rawMaterialName: events[0].rawMaterialName,
        shortageDate,
        shortageQuantity: shortageQty,
        totalDemand,
        initialSoh,
        drivenBy,
      });
    }
  }
  // Stable order: by shortage date, then code.
  out.sort((a, b) => {
    if (a.shortageDate !== b.shortageDate) {
      return a.shortageDate.localeCompare(b.shortageDate);
    }
    return a.rawMaterialCode.localeCompare(b.rawMaterialCode);
  });
  return out;
}

/**
 * For each shortage, derive the place-by date by backing off the lead
 * time. Default 14 calendar days; per-material overrides take precedence
 * when present.
 *
 * v1 simplification: quantity = shortage quantity. A real procurement
 * policy would batch multiple shortages of the same material into one PO
 * sized by the next demand window, possibly with safety stock — that's a
 * later refinement.
 */
export function derivePurchaseRequirements(input: {
  shortages: ReadonlyArray<RawMaterialShortage>;
  defaultLeadTimeDays?: number;
  leadTimeDaysByCode?: Record<string, number>;
  today?: string;
}): PurchaseRequirement[] {
  const defaultLT = input.defaultLeadTimeDays ?? 14;
  const ltMap = input.leadTimeDaysByCode ?? {};
  const out: PurchaseRequirement[] = [];
  for (const s of input.shortages) {
    const lt = ltMap[s.rawMaterialCode] ?? defaultLT;
    // Arrive AT LEAST one day before the shortage date so the material is
    // on hand the morning the kitchen needs it. Mirrors the consumer-side
    // 1-day buffer used by `detectScheduleConflicts`.
    const arriveByDate = isoAddDays(s.shortageDate, -1);
    const placeByDate = isoAddDays(arriveByDate, -lt);
    const overdue = input.today !== undefined && placeByDate < input.today;
    out.push({
      rawMaterialCode: s.rawMaterialCode,
      rawMaterialName: s.rawMaterialName,
      arriveByDate,
      placeByDate,
      leadTimeDays: lt,
      quantity: s.shortageQuantity,
      overdue,
      drivenBy: s.drivenBy,
    });
  }
  return out;
}

/** Convenience: chain all three. */
export function analyzeRawMaterials(input: AnalyzeInput): AnalyzeResult {
  const events = deriveRawMaterialDemand({
    activities: input.activities,
    bom: input.bom,
    intermediateCodes: input.intermediateCodes,
    familyMap: input.familyMap,
    dismissedStableIds: input.dismissedStableIds,
  });
  const shortages = projectRawMaterialSoh({
    events,
    initialSohByCode: input.initialSohByCode,
  });
  const requirements = derivePurchaseRequirements({
    shortages,
    defaultLeadTimeDays: input.defaultLeadTimeDays,
    leadTimeDaysByCode: input.leadTimeDaysByCode,
    today: input.today,
  });
  return { events, shortages, requirements };
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
