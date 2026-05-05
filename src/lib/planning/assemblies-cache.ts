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

export function readAssembliesCache(
  filePath: string = defaultAssembliesCachePath(),
): AssembliesCache | null {
  if (!existsSync(filePath)) return null;
  try {
    const text = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(text);
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
  } catch {
    return null;
  }
}

export function writeAssembliesCache(
  cache: AssembliesCache,
  filePath: string = defaultAssembliesCachePath(),
): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, JSON.stringify(cache, null, 2) + '\n', 'utf-8');
}

// ─── Builder ─────────────────────────────────────────────────

export interface RawAssembly {
  assemblyNumber: string;
  productCode: string;
  productName: string;
  quantity: number;
  warehouseName: string;
  status: string;
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
 * Date derivation matches the existing `demandsFromKitchenAssemblies`
 * helper: prefer lastModifiedOn, fall back to createdOn, format to local
 * YYYY-MM-DD to avoid UTC-shifting Australian dates.
 */
export function buildAssembliesCache(
  raw: RawAssembly[],
): AssembliesCache {
  const lines: AssemblyCacheLine[] = [];
  for (const a of raw) {
    const dateSource = a.lastModifiedOn ?? a.createdOn;
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
