/**
 * Sales-orders cache — Phase 4h.3.
 *
 * Caches active customer sales orders so the calendar's server component
 * can feed them into the forecaster as committed-demand events without
 * a slow live Unleashed call on every render. Mirrors the soh-cache /
 * product-overrides patterns: file at `data/sales-orders-cache.json`,
 * refreshed on demand via `/api/refresh-sales-orders`.
 *
 * Cache shape:
 *   {
 *     "fetchedAt": "2026-05-01T10:00:00.000Z",
 *     "lines": [
 *       {
 *         "productCode": "FCHAGALG",
 *         "quantityRemaining": 50,
 *         "requiredDate": "2026-05-15",
 *         "orderNumber": "SO-12345",
 *         "customerName": "Some Cafe",
 *         "orderStatus": "Placed"
 *       }
 *     ],
 *     "totalLines": 217
 *   }
 *
 * `quantityRemaining` is `quantityOrdered - quantityAllocated` —
 * unfulfilled units still expected to ship. We only keep lines with
 * remainder > 0.
 *
 * `requiredDate` is the customer's expected ship date. When absent
 * (Unleashed allows null), we drop the line — it can't be bucketed
 * into a planning week. Could later be approximated from `orderedDate`
 * + standard lead time, but that's heuristic.
 *
 * Tolerant on read: missing/malformed file → null → planner runs as
 * if there are no committed orders.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import {
  dbReadCache,
  dbWriteCache,
  isDatabaseConfigured,
} from '@/lib/db/unleashed-cache-store';

// ─── Public types ────────────────────────────────────────────

export interface SalesOrderLineSummary {
  productCode: string;
  /** Unfulfilled units — already-shipped portion is excluded. */
  quantityRemaining: number;
  /** ISO date YYYY-MM-DD when the customer expects this. */
  requiredDate: string;
  /** Order number for traceability + drawer display. */
  orderNumber: string;
  /** Customer name for drawer display. */
  customerName: string;
  /** Unleashed status — Placed, Backordered, Parked. */
  orderStatus: string;
}

export interface SalesOrdersCache {
  fetchedAt: string;
  lines: SalesOrderLineSummary[];
  totalLines: number;
}

// ─── Storage ─────────────────────────────────────────────────

export function defaultSalesOrdersCachePath(cwd: string = process.cwd()): string {
  return join(cwd, 'data', 'sales-orders-cache.json');
}

/** Validate any input as a SalesOrdersCache; null on shape mismatch. */
function validateSalesOrdersCache(parsed: unknown): SalesOrdersCache | null {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const r = parsed as Record<string, unknown>;
  if (typeof r.fetchedAt !== 'string' || !Array.isArray(r.lines)) return null;
  const cleaned: SalesOrderLineSummary[] = [];
  for (const raw of r.lines) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const line = raw as Record<string, unknown>;
    if (
      typeof line.productCode !== 'string' ||
      typeof line.quantityRemaining !== 'number' ||
      !Number.isFinite(line.quantityRemaining) ||
      line.quantityRemaining <= 0 ||
      typeof line.requiredDate !== 'string' ||
      typeof line.orderNumber !== 'string' ||
      typeof line.customerName !== 'string' ||
      typeof line.orderStatus !== 'string'
    ) continue;
    cleaned.push({
      productCode: line.productCode,
      quantityRemaining: line.quantityRemaining,
      requiredDate: line.requiredDate,
      orderNumber: line.orderNumber,
      customerName: line.customerName,
      orderStatus: line.orderStatus,
    });
  }
  return {
    fetchedAt: r.fetchedAt,
    lines: cleaned,
    totalLines: typeof r.totalLines === 'number' ? r.totalLines : cleaned.length,
  };
}

/** File-only reader. Used by tests and as fallback when DATABASE_URL absent. */
export function readSalesOrdersCacheFromFile(
  filePath: string = defaultSalesOrdersCachePath(),
): SalesOrdersCache | null {
  if (!existsSync(filePath)) return null;
  try {
    return validateSalesOrdersCache(JSON.parse(readFileSync(filePath, 'utf-8')));
  } catch {
    return null;
  }
}

export function writeSalesOrdersCacheToFile(
  cache: SalesOrdersCache,
  filePath: string = defaultSalesOrdersCachePath(),
): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, JSON.stringify(cache, null, 2) + '\n', 'utf-8');
}

/** Storage-agnostic reader (Phase 4p). DB when configured, else file. */
export async function readSalesOrdersCache(
  filePath: string = defaultSalesOrdersCachePath(),
): Promise<SalesOrdersCache | null> {
  if (isDatabaseConfigured()) {
    const row = await dbReadCache<unknown>('sales-orders');
    if (row) {
      const validated = validateSalesOrdersCache(row.payload);
      if (validated) return validated;
    }
  }
  return readSalesOrdersCacheFromFile(filePath);
}

/** Storage-agnostic writer (Phase 4p). */
export async function writeSalesOrdersCache(
  cache: SalesOrdersCache,
  filePath: string = defaultSalesOrdersCachePath(),
): Promise<void> {
  if (isDatabaseConfigured()) {
    await dbWriteCache('sales-orders', cache, cache.fetchedAt);
    return;
  }
  writeSalesOrdersCacheToFile(cache, filePath);
}

// ─── Builder + lookup helpers ───────────────────────────────

export interface RawSalesOrderLine {
  productCode: string;
  quantityOrdered: number;
  quantityAllocated: number;
  requiredDate?: string | null;
  orderNumber: string;
  customerName: string;
  orderStatus: string;
}

/**
 * Convert raw Unleashed sales-order lines into the cache shape:
 *   - skip lines with no remainder (everything shipped)
 *   - skip lines with no requiredDate (can't bucket)
 *   - normalise requiredDate to YYYY-MM-DD (trim ISO time)
 */
export function buildSalesOrdersCache(
  rawLines: RawSalesOrderLine[],
): SalesOrdersCache {
  const lines: SalesOrderLineSummary[] = [];
  for (const r of rawLines) {
    if (!r.productCode || !r.requiredDate) continue;
    const remaining = r.quantityOrdered - r.quantityAllocated;
    if (!Number.isFinite(remaining) || remaining <= 0) continue;
    // Trim to YYYY-MM-DD so callers can safely string-compare.
    const date = r.requiredDate.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    lines.push({
      productCode: r.productCode,
      quantityRemaining: remaining,
      requiredDate: date,
      orderNumber: r.orderNumber,
      customerName: r.customerName,
      orderStatus: r.orderStatus,
    });
  }
  return {
    fetchedAt: new Date().toISOString(),
    lines,
    totalLines: lines.length,
  };
}

/** All sales-order lines for a product, sorted by requiredDate ascending. */
export function salesOrdersForProduct(
  cache: SalesOrdersCache | null,
  productCode: string,
): SalesOrderLineSummary[] {
  if (!cache) return [];
  return cache.lines
    .filter((l) => l.productCode === productCode)
    .sort((a, b) => a.requiredDate.localeCompare(b.requiredDate));
}

/** Total units of remaining commitment for a product. */
export function totalCommittedFor(
  cache: SalesOrdersCache | null,
  productCode: string,
): number {
  if (!cache) return 0;
  let total = 0;
  for (const l of cache.lines) {
    if (l.productCode === productCode) total += l.quantityRemaining;
  }
  return total;
}
