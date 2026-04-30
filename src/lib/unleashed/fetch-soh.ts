/**
 * SOH fetch with automatic per-warehouse fallback.
 *
 * Unleashed's /StockOnHand endpoint intermittently returns items with empty
 * `warehouseName` fields (aggregated SOH). When that happens, we can't
 * distinguish which warehouse holds which stock, breaking all per-warehouse
 * planning (kitchen feasibility, packaging allocation, transfer detection).
 *
 * This helper centralises the workaround previously duplicated in three API
 * routes: detect the missing data and fall back to one fetch per warehouse,
 * tagging each item with its warehouse identity.
 */

import {
  serverFetchStockOnHand,
  serverFetchWarehouses,
} from "./server";
import type { StockOnHandItem, Warehouse } from "./types";

interface FetchResult {
  sohItems: StockOnHandItem[];
  warehouses: Warehouse[];
}

/**
 * Fetch SOH, guaranteed to have populated warehouse fields.
 *
 * Strategy:
 *   1. Fetch all-warehouses SOH.
 *   2. If every item lacks a warehouse name (Unleashed bug), re-fetch per
 *      warehouse and tag each item with its warehouse's id + name.
 *   3. Return both the tagged items and the warehouses list (callers usually
 *      need it anyway for other purposes).
 */
export async function fetchSOHWithFallback(): Promise<FetchResult> {
  const [sohItemsRaw, warehouses] = await Promise.all([
    serverFetchStockOnHand(),
    serverFetchWarehouses(),
  ]);

  const hasWarehouseData = sohItemsRaw.some((s) => s.warehouseName);
  if (hasWarehouseData || warehouses.length === 0) {
    return { sohItems: sohItemsRaw, warehouses };
  }

  const perWarehouse = await Promise.all(
    warehouses.map(async (wh) => {
      const items = await serverFetchStockOnHand(wh.warehouseCode);
      return items.map((item) => ({
        ...item,
        warehouseId: wh.warehouseId,
        warehouseName: wh.warehouseName,
      }));
    }),
  );

  return { sohItems: perWarehouse.flat(), warehouses };
}
