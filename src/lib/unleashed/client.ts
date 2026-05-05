import type {
  StockOnHandItem,
  AllocationItem,
  Assembly,
  AssemblyCreatePayload,
  PurchaseOrder,
  BOMEntry,
  Product,
  Supplier,
  Warehouse,
  UnleashedAPIError,
} from "./types";

/**
 * Client-side Unleashed API client
 * Calls server proxy endpoint at /api/unleashed
 * Server handles HMAC authentication securely
 *
 * The Unleashed API returns PascalCase fields with nested objects.
 * Each fetch function normalizes responses to our camelCase types.
 */

interface ProxyRequest {
  endpoint: string;
  method?: "GET" | "POST" | "PUT" | "DELETE";
  query?: Record<string, string>;
  body?: unknown;
}

interface ProxyResponse<T> {
  success: boolean;
  data?: T;
  error?: UnleashedAPIError;
}

/** Raw Unleashed paginated response shape */
interface RawPaginatedResponse {
  Pagination: {
    NumberOfItems: number;
    PageSize: number;
    PageNumber: number;
    NumberOfPages: number;
  };
  Items: Record<string, unknown>[];
}

// ─── Proxy call ───────────────────────────────────────────────

async function callProxy<T>(request: ProxyRequest): Promise<T> {
  const response = await fetch("/api/unleashed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(`Proxy error: ${response.statusText}`);
  }

  const data: ProxyResponse<T> = await response.json();
  if (!data.success) {
    throw new Error(`API error: ${data.error?.errorDetail || "Unknown error"}`);
  }

  return data.data as T;
}

/** Parse Unleashed /Date(timestamp)/ format to ISO string */
function parseDate(value: unknown): string | undefined {
  if (!value || typeof value !== "string") return undefined;
  const match = value.match(/\/Date\((\d+)\)\//);
  if (match) return new Date(Number(match[1])).toISOString();
  return value;
}

// ─── Paginated fetch helper ───────────────────────────────────

async function fetchAllPages<T>(
  endpoint: string,
  query: Record<string, string>,
  normalize: (raw: Record<string, unknown>) => T,
  pageSize: number = 200
): Promise<T[]> {
  const allItems: T[] = [];
  let currentPage = 1;
  let hasMore = true;

  while (hasMore) {
    const response = await callProxy<RawPaginatedResponse>({
      endpoint,
      query: {
        ...query,
        pageNumber: currentPage.toString(),
        pageSize: pageSize.toString(),
      },
    });

    for (const raw of response.Items) {
      allItems.push(normalize(raw));
    }

    hasMore = currentPage * pageSize < response.Pagination.NumberOfItems;
    currentPage++;
  }

  return allItems;
}

async function fetchSinglePage<T>(
  endpoint: string,
  query: Record<string, string>,
  normalize: (raw: Record<string, unknown>) => T
): Promise<T[]> {
  const response = await callProxy<RawPaginatedResponse>({
    endpoint,
    query: { ...query, pageSize: "200" },
  });

  return response.Items.map(normalize);
}

// ─── Normalizers ──────────────────────────────────────────────

function normalizeSOH(raw: Record<string, unknown>): StockOnHandItem {
  const qtyOnHand = (raw.QtyOnHand as number) || 0;
  const allocatedQty = (raw.AllocatedQty as number) || 0;
  return {
    productId: raw.ProductGuid as string || raw.Guid as string,
    productCode: raw.ProductCode as string,
    productName: raw.ProductDescription as string,
    warehouseId: raw.WarehouseId as string || "",
    warehouseName: (raw.Warehouse as string) || "",
    quantity: qtyOnHand,
    allocatedQty,
    availableQty: qtyOnHand - allocatedQty,
    lastMovementDate: parseDate(raw.LastModifiedOn),
    reorderPoint: raw.MinStockAlertLevel as number || 0,
    reorderQuantity: raw.ReOrderPoint as number || 0,
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
    unitOfMeasure: (raw.UnitOfMeasure as Record<string, unknown>)?.Name as string || "",
    reorderPoint: raw.ReOrderPoint as number || 0,
    reorderQuantity: raw.MinStockAlertLevel as number || 0,
    discontinue: raw.Obsolete as boolean || false,
    supplier: sup ? {
      supplierId: sup.Guid as string,
      supplierName: sup.SupplierName as string,
      supplierCode: sup.SupplierCode as string || "",
      supplierStatus: "Active" as const,
    } : undefined,
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

function normalizePOLine(raw: Record<string, unknown>): import("./types").PurchaseOrderLine {
  const product = raw.Product as Record<string, unknown> | null;
  return {
    lineNumber: raw.LineNumber as number,
    productCode: product?.ProductCode as string || "",
    productDescription: product?.ProductDescription as string || "",
    quantityOrdered: raw.OrderQuantity as number || 0,
    quantityReceived: raw.ReceiptQuantity as number || 0,
    unitAmount: raw.UnitPrice as number || 0,
    lineTotal: raw.LineTotal as number || 0,
    lineComment: raw.Comments as string | undefined,
    expectedDeliveryDate: parseDate(raw.DeliveryDate),
  };
}

function normalizePO(raw: Record<string, unknown>): PurchaseOrder {
  const supplier = raw.Supplier as Record<string, unknown> | null;
  const lines = (raw.PurchaseOrderLines as Record<string, unknown>[] || []);

  // Map Unleashed status names to our status type
  const rawStatus = raw.OrderStatus as string;
  let status: PurchaseOrder["status"] = "Open";
  if (rawStatus === "Partialled") status = "PartiallyReceived";
  else if (rawStatus === "Complete" || rawStatus === "Received") status = "Received";
  else if (rawStatus === "Cancelled" || rawStatus === "Deleted") status = "Cancelled";

  return {
    purchaseOrderId: raw.Guid as string,
    purchaseOrderNumber: raw.OrderNumber as string || "",
    orderNumber: raw.OrderNumber as string,
    supplierId: supplier?.Guid as string || "",
    supplierName: supplier?.SupplierName as string || "",
    supplierCode: supplier?.SupplierCode as string || "",
    orderedDate: parseDate(raw.OrderDate) || "",
    requiredDate: parseDate(raw.DeliveryDate),
    expectedDeliveryDate: parseDate(raw.DeliveryDate),
    receivedDate: parseDate(raw.ReceivedDate),
    status,
    orderTotal: raw.Total as number || 0,
    purchaseOrderLines: lines.map(normalizePOLine),
    comments: raw.Comments as string | undefined,
  };
}

function normalizeAssemblyLine(raw: Record<string, unknown>): import("./types").AssemblyLine {
  const product = raw.Product as Record<string, unknown> | null;
  return {
    lineNumber: raw.LineNumber as number || 0,
    productCode: product?.ProductCode as string || "",
    productDescription: product?.ProductDescription as string || "",
    quantityPerParent: 0, // not provided directly by API
    warehouseCode: "",
    componentQuantity: raw.Quantity as number || 0,
  };
}

function normalizeAssembly(raw: Record<string, unknown>): Assembly {
  const product = raw.Product as Record<string, unknown> | null;
  const srcWarehouse = raw.SourceWarehouse as Record<string, unknown> | null;
  const lines = (raw.AssemblyLines as Record<string, unknown>[] || []);

  return {
    assemblyId: raw.Guid as string,
    assemblyNumber: (raw.AssemblyNumber as string) || "",
    productId: product?.Guid as string || "",
    productCode: product?.ProductCode as string || "",
    productName: product?.ProductDescription as string || "",
    productDescription: product?.ProductDescription as string || "",
    quantity: raw.Quantity as number || 0,
    status: (raw.AssemblyStatus as string) || "",
    warehouseId: srcWarehouse?.Guid as string || "",
    warehouseName: srcWarehouse?.WarehouseName as string || "",
    assemblyLines: lines.map(normalizeAssemblyLine),
    createdOn: parseDate(raw.CreatedOn) || "",
    lastModifiedOn: parseDate(raw.LastModifiedOn),
    assembleBy: parseDate(raw.AssembleBy),
    comments: (raw.Comments as string | undefined) || undefined,
  };
}

function normalizeBOM(raw: Record<string, unknown>): BOMEntry[] {
  const product = raw.Product as Record<string, unknown> | null;
  const parentCode = product?.ProductCode as string || "";
  const lines = raw.BillOfMaterialsLines as Record<string, unknown>[] || [];

  return lines.map((line) => {
    const lineProduct = line.Product as Record<string, unknown> | null;
    return {
      productCode: lineProduct?.ProductCode as string || "",
      productDescription: lineProduct?.ProductDescription as string || "",
      quantityPerParent: line.Quantity as number || 0,
      warehouseCode: "",
      level: 0,
      parentProductCode: parentCode,
    };
  });
}

// ─── Public fetch functions ───────────────────────────────────

export async function fetchStockOnHand(): Promise<StockOnHandItem[]> {
  return fetchAllPages("StockOnHand", {}, normalizeSOH);
}

export async function fetchAllocations(
  productCode?: string
): Promise<AllocationItem[]> {
  const query: Record<string, string> = {};
  if (productCode) query.productCode = productCode;

  // Allocations come as part of SOH — map to AllocationItem shape
  const items = await fetchSinglePage("StockOnHand/Allocations", query, (raw) => ({
    productCode: raw.ProductCode as string,
    productName: raw.ProductDescription as string,
    allocatedQuantity: raw.AllocatedQty as number || 0,
    orderNumber: raw.OrderNumber as string || "",
    orderType: raw.OrderType as string || "",
    warehouseId: raw.WarehouseId as string || "",
  }));

  return items;
}

export async function fetchStockOnHandByProduct(
  productCode: string
): Promise<StockOnHandItem[]> {
  return fetchSinglePage("StockOnHand", { productCode }, normalizeSOH);
}

export async function fetchAssemblies(options?: {
  startDate?: string;
  endDate?: string;
}): Promise<Assembly[]> {
  const query: Record<string, string> = {};
  if (options?.startDate) query.startDate = options.startDate;
  if (options?.endDate) query.endDate = options.endDate;
  return fetchAllPages("Assemblies", query, normalizeAssembly);
}

export async function fetchAssemblyById(assemblyId: string): Promise<Assembly> {
  const response = await callProxy<RawPaginatedResponse>({
    endpoint: `Assemblies/${assemblyId}`,
  });

  if (response.Items.length === 0) {
    throw new Error(`Assembly not found: ${assemblyId}`);
  }

  return normalizeAssembly(response.Items[0]);
}

export async function fetchBOMs(productCode: string): Promise<BOMEntry[]> {
  const response = await callProxy<RawPaginatedResponse>({
    endpoint: "BillOfMaterials",
    query: { productCode },
  });

  // Each BOM item contains lines — flatten all lines
  const allEntries: BOMEntry[] = [];
  for (const raw of response.Items) {
    allEntries.push(...normalizeBOM(raw));
  }
  return allEntries;
}

export async function fetchPurchaseOrders(): Promise<PurchaseOrder[]> {
  return fetchAllPages("PurchaseOrders", {}, normalizePO);
}

export async function fetchPurchaseOrdersByStatus(
  status: "Open" | "PartiallyReceived" | "Received" | "Cancelled"
): Promise<PurchaseOrder[]> {
  // Unleashed uses different status values in the query filter
  let apiStatus = status as string;
  if (status === "PartiallyReceived") apiStatus = "Partialled";
  if (status === "Received") apiStatus = "Complete";

  return fetchAllPages("PurchaseOrders", { orderStatus: apiStatus }, normalizePO);
}

export async function fetchWarehouses(): Promise<Warehouse[]> {
  return fetchSinglePage("Warehouses", {}, normalizeWarehouse);
}

export async function pushAssembly(
  assembly: AssemblyCreatePayload
): Promise<Assembly> {
  const response = await callProxy<Record<string, unknown>>({
    endpoint: "Assemblies",
    method: "POST",
    body: assembly,
  });

  // Handle both single-object and paginated response shapes
  if ("Items" in response) {
    const items = response.Items as Record<string, unknown>[];
    return normalizeAssembly(items[0]);
  }
  return normalizeAssembly(response);
}

export async function pushPurchaseOrder(
  purchaseOrder: PurchaseOrder
): Promise<PurchaseOrder> {
  const response = await callProxy<Record<string, unknown>>({
    endpoint: "PurchaseOrders",
    method: "POST",
    body: purchaseOrder,
  });

  return normalizePO(response);
}

export async function updatePurchaseOrder(
  purchaseOrderId: string,
  purchaseOrder: Partial<PurchaseOrder>
): Promise<PurchaseOrder> {
  const response = await callProxy<Record<string, unknown>>({
    endpoint: `PurchaseOrders/${purchaseOrderId}`,
    method: "PUT",
    body: purchaseOrder,
  });

  return normalizePO(response);
}

/**
 * Update an existing Unleashed assembly. Partial update — send only the
 * fields you want to change (quantity, comments, assemblyLines, …). Returns
 * the normalized assembly as Unleashed responds.
 *
 * Used by the packaging planner's UPDATE action when the user reschedules
 * or reassigns a live assembly to a different team.
 */
export async function updateAssembly(
  assemblyId: string,
  patch: Partial<Assembly>
): Promise<Assembly> {
  const response = await callProxy<Record<string, unknown>>({
    endpoint: `Assemblies/${assemblyId}`,
    method: "PUT",
    body: patch,
  });

  if ("Items" in response) {
    const items = response.Items as Record<string, unknown>[];
    return normalizeAssembly(items[0]);
  }
  return normalizeAssembly(response);
}

export async function fetchProducts(): Promise<Product[]> {
  return fetchAllPages("Products", {}, normalizeProduct);
}

export async function fetchProductByCode(
  productCode: string
): Promise<Product | null> {
  const items = await fetchSinglePage("Products", { productCode }, normalizeProduct);
  return items.length > 0 ? items[0] : null;
}

export async function fetchSuppliers(): Promise<Supplier[]> {
  return fetchAllPages("Suppliers", {}, normalizeSupplier);
}
