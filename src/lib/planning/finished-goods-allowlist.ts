/**
 * Finished-goods allowlist — Phase 4l.8.
 *
 * The planner is allowed to schedule packaging chips only for SKUs in
 * this file. Anything else gets silently excluded from `monthlyRates`
 * at the optimiser-input stage in `app/calendar/page.tsx`.
 *
 * Source of truth: `data/finished-goods-allowlist.json`.
 * Edit the file directly to expand / contract what gets planned. The
 * planner re-reads it on every server render — no restart required.
 *
 * Returns null when the file is missing, signalling "no allowlist
 * configured → fall back to the old behaviour" (currently: skip).
 * Callers should treat null as "block nothing extra" — i.e. accept any
 * code the rest of the filter chain admits.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const DEFAULT_PATH = ['data', 'finished-goods-allowlist.json'] as const;

export function readFinishedGoodsAllowlist(
  cwd: string = process.cwd(),
): ReadonlySet<string> | null {
  const path = join(cwd, ...DEFAULT_PATH);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    const arr = parsed?.codes;
    if (!Array.isArray(arr)) return null;
    const codes = arr.filter((x): x is string => typeof x === 'string')
      .map((c) => c.trim().toUpperCase())
      .filter(Boolean);
    if (codes.length === 0) return null;
    return new Set(codes);
  } catch {
    return null;
  }
}
