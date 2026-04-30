'use client';

import { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import type { PurchaseOrder } from '@/lib/unleashed/types';
import type { KitchenBatch } from '@/lib/planning/engine-io';
import type { ComponentStatus, DraftPO } from '../hooks/usePurchasingPlanner';
import type { SupplierInfo } from '../data/mock-purchasing-data';
import type { WarehouseAssignment } from '@/lib/planning/warehouse-assignments';
import { buildAssignmentMap } from '@/lib/planning/warehouse-assignments';
import { ClampedPopover } from '@/app/components/ClampedPopover';

// ─── Types ──────────────────────────────────────────────────

interface ComponentTableProps {
  componentSOH: Record<string, number>;
  /** productCode → warehouseName → qty */
  perWarehouseSOH: Record<string, Record<string, number>>;
  componentNames: Record<string, string>;
  componentSuppliers: Record<string, string>;
  suppliers: Record<string, SupplierInfo>;
  consumptionSchedule: Record<string, KitchenBatch[]>;
  /** productCode → monthly demand from CSV (authoritative rates) */
  demandRates: Record<string, number>;
  existingPOs: PurchaseOrder[];
  draftPOs: DraftPO[];
  componentStatusMap: Map<string, ComponentStatus>;
  onComponentClick: (code: string) => void;
  /**
   * Page-level quick filter driven by the stat cards in the header. Each
   * card filters the table down to a single status, or to rows with an
   * attached draft PO. `null` shows all rows.
   */
  statFilter?: 'ok' | 'low' | 'stockout' | 'draft' | null;
}

interface RowData {
  code: string;
  name: string;
  supplier: string;
  status: ComponentStatus;
  soh: number;
  /** SOH at the planning warehouse for this component */
  warehouseSOH: number;
  /** Total SOH across all warehouses */
  globalSOH: number;
  /** The planning warehouse for this component */
  planningWarehouse: string;
  /** Whether the warehouse assignment is a user override */
  isWarehouseOverride: boolean;
  /** Reason text for auto-assigned warehouse */
  warehouseReason: string;
  onOrder: number;
  allocated: number;
  monthlyDemand: number;
  days: number;
  adequacyPct: number;
  nextPOQty: number | null;
  nextPODate: Date | null;
  dailyConsumption: number[];
  dailyBatches: KitchenBatch[][];
  dailyBalance: number[];
  monthlyProjection: { balance: number; incoming: number; demand: number }[];
  runoutIdx: number | null;
  draftCount: number;
}

/** Detail popover for a clicked production/purchasing cell */
interface CellDetail {
  code: string;
  label: string;
  rect: { top: number; left: number; width: number };
  incoming: { source: string; qty: number; date: string; poNumber?: string }[];
  outgoing: { target: string; qty: number; date: string }[];
  openingSOH: number;
  closingSOH: number;
}

type SortKey = 'status' | 'code' | 'name' | 'soh' | 'order' | 'demand' | 'days' | 'adequacy' | 'nextPOQty';

type CheckboxFilters = Partial<Record<SortKey, Set<string>>>;

// Default column widths
const DEFAULT_WIDTHS = [22, 82, 140, 56, 56, 52, 40, 110, 52, 62];
// daily (40) + monthly (12) + runout (1) added dynamically

// ─── Helpers ────────────────────────────────────────────────

function getMonday(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay();
  d.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
  return d;
}

function mKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function daysColor(d: number): string {
  if (d === Infinity) return 'var(--text-muted)';
  if (d < 14) return 'var(--danger)';
  if (d < 30) return 'var(--warning)';
  return 'var(--success)';
}

function balanceColor(b: number): string {
  if (b <= 0) return 'var(--danger)';
  if (b < 100) return 'var(--warning)';
  return 'var(--text-secondary)';
}

const STATUS_DOT: Record<ComponentStatus, string> = {
  ok: 'var(--success)',
  low: 'var(--warning)',
  stockout: 'var(--danger)',
};

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function formatDayTooltip(label: string, consumption: number, balance: number, batches: KitchenBatch[]): string {
  const lines: string[] = [label];
  if (consumption > 0) {
    lines.push(`Consumption: ${Math.round(consumption)}`);
    batches.forEach(b => lines.push(`  ${b.productName}: ${Math.round(b.quantity)}`));
    lines.push('\u2500\u2500\u2500');
  }
  lines.push(`Running SOH: ${Math.round(balance)}`);
  return lines.join('\n');
}

// ─── Filter helpers ─────────────────────────────────────────

function getCompFilterDisplayValue(row: RowData, key: SortKey): string {
  switch (key) {
    case 'status':
      return row.status === 'stockout' ? 'Stockout' : row.status === 'low' ? 'Low' : 'OK';
    case 'code': return row.code;
    case 'name': return row.name || '(unnamed)';
    case 'soh': {
      const v = Math.round(row.warehouseSOH);
      if (v <= 0) return '0';
      if (v < 100) return '1-99';
      if (v < 500) return '100-499';
      if (v < 1000) return '500-999';
      return '1000+';
    }
    case 'order': {
      if (row.onOrder <= 0) return '(none)';
      if (row.onOrder < 100) return '1-99';
      if (row.onOrder < 500) return '100-499';
      return '500+';
    }
    case 'demand': {
      if (row.monthlyDemand <= 0) return '(none)';
      if (row.monthlyDemand < 100) return '1-99';
      if (row.monthlyDemand < 500) return '100-499';
      return '500+';
    }
    case 'days': {
      if (row.days === Infinity) return '(no demand)';
      const d = Math.round(row.days);
      if (d <= 0) return '0d (out)';
      if (d < 7) return '<7d';
      if (d < 14) return '7-13d';
      if (d < 30) return '14-29d';
      if (d < 60) return '30-59d';
      return '60d+';
    }
    case 'adequacy': {
      if (row.allocated <= 0) return '(no demand)';
      const p = Math.round(row.adequacyPct);
      if (p <= 0) return '0%';
      if (p < 50) return '1-49%';
      if (p < 100) return '50-99%';
      return '100%+';
    }
    case 'nextPOQty': {
      if (!row.nextPOQty) return '(none)';
      if (row.nextPOQty < 100) return '1-99';
      if (row.nextPOQty < 500) return '100-499';
      return '500+';
    }
  }
}

function CompFilterDropdown({
  columnKey, allValues, selected, onUpdate, onClose,
}: {
  columnKey: SortKey;
  allValues: { display: string; count: number }[];
  selected: Set<string> | undefined;
  onUpdate: (key: SortKey, selected: Set<string> | undefined) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState('');
  const allDisplays = useMemo(() => allValues.map(v => v.display), [allValues]);
  const [checked, setChecked] = useState<Set<string>>(() => selected ?? new Set(allDisplays));

  useEffect(() => {
    const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    return q ? allValues.filter(v => v.display.toLowerCase().includes(q)) : allValues;
  }, [allValues, search]);

  const allChecked = checked.size === allDisplays.length;

  return (
    <div ref={ref} className="absolute top-full mt-1 rounded shadow-lg z-50" style={{ background: 'var(--bg-page)', border: '0.5px solid var(--border)', minWidth: 180, maxWidth: 260, right: 0 }} onClick={e => e.stopPropagation()}>
      <div className="px-2 pt-2 pb-1">
        <input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search..." autoFocus className="w-full rounded px-2 py-1 text-xs focus:outline-none" style={{ background: 'var(--bg-surface)', border: '0.5px solid var(--border)', color: 'var(--text-primary)' }} />
      </div>
      <div className="px-2 py-1 flex items-center gap-2" style={{ borderBottom: '0.5px solid var(--border)' }}>
        <button onClick={() => setChecked(allChecked ? new Set() : new Set(allDisplays))} className="text-[11px] transition hover:opacity-70" style={{ color: 'var(--accent)', fontWeight: 500 }}>
          {allChecked ? 'Clear All' : 'Select All'}
        </button>
        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{checked.size}/{allDisplays.length}</span>
      </div>
      <div className="max-h-[240px] overflow-y-auto px-1 py-1">
        {filtered.map(({ display, count }) => (
          <label key={display} className="flex items-center gap-2 px-2 py-1 rounded cursor-pointer transition text-xs" style={{ color: 'var(--text-primary)' }} onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--bg-surface)'; }} onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = ''; }}>
            <input type="checkbox" checked={checked.has(display)} onChange={() => setChecked(p => { const n = new Set(p); n.has(display) ? n.delete(display) : n.add(display); return n; })} className="accent-[var(--accent)]" style={{ width: 13, height: 13 }} />
            <span className="flex-1 truncate">{display}</span>
            <span className="text-[10px] font-mono flex-shrink-0" style={{ color: 'var(--text-muted)' }}>{count}</span>
          </label>
        ))}
        {filtered.length === 0 && <div className="px-2 py-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>No matches</div>}
      </div>
      <div className="px-2 py-2 flex items-center justify-end gap-2" style={{ borderTop: '0.5px solid var(--border)' }}>
        <button onClick={onClose} className="text-[11px] px-2 py-1 rounded transition hover:opacity-70" style={{ color: 'var(--text-muted)', border: '0.5px solid var(--border)' }}>Cancel</button>
        <button onClick={() => { if (checked.size === allDisplays.length) onUpdate(columnKey, undefined); else onUpdate(columnKey, new Set(checked)); onClose(); }} disabled={checked.size === 0} className="text-[11px] px-2 py-1 rounded text-white transition hover:opacity-80 disabled:opacity-30" style={{ background: 'var(--accent)', fontWeight: 500 }}>Apply</button>
      </div>
    </div>
  );
}

// ─── Component ──────────────────────────────────────────────

export function ComponentTable({
  componentSOH,
  perWarehouseSOH,
  componentNames,
  componentSuppliers,
  suppliers,
  consumptionSchedule,
  demandRates,
  existingPOs,
  draftPOs,
  componentStatusMap,
  onComponentClick,
  statFilter = null,
}: ComponentTableProps) {
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('days');
  const [sortAsc, setSortAsc] = useState(true);
  const [activeOnly, setActiveOnly] = useState(true);
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [checkboxFilters, setCheckboxFilters] = useState<CheckboxFilters>({});
  const [openFilter, setOpenFilter] = useState<SortKey | null>(null);
  const [cellDetail, setCellDetail] = useState<CellDetail | null>(null);

  // Column widths (resizable)
  const [colWidths, setColWidths] = useState<number[]>([]);
  const resizeRef = useRef<{ colIdx: number; startX: number; startW: number } | null>(null);

  // Working days (8 weeks × 5 days = 40 days from this Monday)
  const days = useMemo(() => {
    const mon = getMonday(new Date());
    const result: { date: Date; dayNum: number; label: string; dayOfWeek: number }[] = [];
    for (let w = 0; w < 8; w++) {
      for (let d = 0; d < 5; d++) {
        const dt = new Date(mon);
        dt.setDate(dt.getDate() + w * 7 + d);
        result.push({
          date: dt,
          dayNum: dt.getDate(),
          label: dt.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' }),
          dayOfWeek: d, // 0=Mon, 4=Fri
        });
      }
    }
    return result;
  }, []);

  // Month ranges (12 months)
  const months = useMemo(() => {
    const now = new Date();
    return Array.from({ length: 12 }, (_, i) => {
      const m = new Date(now.getFullYear(), now.getMonth() + i, 1);
      return { date: m, key: mKey(m), label: m.toLocaleDateString('en-AU', { month: 'short', year: '2-digit' }) };
    });
  }, []);

  // Initialize column widths when column count changes
  const expectedColCount = DEFAULT_WIDTHS.length + days.length + months.length + 1;
  useEffect(() => {
    if (colWidths.length !== expectedColCount) {
      const dy = days.map(() => 18);
      const mo = months.map(() => 52);
      setColWidths([...DEFAULT_WIDTHS, ...dy, ...mo, 50]);
    }
  }, [days, months, expectedColCount, colWidths.length]);

  const totalWidth = useMemo(() => colWidths.reduce((s, w) => s + w, 0), [colWidths]);

  // Column resize handlers
  const handleResizeStart = useCallback((colIdx: number, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    resizeRef.current = { colIdx, startX: e.clientX, startW: colWidths[colIdx] };

    const handleMove = (ev: MouseEvent) => {
      if (!resizeRef.current) return;
      const delta = ev.clientX - resizeRef.current.startX;
      const newW = Math.max(28, resizeRef.current.startW + delta);
      setColWidths(prev => {
        const next = [...prev];
        next[resizeRef.current!.colIdx] = newW;
        return next;
      });
    };
    const handleUp = () => {
      resizeRef.current = null;
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', handleUp);
    };
    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleUp);
  }, [colWidths]);

  // Warehouse assignments for all component codes
  const warehouseAssignments = useMemo(() => {
    const codes = Object.keys(componentSOH);
    if (codes.length === 0) return {} as Record<string, WarehouseAssignment>;
    return buildAssignmentMap(codes, perWarehouseSOH);
  }, [componentSOH, perWarehouseSOH]);

  // PO on-order per component
  const onOrderMap = useMemo(() => {
    const map: Record<string, number> = {};
    for (const po of existingPOs) {
      for (const line of po.purchaseOrderLines) {
        const rem = line.quantityOrdered - line.quantityReceived;
        if (rem > 0) map[line.productCode] = (map[line.productCode] || 0) + rem;
      }
    }
    for (const d of draftPOs) {
      map[d.componentCode] = (map[d.componentCode] || 0) + d.quantity;
    }
    return map;
  }, [existingPOs, draftPOs]);

  // PO by month per component
  const poMonthMap = useMemo(() => {
    const map: Record<string, Record<string, number>> = {};
    for (const po of existingPOs) {
      for (const line of po.purchaseOrderLines) {
        const rem = line.quantityOrdered - line.quantityReceived;
        if (rem <= 0) continue;
        const dt = new Date(line.expectedDeliveryDate || po.expectedDeliveryDate || po.requiredDate || po.orderedDate);
        const mk = mKey(dt);
        if (!map[line.productCode]) map[line.productCode] = {};
        map[line.productCode][mk] = (map[line.productCode][mk] || 0) + rem;
      }
    }
    for (const d of draftPOs) {
      const mk = mKey(d.deliveryDate);
      if (!map[d.componentCode]) map[d.componentCode] = {};
      map[d.componentCode][mk] = (map[d.componentCode][mk] || 0) + d.quantity;
    }
    return map;
  }, [existingPOs, draftPOs]);

  // Detailed PO lines per component per month (for cell detail popover)
  const poLinesByMonth = useMemo(() => {
    const map: Record<string, Record<string, { source: string; qty: number; date: string; poNumber?: string }[]>> = {};
    for (const po of existingPOs) {
      for (const line of po.purchaseOrderLines) {
        const rem = line.quantityOrdered - line.quantityReceived;
        if (rem <= 0) continue;
        const dt = new Date(line.expectedDeliveryDate || po.expectedDeliveryDate || po.requiredDate || po.orderedDate);
        const mk = mKey(dt);
        if (!map[line.productCode]) map[line.productCode] = {};
        if (!map[line.productCode][mk]) map[line.productCode][mk] = [];
        map[line.productCode][mk].push({
          source: po.supplierName || po.supplierCode || 'Unknown',
          qty: rem,
          date: dt.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }),
          poNumber: po.purchaseOrderNumber || po.orderNumber,
        });
      }
    }
    for (const d of draftPOs) {
      const mk = mKey(d.deliveryDate);
      if (!map[d.componentCode]) map[d.componentCode] = {};
      if (!map[d.componentCode][mk]) map[d.componentCode][mk] = [];
      map[d.componentCode][mk].push({
        source: d.supplierName || 'Draft',
        qty: d.quantity,
        date: d.deliveryDate.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }),
      });
    }
    return map;
  }, [existingPOs, draftPOs]);

  // Draft count per component
  const draftCountMap = useMemo(() => {
    const map: Record<string, number> = {};
    for (const d of draftPOs) map[d.componentCode] = (map[d.componentCode] || 0) + 1;
    return map;
  }, [draftPOs]);

  // Next incoming PO per component (earliest delivery date with remaining qty)
  const nextPOMap = useMemo(() => {
    const map: Record<string, { qty: number; date: Date }> = {};
    for (const po of existingPOs) {
      for (const line of po.purchaseOrderLines) {
        const rem = line.quantityOrdered - line.quantityReceived;
        if (rem <= 0) continue;
        const dt = new Date(line.expectedDeliveryDate || po.expectedDeliveryDate || po.requiredDate || po.orderedDate);
        const existing = map[line.productCode];
        if (!existing || dt.getTime() < existing.date.getTime()) {
          map[line.productCode] = { qty: rem, date: dt };
        }
      }
    }
    for (const d of draftPOs) {
      const existing = map[d.componentCode];
      if (!existing || d.deliveryDate.getTime() < existing.date.getTime()) {
        map[d.componentCode] = { qty: d.quantity, date: d.deliveryDate };
      }
    }
    return map;
  }, [existingPOs, draftPOs]);

  // Build row data
  const rows = useMemo((): RowData[] => {
    return Object.keys(componentSOH).map(code => {
      const globalSOH = componentSOH[code] || 0;
      const name = componentNames[code] || code;
      const suppId = componentSuppliers[code] || '';
      const supplier = suppliers[suppId]?.supplierName || '';
      const status = componentStatusMap.get(code) || 'ok';
      const batches = consumptionSchedule[code] || [];
      const onOrder = onOrderMap[code] || 0;
      const allocated = batches.reduce((s, b) => s + b.quantity, 0);

      // Warehouse assignment
      const assignment = warehouseAssignments[code];
      const planningWarehouse = assignment?.warehouseName || '';
      const isWarehouseOverride = assignment?.isOverride || false;
      const warehouseReason = assignment?.autoReason || '';

      // Warehouse-scoped SOH (fall back to global if no warehouse data)
      const perProductWH = perWarehouseSOH[code] || {};
      const warehouseSOH = planningWarehouse && perProductWH[planningWarehouse] !== undefined
        ? perProductWH[planningWarehouse]
        : globalSOH;

      // Use warehouse SOH for projections (daily heatmap, days-of-stock, etc.)
      const soh = warehouseSOH;

      // Monthly demand: prefer CSV rates, fall back to batch-derived estimate
      let monthlyDemand = demandRates[code] || 0;
      if (monthlyDemand === 0 && batches.length > 0) {
        const times = batches.map(b => b.scheduledDate.getTime());
        const rangeDays = Math.max(1, (Math.max(...times) - Math.min(...times)) / 864e5);
        monthlyDemand = (allocated / Math.max(rangeDays, 7)) * 30;
      }

      const dailyDemand = monthlyDemand / 22;
      const daysOfStock = dailyDemand > 0 ? soh / dailyDemand : Infinity;

      // Daily consumption + batches + running SOH balance (uses outer `days` array)
      const dailyConsumption = days.map(day =>
        batches.filter(b => sameDay(b.scheduledDate, day.date)).reduce((s, b) => s + b.quantity, 0)
      );
      const dailyBatches = days.map(day =>
        batches.filter(b => sameDay(b.scheduledDate, day.date))
      );
      let runBal = soh;
      const dailyBalance = dailyConsumption.map(dc => { runBal -= dc; return runBal; });

      // SOH adequacy vs 4-week consumption
      const total4w = dailyConsumption.reduce((s, dc) => s + dc, 0);
      const adequacyPct = total4w > 0 ? Math.min(200, (soh / total4w) * 100) : (soh > 0 ? 200 : 0);

      // Monthly projection
      const pom = poMonthMap[code] || {};
      let bal = soh;
      let runoutIdx: number | null = null;
      const monthlyProjection = months.map((m, i) => {
        const incoming = pom[m.key] || 0;
        const demand = monthlyDemand;
        bal = bal + incoming - demand;
        if (runoutIdx === null && bal <= 0) runoutIdx = i;
        return { balance: bal, incoming, demand };
      });

      const nextPO = nextPOMap[code] || null;

      return {
        code, name, supplier, status, soh, warehouseSOH, globalSOH,
        planningWarehouse, isWarehouseOverride, warehouseReason,
        onOrder, allocated,
        monthlyDemand, days: daysOfStock, adequacyPct,
        nextPOQty: nextPO?.qty ?? null, nextPODate: nextPO?.date ?? null,
        dailyConsumption, dailyBatches, dailyBalance,
        monthlyProjection, runoutIdx,
        draftCount: draftCountMap[code] || 0,
      };
    });
  }, [componentSOH, perWarehouseSOH, warehouseAssignments, componentNames, componentSuppliers, suppliers, componentStatusMap, consumptionSchedule, demandRates, onOrderMap, poMonthMap, draftCountMap, nextPOMap, days, months]);

  // Active = has consumption, POs, or draft POs
  const activeSet = useMemo(() => {
    const set = new Set<string>();
    for (const code of Object.keys(consumptionSchedule)) {
      if (consumptionSchedule[code]?.length > 0) set.add(code);
    }
    for (const po of existingPOs) {
      for (const line of po.purchaseOrderLines) set.add(line.productCode);
    }
    for (const d of draftPOs) set.add(d.componentCode);
    return set;
  }, [consumptionSchedule, existingPOs, draftPOs]);

  // Cell click handlers for production / purchasing windows
  const handleDayCellClick = useCallback((e: React.MouseEvent<HTMLTableCellElement>, row: RowData, dayIdx: number) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const batches = row.dailyBatches[dayIdx];
    const day = days[dayIdx];
    const prevBalance = dayIdx > 0 ? row.dailyBalance[dayIdx - 1] : row.soh;
    setCellDetail({
      code: row.code,
      label: day.label,
      // Viewport-space (no scrollY/scrollX added) — the popover renders with
      // `position: fixed`, which is already viewport-relative. Adding scroll
      // offset here drifted the popover as the page scrolled.
      rect: { top: rect.bottom, left: rect.left, width: 280 },
      incoming: [],
      outgoing: batches.map(b => ({
        target: b.productName || b.productCode,
        qty: b.quantity,
        date: day.label,
      })),
      openingSOH: prevBalance,
      closingSOH: row.dailyBalance[dayIdx],
    });
  }, [days]);

  const handleMonthCellClick = useCallback((e: React.MouseEvent<HTMLTableCellElement>, row: RowData, monthIdx: number) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const month = months[monthIdx];
    const mp = row.monthlyProjection[monthIdx];
    const prevBalance = monthIdx > 0 ? row.monthlyProjection[monthIdx - 1].balance : row.soh;
    const poLines = poLinesByMonth[row.code]?.[month.key] || [];
    setCellDetail({
      code: row.code,
      label: month.label,
      // Viewport-space (no scrollY/scrollX added) — the popover renders with
      // `position: fixed`, which is already viewport-relative. Adding scroll
      // offset here drifted the popover as the page scrolled.
      rect: { top: rect.bottom, left: rect.left, width: 280 },
      incoming: poLines,
      outgoing: mp.demand > 0 ? [{ target: 'Demand', qty: mp.demand, date: month.label }] : [],
      openingSOH: prevBalance,
      closingSOH: mp.balance,
    });
  }, [months, poLinesByMonth]);

  // Close cell detail on outside click
  useEffect(() => {
    if (!cellDetail) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('[data-cell-detail]')) setCellDetail(null);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [cellDetail]);

  const hasActiveFilters = useMemo(() => {
    return Object.keys(checkboxFilters).length > 0;
  }, [checkboxFilters]);

  // Unique filter values per column (computed from all rows before filtering)
  const filterableKeys: SortKey[] = ['status', 'code', 'name', 'soh', 'order', 'demand', 'days', 'adequacy', 'nextPOQty'];

  const uniqueFilterValues = useMemo(() => {
    const baseRows = activeOnly ? rows.filter(r => activeSet.has(r.code)) : rows;
    const result: Record<SortKey, { display: string; count: number }[]> = {} as any;
    for (const key of filterableKeys) {
      const counts = new Map<string, number>();
      for (const row of baseRows) {
        const display = getCompFilterDisplayValue(row, key);
        counts.set(display, (counts.get(display) || 0) + 1);
      }
      result[key] = Array.from(counts.entries())
        .map(([display, count]) => ({ display, count }))
        .sort((a, b) => a.display.localeCompare(b.display));
    }
    return result;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, activeOnly, activeSet]);

  // Filter + sort
  const sorted = useMemo(() => {
    let result = rows;
    if (activeOnly) {
      result = result.filter(r => activeSet.has(r.code));
    }
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(r => r.code.toLowerCase().includes(q) || r.name.toLowerCase().includes(q) || r.supplier.toLowerCase().includes(q));
    }
    // Checkbox filters
    for (const key of filterableKeys) {
      const sel = checkboxFilters[key];
      if (sel) {
        result = result.filter(r => sel.has(getCompFilterDisplayValue(r, key)));
      }
    }

    // Page-level stat-card filter. Applied AFTER the checkbox filters so an
    // operator can narrow to (e.g.) "Stockout" via the card, then further
    // narrow by supplier via the column filter.
    if (statFilter === 'ok' || statFilter === 'low' || statFilter === 'stockout') {
      result = result.filter(r => r.status === statFilter);
    } else if (statFilter === 'draft') {
      result = result.filter(r => (draftCountMap[r.code] || 0) > 0);
    }

    const statusOrder: Record<ComponentStatus, number> = { stockout: 0, low: 1, ok: 2 };
    result = [...result].sort((a, b) => {
      let c = 0;
      switch (sortKey) {
        case 'status': c = statusOrder[a.status] - statusOrder[b.status]; break;
        case 'code': c = a.code.localeCompare(b.code); break;
        case 'name': c = a.name.localeCompare(b.name); break;
        case 'soh': c = a.soh - b.soh; break;
        case 'order': c = a.onOrder - b.onOrder; break;
        case 'demand': c = a.monthlyDemand - b.monthlyDemand; break;
        case 'days': c = (a.days === Infinity ? 9999 : a.days) - (b.days === Infinity ? 9999 : b.days); break;
        case 'adequacy': c = a.adequacyPct - b.adequacyPct; break;
        case 'nextPOQty': c = (a.nextPOQty ?? 0) - (b.nextPOQty ?? 0); break;
      }
      return sortAsc ? c : -c;
    });
    return result;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, search, sortKey, sortAsc, activeOnly, activeSet, checkboxFilters, statFilter, draftCountMap]);

  const toggleSort = useCallback((key: SortKey) => {
    if (sortKey === key) setSortAsc(p => !p);
    else { setSortKey(key); setSortAsc(true); }
  }, [sortKey]);

  const updateCheckboxFilter = useCallback((key: SortKey, selected: Set<string> | undefined) => {
    setCheckboxFilters(prev => {
      const next = { ...prev };
      if (selected === undefined) delete next[key]; else next[key] = selected;
      return next;
    });
  }, []);

  // Sticky header offsets
  const sectionRowH = 28;
  const headerRowH = 28;

  if (colWidths.length === 0) return null;

  return (
    <div className="flex flex-col h-full overflow-hidden min-w-0">
      {/* Filter bar */}
      <div className="px-4 py-2 flex items-center gap-3" style={{ borderBottom: '0.5px solid var(--border)' }}>
        <input
          type="text"
          placeholder="Search components..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="rounded px-3 py-1.5 text-xs w-52 focus:outline-none"
          style={{ color: 'var(--text-primary)', background: 'var(--bg-surface)', border: '0.5px solid var(--border)' }}
        />
        <button
          onClick={() => setActiveOnly(p => !p)}
          className="px-2 py-1 rounded text-xs transition hover:opacity-70"
          style={{
            color: activeOnly ? 'var(--accent)' : 'var(--text-muted)',
            background: activeOnly ? 'var(--accent-light)' : 'transparent',
            border: `0.5px solid ${activeOnly ? 'var(--accent)' : 'var(--border)'}`,
            fontWeight: 500,
          }}
        >
          Active only
        </button>
        {hasActiveFilters && (
          <button
            onClick={() => setCheckboxFilters({})}
            className="px-2 py-1 rounded text-xs transition hover:opacity-70"
            style={{ color: 'var(--danger)', fontWeight: 500 }}
          >
            Clear Filters
          </button>
        )}
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
          {sorted.length}{activeOnly ? ` / ${rows.length}` : ''} component{sorted.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <table className="text-xs" style={{ borderCollapse: 'separate', borderSpacing: 0, tableLayout: 'fixed', width: totalWidth || 1128 }}>
          <colgroup>
            {colWidths.map((w, i) => <col key={i} style={{ width: w }} />)}
          </colgroup>
          <thead>
            {/* Section headers */}
            <tr style={{ position: 'sticky', top: 0, zIndex: 3 }}>
              <th colSpan={3} className="px-2 py-1.5 text-left" style={sectionHead}>COMPONENT</th>
              <th colSpan={4} className="px-2 py-1.5 text-center" style={{ ...sectionHead, borderLeft: '0.5px solid var(--border)' }}>STOCK</th>
              <th colSpan={1} className="px-2 py-1.5 text-center" style={{ ...sectionHead, borderLeft: '0.5px solid var(--border)' }}>ADEQUACY</th>
              <th colSpan={2} className="px-2 py-1.5 text-center" style={{ ...sectionHead, borderLeft: '0.5px solid var(--border)' }}>NEXT PO</th>
              <th colSpan={days.length} className="px-2 py-1.5 text-center" style={{ ...sectionHead, borderLeft: '0.5px solid var(--border)' }}>PRODUCTION</th>
              <th colSpan={months.length} className="px-2 py-1.5 text-center" style={{ ...sectionHead, borderLeft: '0.5px solid var(--border)' }}>PURCHASING</th>
              <th colSpan={1} className="px-2 py-1.5 text-center" style={{ ...sectionHead, borderLeft: '0.5px solid var(--border)' }}></th>
            </tr>
            {/* Column headers with sort + filter */}
            <tr style={{ position: 'sticky', top: sectionRowH, zIndex: 3 }}>
              {([
                { idx: 0, label: '',           colKey: 'status' as SortKey, align: 'center' as const, border: false },
                { idx: 1, label: 'Code',       colKey: 'code' as SortKey,   align: 'left' as const,   border: false },
                { idx: 2, label: 'Name',       colKey: 'name' as SortKey,   align: 'left' as const,   border: false },
                { idx: 3, label: 'SOH',        colKey: 'soh' as SortKey,    align: 'right' as const,  border: true },
                { idx: 4, label: 'Order',      colKey: 'order' as SortKey,  align: 'right' as const,  border: false },
                { idx: 5, label: 'Dem/mo',     colKey: 'demand' as SortKey, align: 'right' as const,  border: false },
                { idx: 6, label: 'Days',       colKey: 'days' as SortKey,   align: 'right' as const,  border: false },
                { idx: 7, label: 'SOH vs Plan', colKey: 'adequacy' as SortKey, align: 'right' as const, border: true },
                { idx: 8, label: 'Qty',        colKey: 'nextPOQty' as SortKey, align: 'right' as const, border: true },
              ]).map(col => {
                const isSorted = sortKey === col.colKey;
                const isFiltered = !!checkboxFilters[col.colKey];
                return (
                  <th
                    key={col.idx}
                    className="px-1.5 py-1.5 select-none"
                    style={{
                      position: 'relative',
                      textAlign: col.align,
                      fontWeight: 600,
                      fontSize: '11px',
                      color: isSorted ? 'var(--accent)' : 'var(--text-secondary)',
                      background: 'var(--bg-page)',
                      borderBottom: '0.5px solid var(--border)',
                      borderLeft: col.border ? '0.5px solid var(--border)' : undefined,
                      whiteSpace: 'nowrap',
                      overflow: 'visible',
                    }}
                  >
                    <div className="flex items-center gap-0.5" style={{ justifyContent: col.align === 'left' ? 'flex-start' : col.align === 'center' ? 'center' : 'flex-end' }}>
                      <button onClick={() => toggleSort(col.colKey)} className="hover:opacity-70 transition" style={{ fontWeight: 600, fontSize: '11px' }}>
                        {col.label}
                        {isSorted && <span className="ml-0.5 text-[9px]">{sortAsc ? '\u25B2' : '\u25BC'}</span>}
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); setOpenFilter(openFilter === col.colKey ? null : col.colKey); }}
                        className="transition hover:opacity-70"
                        style={{
                          color: isFiltered ? 'var(--accent)' : 'var(--text-muted)',
                          fontWeight: 700,
                          fontSize: '14px',
                          lineHeight: 1,
                          padding: '0 1px',
                        }}
                        title="Filter"
                      >
                        +
                      </button>
                    </div>
                    {openFilter === col.colKey && (
                      <CompFilterDropdown
                        columnKey={col.colKey}
                        allValues={uniqueFilterValues[col.colKey] || []}
                        selected={checkboxFilters[col.colKey]}
                        onUpdate={updateCheckboxFilter}
                        onClose={() => setOpenFilter(null)}
                      />
                    )}
                    {/* Resize handle */}
                    <div
                      onMouseDown={e => handleResizeStart(col.idx, e)}
                      style={{ position: 'absolute', top: 0, right: 0, width: 4, height: '100%', cursor: 'col-resize', zIndex: 1 }}
                      onMouseEnter={e => { (e.target as HTMLElement).style.background = 'var(--accent)'; }}
                      onMouseLeave={e => { (e.target as HTMLElement).style.background = ''; }}
                    />
                  </th>
                );
              })}
              <ThR idx={9} onResize={handleResizeStart}>ETA</ThR>
              {days.map((d, i) => (
                <ThR key={`d${i}`} idx={10 + i} onResize={handleResizeStart} border={d.dayOfWeek === 0}><span className="text-[10px]">{d.dayNum}</span></ThR>
              ))}
              {months.map((m, i) => <ThR key={m.key} idx={10 + days.length + i} onResize={handleResizeStart} border={i === 0}>{m.label}</ThR>)}
              <ThR idx={10 + days.length + months.length} onResize={handleResizeStart} border>Out</ThR>
            </tr>
          </thead>
          <tbody>
            {sorted.map(row => (
              <tr
                key={row.code}
                className="transition cursor-pointer"
                style={{
                  borderBottom: '0.5px solid var(--border)',
                  background: expandedRow === row.code ? 'var(--accent-light)' : undefined,
                }}
                onClick={() => {
                  setExpandedRow(expandedRow === row.code ? null : row.code);
                  onComponentClick(row.code);
                }}
                onMouseEnter={e => { if (expandedRow !== row.code) e.currentTarget.style.background = 'var(--bg-surface)'; }}
                onMouseLeave={e => { if (expandedRow !== row.code) e.currentTarget.style.background = ''; }}
              >
                {/* Status dot */}
                <td className="px-1.5 py-1 text-center">
                  <div className="w-2 h-2 rounded-full mx-auto" style={{ background: STATUS_DOT[row.status] }} />
                </td>
                {/* Code */}
                <td className="px-1.5 py-1 font-mono truncate" style={{ color: 'var(--text-primary)', fontWeight: 500 }}>
                  {row.code}
                  {row.draftCount > 0 && (
                    <span className="ml-1 px-1 rounded text-[10px]" style={{ background: 'var(--accent-light)', color: 'var(--accent)', fontWeight: 500 }}>
                      {row.draftCount} PO
                    </span>
                  )}
                </td>
                {/* Name + warehouse */}
                <td className="px-2 py-1 truncate" style={{ color: 'var(--text-secondary)', maxWidth: 160 }} title={`${row.name}\n${row.supplier}\nWarehouse: ${row.planningWarehouse || 'N/A'}${row.isWarehouseOverride ? ' (override)' : ''}\n${row.warehouseReason}`}>
                  <div className="truncate">{row.name}</div>
                  {row.planningWarehouse && (
                    <div className="truncate text-[9px]" style={{ color: row.isWarehouseOverride ? 'var(--accent)' : 'var(--text-muted)', lineHeight: 1.1 }}>
                      {row.planningWarehouse}
                    </div>
                  )}
                </td>
                {/* SOH (warehouse-scoped, with global in tooltip) */}
                <td className="px-1.5 py-1 text-right font-mono" style={{ color: 'var(--text-primary)', fontWeight: 500, borderLeft: '0.5px solid var(--border)' }} title={`Warehouse: ${Math.round(row.warehouseSOH)}\nGlobal: ${Math.round(row.globalSOH)}`}>
                  {Math.round(row.warehouseSOH)}
                  {row.globalSOH !== row.warehouseSOH && (
                    <span className="text-[9px] ml-0.5" style={{ color: 'var(--text-muted)', fontWeight: 400 }}>
                      /{Math.round(row.globalSOH)}
                    </span>
                  )}
                </td>
                {/* On Order */}
                <td className="px-1.5 py-1 text-right font-mono" style={{ color: row.onOrder > 0 ? 'var(--accent)' : 'var(--text-muted)' }}>
                  {row.onOrder > 0 ? `+${Math.round(row.onOrder)}` : '\u2014'}
                </td>
                {/* Monthly demand */}
                <td className="px-1.5 py-1 text-right font-mono" style={{ color: 'var(--text-secondary)' }}>
                  {row.monthlyDemand > 0 ? Math.round(row.monthlyDemand) : '\u2014'}
                </td>
                {/* Days */}
                <td className="px-1.5 py-1 text-right font-mono" style={{
                  color: daysColor(row.days),
                  fontWeight: row.days < 14 ? 500 : 400,
                  background: row.days !== Infinity && row.days < 14
                    ? 'rgba(185, 28, 28, 0.12)'
                    : row.days !== Infinity && row.days < 30 ? 'rgba(180, 83, 9, 0.08)' : undefined,
                }}>
                  {row.days === Infinity ? '\u221E' : Math.round(row.days)}
                </td>
                {/* SOH Adequacy Bar */}
                <td className="px-1.5 py-1" style={{ borderLeft: '0.5px solid var(--border)' }}>
                  <SOHBar pct={row.adequacyPct} soh={row.soh} allocated={row.allocated} />
                </td>
                {/* Next PO Qty */}
                <td className="px-1.5 py-1 text-right font-mono" style={{
                  color: row.nextPOQty ? 'var(--accent)' : 'var(--text-muted)',
                  fontWeight: row.nextPOQty ? 500 : 400,
                  borderLeft: '0.5px solid var(--border)',
                }}>
                  {row.nextPOQty ? Math.round(row.nextPOQty) : '\u2014'}
                </td>
                {/* Next PO ETA */}
                <td className="px-1 py-1 text-right font-mono" style={{
                  color: row.nextPODate ? 'var(--text-secondary)' : 'var(--text-muted)',
                  fontSize: '10px',
                }}>
                  {row.nextPODate ? row.nextPODate.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }) : '\u2014'}
                </td>
                {/* Daily consumption — colored heatmap cells with tooltips */}
                {row.dailyConsumption.map((dc, i) => {
                  const bal = row.dailyBalance[i];
                  const hasBatches = row.dailyBatches[i].length > 0;
                  const bg = bal > 0
                    ? (dc > 0 ? 'rgba(21, 128, 61, 0.45)' : 'rgba(21, 128, 61, 0.18)')
                    : (dc > 0 ? 'rgba(185, 28, 28, 0.50)' : 'rgba(185, 28, 28, 0.22)');
                  return (
                    <td
                      key={i}
                      style={{
                        background: bg,
                        borderLeft: days[i].dayOfWeek === 0 ? '0.5px solid var(--border)' : undefined,
                        cursor: hasBatches ? 'pointer' : undefined,
                      }}
                      title={formatDayTooltip(days[i].label, dc, bal, row.dailyBatches[i])}
                      onClick={hasBatches ? (e) => { e.stopPropagation(); handleDayCellClick(e, row, i); } : undefined}
                    />
                  );
                })}
                {/* Monthly projection */}
                {row.monthlyProjection.map((mp, i) => (
                  <td
                    key={i}
                    className="px-1.5 py-1 text-right font-mono"
                    style={{
                      color: balanceColor(mp.balance),
                      fontWeight: mp.balance <= 0 ? 500 : 400,
                      borderLeft: i === 0 ? '0.5px solid var(--border)' : undefined,
                      cursor: (mp.incoming > 0 || mp.demand > 0) ? 'pointer' : undefined,
                      background: mp.balance <= 0
                        ? 'rgba(185, 28, 28, 0.14)'
                        : mp.balance < 500 ? 'rgba(180, 83, 9, 0.09)' : (mp.incoming > 0 ? 'rgba(21, 128, 61, 0.12)' : undefined),
                    }}
                    onClick={(mp.incoming > 0 || mp.demand > 0) ? (e) => { e.stopPropagation(); handleMonthCellClick(e, row, i); } : undefined}
                  >
                    {Math.round(mp.balance)}
                  </td>
                ))}
                {/* Runout */}
                <td
                  className="px-1.5 py-1 text-center font-mono"
                  style={{
                    color: row.runoutIdx !== null ? 'var(--danger)' : 'var(--success)',
                    fontWeight: 500,
                    borderLeft: '0.5px solid var(--border)',
                    background: row.runoutIdx !== null ? 'rgba(185, 28, 28, 0.14)' : undefined,
                  }}
                >
                  {row.runoutIdx !== null ? months[row.runoutIdx].label : '\u2014'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Cell detail popover — ClampedPopover guarantees it stays in the
          viewport regardless of click position, handling right- and bottom-
          edge overflow automatically. */}
      {cellDetail && (
        <ClampedPopover
          top={cellDetail.rect.top}
          left={cellDetail.rect.left}
          className="rounded-lg shadow-lg overflow-hidden"
          style={{
            width: cellDetail.rect.width,
            background: 'var(--bg-page)',
            border: '0.5px solid var(--border)',
          }}
        >
          <div data-cell-detail>
          {/* Header */}
          <div className="px-3 py-2 flex items-center justify-between" style={{ borderBottom: '0.5px solid var(--border)', background: 'var(--bg-surface)' }}>
            <span className="text-xs" style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{cellDetail.label}</span>
            <button onClick={() => setCellDetail(null)} className="text-xs hover:opacity-60" style={{ color: 'var(--text-muted)' }}>✕</button>
          </div>
          <div className="px-3 py-2 space-y-2">
            {/* SOH summary */}
            <div className="flex justify-between text-[11px]" style={{ color: 'var(--text-muted)' }}>
              <span>Opening: <span style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{Math.round(cellDetail.openingSOH)}</span></span>
              <span>Closing: <span style={{ fontWeight: 500, color: cellDetail.closingSOH <= 0 ? 'var(--danger)' : 'var(--text-primary)' }}>{Math.round(cellDetail.closingSOH)}</span></span>
            </div>

            {/* Incoming */}
            {cellDetail.incoming.length > 0 && (
              <div>
                <p className="text-[10px] uppercase tracking-wide mb-1" style={{ fontWeight: 500, color: 'var(--success)' }}>Incoming</p>
                {cellDetail.incoming.map((item, i) => (
                  <div key={i} className="flex items-center justify-between text-xs py-0.5">
                    <span className="truncate" style={{ color: 'var(--text-secondary)' }}>
                      {item.poNumber && <span className="font-mono" style={{ color: 'var(--text-muted)' }}>{item.poNumber} </span>}
                      {item.source}
                    </span>
                    <span className="flex-shrink-0 font-mono" style={{ fontWeight: 500, color: 'var(--success)' }}>+{Math.round(item.qty)}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Outgoing */}
            {cellDetail.outgoing.length > 0 && (
              <div>
                <p className="text-[10px] uppercase tracking-wide mb-1" style={{ fontWeight: 500, color: 'var(--warning)' }}>Outgoing</p>
                {cellDetail.outgoing.map((item, i) => (
                  <div key={i} className="flex items-center justify-between text-xs py-0.5">
                    <span className="truncate" style={{ color: 'var(--text-secondary)' }}>{item.target}</span>
                    <span className="flex-shrink-0 font-mono" style={{ fontWeight: 500, color: 'var(--warning)' }}>-{Math.round(item.qty)}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Empty state */}
            {cellDetail.incoming.length === 0 && cellDetail.outgoing.length === 0 && (
              <p className="text-xs text-center py-1" style={{ color: 'var(--text-muted)' }}>No transactions</p>
            )}
          </div>
          </div>
        </ClampedPopover>
      )}
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────

const sectionHead: React.CSSProperties = {
  background: 'var(--bg-surface)',
  color: 'var(--text-primary)',
  fontWeight: 600,
  fontSize: '11px',
  letterSpacing: '0.05em',
  textTransform: 'uppercase' as const,
  borderBottom: '0.5px solid var(--border)',
};

/** Resizable column header (non-filterable) */
function ThR({ children, align, border, idx, onResize }: {
  children?: React.ReactNode;
  align?: 'left' | 'right' | 'center';
  border?: boolean;
  idx: number;
  onResize: (idx: number, e: React.MouseEvent) => void;
}) {
  return (
    <th
      className="px-1.5 py-1.5 select-none"
      style={{
        position: 'relative',
        textAlign: align || 'right',
        fontWeight: 600,
        fontSize: '11px',
        color: 'var(--text-secondary)',
        background: 'var(--bg-page)',
        borderBottom: '0.5px solid var(--border)',
        borderLeft: border ? '0.5px solid var(--border)' : undefined,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
      }}
    >
      {children}
      {/* Resize handle */}
      <div
        onMouseDown={e => onResize(idx, e)}
        style={{
          position: 'absolute',
          top: 0,
          right: 0,
          width: 4,
          height: '100%',
          cursor: 'col-resize',
          zIndex: 1,
        }}
        onMouseEnter={e => { (e.target as HTMLElement).style.background = 'var(--accent)'; }}
        onMouseLeave={e => { (e.target as HTMLElement).style.background = ''; }}
      />
    </th>
  );
}

/** Green sliding bar showing SOH adequacy vs planned consumption */
function SOHBar({ pct, soh, allocated }: { pct: number; soh: number; allocated: number }) {
  const fillPct = Math.min(100, Math.max(0, pct));
  const barColor = pct >= 100 ? 'var(--success)' : pct >= 50 ? 'var(--warning)' : 'var(--danger)';
  const trackColor = allocated > 0
    ? (pct < 50 ? 'rgba(185, 28, 28, 0.18)' : pct < 100 ? 'rgba(180, 83, 9, 0.15)' : 'rgba(21, 128, 61, 0.10)')
    : 'var(--bg-surface)';
  const shortfall = allocated > 0 ? Math.max(0, allocated - soh) : 0;

  return (
    <div title={`SOH: ${Math.round(soh)} / Planned: ${Math.round(allocated)}${shortfall > 0 ? ` (${Math.round(shortfall)} short)` : ''}`}>
      <div className="flex items-center gap-1.5">
        <div
          className="flex-1 rounded-sm overflow-hidden"
          style={{ height: 14, background: trackColor, border: '0.5px solid var(--border)' }}
        >
          <div
            className="h-full rounded-sm transition-all duration-300"
            style={{ width: `${fillPct}%`, background: barColor, opacity: 0.9 }}
          />
        </div>
        <span className="font-mono text-[10px] w-8 text-right flex-shrink-0" style={{ color: barColor, fontWeight: 500 }}>
          {allocated > 0 ? `${Math.round(pct)}%` : '\u2014'}
        </span>
      </div>
    </div>
  );
}
