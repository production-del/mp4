/**
 * Product profit + station-letter loader — Phase 4l.9.
 *
 * Reads `data/product-profit.json` (built from `data/_profit-input.tsv` via
 * `scripts/build-profit.js`). Two purposes:
 *
 *   1. **Auto-routing default** — when an allowlisted SKU lacks a family
 *      sheet entry, use the kitchen team's "currently packaged on" station
 *      from this file instead of always defaulting to hand-packing.
 *   2. **Optimiser tie-breaker** — when packaging capacity is constrained,
 *      prefer higher-profit SKUs. (Wiring TBD; this loader exposes the
 *      data so any consumer can pick it up.)
 *
 * Returns null when the file is missing — callers should treat as "no
 * profit data; fall back to defaults".
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { Station } from './engine-io';

const DEFAULT_PATH = ['data', 'product-profit.json'] as const;

export interface ProductProfitEntry {
  /** AUD profit per packaged unit (gross). `null` when source row had no profit data. */
  profitPerItem: number | null;
  /** Source letter (H/E/D/O/B) — kept for traceability. */
  stationLetter: string;
  /** Human-readable letter label (Hand / Elephant / Dust / bottlO / Bulk). */
  stationLabel: string;
  /** Planner-station mapping (null for unknown). B "Bulk" maps to hand-packing for now. */
  plannerStation: Station | null;
}

export interface ProductProfitData {
  byCode: Record<string, ProductProfitEntry>;
}

export function readProductProfit(
  cwd: string = process.cwd(),
): ProductProfitData | null {
  const path = join(cwd, ...DEFAULT_PATH);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    const rawByCode = parsed?.byCode;
    if (!rawByCode || typeof rawByCode !== 'object') return null;
    const byCode: Record<string, ProductProfitEntry> = {};
    for (const [code, raw] of Object.entries(rawByCode)) {
      if (!raw || typeof raw !== 'object') continue;
      const r = raw as Record<string, unknown>;
      const profit = typeof r.profitPerItem === 'number' && Number.isFinite(r.profitPerItem)
        ? r.profitPerItem
        : null;
      const stationLetter = typeof r.stationLetter === 'string' ? r.stationLetter.toUpperCase() : '';
      const stationLabel = typeof r.stationLabel === 'string' ? r.stationLabel : stationLetter;
      const plannerStationRaw = typeof r.plannerStation === 'string' ? r.plannerStation : null;
      const plannerStation = isValidStation(plannerStationRaw) ? plannerStationRaw : null;
      byCode[code.toUpperCase()] = {
        profitPerItem: profit,
        stationLetter,
        stationLabel,
        plannerStation,
      };
    }
    if (Object.keys(byCode).length === 0) return null;
    return { byCode };
  } catch {
    return null;
  }
}

function isValidStation(s: string | null): s is Station {
  return s === 'hand-packing' || s === 'elephant' || s === 'dust' || s === 'bottlo';
}
