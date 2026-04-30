import type { ProductCode } from './join-keys';

/**
 * Demand — a quantity of a product needed at a specific destination by a
 * specific date. The canonical pipeline contract between planning stages.
 *
 * The planner consumes `Demand[]` from: the packaging planner (intermediate
 * demand at MF Packaging), kitchen assemblies (component demand at
 * Lundberg), and — in future — your tracker publishing purchase demand
 * derived from ingredient restocking rules.
 *
 * Keep this shape byte-compatible with the planner's `Demand`. If you need
 * extra fields, add a new variant to `source` rather than extending the
 * core fields.
 */
export interface Demand {
  productCode: ProductCode;
  productName?: string;
  quantityNeeded: number;
  /** Local-ISO `YYYY-MM-DD`. Use `toLocalISODate` from `working-day`. */
  needByDate: string;
  /** Canonical warehouse name, e.g. `"Lundberg Storeroom"`, `"MF Packaging"`. */
  destinationWarehouse: string;
  source: DemandSource;
}

export type DemandSource =
  | { type: 'kitchen_batch'; batchId: string; batchName: string }
  | { type: 'packaging_run'; runId: string; runName: string }
  | { type: 'tracker_restock'; recordId: string; reason: string }
  | { type: 'manual'; id: string; note: string };
