/**
 * Warehouse Assignments — planning warehouse per product
 *
 * Every product has a "planning warehouse": the warehouse against which
 * SOH projections should run for that product in its primary planning context.
 *
 * Auto-assignment logic:
 *   - Intermediates → Lundberg Storeroom (production happens here)
 *   - Finished Goods (MF/BF prefix) → MF Packaging (packed and dispatched here)
 *   - Labels (L prefix) → MF Packaging
 *   - Components / raw materials → warehouse with highest current SOH
 *
 * User overrides persist to localStorage and take precedence over auto-assignment.
 */

import { INTERMEDIATE_REGISTRY } from '@/app/kitchen/data/intermediate-registry';

// ─── Constants ─────────────────────────────────────────────────

/** Canonical warehouse names from Unleashed */
export const WAREHOUSES = {
  LUNDBERG: 'Lundberg Storeroom',
  MF_PACKAGING: 'MF Packaging',
  MF_OPERATIONS: 'MF Operations',
  TBC: 'TBC',
  TBC_HEIGHT: 'TBC Height',
} as const;

export type WarehouseName = typeof WAREHOUSES[keyof typeof WAREHOUSES];

const STORAGE_KEY = 'byron-planning-warehouse-assignments';

// ─── Types ─────────────────────────────────────────────────────

export interface WarehouseAssignment {
  warehouseName: string;
  isOverride: boolean;       // true if user manually set this
  autoReason: string;        // why auto-assigned (for tooltip)
}

export type WarehouseAssignmentMap = Record<string, WarehouseAssignment>;

// ─── Auto-assignment ───────────────────────────────────────────

type ProductClassification = 'intermediate' | 'fg' | 'label' | 'component';

function classifyProduct(code: string): ProductClassification {
  if (code in INTERMEDIATE_REGISTRY) return 'intermediate';
  if (code.startsWith('L') && code.length > 1) return 'label';
  if (code.startsWith('MF') || code.startsWith('BF')) return 'fg';
  return 'component';
}

/**
 * Determine the default planning warehouse for a product.
 *
 * @param code         Product code
 * @param warehouseSOH Per-warehouse SOH for this product: { warehouseName: qty }
 */
export function computeDefaultWarehouse(
  code: string,
  warehouseSOH: Record<string, number>,
): WarehouseAssignment {
  const type = classifyProduct(code);

  switch (type) {
    case 'intermediate':
      return {
        warehouseName: WAREHOUSES.LUNDBERG,
        isOverride: false,
        autoReason: 'Intermediate — produced at Lundberg Storeroom',
      };

    case 'fg':
      return {
        warehouseName: WAREHOUSES.MF_PACKAGING,
        isOverride: false,
        autoReason: 'Finished good — packed at MF Packaging',
      };

    case 'label':
      return {
        warehouseName: WAREHOUSES.MF_PACKAGING,
        isOverride: false,
        autoReason: 'Label — used at MF Packaging',
      };

    case 'component': {
      // Default to the warehouse with highest SOH for this component
      let bestWh: string = WAREHOUSES.TBC;
      let bestQty = -1;
      for (const [wh, qty] of Object.entries(warehouseSOH)) {
        if (qty > bestQty) {
          bestQty = qty;
          bestWh = wh;
        }
      }

      // If no SOH anywhere, default to TBC (main receiving warehouse)
      if (bestQty <= 0) {
        return {
          warehouseName: WAREHOUSES.TBC,
          isOverride: false,
          autoReason: 'Component — no SOH, defaulted to TBC',
        };
      }

      return {
        warehouseName: bestWh,
        isOverride: false,
        autoReason: `Component — highest SOH at ${bestWh} (${Math.round(bestQty)})`,
      };
    }
  }
}

// ─── Persistence ───────────────────────────────────────────────

/** Load user overrides from localStorage */
export function loadOverrides(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

/** Save a single override */
export function saveOverride(productCode: string, warehouseName: string): void {
  if (typeof window === 'undefined') return;
  const overrides = loadOverrides();
  overrides[productCode] = warehouseName;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
}

/** Remove a single override (revert to auto-assignment) */
export function removeOverride(productCode: string): void {
  if (typeof window === 'undefined') return;
  const overrides = loadOverrides();
  delete overrides[productCode];
  localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
}

// ─── Bulk assignment builder ───────────────────────────────────

/**
 * Build the full assignment map for a set of product codes.
 *
 * @param codes          All product codes
 * @param perProductSOH  Per-product, per-warehouse SOH: { productCode: { warehouseName: qty } }
 */
export function buildAssignmentMap(
  codes: string[],
  perProductSOH: Record<string, Record<string, number>>,
): WarehouseAssignmentMap {
  const overrides = loadOverrides();
  const map: WarehouseAssignmentMap = {};

  for (const code of codes) {
    if (overrides[code]) {
      map[code] = {
        warehouseName: overrides[code],
        isOverride: true,
        autoReason: '',
      };
    } else {
      map[code] = computeDefaultWarehouse(code, perProductSOH[code] || {});
    }
  }

  return map;
}

/**
 * Get the planning warehouse for a single product code.
 * Uses override if set, otherwise computes default.
 */
export function getPlanningWarehouse(
  code: string,
  warehouseSOH: Record<string, number>,
): string {
  const overrides = loadOverrides();
  if (overrides[code]) return overrides[code];
  return computeDefaultWarehouse(code, warehouseSOH).warehouseName;
}
