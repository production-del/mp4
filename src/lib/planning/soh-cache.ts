/**
 * Stock-on-hand cache — Phase 4g + 4h.2.
 *
 * The planner needs initial-inventory per SKU but the Unleashed
 * `/StockOnHand` endpoint takes seconds and the calendar's server
 * component would be unusable if it lived-fetched on every render.
 * Instead we cache SOH to `data/soh-cache.json` and refresh on demand
 * via the `/api/refresh-soh` endpoint.
 *
 * Cache shape — single document, keyed by SKU then by warehouse name.
 * Phase 4h.2 added the per-warehouse breakdown: previously we summed
 * across warehouses on write, losing the location data the planner
 * needs for transfer detection (Phase 4i).
 *
 *   {
 *     "fetchedAt": "2026-05-01T10:00:00.000Z",
 *     "byProductCode": {
 *       "FCHAGALG": { "MF Packaging": 234, "Lundberg": 56 },
 *       "MFWALNUME": { "MF Packaging": 1500 }
 *     },
 *     "warehouses": ["MF Packaging", "Lundberg", ...],
 *     "totalRecords": 412
 *   }
 *
 * Lookup helpers:
 *   sohOf(cache, productCode, "MF Packaging") → 234
 *   sohOf(cache, productCode)                 → sum across all warehouses
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
import {
  dbReadCache,
  dbWriteCache,
  isDatabaseConfigured,
} from '@/lib/db/unleashed-cache-store';

// ─── Public types ────────────────────────────────────────────

export interface SohCache {
  /** ISO timestamp of the last successful refresh. */
  fetchedAt: string;
  /** SKU → warehouse name → quantity. Empty record for absent codes. */
  byProductCode: Record<string, Record<string, number>>;
  /** Distinct warehouses seen in any record, for UI selectors. */
  warehouses: string[];
  /** Number of records that contributed. */
  totalRecords: number;
}

// ─── Storage ─────────────────────────────────────────────────

export function defaultSohCachePath(cwd: string = process.cwd()): string {
  return join(cwd, 'data', 'soh-cache.json');
}

/**
 * Validate an unknown value as a SohCache. Used by both the file reader
 * and the DB reader so the same data hygiene applies to either path.
 * Returns null if the shape is wrong, otherwise a cleaned cache (drops
 * non-numeric quantities, missing warehouses).
 */
function validateSohCache(parsed: unknown): SohCache | null {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const r = parsed as Record<string, unknown>;
  if (
    typeof r.fetchedAt !== 'string' ||
    !r.byProductCode ||
    typeof r.byProductCode !== 'object' ||
    Array.isArray(r.byProductCode)
  ) {
    return null;
  }
  const cleaned: Record<string, Record<string, number>> = {};
  const warehousesSet = new Set<string>();
  for (const [productCode, byWh] of Object.entries(r.byProductCode)) {
    if (!byWh || typeof byWh !== 'object' || Array.isArray(byWh)) continue;
    const innerCleaned: Record<string, number> = {};
    for (const [wh, qty] of Object.entries(byWh as Record<string, unknown>)) {
      if (typeof qty === 'number' && Number.isFinite(qty) && qty >= 0 && wh) {
        innerCleaned[wh] = qty;
        warehousesSet.add(wh);
      }
    }
    if (Object.keys(innerCleaned).length > 0) {
      cleaned[productCode] = innerCleaned;
    }
  }
  return {
    fetchedAt: r.fetchedAt,
    byProductCode: cleaned,
    warehouses: Array.isArray(r.warehouses)
      ? (r.warehouses as unknown[]).filter((w): w is string => typeof w === 'string')
      : Array.from(warehousesSet).sort(),
    totalRecords:
      typeof r.totalRecords === 'number' ? r.totalRecords : Object.keys(cleaned).length,
  };
}

/**
 * File-only reader. Used by tests and as a fallback when DATABASE_URL
 * isn't configured. Returns null if file missing or unparseable.
 */
export function readSohCacheFromFile(
  filePath: string = defaultSohCachePath(),
): SohCache | null {
  if (!existsSync(filePath)) return null;
  try {
    const text = readFileSync(filePath, 'utf-8');
    return validateSohCache(JSON.parse(text));
  } catch {
    return null;
  }
}

/** File-only writer. */
export function writeSohCacheToFile(
  cache: SohCache,
  filePath: string = defaultSohCachePath(),
): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, JSON.stringify(cache, null, 2) + '\n', 'utf-8');
}

/**
 * Storage-agnostic reader (Phase 4p).
 *   • DATABASE_URL set     → Postgres (`unleashed_cache` table, kind='soh')
 *   • DATABASE_URL absent  → file (`data/soh-cache.json`)
 *
 * Returns null when nothing usable exists in either store.
 */
export async function readSohCache(
  filePath: string = defaultSohCachePath(),
): Promise<SohCache | null> {
  if (isDatabaseConfigured()) {
    const row = await dbReadCache<unknown>('soh');
    if (row) {
      const validated = validateSohCache(row.payload);
      if (validated) return validated;
      // DB row exists but its shape is unusable — fall through to file
      // rather than returning null so we have a sane local snapshot.
    }
  }
  return readSohCacheFromFile(filePath);
}

/**
 * Storage-agnostic writer (Phase 4p).
 *   • DATABASE_URL set     → Postgres (atomic upsert via dbWriteCache)
 *   • DATABASE_URL absent  → file
 */
export async function writeSohCache(
  cache: SohCache,
  filePath: string = defaultSohCachePath(),
): Promise<void> {
  if (isDatabaseConfigured()) {
    await dbWriteCache('soh', cache, cache.fetchedAt);
    return;
  }
  writeSohCacheToFile(cache, filePath);
}

// ─── Lookup helpers ─────────────────────────────────────────

/**
 * Look up SOH for a product. With `warehouse` set, returns the quantity at
 * that specific warehouse (0 if none). Without `warehouse`, returns the sum
 * across all warehouses for that product.
 */
export function sohOf(
  cache: SohCache | null,
  productCode: string,
  warehouse?: string,
): number {
  const byWh = cache?.byProductCode[productCode];
  if (!byWh) return 0;
  if (warehouse !== undefined) return byWh[warehouse] ?? 0;
  let sum = 0;
  for (const v of Object.values(byWh)) sum += v;
  return sum;
}

/** Returns the per-warehouse breakdown for a product, or null if absent. */
export function sohBreakdownOf(
  cache: SohCache | null,
  productCode: string,
): Record<string, number> | null {
  return cache?.byProductCode[productCode] ?? null;
}

// ─── Builder (used by the refresh API route) ────────────────

export interface SohRecord {
  productCode: string;
  warehouseName: string;
  qtyOnHand: number;
}

/**
 * Aggregate raw SOH records into the cache's per-warehouse shape. Records
 * with the same (productCode, warehouseName) sum together (defensive — the
 * Unleashed endpoint shouldn't return duplicates but we don't rely on it).
 */
export function buildSohCache(records: SohRecord[]): SohCache {
  const byProductCode: Record<string, Record<string, number>> = {};
  const warehousesSet = new Set<string>();
  let included = 0;
  for (const r of records) {
    if (!r.productCode || !r.warehouseName) continue;
    if (!Number.isFinite(r.qtyOnHand) || r.qtyOnHand < 0) continue;
    let inner = byProductCode[r.productCode];
    if (!inner) {
      inner = {};
      byProductCode[r.productCode] = inner;
    }
    inner[r.warehouseName] = (inner[r.warehouseName] ?? 0) + r.qtyOnHand;
    warehousesSet.add(r.warehouseName);
    included += 1;
  }
  return {
    fetchedAt: new Date().toISOString(),
    byProductCode,
    warehouses: Array.from(warehousesSet).sort(),
    totalRecords: included,
  };
}
