'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import type { StockOnHandItem, Assembly, PurchaseOrder } from '@/lib/unleashed/types';
import type { KitchenBatch } from '@/lib/planning/engine-io';
import type { DraftTransfer, TransferGap } from '@/lib/planning/transfer-types';
import { loadDraftTransfers, saveDraftTransfers } from '@/lib/planning/transfer-store';
import { WarehouseSOH } from '@/lib/planning/warehouse-soh';
import { WAREHOUSES } from '@/lib/planning/warehouse-assignments';
import {
  demandsFromKitchenAssemblies,
  consumptionScheduleFromDemands,
} from '@/lib/planning/demand';
import {
  detectTransferGaps,
  extractKitchenDemandsFromSchedule,
  extractPackagingDemands,
} from '@/lib/engine/transfer-detection';
import { INTERMEDIATE_REGISTRY } from '../kitchen/data/intermediate-registry';

// ─── Constants ─────────────────────────────────────────────

/** Default internal transfer lead time in working days */
const DEFAULT_LEAD_TIME_DAYS = 1;

/** Warehouse short names for compact display */
const WH_SHORT: Record<string, string> = {
  'Lundberg Storeroom': 'Lundberg',
  'MF Packaging': 'MF Pkg',
  'MF Operations': 'MF Ops',
  'TBC': 'TBC',
  'TBC Height': 'TBC Hgt',
};

function whShort(name: string): string {
  return WH_SHORT[name] || name;
}

function formatDate(d: Date): string {
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
}

function formatDateFull(d: Date): string {
  return d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
}

function getWeekLabel(d: Date): string {
  const mon = new Date(d);
  mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7));
  return `Wk ${mon.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}`;
}

function generateId(): string {
  return `txfr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Parse the demand source out of a transfer's reason/linked batch.
 * Transfers are created from three places:
 *   - Gaps auto/plan — reason: "Kitchen: <batch name>" or "Packaging: <run name>"
 *   - Kitchen component modal — reason: "Kitchen batch requirement"
 *   - Manual/other — free-form reason text
 */
function parseDemandSource(transfer: DraftTransfer): {
  type: 'kitchen' | 'packaging' | 'other';
  label: string;
} {
  const reason = transfer.reason || '';
  const kitchenMatch = reason.match(/^\s*Kitchen\s*[:\-—]\s*(.+)$/i);
  if (kitchenMatch) return { type: 'kitchen', label: kitchenMatch[1].trim() };
  const packagingMatch = reason.match(/^\s*Packaging\s*[:\-—]\s*(.+)$/i);
  if (packagingMatch) return { type: 'packaging', label: packagingMatch[1].trim() };
  if (/kitchen/i.test(reason)) return { type: 'kitchen', label: reason };
  if (/packaging/i.test(reason)) return { type: 'packaging', label: reason };
  return { type: 'other', label: reason || (transfer.linkedBatchId ? transfer.linkedBatchId : 'Manual') };
}

function subtractWorkingDays(date: Date, days: number): Date {
  const result = new Date(date);
  let count = 0;
  while (count < days) {
    result.setDate(result.getDate() - 1);
    const dow = result.getDay();
    if (dow !== 0 && dow !== 6) count++;
  }
  return result;
}

/**
 * Stable identity for a gap — used to key the (transient) transfer-qty
 * state so it survives table re-sorting. Mirrors the aggregation key the
 * detector uses: product + destination + need-by date.
 */
function gapKeyOf(gap: TransferGap): string {
  // Local-ISO must match the detector's aggregation key (transfer-detection.ts)
  // which now uses `toLocalISODate`. Using `.toISOString()` here would drift
  // by a day for AEST local-midnight dates.
  return `${gap.productCode}|${gap.destinationWarehouse}|${localISODate(gap.needByDate)}`;
}

/** Local YYYY-MM-DD for a date (used by the need-by date-range picker). */
function localISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function todayISO(): string {
  return localISODate(new Date());
}
/** Monday-of-this-week and Sunday, as YYYY-MM-DD — for the "This week" preset. */
function thisWeekRange(): { from: string; to: string } {
  const now = new Date();
  const dow = (now.getDay() + 6) % 7; // 0 = Monday
  const mon = new Date(now);
  mon.setDate(now.getDate() - dow);
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);
  return { from: localISODate(mon), to: localISODate(sun) };
}

// ─── Page ──────────────────────────────────────────────────

type TabKey = 'gaps' | 'manifest';

export default function LogisticsPage() {
  // Data state
  const [sohItems, setSOHItems] = useState<StockOnHandItem[]>([]);
  const [assemblies, setAssemblies] = useState<Assembly[]>([]);
  // All open assemblies incl. PACKAGING (FG) ones — source for packaging
  // transfer demands. (Kitchen-data only returns MF-Intermediate group.)
  const [allOpenAssemblies, setAllOpenAssemblies] = useState<Assembly[]>([]);
  const [consumptionSchedule, setConsumptionSchedule] = useState<Record<string, KitchenBatch[]>>({});
  const [componentNames, setComponentNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // UI state
  const [tab, setTab] = useState<TabKey>('gaps');
  const [draftTransfers, setDraftTransfers] = useState<DraftTransfer[]>([]);
  const [transferQtys, setTransferQtys] = useState<Record<string, Record<string, number>>>({});
  const [leadTimeDays, setLeadTimeDays] = useState(DEFAULT_LEAD_TIME_DAYS);
  const [search, setSearch] = useState('');
  // Need-by date-range filter (driven by the popout in the table's "Need by"
  // header). `from` defaults to today so past-dated transfers are hidden by
  // default; the user can widen/clear it. Empty string = open-ended on that
  // side.
  const [dateRange, setDateRange] = useState<{ from: string; to: string }>({
    from: todayISO(),
    to: '',
  });
  // Column filters (empty set / string = no filter = show all).
  const [destFilter, setDestFilter] = useState<Set<string>>(new Set());
  const [sourceFilter, setSourceFilter] = useState<Set<string>>(new Set());
  const [demandSkuFilter, setDemandSkuFilter] = useState('');

  // ── Data fetching ────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        // Fetch kitchen and purchasing data in parallel
        const [kitchenRes, purchasingRes] = await Promise.all([
          fetch('/api/kitchen-data'),
          fetch('/api/purchasing-data'),
        ]);

        const kitchenJson = await kitchenRes.json();
        const purchasingJson = await purchasingRes.json();

        if (cancelled) return;

        if (!kitchenJson.success) throw new Error(kitchenJson.error || 'Kitchen data fetch failed');
        if (!purchasingJson.success) throw new Error(purchasingJson.error || 'Purchasing data fetch failed');

        const kitchenData = kitchenJson.data as {
          sohItems: StockOnHandItem[];
          assemblies: Assembly[];
        };

        const purchasingData = purchasingJson.data as {
          sohItems: StockOnHandItem[];
          assemblies: Assembly[];
        };

        // Use SOH from kitchen-data (same source, avoids mismatch)
        setSOHItems(kitchenData.sohItems);
        setAssemblies(kitchenData.assemblies);

        // Derive consumption schedule via the shared demand helper.
        // Same derivation used by purchasing — single source now.
        // Restrict to intermediate (kitchen) assemblies — packaging-FG BOM
        // lines (labels/jars/lids/boxes/strips) are NOT kitchen demands at
        // Lundberg; they're handled by extractPackagingDemands, which routes
        // them to the run's own warehouse (Bottlo → MF Ops, others → MF Pkg).
        const schedule = consumptionScheduleFromDemands(
          demandsFromKitchenAssemblies(
            purchasingData.assemblies,
            (a) => a.productCode in INTERMEDIATE_REGISTRY,
          ),
        );
        setConsumptionSchedule(schedule);

        // Keep ALL open assemblies (incl. packaging FGs) so we can derive
        // packaging-run input demands for transfer detection.
        setAllOpenAssemblies(purchasingData.assemblies);

        // Build name map from SOH items
        const names: Record<string, string> = {};
        for (const item of kitchenData.sohItems) {
          if (!names[item.productCode]) names[item.productCode] = item.productName;
        }
        setComponentNames(names);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load data');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, []);

  // Restore drafts on mount
  useEffect(() => {
    const stored = loadDraftTransfers();
    if (stored.length > 0) setDraftTransfers(stored);
  }, []);

  // ── SOH maps ─────────────────────────────────────────────

  const soh = useMemo(() => new WarehouseSOH(sohItems), [sohItems]);

  // ── Gap detection ────────────────────────────────────────

  const gaps: TransferGap[] = useMemo(() => {
    if (sohItems.length === 0) return [];

    const kitchenDemands = extractKitchenDemandsFromSchedule(consumptionSchedule);
    // Packaging-run input demands (intermediates + labels/jars/lids/boxes)
    // at each run's own warehouse — Bottlo → MF Operations, all other
    // packaging stations → MF Packaging (read from the assembly).
    const packagingDemands = extractPackagingDemands(
      allOpenAssemblies,
      (code) => code in INTERMEDIATE_REGISTRY,
      WAREHOUSES.MF_PACKAGING,
    );

    // Date filtering (incl. the today-floor default) is applied in
    // `filteredGaps` from the need-by date-range picker, so the user can
    // widen the window to see past/overdue transfers when they want.
    return detectTransferGaps({
      soh,
      kitchenDemands,
      packagingDemands,
      productNames: componentNames,
    });
  }, [sohItems, consumptionSchedule, allOpenAssemblies, soh, componentNames]);

  // Filter gaps by search + need-by date range + column filters
  // (destination, source warehouse, demand-source SKU).
  const filteredGaps = useMemo(() => {
    const q = search.trim().toLowerCase();
    const demandQ = demandSkuFilter.trim().toLowerCase();
    const { from, to } = dateRange;
    const out: TransferGap[] = [];
    for (const g of gaps) {
      // Search match
      if (q) {
        const hit =
          g.productCode.toLowerCase().includes(q) ||
          g.productName.toLowerCase().includes(q) ||
          g.destinationWarehouse.toLowerCase().includes(q);
        if (!hit) continue;
      }
      // Need-by date range (inclusive). Compare local YYYY-MM-DD strings.
      const needBy = localISODate(g.needByDate);
      if (from && needBy < from) continue;
      if (to && needBy > to) continue;
      // Destination warehouse toggle
      if (destFilter.size > 0 && !destFilter.has(g.destinationWarehouse)) continue;
      // Demand-source SKU/name filter
      if (demandQ && !g.demandSource.name.toLowerCase().includes(demandQ)) continue;
      // Source-warehouse toggle — narrow the source options; drop the gap
      // entirely if none of its sources are in the selected set.
      let sourceOptions = g.sourceOptions;
      if (sourceFilter.size > 0) {
        sourceOptions = sourceOptions.filter((s) => sourceFilter.has(s.warehouse));
        if (sourceOptions.length === 0) continue;
      }
      out.push(sourceOptions === g.sourceOptions ? g : { ...g, sourceOptions });
    }
    return out;
  }, [gaps, search, dateRange, destFilter, sourceFilter, demandSkuFilter]);

  // ── Transfer qty management ──────────────────────────────

  // Pre-fill: seed each gap's BEST source with the needed qty (capped at
  // what's available there), so the operator can plan in one click and
  // only edit the qty / switch source where necessary. Seeds once per gap
  // — only when there's no entry yet, so it never overwrites a value the
  // user typed, zeroed, or that was cleared after planning.
  useEffect(() => {
    if (gaps.length === 0) return;
    setTransferQtys(prev => {
      let changed = false;
      const next = { ...prev };
      for (const gap of gaps) {
        if (gap.sourceOptions.length === 0) continue;
        const key = gapKeyOf(gap);
        if (next[key]) continue; // already seeded or user-touched
        const best = gap.sourceOptions[0]; // sorted by available desc
        const qty = Math.min(best.available, gap.quantityNeeded);
        if (qty <= 0) continue;
        next[key] = { [best.warehouse]: Math.round(qty * 100) / 100 };
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [gaps]);

  const getTransferQty = useCallback((gapKey: string, sourceWh: string): number => {
    return transferQtys[gapKey]?.[sourceWh] ?? 0;
  }, [transferQtys]);

  const setTransferQty = useCallback((gapKey: string, sourceWh: string, qty: number) => {
    setTransferQtys(prev => ({
      ...prev,
      [gapKey]: { ...(prev[gapKey] || {}), [sourceWh]: qty },
    }));
  }, []);

  // Auto-fill a gap's transfer qty from the best source
  const autoFillGap = useCallback((gap: TransferGap) => {
    if (gap.sourceOptions.length === 0) return;
    const best = gap.sourceOptions[0]; // Already sorted by available desc
    const qty = Math.min(best.available, gap.quantityNeeded);
    setTransferQty(gapKeyOf(gap), best.warehouse, Math.round(qty * 100) / 100);
  }, [setTransferQty]);

  // ── Plan a transfer ──────────────────────────────────────

  const planTransfer = useCallback((gap: TransferGap, sourceWh: string) => {
    const gapKey = gapKeyOf(gap);
    const qty = getTransferQty(gapKey, sourceWh);
    if (qty <= 0) return;

    const transferDate = subtractWorkingDays(gap.needByDate, leadTimeDays);

    const draft: DraftTransfer = {
      id: generateId(),
      productCode: gap.productCode,
      productName: gap.productName,
      quantity: qty,
      fromWarehouse: sourceWh,
      toWarehouse: gap.destinationWarehouse,
      transferDate,
      needByDate: gap.needByDate,
      status: 'confirmed',
      reason: `${gap.demandSource.type === 'kitchen_batch' ? 'Kitchen' : 'Packaging'}: ${gap.demandSource.name}`,
      linkedBatchId: gap.demandSource.id,
    };

    setDraftTransfers(prev => {
      const next = [...prev, draft];
      saveDraftTransfers(next);
      return next;
    });

    // Clear the transfer qty for this gap
    setTransferQty(gapKey, sourceWh, 0);
  }, [getTransferQty, leadTimeDays, setTransferQty]);

  // ── Remove a draft ───────────────────────────────────────

  const removeDraft = useCallback((id: string) => {
    setDraftTransfers(prev => {
      const next = prev.filter(t => t.id !== id);
      saveDraftTransfers(next);
      return next;
    });
  }, []);

  const clearAllDrafts = useCallback(() => {
    setDraftTransfers([]);
    saveDraftTransfers([]);
  }, []);

  // ── Stats ────────────────────────────────────────────────

  const stats = useMemo(() => {
    const confirmedTransfers = draftTransfers.filter(t => t.status === 'confirmed' || t.status === 'draft');
    const totalKg = confirmedTransfers.reduce((sum, t) => sum + t.quantity, 0);
    return {
      totalGaps: gaps.length,
      transfersPlanned: confirmedTransfers.length,
      totalKg: Math.round(totalKg * 100) / 100,
    };
  }, [gaps, draftTransfers]);

  // ── Manifest grouping ───────────────────────────────────

  const manifestGroups = useMemo(() => {
    const confirmed = draftTransfers.filter(t => t.status === 'confirmed' || t.status === 'draft');
    const groups: Record<string, Record<string, DraftTransfer[]>> = {};

    for (const t of confirmed) {
      const routeKey = `${whShort(t.fromWarehouse)} \u2192 ${whShort(t.toWarehouse)}`;
      const weekKey = getWeekLabel(t.transferDate);
      if (!groups[routeKey]) groups[routeKey] = {};
      if (!groups[routeKey][weekKey]) groups[routeKey][weekKey] = [];
      groups[routeKey][weekKey].push(t);
    }

    return groups;
  }, [draftTransfers]);

  // ── Loading / error states ──────────────────────────────

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center" style={{ background: 'var(--bg-page)' }}>
        <div className="text-center">
          <div className="text-sm mb-2" style={{ color: 'var(--text-muted)' }}>Loading logistics data...</div>
          <div className="w-48 h-0.5 rounded overflow-hidden" style={{ background: 'var(--bg-surface)' }}>
            <div className="h-full rounded animate-pulse" style={{ width: '60%', background: 'var(--accent)' }} />
          </div>
        </div>
      </div>
    );
  }

  // ── Render ──────────────────────────────────────────────

  return (
    <div className="h-screen flex flex-col overflow-hidden" style={{ background: 'var(--bg-page)', color: 'var(--text-primary)' }}>
      {/* Error banner */}
      {error && (
        <div className="px-6 py-2 text-sm" style={{ background: 'var(--danger-light)', color: 'var(--danger)', borderBottom: '0.5px solid var(--border)' }}>
          {error}
        </div>
      )}

      {/* Header */}
      <div className="px-6 pt-5 pb-4" style={{ borderBottom: '0.5px solid var(--border)' }}>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-xl" style={{ fontWeight: 500, color: 'var(--text-primary)' }}>Logistics Planner</h1>
            <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
              Inter-warehouse transfer requirements and planning
            </p>
          </div>
          <div className="flex items-center gap-3">
            <label className="text-xs flex items-center gap-2" style={{ color: 'var(--text-secondary)' }}>
              Lead time
              <input
                type="number"
                min={0}
                max={5}
                value={leadTimeDays}
                onChange={e => setLeadTimeDays(Math.max(0, parseInt(e.target.value) || 0))}
                className="w-12 rounded px-2 py-0.5 text-xs text-center focus:outline-none"
                style={{ background: 'var(--bg-surface)', border: '0.5px solid var(--border)', color: 'var(--text-primary)' }}
              />
              day{leadTimeDays !== 1 ? 's' : ''}
            </label>
            {draftTransfers.length > 0 && (
              <button
                onClick={clearAllDrafts}
                className="text-xs px-2 py-1 rounded transition hover:opacity-70"
                style={{ color: 'var(--danger)', background: 'var(--danger-light)', border: '0.5px solid var(--danger)' }}
              >
                Clear all
              </button>
            )}
          </div>
        </div>

        {/* Stat cards */}
        <div className="grid grid-cols-3 gap-3 mb-4">
          <button
            onClick={() => setTab('gaps')}
            className="rounded px-3 py-2 text-left transition"
            style={{
              background: tab === 'gaps' ? 'var(--accent-light)' : 'var(--bg-surface)',
              border: tab === 'gaps' ? '0.5px solid var(--accent)' : '0.5px solid transparent',
            }}
          >
            <div className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-muted)', fontWeight: 500 }}>Transfer Gaps</div>
            <div className="text-xl mt-0.5" style={{ fontWeight: 500, color: stats.totalGaps > 0 ? 'var(--warning)' : 'var(--success)' }}>
              {stats.totalGaps}
            </div>
          </button>
          <button
            onClick={() => setTab('manifest')}
            className="rounded px-3 py-2 text-left transition"
            style={{
              background: tab === 'manifest' ? 'var(--accent-light)' : 'var(--bg-surface)',
              border: tab === 'manifest' ? '0.5px solid var(--accent)' : '0.5px solid transparent',
            }}
          >
            <div className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-muted)', fontWeight: 500 }}>Transfers Planned</div>
            <div className="text-xl mt-0.5" style={{ fontWeight: 500, color: stats.transfersPlanned > 0 ? 'var(--accent)' : 'var(--text-primary)' }}>
              {stats.transfersPlanned}
            </div>
          </button>
          <div
            className="rounded px-3 py-2 text-left"
            style={{ background: 'var(--bg-surface)', border: '0.5px solid transparent' }}
          >
            <div className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-muted)', fontWeight: 500 }}>Total kg to Move</div>
            <div className="text-xl mt-0.5" style={{ fontWeight: 500, color: 'var(--text-primary)' }}>
              {stats.totalKg > 0 ? stats.totalKg.toLocaleString('en-AU') : '\u2014'}
            </div>
          </div>
        </div>

        {/* Search */}
        <div className="flex items-center gap-3">
          <input
            type="text"
            placeholder="Search by product code, name, or warehouse..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="rounded px-3 py-1.5 text-xs w-80 focus:outline-none"
            style={{ color: 'var(--text-primary)', background: 'var(--bg-surface)', border: '0.5px solid var(--border)' }}
          />
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {tab === 'gaps' ? `${filteredGaps.length} gap${filteredGaps.length !== 1 ? 's' : ''}` : `${Object.keys(manifestGroups).length} route${Object.keys(manifestGroups).length !== 1 ? 's' : ''}`}
          </span>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {tab === 'gaps' ? (
          <GapsTable
            gaps={filteredGaps}
            draftTransfers={draftTransfers}
            getTransferQty={getTransferQty}
            setTransferQty={setTransferQty}
            autoFillGap={autoFillGap}
            planTransfer={planTransfer}
            dateRange={dateRange}
            setDateRange={setDateRange}
            destFilter={destFilter}
            setDestFilter={setDestFilter}
            sourceFilter={sourceFilter}
            setSourceFilter={setSourceFilter}
            demandSkuFilter={demandSkuFilter}
            setDemandSkuFilter={setDemandSkuFilter}
          />
        ) : (
          <ManifestView
            groups={manifestGroups}
            removeDraft={removeDraft}
          />
        )}
      </div>
    </div>
  );
}

// ─── Gaps Table ────────────────────────────────────────────

type GapSortKey = 'product' | 'destination' | 'needBy' | 'source' | 'qty';

/** Clean line-art calendar icon (matches the native date-input glyph). */
function CalendarIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ display: 'inline-block', verticalAlign: '-1px' }}>
      <rect x="2" y="3" width="12" height="11" rx="1.5" />
      <line x1="2" y1="6" x2="14" y2="6" />
      <line x1="5.5" y1="1.5" x2="5.5" y2="4" />
      <line x1="10.5" y1="1.5" x2="10.5" y2="4" />
    </svg>
  );
}

/** Funnel icon used on filterable column headers. */
function FilterIcon({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ display: 'inline-block', verticalAlign: '-1px' }}>
      <path d="M2 3h12l-4.5 5.5V13l-3 1.5V8.5L2 3z" />
    </svg>
  );
}

/** Small preset button used inside the need-by date-range popout. */
function PresetBtn({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        fontSize: 10,
        padding: '2px 6px',
        borderRadius: 3,
        border: '0.5px solid var(--border)',
        background: 'var(--bg-page)',
        color: 'var(--text-secondary)',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </button>
  );
}

function GapsTable({
  gaps,
  draftTransfers,
  getTransferQty,
  setTransferQty,
  autoFillGap,
  planTransfer,
  dateRange,
  setDateRange,
  destFilter,
  setDestFilter,
  sourceFilter,
  setSourceFilter,
  demandSkuFilter,
  setDemandSkuFilter,
}: {
  gaps: TransferGap[];
  draftTransfers: DraftTransfer[];
  getTransferQty: (gapKey: string, wh: string) => number;
  setTransferQty: (gapKey: string, wh: string, qty: number) => void;
  autoFillGap: (gap: TransferGap) => void;
  planTransfer: (gap: TransferGap, sourceWh: string) => void;
  dateRange: { from: string; to: string };
  setDateRange: (r: { from: string; to: string }) => void;
  destFilter: Set<string>;
  setDestFilter: (s: Set<string>) => void;
  sourceFilter: Set<string>;
  setSourceFilter: (s: Set<string>) => void;
  demandSkuFilter: string;
  setDemandSkuFilter: (s: string) => void;
}) {
  // Sortable headers — default to earliest need-by (most urgent first).
  const [sort, setSort] = useState<{ key: GapSortKey; dir: 'asc' | 'desc' }>({
    key: 'needBy',
    dir: 'asc',
  });
  // Which column's filter popout is open (only one at a time).
  const [openFilter, setOpenFilter] = useState<null | 'date' | 'dest' | 'source' | 'demand'>(null);
  const dateFilterActive = dateRange.from !== '' || dateRange.to !== '';

  // Toggle a warehouse in a Set-based filter (returns a NEW set).
  const toggleInSet = (set: Set<string>, value: string): Set<string> => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  };
  const allWarehouses = Object.values(WAREHOUSES);

  const toggleSort = (key: GapSortKey) => {
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: key === 'qty' ? 'desc' : 'asc' },
    );
  };

  const sortedGaps = useMemo(() => {
    const dir = sort.dir === 'asc' ? 1 : -1;
    const copy = [...gaps];
    copy.sort((a, b) => {
      let cmp = 0;
      switch (sort.key) {
        case 'product':
          cmp = a.productCode.localeCompare(b.productCode);
          break;
        case 'destination':
          cmp = a.destinationWarehouse.localeCompare(b.destinationWarehouse);
          break;
        case 'needBy':
          cmp = a.needByDate.getTime() - b.needByDate.getTime();
          break;
        case 'source':
          cmp = a.demandSource.name.localeCompare(b.demandSource.name);
          break;
        case 'qty':
          cmp = a.quantityNeeded - b.quantityNeeded;
          break;
      }
      // Stable tiebreak so equal keys keep a deterministic order.
      if (cmp === 0) cmp = gapKeyOf(a).localeCompare(gapKeyOf(b));
      return cmp * dir;
    });
    return copy;
  }, [gaps, sort]);

  if (gaps.length === 0) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-center">
          <div className="text-sm" style={{ color: 'var(--text-muted)' }}>No transfer gaps detected</div>
          <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
            All scheduled demands have sufficient stock at the target warehouse
          </div>
        </div>
      </div>
    );
  }

  return (
    <table className="text-xs w-full" style={{ borderCollapse: 'separate', borderSpacing: 0 }}>
      <thead className="sticky top-0 z-10">
        <tr>
          {([
            { label: 'Product', key: 'product', align: 'left', filter: null },
            { label: 'Destination', key: 'destination', align: 'left', filter: 'dest' },
            { label: 'Need by', key: 'needBy', align: 'left', filter: 'date' },
            { label: 'Demand source', key: 'source', align: 'left', filter: 'demand' },
            { label: 'Qty needed', key: 'qty', align: 'right', filter: null },
            { label: 'Source', key: null, align: 'left', filter: 'source' },
            { label: 'Available', key: null, align: 'right', filter: null },
            { label: 'Transfer qty', key: null, align: 'right', filter: null },
            { label: '', key: null, align: 'left', filter: null },
          ] as { label: string; key: GapSortKey | null; align: 'left' | 'right'; filter: null | 'date' | 'dest' | 'source' | 'demand' }[]).map((col, i) => {
            const sortable = col.key !== null;
            const active = sortable && sort.key === col.key;
            const filterActive =
              col.filter === 'date' ? dateFilterActive
              : col.filter === 'dest' ? destFilter.size > 0
              : col.filter === 'source' ? sourceFilter.size > 0
              : col.filter === 'demand' ? demandSkuFilter.trim() !== ''
              : false;
            const isOpen = col.filter !== null && openFilter === col.filter;
            return (
              <th
                key={col.label || `col-${i}`}
                className={`px-3 py-2 ${col.align === 'right' ? 'text-right' : 'text-left'}`}
                style={{
                  fontWeight: 600,
                  fontSize: '11px',
                  color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                  background: 'var(--bg-surface)',
                  borderBottom: '0.5px solid var(--border)',
                  whiteSpace: 'nowrap',
                  userSelect: 'none',
                  position: col.filter ? 'relative' : undefined,
                }}
              >
                <span
                  onClick={sortable ? () => toggleSort(col.key as GapSortKey) : undefined}
                  className={sortable ? 'cursor-pointer select-none' : ''}
                  title={sortable ? `Sort by ${col.label}` : undefined}
                >
                  {col.label}
                  {sortable && (
                    <span style={{ marginLeft: 4, opacity: active ? 1 : 0.3, fontSize: '9px' }}>
                      {active ? (sort.dir === 'asc' ? '▲' : '▼') : '⇅'}
                    </span>
                  )}
                </span>
                {col.filter && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpenFilter(isOpen ? null : col.filter);
                    }}
                    title={col.filter === 'date' ? 'Filter by need-by date or range' : col.filter === 'demand' ? 'Filter by demand-source SKU' : 'Filter by warehouse'}
                    style={{
                      marginLeft: 6,
                      lineHeight: 1,
                      cursor: 'pointer',
                      background: filterActive ? 'var(--accent-light)' : 'transparent',
                      color: filterActive ? 'var(--accent)' : 'var(--text-muted)',
                      border: filterActive ? '0.5px solid var(--accent)' : '0.5px solid transparent',
                      borderRadius: 3,
                      padding: '2px 4px',
                    }}
                  >
                    {col.filter === 'date' ? <CalendarIcon /> : <FilterIcon />}
                  </button>
                )}
                {isOpen && (
                  <div
                    onClick={(e) => e.stopPropagation()}
                    style={{
                      position: 'absolute',
                      top: '100%',
                      left: 0,
                      marginTop: 4,
                      zIndex: 30,
                      background: 'var(--bg-surface)',
                      border: '0.5px solid var(--border)',
                      borderRadius: 6,
                      boxShadow: '0 6px 20px rgba(0,0,0,0.18)',
                      padding: 12,
                      minWidth: 200,
                      fontWeight: 400,
                      textTransform: 'none',
                      letterSpacing: 0,
                      cursor: 'default',
                    }}
                  >
                    {/* ── Date range ── */}
                    {col.filter === 'date' && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        <label style={{ fontSize: 11, color: 'var(--text-secondary)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                          From
                          <input type="date" value={dateRange.from} onChange={(e) => setDateRange({ ...dateRange, from: e.target.value })}
                            style={{ fontSize: 11, padding: '2px 6px', borderRadius: 3, border: '0.5px solid var(--border)', background: 'var(--bg-page)', color: 'var(--text-primary)' }} />
                        </label>
                        <label style={{ fontSize: 11, color: 'var(--text-secondary)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                          To
                          <input type="date" value={dateRange.to} onChange={(e) => setDateRange({ ...dateRange, to: e.target.value })}
                            style={{ fontSize: 11, padding: '2px 6px', borderRadius: 3, border: '0.5px solid var(--border)', background: 'var(--bg-page)', color: 'var(--text-primary)' }} />
                        </label>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 2 }}>
                          <PresetBtn label="Today" onClick={() => setDateRange({ from: todayISO(), to: todayISO() })} />
                          <PresetBtn label="Today on" onClick={() => setDateRange({ from: todayISO(), to: '' })} />
                          <PresetBtn label="This week" onClick={() => setDateRange(thisWeekRange())} />
                          <PresetBtn label="All dates" onClick={() => setDateRange({ from: '', to: '' })} />
                        </div>
                      </div>
                    )}
                    {/* ── Warehouse toggle (destination / source) ── */}
                    {(col.filter === 'dest' || col.filter === 'source') && (() => {
                      const set = col.filter === 'dest' ? destFilter : sourceFilter;
                      const setFn = col.filter === 'dest' ? setDestFilter : setSourceFilter;
                      return (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          {allWarehouses.map((wh) => (
                            <label key={wh} style={{ fontSize: 11, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                              <input
                                type="checkbox"
                                checked={set.size === 0 || set.has(wh)}
                                onChange={() => setFn(toggleInSet(set, wh))}
                              />
                              {whShort(wh)}
                            </label>
                          ))}
                          <PresetBtn label="All warehouses" onClick={() => setFn(new Set())} />
                        </div>
                      );
                    })()}
                    {/* ── Demand-source SKU filter ── */}
                    {col.filter === 'demand' && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <input
                          type="text"
                          autoFocus
                          placeholder="SKU or run name…"
                          value={demandSkuFilter}
                          onChange={(e) => setDemandSkuFilter(e.target.value)}
                          style={{ fontSize: 11, padding: '4px 6px', borderRadius: 3, border: '0.5px solid var(--border)', background: 'var(--bg-page)', color: 'var(--text-primary)', width: 180 }}
                        />
                        <PresetBtn label="Clear" onClick={() => setDemandSkuFilter('')} />
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={() => setOpenFilter(null)}
                      style={{ marginTop: 8, width: '100%', fontSize: 11, padding: '3px 0', borderRadius: 3, border: '0.5px solid var(--border)', background: 'var(--bg-page)', color: 'var(--text-secondary)', cursor: 'pointer' }}
                    >
                      Done
                    </button>
                  </div>
                )}
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {sortedGaps.map((gap) => {
          const gapKey = gapKeyOf(gap);
          // Check for existing draft transfers covering this gap
          const draftedQty = draftTransfers
            .filter(t => t.productCode === gap.productCode && t.toWarehouse === gap.destinationWarehouse)
            .reduce((sum, t) => sum + t.quantity, 0);
          const fullyCovered = draftedQty >= gap.quantityNeeded;

          // One row per source option per gap
          return gap.sourceOptions.map((source, srcIdx) => {
            const isFirst = srcIdx === 0;
            const qty = getTransferQty(gapKey, source.warehouse);
            const canPlan = qty > 0;

            return (
              <tr
                key={`${gapKey}-${srcIdx}`}
                style={{ borderBottom: isFirst ? undefined : '0.5px solid var(--border)' }}
                className="transition"
                onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-surface)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = ''; }}
              >
                {/* Product — only on first row of gap */}
                {isFirst ? (
                  <td className="px-3 py-1.5" rowSpan={gap.sourceOptions.length} style={{ borderBottom: '0.5px solid var(--border)' }}>
                    <span className="font-mono" style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{gap.productCode}</span>
                    <div className="truncate" style={{ color: 'var(--text-muted)', maxWidth: 180, fontSize: '10px' }} title={gap.productName}>
                      {gap.productName}
                    </div>
                  </td>
                ) : null}

                {/* Destination — only on first row */}
                {isFirst ? (
                  <td className="px-3 py-1.5" rowSpan={gap.sourceOptions.length} style={{ borderBottom: '0.5px solid var(--border)' }}>
                    <span className="px-1.5 py-0.5 rounded text-[10px]" style={{
                      fontWeight: 500,
                      color: gap.destinationWarehouse === WAREHOUSES.LUNDBERG ? 'var(--accent)' : 'var(--purple)',
                      background: gap.destinationWarehouse === WAREHOUSES.LUNDBERG ? 'var(--accent-light)' : 'var(--purple-light)',
                    }}>
                      {whShort(gap.destinationWarehouse)}
                    </span>
                  </td>
                ) : null}

                {/* Need by date — only on first row */}
                {isFirst ? (
                  <td className="px-3 py-1.5" rowSpan={gap.sourceOptions.length} style={{ color: 'var(--text-secondary)', borderBottom: '0.5px solid var(--border)' }}>
                    {formatDateFull(gap.needByDate)}
                  </td>
                ) : null}

                {/* Demand source — only on first row */}
                {isFirst ? (
                  <td className="px-3 py-1.5 truncate" rowSpan={gap.sourceOptions.length} style={{ color: 'var(--text-muted)', maxWidth: 180, borderBottom: '0.5px solid var(--border)', fontSize: '10px' }} title={gap.demandSource.name}>
                    <span className="px-1 py-0.5 rounded text-[9px] mr-1" style={{
                      fontWeight: 500,
                      color: gap.demandSource.type === 'kitchen_batch' ? 'var(--success)' : 'var(--purple)',
                      background: gap.demandSource.type === 'kitchen_batch' ? 'var(--success-light)' : 'var(--purple-light)',
                    }}>
                      {gap.demandSource.type === 'kitchen_batch' ? 'KIT' : 'PKG'}
                    </span>
                    {gap.demandSource.name}
                  </td>
                ) : null}

                {/* Qty needed — only on first row */}
                {isFirst ? (
                  <td className="px-3 py-1.5 text-right font-mono" rowSpan={gap.sourceOptions.length} style={{ fontWeight: 500, color: fullyCovered ? 'var(--success)' : 'var(--danger)', borderBottom: '0.5px solid var(--border)' }}>
                    {Math.round(gap.quantityNeeded)}
                    {draftedQty > 0 && (
                      <div className="text-[10px] mt-0.5" style={{ fontWeight: 500, color: fullyCovered ? 'var(--success)' : 'var(--accent)' }}>
                        {Math.round(draftedQty)} drafted
                      </div>
                    )}
                  </td>
                ) : null}

                {/* Source warehouse — first row is the pre-filled best source */}
                <td className="px-3 py-1.5" style={{ borderBottom: '0.5px solid var(--border)' }}>
                  <span className="text-[10px]" style={{ color: 'var(--text-secondary)', fontWeight: 500 }}>
                    {whShort(source.warehouse)}
                  </span>
                  {isFirst && gap.sourceOptions.length > 1 && (
                    <span
                      className="ml-1 text-[8px] px-1 py-0.5 rounded"
                      style={{ color: 'var(--accent)', background: 'var(--accent-light)', fontWeight: 600 }}
                      title="Suggested source — most stock available. Pre-filled below; edit the qty or enter a qty on another source row to switch."
                    >
                      best
                    </span>
                  )}
                </td>

                {/* Available at source */}
                <td className="px-3 py-1.5 text-right font-mono" style={{ color: 'var(--text-secondary)', borderBottom: '0.5px solid var(--border)' }}>
                  {Math.round(source.available)}
                </td>

                {/* Transfer qty input */}
                <td className="px-3 py-1.5 text-right" style={{ borderBottom: '0.5px solid var(--border)' }}>
                  <div className="flex items-center justify-end gap-1">
                    {isFirst && (
                      <button
                        onClick={() => autoFillGap(gap)}
                        className="text-[9px] px-1 py-0.5 rounded transition hover:opacity-70"
                        style={{ color: 'var(--accent)', background: 'var(--accent-light)', border: '0.5px solid var(--accent)' }}
                        title="Auto-fill from best source"
                      >
                        Auto
                      </button>
                    )}
                    <input
                      type="number"
                      min={0}
                      max={source.available}
                      value={qty || ''}
                      onChange={e => setTransferQty(gapKey, source.warehouse, Math.max(0, parseFloat(e.target.value) || 0))}
                      className="w-16 rounded px-1.5 py-0.5 text-xs text-right font-mono focus:outline-none"
                      style={{ background: 'var(--bg-surface)', border: '0.5px solid var(--border)', color: 'var(--text-primary)' }}
                      placeholder="0"
                    />
                  </div>
                </td>

                {/* Plan button */}
                <td className="px-3 py-1.5" style={{ borderBottom: '0.5px solid var(--border)' }}>
                  <button
                    onClick={() => planTransfer(gap, source.warehouse)}
                    disabled={!canPlan}
                    className="text-[10px] px-2 py-1 rounded transition"
                    style={{
                      fontWeight: 500,
                      color: canPlan ? '#fff' : 'var(--text-muted)',
                      background: canPlan ? 'var(--accent)' : 'var(--bg-surface)',
                      border: canPlan ? '0.5px solid var(--accent)' : '0.5px solid var(--border)',
                      cursor: canPlan ? 'pointer' : 'default',
                      opacity: canPlan ? 1 : 0.5,
                    }}
                  >
                    Plan Transfer
                  </button>
                </td>
              </tr>
            );
          });
        })}
      </tbody>
    </table>
  );
}

// ─── Transfer Manifest ─────────────────────────────────────

function ManifestView({
  groups,
  removeDraft,
}: {
  groups: Record<string, Record<string, DraftTransfer[]>>;
  removeDraft: (id: string) => void;
}) {
  const routeKeys = Object.keys(groups);

  if (routeKeys.length === 0) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-center">
          <div className="text-sm" style={{ color: 'var(--text-muted)' }}>No transfers planned yet</div>
          <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
            Use the Gaps tab to plan transfers from source to destination
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="px-6 py-4 space-y-6">
      {routeKeys.sort().map(route => {
        const weeks = groups[route];
        const weekKeys = Object.keys(weeks).sort();

        return (
          <div key={route}>
            <div className="flex items-center gap-2 mb-3">
              <h3 className="text-sm" style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{route}</h3>
              <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ color: 'var(--text-muted)', background: 'var(--bg-surface)' }}>
                {Object.values(weeks).flat().length} item{Object.values(weeks).flat().length !== 1 ? 's' : ''}
              </span>
            </div>

            {weekKeys.map(week => {
              const transfers = weeks[week];
              const weekTotal = transfers.reduce((s, t) => s + t.quantity, 0);

              return (
                <div key={week} className="mb-4">
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-muted)', fontWeight: 500 }}>{week}</span>
                    <span className="text-[10px] font-mono" style={{ color: 'var(--text-secondary)' }}>
                      {Math.round(weekTotal)} kg
                    </span>
                  </div>

                  <table className="text-xs w-full" style={{ borderCollapse: 'separate', borderSpacing: 0 }}>
                    <thead>
                      <tr>
                        {['Product', 'Qty (kg)', 'Transfer date', 'Need by', 'Demand source', ''].map(h => (
                          <th
                            key={h}
                            className={`px-3 py-1.5 ${h === 'Qty (kg)' ? 'text-right' : 'text-left'}`}
                            style={{ fontWeight: 600, fontSize: '10px', color: 'var(--text-muted)', background: 'var(--bg-surface)', borderBottom: '0.5px solid var(--border)' }}
                          >
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {transfers.map(t => (
                        <tr
                          key={t.id}
                          style={{ borderBottom: '0.5px solid var(--border)' }}
                          className="transition"
                          onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-surface)'; }}
                          onMouseLeave={e => { e.currentTarget.style.background = ''; }}
                        >
                          <td className="px-3 py-1.5">
                            <span className="font-mono" style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{t.productCode}</span>
                            <span className="ml-1.5" style={{ color: 'var(--text-muted)', fontSize: '10px' }}>{t.productName}</span>
                          </td>
                          <td className="px-3 py-1.5 text-right font-mono" style={{ fontWeight: 500, color: 'var(--text-primary)' }}>
                            {Math.round(t.quantity)}
                          </td>
                          <td className="px-3 py-1.5" style={{ color: 'var(--text-secondary)' }}>
                            {formatDate(t.transferDate)}
                          </td>
                          <td className="px-3 py-1.5" style={{ color: 'var(--text-secondary)' }}>
                            {formatDate(t.needByDate)}
                          </td>
                          <td className="px-3 py-1.5 truncate" style={{ color: 'var(--text-muted)', maxWidth: 220, fontSize: '10px' }} title={t.reason}>
                            {(() => {
                              const src = parseDemandSource(t);
                              const badgeColor = src.type === 'kitchen' ? 'var(--success)'
                                : src.type === 'packaging' ? 'var(--purple)'
                                : 'var(--text-secondary)';
                              const badgeBg = src.type === 'kitchen' ? 'var(--success-light)'
                                : src.type === 'packaging' ? 'var(--purple-light)'
                                : 'var(--bg-surface)';
                              const badgeLabel = src.type === 'kitchen' ? 'KIT'
                                : src.type === 'packaging' ? 'PKG'
                                : 'TXFR';
                              return (
                                <>
                                  <span
                                    className="px-1 py-0.5 rounded text-[9px] mr-1"
                                    style={{ fontWeight: 500, color: badgeColor, background: badgeBg }}
                                  >
                                    {badgeLabel}
                                  </span>
                                  {src.label}
                                </>
                              );
                            })()}
                          </td>
                          <td className="px-3 py-1.5">
                            <button
                              onClick={() => removeDraft(t.id)}
                              className="text-[10px] px-1.5 py-0.5 rounded transition hover:opacity-70"
                              style={{ color: 'var(--danger)', background: 'var(--danger-light)' }}
                            >
                              Remove
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

