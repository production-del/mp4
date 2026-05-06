import { NextRequest, NextResponse } from "next/server";
import {
  serverFetchStockOnHand,
  serverFetchPurchaseOrdersByStatus,
  serverFetchOpenAssemblies,
  serverFetchSuppliers,
  serverFetchPlannerProducts,
} from "@/lib/unleashed/server";
import type {
  StockOnHandItem,
  PurchaseOrder,
  Assembly,
  Supplier,
  Product,
} from "@/lib/unleashed/types";

interface PurchasingDataPayload {
  sohItems: StockOnHandItem[];
  openPOs: PurchaseOrder[];
  partialPOs: PurchaseOrder[];
  assemblies: Assembly[];
  suppliers: Supplier[];
  products: Product[];
  cachedAt: string;
}

// Composite cache — individual fetches are cached + dedup'd in server.ts
let cache: PurchasingDataPayload | null = null;
let cacheExpiry = 0;
let isRefreshing = false;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function refreshCache(): Promise<void> {
  if (isRefreshing) return;
  isRefreshing = true;
  try {
    // All individual fetches are cached + dedup'd in server.ts:
    // - SOH: 5 min cache + dedup
    // - Products: 2h cache + dedup
    // - Suppliers: 2h cache + dedup
    // - Assemblies: 5 min cache + dedup
    // - POs: dedup (no local cache — fast endpoints)
    const [sohItems, openPOs, partialPOs, assemblies, products, suppliers] =
      await Promise.all([
        serverFetchStockOnHand(),
        serverFetchPurchaseOrdersByStatus("Open"),
        serverFetchPurchaseOrdersByStatus("PartiallyReceived"),
        serverFetchOpenAssemblies(), // already TBC-filtered at source
        serverFetchPlannerProducts(), // TBC-grouped SKUs excluded
        serverFetchSuppliers(),
      ]);

    cache = {
      sohItems,
      openPOs,
      partialPOs,
      assemblies,
      suppliers,
      products,
      cachedAt: new Date().toISOString(),
    };
    cacheExpiry = Date.now() + CACHE_TTL_MS;
  } finally {
    isRefreshing = false;
  }
}

export async function GET(request: NextRequest) {
  const forceRefresh = request.nextUrl.searchParams.get("refresh") === "true";

  // Fresh cache — return immediately
  if (!forceRefresh && cache && Date.now() < cacheExpiry) {
    return NextResponse.json({ success: true, data: cache, fromCache: true });
  }

  // Stale cache — return stale data immediately, refresh in background
  if (!forceRefresh && cache) {
    void refreshCache();
    return NextResponse.json({ success: true, data: cache, fromCache: true, stale: true });
  }

  try {
    await refreshCache();
    return NextResponse.json({ success: true, data: cache, fromCache: false });
  } catch (error) {
    console.error("Purchasing data fetch error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to fetch data",
      },
      { status: 500 }
    );
  }
}
