/**
 * Printable HTML report generators — Phase 4n.2.
 *
 * Each builder returns a complete `<!DOCTYPE html>...` document the
 * client can open in a new window for printing or save-as-PDF. The HTML
 * carries inline styles and a `window.print()` call so the print dialog
 * pops automatically on load. Pure: no DOM, no fs.
 *
 * Design choices:
 *   - PO report groups by VENDOR for easy operator workflow ("call Acme,
 *     give them this list"). Within a vendor, overdue rows float to the
 *     top, then by place-by date.
 *   - Packaging report groups by WEEK then by STATION. Each station
 *     section ends with a daily totals strip showing utilisation.
 *   - Kitchen report is a single chronological table.
 *   - All three: dd/mm/yyyy dates, accessible HTML, page-breaks before
 *     each top-level group so each prints cleanly.
 *
 * Mutations are honoured because the input activities + lead-time
 * overrides are already projected client-side.
 */

import type { CalendarActivity } from './calendar-projection';
import type { PurchaseRequirement } from '@/lib/engine/raw-material-demand';
import type { MutationsMap } from './calendar-mutations';
import { isDismissed, leadTimeOverridesByCode } from './calendar-mutations';

// ─── Public API ──────────────────────────────────────────────

export interface BuildPoHtmlInput {
  purchaseRequirements: ReadonlyArray<PurchaseRequirement>;
  vendorByCode: Record<string, string>;
  mutations: MutationsMap;
  today: string;
  /** stableId → product/date for the "Drives" cell. */
  driverLookup?: Map<string, { productCode: string; productName: string; date: string }>;
}

export function buildPoHtml(input: BuildPoHtmlInput): string {
  const overrides = leadTimeOverridesByCode(input.mutations);
  type Row = {
    placeBy: string;
    arriveBy: string;
    code: string;
    name: string;
    leadTimeUsed: number;
    leadTimeDefault: number;
    quantity: number;
    overdue: boolean;
    drives: string;
  };
  const byVendor = new Map<string, Row[]>();
  for (const req of input.purchaseRequirements) {
    const override = overrides[req.rawMaterialCode];
    const leadTimeUsed =
      typeof override === 'number' && Number.isFinite(override) && override >= 0
        ? Math.round(override)
        : req.leadTimeDays;
    const effectivePlaceBy =
      req.placeByDate < input.today ? input.today : req.placeByDate;
    const effectiveArriveBy = isoAddDays(effectivePlaceBy, leadTimeUsed);
    const vendor = input.vendorByCode[req.rawMaterialCode] ?? '(no vendor specified)';
    const drivers = (req.drivenBy ?? []).map((id) => {
      const d = input.driverLookup?.get(id);
      return d ? `${d.productCode} on ${fmtDate(d.date)}` : id;
    }).join('; ');
    let arr = byVendor.get(vendor);
    if (!arr) {
      arr = [];
      byVendor.set(vendor, arr);
    }
    arr.push({
      placeBy: effectivePlaceBy,
      arriveBy: effectiveArriveBy,
      code: req.rawMaterialCode,
      name: req.rawMaterialName,
      leadTimeUsed,
      leadTimeDefault: req.leadTimeDays,
      quantity: Math.round(req.quantity),
      overdue: req.placeByDate < input.today,
      drives: drivers,
    });
  }
  // Sort vendors alphabetically; within each, overdue first, then by placeBy.
  const vendorEntries = Array.from(byVendor.entries()).sort((a, b) =>
    a[0].localeCompare(b[0]),
  );
  for (const [, rows] of vendorEntries) {
    rows.sort((a, b) => {
      if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
      if (a.placeBy !== b.placeBy) return a.placeBy.localeCompare(b.placeBy);
      return a.code.localeCompare(b.code);
    });
  }
  const totalCount = input.purchaseRequirements.length;
  const overdueCount = vendorEntries.reduce(
    (n, [, rows]) => n + rows.filter((r) => r.overdue).length,
    0,
  );
  const sections = vendorEntries
    .map(([vendor, rows]) => {
      const overdueInVendor = rows.filter((r) => r.overdue).length;
      const head = `<h2>${esc(vendor)} <span class="muted">— ${rows.length} PO${rows.length === 1 ? '' : 's'}${overdueInVendor > 0 ? ` (${overdueInVendor} overdue)` : ''}</span></h2>`;
      const tableRows = rows
        .map(
          (r) => `<tr class="${r.overdue ? 'overdue' : ''}"><td>${esc(fmtDate(r.placeBy))}${r.overdue ? ' <span class="warn">⚠</span>' : ''}</td><td>${esc(fmtDate(r.arriveBy))}</td><td><strong>${esc(r.code)}</strong><br><span class="muted">${esc(r.name)}</span></td><td class="num">${esc(String(r.quantity))}</td><td class="num">${esc(String(r.leadTimeUsed))}${r.leadTimeUsed !== r.leadTimeDefault ? ` <span class="muted">(default ${r.leadTimeDefault})</span>` : ''}</td><td>${esc(r.drives)}</td></tr>`,
        )
        .join('');
      return `<section class="vendor">${head}<table><thead><tr><th>Place by</th><th>Arrive by</th><th>Material</th><th class="num">Qty</th><th class="num">Lead time (days)</th><th>Drives</th></tr></thead><tbody>${tableRows}</tbody></table></section>`;
    })
    .join('\n');
  const summary = `<p class="summary">${totalCount} PO${totalCount === 1 ? '' : 's'} across ${vendorEntries.length} vendor${vendorEntries.length === 1 ? '' : 's'}${overdueCount > 0 ? ` · <span class="warn-text">${overdueCount} overdue</span>` : ''}</p>`;
  return wrapDocument({
    title: `Purchase orders — ${fmtDate(input.today)}`,
    heading: 'Purchase orders',
    today: input.today,
    body: summary + (sections || `<p class="muted">No purchase orders required.</p>`),
  });
}

export interface BuildPackagingHtmlInput {
  activities: ReadonlyArray<CalendarActivity>;
  mutations: MutationsMap;
  stationDailyMinutes: Record<string, number>;
  today: string;
}

export function buildPackagingHtml(input: BuildPackagingHtmlInput): string {
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
    weekStart: string;
    orderInWeek: number;
  };
  const byWeek = new Map<string, Map<string, Row[]>>();
  for (const a of input.activities) {
    if (a.kind !== 'packaging') continue;
    if (!a.station) continue;
    if (isDismissed(input.mutations, a.stableId)) continue;
    const r: Row = {
      date: a.date,
      station: a.station,
      code: a.productCode,
      name: a.productName,
      quantity: Math.round(a.quantity),
      productionMin: Math.round(a.durationMinutes),
      changeoverMin: Math.round(a.changeoverMinutes),
      totalMin: Math.round(a.durationMinutes + a.changeoverMinutes),
      family: a.family ?? '',
      weekStart: a.weekStart,
      orderInWeek: a.orderInWeek,
    };
    let stMap = byWeek.get(r.weekStart);
    if (!stMap) {
      stMap = new Map();
      byWeek.set(r.weekStart, stMap);
    }
    let arr = stMap.get(r.station);
    if (!arr) {
      arr = [];
      stMap.set(r.station, arr);
    }
    arr.push(r);
  }
  const weeks = Array.from(byWeek.keys()).sort();
  const sections = weeks
    .map((ws) => {
      const stMap = byWeek.get(ws)!;
      const stations = Array.from(stMap.keys()).sort();
      const stationBlocks = stations
        .map((station) => {
          const rows = stMap.get(station)!;
          rows.sort((a, b) => {
            if (a.date !== b.date) return a.date.localeCompare(b.date);
            return a.orderInWeek - b.orderInWeek;
          });
          // Per-day totals for utilisation column.
          const dailyTotals = new Map<string, number>();
          for (const r of rows) {
            dailyTotals.set(r.date, (dailyTotals.get(r.date) ?? 0) + r.totalMin);
          }
          const cap = input.stationDailyMinutes[station] ?? 480;
          const totalsRows = Array.from(dailyTotals.entries())
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([d, mins]) => {
              const util = cap > 0 ? Math.round((mins / cap) * 100) : 0;
              const utilClass = util > 100 ? 'overrun' : util > 85 ? 'warn-row' : '';
              return `<tr class="totals ${utilClass}"><td>${esc(fmtDate(d))}</td><td colspan="4" class="muted">Daily total · ${cap} min capacity</td><td class="num">${mins}</td><td class="num">${util}%</td></tr>`;
            })
            .join('');
          const tableRows = rows
            .map(
              (r) => `<tr><td>${esc(fmtDate(r.date))}</td><td><strong>${esc(r.code)}</strong><br><span class="muted">${esc(r.name)}</span></td><td>${esc(r.family)}</td><td class="num">${esc(String(r.quantity))}</td><td class="num">${esc(String(r.productionMin))}</td><td class="num">${esc(String(r.changeoverMin))}</td><td class="num">${esc(String(r.totalMin))}</td></tr>`,
            )
            .join('');
          return `<h3>${esc(station)} <span class="muted">— ${rows.length} batch${rows.length === 1 ? '' : 'es'}</span></h3><table><thead><tr><th>Date</th><th>Product</th><th>Family</th><th class="num">Qty</th><th class="num">Prod min</th><th class="num">Changeover min</th><th class="num">Total min</th></tr></thead><tbody>${tableRows}</tbody>${totalsRows ? `<tfoot>${totalsRows}</tfoot>` : ''}</table>`;
        })
        .join('');
      return `<section class="week"><h2>Week of ${esc(fmtDate(ws))}</h2>${stationBlocks}</section>`;
    })
    .join('\n');
  return wrapDocument({
    title: `Packaging schedule — ${fmtDate(input.today)}`,
    heading: 'Packaging schedule',
    today: input.today,
    body: sections || `<p class="muted">No packaging activities scheduled.</p>`,
  });
}

export interface BuildKitchenHtmlInput {
  activities: ReadonlyArray<CalendarActivity>;
  mutations: MutationsMap;
  kitchenMinutesByProductCode: Record<string, number>;
  kitchenDefaultMinutes: number;
  today: string;
}

export function buildKitchenHtml(input: BuildKitchenHtmlInput): string {
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
  const tableRows = rows
    .map(
      (r) => `<tr><td>${esc(fmtDate(r.startDate))}</td><td>${esc(fmtDate(r.finishDate))}</td><td>${r.requiredByDate ? esc(fmtDate(r.requiredByDate)) : ''}</td><td><strong>${esc(r.code)}</strong><br><span class="muted">${esc(r.name)}</span></td><td class="num">${esc(String(r.quantity))}</td><td class="num">${esc(String(r.durationDays))}</td><td class="num">${esc(String(r.kitchenMin))}</td></tr>`,
    )
    .join('');
  const body = rows.length === 0
    ? `<p class="muted">No kitchen runs required.</p>`
    : `<p class="summary">${rows.length} run${rows.length === 1 ? '' : 's'} in the planning horizon.</p><table><thead><tr><th>Start</th><th>Finish</th><th>Required by</th><th>Product</th><th class="num">Qty</th><th class="num">Days</th><th class="num">Kitchen min<br>(start day)</th></tr></thead><tbody>${tableRows}</tbody></table>`;
  return wrapDocument({
    title: `Kitchen runs — ${fmtDate(input.today)}`,
    heading: 'Kitchen runs',
    today: input.today,
    body,
  });
}

// ─── Internals ───────────────────────────────────────────────

function wrapDocument(args: {
  title: string;
  heading: string;
  today: string;
  body: string;
}): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(args.title)}</title>
<style>
  :root { color-scheme: light; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    color: #111;
    margin: 24px;
    font-size: 12px;
    line-height: 1.4;
  }
  h1 { margin: 0 0 4px; font-size: 20px; }
  h2 { margin: 24px 0 8px; font-size: 15px; border-bottom: 1px solid #999; padding-bottom: 4px; }
  h3 { margin: 14px 0 6px; font-size: 13px; color: #333; }
  p.summary { margin: 0 0 16px; color: #333; }
  p.muted, span.muted { color: #666; }
  span.muted { font-size: 11px; }
  span.warn { color: #c00; font-weight: bold; }
  span.warn-text { color: #c00; font-weight: 600; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 12px; }
  th, td { padding: 4px 8px; border-bottom: 1px solid #ddd; text-align: left; vertical-align: top; }
  th { background: #f5f5f5; font-weight: 600; font-size: 11px; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  tr.overdue td { background: #ffecec; }
  tr.totals td { background: #fafafa; font-style: italic; border-top: 1px solid #999; }
  tr.warn-row td { background: #fff3e0; }
  tr.overrun td { background: #ffe1e1; font-weight: 600; }
  section.vendor, section.week { page-break-inside: avoid; margin-bottom: 18px; }
  section.vendor + section.vendor, section.week + section.week { page-break-before: always; }
  .controls { margin-bottom: 16px; }
  .controls button {
    padding: 6px 12px; font-size: 12px;
    background: #fff; color: #111; border: 1px solid #999; border-radius: 3px;
    cursor: pointer; font-family: inherit;
  }
  .meta { font-size: 11px; color: #666; }
  @media print {
    body { margin: 12mm; font-size: 10pt; }
    .controls { display: none; }
    h2 { page-break-before: auto; }
    section.vendor + section.vendor, section.week + section.week { page-break-before: always; }
  }
</style>
</head>
<body>
  <header>
    <h1>${esc(args.heading)}</h1>
    <div class="meta">Generated ${esc(fmtDate(args.today))}</div>
  </header>
  <div class="controls">
    <button type="button" onclick="window.print()">Print</button>
    <button type="button" onclick="window.close()">Close</button>
  </div>
  <main>
    ${args.body}
  </main>
  <script>
    // Auto-open the print dialog once styles are ready. Wrapped in a
    // setTimeout so layout settles first.
    window.addEventListener('load', function () { setTimeout(function () { window.print(); }, 200); });
  </script>
</body>
</html>`;
}

function esc(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

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
