/**
 * Demand Override — client-side CSV-backed demand map.
 *
 * The planner's canonical demand rates come from `data/demand.csv` on the
 * server (read by `/api/demand-data`). Operators can upload a new CSV via
 * Settings → Demand Import, which stores the parsed map in localStorage and
 * takes precedence over the server file for this browser session.
 *
 * Shape mirrors `/api/demand-data` so consumers can swap sources freely:
 *   Record<productCode, monthlyKg>
 *
 * Clearing the override reverts to the server CSV. The server file is never
 * written from the browser — this is a local-only override.
 *
 * Storage key follows the rest of the app's versioned-store convention.
 */

const STORE_KEY = 'byron-demand-override-v1';

export interface DemandOverride {
  version: 1;
  /** productCode → monthly demand (kg). Same shape as `/api/demand-data`. */
  demand: Record<string, number>;
  /** ISO timestamp of the last successful import. */
  uploadedAt: string;
  /** Original filename, kept as a breadcrumb for the operator. */
  sourceFileName?: string;
}

export interface DemandOverrideInfo {
  count: number;
  uploadedAt: string;
  sourceFileName?: string;
}

function isBrowser(): boolean {
  return typeof window !== 'undefined';
}

export function readDemandOverride(): DemandOverride | null {
  if (!isBrowser()) return null;
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DemandOverride;
    if (parsed?.version !== 1 || typeof parsed.demand !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeDemandOverride(
  demand: Record<string, number>,
  sourceFileName?: string,
): void {
  if (!isBrowser()) return;
  const payload: DemandOverride = {
    version: 1,
    demand,
    uploadedAt: new Date().toISOString(),
    sourceFileName,
  };
  localStorage.setItem(STORE_KEY, JSON.stringify(payload));
  // Fire a storage event so other open tabs react immediately.
  window.dispatchEvent(new StorageEvent('storage', { key: STORE_KEY }));
}

export function clearDemandOverride(): void {
  if (!isBrowser()) return;
  localStorage.removeItem(STORE_KEY);
  window.dispatchEvent(new StorageEvent('storage', { key: STORE_KEY }));
}

export function getDemandOverrideInfo(): DemandOverrideInfo | null {
  const o = readDemandOverride();
  if (!o) return null;
  return {
    count: Object.keys(o.demand).length,
    uploadedAt: o.uploadedAt,
    sourceFileName: o.sourceFileName,
  };
}
