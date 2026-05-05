/**
 * Packaging plan → xlsx exporter.
 *
 * Turns the planner's scheduled packaging runs (both draft CREATE and
 * edited-existing UPDATE entries with a dayInt > 0) into a procurement-ready
 * workbook:
 *
 *   • `Summary` — one row per purchasable item needed anywhere in the plan,
 *     grouped by supplier. Columns match the procurement-email spec:
 *     Supplier · Item Code · Item Name · Amount Required (plan) · Amount for
 *     3mo Forecast · Current SOH · Shortfall.
 *   • `Labels by supplier` — same shape as Summary but filtered to label SKUs
 *     so the procurement lead can hand the tab straight to a print supplier.
 *   • `Intermediates by day` — one row per (intermediate, day) with kg
 *     required, SOH at MF Packaging, and a transfer-needed flag so the kitchen
 *     + logistics teams know when each kg has to land.
 *   • `Other components` — everything else from the FG BOM that isn't a label
 *     or an intermediate (bags, caps, ribbons, inserts…).
 *   • `Transfers needed` — items short at MF Packaging but covered globally;
 *     a direct worklist for logistics.
 */

import * as XLSX from 'xlsx';
import type { PackagingSKU } from '../hooks/usePackagingData';
import type { PackingTeam } from '../hooks/usePackagingPlanner';
import { dayIntToDate, toLocalISODate } from '@/lib/planning/working-day';
import { WarehouseSOH } from '@/lib/planning/warehouse-soh';
import { WAREHOUSES } from '@/lib/planning/warehouse-assignments';
import type { StockOnHandItem } from '@/lib/unleashed/types';

export interface ScheduledRun {
  productCode: string;
  quantity: number;
  dayInt: number;
  team?: PackingTeam;
}

interface RawBOMEntry {
  productCode: string;
  productDescription: string;
  quantityPerParent: number;
  parentProductCode: string;
}

interface RawSOHItem {
  productCode: string;
  productName: string;
  warehouseId?: string;
  warehouseName?: string;
  quantity: number;
  availableQty?: number;
}

export interface SupplierRef {
  code: string;
  name: string;
}

export interface ExportPlanInput {
  /** Scheduled packaging runs (must all have dayInt > 0 and quantity > 0). */
  runs: ScheduledRun[];
  /** SKU snapshot — drives display names, monthly usage, and unit conversion. */
  skus: PackagingSKU[];
  /** Full BOM: each entry says "product X consumes quantityPerParent of component Y". */
  bomEntries: RawBOMEntry[];
  /** SOH snapshot — used for current-on-hand + warehouse breakdown. */
  sohItems: RawSOHItem[];
  /** productCode → supplier for procurement grouping. */
  supplierByCode: Record<string, SupplierRef>;
  /** productCode → monthly usage (FG level). Used for 3mo forecast roll-up. */
  monthlyUsage: Record<string, number>;
  /** productCode → group name (so we can classify "label" vs "intermediate" vs other). */
  productGroups: Record<string, string>;
}

const UNKNOWN_SUPPLIER: SupplierRef = { code: '—', name: 'Unknown' };

function classifyComponent(
  componentCode: string,
  productGroups: Record<string, string>,
): 'label' | 'intermediate' | 'other' {
  if (componentCode.startsWith('L') && !componentCode.startsWith('LI')) return 'label';
  const group = productGroups[componentCode] || '';
  if (group === 'MF - Intermediate') return 'intermediate';
  // Fallback: codes beginning I[A-Z] with the known intermediate prefixes
  const INTERMEDIATE_PREFIXES = ['IA', 'IG', 'IM', 'IC', 'IS', 'IY'];
  if (INTERMEDIATE_PREFIXES.some(p => componentCode.startsWith(p))) return 'intermediate';
  return 'other';
}

/** 3-decimal-safe rounding for display. */
function round(n: number, places = 3): number {
  const k = Math.pow(10, places);
  return Math.round(n * k) / k;
}

/**
 * Build the workbook from a planner snapshot and return an ArrayBuffer that
 * the caller can stream to the browser as a download. All aggregation is
 * pure — no side effects, no DOM access — so the utility is testable.
 */
export function exportPackagingPlan(input: ExportPlanInput): ArrayBuffer {
  const {
    runs,
    skus,
    bomEntries,
    sohItems,
    supplierByCode,
    monthlyUsage,
    productGroups,
  } = input;

  const skuByCode = new Map(skus.map(s => [s.productCode, s]));

  // The raw payload's SOH shape is slightly trimmed compared to the canonical
  // StockOnHandItem (only the fields the export needs are guaranteed). Cast
  // at call site so the engine gets the full structural type it expects.
  const sohView = new WarehouseSOH(sohItems as unknown as StockOnHandItem[]);

  const globalSOH = sohView.globalOnHandMap();
  const mfPackagingSOH = sohView.byWarehouseMap(WAREHOUSES.MF_PACKAGING);
  const perProductSOH = sohView.perProductMap();

  // ─── BOM lookup: parent → { componentCode, qtyPerParent }[] ───
  const bomByParent = new Map<string, RawBOMEntry[]>();
  for (const e of bomEntries) {
    if (!e.parentProductCode) continue;
    if (!bomByParent.has(e.parentProductCode)) bomByParent.set(e.parentProductCode, []);
    bomByParent.get(e.parentProductCode)!.push(e);
  }

  // Name lookup: prefer SKU-level, fall back to BOM descriptions, fall back to SOH productName.
  const nameByCode = new Map<string, string>();
  for (const s of skus) nameByCode.set(s.productCode, s.productName);
  for (const e of bomEntries) {
    if (!nameByCode.has(e.productCode)) nameByCode.set(e.productCode, e.productDescription);
  }
  for (const s of sohItems) {
    if (!nameByCode.has(s.productCode)) nameByCode.set(s.productCode, s.productName);
  }

  // ─── Aggregate per-component demand from the scheduled runs ───
  // For each run (FG, qty, day), walk the FG's BOM. Labels get 1 per unit; all
  // other components are qtyPerParent-weighted.
  interface RequiredItem {
    componentCode: string;
    componentName: string;
    kind: 'label' | 'intermediate' | 'other';
    totalRequired: number;
    /** For intermediates, per-day kg map. */
    perDay: Map<number, number>;
    /** Which FGs contributed (for email/detail). */
    parentFGs: Set<string>;
  }

  const required = new Map<string, RequiredItem>();

  const bump = (
    code: string,
    name: string,
    kind: RequiredItem['kind'],
    qty: number,
    dayInt: number,
    parentFG: string,
  ) => {
    let row = required.get(code);
    if (!row) {
      row = {
        componentCode: code,
        componentName: name,
        kind,
        totalRequired: 0,
        perDay: new Map(),
        parentFGs: new Set(),
      };
      required.set(code, row);
    }
    row.totalRequired += qty;
    row.perDay.set(dayInt, (row.perDay.get(dayInt) || 0) + qty);
    row.parentFGs.add(parentFG);
  };

  for (const run of runs) {
    if (run.quantity <= 0) continue;
    const sku = skuByCode.get(run.productCode);
    const parentName = sku?.productName || run.productCode;
    const bomLines = bomByParent.get(run.productCode) || [];

    // If no BOM entries are known, at minimum emit the label + intermediate
    // from the SKU cache so the procurement output isn't empty for that run.
    // (The BOM cache only covers a few intermediate codes — the SKU-level
    // derivation catches the common case.)
    if (bomLines.length === 0 && sku) {
      if (sku.labelSKU) {
        bump(sku.labelSKU, nameByCode.get(sku.labelSKU) || sku.labelSKU, 'label', run.quantity, run.dayInt, run.productCode);
      }
      if (sku.foodComponentCode && sku.kgPerUnit > 0) {
        bump(
          sku.foodComponentCode,
          nameByCode.get(sku.foodComponentCode) || sku.foodComponentCode,
          'intermediate',
          run.quantity * sku.kgPerUnit,
          run.dayInt,
          run.productCode,
        );
      }
      continue;
    }

    for (const line of bomLines) {
      const kind = classifyComponent(line.productCode, productGroups);
      const name = nameByCode.get(line.productCode) || line.productDescription || line.productCode;
      const qty =
        kind === 'label'
          ? run.quantity // labels are 1-per-unit regardless of the BOM value
          : run.quantity * (line.quantityPerParent || 0);
      if (qty <= 0) continue;
      bump(line.productCode, name, kind, qty, run.dayInt, run.productCode);
      void parentName;
    }
  }

  // ─── 3-month forecast per component ───
  // Derive by rolling the FG-level monthlyUsage × 3 down the same BOM path as
  // the plan aggregation. Gives a "what would you normally consume in 3mo"
  // benchmark that's directly comparable to the "amount required (plan)" col.
  const forecast3mo = new Map<string, number>();
  const bumpForecast = (code: string, qty: number) => {
    if (qty <= 0) return;
    forecast3mo.set(code, (forecast3mo.get(code) || 0) + qty);
  };
  for (const sku of skus) {
    const usage = monthlyUsage[sku.productCode];
    if (!usage || usage <= 0) continue;
    const units3mo = usage * 3;
    const bomLines = bomByParent.get(sku.productCode) || [];
    if (bomLines.length === 0) {
      if (sku.labelSKU) bumpForecast(sku.labelSKU, units3mo);
      if (sku.foodComponentCode && sku.kgPerUnit > 0) {
        bumpForecast(sku.foodComponentCode, units3mo * sku.kgPerUnit);
      }
      continue;
    }
    for (const line of bomLines) {
      const kind = classifyComponent(line.productCode, productGroups);
      const qty = kind === 'label' ? units3mo : units3mo * (line.quantityPerParent || 0);
      bumpForecast(line.productCode, qty);
    }
  }

  // ─── Sheet 1: Summary (grouped by supplier) ───
  const supplierOf = (code: string): SupplierRef =>
    supplierByCode[code] || UNKNOWN_SUPPLIER;

  const summaryRows: Record<string, string | number>[] = [];
  const sortedRequired = [...required.values()].sort((a, b) => {
    const sa = supplierOf(a.componentCode).name;
    const sb = supplierOf(b.componentCode).name;
    if (sa !== sb) return sa.localeCompare(sb);
    return a.componentCode.localeCompare(b.componentCode);
  });
  for (const item of sortedRequired) {
    const sup = supplierOf(item.componentCode);
    const currentSOH = globalSOH[item.componentCode] || 0;
    const shortfall = Math.max(0, item.totalRequired - currentSOH);
    summaryRows.push({
      Supplier: sup.name,
      'Supplier Code': sup.code,
      'Item Code': item.componentCode,
      'Item Name': item.componentName,
      Type: item.kind,
      Unit: item.kind === 'label' || item.kind === 'other' ? 'ea' : 'kg',
      'Amount Required (Plan)': round(item.totalRequired),
      '3mo Forecast': round(forecast3mo.get(item.componentCode) || 0),
      'Current SOH (global)': round(currentSOH),
      'SOH at MF Packaging': round(mfPackagingSOH[item.componentCode] || 0),
      Shortfall: round(shortfall),
      'FGs Using This': [...item.parentFGs].sort().join(', '),
    });
  }
  const summarySheet = XLSX.utils.json_to_sheet(summaryRows);

  // ─── Sheet 2: Labels by supplier ───
  const labelRows: Record<string, string | number>[] = [];
  for (const item of sortedRequired) {
    if (item.kind !== 'label') continue;
    const sup = supplierOf(item.componentCode);
    const currentSOH = globalSOH[item.componentCode] || 0;
    const mfSOH = mfPackagingSOH[item.componentCode] || 0;
    const shortfall = Math.max(0, item.totalRequired - currentSOH);
    const earliestDay = [...item.perDay.keys()].sort((a, b) => a - b)[0];
    const latestDay = [...item.perDay.keys()].sort((a, b) => b - a)[0];
    labelRows.push({
      Supplier: sup.name,
      'Supplier Code': sup.code,
      'Label SKU': item.componentCode,
      'Label Name': item.componentName,
      'Units Required': Math.round(item.totalRequired),
      '3mo Forecast': Math.round(forecast3mo.get(item.componentCode) || 0),
      'SOH (global)': round(currentSOH),
      'SOH at MF Packaging': round(mfSOH),
      Shortfall: Math.round(shortfall),
      'First Needed': earliestDay ? toLocalISODate(dayIntToDate(earliestDay)) : '',
      'Last Needed': latestDay ? toLocalISODate(dayIntToDate(latestDay)) : '',
      'FGs Using This': [...item.parentFGs].sort().join(', '),
    });
  }
  const labelsSheet = XLSX.utils.json_to_sheet(labelRows);

  // ─── Sheet 3: Intermediates by day ───
  const intByDayRows: Record<string, string | number>[] = [];
  for (const item of sortedRequired) {
    if (item.kind !== 'intermediate') continue;
    const mfSOH = mfPackagingSOH[item.componentCode] || 0;
    const days = [...item.perDay.entries()].sort((a, b) => a[0] - b[0]);
    for (const [dayInt, kg] of days) {
      const dateStr = toLocalISODate(dayIntToDate(dayInt));
      intByDayRows.push({
        Date: dateStr,
        'Intermediate Code': item.componentCode,
        'Intermediate Name': item.componentName,
        'Kg Required': round(kg),
        'SOH at MF Packaging': round(mfSOH),
        'Transfer Needed?': mfSOH < item.totalRequired ? 'yes' : 'no',
        'FGs That Day': [...item.parentFGs]
          .filter(fg => runs.some(r => r.productCode === fg && r.dayInt === dayInt))
          .join(', '),
      });
    }
  }
  const intByDaySheet = XLSX.utils.json_to_sheet(intByDayRows);

  // ─── Sheet 4: Other components ───
  const otherRows: Record<string, string | number>[] = [];
  for (const item of sortedRequired) {
    if (item.kind !== 'other') continue;
    const sup = supplierOf(item.componentCode);
    const currentSOH = globalSOH[item.componentCode] || 0;
    const shortfall = Math.max(0, item.totalRequired - currentSOH);
    otherRows.push({
      Supplier: sup.name,
      'Supplier Code': sup.code,
      'Item Code': item.componentCode,
      'Item Name': item.componentName,
      'Amount Required (Plan)': round(item.totalRequired),
      '3mo Forecast': round(forecast3mo.get(item.componentCode) || 0),
      'Current SOH (global)': round(currentSOH),
      Shortfall: round(shortfall),
      'FGs Using This': [...item.parentFGs].sort().join(', '),
    });
  }
  const otherSheet = XLSX.utils.json_to_sheet(otherRows);

  // ─── Sheet 5: Transfers needed ───
  // An item shows here when MF Packaging doesn't have enough but globally
  // there IS enough — i.e., it can be solved by a warehouse transfer.
  const transferRows: Record<string, string | number>[] = [];
  for (const item of sortedRequired) {
    const mfSOH = mfPackagingSOH[item.componentCode] || 0;
    const globSOH = globalSOH[item.componentCode] || 0;
    const requiredHere = item.totalRequired;
    if (mfSOH >= requiredHere) continue; // fine where it sits
    const transferable = Math.max(0, Math.min(requiredHere - mfSOH, globSOH - mfSOH));
    if (transferable <= 0) continue; // needs purchasing, not transfer
    // Find the warehouse(s) holding the shortfall
    const byWh = perProductSOH[item.componentCode] || {};
    const holders = Object.entries(byWh)
      .filter(([wh, q]) => wh !== WAREHOUSES.MF_PACKAGING && q > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([wh, q]) => `${wh || 'Default'}: ${round(q)}`)
      .join(' · ');
    const earliestDay = [...item.perDay.keys()].sort((a, b) => a - b)[0];
    transferRows.push({
      'Item Code': item.componentCode,
      'Item Name': item.componentName,
      Type: item.kind,
      Unit: item.kind === 'label' || item.kind === 'other' ? 'ea' : 'kg',
      'Qty to Transfer': round(transferable),
      'SOH at MF Packaging': round(mfSOH),
      'SOH at Other Warehouses': holders,
      'Needed By': earliestDay ? toLocalISODate(dayIntToDate(earliestDay)) : '',
    });
  }
  const transfersSheet = XLSX.utils.json_to_sheet(transferRows);

  // ─── Assemble workbook ───
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, summarySheet, 'Summary');
  XLSX.utils.book_append_sheet(wb, labelsSheet, 'Labels by supplier');
  XLSX.utils.book_append_sheet(wb, intByDaySheet, 'Intermediates by day');
  XLSX.utils.book_append_sheet(wb, otherSheet, 'Other components');
  XLSX.utils.book_append_sheet(wb, transfersSheet, 'Transfers needed');

  return XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
}

/**
 * Browser-side helper: generate the workbook and trigger a download with a
 * timestamped filename. Keeps the production code free of DOM/File API
 * scattered across pages.
 */
export function downloadPackagingPlan(input: ExportPlanInput): void {
  const buffer = exportPackagingPlan(input);
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `packaging-plan-requirements-${stamp}.xlsx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
