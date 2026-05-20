/**
 * Demand-data loader — Phase 4o.
 *
 * Reads monthly demand from one of two sources, in priority order:
 *
 *   1. **Google Sheet** (preferred when configured). Driven by the
 *      `GOOGLE_SHEETS_ID` + `DEMAND_SHEET_GID` env vars. The sheet must
 *      be shared as "Anyone with the link can view" — no API key needed
 *      because we use the public CSV-export endpoint
 *      (`docs.google.com/spreadsheets/d/<id>/export?format=csv&gid=<gid>`).
 *      Operators can edit the sheet (or its UDH-driven feed) and the
 *      planner picks up changes on the next page render.
 *
 *   2. **Local file** `data/demand.csv` — fallback for offline / tests
 *      and the historical default.
 *
 * Returns null when neither source is available (caller renders an
 * explanatory error rather than silently planning against zero demand).
 *
 * Both sources share the same column layout — only `Product Code` and
 * `AVE` are used. Compound-quoted product names with embedded commas are
 * handled by the inline CSV parser.
 *
 * Pure aside from the fs read / network fetch. The function returns a
 * promise so callers in async server components can await it. The
 * single existing call site is `app/calendar/page.tsx`.
 */

import { readFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';

export interface MonthlyDemandData {
  /** productCode → monthly AVE (rounded). */
  rates: Record<string, number>;
  /**
   * productCode → product group (from the "Unleashed Product Group" column
   * or any column matching "product group"). Phase 4l.8: used to filter
   * customer-specific (TBC-prefixed) and other non-Byron groups before
   * planning. Missing entries = empty string (no filter applies).
   */
  groups: Record<string, string>;
  /** Where the data came from — either an absolute file path or the sheet URL. */
  sourcePath: string;
  /** ISO timestamp of the file's mtime, or fetch time for the sheet, or null when unknown. */
  sourceMtime: string | null;
  /** Discriminator so the UI can label the badge appropriately. */
  source: 'sheet' | 'file';
}

// ─── Public API ──────────────────────────────────────────────

/**
 * Try Google Sheets first (when env vars are set); fall back to the local
 * CSV file. Returns null when neither is available.
 */
export async function loadMonthlyDemand(
  cwd: string = process.cwd(),
): Promise<MonthlyDemandData | null> {
  const sheetId = process.env.GOOGLE_SHEETS_ID;
  const gid = process.env.DEMAND_SHEET_GID;
  if (sheetId && sheetId !== 'your-sheets-id') {
    try {
      const fromSheet = await loadFromSheet({ sheetId, gid: gid ?? '0' });
      if (fromSheet) return fromSheet;
    } catch (err) {
      // Network / parse / permissions failure — log and fall through to
      // the file. We don't want a transient sheet outage to take down
      // the planner when there's a perfectly serviceable local file.
      console.warn(
        '[demand-data-loader] Sheet fetch failed; falling back to data/demand.csv:',
        err instanceof Error ? err.message : err,
      );
    }
  }
  return loadFromFile(cwd);
}

/**
 * Sheet-only loader. Exported for tests and so callers can force a fetch
 * (e.g. a future "Refresh demand" button that bypasses the file fallback).
 */
export async function loadFromSheet(input: {
  sheetId: string;
  gid: string;
  /** Override fetch for tests. */
  fetchImpl?: typeof fetch;
}): Promise<MonthlyDemandData | null> {
  const url = `https://docs.google.com/spreadsheets/d/${input.sheetId}/export?format=csv&gid=${input.gid}`;
  const fetchFn = input.fetchImpl ?? fetch;
  const res = await fetchFn(url, {
    // Don't cache forever — the whole point is to pick up edits. Vercel's
    // default revalidate is fine, but mark explicit so behavior is clear.
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error(
      `Sheet fetch returned HTTP ${res.status}. Confirm the sheet is shared as "Anyone with the link can view" and that GOOGLE_SHEETS_ID + DEMAND_SHEET_GID match its URL.`,
    );
  }
  const text = await res.text();
  const { rates, groups } = parseDemandCsv(text);
  return {
    rates,
    groups,
    sourcePath: url,
    sourceMtime: new Date().toISOString(),
    source: 'sheet',
  };
}

/** File-only loader. Exported for tests. */
export function loadFromFile(
  cwd: string = process.cwd(),
): MonthlyDemandData | null {
  const csvPath = join(cwd, 'data', 'demand.csv');
  if (!existsSync(csvPath)) return null;
  const text = readFileSync(csvPath, 'utf-8');
  const { rates, groups } = parseDemandCsv(text);
  let mtime: string | null = null;
  try {
    mtime = statSync(csvPath).mtime.toISOString();
  } catch {
    /* ignore */
  }
  return { rates, groups, sourcePath: csvPath, sourceMtime: mtime, source: 'file' };
}

// ─── Internals ───────────────────────────────────────────────

/**
 * Parse the demand CSV (file or sheet — same layout). Only `Product Code`
 * and `AVE` columns are used; everything else is ignored. When the same
 * code appears multiple times, the LARGEST value wins (defensive against
 * the source occasionally producing two rows for one SKU).
 */
export function parseDemandCsv(text: string): {
  rates: Record<string, number>;
  groups: Record<string, string>;
} {
  const rows = parseCSV(text);
  if (rows.length < 2) return { rates: {}, groups: {} };
  const headers = rows[0].map((h) => h.toLowerCase().trim());
  const codeCol = headers.findIndex(
    (h) => h === 'product code' || h === 'productcode' || h === 'sku',
  );
  const aveCol = headers.findIndex(
    (h) => h === 'ave' || h === 'average' || h === 'demand',
  );
  // Group column is optional. Match common variants.
  const groupCol = headers.findIndex(
    (h) =>
      h === 'product group' ||
      h === 'productgroup' ||
      h === 'unleashed product group' ||
      h === 'group',
  );
  if (codeCol === -1 || aveCol === -1) return { rates: {}, groups: {} };
  const rates: Record<string, number> = {};
  const groups: Record<string, string> = {};
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const code = (row[codeCol] || '').trim().toUpperCase();
    const raw = (row[aveCol] || '').replace(/,/g, '').trim();
    const value = parseFloat(raw);
    if (!code || isNaN(value) || value < 0) continue;
    if (rates[code] === undefined || value > rates[code]) {
      rates[code] = Math.round(value);
    }
    if (groupCol !== -1) {
      const g = (row[groupCol] || '').trim();
      if (g && !groups[code]) groups[code] = g;
    }
  }
  return { rates, groups };
}

/**
 * Minimal CSV row parser — handles quoted values that contain commas. The
 * source has compound names like `"STARDUST Yellow ""Anti-Inflammatory""...`
 * so we track quote state as we scan.
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
