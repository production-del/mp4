/**
 * Assemblies cache — Phase 4j.
 *
 * Caches active Unleashed assemblies (kitchen + packaging production runs)
 * so the calendar's server component can render them without paying the
 * cost of a live Unleashed API call on every page load. Refreshed on
 * demand via `/api/refresh-assemblies`. Mirrors the soh-cache /
 * sales-orders-cache patterns.
 *
 * Cache shape:
 *   {
 *     "fetchedAt": "2026-05-01T10:00:00Z",
 *     "lines": [
 *       {
 *         "assemblyNumber": "A-12345",
 *         "productCode": "XHBC",
 *         "productName": "Chaga",
 *         "quantity": 60,
 *         "scheduledDate": "2026-05-15",
 *         "warehouseName": "Lundberg Storeroom",
 *         "status": "InProgress"
 *       }
 *     ],
 *     "totalLines": 47
 *   }
 *
 * Each line represents one assembly (one production run). The calendar
 * uses `warehouseName` to distinguish kitchen production (Lundberg) from
 * packaging production (already covered by the planner's optimiser).
 *
 * Tolerant on read: missing/malformed file → null → calendar renders
 * without kitchen chips.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import {
  dbReadCache,
  dbWriteCache,
  isDatabaseConfigured,
} from '@/lib/db/unleashed-cache-store';

// ─── Public types ────────────────────────────────────────────

export interface AssemblyCacheLine {
  assemblyNumber: string;
  productCode: string;
  productName: string;
  quantity: number;
  /** YYYY-MM-DD; derived from lastModifiedOn or createdOn. */
  scheduledDate: string;
  warehouseName: string;
  status: string;
}

export interface AssembliesCache {
  fetchedAt: string;
  lines: AssemblyCacheLine[];
  totalLines: number;
}

// ─── Storage ─────────────────────────────────────────────────

export function defaultAssembliesCachePath(cwd: string = process.cwd()): string {
  return join(cwd, 'data', 'assemblies-cache.json');
}

/** Validate any input as an AssembliesCache; null on shape mismatch. */
function validateAssembliesCache(parsed: unknown): AssembliesCache | null {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const r = parsed as Record<string, unknown>;
  if (typeof r.fetchedAt !== 'string' || !Array.isArray(r.lines)) return null;
  const cleaned: AssemblyCacheLine[] = [];
  for (const raw of r.lines) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const line = raw as Record<string, unknown>;
    if (
      typeof line.assemblyNumber !== 'string' ||
      typeof line.productCode !== 'string' ||
      typeof line.productName !== 'string' ||
      typeof line.quantity !== 'number' ||
      !Number.isFinite(line.quantity) ||
      typeof line.scheduledDate !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(line.scheduledDate) ||
      typeof line.warehouseName !== 'string' ||
      typeof line.status !== 'string'
    ) continue;
    cleaned.push({
      assemblyNumber: line.assemblyNumber,
      productCode: line.productCode,
      productName: line.productName,
      quantity: line.quantity,
      scheduledDate: line.scheduledDate,
      warehouseName: line.warehouseName,
      status: line.status,
    });
  }
  return {
    fetchedAt: r.fetchedAt,
    lines: cleaned,
    totalLines: typeof r.totalLines === 'number' ? r.totalLines : cleaned.length,
  };
}

/** File-only reader. Used by tests and fallback when DATABASE_URL absent. */
export function readAssembliesCacheFromFile(
  filePath: string = defaultAssembliesCachePath(),
): AssembliesCache | null {
  if (!existsSync(filePath)) return null;
  try {
    return validateAssembliesCache(JSON.parse(readFileSync(filePath, 'utf-8')));
  } catch {
    return null;
  }
}

export function writeAssembliesCacheToFile(
  cache: AssembliesCache,
  filePath: string = defaultAssembliesCachePath(),
): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, JSON.stringify(cache, null, 2) + '\n', 'utf-8');
}

/** Storage-agnostic reader (Phase 4p). DB when configured, else file. */
export async function readAssembliesCache(
  filePath: string = defaultAssembliesCachePath(),
): Promise<AssembliesCache | null> {
  if (isDatabaseConfigured()) {
    const row = await dbReadCache<unknown>('assemblies');
    if (row) {
      const validated = validateAssembliesCache(row.payload);
      if (validated) return validated;
    }
  }
  return readAssembliesCacheFromFile(filePath);
}

/** Storage-agnostic writer (Phase 4p). */
export async function writeAssembliesCache(
  cache: AssembliesCache,
  filePath: string = defaultAssembliesCachePath(),
): Promise<void> {
  if (isDatabaseConfigured()) {
    await dbWriteCache('assemblies', cache, cache.fetchedAt);
    return;
  }
  writeAssembliesCacheToFile(cache, filePath);
}

// ─── Builder ─────────────────────────────────────────────────

export interface RawAssembly {
  assemblyNumber: string;
  productCode: string;
  productName: string;
  quantity: number;
  warehouseName: string;
  status: string;
  /**
   * Phase 4l.12 — the actual SCHEDULED date from Unleashed (Unleashed's
   * `AssembleBy` field). Use this when present — it's the date the
   * kitchen team / packaging team has committed to. Falls back to
   * lastModifiedOn / createdOn (record audit timestamps) only when
   * AssembleBy is missing, since those audit dates often cluster
   * around "today" and produce misleading calendar placements.
   */
  assembleBy?: string | null;
  /** Either ISO datetime or null. */
  lastModifiedOn?: string | null;
  /** Fallback when lastModifiedOn is absent. */
  createdOn?: string | null;
}

/**
 * Convert raw Unleashed assemblies into cache lines. Skips assemblies
 * without a usable scheduled date (defensive — Unleashed shouldn't return
 * these but cache integrity matters more than completeness).
 *
 * Date derivation: PREFER `assembleBy` (the user's intended scheduled
 * date in Unleashed). Fall back to lastModifiedOn / createdOn only when
 * AssembleBy is missing — those are audit timestamps and cluster on
 * "today" rather than reflecting real production timing.
 */
export function buildAssembliesCache(
  raw: RawAssembly[],
): AssembliesCache {
  const lines: AssemblyCacheLine[] = [];
  for (const a of raw) {
    const dateSource = a.assembleBy ?? a.lastModifiedOn ?? a.createdOn;
    if (!dateSource) continue;
    const d = new Date(dateSource);
    let iso: string;
    if (isNaN(d.getTime())) {
      iso = dateSource.slice(0, 10);
    } else {
      iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) continue;
    if (!a.productCode || !a.assemblyNumber) continue;
    if (!Number.isFinite(a.quantity) || a.quantity <= 0) continue;
    lines.push({
      assemblyNumber: a.assemblyNumber,
      productCode: a.productCode,
      productName: a.productName,
      quantity: a.quantity,
      scheduledDate: iso,
      warehouseName: a.warehouseName,
      status: a.status,
    });
  }
  return {
    fetchedAt: new Date().toISOString(),
    lines,
    totalLines: lines.length,
  };
}

// ─── Lookups ─────────────────────────────────────────────────

/**
 * Get assemblies at a specific warehouse. The calendar uses this with
 * `'Lundberg Storeroom'` to surface kitchen production runs as chips,
 * separate from the planner's packaging output.
 */
export function assembliesAtWarehouse(
  cache: AssembliesCache | null,
  warehouseName: string,
): AssemblyCacheLine[] {
  if (!cache) return [];
  return cache.lines.filter((l) => l.warehouseName === warehouseName);
}
