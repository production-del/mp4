/**
 * Server-side demand-data loader — reads `data/demand.csv` directly without
 * going through the `/api/demand-data` HTTP route.
 *
 * The route at `src/app/api/demand-data/route.ts` is the canonical reader
 * used by the running app's API surface. This module duplicates only the
 * parsing logic so server components (and tests) can pull demand without
 * a self-fetch — Next.js server components can't easily call their own
 * fetch endpoints during build/render. The two readers stay in sync via a
 * shared smoke test if drift becomes a concern.
 *
 * Pure aside from the file read. Returns a plain `Record<productCode, monthlyAve>`.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

export interface MonthlyDemandData {
  /** productCode → monthly AVE (rounded). */
  rates: Record<string, number>;
  /** Source file path that was read. */
  sourcePath: string;
  /** ISO timestamp of the file's modification time. */
  sourceMtime: string | null;
}

/**
 * Minimal CSV row parser — handles quoted values that contain commas. The
 * demand.csv header has compound names like `"STARDUST Yellow ""Anti-Inflammatory""...`
 * which the project's existing route handles by tracking quote state.
 */
function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let current = '';
  let inQuotes = false;
  let row: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') {
        row.push(current.trim());
        current = '';
      } else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(current.trim());
        if (row.some((c) => c !== '')) rows.push(row);
        row = [];
        current = '';
      } else current += ch;
    }
  }
  row.push(current.trim());
  if (row.some((c) => c !== '')) rows.push(row);
  return rows;
}

/**
 * Load monthly demand from the standard location. Returns null if the file
 * doesn't exist — caller can fall back to a fixture.
 */
export function loadMonthlyDemand(
  cwd: string = process.cwd(),
): MonthlyDemandData | null {
  const csvPath = join(cwd, 'data', 'demand.csv');
  if (!existsSync(csvPath)) return null;
  const text = readFileSync(csvPath, 'utf-8');
  const rows = parseCSV(text);
  if (rows.length < 2) return { rates: {}, sourcePath: csvPath, sourceMtime: null };

  const headers = rows[0].map((h) => h.toLowerCase().trim());
  const codeCol = headers.findIndex((h) => h === 'product code' || h === 'productcode' || h === 'sku');
  const aveCol = headers.findIndex((h) => h === 'ave' || h === 'average' || h === 'demand');
  if (codeCol === -1 || aveCol === -1) return { rates: {}, sourcePath: csvPath, sourceMtime: null };

  const rates: Record<string, number> = {};
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const code = (row[codeCol] || '').trim().toUpperCase();
    const raw = (row[aveCol] || '').replace(/,/g, '').trim();
    const value = parseFloat(raw);
    if (!code || isNaN(value) || value < 0) continue;
    if (rates[code] === undefined || value > rates[code]) {
      rates[code] = Math.round(value);
    }
  }

  let mtime: string | null = null;
  try {
    const stat = require('fs').statSync(csvPath);
    mtime = stat.mtime.toISOString();
  } catch {
    /* ignore */
  }
  return { rates, sourcePath: csvPath, sourceMtime: mtime };
}
