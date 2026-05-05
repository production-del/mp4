/**
 * Warehouse-aware SOH view
 *
 * Single class that replaces the earlier 5-shape `WarehouseSOHMaps` interface.
 * Each consumer previously picked its own combination of map shapes; this API
 * exposes every lookup they need as a method, with the underlying indices
 * built once at construction.
 *
 * The five original maps (byWarehouse, global, perProduct, availByWarehouse,
 * availGlobal) are still built internally — they're the right indices for the
 * questions asked — but consumers no longer reach into the shape.
 */

import type { StockOnHandItem } from '@/lib/unleashed/types';

export class WarehouseSOH {
  /** warehouseName → productCode → on-hand qty */
  private readonly _byWarehouse: Record<string, Record<string, number>> = {};
  /** productCode → total on-hand across warehouses */
  private readonly _global: Record<string, number> = {};
  /** productCode → warehouseName → on-hand qty */
  private readonly _perProduct: Record<string, Record<string, number>> = {};
  /** warehouseName → productCode → available qty (on-hand minus allocated) */
  private readonly _availByWarehouse: Record<string, Record<string, number>> = {};
  /** productCode → total available across warehouses */
  private readonly _availGlobal: Record<string, number> = {};

  constructor(items: StockOnHandItem[]) {
    for (const item of items) {
      const wh = item.warehouseName || '';
      const code = item.productCode;
      const qty = item.quantity;
      const avail = item.availableQty ?? qty;

      if (!this._byWarehouse[wh]) this._byWarehouse[wh] = {};
      this._byWarehouse[wh][code] = (this._byWarehouse[wh][code] || 0) + qty;

      this._global[code] = (this._global[code] || 0) + qty;

      if (!this._perProduct[code]) this._perProduct[code] = {};
      this._perProduct[code][wh] = (this._perProduct[code][wh] || 0) + qty;

      if (!this._availByWarehouse[wh]) this._availByWarehouse[wh] = {};
      this._availByWarehouse[wh][code] = (this._availByWarehouse[wh][code] || 0) + avail;

      this._availGlobal[code] = (this._availGlobal[code] || 0) + avail;
    }
  }

  // ─── Single-value lookups ────────────────────────────────────

  /** On-hand qty of `productCode` at `warehouse`. Returns 0 if missing. */
  atWarehouse(warehouse: string, productCode: string): number {
    return this._byWarehouse[warehouse]?.[productCode] ?? 0;
  }

  /** Available qty (on-hand minus allocated) of `productCode` at `warehouse`. */
  availableAtWarehouse(warehouse: string, productCode: string): number {
    return this._availByWarehouse[warehouse]?.[productCode] ?? 0;
  }

  /** Total on-hand qty of `productCode` across all warehouses. */
  globalOnHand(productCode: string): number {
    return this._global[productCode] ?? 0;
  }

  /** Total available qty of `productCode` across all warehouses. */
  globalAvailable(productCode: string): number {
    return this._availGlobal[productCode] ?? 0;
  }

  // ─── Bulk maps (for batch operations) ────────────────────────

  /** `productCode → on-hand qty` for a specific warehouse. */
  byWarehouseMap(warehouse: string): Record<string, number> {
    return this._byWarehouse[warehouse] ?? {};
  }

  /** `productCode → available qty` for a specific warehouse. */
  availableByWarehouseMap(warehouse: string): Record<string, number> {
    return this._availByWarehouse[warehouse] ?? {};
  }

  /** Global `productCode → on-hand qty`. */
  globalOnHandMap(): Record<string, number> {
    return this._global;
  }

  /** Global `productCode → available qty`. */
  globalAvailableMap(): Record<string, number> {
    return this._availGlobal;
  }

  /** `warehouseName → qty` for a single product. */
  perProduct(productCode: string): Record<string, number> {
    return this._perProduct[productCode] ?? {};
  }

  /** Full `productCode → warehouseName → qty`. */
  perProductMap(): Record<string, Record<string, number>> {
    return this._perProduct;
  }

  // ─── Iteration helpers ───────────────────────────────────────

  /** All warehouse names we have SOH data for. */
  warehouses(): string[] {
    return Object.keys(this._byWarehouse);
  }

  /**
   * On-hand for the warehouse if any data is present, else fall back to global
   * totals. Used when a consumer needs warehouse-specific data but wants to
   * degrade gracefully when the Unleashed response is aggregated across
   * warehouses (all items tagged with an empty warehouse name).
   */
  byWarehouseOrGlobalMap(warehouse: string): Record<string, number> {
    const perWh = this._byWarehouse[warehouse];
    return perWh && Object.keys(perWh).length > 0 ? perWh : this._global;
  }

  /**
   * Deep clone of the by-warehouse × on-hand indices, suitable for engines
   * that need to mutate a running balance without disturbing this view.
   */
  cloneMutableBalances(): Record<string, Record<string, number>> {
    const out: Record<string, Record<string, number>> = {};
    for (const [wh, products] of Object.entries(this._byWarehouse)) {
      out[wh] = { ...products };
    }
    return out;
  }
}
