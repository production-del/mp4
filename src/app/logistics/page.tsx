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
        const schedule = consumptionScheduleFromDemands(
          demandsFromKitchenAssemblies(purchasingData.assemblies),
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

    return detectTransferGaps({
      soh,
      kitchenDemands,
      packagingDemands,
      productNames: componentNames,
    });
  }, [sohItems, consumptionSchedule, allOpenAssemblies, soh, componentNames]);

  // Filter gaps by search
  const filteredGaps = useMemo(() => {
    if (!search) return gaps;
    const q = search.toLowerCase();
    return gaps.filter(g =>
      g.productCode.toLowerCase().includes(q) ||
      g.productName.toLowerCase().includes(q) ||
      g.destinationWarehouse.toLowerCase().includes(q)
    );
  }, [gaps, search]);

  // ── Transfer qty management ──────────────────────────────

  const getTransferQty = useCallback((gapIndex: number, sourceWh: string): number => {
    const key = `${gapIndex}`;
    return transferQtys[key]?.[sourceWh] ?? 0;
  }, [transferQtys]);

  const setTransferQty = useCallback((gapIndex: number, sourceWh: string, qty: number) => {
    const key = `${gapIndex}`;
    setTransferQtys(prev => ({
      ...prev,
      [key]: { ...(prev[key] || {}), [sourceWh]: qty },
    }));
  }, []);

  // Auto-fill a gap's transfer qty from the best source
  const autoFillGap = useCallback((gapIndex: number, gap: TransferGap) => {
    if (gap.sourceOptions.length === 0) return;
    const best = gap.sourceOptions[0]; // Already sorted by available desc
    const qty = Math.min(best.available, gap.quantityNeeded);
    setTransferQty(gapIndex, best.warehouse, Math.round(qty * 100) / 100);
  }, [setTransferQty]);

  // ── Plan a transfer ──────────────────────────────────────

  const planTransfer = useCallback((gapIndex: number, gap: TransferGap, sourceWh: string) => {
    const qty = getTransferQty(gapIndex, sourceWh);
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
    setTransferQty(gapIndex, sourceWh, 0);
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

function GapsTable({
  gaps,
  draftTransfers,
  getTransferQty,
  setTransferQty,
  autoFillGap,
  planTransfer,
}: {
  gaps: TransferGap[];
  draftTransfers: DraftTransfer[];
  getTransferQty: (idx: number, wh: string) => number;
  setTransferQty: (idx: number, wh: string, qty: number) => void;
  autoFillGap: (idx: number, gap: TransferGap) => void;
  planTransfer: (idx: number, gap: TransferGap, sourceWh: string) => void;
}) {
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
          {['Product', 'Destination', 'Need by', 'Demand source', 'Qty needed', 'Source', 'Available', 'Transfer qty', ''].map(h => (
            <th
              key={h}
              className={`px-3 py-2 ${h === 'Qty needed' || h === 'Available' || h === 'Transfer qty' ? 'text-right' : 'text-left'}`}
              style={{ fontWeight: 600, fontSize: '11px', color: 'var(--text-secondary)', background: 'var(--bg-surface)', borderBottom: '0.5px solid var(--border)' }}
            >
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {gaps.map((gap, gapIdx) => {
          // Check for existing draft transfers covering this gap
          const draftedQty = draftTransfers
            .filter(t => t.productCode === gap.productCode && t.toWarehouse === gap.destinationWarehouse)
            .reduce((sum, t) => sum + t.quantity, 0);
          const fullyCovered = draftedQty >= gap.quantityNeeded;

          // One row per source option per gap
          return gap.sourceOptions.map((source, srcIdx) => {
            const isFirst = srcIdx === 0;
            const qty = getTransferQty(gapIdx, source.warehouse);
            const canPlan = qty > 0;

            return (
              <tr
                key={`${gapIdx}-${srcIdx}`}
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

                {/* Source warehouse */}
                <td className="px-3 py-1.5" style={{ borderBottom: '0.5px solid var(--border)' }}>
                  <span className="text-[10px]" style={{ color: 'var(--text-secondary)', fontWeight: 500 }}>
                    {whShort(source.warehouse)}
                  </span>
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
                        onClick={() => autoFillGap(gapIdx, gap)}
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
                      onChange={e => setTransferQty(gapIdx, source.warehouse, Math.max(0, parseFloat(e.target.value) || 0))}
                      className="w-16 rounded px-1.5 py-0.5 text-xs text-right font-mono focus:outline-none"
                      style={{ background: 'var(--bg-surface)', border: '0.5px solid var(--border)', color: 'var(--text-primary)' }}
                      placeholder="0"
                    />
                  </div>
                </td>

                {/* Plan button */}
                <td className="px-3 py-1.5" style={{ borderBottom: '0.5px solid var(--border)' }}>
                  <button
                    onClick={() => planTransfer(gapIdx, gap, source.warehouse)}
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

