'use client';

/**
 * Mobile-optimised view of the Logistics transfer gaps.
 *
 * Same data + gap-detection pipeline as `/logistics`, but rendered as a
 * single-column card list with large tap targets for use on a phone on the
 * shop floor. Operators get the day's transfers, can switch source on a
 * tap, edit the qty, and add to drafts — without zooming into the desk-view
 * table.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { StockOnHandItem, Assembly } from '@/lib/unleashed/types';
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

// ─── Helpers ─────────────────────────────────────────────────

const WH_SHORT: Record<string, string> = {
  'Lundberg Storeroom': 'Lundberg',
  'MF Packaging': 'MF Pkg',
  'MF Operations': 'MF Ops',
  'TBC': 'TBC',
  'TBC Height': 'TBC Hgt',
};
const whShort = (n: string) => WH_SHORT[n] || n;

const DEFAULT_LEAD_TIME_DAYS = 1;

function formatNeedBy(d: Date): string {
  return d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
}
function localISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function todayISO(): string { return localISODate(new Date()); }
function endOfWeekISO(): string {
  const now = new Date();
  const dow = (now.getDay() + 6) % 7; // 0 = Mon
  const sun = new Date(now);
  sun.setDate(now.getDate() + (6 - dow));
  return localISODate(sun);
}
function gapKeyOf(g: TransferGap): string {
  // Local-ISO must match the detector's aggregation key (transfer-detection.ts).
  // `.toISOString()` would drift a day for AEST local-midnight dates.
  return `${g.productCode}|${g.destinationWarehouse}|${localISODate(g.needByDate)}`;
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
function generateId(): string {
  return `txfr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

type DateScope = 'today' | 'week' | 'all';
type Tab = 'pending' | 'drafts';

// ─── Page ───────────────────────────────────────────────────

export default function TransfersMobilePage() {
  const [sohItems, setSOHItems] = useState<StockOnHandItem[]>([]);
  const [, setAssemblies] = useState<Assembly[]>([]);
  const [consumptionSchedule, setConsumptionSchedule] = useState<Record<string, KitchenBatch[]>>({});
  const [allOpenAssemblies, setAllOpenAssemblies] = useState<Assembly[]>([]);
  const [componentNames, setComponentNames] = useState<Record<string, string>>({});
  const [drafts, setDrafts] = useState<DraftTransfer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [tab, setTab] = useState<Tab>('pending');
  const [scope, setScope] = useState<DateScope>('week');

  // Per-gap chosen source + qty (keyed by stable gapKey).
  const [pickedSource, setPickedSource] = useState<Record<string, string>>({});
  const [pickedQty, setPickedQty] = useState<Record<string, number>>({});
  // Track which gaps the operator has just added (so the card flips to "Added").
  const [added, setAdded] = useState<Record<string, string>>({});

  // ── Load ────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [kitchenRes, purchasingRes] = await Promise.all([
          fetch('/api/kitchen-data'),
          fetch('/api/purchasing-data'),
        ]);
        const kitchenJson = await kitchenRes.json();
        const purchasingJson = await purchasingRes.json();
        if (cancelled) return;
        if (!kitchenJson.success) throw new Error(kitchenJson.error || 'Kitchen data fetch failed');
        if (!purchasingJson.success) throw new Error(purchasingJson.error || 'Purchasing data fetch failed');

        const kitchenData = kitchenJson.data as { sohItems: StockOnHandItem[]; assemblies: Assembly[] };
        const purchasingData = purchasingJson.data as { sohItems: StockOnHandItem[]; assemblies: Assembly[] };

        setSOHItems(kitchenData.sohItems);
        setAssemblies(kitchenData.assemblies);

        // Kitchen demands — only intermediate (kitchen) assemblies. Packaging
        // FG lines flow through extractPackagingDemands → their own warehouse.
        const schedule = consumptionScheduleFromDemands(
          demandsFromKitchenAssemblies(
            purchasingData.assemblies,
            (a) => a.productCode in INTERMEDIATE_REGISTRY,
          ),
        );
        setConsumptionSchedule(schedule);
        setAllOpenAssemblies(purchasingData.assemblies);

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

  // Restore drafts on mount.
  useEffect(() => {
    const stored = loadDraftTransfers();
    if (stored.length > 0) setDrafts(stored);
  }, []);

  const soh = useMemo(() => new WarehouseSOH(sohItems), [sohItems]);

  // ── Gaps ────────────────────────────────────────────────
  const gaps: TransferGap[] = useMemo(() => {
    if (sohItems.length === 0) return [];
    const kitchenDemands = extractKitchenDemandsFromSchedule(consumptionSchedule);
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

  // ── Date-scope filter ────────────────────────────────────
  const visibleGaps = useMemo(() => {
    const today = todayISO();
    const weekEnd = endOfWeekISO();
    return gaps.filter((g) => {
      const iso = localISODate(g.needByDate);
      if (iso < today) return false; // hide already-overdue rows by default on mobile
      if (scope === 'today') return iso === today;
      if (scope === 'week') return iso <= weekEnd;
      return true;
    }).sort((a, b) => a.needByDate.getTime() - b.needByDate.getTime());
  }, [gaps, scope]);

  // ── Pre-fill source + qty once per gap ───────────────────
  useEffect(() => {
    setPickedSource((prev) => {
      const next = { ...prev };
      for (const g of gaps) {
        const k = gapKeyOf(g);
        if (next[k]) continue;
        const best = g.sourceOptions[0];
        if (best) next[k] = best.warehouse;
      }
      return next;
    });
    setPickedQty((prev) => {
      const next = { ...prev };
      for (const g of gaps) {
        const k = gapKeyOf(g);
        if (next[k] != null) continue;
        const best = g.sourceOptions[0];
        if (best) next[k] = Math.min(best.available, g.quantityNeeded);
      }
      return next;
    });
  }, [gaps]);

  // ── Persist drafts whenever they change ──────────────────
  useEffect(() => { saveDraftTransfers(drafts); }, [drafts]);

  const addToDrafts = useCallback((gap: TransferGap) => {
    const k = gapKeyOf(gap);
    const sourceWh = pickedSource[k];
    const qty = pickedQty[k];
    if (!sourceWh || !qty || qty <= 0) return;
    const transfer: DraftTransfer = {
      id: generateId(),
      productCode: gap.productCode,
      productName: gap.productName,
      quantity: qty,
      fromWarehouse: sourceWh,
      toWarehouse: gap.destinationWarehouse,
      needByDate: gap.needByDate,
      transferDate: subtractWorkingDays(gap.needByDate, DEFAULT_LEAD_TIME_DAYS),
      status: 'draft',
      reason: `${gap.demandSource.type === 'kitchen_batch' ? 'Kitchen' : 'Packaging'}: ${gap.demandSource.name}`,
      linkedBatchId: gap.demandSource.id,
    };
    setDrafts((prev) => [...prev, transfer]);
    setAdded((prev) => ({ ...prev, [k]: transfer.id }));
  }, [pickedSource, pickedQty]);

  const undoAdd = useCallback((gapKey: string) => {
    const draftId = added[gapKey];
    if (!draftId) return;
    setDrafts((prev) => prev.filter((d) => d.id !== draftId));
    setAdded((prev) => { const n = { ...prev }; delete n[gapKey]; return n; });
  }, [added]);

  const removeDraft = useCallback((id: string) => {
    setDrafts((prev) => prev.filter((d) => d.id !== id));
    setAdded((prev) => {
      const n = { ...prev };
      for (const [k, v] of Object.entries(n)) if (v === id) delete n[k];
      return n;
    });
  }, []);

  const pendingCount = visibleGaps.filter((g) => !added[gapKeyOf(g)]).length;

  // ── Render ──────────────────────────────────────────────
  if (loading) return <Skeleton />;
  if (error) return <ErrorView msg={error} />;

  return (
    <div style={{ maxWidth: 640, margin: '0 auto', padding: '12px 12px 96px' }}>
      {/* Tab toggle */}
      <div
        style={{
          display: 'flex',
          gap: 6,
          padding: 4,
          background: 'var(--bg-surface)',
          border: '0.5px solid var(--border)',
          borderRadius: 10,
          marginBottom: 12,
          position: 'sticky',
          top: 8,
          zIndex: 5,
          backdropFilter: 'blur(8px)',
        }}
      >
        <TabButton active={tab === 'pending'} onClick={() => setTab('pending')}
          label="Pending" count={pendingCount} />
        <TabButton active={tab === 'drafts'} onClick={() => setTab('drafts')}
          label="Drafts" count={drafts.length} />
      </div>

      {tab === 'pending' && (
        <>
          {/* Date-scope chips */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 12, overflowX: 'auto' }}>
            <ScopeChip active={scope === 'today'} onClick={() => setScope('today')} label="Today" />
            <ScopeChip active={scope === 'week'} onClick={() => setScope('week')} label="This week" />
            <ScopeChip active={scope === 'all'} onClick={() => setScope('all')} label="All upcoming" />
          </div>

          {visibleGaps.length === 0 ? (
            <EmptyState scope={scope} />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {visibleGaps.map((gap) => {
                const k = gapKeyOf(gap);
                return (
                  <GapCard
                    key={k}
                    gap={gap}
                    gapKey={k}
                    pickedSource={pickedSource[k] || ''}
                    pickedQty={pickedQty[k] ?? 0}
                    onPickSource={(wh) => setPickedSource((p) => ({ ...p, [k]: wh }))}
                    onChangeQty={(q) => setPickedQty((p) => ({ ...p, [k]: q }))}
                    addedDraftId={added[k]}
                    onAdd={() => addToDrafts(gap)}
                    onUndo={() => undoAdd(k)}
                  />
                );
              })}
            </div>
          )}
        </>
      )}

      {tab === 'drafts' && <DraftList drafts={drafts} onRemove={removeDraft} />}
    </div>
  );
}

// ─── Card ───────────────────────────────────────────────────

function GapCard({
  gap, gapKey, pickedSource, pickedQty,
  onPickSource, onChangeQty, addedDraftId, onAdd, onUndo,
}: {
  gap: TransferGap;
  gapKey: string;
  pickedSource: string;
  pickedQty: number;
  onPickSource: (wh: string) => void;
  onChangeQty: (q: number) => void;
  addedDraftId?: string;
  onAdd: () => void;
  onUndo: () => void;
}) {
  const isKit = gap.demandSource.type === 'kitchen_batch';
  const isAdded = !!addedDraftId;

  return (
    <div
      style={{
        background: 'var(--bg-surface)',
        border: `0.5px solid ${isAdded ? 'var(--success)' : 'var(--border)'}`,
        borderRadius: 12,
        padding: 12,
        boxShadow: isAdded ? '0 0 0 2px var(--success-light) inset' : undefined,
        transition: 'border-color 0.15s, box-shadow 0.15s',
      }}
      data-gap-key={gapKey}
    >
      {/* Header: badge + product */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 6 }}>
        <span style={{
          fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 4,
          color: isKit ? 'var(--success)' : 'var(--purple)',
          background: isKit ? 'var(--success-light)' : 'var(--purple-light)',
          flexShrink: 0,
        }}>
          {isKit ? 'KIT' : 'PKG'}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.2 }}>
            {gap.productName || gap.productCode}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
            {gap.productCode} · {gap.demandSource.name}
          </div>
        </div>
      </div>

      {/* From → To, big */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '10px 8px', marginTop: 6,
        background: 'var(--bg-page)', borderRadius: 8,
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>From</div>
          <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-primary)' }}>
            {pickedSource ? whShort(pickedSource) : '—'}
          </div>
        </div>
        <div aria-hidden style={{ color: 'var(--text-muted)', fontSize: 18 }}>→</div>
        <div style={{ flex: 1, minWidth: 0, textAlign: 'right' }}>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>To</div>
          <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-primary)' }}>
            {whShort(gap.destinationWarehouse)}
          </div>
        </div>
      </div>

      {/* Need by + qty needed */}
      <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>Need by</div>
          <div style={{ fontSize: 13, color: 'var(--text-primary)' }}>{formatNeedBy(gap.needByDate)}</div>
        </div>
        <div style={{ flex: 1, textAlign: 'right' }}>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>Short</div>
          <div style={{ fontSize: 13, color: 'var(--text-primary)' }}>{gap.quantityNeeded}</div>
        </div>
      </div>

      {/* Source chips */}
      {gap.sourceOptions.length > 1 && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>Source</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {gap.sourceOptions.map((s, i) => {
              const active = s.warehouse === pickedSource;
              return (
                <button
                  key={s.warehouse}
                  onClick={() => onPickSource(s.warehouse)}
                  disabled={isAdded}
                  style={{
                    padding: '6px 10px', borderRadius: 16,
                    fontSize: 12, fontWeight: 500,
                    border: `0.5px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                    background: active ? 'var(--accent-light)' : 'var(--bg-page)',
                    color: active ? 'var(--accent)' : 'var(--text-primary)',
                    cursor: isAdded ? 'default' : 'pointer',
                    opacity: isAdded ? 0.6 : 1,
                  }}
                >
                  {whShort(s.warehouse)} · {s.available}{i === 0 && !active ? ' ★' : ''}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Qty stepper + action */}
      <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' }}>
        <div style={{
          display: 'flex', alignItems: 'center',
          border: '0.5px solid var(--border)', borderRadius: 8,
          overflow: 'hidden', flexShrink: 0,
        }}>
          <button
            onClick={() => onChangeQty(Math.max(0, Math.round((pickedQty - 1) * 100) / 100))}
            disabled={isAdded}
            aria-label="Decrease qty"
            style={{
              width: 40, height: 40, fontSize: 18,
              background: 'var(--bg-page)', color: 'var(--text-primary)',
              border: 'none', cursor: isAdded ? 'default' : 'pointer',
            }}
          >−</button>
          <input
            type="number"
            inputMode="decimal"
            value={pickedQty}
            disabled={isAdded}
            onChange={(e) => onChangeQty(parseFloat(e.target.value) || 0)}
            style={{
              width: 64, height: 40, textAlign: 'center',
              fontSize: 15, fontWeight: 600,
              background: 'var(--bg-surface)', color: 'var(--text-primary)',
              border: 'none', borderLeft: '0.5px solid var(--border)', borderRight: '0.5px solid var(--border)',
              outline: 'none',
            }}
          />
          <button
            onClick={() => onChangeQty(Math.round((pickedQty + 1) * 100) / 100)}
            disabled={isAdded}
            aria-label="Increase qty"
            style={{
              width: 40, height: 40, fontSize: 18,
              background: 'var(--bg-page)', color: 'var(--text-primary)',
              border: 'none', cursor: isAdded ? 'default' : 'pointer',
            }}
          >+</button>
        </div>

        {isAdded ? (
          <button
            onClick={onUndo}
            style={{
              flex: 1, height: 40, borderRadius: 8,
              background: 'var(--success-light)', color: 'var(--success)',
              border: '0.5px solid var(--success)',
              fontSize: 14, fontWeight: 600, cursor: 'pointer',
            }}
          >
            ✓ Added · Undo
          </button>
        ) : (
          <button
            onClick={onAdd}
            disabled={!pickedSource || pickedQty <= 0}
            style={{
              flex: 1, height: 40, borderRadius: 8,
              background: 'var(--accent)', color: 'white',
              border: 'none',
              fontSize: 14, fontWeight: 600,
              cursor: !pickedSource || pickedQty <= 0 ? 'not-allowed' : 'pointer',
              opacity: !pickedSource || pickedQty <= 0 ? 0.5 : 1,
            }}
          >
            Add to drafts
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Drafts ─────────────────────────────────────────────────

function DraftList({ drafts, onRemove }: { drafts: DraftTransfer[]; onRemove: (id: string) => void }) {
  if (drafts.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)' }}>
        <div style={{ fontSize: 32, marginBottom: 8 }}>📋</div>
        <div style={{ fontSize: 14 }}>No drafts yet</div>
        <div style={{ fontSize: 12, marginTop: 4 }}>Add transfers from the Pending tab.</div>
      </div>
    );
  }
  const sorted = [...drafts].sort((a, b) => a.needByDate.getTime() - b.needByDate.getTime());
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {sorted.map((d) => (
        <div key={d.id} style={{
          background: 'var(--bg-surface)', border: '0.5px solid var(--border)',
          borderRadius: 10, padding: 10,
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
              {d.quantity} × {d.productCode}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              {whShort(d.fromWarehouse)} → {whShort(d.toWarehouse)} · {formatNeedBy(d.needByDate)}
            </div>
          </div>
          <button
            onClick={() => onRemove(d.id)}
            aria-label="Remove draft"
            style={{
              width: 36, height: 36, borderRadius: 8,
              background: 'var(--bg-page)', color: 'var(--danger)',
              border: '0.5px solid var(--border)',
              fontSize: 18, cursor: 'pointer', flexShrink: 0,
            }}
          >×</button>
        </div>
      ))}
    </div>
  );
}

// ─── Tiny components ────────────────────────────────────────

function TabButton({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count: number }) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1, height: 40, borderRadius: 8,
        background: active ? 'var(--accent-light)' : 'transparent',
        color: active ? 'var(--accent)' : 'var(--text-secondary)',
        border: 'none',
        fontSize: 14, fontWeight: 600, cursor: 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
      }}
    >
      <span>{label}</span>
      <span style={{
        fontSize: 11, padding: '1px 6px', borderRadius: 10,
        background: active ? 'var(--accent)' : 'var(--border)',
        color: active ? 'white' : 'var(--text-muted)',
      }}>{count}</span>
    </button>
  );
}

function ScopeChip({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '6px 12px', borderRadius: 16,
        fontSize: 12, fontWeight: 500,
        border: `0.5px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
        background: active ? 'var(--accent-light)' : 'var(--bg-surface)',
        color: active ? 'var(--accent)' : 'var(--text-primary)',
        cursor: 'pointer', whiteSpace: 'nowrap',
      }}
    >
      {label}
    </button>
  );
}

function EmptyState({ scope }: { scope: DateScope }) {
  const msg = scope === 'today' ? 'No transfers needed today.'
    : scope === 'week' ? 'No transfers needed this week.'
    : 'No upcoming transfers.';
  return (
    <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)' }}>
      <div style={{ fontSize: 32, marginBottom: 8 }}>✓</div>
      <div style={{ fontSize: 14 }}>{msg}</div>
    </div>
  );
}

function Skeleton() {
  return (
    <div style={{ maxWidth: 640, margin: '0 auto', padding: 12 }}>
      <div style={{ height: 48, background: 'var(--bg-surface)', borderRadius: 10, marginBottom: 12, animation: 'pulse 1.6s infinite' }} />
      {[0, 1, 2].map((i) => (
        <div key={i} style={{ height: 140, background: 'var(--bg-surface)', borderRadius: 12, marginBottom: 10, animation: 'pulse 1.6s infinite' }} />
      ))}
      <style>{`@keyframes pulse { 0%, 100% { opacity: 1 } 50% { opacity: 0.5 } }`}</style>
    </div>
  );
}

function ErrorView({ msg }: { msg: string }) {
  return (
    <div style={{ maxWidth: 640, margin: '40px auto', padding: 20, textAlign: 'center' }}>
      <div style={{ fontSize: 32, marginBottom: 8 }}>⚠️</div>
      <div style={{ fontSize: 14, color: 'var(--danger)' }}>{msg}</div>
    </div>
  );
}
