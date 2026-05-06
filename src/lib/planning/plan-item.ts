/**
 * PlanItem — unified draft type for every planning variant.
 *
 * Replaces the four parallel draft types previously sprinkled across the app:
 *   - `ScheduledBatch`  (kitchen)
 *   - `PlannedAssembly` (packaging)
 *   - `DraftPO`         (purchasing)
 *   - `DraftTransfer`   (logistics)
 *
 * Every plan item shares a small set of fields (id, productCode, quantity,
 * lifecycle). Variant-specific fields live on the discriminated variant types,
 * keyed by `kind`. The discriminator lets consumers narrow to the variant
 * they care about via `kind === 'kitchen_run'` (and friends).
 *
 * Dates are stored as local ISO strings (YYYY-MM-DD) so the store can round-
 * trip through `JSON.stringify`/`parse` without `Date`-object rehydration.
 * UI code that still wants `Date` objects converts at the boundary via
 * `working-day.ts` helpers.
 */

export type PlanItemKind = 'kitchen_run' | 'packaging_run' | 'purchase_order' | 'transfer';

/** Commitment state: has the planner's draft been pushed to Unleashed yet? */
export type Lifecycle = 'draft' | 'pushed';

interface BasePlanItem {
  id: string;
  kind: PlanItemKind;
  productCode: string;
  productName: string;
  quantity: number;
  lifecycle: Lifecycle;
}

// ─── Kitchen run ─────────────────────────────────────────────

/**
 * Free-form resource identifier — one of the configured `kitchenResources`
 * in `KitchenConfig`. Historically this was a fixed `'midgy' | 'mama' | 'papa'`
 * union for the three dehydrators, hence the field name. It's now widened to
 * a string so ovens, mixers, and any other physical resource can use the same
 * lane/slot system. The legacy `DehydratorSlot` name survives for continuity.
 */
export type DehydratorSlot = string;

export interface KitchenRunItem extends BasePlanItem {
  kind: 'kitchen_run';
  /** Local-ISO (YYYY-MM-DD). When the batch is scheduled to run. */
  scheduledDate: string;
  /** Key into `INTERMEDIATE_REGISTRY` (the assemblyId from Unleashed). */
  intermediateKey: string;
  /** Which resource slot this batch is on (dehydrator, oven, mixer, etc.). */
  dehydrator?: DehydratorSlot;
  /** `unleashed` = sourced from API; `draft` = user-authored. */
  origin: 'unleashed' | 'draft';
  /** Production progress (distinct from `lifecycle`'s commitment state). */
  status: 'planned' | 'scheduled' | 'in_progress' | 'completed';
  /**
   * Unleashed-facing number (human-readable). The Unleashed GUID is carried
   * by `intermediateKey` (kitchen treats key = assemblyId by construction).
   */
  assemblyNumber?: string;
}

// ─── Packaging run ───────────────────────────────────────────

export type PackingTeam = 'elephant' | 'dust' | 'hand' | 'bottling' | 'bulk';

export interface PackagingRunItem extends BasePlanItem {
  kind: 'packaging_run';
  /** Working-day integer (1=Mon this week, 6=Mon next week, …). */
  dayInt: number;
  /** Local-ISO derived from `dayInt`, stored so it survives week rollover. */
  scheduledDate: string;
  team?: PackingTeam;
  action: 'CREATE' | 'UPDATE';
  existingAssemblyId?: string;
  /**
   * `true` when this item was born from the Priority workflow (deficit-
   * triggered, operator-approved). The push adapter turns this into a
   * `[SOURCE:priority]` tag in the Unleashed assembly's `comments` and a
   * `[PRIORITY]` prefix in the `productDescription`.
   */
  prioritySource?: boolean;
  /**
   * Sales-order numbers that motivate this item (e.g. `TBC-00027681`,
   * `MF#19406`). Written to the assembly's `comments` as `[SO:<n>]` tags
   * at push time so the ERP record carries its own attribution.
   */
  salesOrders?: string[];
}

// ─── Purchase order ──────────────────────────────────────────

export interface PurchaseOrderItem extends BasePlanItem {
  kind: 'purchase_order';
  /** Local-ISO. When the supplier is expected to deliver. */
  deliveryDate: string;
  supplierId: string;
  supplierName: string;
}

// ─── Transfer ────────────────────────────────────────────────

export interface TransferItem extends BasePlanItem {
  kind: 'transfer';
  /** Local-ISO. When the transfer itself is scheduled to happen. */
  transferDate: string;
  /** Local-ISO. When the destination warehouse needs the stock. */
  needByDate: string;
  fromWarehouse: string;
  toWarehouse: string;
  /**
   * Transfer-specific status: transfers have a confirmation step between
   * draft and push. `lifecycle` tracks commitment, `status` tracks the
   * confirm → push progression.
   */
  status: 'draft' | 'confirmed' | 'pushed';
  reason: string;
  linkedBatchId?: string;
}

// ─── Union + narrowing helpers ───────────────────────────────

export type PlanItem = KitchenRunItem | PackagingRunItem | PurchaseOrderItem | TransferItem;

/** Type-guarded extractor, e.g. `ofKind(items, 'transfer') → TransferItem[]`. */
export function ofKind<K extends PlanItemKind>(
  items: PlanItem[],
  kind: K,
): Extract<PlanItem, { kind: K }>[] {
  return items.filter((i): i is Extract<PlanItem, { kind: K }> => i.kind === kind);
}
