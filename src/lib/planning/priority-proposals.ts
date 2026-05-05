/**
 * Priority proposals selector.
 *
 * Given the current packaging SKU snapshot, the per-product priority flags,
 * global settings, and sales-order attribution data, compute the list of
 * rows to show on the Priorities page. Pure function — no IO, no state.
 *
 * A row exists when ALL of:
 *   - Flag is enabled for the product.
 *   - `availableStock` is at or below the configured deficit threshold
 *     (default 0 — only over-allocated products trigger).
 *   - Food component exists globally in positive quantity (otherwise the
 *     kitchen needs to produce more first — that's not a priority job).
 *
 * Each proposal carries both the "deficit" (exact shortfall) and
 * "suggested" (target-days coverage) numbers, so the operator can see what
 * a conservative vs aggressive refill looks like before committing. The
 * editable `proposedQty` starts at the deficit per approved plan.
 *
 * Transfer suggestion: when feasibility is amber (intermediate exists
 * globally but not at MF Packaging), we pick the first warehouse from the
 * settings' `transferSourcePreference` that has enough stock, and emit a
 * transfer recommendation of exactly the required kg.
 */

import type { PackagingSKU } from '@/app/packaging/hooks/usePackagingData';
import type { PriorityFlag } from './priority-flags';
import type { PrioritySettings } from './priority-settings';
import type { SalesOrderAttribution } from '@/app/api/sales-orders/route';
import { computePackagingFeasibility } from './packaging-feasibility';
import type { WarehouseSOH } from './warehouse-soh';

export interface PriorityProposal {
  productCode: string;
  productName: string;
  familyCode: string;
  familyName: string;
  sizeVariant: string;

  /** Current available stock (can be negative — that's the trigger). */
  availableStock: number;
  /** `|availableStock|` clipped at zero — what the proposal defaults to. */
  deficitQty: number;
  /** Target-days coverage minus available — what the Packaging Plan would suggest. */
  suggestedQty: number;
  /** Ceiling: floor(foodComponentSOHGlobal / kgPerUnit). `Infinity` if no kg requirement. */
  ingredientLimitQty: number;
  /** Required intermediate kg at proposed qty. */
  requiredKgForDeficit: number;

  /** Feasibility of proposing a run of `deficitQty`. */
  feasibility: 'green' | 'amber' | 'red';
  feasibilityReason?: string;

  /** Present when feasibility is amber. */
  transferSource?: string;
  transferKg?: number;

  foodComponentCode: string;
  kgPerUnit: number;

  /** Sales-order lines that motivate this proposal, sorted by urgency. */
  salesOrders: SalesOrderAttribution[];
}

export interface BuildProposalsArgs {
  skus: PackagingSKU[];
  flags: Record<string, PriorityFlag>;
  settings: PrioritySettings;
  /** Keyed by productCode. */
  salesOrdersByProduct: Record<string, SalesOrderAttribution[]>;
  /** Used to pick a concrete warehouse source for amber-state transfers. */
  soh: WarehouseSOH;
  /** Where packaging happens — the transfer destination. */
  packagingWarehouse: string;
}

export function buildPriorityProposals(args: BuildProposalsArgs): PriorityProposal[] {
  const { skus, flags, settings, salesOrdersByProduct, soh, packagingWarehouse } = args;
  const out: PriorityProposal[] = [];

  for (const sku of skus) {
    const flag = flags[sku.productCode];
    if (!flag?.enabled) continue;
    if (sku.availableStock > settings.deficitThreshold) continue;
    if (sku.foodComponentSOHGlobal <= 0) continue;

    const deficitQty = Math.max(0, -sku.availableStock);
    if (deficitQty <= 0) continue;

    const feas = computePackagingFeasibility(sku, deficitQty);

    const ingredientLimitQty =
      sku.kgPerUnit > 0 ? Math.floor(sku.foodComponentSOHGlobal / sku.kgPerUnit) : Number.POSITIVE_INFINITY;

    let transferSource: string | undefined;
    let transferKg: number | undefined;
    if (feas.state === 'amber' && sku.foodComponentCode && sku.kgPerUnit > 0) {
      const requiredKg = deficitQty * sku.kgPerUnit;
      // Walk the preferred source list; first with enough stock wins.
      for (const candidate of settings.transferSourcePreference) {
        if (candidate === packagingWarehouse) continue;
        const avail = soh.atWarehouse(candidate, sku.foodComponentCode);
        if (avail >= requiredKg) {
          transferSource = candidate;
          transferKg = requiredKg;
          break;
        }
      }
      // Fallback: any warehouse that has positive stock, highest wins.
      if (!transferSource) {
        const perWh = soh.perProduct(sku.foodComponentCode);
        const best = Object.entries(perWh)
          .filter(([wh]) => wh !== packagingWarehouse)
          .sort(([, a], [, b]) => b - a)[0];
        if (best && best[1] > 0) {
          transferSource = best[0];
          transferKg = Math.min(best[1], requiredKg);
        }
      }
    }

    out.push({
      productCode: sku.productCode,
      productName: sku.productName,
      familyCode: sku.familyCode,
      familyName: sku.familyName,
      sizeVariant: sku.sizeVariant,
      availableStock: sku.availableStock,
      deficitQty,
      suggestedQty: sku.suggestedQty,
      ingredientLimitQty,
      requiredKgForDeficit: deficitQty * (sku.kgPerUnit || 0),
      feasibility: feas.state,
      feasibilityReason: feas.reason,
      transferSource,
      transferKg,
      foodComponentCode: sku.foodComponentCode,
      kgPerUnit: sku.kgPerUnit,
      salesOrders: salesOrdersByProduct[sku.productCode] ?? [],
    });
  }

  // Most urgent first: largest deficit wins. Ties broken by product code for stability.
  out.sort((a, b) => b.deficitQty - a.deficitQty || a.productCode.localeCompare(b.productCode));
  return out;
}
