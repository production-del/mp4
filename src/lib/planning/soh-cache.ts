/**
 * Stock-on-hand cache — Phase 4g.
 *
 * The planner needs initial-inventory per SKU but the Unleashed
 * `/StockOnHand` endpoint takes seconds and the calendar's server
 * component would be unusable if it lived-fetched on every render.
 * Instead we cache SOH to `data/soh-cache.json` and refresh on demand
 * via the `/api/refresh-soh` endpoint.
 *
 * Cache shape — single document, keyed by SKU:
 *   {
 *     "fetchedAt": "2026-05-01T10:00:00.000Z",
 *     "warehouseFilter": "MF Packaging",
 *     "byProductCode": { "FCHAGALG": 234, "MFWALNUME": 1500 },
 *     "totalRecords": 412
 *   }
 *
 * Server component reads the cache (fast, deterministic, works offline);
 * operator clicks "Refresh SOH" in the UI to re-pull from Unleashed when
 * they want fresh numbers. This pattern mirrors product-overrides.ts.
 *
 * Tolerant by design: missing cache file means "no SOH known" → planner
 * treats every product as having 0 starting stock (the prior behaviour).
 * Malformed JSON, wrong shape, etc. → same fallback. No throws on read.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';

// ─── Public types ────────────────────────────────────────────

export interface SohCache {
  /** ISO timestamp of the last successful refresh. */
  fetchedAt: string;
  /** Warehouse the cache was fetched against, for traceability. Empty string = all warehouses summed. */
  warehouseFilter: string;
  /** SKU → quantity. Lookups default to 0 for absent codes. */
  byProductCode: Record<string, number>;
  /** Number of records that contributed (informational; may exceed byProductCode size if multiple records per SKU were summed). */
  totalRecords: number;
}

// ─── Storage ─────────────────────────────────────────────────

export function defaultSohCachePath(cwd: string = process.cwd()): string {
  return join(cwd, 'data', 'soh-cache.json');
}

/** Read the cache. Returns null if file missing or unparseable. */
export function readSohCache(
  filePath: string = defaultSohCachePath(),
): SohCache | null {
  if (!existsSync(filePath)) return null;
  try {
    const text = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const r = parsed as Record<string, unknown>;
    if (
      typeof r.fetchedAt !== 'string' ||
      typeof r.warehouseFilter !== 'string' ||
      !r.byProductCode ||
      typeof r.byProductCode !== 'object' ||
      Array.isArray(r.byProductCode)
    ) {
      return null;
    }
    // Validate the byProductCode entries — drop anything non-numeric.
    const cleaned: Record<string, number> = {};
    for (const [k, v] of Object.entries(r.byProductCode)) {
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) cleaned[k] = v;
    }
    return {
      fetchedAt: r.fetchedAt,
      warehouseFilter: r.warehouseFilter,
      byProductCode: cleaned,
      totalRecords: typeof r.totalRecords === 'number' ? r.totalRecords : Object.keys(cleaned).length,
    };
  } catch {
    return null;
  }
}

export function writeSohCache(
  cache: SohCache,
  filePath: string = defaultSohCachePath(),
): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, JSON.stringify(cache, null, 2) + '\n', 'utf-8');
}

// ─── Lookup helper ──────────────────────────────────────────

export function sohOf(cache: SohCache | null, productCode: string): number {
  return cache?.byProductCode[productCode] ?? 0;
}

// ─── Builder (used by the refresh API route) ────────────────

export interface SohRecord {
  productCode: string;
  warehouseName: string;
  qtyOnHand: number;
}

/**
 * Aggregate raw SOH records into the cache shape. When `warehouseFilter` is
 * provided, only records matching that warehouse name are summed; otherwise
 * all records contribute. Multiple records for the same SKU sum together.
 */
export function buildSohCache(
  records: SohRecord[],
  warehouseFilter: string = '',
): SohCache {
  const byProductCode: Record<string, number> = {};
  let included = 0;
  for (const r of records) {
    if (!r.productCode) continue;
    if (warehouseFilter && r.warehouseName !== warehouseFilter) continue;
    if (!Number.isFinite(r.qtyOnHand) || r.qtyOnHand < 0) continue;
    byProductCode[r.productCode] = (byProductCode[r.productCode] ?? 0) + r.qtyOnHand;
    included += 1;
  }
  return {
    fetchedAt: new Date().toISOString(),
    warehouseFilter,
    byProductCode,
    totalRecords: included,
  };
}
