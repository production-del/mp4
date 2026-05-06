/**
 * Engine I/O types — the cross-boundary shapes the planning engines consume
 * and produce.
 *
 * Previously lived in `src/lib/engine/types.ts`. Moved here because "what the
 * engine talks about" is planning-domain data, not engine implementation
 * detail. Co-located with `plan-item.ts` and `demand.ts`, which define the
 * types that FEED these engine inputs.
 *
 * This module deliberately contains no runtime code — only interfaces and a
 * handful of string unions. Engines import these types; callers assemble
 * input objects and read output objects. For the Python-seam JSON contract
 * (wire format with ISO date strings) see `src/lib/engine/serialization.ts`.
 */

import type { BusinessCalendar } from '@/lib/engine/business-calendar';

// ─── Core input items ────────────────────────────────────────

/** A batch scheduled for production in the kitchen. */
export interface KitchenBatch {
  id: string;
  productCode: string;
  productName: string;
  quantity: number;
  scheduledDate: Date;
  status: 'planned' | 'scheduled' | 'in_progress' | 'completed';
  /** References to other batch IDs this batch depends on. */
  dependencies: string[];
  /**
   * Calendar days the batch occupies its equipment from `scheduledDate`.
   * Output becomes available the next working day after the LAST processing
   * day (i.e., `scheduledDate + durationDays - 1`). Undefined defaults to 1
   * — same-day processing, output next day — which matches legacy behaviour.
   */
  durationDays?: number;
}

/** A BOM component specification. */
export interface BOMComponent {
  productCode: string;
  productName: string;
  quantityPerParent: number;
  /** 1 for direct components, 2 for intermediates, etc. */
  level: number;
  parentProductCode: string;
}

/** Stock on hand for a single product at a single warehouse. */
export interface SOHItem {
  productCode: string;
  productName: string;
  quantity: number;
  warehouseId: string;
}

/** A scheduled purchase order delivery. */
export interface PurchaseOrderSchedule {
  poId: string;
  deliveryDate: Date;
  quantity: number;
  received: boolean;
}

// ─── Feasibility ─────────────────────────────────────────────

/** Feasibility result for a single batch. */
export interface BatchFeasibility {
  batchId: string;
  productCode: string;
  feasible: boolean;
  constraints: string[];
  availableQuantity: number;
  requiredQuantity: number;
  /** Can the batch start on its scheduled date? */
  canStart: boolean;
  missingComponents: ComponentShortfall[];
}

/**
 * Three-state feasibility:
 *  - `green`  → sufficient SOH at the planning warehouse
 *  - `amber`  → insufficient locally, available globally (needs transfer)
 *  - `red`    → insufficient globally (requires purchasing)
 */
export type FeasibilityState = 'green' | 'amber' | 'red';

/** A component that is in short supply for a batch. */
export interface ComponentShortfall {
  productCode: string;
  productName: string;
  /** SOH at the planning warehouse. */
  available: number;
  required: number;
  shortfall: number;
  canBeProcured: boolean;
  /** SOH across all warehouses (for amber-state detection). */
  globalAvailable: number;
}

// ─── Kitchen projection ──────────────────────────────────────

export interface KitchenProjectionInput {
  batches: KitchenBatch[];
  boms: BOMComponent[];
  /** SOH at the planning warehouse (Lundberg). */
  soh: SOHItem[];
  /** SOH across all warehouses (for amber detection). */
  globalSOH?: SOHItem[];
  businessCalendar: BusinessCalendar;
}

export interface KitchenProjectionResult {
  batches: BatchFeasibility[];
  aggregated: {
    totalFeasible: number;
    totalInfeasible: number;
    totalAtRisk: number;
  };
  timeline: BatchTimeline[];
}

export interface BatchTimeline {
  batchId: string;
  productCode: string;
  date: Date;
  event: 'scheduled' | 'available_next_day' | 'completion';
  notes: string;
}

// ─── Purchasing projection ───────────────────────────────────

export interface PurchasingProjectionInput {
  componentCode: string;
  batches: KitchenBatch[];
  soh: number;
  dailyConsumption: number[];
  existingPOs: PurchaseOrderSchedule[];
  businessCalendar: BusinessCalendar;
}

export interface DailySOHProjection {
  date: Date;
  openingSOH: number;
  consumedQuantity: number;
  incomingPOs: number;
  closingSOH: number;
  /** Based on average consumption. */
  daysOfStock: number;
}

export interface PurchasingProjectionResult {
  componentCode: string;
  projections: DailySOHProjection[];
  risks: StockRisk[];
  recommendedPODate: Date | null;
  recommendedQuantity: number;
}

export interface StockRisk {
  date: Date;
  riskType: 'stockout' | 'low_stock' | 'overstock';
  message: string;
  projectedSOH: number;
}

// ─── Forward demand projection (3-month planner, Phase 1) ───

/**
 * Configuration for the forward planning horizon.
 *
 * `startWeek` is the ISO local date (`YYYY-MM-DD`) of the Monday that anchors
 * week 0. Forecaster output produces exactly `weeks` rows per product code,
 * indexed from `startWeek`. Default horizon is 12 weeks (≈3 months).
 *
 * Anchoring on Monday is deliberate: it matches the working-week semantics in
 * `working-day.ts` and makes weekly buckets stable across timezone-sensitive
 * conversions. Always pass strings; never `Date`.
 */
export interface PlanningHorizon {
  startWeek: string; // YYYY-MM-DD, must be a Monday
  weeks: number;
}

/**
 * Demand for a single product in a single week of the horizon.
 *
 * `quantity` is the total expected demand for that week, summed from all
 * contributing sources. `sources` records which inputs fed this row — useful
 * for the optimiser's `rationale[]` output and for UI tooltips that explain
 * "this week's demand came from monthly rate + 2 packaging events."
 *
 * Quantities are real-valued (rate-derived contributions are typically
 * fractional). Round only at presentation time, never inside the engine.
 */
export interface WeeklyDemand {
  productCode: string;
  weekStart: string; // YYYY-MM-DD, Monday-anchored
  quantity: number;
  sources: Array<'rate' | 'event'>;
}

// ─── Advanced/auxiliary ──────────────────────────────────────

/** Intermediate component dependency for two-level production chaining. */
export interface IntermediateComponent {
  productCode: string;
  productName: string;
  /** Which batch produces this intermediate. */
  parentBatchId: string;
  producedDate: Date;
  quantity: number;
  /** Which batches consume this. */
  consumedByBatches: string[];
}

/** Tuning knobs for the purchasing projection. */
export interface ProjectionConfig {
  minStockThreshold: number;
  /** Days of stock considered "low". */
  lowStockDays: number;
  /** PO lead time in working days. */
  leadTimeDays: number;
  /** Safety stock buffer in working days. */
  safetyStockDays: number;
}
