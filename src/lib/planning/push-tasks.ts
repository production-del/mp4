/**
 * Push task builders — one function per PlanItem variant.
 *
 * Every planner's push flow used to live in its own dialog component: three
 * copies of a 3-phase state machine, two page-local payload builders. Now
 * each variant contributes a list of `PushTask`s, which the shared
 * `PushPlanDialog` iterates uniformly.
 *
 * A `PushTask` is the unit the dialog advances through: one label, one
 * `run()` call, and the `PlanItem` ids it covers (so the caller can mark
 * them pushed when the task succeeds).
 *
 * Purchasing batches multiple PO items into one Unleashed PO (grouped by
 * supplier), so one task there covers many items. Kitchen and packaging
 * push one assembly per item.
 */

import type {
  PackagingRunItem,
  KitchenRunItem,
  PurchaseOrderItem,
} from './plan-item';
import type { AssemblyCreatePayload, AssemblyLine } from '@/lib/unleashed/types';
import { pushAssembly, pushPurchaseOrder, updateAssembly } from '@/lib/unleashed/client';
import { writeAssemblyMeta } from './assembly-meta';

// ─── Task shape ────────────────────────────────────────────

export interface PushTask {
  /** Unique id for React keys + result tracking. */
  id: string;
  /** Kind label shown in the dialog ("Kitchen Batch", "Packaging Assembly", …). */
  variantLabel: string;
  /** User-visible line (product name + qty). */
  label: string;
  /** PlanItem ids this task covers — used to mark pushed on success. */
  itemIds: string[];
  /** Execute the push. Throws on failure. */
  run: () => Promise<void>;
}

// ─── Kitchen ───────────────────────────────────────────────

export interface KitchenPushContext {
  warehouseId: string;
  warehouseName: string;
  /**
   * Optional: `assemblyId → intermediate config`. When provided, assembly
   * lines are included explicitly. When a given intermediate is missing (or
   * the whole map is absent — e.g., Review Drafts has no kitchen context),
   * the task sends an empty `assemblyLines` array and Unleashed resolves the
   * BOM from the saved definition.
   */
  intermediates?: Record<
    string,
    { name: string; components: Record<string, number> }
  >;
}

/** One push task per kitchen batch; payload mirrors the old `buildAssemblyPayload`. */
export function buildKitchenPushTasks(
  items: KitchenRunItem[],
  ctx: KitchenPushContext,
): PushTask[] {
  return items.map((item) => {
    const intermediate = ctx.intermediates?.[item.intermediateKey];
    const label = `${item.productName || item.productCode} (${item.quantity}kg)`;

    return {
      id: `kitchen:${item.id}`,
      variantLabel: 'Kitchen Batch',
      label,
      itemIds: [item.id],
      async run() {
        const assemblyLines: AssemblyLine[] = intermediate
          ? Object.entries(intermediate.components).map(
              ([productCode, quantityPerParent], index) => ({
                lineNumber: index + 1,
                productCode,
                productDescription: productCode,
                quantityPerParent,
                warehouseCode: 'LB',
                componentQuantity: quantityPerParent * item.quantity,
              }),
            )
          : [];
        const payload: AssemblyCreatePayload = {
          productId: '',
          productCode: item.productCode,
          productName: item.productName,
          productDescription: `Kitchen batch: ${item.productName} (${item.quantity}kg)`,
          quantity: item.quantity,
          warehouseId: ctx.warehouseId,
          warehouseName: ctx.warehouseName,
          assemblyLines,
        };
        await pushAssembly(payload);
      },
    };
  });
}

// ─── Packaging ─────────────────────────────────────────────

export interface PackagingPushContext {
  warehouseId: string;
  warehouseName: string;
  /**
   * Optional: `productCode → SKU metadata` for assembly-line generation
   * (food component + kg/unit) plus existing-assembly context for UPDATE.
   * When absent (Review Drafts has no packaging SKU context), CREATE tasks
   * send an empty `assemblyLines` array and Unleashed resolves the BOM from
   * the saved definition.
   */
  skus?: Map<
    string,
    {
      productName: string;
      familyName: string;
      foodComponentCode: string;
      kgPerUnit: number;
      /** Unleashed Guid of the existing assembly; required for UPDATE actions. */
      existingAssemblyId?: string;
      /** Current `comments` string from Unleashed, so we can preserve human notes. */
      existingAssemblyNotes?: string;
    }
  >;
}

/** One push task per packaging assembly; handles both CREATE and UPDATE variants. */
export function buildPackagingPushTasks(
  items: PackagingRunItem[],
  ctx: PackagingPushContext,
): PushTask[] {
  return items.map((item) => {
    const sku = ctx.skus?.get(item.productCode);
    const displayName = sku?.productName || item.productName || item.productCode;
    const actionLabel = item.action === 'UPDATE' ? 'UPDATE' : 'CREATE';
    const priorityTag = item.prioritySource ? ' [PRIORITY]' : '';
    const label = `[${actionLabel}]${priorityTag} ${displayName} (${item.quantity} units)`;
    const isUpdate = item.action === 'UPDATE';

    return {
      id: `packaging:${item.id}`,
      variantLabel: item.prioritySource ? 'Priority Packaging' : 'Packaging Assembly',
      label,
      itemIds: [item.id],
      async run() {
        // Encode team + source + SO attribution into assembly comments. Human
        // notes are preserved; our tags render as a stable trailing block.
        const comments = writeAssemblyMeta(sku?.existingAssemblyNotes, {
          team: item.team,
          source: item.prioritySource ? 'priority' : undefined,
          salesOrders: item.salesOrders,
        });

        if (isUpdate) {
          const assemblyId = item.existingAssemblyId || sku?.existingAssemblyId;
          if (!assemblyId) {
            throw new Error('Missing existingAssemblyId for UPDATE');
          }
          // Only send the fields we're actually changing. Quantity and
          // comments are safe to PUT; leaving assemblyLines out preserves the
          // existing BOM.
          await updateAssembly(assemblyId, {
            quantity: item.quantity,
            comments,
          });
          return;
        }

        const assemblyLines: AssemblyLine[] = sku
          ? [
              {
                lineNumber: 1,
                productCode: sku.foodComponentCode,
                productDescription: sku.familyName,
                quantityPerParent: sku.kgPerUnit,
                warehouseCode: '',
                componentQuantity: item.quantity * sku.kgPerUnit,
              },
            ]
          : [];
        // `[PRIORITY]` prefix on the human-visible description gives ops a
        // searchable marker in Unleashed's own UI, where our machine tags
        // are less prominent.
        const description = item.prioritySource
          ? `[PRIORITY] Packaging: ${displayName} (${item.quantity} units)`
          : `Packaging: ${displayName} (${item.quantity} units)`;
        const payload: AssemblyCreatePayload = {
          productId: '',
          productCode: item.productCode,
          productName: displayName,
          productDescription: description,
          quantity: item.quantity,
          warehouseId: ctx.warehouseId,
          warehouseName: ctx.warehouseName,
          assemblyLines,
          // Comments carry the team/source/SO tags for the newly created assembly.
          comments: comments || undefined,
        };
        await pushAssembly(payload);
      },
    };
  });
}

// ─── Purchase orders ───────────────────────────────────────

/**
 * Purchase orders batch differently: all drafts for a single supplier become
 * one PO with many lines. So `N` PO items → `M` tasks where `M` = unique
 * suppliers. Each task covers every item id for that supplier.
 */
export function buildPurchaseOrderPushTasks(
  items: PurchaseOrderItem[],
): PushTask[] {
  const bySupplier = new Map<string, PurchaseOrderItem[]>();
  for (const item of items) {
    const key = item.supplierId || 'unassigned';
    const list = bySupplier.get(key) ?? [];
    list.push(item);
    bySupplier.set(key, list);
  }

  const tasks: PushTask[] = [];
  for (const [supplierId, group] of bySupplier) {
    const supplierName = group[0]?.supplierName || 'Unassigned';
    const label = `${supplierName} (${group.length} line${group.length !== 1 ? 's' : ''})`;
    const firstDelivery = group[0]?.deliveryDate || '';

    tasks.push({
      id: `po:${supplierId}`,
      variantLabel: 'Purchase Order',
      label,
      itemIds: group.map((g) => g.id),
      async run() {
        const poId =
          (typeof crypto !== 'undefined' && 'randomUUID' in crypto
            ? crypto.randomUUID()
            : `po-${Date.now()}`);
        await pushPurchaseOrder({
          purchaseOrderId: poId,
          purchaseOrderNumber: '',
          supplierId,
          supplierName,
          supplierCode: '',
          orderedDate: new Date().toISOString().slice(0, 10),
          requiredDate: firstDelivery,
          expectedDeliveryDate: firstDelivery,
          status: 'Open',
          orderTotal: 0,
          purchaseOrderLines: group.map((d, idx) => ({
            lineNumber: idx + 1,
            productCode: d.productCode,
            productDescription: d.productName,
            quantityOrdered: d.quantity,
            quantityReceived: 0,
            unitAmount: 0,
            lineTotal: 0,
            expectedDeliveryDate: d.deliveryDate,
          })),
        });
      },
    });
  }

  return tasks;
}
