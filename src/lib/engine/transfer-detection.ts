/**
 * Transfer Gap Detection Engine
 *
 * Identifies components/intermediates that are short at the target warehouse
 * but available elsewhere, producing TransferGap records for the Logistics Planner.
 *
 * Kitchen batches need ingredients at Lundberg Storeroom.
 * Packaging runs need intermediates at MF Packaging.
 *
 * For each demand event we check:
 *   1. Is there enough stock at the destination warehouse? If yes, no gap.
 *   2. Is there stock at other warehouses? If yes, produce a TransferGap.
 */

import type { TransferGap } from '@/lib/planning/transfer-types';
import type { WarehouseSOH } from '@/lib/planning/warehouse-soh';
import { WAREHOUSES } from '@/lib/planning/warehouse-assignments';
import type { Assembly } from '@/lib/unleashed/types';
import type { KitchenBatch } from '@/lib/planning/engine-io';
import { INTERMEDIATE_REGISTRY } from '@/app/kitchen/data/intermediate-registry';

// ─── Types for demand inputs ──────────────────────────────

export interface KitchenDemandItem {
  batchId: string;
  batchName: string;
  componentCode: string;
  componentName: string;
  quantityNeeded: number;
  scheduledDate: Date;
}

export interface PackagingDemandItem {
  runId: string;
  runName: string;
  /** The INPUT needed (intermediate OR packaging material: label/jar/lid/box/…). */
  productCode: string;
  productName: string;
  quantityNeeded: number;
  scheduledDate: Date;
  /**
   * Warehouse where the packaging run happens (= where this input must be).
   * Derived from the assembly's own warehouse. Bottlo runs are at
   * MF Operations; all other packaging stations are at MF Packaging — but
   * we read the assembly's `warehouseName` directly rather than re-deriving
   * from the station, since Unleashed already records where it's assembled.
   * Falls back to MF Packaging when absent.
   */
  destinationWarehouse: string;
}

/**
 * Build packaging-run input demands from Unleashed FG assemblies.
 *
 * A packaging assembly's `assemblyLines` ARE its full depth-1 BOM — the
 * intermediate(s) PLUS every packaging material (label, jar, lid, box,
 * strip, foam …). Each line becomes a demand for that input at the
 * warehouse where the assembly is built, so the transfer detector can flag
 * any input that's sitting in the wrong warehouse for the run's date.
 *
 * Intermediate assemblies (kitchen batches) are skipped — those are handled
 * by the kitchen-demand path, whose destination is Lundberg Storeroom.
 *
 * @param assemblies         all open assemblies (incl. FG/packaging ones)
 * @param isIntermediate     predicate: is this productCode a kitchen intermediate?
 * @param fallbackWarehouse  destination when an assembly has no warehouse
 */
export function extractPackagingDemands(
  assemblies: Assembly[],
  isIntermediate: (code: string) => boolean,
  fallbackWarehouse: string,
): PackagingDemandItem[] {
  const demands: PackagingDemandItem[] = [];

  for (const assembly of assemblies) {
    // Skip kitchen batches — those go through the kitchen-demand path.
    if (isIntermediate(assembly.productCode)) continue;

    const scheduledDate = new Date(
      assembly.assembleBy || assembly.lastModifiedOn || assembly.createdOn,
    );
    const destinationWarehouse = assembly.warehouseName || fallbackWarehouse;

    for (const line of assembly.assemblyLines) {
      if (!line.productCode || line.componentQuantity <= 0) continue;
      demands.push({
        runId: assembly.assemblyId,
        runName: `${assembly.productCode} - ${assembly.productName}`,
        productCode: line.productCode,
        productName: line.productDescription || line.productCode,
        quantityNeeded: line.componentQuantity,
        scheduledDate,
        destinationWarehouse,
      });
    }
  }

  return demands;
}

// ─── Kitchen demand extraction ────────────────────────────

/**
 * Extract component demands from Unleashed assemblies (kitchen batches).
 * Each assembly line is a demand for that component at Lundberg Storeroom.
 */
export function extractKitchenDemands(assemblies: Assembly[]): KitchenDemandItem[] {
  const demands: KitchenDemandItem[] = [];

  for (const assembly of assemblies) {
    // Only process intermediate assemblies (kitchen batches)
    const isIntermediate = assembly.productCode in INTERMEDIATE_REGISTRY;
    if (!isIntermediate) continue;

    const scheduledDate = new Date(assembly.lastModifiedOn || assembly.createdOn);

    for (const line of assembly.assemblyLines) {
      demands.push({
        batchId: assembly.assemblyId,
        batchName: `${assembly.productCode} - ${assembly.productName}`,
        componentCode: line.productCode,
        componentName: line.productDescription,
        quantityNeeded: line.componentQuantity,
        scheduledDate,
      });
    }
  }

  return demands;
}

/**
 * Extract demands from the purchasing planner's consumption schedule.
 * This covers kitchen batches derived from assemblies via usePurchasingData.
 */
export function extractKitchenDemandsFromSchedule(
  consumptionSchedule: Record<string, KitchenBatch[]>,
): KitchenDemandItem[] {
  const demands: KitchenDemandItem[] = [];

  for (const [componentCode, batches] of Object.entries(consumptionSchedule)) {
    for (const batch of batches) {
      demands.push({
        batchId: batch.id,
        batchName: batch.productName || batch.productCode,
        componentCode,
        componentName: batch.productName || componentCode,
        quantityNeeded: batch.quantity,
        scheduledDate: batch.scheduledDate,
      });
    }
  }

  return demands;
}

// ─── Gap detection ────────────────────────────────────────

interface DetectGapsOptions {
  soh: WarehouseSOH;
  kitchenDemands: KitchenDemandItem[];
  packagingDemands: PackagingDemandItem[];
  /** Product names for display (code -> name) */
  productNames?: Record<string, string>;
}

/**
 * Detect transfer gaps: stock needed at one warehouse but sitting at another.
 *
 * Aggregates demands by (productCode, destinationWarehouse) and compares
 * against per-warehouse SOH to find shortfalls that could be resolved
 * by internal transfers.
 */
export function detectTransferGaps(options: DetectGapsOptions): TransferGap[] {
  const { soh, kitchenDemands, packagingDemands, productNames } = options;
  const gaps: TransferGap[] = [];

  // Track running available qty at each warehouse as we allocate
  // (so multiple demands for the same component don't double-count SOH)
  const availableAt = soh.cloneMutableBalances();

  function getAvailable(warehouse: string, code: string): number {
    return availableAt[warehouse]?.[code] || 0;
  }

  function consumeAt(warehouse: string, code: string, qty: number): void {
    if (!availableAt[warehouse]) availableAt[warehouse] = {};
    availableAt[warehouse][code] = (availableAt[warehouse][code] || 0) - qty;
  }

  // Merge all demands into a single sorted list (earliest first)
  type DemandEntry = {
    productCode: string;
    productName: string;
    destinationWarehouse: string;
    quantityNeeded: number;
    scheduledDate: Date;
    demandSource: TransferGap['demandSource'];
  };

  const allDemands: DemandEntry[] = [];

  // Kitchen demands → destination is Lundberg Storeroom
  for (const d of kitchenDemands) {
    allDemands.push({
      productCode: d.componentCode,
      productName: productNames?.[d.componentCode] || d.componentName,
      destinationWarehouse: WAREHOUSES.LUNDBERG,
      quantityNeeded: d.quantityNeeded,
      scheduledDate: d.scheduledDate,
      demandSource: {
        type: 'kitchen_batch',
        id: d.batchId,
        name: d.batchName,
        date: d.scheduledDate,
      },
    });
  }

  // Packaging demands → destination is the run's own warehouse
  // (Bottlo = MF Operations; all other stations = MF Packaging — read
  // from the assembly rather than re-derived).
  for (const d of packagingDemands) {
    allDemands.push({
      productCode: d.productCode,
      productName: productNames?.[d.productCode] || d.productName,
      destinationWarehouse: d.destinationWarehouse || WAREHOUSES.MF_PACKAGING,
      quantityNeeded: d.quantityNeeded,
      scheduledDate: d.scheduledDate,
      demandSource: {
        type: 'packaging_run',
        id: d.runId,
        name: d.runName,
        date: d.scheduledDate,
      },
    });
  }

  // Sort by date (earliest first) for correct sequential allocation
  allDemands.sort((a, b) => a.scheduledDate.getTime() - b.scheduledDate.getTime());

  // Aggregate demands by (productCode + destinationWarehouse + date) to avoid
  // producing one gap per assembly line when multiple assemblies consume the same component
  const aggregated = new Map<string, DemandEntry & { totalNeeded: number }>();

  for (const demand of allDemands) {
    const dateKey = demand.scheduledDate.toISOString().slice(0, 10);
    const key = `${demand.productCode}|${demand.destinationWarehouse}|${dateKey}`;

    const existing = aggregated.get(key);
    if (existing) {
      existing.totalNeeded += demand.quantityNeeded;
    } else {
      aggregated.set(key, { ...demand, totalNeeded: demand.quantityNeeded });
    }
  }

  // Process each aggregated demand
  for (const demand of aggregated.values()) {
    const destQty = getAvailable(demand.destinationWarehouse, demand.productCode);

    if (destQty >= demand.totalNeeded) {
      // Enough stock at destination — consume it and move on
      consumeAt(demand.destinationWarehouse, demand.productCode, demand.totalNeeded);
      continue;
    }

    // Shortfall at destination
    const shortfall = demand.totalNeeded - Math.max(0, destQty);

    // Consume whatever is available at the destination
    if (destQty > 0) {
      consumeAt(demand.destinationWarehouse, demand.productCode, destQty);
    }

    // Check other warehouses for source options
    const sourceOptions: { warehouse: string; available: number }[] = [];
    for (const [wh, products] of Object.entries(availableAt)) {
      if (wh === demand.destinationWarehouse) continue;
      const available = products[demand.productCode] || 0;
      if (available > 0) {
        sourceOptions.push({ warehouse: wh, available: Math.round(available * 100) / 100 });
      }
    }

    // Only create a gap if there IS stock elsewhere to transfer from
    if (sourceOptions.length > 0) {
      // Sort sources by available qty descending (best source first)
      sourceOptions.sort((a, b) => b.available - a.available);

      gaps.push({
        productCode: demand.productCode,
        productName: demand.productName,
        destinationWarehouse: demand.destinationWarehouse,
        needByDate: demand.scheduledDate,
        quantityNeeded: Math.round(shortfall * 100) / 100,
        sourceOptions,
        demandSource: demand.demandSource,
      });
    }
  }

  return gaps;
}
