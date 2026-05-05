import { NextRequest, NextResponse } from "next/server";
import {
  serverFetchPlannerProducts,
  serverFetchSuppliers,
  serverFetchOpenAssemblies,
} from "@/lib/unleashed/server";
import { fetchSOHWithFallback } from "@/lib/unleashed/fetch-soh";
import type {
  StockOnHandItem,
  Product,
  Supplier,
  Assembly,
  Warehouse,
} from "@/lib/unleashed/types";

interface ProductsDataPayload {
  sohItems: StockOnHandItem[];
  products: Product[];
  suppliers: Supplier[];
  assemblies: Assembly[];
  warehouses: Warehouse[];
  cachedAt: string;
}

let cache: ProductsDataPayload | null = null;
let cacheExpiry = 0;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export async function GET(request: NextRequest) {
  const forceRefresh = request.nextUrl.searchParams.get("refresh") === "true";

  if (!forceRefresh && cache && Date.now() < cacheExpiry) {
    return NextResponse.json({ success: true, data: cache, fromCache: true });
  }

  try {
    const [{ sohItems, warehouses }, products, suppliers, assemblies] = await Promise.all([
      fetchSOHWithFallback(),
      serverFetchPlannerProducts(), // TBC-grouped SKUs excluded
      serverFetchSuppliers(),
      serverFetchOpenAssemblies(), // TBC-grouped assemblies excluded at source
    ]);

    const payload: ProductsDataPayload = {
      sohItems,
      products,
      suppliers,
      assemblies,
      warehouses,
      cachedAt: new Date().toISOString(),
    };

    cache = payload;
    cacheExpiry = Date.now() + CACHE_TTL_MS;

    return NextResponse.json({ success: true, data: payload, fromCache: false });
  } catch (err) {
    console.error("[products-data] Error:", err);
    if (cache) {
      return NextResponse.json({ success: true, data: cache, fromCache: true, stale: true });
    }
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
