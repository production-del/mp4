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

/**
 * Scheduled supply for a raw material — typically an outstanding Unleashed
 * PO line landing on its expected delivery date. Credited to running SOH
 * BEFORE same-date demand is deducted (Phase 4l.5).
 */
export interface RawMaterialSupplyEvent {
  rawMaterialCode: string;
  rawMaterialName: string;
  quantity: number;
  /** YYYY-MM-DD when the supply becomes available. */
  availableDate: string;
  /** Provenance for diagnostics / chip drilldown. */
  source: {
    kind: 'unleashed_po';
    purchaseOrderNumber: string;
    lineNumber: number;
    supplierName: string;
  };
}

export interface RawMaterialShortage {
  rawMaterialCode: string;
  rawMaterialName: string;
  /** YYYY-MM-DD when projected SOH first goes below zero. */
  shortageDate: string;
  /** Quantity short on the shortage date (positive number). */
  shortageQuantity: number;
  /**
   * Cumulative shortage at the end of the projection window =
   * `max(0, totalDemand - initialSoh)`. Drives PO sizing in
   * `derivePurchaseRequirements` so a single PO covers the whole horizon's
   * demand rather than just the first shortfall.
   */
  cumulativeShortage: number;
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
  /**
   * Scheduled supply (e.g. outstanding Unleashed PO line items) credited
   * to SOH on their `availableDate`. Optional; Phase 4l.5.
   */
  supplyEvents?: ReadonlyArray<RawMaterialSupplyEvent>;
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
 * Walk forward through demand + supply events chronologically, simulating
 * SOH. Emit one shortage row per raw material at the FIRST date its
 * projected SOH would go below zero. Subsequent demand on the same material
 * is accumulated into `totalDemand` for context, and total scheduled supply
 * into `totalSupply`.
 *
 * Supply events (e.g. Unleashed PO outstanding lines, Phase 4l.5) credit
 * SOH on their `availableDate`. Same-date ordering: supplies before demands
 * so a PO arriving on day X is available to cover demand on day X.
 */
export function projectRawMaterialSoh(input: {
  events: ReadonlyArray<RawMaterialDemandEvent>;
  supplyEvents?: ReadonlyArray<RawMaterialSupplyEvent>;
  initialSohByCode: Record<string, number>;
}): RawMaterialShortage[] {
  // Group demand + supply events by raw-material code.
  type TimelineEvent =
    | { kind: 'demand'; date: string; quantity: number; ref: RawMaterialDemandEvent }
    | { kind: 'supply'; date: string; quantity: number; ref: RawMaterialSupplyEvent };
  const byCode = new Map<string, TimelineEvent[]>();
  for (const ev of input.events) {
    let arr = byCode.get(ev.rawMaterialCode);
    if (!arr) {
      arr = [];
      byCode.set(ev.rawMaterialCode, arr);
    }
    arr.push({ kind: 'demand', date: ev.requiredByDate, quantity: ev.quantity, ref: ev });
  }
  for (const sv of input.supplyEvents ?? []) {
    let arr = byCode.get(sv.rawMaterialCode);
    if (!arr) {
      arr = [];
      byCode.set(sv.rawMaterialCode, arr);
    }
    arr.push({ kind: 'supply', date: sv.availableDate, quantity: sv.quantity, ref: sv });
  }
  const out: RawMaterialShortage[] = [];
  for (const [code, evs] of byCode.entries()) {
    // Sort by date asc, with supplies before demands on the same date so
    // a PO arriving day-of credits SOH before that day's consumption.
    evs.sort((a, b) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      if (a.kind !== b.kind) return a.kind === 'supply' ? -1 : 1;
      return 0;
    });
    const initialSoh = input.initialSohByCode[code] ?? 0;
    let soh = initialSoh;
    let shortageDate: string | null = null;
    let shortageQty = 0;
    let totalDemand = 0;
    let totalSupply = 0;
    let firstName = '';
    const drivenBy: string[] = [];
    for (const ev of evs) {
      if (!firstName) firstName = ev.kind === 'demand' ? ev.ref.rawMaterialName : ev.ref.rawMaterialName;
      if (ev.kind === 'supply') {
        soh += ev.quantity;
        totalSupply += ev.quantity;
        continue;
      }
      soh -= ev.quantity;
      totalDemand += ev.quantity;
      drivenBy.push(ev.ref.drivenBy.stableId);
      if (shortageDate === null && soh < 0) {
        shortageDate = ev.date;
        shortageQty = -soh; // amount short on this date
      }
    }
    if (shortageDate) {
      out.push({
        rawMaterialCode: code,
        rawMaterialName: firstName,
        shortageDate,
        shortageQuantity: shortageQty,
        cumulativeShortage: Math.max(0, totalDemand - initialSoh - totalSupply),
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
 * Phase 4l.4: quantity now = `cumulativeShortage` (total horizon shortfall
 * = totalDemand − initialSoh, clamped ≥ 0). A single PO covers the whole
 * projected window's demand rather than just the first shortfall — closer
 * to real procurement behaviour. Safety stock is still future work.
 * `shortageQuantity` is retained on the shortage row for display.
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
    // Skip zero-qty requirements (Phase 4l.8). A shortage row exists
    // whenever projected SOH goes negative at some point in the walk, but
    // if later supply (e.g. an Unleashed PO arriving in horizon) covers
    // the cumulative deficit, `cumulativeShortage` is 0 and no new PO is
    // needed. Timing-of-existing-supplies issues surface via the conflict
    // detector — we don't paper over them with a phantom zero-qty PO.
    if (s.cumulativeShortage <= 0) continue;
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
      quantity: s.cumulativeShortage,
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
    supplyEvents: input.supplyEvents,
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
