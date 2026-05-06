import { createUnleashedRequest } from "./auth";
import type {
  StockOnHandItem,
  Assembly,
  AssemblyLine,
  PurchaseOrder,
  PurchaseOrderLine,
  Product,
  Supplier,
  Warehouse,
  BOMEntry,
  SalesOrder,
  SalesOrderLine,
} from "./types";

/**
 * Server-side Unleashed API fetcher.
 * Calls Unleashed directly with HMAC auth — no proxy roundtrip.
 * Used by API routes to fetch + normalize + cache data.
 */

interface RawPaginatedResponse {
  Pagination: {
    NumberOfItems: number;
    PageSize: number;
    PageNumber: number;
    NumberOfPages: number;
  };
  Items: Record<string, unknown>[];
}

function getCredentials() {
  const apiId = process.env.UNLEASHED_API_ID;
  const apiKey = process.env.UNLEASHED_API_KEY;
  if (!apiId || !apiKey) throw new Error("Unleashed API credentials not configured");
  return { apiId, apiKey };
}

async function fetchEndpoint(
  endpoint: string,
  query: Record<string, string> = {}
): Promise<RawPaginatedResponse> {
  const { apiId, apiKey } = getCredentials();
  const { url, headers } = createUnleashedRequest(endpoint, query, apiId, apiKey);

  const response = await fetch(url, { headers, next: { revalidate: 0 } });
  if (!response.ok) {
    throw new Error(`Unleashed API ${endpoint}: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function fetchAllPages(
  endpoint: string,
  query: Record<string, string> = {},
  pageSize = 1000
): Promise<Record<string, unknown>[]> {
  const allItems: Record<string, unknown>[] = [];
  let currentPage = 1;
  let hasMore = true;

  while (hasMore) {
    // Unleashed uses URL-based pagination: endpoint/2, endpoint/3, etc.
    const ep = currentPage === 1 ? endpoint : `${endpoint}/${currentPage}`;
    const response = await fetchEndpoint(ep, {
      ...query,
      pageSize: pageSize.toString(),
    });

    allItems.push(...response.Items);
    const totalPages = response.Pagination.NumberOfPages || 1;
    hasMore = currentPage < totalPages;
    currentPage++;
  }

  return allItems;
}

// ─── Date parsing ─────────────────────────────────────────────

function parseDate(value: unknown): string | undefined {
  if (!value || typeof value !== "string") return undefined;
  const match = value.match(/\/Date\((\d+)\)\//);
  if (match) return new Date(Number(match[1])).toISOString();
  return value;
}

// ─── Normalizers ──────────────────────────────────────────────

function normalizeSOH(raw: Record<string, unknown>): StockOnHandItem {
  const qtyOnHand = (raw.QtyOnHand as number) || 0;
  const allocatedQty = (raw.AllocatedQty as number) || 0;
  return {
    productId: (raw.ProductGuid as string) || (raw.Guid as string),
    productCode: raw.ProductCode as string,
    productName: raw.ProductDescription as string,
    warehouseId: (raw.WarehouseId as string) || "",
    warehouseName: (raw.WarehouseName as string) || (raw.Warehouse as string) || "",
    quantity: qtyOnHand,
    allocatedQty,
    availableQty: qtyOnHand - allocatedQty,
    lastMovementDate: parseDate(raw.LastModifiedOn),
    reorderPoint: (raw.MinStockAlertLevel as number) || 0,
    reorderQuantity: (raw.ReOrderPoint as number) || 0,
  };
}

function normalizeSupplier(raw: Record<string, unknown>): Supplier {
  return {
    supplierId: raw.Guid as string,
    supplierName: raw.SupplierName as string,
    supplierCode: raw.SupplierCode as string,
    supplierStatus: raw.Obsolete ? "Inactive" : "Active",
    contactName: raw.ContactName as string | undefined,
    email: raw.Email as string | undefined,
    phone: raw.PhoneNumber as string | undefined,
  };
}

function normalizeProduct(raw: Record<string, unknown>): Product {
  const sup = raw.Supplier as Record<string, unknown> | null;
  const grp = raw.ProductGroup as Record<string, unknown> | null;
  return {
    productId: raw.Guid as string,
    productCode: raw.ProductCode as string,
    productDescription: raw.ProductDescription as string,
    productName: raw.ProductDescription as string,
    productGroup: (grp?.GroupName as string) || "",
    unitOfMeasure:
      ((raw.UnitOfMeasure as Record<string, unknown>)?.Name as string) || "",
    reorderPoint: (raw.ReOrderPoint as number) || 0,
    reorderQuantity: (raw.MinStockAlertLevel as number) || 0,
    discontinue: (raw.Obsolete as boolean) || false,
    supplier: sup
      ? {
          supplierId: sup.Guid as string,
          supplierName: sup.SupplierName as string,
          supplierCode: (sup.SupplierCode as string) || "",
          supplierStatus: "Active" as const,
        }
      : undefined,
    productStatus: raw.Obsolete ? "Discontinued" : "Active",
  };
}

function normalizeWarehouse(raw: Record<string, unknown>): Warehouse {
  return {
    warehouseId: raw.Guid as string,
    warehouseName: raw.WarehouseName as string,
    warehouseCode: raw.WarehouseCode as string,
    isDefault: raw.IsDefault as boolean,
    streetAddress: raw.AddressLine1 as string | undefined,
    city: raw.City as string | undefined,
    region: raw.Region as string | undefined,
    country: raw.Country as string | undefined,
    postCode: raw.PostCode as string | undefined,
  };
}

function normalizePOLine(raw: Record<string, unknown>): PurchaseOrderLine {
  const product = raw.Product as Record<string, unknown> | null;
  return {
    lineNumber: raw.LineNumber as number,
    productCode: (product?.ProductCode as string) || "",
    productDescription: (product?.ProductDescription as string) || "",
    quantityOrdered: (raw.OrderQuantity as number) || 0,
    quantityReceived: (raw.ReceiptQuantity as number) || 0,
    unitAmount: (raw.UnitPrice as number) || 0,
    lineTotal: (raw.LineTotal as number) || 0,
    lineComment: raw.Comments as string | undefined,
    expectedDeliveryDate: parseDate(raw.DeliveryDate),
  };
}

function normalizePO(raw: Record<string, unknown>): PurchaseOrder {
  const supplier = raw.Supplier as Record<string, unknown> | null;
  const lines = (raw.PurchaseOrderLines as Record<string, unknown>[]) || [];

  const rawStatus = raw.OrderStatus as string;
  let status: PurchaseOrder["status"] = "Open";
  if (rawStatus === "Placed" || rawStatus === "Parked") status = "Open";
  else if (rawStatus === "Receipted" || rawStatus === "Partialled") status = "PartiallyReceived";
  else if (rawStatus === "Complete" || rawStatus === "Received" || rawStatus === "Costed")
    status = "Received";
  else if (rawStatus === "Cancelled" || rawStatus === "Deleted")
    status = "Cancelled";

  return {
    purchaseOrderId: raw.Guid as string,
    purchaseOrderNumber: (raw.OrderNumber as string) || "",
    orderNumber: raw.OrderNumber as string,
    supplierId: (supplier?.Guid as string) || "",
    supplierName: (supplier?.SupplierName as string) || "",
    supplierCode: (supplier?.SupplierCode as string) || "",
    orderedDate: parseDate(raw.OrderDate) || "",
    requiredDate: parseDate(raw.DeliveryDate),
    expectedDeliveryDate: parseDate(raw.DeliveryDate),
    receivedDate: parseDate(raw.ReceivedDate),
    status,
    orderTotal: (raw.Total as number) || 0,
    purchaseOrderLines: lines.map(normalizePOLine),
    comments: raw.Comments as string | undefined,
  };
}

function normalizeAssemblyLine(raw: Record<string, unknown>): AssemblyLine {
  const product = raw.Product as Record<string, unknown> | null;
  return {
    lineNumber: (raw.LineNumber as number) || 0,
    productCode: (product?.ProductCode as string) || "",
    productDescription: (product?.ProductDescription as string) || "",
    quantityPerParent: 0,
    warehouseCode: "",
    componentQuantity: (raw.Quantity as number) || 0,
  };
}

function normalizeAssembly(raw: Record<string, unknown>): Assembly {
  const product = raw.Product as Record<string, unknown> | null;
  const srcWarehouse = raw.SourceWarehouse as Record<string, unknown> | null;
  const lines = (raw.AssemblyLines as Record<string, unknown>[]) || [];

  return {
    assemblyId: raw.Guid as string,
    assemblyNumber: (raw.AssemblyNumber as string) || "",
    productId: (product?.Guid as string) || "",
    productCode: (product?.ProductCode as string) || "",
    productName: (product?.ProductDescription as string) || "",
    productDescription: (product?.ProductDescription as string) || "",
    quantity: (raw.Quantity as number) || 0,
    status: (raw.AssemblyStatus as string) || "",
    warehouseId: (srcWarehouse?.Guid as string) || "",
    warehouseName: (srcWarehouse?.WarehouseName as string) || "",
    assemblyLines: lines.map(normalizeAssemblyLine),
    createdOn: parseDate(raw.CreatedOn) || "",
    lastModifiedOn: parseDate(raw.LastModifiedOn),
    assembleBy: parseDate(raw.AssembleBy),
    comments: (raw.Comments as string | undefined) || undefined,
  };
}

function normalizeBOMLines(raw: Record<string, unknown>): BOMEntry[] {
  const product = raw.Product as Record<string, unknown> | null;
  const parentCode = (product?.ProductCode as string) || "";
  const lines =
    (raw.BillOfMaterialsLines as Record<string, unknown>[]) || [];

  return lines.map((line) => {
    const lineProduct = line.Product as Record<string, unknown> | null;
    return {
      productCode: (lineProduct?.ProductCode as string) || "",
      productDescription: (lineProduct?.ProductDescription as string) || "",
      quantityPerParent: (line.Quantity as number) || 0,
      warehouseCode: "",
      level: 0,
      parentProductCode: parentCode,
    };
  });
}

// ─── Request deduplication ────────────────────────────────
// When multiple routes fire simultaneously (e.g. opening the app),
// they call the same Unleashed endpoints concurrently. Without dedup,
// 3 routes = 3 identical SOH requests. With dedup, concurrent callers
// share a single in-flight request, cutting API load by 2/3.

const _inflight = new Map<string, Promise<unknown>>();

function dedup<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = _inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;

  const promise = fn().finally(() => _inflight.delete(key));
  _inflight.set(key, promise);
  return promise;
}

// ─── Cross-route caching ─────────────────────────────────
// SOH + assemblies are needed by all 3 routes. Cache them at the
// server.ts level so concurrent route handlers share one fetch.

let _sohCache: StockOnHandItem[] | null = null;
let _sohExpiry = 0;
const SOH_CACHE_TTL = 5 * 60 * 1000; // 5 min

let _assembliesCache: Assembly[] | null = null;
let _assembliesExpiry = 0;
const ASSEMBLIES_CACHE_TTL = 5 * 60 * 1000; // 5 min

let _suppliersCache: Supplier[] | null = null;
let _suppliersExpiry = 0;
const SUPPLIERS_CACHE_TTL = 2 * 60 * 60 * 1000; // 2 hours

let _productsCache: Product[] | null = null;
let _productsCacheExpiry = 0;
const PRODUCTS_CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

// ─── Public fetch functions (server-side) ─────────────────────

export async function serverFetchStockOnHand(
  warehouseCode?: string
): Promise<StockOnHandItem[]> {
  // Only cache the "all warehouses" call (no warehouseCode filter)
  if (!warehouseCode && _sohCache && Date.now() < _sohExpiry) {
    return _sohCache;
  }
  return dedup(`soh:${warehouseCode || 'all'}`, async () => {
    const query: Record<string, string> = {};
    if (warehouseCode) query.warehouseCode = warehouseCode;
    const items = await fetchAllPages("StockOnHand", query);
    const result = items.map(normalizeSOH);
    if (!warehouseCode) {
      _sohCache = result;
      _sohExpiry = Date.now() + SOH_CACHE_TTL;
    }
    return result;
  });
}

export async function serverFetchSuppliers(): Promise<Supplier[]> {
  if (_suppliersCache && Date.now() < _suppliersExpiry) {
    return _suppliersCache;
  }
  return dedup('suppliers', async () => {
    const items = await fetchAllPages("Suppliers");
    const result = items.map(normalizeSupplier);
    _suppliersCache = result;
    _suppliersExpiry = Date.now() + SUPPLIERS_CACHE_TTL;
    return result;
  });
}

/**
 * Products whose group name starts with "TBC" are customer-specific SKUs
 * that don't participate in our kitchen / packaging / component flows.
 * Centralising the rule here keeps it enforced uniformly across every
 * API route. See also: the assembly filter in `serverFetchOpenAssemblies`.
 */
export function isExcludedProductGroup(group: string | undefined): boolean {
  return (group ?? '').toUpperCase().startsWith('TBC');
}

/**
 * Returns every product (including TBC ones). Kept as the primary fetcher
 * so that the product-group cache is complete — we still need to know the
 * groups of TBC products so we can filter TBC assemblies by product code.
 * Callers that render products in the UI should use
 * `serverFetchPlannerProducts` instead.
 */
export async function serverFetchProducts(): Promise<Product[]> {
  if (_productsCache && Date.now() < _productsCacheExpiry) {
    return _productsCache;
  }
  return dedup('products', async () => {
    const items = await fetchAllPages("Products");
    const products = items.map(normalizeProduct);
    _productsCache = products;
    _productsCacheExpiry = Date.now() + PRODUCTS_CACHE_TTL_MS;
    // Seed product-group cache from the bulk fetch (instant)
    _buildGroupCacheFromProducts(products);
    return products;
  });
}

/**
 * Planner-facing product list: the same data as `serverFetchProducts` minus
 * TBC-grouped SKUs. Use this when returning products to the UI or filtering
 * data that will be shown to operators. Backend logic that needs the full
 * list (e.g., group resolution for assembly filtering) should still call
 * `serverFetchProducts`.
 */
export async function serverFetchPlannerProducts(): Promise<Product[]> {
  const all = await serverFetchProducts();
  return all.filter((p) => !isExcludedProductGroup(p.productGroup));
}

export async function serverFetchWarehouses(): Promise<Warehouse[]> {
  const response = await fetchEndpoint("Warehouses", { pageSize: "200" });
  return response.Items.map(normalizeWarehouse);
}

export async function serverFetchPurchaseOrdersByStatus(
  status: "Open" | "PartiallyReceived"
): Promise<PurchaseOrder[]> {
  return dedup(`po:${status}`, async () => {
    // Unleashed API status values:
    //   Placed = open/submitted POs awaiting delivery
    //   Parked = draft/held POs
    //   Receipted = partially received POs
    //   Complete = fully received
    //   Costed = finalised/costed
    let apiStatus: string;
    if (status === "Open") apiStatus = "Placed";
    else apiStatus = "Receipted"; // PartiallyReceived
    const items = await fetchAllPages("PurchaseOrders", { orderStatus: apiStatus });

    // Also fetch Parked POs as "Open" — they represent planned purchases
    let parkedItems: Record<string, unknown>[] = [];
    if (status === "Open") {
      parkedItems = await fetchAllPages("PurchaseOrders", { orderStatus: "Parked" });
    }

    return [...items, ...parkedItems].map(normalizePO);
  });
}

export async function serverFetchAssemblies(options?: {
  startDate?: string;
  endDate?: string;
  assemblyStatus?: string;
}): Promise<Assembly[]> {
  const query: Record<string, string> = {};
  if (options?.startDate) query.startDate = options.startDate;
  if (options?.endDate) query.endDate = options.endDate;
  if (options?.assemblyStatus) query.assemblyStatus = options.assemblyStatus;
  const items = await fetchAllPages("Assemblies", query);
  return items.map(normalizeAssembly);
}

/**
 * Fetch all non-completed assemblies (Parked, Planned, Open) in parallel.
 * These represent uncommitted demand — completed assemblies have already
 * consumed their components and are reflected in current SOH.
 *
 * Cached (5 min) + dedup'd so concurrent route handlers share one fetch.
 */
export async function serverFetchOpenAssemblies(): Promise<Assembly[]> {
  if (_assembliesCache && Date.now() < _assembliesExpiry) {
    return _assembliesCache;
  }
  return dedup('openAssemblies', async () => {
    // Fetch products first so the product-group cache is populated — we
    // need it to identify and drop TBC-grouped assemblies below. These two
    // calls are both planner-data concerns and are already independently
    // cached, so pairing them is cheap.
    const [, parked, planned, open] = await Promise.all([
      serverFetchProducts(),
      serverFetchAssemblies({ assemblyStatus: "Parked" }),
      serverFetchAssemblies({ assemblyStatus: "Planned" }),
      serverFetchAssemblies({ assemblyStatus: "Open" }),
    ]);
    const seen = new Set<string>();
    const unique: Assembly[] = [];
    for (const assembly of [...parked, ...planned, ...open]) {
      if (!seen.has(assembly.assemblyId)) {
        seen.add(assembly.assemblyId);
        unique.push(assembly);
      }
    }
    // Drop assemblies whose product belongs to an excluded group (TBC).
    // `productGroupCache` is populated by `serverFetchProducts` above.
    const filtered = unique.filter((a) => {
      const group = productGroupCache?.get(a.productCode);
      return !isExcludedProductGroup(group);
    });
    _assembliesCache = filtered;
    _assembliesExpiry = Date.now() + ASSEMBLIES_CACHE_TTL;
    return filtered;
  });
}

// ─── Product group resolution (cached) ───────────────────────

let productGroupCache: Map<string, string> | null = null;
let productGroupCacheExpiry = 0;
const PRODUCT_GROUP_CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours (matches products)

/** Build the productCode → group map from the bulk products list (instant, O(n)). */
function _buildGroupCacheFromProducts(products: Product[]): void {
  const map = new Map<string, string>();
  for (const p of products) {
    map.set(p.productCode, p.productGroup);
  }
  productGroupCache = map;
  productGroupCacheExpiry = Date.now() + PRODUCT_GROUP_CACHE_TTL_MS;
}

/**
 * Resolve product group for a single product code via individual API call.
 * Only used as a fallback for codes missing from the bulk products list.
 */
async function resolveProductGroup(productCode: string): Promise<string> {
  try {
    const response = await fetchEndpoint("Products", { productCode, pageSize: "1" });
    const item = response.Items[0];
    if (item) {
      const group = item.ProductGroup as Record<string, unknown> | null;
      return (group?.GroupName as string) || "";
    }
  } catch {
    // Ignore lookup failures
  }
  return "";
}

/**
 * Build a map of productCode → productGroup for a set of codes.
 *
 * **Optimized path:** Uses the shared bulk products cache (from serverFetchProducts)
 * to resolve groups instantly. Only falls back to individual API calls for codes
 * missing from the bulk list (rare — some component-type products are excluded).
 *
 * Before this optimization, resolving ~80 codes took 8 sequential rounds of 10
 * API calls each (~15s). Now it's instant when the products cache is warm, or a
 * single ~23s bulk fetch that benefits all routes for 2 hours.
 */
async function resolveProductGroups(codes: string[]): Promise<Map<string, string>> {
  // Fast path: group cache is warm and has all codes
  if (productGroupCache && Date.now() < productGroupCacheExpiry) {
    const allCached = codes.every(c => productGroupCache!.has(c));
    if (allCached) return productGroupCache;
  }

  // Use bulk products cache if available; otherwise trigger a bulk fetch
  if (_productsCache && Date.now() < _productsCacheExpiry) {
    _buildGroupCacheFromProducts(_productsCache);
  } else {
    // Single bulk fetch (~23s on cold start, cached 2h) instead of N individual calls
    await serverFetchProducts();
  }

  const map = productGroupCache!;
  const missing = codes.filter(c => !map.has(c));

  if (missing.length === 0) return map;

  // Fallback: individual lookups ONLY for codes not in the bulk products list.
  // Typically 0-5 codes instead of the original 50-80.
  const BATCH_SIZE = 10;
  for (let i = 0; i < missing.length; i += BATCH_SIZE) {
    const batch = missing.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map(async (code) => ({
      code,
      group: await resolveProductGroup(code),
    })));
    for (const { code, group } of results) {
      map.set(code, group);
    }
  }

  productGroupCache = map;
  productGroupCacheExpiry = Date.now() + PRODUCT_GROUP_CACHE_TTL_MS;
  return map;
}

/** Public wrapper for resolveProductGroups (for use in API routes) */
export async function resolveProductGroupsPublic(
  codes: string[]
): Promise<Map<string, string>> {
  return resolveProductGroups(codes);
}

/**
 * Fetch non-completed assemblies filtered to a specific product group.
 * Resolves product groups by querying the Products endpoint per unique code.
 */
export async function serverFetchOpenAssembliesByGroup(
  groupName: string
): Promise<Assembly[]> {
  const assemblies = await serverFetchOpenAssemblies();

  // Get unique product codes from assemblies
  const codes = [...new Set(assemblies.map(a => a.productCode))];

  // Resolve their product groups
  const groupMap = await resolveProductGroups(codes);

  // Filter and annotate
  return assemblies
    .filter(a => groupMap.get(a.productCode) === groupName)
    .map(a => ({ ...a, productGroup: groupMap.get(a.productCode) }));
}

export async function serverFetchBOMs(
  productCode: string
): Promise<BOMEntry[]> {
  const response = await fetchEndpoint("BillOfMaterials", { productCode });
  // Unleashed returns all BOMs referencing this code (as parent OR component).
  // Filter to only the BOM where this code is the parent product.
  const items = (response.Items as Record<string, unknown>[]) || [];
  const parentItems = items.filter((item) => {
    const product = item.Product as Record<string, unknown> | null;
    return (product?.ProductCode as string) === productCode;
  });
  return parentItems.flatMap(normalizeBOMLines);
}

/**
 * Reverse BOM lookup: fetch all BOMs where `componentCode` appears as a component.
 * Returns BOMEntry[] with parentProductCode set to the FG product code.
 *
 * Useful for packaging: query "IAW" → get all FG SKUs that use Walnuts Activated,
 * with their quantityPerParent ratios.
 */

// Cache for reverse BOM lookups (30-min TTL)
const reverseBOMCache = new Map<string, { data: BOMEntry[]; expiry: number }>();
const REVERSE_BOM_TTL = 30 * 60 * 1000;

// Cache for the full-tenant BOM snapshot (30-min TTL). Shared by every
// caller that needs to walk the BOM graph across arbitrary products —
// much cheaper than per-component lookups once there are more than a
// handful of codes to cover.
let _allBOMsCache: BOMEntry[] | null = null;
let _allBOMsCacheExpiry = 0;
const ALL_BOMS_TTL = 30 * 60 * 1000;

/**
 * Fetch every BOM in the Unleashed tenant and flatten it into
 * `BOMEntry[]` (each entry = one child line, keyed on `parentProductCode`).
 *
 * Replaces the old per-component lookup list. We paginate the
 * `BillOfMaterials` endpoint once and keep the result cached for 30 min —
 * downstream callers (packaging export, card modal, projections) walk the
 * same snapshot, so there's no blind spot for SKUs whose food component
 * happens to be outside a hardcoded list.
 */
export async function serverFetchAllBOMs(): Promise<BOMEntry[]> {
  if (_allBOMsCache && Date.now() < _allBOMsCacheExpiry) return _allBOMsCache;
  return dedup("allBOMs", async () => {
    const items = await fetchAllPages("BillOfMaterials");
    const result: BOMEntry[] = [];
    for (const item of items) {
      result.push(...normalizeBOMLines(item));
    }
    _allBOMsCache = result;
    _allBOMsCacheExpiry = Date.now() + ALL_BOMS_TTL;
    return result;
  });
}

export async function serverFetchBOMsForComponent(
  componentCode: string
): Promise<BOMEntry[]> {
  const cached = reverseBOMCache.get(componentCode);
  if (cached && Date.now() < cached.expiry) return cached.data;

  const response = await fetchEndpoint("BillOfMaterials", {
    productCode: componentCode,
  });
  const items = (response.Items as Record<string, unknown>[]) || [];

  // Keep BOMs where componentCode appears as a LINE (component), not as the parent.
  // Each BOM item has a parent Product and BillOfMaterialsLines containing components.
  const result: BOMEntry[] = [];
  for (const item of items) {
    const product = item.Product as Record<string, unknown> | null;
    const parentCode = (product?.ProductCode as string) || "";

    // Skip if this BOM's parent IS the component (that's the forward lookup case)
    if (parentCode === componentCode) continue;

    const lines = normalizeBOMLines(item);
    // Find the specific line for our component
    const componentLine = lines.find(
      (line) => line.productCode === componentCode
    );
    if (componentLine) {
      result.push(componentLine);
    }
  }

  reverseBOMCache.set(componentCode, { data: result, expiry: Date.now() + REVERSE_BOM_TTL });
  return result;
}

// ─── Sales Orders ─────────────────────────────────────────────

function normalizeSalesOrderLine(raw: Record<string, unknown>): SalesOrderLine {
  const product = raw.Product as Record<string, unknown> | null;
  return {
    lineNumber: (raw.LineNumber as number) || 0,
    productCode: (product?.ProductCode as string) || "",
    productDescription: (product?.ProductDescription as string) || "",
    quantityOrdered: (raw.OrderQuantity as number) || 0,
    quantityAllocated: (raw.AllocatedQuantity as number) || 0,
    quantityBackordered:
      ((raw.BackorderQuantity as number) ??
        (raw.QuantityBackordered as number) ??
        0) as number,
    unitAmount: (raw.UnitPrice as number) || 0,
    lineTotal: (raw.LineTotal as number) || 0,
  };
}

function normalizeSalesOrder(raw: Record<string, unknown>): SalesOrder {
  const customer = raw.Customer as Record<string, unknown> | null;
  const lines = (raw.SalesOrderLines as Record<string, unknown>[]) || [];
  return {
    salesOrderId: raw.Guid as string,
    orderNumber: (raw.OrderNumber as string) || "",
    orderStatus: (raw.OrderStatus as string) || "",
    customerId: (customer?.Guid as string) || "",
    customerName: (customer?.CustomerName as string) || "",
    orderedDate: parseDate(raw.OrderDate),
    requiredDate: parseDate(raw.RequiredDate),
    salesOrderLines: lines.map(normalizeSalesOrderLine),
  };
}

/**
 * Fetch "active" sales orders — i.e., ones that could still be driving a
 * deficit. Unleashed's `Placed` and `Backordered` are the relevant
 * statuses; `Parked` is drafting, `Dispatched`/`Completed` have already
 * shipped, `Cancelled`/`Deleted` are off the books.
 *
 * Paginates through all results. Typical live data: ~500–2,000 orders,
 * which fits well within a single fetch at pageSize 1000.
 *
 * Short cache (2 minutes) — allocations change rapidly as orders come in.
 */
let _salesOrdersCache: SalesOrder[] | null = null;
let _salesOrdersCacheExpiry = 0;
const SALES_ORDERS_CACHE_TTL = 2 * 60 * 1000;

export async function serverFetchActiveSalesOrders(): Promise<SalesOrder[]> {
  if (_salesOrdersCache && Date.now() < _salesOrdersCacheExpiry) {
    return _salesOrdersCache;
  }
  return dedup("sales-orders:active", async () => {
    // Fetch each status independently; Unleashed filters one value per
    // request. Run in parallel, merge.
    const [placed, backordered] = await Promise.all([
      fetchAllPages("SalesOrders", { orderStatus: "Placed" }),
      fetchAllPages("SalesOrders", { orderStatus: "Backordered" }),
    ]);
    const result = [...placed, ...backordered].map(normalizeSalesOrder);
    _salesOrdersCache = result;
    _salesOrdersCacheExpiry = Date.now() + SALES_ORDERS_CACHE_TTL;
    return result;
  });
}
