import { NextRequest, NextResponse } from "next/server";
import {
  serverFetchOpenAssemblies,
  serverFetchPurchaseOrdersByStatus,
  serverFetchAllBOMs,
  serverFetchPlannerProducts,
} from "@/lib/unleashed/server";
import { fetchSOHWithFallback } from "@/lib/unleashed/fetch-soh";
import type {
  StockOnHandItem,
  Assembly,
  PurchaseOrder,
  BOMEntry,
} from "@/lib/unleashed/types";

/** Flat supplier info per purchasable product code, for the export flow. */
export interface SupplierRef {
  code: string;
  name: string;
}

interface PackagingDataPayload {
  sohItems: StockOnHandItem[];
  assemblies: Assembly[];        // non-intermediate open assemblies
  openPOs: PurchaseOrder[];      // for label ETAs
  /**
   * Full-tenant BOM snapshot flattened to one entry per child line. Keyed
   * on `parentProductCode`. Historically this route only fetched BOMs for
   * a fixed intermediate-code list; it now pulls every BOM so downstream
   * walks (export, card modal, shortfall math) cover the full catalogue.
   */
  bomEntries: BOMEntry[];
  productGroups: Record<string, string>; // productCode → group name
  /**
   * Flat map of productCode → default supplier (name + code). Drives the
   * procurement export so each required component can be grouped by the
   * supplier who actually fills it.
   */
  supplierByCode: Record<string, SupplierRef>;
  cachedAt: string;
}

// ─── Caching with stale-while-revalidate ─────────────────

type FastData = Pick<PackagingDataPayload, "sohItems" | "assemblies" | "openPOs" | "productGroups" | "supplierByCode">;
let fastCache: FastData | null = null;
let fastCacheExpiry = 0;
let bomCache: BOMEntry[] | null = null;
let bomCacheExpiry = 0;
let fullCache: PackagingDataPayload | null = null;
let fullCacheExpiry = 0;
let isRefreshing = false;

const FAST_TTL_MS = 5 * 60 * 1000;  // 5 min
const BOM_TTL_MS = 30 * 60 * 1000;  // 30 min
const FULL_TTL_MS = 5 * 60 * 1000;  // 5 min (composite)

async function refreshFastData(): Promise<FastData> {
  const [{ sohItems }, allAssemblies, openPOs, products] = await Promise.all([
    fetchSOHWithFallback(),
    serverFetchOpenAssemblies(),
    serverFetchPurchaseOrdersByStatus("Open"),
    serverFetchPlannerProducts(),
  ]);

  // resolveProductGroupsPublic now uses the shared bulk products cache
  // (instant if warm, single bulk fetch if cold — no more N individual calls)
  const codes = [...new Set(allAssemblies.map(a => a.productCode))];
  const { resolveProductGroupsPublic } = await import("@/lib/unleashed/server");
  const groupMap = await resolveProductGroupsPublic(codes);

  const assemblies = allAssemblies.filter(
    a => groupMap.get(a.productCode) !== "MF - Intermediate"
  );

  const productGroups: Record<string, string> = {};
  for (const [code, group] of groupMap) {
    productGroups[code] = group;
  }

  // Flatten each product's default supplier down to a (code → {code, name})
  // map so the export bundle stays small. Products with no supplier fall
  // through and get "Unknown" at render time — expected for labels and some
  // packaging items that live on internal codes.
  const supplierByCode: Record<string, SupplierRef> = {};
  for (const p of products) {
    if (p.supplier && p.supplier.supplierName) {
      supplierByCode[p.productCode] = {
        code: p.supplier.supplierCode || p.supplier.supplierId,
        name: p.supplier.supplierName,
      };
    }
  }

  const result = { sohItems, assemblies, openPOs, productGroups, supplierByCode };
  fastCache = result;
  fastCacheExpiry = Date.now() + FAST_TTL_MS;
  return result;
}

async function refreshBOMData(): Promise<BOMEntry[]> {
  // One bulk call covers every BOM in the tenant — no hardcoded list of
  // food-component codes. The server-side fetcher has its own 30-min cache
  // that deduplicates concurrent callers, so routes that compose this
  // (kitchen, purchasing) will share the same snapshot.
  const entries = await serverFetchAllBOMs();
  bomCache = entries;
  bomCacheExpiry = Date.now() + BOM_TTL_MS;
  return entries;
}

async function refreshAll(forceRefresh: boolean): Promise<void> {
  if (isRefreshing) return;
  isRefreshing = true;
  try {
    const haveFast = !forceRefresh && fastCache && Date.now() < fastCacheExpiry;
    const haveBOM = !forceRefresh && bomCache && Date.now() < bomCacheExpiry;

    const [fast, boms] = await Promise.all([
      haveFast ? Promise.resolve(fastCache!) : refreshFastData(),
      haveBOM ? Promise.resolve(bomCache!) : refreshBOMData(),
    ]);

    fullCache = { ...fast, bomEntries: boms, cachedAt: new Date().toISOString() };
    fullCacheExpiry = Date.now() + FULL_TTL_MS;
  } finally {
    isRefreshing = false;
  }
}

export async function GET(request: NextRequest) {
  const forceRefresh = request.nextUrl.searchParams.get("refresh") === "true";

  // Fresh cache — return immediately
  if (!forceRefresh && fullCache && Date.now() < fullCacheExpiry) {
    return NextResponse.json({ success: true, data: fullCache, fromCache: true });
  }

  // Stale cache — return stale data immediately, refresh in background
  if (!forceRefresh && fullCache) {
    void refreshAll(false);
    return NextResponse.json({ success: true, data: fullCache, fromCache: true, stale: true });
  }

  try {
    await refreshAll(forceRefresh);
    return NextResponse.json({ success: true, data: fullCache, fromCache: false });
  } catch (error) {
    console.error("Packaging data fetch error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to fetch data",
      },
      { status: 500 }
    );
  }
}
