/**
 * Product overrides — Phase 4f.
 *
 * Per-SKU overrides for the planning defaults that currently come from
 * hardcoded constants in the calendar's server page (shelf life,
 * max-batch). Stored as a JSON file at `data/product-overrides.json`
 * because:
 *
 *   - The operator should be able to edit them without touching code.
 *   - The Next.js server component reads them on every render
 *     (`force-dynamic`), so changes show up after a Re-plan without a
 *     deploy.
 *   - File-on-disk is dead simple — no DB to spin up, easy to back up
 *     in git, easy to inspect or hand-edit. We can swap to localStorage-
 *     based mutations or a real DB later if needed.
 *
 * Concurrency: write operations re-read the file then write the merged
 * map. Two simultaneous writes from the same operator could race in
 * theory; in practice the calendar UI is single-user. The store
 * tolerates malformed/missing files by treating them as empty.
 *
 * Shape of the file:
 *   {
 *     "FCHAGALG": { "shelfLifeDays": 365, "maxBatchSize": 800 },
 *     "MFWALNUME": { "shelfLifeDays": 180 }
 *   }
 *
 * Missing fields fall back to the calendar page's global defaults.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';

// ─── Public types ────────────────────────────────────────────

export interface ProductOverride {
  /** Override the per-product shelf life (in days). When absent, use the global default. */
  shelfLifeDays?: number;
  /** Override the per-product max batch size (units). Absent → use station daily output. */
  maxBatchSize?: number;
}

export type ProductOverridesMap = Record<string, ProductOverride>;

// ─── Storage ─────────────────────────────────────────────────

export function defaultOverridesPath(cwd: string = process.cwd()): string {
  return join(cwd, 'data', 'product-overrides.json');
}

export function readProductOverrides(
  filePath: string = defaultOverridesPath(),
): ProductOverridesMap {
  if (!existsSync(filePath)) return {};
  try {
    const text = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return validateMap(parsed);
    }
    return {};
  } catch {
    return {};
  }
}

export function writeProductOverrides(
  map: ProductOverridesMap,
  filePath: string = defaultOverridesPath(),
): void {
  // Make sure data/ exists (it should, since the spreadsheet lives there,
  // but defensive in case the file is on a fresh checkout).
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, JSON.stringify(map, null, 2) + '\n', 'utf-8');
}

// ─── Pure operations ────────────────────────────────────────

/** Returns a NEW map with the override merged into the existing one (or created). */
export function setOverride(
  map: ProductOverridesMap,
  productCode: string,
  partial: ProductOverride,
): ProductOverridesMap {
  const cleaned = cleanOverride(partial);
  const existing = map[productCode] ?? {};
  const merged: ProductOverride = { ...existing, ...cleaned };
  // If every field was cleared, drop the entry entirely.
  if (Object.keys(merged).length === 0) {
    const out = { ...map };
    delete out[productCode];
    return out;
  }
  return { ...map, [productCode]: merged };
}

/** Returns a NEW map without an entry for `productCode`. */
export function clearOverride(
  map: ProductOverridesMap,
  productCode: string,
): ProductOverridesMap {
  if (!(productCode in map)) return map;
  const out = { ...map };
  delete out[productCode];
  return out;
}

/** Resolve effective values for a product, applying defaults where unset. */
export function resolveOverride(
  map: ProductOverridesMap,
  productCode: string,
  defaults: { shelfLifeDays: number; maxBatchSize: number },
): { shelfLifeDays: number; maxBatchSize: number; overridden: { shelfLifeDays: boolean; maxBatchSize: boolean } } {
  const override = map[productCode];
  return {
    shelfLifeDays: override?.shelfLifeDays ?? defaults.shelfLifeDays,
    maxBatchSize: override?.maxBatchSize ?? defaults.maxBatchSize,
    overridden: {
      shelfLifeDays: override?.shelfLifeDays !== undefined,
      maxBatchSize: override?.maxBatchSize !== undefined,
    },
  };
}

// ─── Internals ───────────────────────────────────────────────

/** Strip undefined / null / non-positive fields from an override. */
function cleanOverride(o: ProductOverride): ProductOverride {
  const out: ProductOverride = {};
  if (typeof o.shelfLifeDays === 'number' && o.shelfLifeDays > 0) {
    out.shelfLifeDays = Math.round(o.shelfLifeDays);
  }
  if (typeof o.maxBatchSize === 'number' && o.maxBatchSize > 0) {
    out.maxBatchSize = Math.round(o.maxBatchSize);
  }
  return out;
}

/** Validate + clean every entry in a parsed JSON file. Drops anything malformed. */
function validateMap(raw: Record<string, unknown>): ProductOverridesMap {
  const out: ProductOverridesMap = {};
  for (const [code, value] of Object.entries(raw)) {
    if (!code || typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    const v = value as Record<string, unknown>;
    const clean = cleanOverride({
      shelfLifeDays: typeof v.shelfLifeDays === 'number' ? v.shelfLifeDays : undefined,
      maxBatchSize: typeof v.maxBatchSize === 'number' ? v.maxBatchSize : undefined,
    });
    if (Object.keys(clean).length > 0) out[code] = clean;
  }
  return out;
}
