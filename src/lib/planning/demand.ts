/**
 * Demand — unified typed contract between planning stages.
 *
 * Planning stages produce and consume "demand": a quantity of a product needed
 * at a specific warehouse by a specific date. Previously each handoff had its
 * own shape (PackagingDeadline, KitchenBatch[], KitchenDemandItem,
 * PackagingDemandItem) and its own transport (localStorage JSON blob,
 * in-memory record of arrays, etc.). This module is the canonical type and
 * store for all pipeline demand.
 *
 * Two kinds of demand exist:
 *
 * 1. **Published** (user-driven, persisted in localStorage). Packaging plans
 *    produce demand for intermediates at MF Packaging. The kitchen and
 *    logistics pages subscribe to this.
 *
 * 2. **Derived** (computed from Unleashed data, never persisted). Kitchen
 *    assemblies imply component consumption at Lundberg. Both the purchasing
 *    projection and the transfer gap detector need this; they used to derive
 *    it independently. Now both call `demandsFromKitchenAssemblies()`.
 *
 * Monthly usage rates (CSV) are deliberately not modelled as Demand — they
 * are *rates*, not events, and live separately in `byron-packaging-config`.
 * The purchasing projection blends the two: rate as a steady drain, events
 * as discrete drops.
 */

import type { Assembly } from '@/lib/unleashed/types';
import type { KitchenBatch } from '@/lib/planning/engine-io';
import { fromLocalISODate } from './working-day';
import { WAREHOUSES } from './warehouse-assignments';

// ─── Types ────────────────────────────────────────────────────

/** Discriminated source of a demand entry — kitchen run or packaging run. */
export type DemandSource =
  | { type: 'kitchen_batch'; batchId: string; batchName: string }
  | { type: 'packaging_run'; runId: string; runName: string };

/** A single demand event: X units of `productCode` needed at `destinationWarehouse` by `needByDate`. */
export interface Demand {
  productCode: string;
  productName?: string;
  quantityNeeded: number;
  /** ISO YYYY-MM-DD (local timezone — use working-day helpers to convert). */
  needByDate: string;
  destinationWarehouse: string;
  source: DemandSource;
}

// ─── Storage ─────────────────────────────────────────────────

const STORE_KEY = 'byron-demand-v1';
const LEGACY_PACKAGING_KEY = 'byron-packaging-planned-dates';

interface DemandStoreShape {
  /** Demand published by the packaging planner (intermediates needed at MF Packaging). */
  packaging: Demand[];
}

function defaultStore(): DemandStoreShape {
  return { packaging: [] };
}

function readStore(): DemandStoreShape {
  if (typeof window === 'undefined') return defaultStore();
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return defaultStore();
    const parsed = JSON.parse(raw);
    return { packaging: Array.isArray(parsed.packaging) ? parsed.packaging : [] };
  } catch {
    return defaultStore();
  }
}

function writeStore(store: DemandStoreShape): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch {
    /* ignore */
  }
}

// ─── Published demand (packaging → kitchen / logistics) ──────

/** Overwrite the packaging planner's published demand. */
export function publishPackagingDemand(demands: Demand[]): void {
  const store = readStore();
  store.packaging = demands;
  writeStore(store);
  // Any authoritative publish from the planner supersedes the legacy blob —
  // discard it so a subsequent read doesn't resurrect stale data even when
  // the fresh publish is an explicit empty set.
  if (typeof window !== 'undefined') {
    localStorage.removeItem(LEGACY_PACKAGING_KEY);
  }
}

/** Read all demand currently published by the packaging planner. */
export function readPackagingDemand(): Demand[] {
  // Lazy migration: if the legacy key is present and the new store is empty
  // for the packaging origin, convert on first read. This handles every entry
  // point (kitchen, logistics, review) uniformly — the packaging planner's
  // "publish on change" effect otherwise overwrites a mount-time migration.
  maybeMigrateLegacy();
  return readStore().packaging;
}

/** Clear all packaging-published demand (e.g., after draft clear). */
export function clearPackagingDemand(): void {
  const store = readStore();
  store.packaging = [];
  writeStore(store);
}

// ─── Derived demand (kitchen consumption from Unleashed) ─────

/**
 * Convert Unleashed kitchen assemblies into component-level demand events at
 * Lundberg. Shared by the purchasing projection and the transfer gap detector —
 * previously each page had its own copy of this derivation.
 *
 * By default ALL assemblies are processed — the purchasing projection wants
 * every line's draw-down (it buys packaging materials too). Pass
 * `includeAssembly` to restrict to e.g. intermediate (kitchen) assemblies:
 * the transfer detector does this so packaging-FG BOM lines (labels, jars,
 * strips, …) don't leak into a phantom Lundberg requirement — those are
 * handled by `extractPackagingDemands`, which routes them to the run's own
 * warehouse.
 */
export function demandsFromKitchenAssemblies(
  assemblies: Assembly[],
  includeAssembly?: (assembly: Assembly) => boolean,
): Demand[] {
  const out: Demand[] = [];
  for (const assembly of assemblies) {
    if (includeAssembly && !includeAssembly(assembly)) continue;
    // Assemblies carry the scheduled date via lastModifiedOn (mirrors the
    // earlier `deriveConsumption*` helpers). Convert to local ISO so the
    // downstream shape is uniform.
    const dateSource = assembly.lastModifiedOn || assembly.createdOn;
    const d = new Date(dateSource);
    const iso = isNaN(d.getTime())
      ? dateSource.slice(0, 10)
      : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    for (const line of assembly.assemblyLines) {
      out.push({
        productCode: line.productCode,
        productName: line.productDescription,
        quantityNeeded: line.componentQuantity,
        needByDate: iso,
        destinationWarehouse: WAREHOUSES.LUNDBERG,
        source: {
          type: 'kitchen_batch',
          batchId: `${assembly.assemblyId}-${line.lineNumber}`,
          batchName: assembly.productName || assembly.productCode,
        },
      });
    }
  }
  return out;
}

// ─── Engine adapter ──────────────────────────────────────────

/**
 * Adapt `Demand[]` to the `Record<productCode, KitchenBatch[]>` shape the
 * purchasing projection and transfer detection engines still consume.
 *
 * This adapter will disappear in phase 6 once the engine accepts `Demand[]`
 * directly. For now it preserves engine signatures while the pipeline
 * contract converges on `Demand`.
 */
export function consumptionScheduleFromDemands(
  demands: Demand[],
): Record<string, KitchenBatch[]> {
  const schedule: Record<string, KitchenBatch[]> = {};
  for (const d of demands) {
    if (!schedule[d.productCode]) schedule[d.productCode] = [];
    const id = d.source.type === 'kitchen_batch' ? d.source.batchId : d.source.runId;
    schedule[d.productCode].push({
      id: `consumption-${id}`,
      productCode: d.productCode,
      productName: d.productName ?? d.productCode,
      quantity: d.quantityNeeded,
      scheduledDate: fromLocalISODate(d.needByDate),
      status: 'planned',
      dependencies: [],
    });
  }
  return schedule;
}

// ─── Legacy migration ────────────────────────────────────────

/**
 * One-shot migration of the old `byron-packaging-planned-dates` JSON blob
 * into the typed demand store. Invoked lazily from `readPackagingDemand`
 * so any consumer (kitchen, logistics, review) triggers it on first access.
 *
 * Idempotent: if the legacy key is absent or malformed, does nothing and
 * cleans up. If the new store already has packaging demand, deletes the
 * legacy key without overwriting.
 */
function maybeMigrateLegacy(): void {
  if (typeof window === 'undefined') return;
  try {
    const legacyRaw = localStorage.getItem(LEGACY_PACKAGING_KEY);
    if (!legacyRaw) return;

    // If we already have typed data, legacy is stale — discard it.
    const existing = readStore();
    if (existing.packaging.length > 0) {
      localStorage.removeItem(LEGACY_PACKAGING_KEY);
      return;
    }

    const parsed = JSON.parse(legacyRaw);
    if (!Array.isArray(parsed)) {
      localStorage.removeItem(LEGACY_PACKAGING_KEY);
      return;
    }

    const demands: Demand[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object') continue;
      const date = entry.date as string | undefined;
      const label = (entry.label as string) || '';
      const demandKg = (entry.demandKg as Record<string, number>) || {};
      if (!date) continue;
      for (const [familyCode, qty] of Object.entries(demandKg)) {
        if (qty > 0) {
          demands.push({
            productCode: familyCode,
            quantityNeeded: qty,
            needByDate: date,
            destinationWarehouse: WAREHOUSES.MF_PACKAGING,
            source: {
              type: 'packaging_run',
              runId: `${date}-${familyCode}`,
              runName: label || familyCode,
            },
          });
        }
      }
    }

    publishPackagingDemand(demands);
    localStorage.removeItem(LEGACY_PACKAGING_KEY);
  } catch {
    /* ignore — migration is best-effort */
  }
}

/**
 * Exported entry point for callers that want to force the migration early
 * (e.g., app mount). Safe to call multiple times.
 */
export function migrateLegacyPackagingDeadlines(): void {
  maybeMigrateLegacy();
}
