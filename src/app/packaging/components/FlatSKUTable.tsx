'use client';

import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import type { PackagingSKU } from '../hooks/usePackagingData';
import { CellNavigationProvider, useCellNavigation } from '../context/CellNavigationContext';
import { dateToDayInt, formatDayInt, dayIntToDate } from '@/lib/planning/working-day';
import { EditableCell } from './SKURow';

/** Registers the flat table's row count with the cell navigation context */
function FlatFamilyRegistrar({ rowCount }: { rowCount: number }) {
  const { registerFamily, unregisterFamily } = useCellNavigation();
  useEffect(() => {
    registerFamily('__flat__', rowCount);
    return () => unregisterFamily('__flat__');
  }, [rowCount, registerFamily, unregisterFamily]);
  return null;
}

// ─── Column key type ────────────────────────────────────────────

type SortKey =
  | 'sku' | 'product' | 'size' | 'days' | 'usage' | 'fgSOH' | 'avail'
  | 'existing' | 'exDay' | 'suggest' | 'qty' | 'day'
  | 'canMake' | 'labels' | 'family';

type SortDir = 'asc' | 'desc';

const DEFAULT_ORDER: SortKey[] = [
  'sku', 'product', 'size', 'days', 'usage', 'fgSOH', 'avail',
  'existing', 'exDay', 'suggest', 'qty', 'day',
  'canMake', 'labels', 'family',
];

const DEFAULT_WIDTHS: Record<SortKey, number> = {
  sku: 11, product: 11, size: 4, days: 5, usage: 6, fgSOH: 5, avail: 5,
  existing: 7, exDay: 7, suggest: 7, qty: 7, day: 7,
  canMake: 6, labels: 5, family: 8,
};

// ─── Column definitions ─────────────────────────────────────────

interface ColDef {
  key: SortKey;
  header: string;
  align: 'left' | 'center' | 'right';
  bgTint: boolean;    // tinted background for grouped columns
  borderLeft: boolean; // left border (first of a group)
}

const COL_DEFS: Record<SortKey, ColDef> = {
  sku:      { key: 'sku',      header: 'SKU',      align: 'left',   bgTint: false, borderLeft: false },
  product:  { key: 'product',  header: 'Product',  align: 'left',   bgTint: false, borderLeft: false },
  size:     { key: 'size',     header: 'Size',     align: 'center', bgTint: false, borderLeft: false },
  days:     { key: 'days',     header: 'Days',     align: 'right',  bgTint: false, borderLeft: false },
  usage:    { key: 'usage',    header: 'Demand', align: 'right',  bgTint: false, borderLeft: false },
  fgSOH:    { key: 'fgSOH',    header: 'SOH',   align: 'right',  bgTint: false, borderLeft: false },
  avail:    { key: 'avail',    header: 'Avail',   align: 'right',  bgTint: false, borderLeft: false },
  existing: { key: 'existing', header: 'Existing', align: 'right',  bgTint: true,  borderLeft: true },
  exDay:    { key: 'exDay',    header: 'Ex. Day',  align: 'right',  bgTint: true,  borderLeft: false },
  suggest:  { key: 'suggest',  header: 'Suggest',  align: 'right',  bgTint: false, borderLeft: false },
  qty:      { key: 'qty',      header: 'Qty',      align: 'right',  bgTint: true,  borderLeft: true },
  day:      { key: 'day',      header: 'Day',      align: 'right',  bgTint: true,  borderLeft: false },
  canMake:  { key: 'canMake',  header: 'Limit',    align: 'right',  bgTint: false, borderLeft: false },
  labels:   { key: 'labels',   header: 'Labels',   align: 'right',  bgTint: false, borderLeft: false },
  family:   { key: 'family',   header: 'Family',   align: 'right',  bgTint: false, borderLeft: false },
};

// ─── Sort / filter helpers ──────────────────────────────────────

function getSortValue(
  sku: PackagingSKU, key: SortKey,
  getPlanned: (code: string) => { quantity: number; dayInt: number } | null,
): string | number {
  switch (key) {
    case 'sku': return sku.productCode;
    case 'product': return sku.productName;
    case 'size': return sku.sizeVariant || '';
    case 'days': return sku.daysAvailable === Infinity ? 999999 : sku.daysAvailable;
    case 'usage': return sku.monthlyUsage ?? 0;
    case 'fgSOH': return sku.fgSOH;
    case 'avail': return sku.availableStock;
    case 'existing': return sku.existingAssemblyQty ?? 0;
    case 'exDay': return sku.existingAssemblyDate || '';
    case 'suggest': return sku.suggestedQty;
    case 'qty': return getPlanned(sku.productCode)?.quantity ?? 0;
    case 'day': return getPlanned(sku.productCode)?.dayInt ?? 0;
    case 'canMake': return sku.canAssemble;
    case 'labels': return sku.labelsOnHand;
    case 'family': return sku.familyName;
  }
}

/** Format a Date as DD/MM/YYYY (local time) — the format operators here expect. */
function formatDMY(d: Date): string {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

/**
 * Parse a DD/MM/YYYY display string into a sortable integer (YYYYMMDD). Used
 * by the filter dropdown so dates sort chronologically rather than by the
 * alphabetic order of the display string (where "05/04/2026" < "21/03/2026"
 * which is wrong). Returns NaN for values that aren't DD/MM/YYYY so callers
 * can fall back to string compare.
 */
function parseDMYToSortKey(s: string): number {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
  if (!m) return NaN;
  return Number(m[3]) * 10000 + Number(m[2]) * 100 + Number(m[1]);
}

function getFilterDisplayValue(
  sku: PackagingSKU, key: SortKey,
  getPlanned: (code: string) => { quantity: number; dayInt: number } | null,
): string {
  const raw = getSortValue(sku, key, getPlanned);
  if (key === 'days') {
    if (sku.daysAvailable === Infinity) return '(no usage)';
    const d = Math.round(sku.daysAvailable);
    if (d <= 0) return '0d (out)';
    if (d < 7) return '<7d';
    if (d < 14) return '7-13d';
    if (d < 30) return '14-29d';
    if (d < 60) return '30-59d';
    return '60d+';
  }
  // Date-valued columns — render DD/MM/YYYY so the filter dropdown shows
  // human-friendly dates instead of ISO strings (exDay) or raw working-day
  // integers (day).
  if (key === 'exDay') {
    if (!sku.existingAssemblyDate) return '(none)';
    const d = new Date(sku.existingAssemblyDate);
    if (isNaN(d.getTime())) return '(invalid)';
    return formatDMY(d);
  }
  if (key === 'day') {
    const planned = getPlanned(sku.productCode);
    if (!planned || planned.dayInt <= 0) return '(unplanned)';
    return formatDMY(dayIntToDate(planned.dayInt));
  }
  if (typeof raw === 'number') return raw === 0 ? '0' : String(raw);
  return String(raw) || '(empty)';
}

type ColumnFilters = Partial<Record<SortKey, Set<string>>>;

// ─── Layout persistence ─────────────────────────────────────────

const LAYOUT_KEY = 'byron-pp-column-layout';

interface ColumnLayout {
  order: SortKey[];
  widths: Record<SortKey, number>;
}

function loadLayout(): ColumnLayout {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ColumnLayout>;
      // Validate: ensure all keys present
      const order = parsed.order?.filter(k => k in COL_DEFS) ?? DEFAULT_ORDER;
      // Add any missing columns at end
      for (const k of DEFAULT_ORDER) {
        if (!order.includes(k)) order.push(k);
      }
      const widths = { ...DEFAULT_WIDTHS, ...(parsed.widths || {}) };
      return { order, widths };
    }
  } catch { /* ignore */ }
  return { order: [...DEFAULT_ORDER], widths: { ...DEFAULT_WIDTHS } };
}

function saveLayout(layout: ColumnLayout) {
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch { /* ignore */ }
}

// ─── Colour helpers ─────────────────────────────────────────────

function daysColor(days: number): string {
  if (days <= 0) return 'var(--danger)';
  if (days < 7) return 'var(--danger)';
  if (days < 14) return 'var(--warning)';
  if (days < 30) return 'var(--text-primary)';
  return 'var(--text-muted)';
}

// ─── Cell context for dynamic rendering ─────────────────────────

interface CellCtx {
  sku: PackagingSKU;
  plannedQty: number;
  plannedDay: number;
  existingQtyEdit: number | null;
  existingDayEdit: number | null;
  existingOrigDayInt: number;
  labelWarning: boolean;
  familyCode: string;
  rowIndex: number;
  onSetQty: (code: string, qty: number) => void;
  onSetDay: (code: string, d: number) => void;
  onSetExistingQty: (code: string, qty: number) => void;
  onSetExistingDay: (code: string, d: number) => void;
  onFillSuggestion: (code: string) => void;
  onOpenModal?: (code: string) => void;
}

function renderCell(key: SortKey, ctx: CellCtx): React.ReactNode {
  const { sku, plannedQty, plannedDay, existingQtyEdit, existingDayEdit, existingOrigDayInt, labelWarning, familyCode, rowIndex, onOpenModal } = ctx;
  switch (key) {
    case 'sku':
      // Make the SKU code a click target for the BOM modal when the callback
      // is provided. Falls back to a plain span so tests and legacy usage
      // without the modal still render the same.
      if (onOpenModal) {
        return (
          <button
            type="button"
            onClick={() => onOpenModal(sku.productCode)}
            className="font-mono truncate transition hover:opacity-80"
            title={`${sku.productCode} — click to view BOM & drafts`}
            style={{
              color: 'var(--accent)',
              textDecoration: 'underline',
              textDecorationStyle: 'dotted',
              textUnderlineOffset: 2,
              background: 'transparent',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
            }}
          >
            {sku.productCode}
          </button>
        );
      }
      return <span className="font-mono truncate" title={sku.productCode}>{sku.productCode}</span>;
    case 'product': {
      const shortName = sku.productName.replace(/\s*Organic & Activated\s*/g, ' ').replace(/\s*Organic &\s*/g, ' ').replace(/\s*Activated\s*/g, ' ').replace(/\s+/g, ' ').trim();
      return <span className="truncate" style={{ color: 'var(--text-secondary)' }} title={sku.productName}>{shortName}</span>;
    }
    case 'size':
      return (
        <span className="inline-block px-1.5 py-0.5 rounded text-xs" style={{ fontWeight: 500, color: 'var(--text-secondary)', background: 'var(--bg-surface)' }}>
          {sku.sizeVariant || '\u2014'}
        </span>
      );
    case 'days':
      return (
        <span className="font-mono" style={{ color: daysColor(sku.daysAvailable), fontWeight: sku.daysAvailable < 14 ? 500 : 400 }}>
          {sku.daysAvailable === Infinity ? '\u221e' : Math.round(sku.daysAvailable)}
        </span>
      );
    case 'usage':
      return (
        <span className="font-mono" style={{ color: 'var(--text-secondary)' }}>
          {sku.monthlyUsage != null && sku.monthlyUsage > 0 ? sku.monthlyUsage.toLocaleString() : '\u2014'}
        </span>
      );
    case 'fgSOH':
      return <span className="font-mono">{sku.fgSOH}</span>;
    case 'avail':
      return (
        <span className="font-mono" style={{ color: sku.availableStock !== sku.fgSOH ? 'var(--accent)' : 'var(--text-muted)' }}>
          {sku.availableStock}
        </span>
      );
    case 'existing':
      return sku.existingAssemblyQty ? (
        <EditableCell
          value={existingQtyEdit ?? sku.existingAssemblyQty}
          onCommit={(v) => ctx.onSetExistingQty(sku.productCode, Math.round(v))}
          placeholder="\u2014"
          coord={{ familyCode, rowIndex, colIndex: 0 }}
        />
      ) : <span style={{ color: 'var(--text-muted)' }}>{'\u2014'}</span>;
    case 'exDay':
      return sku.existingAssemblyQty ? (
        <EditableCell
          value={(existingDayEdit ?? existingOrigDayInt) || null}
          onCommit={(v) => ctx.onSetExistingDay(sku.productCode, Math.round(v))}
          placeholder="-"
          tooltip={(existingDayEdit ?? existingOrigDayInt) > 0 ? formatDayInt(existingDayEdit ?? existingOrigDayInt) : 'Working day (1-5 = this week)'}
          coord={{ familyCode, rowIndex, colIndex: 1 }}
        />
      ) : <span style={{ color: 'var(--text-muted)' }}>{'\u2014'}</span>;
    case 'suggest':
      return sku.suggestedQty > 0 ? (
        <button onClick={() => ctx.onFillSuggestion(sku.productCode)} className="font-mono transition hover:opacity-70" style={{ color: 'var(--accent)', fontWeight: 500 }} title="Click to fill">
          {sku.suggestedQty}
        </button>
      ) : <span className="font-mono" style={{ color: 'var(--text-muted)' }}>{'\u2014'}</span>;
    case 'qty':
      return (
        <EditableCell
          value={plannedQty || null}
          onCommit={(v) => ctx.onSetQty(sku.productCode, Math.round(v))}
          placeholder="-"
          coord={{ familyCode, rowIndex, colIndex: 2 }}
        />
      );
    case 'day':
      return (
        <EditableCell
          value={plannedDay || null}
          onCommit={(v) => ctx.onSetDay(sku.productCode, Math.round(v))}
          placeholder="-"
          tooltip={plannedDay > 0 ? formatDayInt(plannedDay) : 'Working day (1-5 = this week)'}
          coord={{ familyCode, rowIndex, colIndex: 3 }}
        />
      );
    case 'canMake':
      return (
        <span className="font-mono" style={{ color: sku.canAssemble > 0 ? 'var(--text-secondary)' : 'var(--text-muted)' }}>
          {Math.floor(sku.canAssemble).toLocaleString()}
        </span>
      );
    case 'labels':
      return (
        <span className="font-mono" style={{ color: labelWarning ? 'var(--danger)' : 'var(--text-muted)', fontWeight: labelWarning ? 500 : 400 }}>
          {sku.labelsOnHand}{labelWarning && <span className="ml-1">!</span>}
        </span>
      );
    case 'family':
      return <span className="font-mono truncate" style={{ color: 'var(--text-muted)' }} title={sku.familyName}>{sku.familyCode}</span>;
  }
}

/** Extra td styles per column — conditional formatting */
function cellStyle(key: SortKey, ctx: { existingQtyEdit: number | null; sku: PackagingSKU; plannedQty: number }): React.CSSProperties {
  const { sku, plannedQty } = ctx;
  switch (key) {
    case 'existing':
      return {
        color: ctx.existingQtyEdit != null && ctx.existingQtyEdit !== sku.existingAssemblyQty ? 'var(--warning)' : 'var(--accent)',
        fontWeight: 500,
      };
    case 'days': {
      const d = sku.daysAvailable;
      if (d === Infinity) return { background: 'rgba(21, 128, 61, 0.06)' };
      if (d <= 0) return { background: 'rgba(185, 28, 28, 0.22)' };
      if (d < 7) return { background: 'rgba(185, 28, 28, 0.14)' };
      if (d < 14) return { background: 'rgba(180, 83, 9, 0.12)' };
      if (d < 30) return { background: 'rgba(180, 83, 9, 0.05)' };
      if (d >= 60) return { background: 'rgba(21, 128, 61, 0.06)' };
      return {};
    }
    case 'usage': {
      const u = sku.monthlyUsage ?? 0;
      if (u <= 0) return {};
      if (u < 100) return { background: 'rgba(37, 99, 235, 0.04)' };
      if (u < 500) return { background: 'rgba(37, 99, 235, 0.08)' };
      if (u < 1000) return { background: 'rgba(37, 99, 235, 0.13)' };
      return { background: 'rgba(37, 99, 235, 0.18)' };
    }
    case 'fgSOH': {
      const d = sku.daysAvailable;
      if (d === Infinity) return {};
      if (d <= 0) return { background: 'rgba(185, 28, 28, 0.12)' };
      if (d < 7) return { background: 'rgba(185, 28, 28, 0.08)' };
      if (d < 14) return { background: 'rgba(180, 83, 9, 0.06)' };
      return {};
    }
    case 'canMake': {
      if (sku.canAssemble <= 0 && (sku.monthlyUsage ?? 0) > 0) return { background: 'rgba(185, 28, 28, 0.10)' };
      if (plannedQty > 0 && sku.canAssemble > 0 && sku.canAssemble < plannedQty) return { background: 'rgba(180, 83, 9, 0.10)' };
      return {};
    }
    default:
      return {};
  }
}

// ─── Filter dropdown ────────────────────────────────────────────

function FilterDropdown({
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
    <div ref={ref} className="absolute top-full mt-1 rounded shadow-lg z-50" style={{ background: 'var(--bg-page)', border: '0.5px solid var(--border)', minWidth: 200, maxWidth: 280, right: 0 }} onClick={e => e.stopPropagation()}>
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

// ─── Main table ─────────────────────────────────────────────────

interface FlatSKUTableProps {
  skus: PackagingSKU[];
  getPlanned: (productCode: string) => { quantity: number; dayInt: number } | null;
  onSetQty: (productCode: string, qty: number) => void;
  onSetDay: (productCode: string, dayInt: number) => void;
  onSetExistingQty: (productCode: string, qty: number) => void;
  onSetExistingDay: (productCode: string, dayInt: number) => void;
  getExistingQty: (productCode: string) => number | null;
  getExistingDay: (productCode: string) => number | null;
  onFillSuggestion: (productCode: string) => void;
  onSetUsage: (productCode: string, usage: number) => void;
  /** Opens the shared BOM investigation modal for the clicked SKU. */
  onOpenModal?: (productCode: string) => void;
}

export function FlatSKUTable({
  skus, getPlanned,
  onSetQty, onSetDay, onSetExistingQty, onSetExistingDay,
  getExistingQty, getExistingDay, onFillSuggestion, onSetUsage,
  onOpenModal,
}: FlatSKUTableProps) {
  // ── Layout state (order + widths) ──
  // Phase 4l.14 — initialise with the DEFAULT layout so the server-rendered
  // HTML and the client's first render agree; reading localStorage in the
  // useState initializer caused a hydration mismatch (column order / widths
  // differed between server default and client-persisted). The persisted
  // layout is restored in the effect below, after mount.
  const [layout, setLayout] = useState<ColumnLayout>(() => ({
    order: [...DEFAULT_ORDER],
    widths: { ...DEFAULT_WIDTHS },
  }));
  useEffect(() => {
    setLayout(loadLayout());
  }, []);
  const { order: columnOrder, widths: columnWidths } = layout;

  const updateLayout = useCallback((next: ColumnLayout) => {
    setLayout(next);
    saveLayout(next);
  }, []);

  const resetLayout = useCallback(() => {
    const reset = { order: [...DEFAULT_ORDER], widths: { ...DEFAULT_WIDTHS } };
    setLayout(reset);
    saveLayout(reset);
  }, []);

  // ── Sort / filter state ──
  const [sortKey, setSortKey] = useState<SortKey>('days');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [columnFilters, setColumnFilters] = useState<ColumnFilters>({});
  const [openFilter, setOpenFilter] = useState<SortKey | null>(null);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(p => p === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('asc'); }
  };

  const updateFilter = useCallback((key: SortKey, sel: Set<string> | undefined) => {
    setColumnFilters(prev => { const n = { ...prev }; sel === undefined ? delete n[key] : n[key] = sel; return n; });
  }, []);

  // ── Column drag reorder ──
  const [dragCol, setDragCol] = useState<SortKey | null>(null);
  const [dragOverCol, setDragOverCol] = useState<SortKey | null>(null);

  const onDragStart = useCallback((e: React.DragEvent, key: SortKey) => {
    setDragCol(key);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', key);
  }, []);

  const onDragOver = useCallback((e: React.DragEvent, key: SortKey) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverCol(key);
  }, []);

  const onDrop = useCallback((e: React.DragEvent, targetKey: SortKey) => {
    e.preventDefault();
    const sourceKey = e.dataTransfer.getData('text/plain') as SortKey;
    if (sourceKey && sourceKey !== targetKey) {
      setLayout(prev => {
        const next = [...prev.order];
        const fromIdx = next.indexOf(sourceKey);
        const toIdx = next.indexOf(targetKey);
        if (fromIdx < 0 || toIdx < 0) return prev;
        next.splice(fromIdx, 1);
        next.splice(toIdx, 0, sourceKey);
        const updated = { ...prev, order: next };
        saveLayout(updated);
        return updated;
      });
    }
    setDragCol(null);
    setDragOverCol(null);
  }, []);

  const onDragEnd = useCallback(() => {
    setDragCol(null);
    setDragOverCol(null);
  }, []);

  // ── Column resize ──
  const tableRef = useRef<HTMLTableElement>(null);
  const resizeRef = useRef<{ key: SortKey; startX: number; startWidth: number } | null>(null);

  const onResizeStart = useCallback((e: React.MouseEvent, key: SortKey) => {
    e.preventDefault();
    e.stopPropagation();
    resizeRef.current = { key, startX: e.clientX, startWidth: columnWidths[key] };

    const onMove = (me: MouseEvent) => {
      // Snapshot the ref into locals BEFORE calling setLayout. React can defer
      // the updater callback, and if `onUp` fires before it runs, the ref
      // will be null — we used to crash reading `resizeRef.current!.key`
      // inside the updater. Locals are stable for the lifetime of this event.
      const current = resizeRef.current;
      if (!current || !tableRef.current) return;
      const tableW = tableRef.current.offsetWidth;
      const deltaPx = me.clientX - current.startX;
      const deltaPct = (deltaPx / tableW) * 100;
      const newWidth = Math.max(2, current.startWidth + deltaPct);
      const resizingKey = current.key;
      setLayout(prev => {
        const updated = { ...prev, widths: { ...prev.widths, [resizingKey]: newWidth } };
        saveLayout(updated);
        return updated;
      });
    };
    const onUp = () => {
      resizeRef.current = null;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [columnWidths]);

  // ── Filter values ──
  const filterValues = useMemo(() => {
    const map: Partial<Record<SortKey, Map<string, number>>> = {};
    for (const key of DEFAULT_ORDER) {
      const counts = new Map<string, number>();
      for (const sku of skus) {
        const d = getFilterDisplayValue(sku, key, getPlanned);
        counts.set(d, (counts.get(d) || 0) + 1);
      }
      map[key] = counts;
    }
    return map;
  }, [skus, getPlanned]);

  // ── Filter + sort ──
  const filteredAndSorted = useMemo(() => {
    let result = skus;
    const active = Object.entries(columnFilters) as [SortKey, Set<string>][];
    if (active.length > 0) {
      result = result.filter(sku => active.every(([k, allowed]) => allowed.has(getFilterDisplayValue(sku, k, getPlanned))));
    }
    const arr = [...result];
    arr.sort((a, b) => {
      const va = getSortValue(a, sortKey, getPlanned);
      const vb = getSortValue(b, sortKey, getPlanned);
      const cmp = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb));
      return sortDir === 'desc' ? -cmp : cmp;
    });
    return arr;
  }, [skus, sortKey, sortDir, getPlanned, columnFilters]);

  const activeFilterCount = Object.keys(columnFilters).length;

  return (
    <CellNavigationProvider familyOrder={['__flat__']}>
      <FlatFamilyRegistrar rowCount={filteredAndSorted.length} />
      {/* Scroll on a single container so `position: sticky` on <th> anchors
          to the same axis the user is scrolling. The previous structure had
          overflow-y on the outer div and overflow-x on the inner div, which
          meant vertical scrolling was captured outside the sticky scope and
          the header scrolled away with the body. */}
      <div className="flex-1 overflow-auto px-6 py-3">
        <div style={{ border: '0.5px solid var(--border)', borderRadius: 6 }}>
          <table ref={tableRef} style={{ tableLayout: 'fixed', minWidth: 1400, width: '100%' }}>
            <colgroup>
              {columnOrder.map(key => (
                <col key={key} style={{ width: `${columnWidths[key]}%` }} />
              ))}
            </colgroup>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-surface)' }}>
                {columnOrder.map(key => {
                  const def = COL_DEFS[key];
                  const isSortActive = sortKey === key;
                  const hasFilter = columnFilters[key] !== undefined;
                  const isDragOver = dragOverCol === key && dragCol !== key;

                  return (
                    <th
                      key={key}
                      draggable
                      onDragStart={e => onDragStart(e, key)}
                      onDragOver={e => onDragOver(e, key)}
                      onDrop={e => onDrop(e, key)}
                      onDragEnd={onDragEnd}
                      className={`px-2 py-1.5 text-[11px] uppercase tracking-wider select-none relative whitespace-nowrap ${
                        def.align === 'left' ? 'text-left' : def.align === 'center' ? 'text-center' : 'text-right'
                      }`}
                      style={{
                        fontWeight: 500,
                        color: (isSortActive || hasFilter) ? 'var(--accent)' : 'var(--text-muted)',
                        position: 'sticky',
                        top: 0,
                        background: def.bgTint ? 'var(--bg-page)' : 'var(--bg-surface)',
                        zIndex: openFilter === key ? 50 : 2,
                        cursor: 'grab',
                        ...(def.borderLeft ? { borderLeft: '2px solid var(--border)' } : {}),
                        ...(isDragOver ? { boxShadow: 'inset 2px 0 0 var(--accent)' } : {}),
                        ...(dragCol === key ? { opacity: 0.4 } : {}),
                      }}
                    >
                      {/* Sort label */}
                      <span
                        onClick={(e) => { e.stopPropagation(); toggleSort(key); }}
                        className="cursor-pointer transition hover:opacity-70 overflow-hidden text-ellipsis"
                        title={`Sort by ${def.header}`}
                      >
                        {def.header}
                        {isSortActive && <span className="ml-0.5 text-[11px]">{sortDir === 'asc' ? '\u25B2' : '\u25BC'}</span>}
                      </span>
                      {/* Filter button */}
                      <button
                        onClick={(e) => { e.stopPropagation(); setOpenFilter(p => p === key ? null : key); }}
                        className="ml-1 inline-flex items-center justify-center transition hover:opacity-70"
                        style={{ color: hasFilter ? 'var(--accent)' : 'var(--text-muted)', opacity: hasFilter ? 1 : 0.5, fontSize: 16, fontWeight: 700, lineHeight: 1, width: 18, height: 18 }}
                        title={hasFilter ? 'Filtered \u2014 click to edit' : `Filter by ${def.header}`}
                      >+</button>
                      {/* Filter dropdown */}
                      {openFilter === key && (
                        <FilterDropdown
                          columnKey={key}
                          allValues={[...(filterValues[key] || new Map()).entries()].map(([d, c]) => ({ display: d, count: c })).sort((a, b) => {
                            // Date-valued columns (exDay/day) emit DD/MM/YYYY —
                            // sort chronologically rather than by ASCII order.
                            const da = parseDMYToSortKey(a.display);
                            const db = parseDMYToSortKey(b.display);
                            if (!isNaN(da) && !isNaN(db)) return da - db;
                            // Numeric values (e.g. quantities) — natural numeric order.
                            const na = Number(a.display), nb = Number(b.display);
                            if (!isNaN(na) && !isNaN(nb)) return na - nb;
                            return a.display.localeCompare(b.display);
                          })}
                          selected={columnFilters[key]}
                          onUpdate={updateFilter}
                          onClose={() => setOpenFilter(null)}
                        />
                      )}
                      {/* Resize handle */}
                      <div
                        onMouseDown={e => onResizeStart(e, key)}
                        style={{ position: 'absolute', top: 0, right: 0, bottom: 0, width: 4, cursor: 'col-resize', zIndex: 3 }}
                        onClick={e => e.stopPropagation()}
                      />
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {filteredAndSorted.map((sku, idx) => (
                <FlatRow
                  key={sku.productCode}
                  sku={sku}
                  columnOrder={columnOrder}
                  planned={getPlanned(sku.productCode)}
                  existingQtyEdit={getExistingQty(sku.productCode)}
                  existingDayEdit={getExistingDay(sku.productCode)}
                  onSetQty={onSetQty}
                  onSetDay={onSetDay}
                  onSetExistingQty={onSetExistingQty}
                  onSetExistingDay={onSetExistingDay}
                  onFillSuggestion={onFillSuggestion}
                  onOpenModal={onOpenModal}
                  rowIndex={idx}
                />
              ))}
            </tbody>
          </table>
        </div>
        {/* Footer */}
        <div className="px-4 py-2 text-sm flex items-center gap-3" style={{ color: 'var(--text-muted)' }}>
          <span>
            {filteredAndSorted.length === skus.length ? `${skus.length} SKUs` : `${filteredAndSorted.length} of ${skus.length} SKUs`}
          </span>
          {activeFilterCount > 0 && (
            <button onClick={() => setColumnFilters({})} className="text-sm px-2 py-0.5 rounded transition hover:opacity-70" style={{ color: 'var(--accent)', background: 'var(--accent-light)', border: '0.5px solid var(--accent)', fontWeight: 500 }}>
              Clear {activeFilterCount} filter{activeFilterCount > 1 ? 's' : ''}
            </button>
          )}
          <button onClick={resetLayout} className="text-sm px-2 py-0.5 rounded transition hover:opacity-70" style={{ color: 'var(--text-muted)', border: '0.5px solid var(--border)' }}>
            Reset columns
          </button>
        </div>
      </div>
    </CellNavigationProvider>
  );
}

// ─── Dynamic flat row ───────────────────────────────────────────

function FlatRow({
  sku, columnOrder, planned, existingQtyEdit, existingDayEdit,
  onSetQty, onSetDay, onSetExistingQty, onSetExistingDay, onFillSuggestion, onOpenModal, rowIndex,
}: {
  sku: PackagingSKU;
  columnOrder: SortKey[];
  planned: { quantity: number; dayInt: number } | null;
  existingQtyEdit: number | null;
  existingDayEdit: number | null;
  onSetQty: (code: string, qty: number) => void;
  onSetDay: (code: string, d: number) => void;
  onSetExistingQty: (code: string, qty: number) => void;
  onSetExistingDay: (code: string, d: number) => void;
  onFillSuggestion: (code: string) => void;
  onOpenModal?: (code: string) => void;
  rowIndex: number;
}) {
  const plannedQty = planned?.quantity ?? 0;
  const plannedDay = planned?.dayInt ?? 0;
  const existingOrigDayInt = sku.existingAssemblyDate ? dateToDayInt(new Date(sku.existingAssemblyDate), undefined, { weekend: 'up' }) : 0;
  const labelWarning = plannedQty > 0 && sku.labelsOnHand < plannedQty;
  const familyCode = '__flat__';

  const ctx: CellCtx = {
    sku, plannedQty, plannedDay, existingQtyEdit, existingDayEdit, existingOrigDayInt,
    labelWarning, familyCode, rowIndex, onSetQty, onSetDay, onSetExistingQty, onSetExistingDay, onFillSuggestion, onOpenModal,
  };

  return (
    <tr
      className="transition text-sm"
      style={{ borderBottom: '0.5px solid var(--border)' }}
      onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-surface)'; }}
      onMouseLeave={e => { e.currentTarget.style.background = ''; }}
    >
      {columnOrder.map(key => {
        const def = COL_DEFS[key];
        return (
          <td
            key={key}
            className={`px-2 py-1.5 ${
              def.align === 'left' ? 'text-left' : def.align === 'center' ? 'text-center' : 'text-right'
            }`}
            style={{
              color: 'var(--text-primary)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              ...(def.bgTint ? { background: 'var(--bg-surface)' } : {}),
              ...(def.borderLeft ? { borderLeft: '2px solid var(--border)' } : {}),
              ...cellStyle(key, ctx),
            }}
          >
            {renderCell(key, ctx)}
          </td>
        );
      })}
    </tr>
  );
}
