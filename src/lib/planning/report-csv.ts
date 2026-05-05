/**
 * Report CSV builders — Phase 4n.1.
 *
 * Three pure functions, one per report:
 *   - `buildPoCsv` — purchase orders that need to be placed
 *   - `buildPackagingCsv` — packaging schedule per station
 *   - `buildKitchenCsv` — kitchen runs (kitchen-required chips)
 *
 * Each takes the current MUTATED activities (so user edits — drag/drop,
 * quantity, lead-time overrides — flow through) plus relevant context.
 * Dismissed activities are excluded; the plan should reflect what the user
 * actually intends to do.
 *
 * Output format: standard CSV with:
 *   - UTF-8 BOM prefix so Excel detects encoding correctly.
 *   - `\n` line endings (Excel + Numbers + Sheets all handle).
 *   - Quote-wrapped fields when they contain a comma, quote, or newline;
 *     internal quotes are doubled per RFC 4180.
 *   - Dates as dd/mm/yyyy to match the on-screen format.
 *
 * Pure: no DOM, no fs.
 */

import type { CalendarActivity } from './calendar-projection';
import type { PurchaseRequirement } from '@/lib/engine/raw-material-demand';
import type { MutationsMap } from './calendar-mutations';
import { isDismissed, leadTimeOverridesByCode } from './calendar-mutations';

// ─── Public API ──────────────────────────────────────────────

export interface BuildPoCsvInput {
  purchaseRequirements: ReadonlyArray<PurchaseRequirement>;
  /** From data/raw-material-lead-times.json — adds the Vendor column when present. */
  vendorByCode: Record<string, string>;
  /** User's current mutations layer — supplies lead-time overrides. */
  mutations: MutationsMap;
  /** Today's local ISO date — used to compute effective dates. */
  today: string;
  /** stableId → productCode/name lookup for the "Drives" column. */
  driverLookup?: Map<string, { productCode: string; productName: string; date: string }>;
}

/**
 * One row per PO requirement. Place-by and arrive-by reflect the EFFECTIVE
 * dates (clamped to today, and shifted by any lead-time override). The
 * "Default lead time" column shows the file default for context; "Lead
 * time used" shows what's actually being applied.
 */
export function buildPoCsv(input: BuildPoCsvInput): string {
  const overrides = leadTimeOverridesByCode(input.mutations);
  type Row = {
    placeBy: string;
    arriveBy: string;
    code: string;
    name: string;
    vendor: string;
    leadTimeUsed: number;
    leadTimeDefault: number;
    quantity: number;
    overdue: boolean;
    drives: string;
  };
  const rows: Row[] = [];
  for (const req of input.purchaseRequirements) {
    const override = overrides[req.rawMaterialCode];
    const leadTimeUsed =
      typeof override === 'number' && Number.isFinite(override) && override >= 0
        ? Math.round(override)
        : req.leadTimeDays;
    const effectivePlaceBy =
      req.placeByDate < input.today ? input.today : req.placeByDate;
    const effectiveArriveBy = isoAddDays(effectivePlaceBy, leadTimeUsed);
    const drivers = input.driverLookup
      ? req.drivenBy
          .map((id) => {
            const d = input.driverLookup!.get(id);
            return d ? `${d.productCode} on ${fmtDate(d.date)}` : id;
          })
          .join('; ')
      : req.drivenBy.join('; ');
    rows.push({
      placeBy: effectivePlaceBy,
      arriveBy: effectiveArriveBy,
      code: req.rawMaterialCode,
      name: req.rawMaterialName,
      vendor: input.vendorByCode[req.rawMaterialCode] ?? '',
      leadTimeUsed,
      leadTimeDefault: req.leadTimeDays,
      quantity: Math.round(req.quantity),
      overdue: req.placeByDate < input.today,
      drives: drivers,
    });
  }
  rows.sort((a, b) => {
    if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
    if (a.placeBy !== b.placeBy) return a.placeBy.localeCompare(b.placeBy);
    return a.code.localeCompare(b.code);
  });
  const header = [
    'Place by',
    'Arrive by',
    'Material code',
    'Material name',
    'Vendor',
    'Quantity',
    'Lead time used (days)',
    'Default lead time (days)',
    'Overdue',
    'Drives',
  ];
  const lines = [header.map(csvEscape).join(',')];
  for (const r of rows) {
    lines.push(
      [
        fmtDate(r.placeBy),
        fmtDate(r.arriveBy),
        r.code,
        r.name,
        r.vendor,
        String(r.quantity),
        String(r.leadTimeUsed),
        String(r.leadTimeDefault),
        r.overdue ? 'Y' : 'N',
        r.drives,
      ]
        .map(csvEscape)
        .join(','),
    );
  }
  return BOM + lines.join('\n') + '\n';
}

export interface BuildPackagingCsvInput {
  /** Mutated activities with PO chips already merged. */
  activities: ReadonlyArray<CalendarActivity>;
  mutations: MutationsMap;
  /** Per-station daily capacity — for the optional Utilisation column. */
  stationDailyMinutes: Record<string, number>;
}

/**
 * One row per packaging chip (excluding dismissed). Sorted by date, then
 * station, then within-day order. Includes a Total min column = production
 * + changeover, which is what the heatmap charges to the station.
 */
export function buildPackagingCsv(input: BuildPackagingCsvInput): string {
  type Row = {
    date: string;
    station: string;
    code: string;
    name: string;
    quantity: number;
    productionMin: number;
    changeoverMin: number;
    totalMin: number;
    family: string;
    orderInWeek: number;
  };
  const rows: Row[] = [];
  for (const a of input.activities) {
    if (a.kind !== 'packaging') continue;
    if (!a.station) continue;
    if (isDismissed(input.mutations, a.stableId)) continue;
    const totalMin = Math.round(a.durationMinutes + a.changeoverMinutes);
    rows.push({
      date: a.date,
      station: a.station,
      code: a.productCode,
      name: a.productName,
      quantity: Math.round(a.quantity),
      productionMin: Math.round(a.durationMinutes),
      changeoverMin: Math.round(a.changeoverMinutes),
      totalMin,
      family: a.family ?? '',
      orderInWeek: a.orderInWeek,
    });
  }
  rows.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    if (a.station !== b.station) return a.station.localeCompare(b.station);
    return a.orderInWeek - b.orderInWeek;
  });
  const header = [
    'Date',
    'Station',
    'Product code',
    'Product name',
    'Quantity',
    'Production min',
    'Changeover min',
    'Total min',
    'Family',
  ];
  const lines = [header.map(csvEscape).join(',')];
  for (const r of rows) {
    lines.push(
      [
        fmtDate(r.date),
        r.station,
        r.code,
        r.name,
        String(r.quantity),
        String(r.productionMin),
        String(r.changeoverMin),
        String(r.totalMin),
        r.family,
      ]
        .map(csvEscape)
        .join(','),
    );
  }
  // Daily totals per station appended as a second block, separated by a
  // blank line. Useful for at-a-glance load checks.
  type Tot = { date: string; station: string; totalMin: number };
  const totalsByKey = new Map<string, Tot>();
  for (const r of rows) {
    const k = `${r.date}|${r.station}`;
    const t = totalsByKey.get(k);
    if (t) t.totalMin += r.totalMin;
    else totalsByKey.set(k, { date: r.date, station: r.station, totalMin: r.totalMin });
  }
  const totals = Array.from(totalsByKey.values()).sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return a.station.localeCompare(b.station);
  });
  if (totals.length > 0) {
    lines.push('');
    lines.push('Daily totals,,,,');
    lines.push(['Date', 'Station', 'Total min', 'Capacity min', 'Util %'].map(csvEscape).join(','));
    for (const t of totals) {
      const cap = input.stationDailyMinutes[t.station] ?? 480;
      const utilPct = cap > 0 ? Math.round((t.totalMin / cap) * 100) : 0;
      lines.push(
        [fmtDate(t.date), t.station, String(t.totalMin), String(cap), `${utilPct}%`]
          .map(csvEscape)
          .join(','),
      );
    }
  }
  return BOM + lines.join('\n') + '\n';
}

export interface BuildKitchenCsvInput {
  activities: ReadonlyArray<CalendarActivity>;
  mutations: MutationsMap;
  /** Per-recipe kitchen-team minutes, for the "Kitchen min" column. */
  kitchenMinutesByProductCode: Record<string, number>;
  kitchenDefaultMinutes: number;
}

/**
 * One row per kitchen-required chip (excluding dismissed). Sorted by start
 * date. Includes finish-date and required-by-date so the user sees the
 * full timing picture.
 */
export function buildKitchenCsv(input: BuildKitchenCsvInput): string {
  type Row = {
    startDate: string;
    finishDate: string;
    requiredByDate: string;
    code: string;
    name: string;
    quantity: number;
    durationDays: number;
    kitchenMin: number;
  };
  const rows: Row[] = [];
  for (const a of input.activities) {
    if (a.kind !== 'kitchen-required') continue;
    if (isDismissed(input.mutations, a.stableId)) continue;
    rows.push({
      startDate: a.date,
      finishDate: a.finishDate ?? a.date,
      requiredByDate: a.requiredByDate ?? '',
      code: a.productCode,
      name: a.productName,
      quantity: Math.round(a.quantity),
      durationDays: a.durationDays ?? 1,
      kitchenMin:
        input.kitchenMinutesByProductCode[a.productCode] ??
        input.kitchenDefaultMinutes,
    });
  }
  rows.sort((a, b) => {
    if (a.startDate !== b.startDate) return a.startDate.localeCompare(b.startDate);
    return a.code.localeCompare(b.code);
  });
  const header = [
    'Start date',
    'Finish date',
    'Required by',
    'Product code',
    'Product name',
    'Quantity',
    'Duration (days)',
    'Kitchen min (start day)',
  ];
  const lines = [header.map(csvEscape).join(',')];
  for (const r of rows) {
    lines.push(
      [
        fmtDate(r.startDate),
        fmtDate(r.finishDate),
        r.requiredByDate ? fmtDate(r.requiredByDate) : '',
        r.code,
        r.name,
        String(r.quantity),
        String(r.durationDays),
        String(r.kitchenMin),
      ]
        .map(csvEscape)
        .join(','),
    );
  }
  return BOM + lines.join('\n') + '\n';
}

// ─── Internals ───────────────────────────────────────────────

const BOM = '﻿';

/** Wrap a field in quotes if it contains comma/quote/newline; double internal quotes. */
function csvEscape(value: string): string {
  if (value === undefined || value === null) return '';
  const needsQuote = /[",\n\r]/.test(value);
  if (!needsQuote) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

/** ISO YYYY-MM-DD → dd/mm/yyyy. Mirrors the on-screen format. */
function fmtDate(iso: string): string {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

function isoAddDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}
