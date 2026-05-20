/**
 * Purchase orders cache — Phase 4l.5.
 *
 * Caches Unleashed-resident purchase orders that are still outstanding
 * (status `Placed` / `Parked` → "Open", `Receipted` → "PartiallyReceived").
 * Each cache line represents ONE outstanding line item on a PO, sized to
 * the un-received quantity (`quantityOrdered − quantityReceived`).
 *
 * The planner uses these as **scheduled supply** for raw materials so that
 * shortage projection (and therefore synthetic PO sizing) accounts for
 * stock that's already on its way. They also render as view-only PO chips
 * on the calendar with an "Unleashed" badge so the operator can see what's
 * already committed.
 *
 * Tolerant on read: missing/malformed file → null → planner renders without
 * the supply credit.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import {
  dbReadCache,
  dbWriteCache,
  isDatabaseConfigured,
} from '@/lib/db/unleashed-cache-store';

// ─── Public types ────────────────────────────────────────────

export interface PurchaseOrderCacheLine {
  purchaseOrderNumber: string;
  /** Unleashed line number within the PO; lets us join back if needed. */
  lineNumber: number;
  productCode: string;
  productName: string;
  /** Outstanding qty = ordered − received (always > 0; fully-received lines are dropped). */
  quantity: number;
  /** YYYY-MM-DD when this line is expected to arrive. */
  expectedDeliveryDate: string;
  supplierName: string;
  /** "Open" or "PartiallyReceived". */
  status: 'Open' | 'PartiallyReceived';
}

export interface PurchaseOrdersCache {
  fetchedAt: string;
  lines: PurchaseOrderCacheLine[];
  totalLines: number;
}

// ─── Storage ─────────────────────────────────────────────────

export function defaultPurchaseOrdersCachePath(cwd: string = process.cwd()): string {
  return join(cwd, 'data', 'purchase-orders-cache.json');
}

function validatePurchaseOrdersCache(parsed: unknown): PurchaseOrdersCache | null {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const r = parsed as Record<string, unknown>;
  if (typeof r.fetchedAt !== 'string' || !Array.isArray(r.lines)) return null;
  const cleaned: PurchaseOrderCacheLine[] = [];
  for (const raw of r.lines) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const line = raw as Record<string, unknown>;
    if (
      typeof line.purchaseOrderNumber !== 'string' ||
      typeof line.lineNumber !== 'number' ||
      typeof line.productCode !== 'string' ||
      typeof line.productName !== 'string' ||
      typeof line.quantity !== 'number' ||
      !Number.isFinite(line.quantity) ||
      line.quantity <= 0 ||
      typeof line.expectedDeliveryDate !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(line.expectedDeliveryDate) ||
      typeof line.supplierName !== 'string' ||
      (line.status !== 'Open' && line.status !== 'PartiallyReceived')
    ) {
      continue;
    }
    cleaned.push({
      purchaseOrderNumber: line.purchaseOrderNumber,
      lineNumber: line.lineNumber,
      productCode: line.productCode,
      productName: line.productName,
      quantity: line.quantity,
      expectedDeliveryDate: line.expectedDeliveryDate,
      supplierName: line.supplierName,
      status: line.status,
    });
  }
  return {
    fetchedAt: r.fetchedAt,
    lines: cleaned,
    totalLines: typeof r.totalLines === 'number' ? r.totalLines : cleaned.length,
  };
}

export function readPurchaseOrdersCacheFromFile(
  filePath: string = defaultPurchaseOrdersCachePath(),
): PurchaseOrdersCache | null {
  if (!existsSync(filePath)) return null;
  try {
    return validatePurchaseOrdersCache(JSON.parse(readFileSync(filePath, 'utf-8')));
  } catch {
    return null;
  }
}

export function writePurchaseOrdersCacheToFile(
  cache: PurchaseOrdersCache,
  filePath: string = defaultPurchaseOrdersCachePath(),
): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, JSON.stringify(cache, null, 2) + '\n', 'utf-8');
}

export async function readPurchaseOrdersCache(
  filePath: string = defaultPurchaseOrdersCachePath(),
): Promise<PurchaseOrdersCache | null> {
  if (isDatabaseConfigured()) {
    const row = await dbReadCache<unknown>('purchase-orders');
    if (row) {
      const validated = validatePurchaseOrdersCache(row.payload);
      if (validated) return validated;
    }
  }
  return readPurchaseOrdersCacheFromFile(filePath);
}

export async function writePurchaseOrdersCache(
  cache: PurchaseOrdersCache,
  filePath: string = defaultPurchaseOrdersCachePath(),
): Promise<void> {
  if (isDatabaseConfigured()) {
    await dbWriteCache('purchase-orders', cache, cache.fetchedAt);
    return;
  }
  writePurchaseOrdersCacheToFile(cache, filePath);
}

// ─── Builder ─────────────────────────────────────────────────

export interface RawPurchaseOrder {
  purchaseOrderNumber: string;
  supplierName: string;
  status: 'Open' | 'PartiallyReceived';
  /** PO-level fallback when line.expectedDeliveryDate is absent. */
  expectedDeliveryDate?: string | null;
  requiredDate?: string | null;
  orderedDate?: string | null;
  lines: Array<{
    lineNumber: number;
    productCode: string;
    productDescription: string;
    quantityOrdered: number;
    quantityReceived: number;
    expectedDeliveryDate?: string | null;
  }>;
}

/**
 * Convert raw Unleashed POs into cache lines, one per outstanding line item.
 * Lines with ordered ≤ received are dropped (fully fulfilled). Date
 * fallback ladder: line.expectedDeliveryDate → po.expectedDeliveryDate →
 * po.requiredDate → po.orderedDate. Lines with no usable date are dropped
 * (defensive — cache integrity matters more than completeness).
 */
export function buildPurchaseOrdersCache(
  raw: RawPurchaseOrder[],
): PurchaseOrdersCache {
  const out: PurchaseOrderCacheLine[] = [];
  for (const po of raw) {
    for (const ln of po.lines) {
      const outstanding = ln.quantityOrdered - ln.quantityReceived;
      if (!(outstanding > 0)) continue;
      const dateSource =
        ln.expectedDeliveryDate ||
        po.expectedDeliveryDate ||
        po.requiredDate ||
        po.orderedDate;
      if (!dateSource) continue;
      const d = new Date(dateSource);
      let iso: string;
      if (isNaN(d.getTime())) {
        iso = dateSource.slice(0, 10);
      } else {
        iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) continue;
      if (!ln.productCode || !po.purchaseOrderNumber) continue;
      out.push({
        purchaseOrderNumber: po.purchaseOrderNumber,
        lineNumber: ln.lineNumber,
        productCode: ln.productCode,
        productName: ln.productDescription || ln.productCode,
        quantity: outstanding,
        expectedDeliveryDate: iso,
        supplierName: po.supplierName,
        status: po.status,
      });
    }
  }
  return {
    fetchedAt: new Date().toISOString(),
    lines: out,
    totalLines: out.length,
  };
}
