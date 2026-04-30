/**
 * TypeScript interfaces for Unleashed API integration
 * Based on Unleashed API documentation and schema
 */

export interface Product {
  productId: string;
  productCode: string;
  productDescription: string;
  productName: string;
  productGroup: string;
  unitOfMeasure: string;
  reorderPoint: number;
  reorderQuantity: number;
  discontinue: boolean;
  supplier?: Supplier;
  productStatus: "Active" | "Discontinued" | "Obsolete";
}

export interface Warehouse {
  warehouseId: string;
  warehouseName: string;
  warehouseCode: string;
  isDefault?: boolean;
  streetAddress?: string;
  city?: string;
  region?: string;
  country?: string;
  postCode?: string;
}

export interface StockOnHandItem {
  productId: string;
  productCode: string;
  productName: string;
  warehouseId: string;
  warehouseName: string;
  quantity: number;        // QtyOnHand (total physical stock)
  allocatedQty: number;    // AllocQty (committed to orders/assemblies)
  availableQty: number;    // QtyOnHand - AllocQty
  lastMovementDate?: string;
  reorderPoint: number;
  reorderQuantity: number;
}

export interface Supplier {
  supplierId: string;
  supplierName: string;
  supplierCode: string;
  supplierStatus: "Active" | "Inactive";
  contactName?: string;
  email?: string;
  phone?: string;
}

export interface AssemblyLine {
  lineNumber: number;
  productCode: string;
  productDescription: string;
  quantityPerParent: number;
  warehouseCode: string;
  componentQuantity: number;
}

export interface Assembly {
  assemblyId: string;
  assemblyNumber: string;
  productId: string;
  productCode: string;
  productName: string;
  productDescription: string;
  productGroup?: string;
  quantity: number;
  status: string;
  warehouseId: string;
  warehouseName: string;
  assemblyLines: AssemblyLine[];
  createdOn: string;
  lastModifiedOn?: string;
  /**
   * When the assembly is scheduled to be assembled (Unleashed's `AssembleBy`
   * field — surfaced in their UI as the "Assemble By" column). Preferred
   * over `createdOn` for all scheduling purposes: a record created today
   * for Monday next week should land on next Monday, not today.
   * ISO string; undefined when Unleashed hasn't been given one.
   */
  assembleBy?: string;
  /**
   * Free-form notes Unleashed stores on an assembly. We also piggyback
   * machine-readable tags here (e.g. `[TEAM:elephant]`) so resource
   * allocation survives in the ERP without a second source of truth.
   * See `src/lib/planning/assembly-meta.ts` for the tag grammar.
   */
  comments?: string;
}

export interface BOMEntry {
  productCode: string;
  productDescription: string;
  quantityPerParent: number;
  warehouseCode: string;
  level: number;
  parentProductCode: string;
}

export interface PurchaseOrderLine {
  lineNumber: number;
  productCode: string;
  productDescription: string;
  quantityOrdered: number;
  quantityReceived: number;
  unitAmount: number;
  lineTotal: number;
  lineComment?: string;
  expectedDeliveryDate?: string;
}

export interface PurchaseOrder {
  purchaseOrderId: string;
  purchaseOrderNumber: string;
  orderNumber?: string;
  supplierId: string;
  supplierName: string;
  supplierCode: string;
  orderedDate: string;
  requiredDate?: string;
  expectedDeliveryDate?: string;
  receivedDate?: string;
  status: "Open" | "PartiallyReceived" | "Received" | "Cancelled";
  orderTotal: number;
  purchaseOrderLines: PurchaseOrderLine[];
  comments?: string;
}

export interface UnleashedAPIResponse<T> {
  pageNumber: number;
  pageSize: number;
  recordsTotal: number;
  recordsFiltered: number;
  items: T[];
}

export interface UnleashedAPIError {
  statusCode: number;
  errorDetail: string;
  errorCode: string;
}

export interface AllocationItem {
  productCode: string;
  productName: string;
  allocatedQuantity: number;
  orderNumber: string;
  orderType: string; // "SalesOrder" | "Assembly" etc.
  warehouseId: string;
}

// ─── Sales orders ────────────────────────────────────────────

/**
 * A single line item on a sales order. Used by the Priority module to
 * attribute a packaging proposal back to the orders that caused the deficit.
 */
export interface SalesOrderLine {
  lineNumber: number;
  productCode: string;
  productDescription: string;
  quantityOrdered: number;
  quantityAllocated: number;
  quantityBackordered: number;
  unitAmount: number;
  lineTotal: number;
}

/**
 * A customer sales order. We only keep the fields relevant to priority
 * attribution + display — no financial detail, no addressing beyond the
 * customer name.
 *
 * Unleashed order statuses we care about:
 *   - `Placed`       active, expected to ship
 *   - `Backordered`  stock short; Unleashed has flagged it
 *   - `Parked`       draft / not yet submitted
 * Completed / Dispatched / Cancelled / Deleted are explicitly out of scope
 * for priority proposals.
 */
export interface SalesOrder {
  salesOrderId: string;
  orderNumber: string;
  orderStatus: "Placed" | "Backordered" | "Parked" | "Dispatched" | "Completed" | "Cancelled" | "Deleted" | string;
  customerId: string;
  customerName: string;
  orderedDate?: string;
  requiredDate?: string;
  salesOrderLines: SalesOrderLine[];
}

/** What we send to create an assembly (server fills assemblyId, createdOn) */
export type AssemblyCreatePayload = Omit<Assembly, 'assemblyId' | 'assemblyNumber' | 'status' | 'createdOn' | 'lastModifiedOn'>;
