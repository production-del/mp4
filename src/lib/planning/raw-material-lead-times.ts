/**
 * Raw-material lead times — Phase 4m.4.
 *
 * Per-raw-material default lead times (calendar days from PO placement to
 * delivery), plus an optional vendor name for display. Loaded from
 * `data/raw-material-lead-times.json` on every render; the file may be
 * absent (treated as empty), malformed (treated as empty), or partially
 * populated. Codes not in the file fall back to the analyzer's default
 * (14 days at the time of writing).
 *
 * Why a JSON file (matches `product-overrides.ts` pattern):
 *   - Operators can edit without code.
 *   - Next.js `force-dynamic` page reads on every render so updates show
 *     up after a Re-plan without a deploy.
 *   - Easy to back up in git and hand-edit.
 *
 * For TRANSIENT shipping delays (e.g. "this week's shipment is 5 days
 * late"), the user sets a per-PO override via the drawer; that's stored
 * in localStorage by the client mutations layer and overrides this file.
 *
 * Shape of the file:
 *   {
 *     "RAW_CACAO": { "leadTimeDays": 21, "vendor": "Acme Cacao Co" },
 *     "LABEL_FCHOC": { "leadTimeDays": 7 }
 *   }
 *
 * The `_comment` key is reserved for documentation in the file itself
 * and is ignored.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

// ─── Public types ────────────────────────────────────────────

export interface RawMaterialLeadTime {
  /** Calendar days from PO placement to delivery. Required. */
  leadTimeDays: number;
  /** Optional vendor name — drawer surfaces it for context. */
  vendor?: string;
}

export type RawMaterialLeadTimesMap = Record<string, RawMaterialLeadTime>;

// ─── Storage ─────────────────────────────────────────────────

export function defaultLeadTimesPath(cwd: string = process.cwd()): string {
  return join(cwd, 'data', 'raw-material-lead-times.json');
}

/**
 * Read the lead-times file. Tolerates missing file, malformed JSON, and
 * malformed entries (they're silently dropped). Returns an empty map when
 * nothing usable is found.
 *
 * The `_comment` key (used to document the file) is filtered out.
 */
export function readLeadTimes(
  path: string = defaultLeadTimesPath(),
): RawMaterialLeadTimesMap {
  if (!existsSync(path)) return {};
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: RawMaterialLeadTimesMap = {};
  for (const [code, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (code.startsWith('_')) continue; // `_comment` and friends
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const v = value as Record<string, unknown>;
    const leadTimeDays = v.leadTimeDays;
    if (typeof leadTimeDays !== 'number' || !Number.isFinite(leadTimeDays) || leadTimeDays < 0) {
      continue;
    }
    const entry: RawMaterialLeadTime = {
      leadTimeDays: Math.round(leadTimeDays),
    };
    if (typeof v.vendor === 'string' && v.vendor.length > 0) {
      entry.vendor = v.vendor;
    }
    out[code] = entry;
  }
  return out;
}

// ─── Convenience accessors ──────────────────────────────────

export function leadTimeDaysByCode(
  map: RawMaterialLeadTimesMap,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [code, entry] of Object.entries(map)) {
    out[code] = entry.leadTimeDays;
  }
  return out;
}

export function vendorByCode(
  map: RawMaterialLeadTimesMap,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [code, entry] of Object.entries(map)) {
    if (entry.vendor) out[code] = entry.vendor;
  }
  return out;
}
