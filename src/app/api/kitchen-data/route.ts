import { NextRequest, NextResponse } from "next/server";
import {
  serverFetchOpenAssembliesByGroup,
  serverFetchPurchaseOrdersByStatus,
} from "@/lib/unleashed/server";
import { fetchSOHWithFallback } from "@/lib/unleashed/fetch-soh";
import type {
  StockOnHandItem,
  Assembly,
  Warehouse,
  PurchaseOrder,
} from "@/lib/unleashed/types";

/**
 * One delivery-on-date supply record, flattened from a PO line. Partial
 * receipts are represented as the remaining (unreceived) quantity so the
 * projection only adds what's still outstanding.
 */
export interface OpenPOLine {
  purchaseOrderNumber: string;
  productCode: string;
  /** Outstanding quantity (ordered minus received) */
  quantity: number;
  /** ISO date string (YYYY-MM-DD) — the expected delivery day */
  deliveryDate: string;
  supplierName: string;
  status: "Open" | "PartiallyReceived";
}

interface KitchenDataPayload {
  sohItems: StockOnHandItem[];
  assemblies: Assembly[];
  warehouses: Warehouse[];
  openPOLines: OpenPOLine[];
  cachedAt: string;
}

/**
 * Flatten Unleashed POs into per-line delivery records. A PO with no delivery
 * date anywhere (line-level or header-level) is skipped — we can't place it
 * on a timeline. For `PartiallyReceived` POs we subtract `quantityReceived`
 * so only the outstanding balance lifts projected SOH.
 */
function flattenPOsToLines(
  pos: PurchaseOrder[],
  status: "Open" | "PartiallyReceived",
): OpenPOLine[] {
  const out: OpenPOLine[] = [];
  for (const po of pos) {
    // Prefer line-level delivery date; fall back to PO header dates.
    const headerDate = po.expectedDeliveryDate || po.requiredDate;
    for (const line of po.purchaseOrderLines) {
      const remaining = Math.max(
        0,
        (line.quantityOrdered ?? 0) - (line.quantityReceived ?? 0),
      );
      if (remaining <= 0) continue;
      const rawDate = line.expectedDeliveryDate || headerDate;
      if (!rawDate) continue;
      // Normalise to YYYY-MM-DD — Unleashed returns a variety of formats,
      // but only the date portion matters for projection.
      const iso = rawDate.includes("T") ? rawDate.split("T")[0] : rawDate.slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) continue;
      out.push({
        purchaseOrderNumber: po.purchaseOrderNumber,
        productCode: line.productCode,
        quantity: remaining,
        deliveryDate: iso,
        supplierName: po.supplierName,
        status,
      });
    }
  }
  return out;
}

// In-memory cache with stale-while-revalidate
let cache: KitchenDataPayload | null = null;
let cacheExpiry = 0;
let isRefreshing = false;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function refreshCache(): Promise<void> {
  if (isRefreshing) return;
  isRefreshing = true;
  try {
    const [{ sohItems, warehouses }, assemblies, openPOs, partialPOs] =
      await Promise.all([
        fetchSOHWithFallback(),
        serverFetchOpenAssembliesByGroup("MF - Intermediate"),
        serverFetchPurchaseOrdersByStatus("Open"),
        serverFetchPurchaseOrdersByStatus("PartiallyReceived"),
      ]);

    const openPOLines = [
      ...flattenPOsToLines(openPOs, "Open"),
      ...flattenPOsToLines(partialPOs, "PartiallyReceived"),
    ];

    cache = {
      sohItems,
      assemblies,
      warehouses,
      openPOLines,
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
    console.error("Kitchen data fetch error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to fetch data",
      },
      { status: 500 }
    );
  }
}
