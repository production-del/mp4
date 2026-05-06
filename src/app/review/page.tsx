'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import type { DraftTransfer } from '@/lib/planning/transfer-types';
import { loadDraftTransfers } from '@/lib/planning/transfer-store';
import { dayIntToReadable, formatISOFull } from '@/lib/planning/working-day';
import { listByKind, replaceByKind, markPushed } from '@/lib/planning/plan-draft-store';
import { PushPlanDialog } from '@/app/components/PushPlanDialog';
import { buildKitchenPushTasks, buildPackagingPushTasks } from '@/lib/planning/push-tasks';

// ─── Types ─────────────────────────────────────────────────

interface PackagingDraftState {
  planned: Record<string, { quantity: number; dayInt: number }>;
  existingEdits?: Record<string, { qty: number; dayInt: number }>;
}

interface KitchenBatch {
  id: string;
  productCode: string;
  productName: string;
  quantity: number;
  scheduledDate: string;
  status: string;
  origin?: string;
  dehydrator?: string;
  intermediateKey?: string;
}

// ─── Push types ───────────────────────────────────────────

interface WarehouseRef {
  id: string;
  name: string;
}

interface BlockerEntry {
  type: 'component' | 'labels';
  familyCode: string;
  familyName: string;
  productCode?: string;
  required: number;
  available: number;
  shortfall: number;
  unit: string;
  affectedSKUs: { code: string; qty: number; dayInt: number; source: string }[];
}

interface BlockerSnapshot {
  updatedAt: string;
  blockers: BlockerEntry[];
}

// ─── Helpers ───────────────────────────────────────────────

/** Alias kept short for JSX readability; logic lives in working-day module. */
const formatDate = formatISOFull;

function loadPackagingDraft(): PackagingDraftState {
  // Reconstruct the legacy `{ planned, existingEdits }` shape from the unified
  // PlanItem store so the rest of this page's logic stays unchanged.
  const items = listByKind('packaging_run');
  const state: PackagingDraftState = { planned: {}, existingEdits: {} };
  for (const item of items) {
    if (item.action === 'CREATE') {
      state.planned[item.productCode] = { quantity: item.quantity, dayInt: item.dayInt };
    } else {
      state.existingEdits![item.productCode] = { qty: item.quantity, dayInt: item.dayInt };
    }
  }
  return state;
}

function loadKitchenBatches(): KitchenBatch[] {
  return listByKind('kitchen_run').map(i => ({
    id: i.id,
    productCode: i.productCode,
    productName: i.productName,
    quantity: i.quantity,
    scheduledDate: i.scheduledDate,
    status: i.status,
    origin: i.origin,
    dehydrator: i.dehydrator,
    intermediateKey: i.intermediateKey,
  }));
}

function loadKitchenWarehouse(): WarehouseRef {
  try {
    const raw = localStorage.getItem('byron-kitchen-config');
    if (raw) {
      const parsed = JSON.parse(raw);
      return { id: parsed.kitchenWarehouseId || '', name: parsed.kitchenWarehouseName || '' };
    }
  } catch { /* ignore */ }
  return { id: '', name: '' };
}

function loadPackagingWarehouse(): WarehouseRef {
  try {
    const raw = localStorage.getItem('byron-packaging-config');
    if (raw) {
      const settings = JSON.parse(raw).settings || {};
      return { id: settings.warehouseId || '', name: settings.warehouseName || '' };
    }
  } catch { /* ignore */ }
  return { id: '', name: '' };
}

/** Remove pushed CREATE packaging items from the unified store. */
function cleanupPackagingDraft(pushedCodes: string[]) {
  const pushedSet = new Set(pushedCodes);
  const remaining = listByKind('packaging_run').filter(
    i => !(i.action === 'CREATE' && pushedSet.has(i.productCode)),
  );
  replaceByKind('packaging_run', remaining);
}

/** Mark pushed kitchen batches as lifecycle='pushed' + origin='unleashed'. */
function cleanupKitchenDraft(pushedIds: string[]) {
  markPushed(pushedIds);
  const idSet = new Set(pushedIds);
  const items = listByKind('kitchen_run').map(i =>
    idSet.has(i.id) ? { ...i, origin: 'unleashed' as const } : i,
  );
  replaceByKind('kitchen_run', items);
}

function loadBlockers(): BlockerSnapshot {
  try {
    const raw = localStorage.getItem('byron-review-blockers');
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return { updatedAt: '', blockers: [] };
}

// ─── Page ──────────────────────────────────────────────────

export default function ReviewPage() {
  const [loaded, setLoaded] = useState(false);
  const [packagingDraft, setPackagingDraft] = useState<PackagingDraftState>({ planned: {} });
  const [kitchenBatches, setKitchenBatches] = useState<KitchenBatch[]>([]);
  const [transfers, setTransfers] = useState<DraftTransfer[]>([]);
  const [blockerSnapshot, setBlockerSnapshot] = useState<BlockerSnapshot>({ updatedAt: '', blockers: [] });
  const [showPush, setShowPush] = useState(false);
  const [kitchenWarehouse, setKitchenWarehouse] = useState<WarehouseRef>({ id: '', name: '' });
  const [packagingWarehouse, setPackagingWarehouse] = useState<WarehouseRef>({ id: '', name: '' });

  const reload = useCallback(() => {
    setPackagingDraft(loadPackagingDraft());
    setKitchenBatches(loadKitchenBatches());
    setTransfers(loadDraftTransfers());
    setBlockerSnapshot(loadBlockers());
    setKitchenWarehouse(loadKitchenWarehouse());
    setPackagingWarehouse(loadPackagingWarehouse());
  }, []);

  useEffect(() => {
    reload();
    setLoaded(true);
    window.addEventListener('focus', reload);
    return () => window.removeEventListener('focus', reload);
  }, [reload]);

  // ─── Packaging assemblies ─────────────────────────────────

  const newAssemblies = useMemo(() => {
    return Object.entries(packagingDraft.planned)
      .filter(([, plan]) => plan.quantity > 0)
      .map(([code, plan]) => ({
        productCode: code,
        quantity: plan.quantity,
        dayInt: plan.dayInt,
        action: 'CREATE' as const,
      }))
      .sort((a, b) => a.dayInt - b.dayInt || a.productCode.localeCompare(b.productCode));
  }, [packagingDraft.planned]);

  const existingEdits = useMemo(() => {
    if (!packagingDraft.existingEdits) return [];
    return Object.entries(packagingDraft.existingEdits)
      .filter(([, edit]) => edit.qty > 0)
      .map(([code, edit]) => ({
        productCode: code,
        quantity: edit.qty,
        dayInt: edit.dayInt,
        action: 'UPDATE' as const,
      }))
      .sort((a, b) => a.dayInt - b.dayInt || a.productCode.localeCompare(b.productCode));
  }, [packagingDraft.existingEdits]);

  const allAssemblies = useMemo(() => [...newAssemblies, ...existingEdits], [newAssemblies, existingEdits]);

  // ─── Kitchen batches (non-completed) ──────────────────────

  const activeBatches = useMemo(() => {
    return kitchenBatches
      .filter(b => b.status !== 'completed')
      .sort((a, b) => a.scheduledDate.localeCompare(b.scheduledDate));
  }, [kitchenBatches]);

  // ─── Draft transfers ──────────────────────────────────────

  const activeTransfers = useMemo(() => {
    return transfers
      .filter(t => t.status !== 'pushed')
      .sort((a, b) => a.transferDate.getTime() - b.transferDate.getTime());
  }, [transfers]);

  // ─── Blockers ─────────────────────────────────────────────

  const componentBlockers = useMemo(() => {
    return blockerSnapshot.blockers
      .filter(b => b.type === 'component')
      .sort((a, b) => b.shortfall - a.shortfall);
  }, [blockerSnapshot.blockers]);

  const labelBlockers = useMemo(() => {
    return blockerSnapshot.blockers
      .filter(b => b.type === 'labels')
      .sort((a, b) => b.shortfall - a.shortfall);
  }, [blockerSnapshot.blockers]);

  const totalBlockers = componentBlockers.length + labelBlockers.length;

  // ─── Pushable items ──────────────────────────────────────

  /** Kitchen draft batches only (not already in Unleashed) */
  const pushableKitchenBatches = useMemo(() => {
    return activeBatches.filter(b => b.origin !== 'unleashed');
  }, [activeBatches]);

  const pushableCount = newAssemblies.length + pushableKitchenBatches.length;

  const handlePushComplete = useCallback((
    succeededPkg: string[],
    succeededKit: string[],
  ) => {
    if (succeededPkg.length > 0) cleanupPackagingDraft(succeededPkg);
    if (succeededKit.length > 0) cleanupKitchenDraft(succeededKit);
    reload();
  }, [reload]);

  // ─── Stats ────────────────────────────────────────────────

  const stats = {
    newAssemblies: newAssemblies.length,
    existingEdits: existingEdits.length,
    kitchenBatches: activeBatches.length,
    transfers: activeTransfers.length,
    blockers: totalBlockers,
  };
  const totalItems = stats.newAssemblies + stats.existingEdits + stats.kitchenBatches + stats.transfers;

  if (!loaded) {
    return (
      <div className="h-screen flex items-center justify-center" style={{ background: 'var(--bg-page)' }}>
        <div className="text-sm" style={{ color: 'var(--text-muted)' }}>Loading drafts...</div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col overflow-hidden" style={{ background: 'var(--bg-page)', color: 'var(--text-primary)' }}>
      {/* Header */}
      <div className="px-6 pt-5 pb-4" style={{ borderBottom: '0.5px solid var(--border)' }}>
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-xl" style={{ fontWeight: 500 }}>Review Drafts</h1>
            <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
              All pending assemblies, kitchen batches, warehouse transfers, and stock blockers — nothing is pushed until you confirm.
            </p>
          </div>
          {pushableCount > 0 && (
            <button
              onClick={() => setShowPush(true)}
              className="px-4 py-2 rounded text-sm text-white transition hover:opacity-90 shrink-0"
              style={{ fontWeight: 500, background: 'var(--success)' }}
            >
              Push to Unleashed ({pushableCount})
            </button>
          )}
        </div>

        {/* Stat cards */}
        <div className="grid grid-cols-5 gap-3 mt-4">
          {[
            { label: 'New Assemblies', value: stats.newAssemblies, color: stats.newAssemblies > 0 ? 'var(--success)' : undefined },
            { label: 'Existing Edits', value: stats.existingEdits, color: stats.existingEdits > 0 ? 'var(--warning)' : undefined },
            { label: 'Kitchen Batches', value: stats.kitchenBatches, color: stats.kitchenBatches > 0 ? 'var(--accent)' : undefined },
            { label: 'Transfers', value: stats.transfers, color: stats.transfers > 0 ? 'var(--accent)' : undefined },
            { label: 'Blockers', value: stats.blockers, color: stats.blockers > 0 ? 'var(--danger)' : undefined },
          ].map(card => (
            <div key={card.label} className="rounded px-4 py-3" style={{ background: 'var(--bg-surface)' }}>
              <div className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--text-muted)', fontWeight: 500 }}>
                {card.label}
              </div>
              <div className="text-2xl mt-0.5" style={{ fontWeight: 500, color: card.color || 'var(--text-primary)' }}>
                {card.value}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">

        {totalItems === 0 && (
          <div className="flex items-center justify-center py-20">
            <div className="text-center">
              <div className="text-lg" style={{ color: 'var(--text-muted)' }}>No pending drafts</div>
              <div className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
                Plan assemblies in Packaging Plan or schedule batches in Kitchen Calendar
              </div>
            </div>
          </div>
        )}

        {/* ─── Blockers ───────────────────────────────────── */}
        {totalBlockers > 0 && (
          <Section
            title="Blockers"
            subtitle={`Insufficient stock detected — ${componentBlockers.length} component${componentBlockers.length !== 1 ? 's' : ''}, ${labelBlockers.length} label${labelBlockers.length !== 1 ? 's' : ''}${blockerSnapshot.updatedAt ? ` · last checked ${new Date(blockerSnapshot.updatedAt).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })}` : ''}`}
            badge={`${totalBlockers}`}
            badgeColor="var(--danger)"
          >
            <table className="w-full" style={{ tableLayout: 'fixed' }}>
              <colgroup>
                <col style={{ width: '8%' }} />
                <col style={{ width: '14%' }} />
                <col style={{ width: '18%' }} />
                <col style={{ width: '10%' }} />
                <col style={{ width: '10%' }} />
                <col style={{ width: '10%' }} />
                <col style={{ width: '30%' }} />
              </colgroup>
              <thead>
                <tr style={{ borderBottom: '0.5px solid var(--border)' }}>
                  {['Type', 'Family / SKU', 'Issue', 'Required', 'Available', 'Short', 'Affected Assemblies'].map(h => (
                    <th key={h} className="px-3 py-2 text-xs uppercase tracking-wider text-left" style={{ color: 'var(--text-muted)', fontWeight: 500 }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {componentBlockers.map(b => (
                  <tr key={`comp-${b.familyCode}`} style={{ borderBottom: '0.5px solid var(--border)', background: 'rgba(185, 28, 28, 0.04)' }}>
                    <td className="px-3 py-2">
                      <span className="text-[11px] px-1.5 py-0.5 rounded" style={{ background: 'var(--danger-light)', color: 'var(--danger)', fontWeight: 600 }}>
                        FOOD
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <div className="text-sm font-mono" style={{ color: 'var(--text-primary)', fontWeight: 500 }}>{b.familyCode}</div>
                      <div className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>{b.familyName}</div>
                    </td>
                    <td className="px-3 py-2 text-sm" style={{ color: 'var(--danger)', fontWeight: 500 }}>
                      {b.shortfall}{b.unit} short of intermediate
                    </td>
                    <td className="px-3 py-2 text-sm font-mono" style={{ color: 'var(--text-primary)' }}>
                      {b.required}{b.unit}
                    </td>
                    <td className="px-3 py-2 text-sm font-mono" style={{ color: 'var(--text-secondary)' }}>
                      {b.available}{b.unit}
                    </td>
                    <td className="px-3 py-2 text-sm font-mono" style={{ color: 'var(--danger)', fontWeight: 600 }}>
                      {b.shortfall}{b.unit}
                    </td>
                    <td className="px-3 py-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                      <div className="flex flex-wrap gap-1">
                        {b.affectedSKUs.map((s, i) => (
                          <span key={i} className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded" style={{ background: 'var(--bg-surface)', border: '0.5px solid var(--border)' }}>
                            <span className="font-mono">{s.code}</span>
                            <span style={{ color: 'var(--text-muted)' }}>&times;{s.qty}</span>
                            {s.dayInt > 0 && <span style={{ color: 'var(--text-muted)' }}>d{s.dayInt}</span>}
                          </span>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
                {labelBlockers.map(b => (
                  <tr key={`lbl-${b.productCode}`} style={{ borderBottom: '0.5px solid var(--border)', background: 'rgba(180, 83, 9, 0.04)' }}>
                    <td className="px-3 py-2">
                      <span className="text-[11px] px-1.5 py-0.5 rounded" style={{ background: 'var(--warning-light)', color: 'var(--warning)', fontWeight: 600 }}>
                        LABEL
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <div className="text-sm font-mono" style={{ color: 'var(--text-primary)', fontWeight: 500 }}>{b.productCode}</div>
                      <div className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>{b.familyName}</div>
                    </td>
                    <td className="px-3 py-2 text-sm" style={{ color: 'var(--warning)', fontWeight: 500 }}>
                      {b.shortfall} labels short
                    </td>
                    <td className="px-3 py-2 text-sm font-mono" style={{ color: 'var(--text-primary)' }}>
                      {b.required}
                    </td>
                    <td className="px-3 py-2 text-sm font-mono" style={{ color: 'var(--text-secondary)' }}>
                      {b.available}
                    </td>
                    <td className="px-3 py-2 text-sm font-mono" style={{ color: 'var(--warning)', fontWeight: 600 }}>
                      {b.shortfall}
                    </td>
                    <td className="px-3 py-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                      <div className="flex flex-wrap gap-1">
                        {b.affectedSKUs.map((s, i) => (
                          <span key={i} className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded" style={{ background: 'var(--bg-surface)', border: '0.5px solid var(--border)' }}>
                            <span className="font-mono">{s.code}</span>
                            <span style={{ color: 'var(--text-muted)' }}>&times;{s.qty}</span>
                            {s.dayInt > 0 && <span style={{ color: 'var(--text-muted)' }}>d{s.dayInt}</span>}
                          </span>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
        )}

        {/* ─── Packaging Assemblies (CREATE) ──────────────── */}
        {newAssemblies.length > 0 && (
          <Section
            title="New Assemblies"
            subtitle="Will CREATE new assembly orders in Unleashed when pushed from Packaging Plan"
            badge={`${newAssemblies.length}`}
            badgeColor="var(--success)"
          >
            <table className="w-full" style={{ tableLayout: 'fixed' }}>
              <colgroup>
                <col style={{ width: '8%' }} />
                <col style={{ width: '32%' }} />
                <col style={{ width: '15%' }} />
                <col style={{ width: '15%' }} />
                <col style={{ width: '15%' }} />
                <col style={{ width: '15%' }} />
              </colgroup>
              <thead>
                <tr style={{ borderBottom: '0.5px solid var(--border)' }}>
                  {['Action', 'Product Code', 'Quantity', 'Day', 'Schedule', 'Status'].map(h => (
                    <th key={h} className="px-3 py-2 text-xs uppercase tracking-wider text-left" style={{ color: 'var(--text-muted)', fontWeight: 500 }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {newAssemblies.map(a => (
                  <tr key={a.productCode} style={{ borderBottom: '0.5px solid var(--border)' }}>
                    <td className="px-3 py-2">
                      <span className="text-[11px] px-1.5 py-0.5 rounded" style={{ background: 'var(--success-light)', color: 'var(--success)', fontWeight: 600 }}>
                        CREATE
                      </span>
                    </td>
                    <td className="px-3 py-2 text-sm font-mono" style={{ color: 'var(--text-primary)' }}>
                      {a.productCode}
                    </td>
                    <td className="px-3 py-2 text-sm font-mono" style={{ color: 'var(--text-primary)', fontWeight: 500 }}>
                      {a.quantity}
                    </td>
                    <td className="px-3 py-2 text-sm font-mono" style={{ color: 'var(--text-secondary)' }}>
                      {a.dayInt > 0 ? a.dayInt : '—'}
                    </td>
                    <td className="px-3 py-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
                      {a.dayInt > 0 ? dayIntToReadable(a.dayInt) : 'No date set'}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className="text-[11px] px-1.5 py-0.5 rounded"
                        style={{
                          background: a.dayInt > 0 ? 'var(--accent-light)' : 'var(--warning-light)',
                          color: a.dayInt > 0 ? 'var(--accent)' : 'var(--warning)',
                          fontWeight: 500,
                        }}
                      >
                        {a.dayInt > 0 ? 'Ready' : 'Needs date'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
        )}

        {/* ─── Packaging Assemblies (UPDATE) ──────────────── */}
        {existingEdits.length > 0 && (
          <Section
            title="Existing Assembly Edits"
            subtitle="Will UPDATE existing assembly orders in Unleashed when pushed from Packaging Plan"
            badge={`${existingEdits.length}`}
            badgeColor="var(--warning)"
          >
            <table className="w-full" style={{ tableLayout: 'fixed' }}>
              <colgroup>
                <col style={{ width: '8%' }} />
                <col style={{ width: '32%' }} />
                <col style={{ width: '15%' }} />
                <col style={{ width: '15%' }} />
                <col style={{ width: '15%' }} />
                <col style={{ width: '15%' }} />
              </colgroup>
              <thead>
                <tr style={{ borderBottom: '0.5px solid var(--border)' }}>
                  {['Action', 'Product Code', 'New Qty', 'Day', 'Schedule', 'Status'].map(h => (
                    <th key={h} className="px-3 py-2 text-xs uppercase tracking-wider text-left" style={{ color: 'var(--text-muted)', fontWeight: 500 }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {existingEdits.map(a => (
                  <tr key={a.productCode} style={{ borderBottom: '0.5px solid var(--border)' }}>
                    <td className="px-3 py-2">
                      <span className="text-[11px] px-1.5 py-0.5 rounded" style={{ background: 'var(--warning-light)', color: 'var(--warning)', fontWeight: 600 }}>
                        UPDATE
                      </span>
                    </td>
                    <td className="px-3 py-2 text-sm font-mono" style={{ color: 'var(--text-primary)' }}>
                      {a.productCode}
                    </td>
                    <td className="px-3 py-2 text-sm font-mono" style={{ color: 'var(--warning)', fontWeight: 500 }}>
                      {a.quantity}
                    </td>
                    <td className="px-3 py-2 text-sm font-mono" style={{ color: 'var(--text-secondary)' }}>
                      {a.dayInt > 0 ? a.dayInt : '—'}
                    </td>
                    <td className="px-3 py-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
                      {a.dayInt > 0 ? dayIntToReadable(a.dayInt) : 'No date set'}
                    </td>
                    <td className="px-3 py-2">
                      <span className="text-[11px] px-1.5 py-0.5 rounded" style={{ background: 'var(--warning-light)', color: 'var(--warning)', fontWeight: 500 }}>
                        Modified
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
        )}

        {/* ─── Kitchen Batches ────────────────────────────── */}
        {activeBatches.length > 0 && (
          <Section
            title="Kitchen Batches"
            subtitle="Scheduled intermediate batches — planned or in-progress on the Kitchen Calendar"
            badge={`${activeBatches.length}`}
            badgeColor="var(--accent)"
          >
            <table className="w-full" style={{ tableLayout: 'fixed' }}>
              <colgroup>
                <col style={{ width: '8%' }} />
                <col style={{ width: '20%' }} />
                <col style={{ width: '20%' }} />
                <col style={{ width: '12%' }} />
                <col style={{ width: '15%' }} />
                <col style={{ width: '12%' }} />
                <col style={{ width: '13%' }} />
              </colgroup>
              <thead>
                <tr style={{ borderBottom: '0.5px solid var(--border)' }}>
                  {['Origin', 'Intermediate', 'Name', 'Qty (kg)', 'Scheduled', 'Equipment', 'Status'].map(h => (
                    <th key={h} className="px-3 py-2 text-xs uppercase tracking-wider text-left" style={{ color: 'var(--text-muted)', fontWeight: 500 }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {activeBatches.map(b => (
                  <tr key={b.id} style={{ borderBottom: '0.5px solid var(--border)' }}>
                    <td className="px-3 py-2">
                      <span
                        className="text-[11px] px-1.5 py-0.5 rounded"
                        style={{
                          background: b.origin === 'unleashed' ? 'var(--accent-light)' : 'var(--bg-surface)',
                          color: b.origin === 'unleashed' ? 'var(--accent)' : 'var(--text-secondary)',
                          fontWeight: 500,
                          border: b.origin !== 'unleashed' ? '0.5px solid var(--border)' : undefined,
                        }}
                      >
                        {b.origin === 'unleashed' ? 'Live' : 'Draft'}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-sm font-mono" style={{ color: 'var(--text-primary)' }}>
                      {b.productCode}
                    </td>
                    <td className="px-3 py-2 text-sm truncate" style={{ color: 'var(--text-secondary)' }}>
                      {b.productName}
                    </td>
                    <td className="px-3 py-2 text-sm font-mono" style={{ color: 'var(--text-primary)', fontWeight: 500 }}>
                      {b.quantity}kg
                    </td>
                    <td className="px-3 py-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
                      {formatDate(b.scheduledDate)}
                    </td>
                    <td className="px-3 py-2 text-sm" style={{ color: 'var(--text-muted)' }}>
                      {b.dehydrator || '—'}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className="text-[11px] px-1.5 py-0.5 rounded capitalize"
                        style={{
                          background: b.status === 'in_progress' ? 'var(--warning-light)' : 'var(--bg-surface)',
                          color: b.status === 'in_progress' ? 'var(--warning)' : 'var(--text-secondary)',
                          fontWeight: 500,
                          border: b.status !== 'in_progress' ? '0.5px solid var(--border)' : undefined,
                        }}
                      >
                        {b.status.replace('_', ' ')}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
        )}

        {/* ─── Warehouse Transfers ────────────────────────── */}
        {activeTransfers.length > 0 && (
          <Section
            title="Warehouse Transfers"
            subtitle="Draft inter-warehouse stock transfers planned in Logistics"
            badge={`${activeTransfers.length}`}
            badgeColor="var(--accent)"
          >
            <table className="w-full" style={{ tableLayout: 'fixed' }}>
              <colgroup>
                <col style={{ width: '8%' }} />
                <col style={{ width: '15%' }} />
                <col style={{ width: '15%' }} />
                <col style={{ width: '10%' }} />
                <col style={{ width: '15%' }} />
                <col style={{ width: '15%' }} />
                <col style={{ width: '12%' }} />
                <col style={{ width: '10%' }} />
              </colgroup>
              <thead>
                <tr style={{ borderBottom: '0.5px solid var(--border)' }}>
                  {['Status', 'Product', 'Reason', 'Qty', 'From', 'To', 'Transfer Date', 'Need By'].map(h => (
                    <th key={h} className="px-3 py-2 text-xs uppercase tracking-wider text-left" style={{ color: 'var(--text-muted)', fontWeight: 500 }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {activeTransfers.map(t => (
                  <tr key={t.id} style={{ borderBottom: '0.5px solid var(--border)' }}>
                    <td className="px-3 py-2">
                      <span
                        className="text-[11px] px-1.5 py-0.5 rounded capitalize"
                        style={{
                          background: t.status === 'confirmed' ? 'var(--success-light)' : 'var(--bg-surface)',
                          color: t.status === 'confirmed' ? 'var(--success)' : 'var(--text-secondary)',
                          fontWeight: 500,
                          border: t.status !== 'confirmed' ? '0.5px solid var(--border)' : undefined,
                        }}
                      >
                        {t.status}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-sm font-mono" style={{ color: 'var(--text-primary)' }}>
                      {t.productCode}
                    </td>
                    <td className="px-3 py-2 text-sm truncate" style={{ color: 'var(--text-secondary)' }} title={t.reason}>
                      {t.reason}
                    </td>
                    <td className="px-3 py-2 text-sm font-mono" style={{ color: 'var(--text-primary)', fontWeight: 500 }}>
                      {t.quantity}
                    </td>
                    <td className="px-3 py-2 text-sm truncate" style={{ color: 'var(--text-secondary)' }}>
                      {t.fromWarehouse}
                    </td>
                    <td className="px-3 py-2 text-sm truncate" style={{ color: 'var(--text-secondary)' }}>
                      {t.toWarehouse}
                    </td>
                    <td className="px-3 py-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
                      {t.transferDate.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}
                    </td>
                    <td className="px-3 py-2 text-sm" style={{
                      color: t.needByDate < new Date() ? 'var(--danger)' : 'var(--text-secondary)',
                      fontWeight: t.needByDate < new Date() ? 500 : 400,
                    }}>
                      {t.needByDate.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
        )}
      </div>

      {/* Push dialog */}
      {showPush && (() => {
        // Build kitchen tasks. We don't have intermediate BOM context here —
        // the push-tasks helper sends empty assemblyLines and Unleashed
        // resolves the BOM from the saved definition.
        const kitchenTasks = buildKitchenPushTasks(
          pushableKitchenBatches.map(b => ({
            kind: 'kitchen_run' as const,
            id: b.id,
            productCode: b.productCode,
            productName: b.productName,
            quantity: b.quantity,
            lifecycle: 'draft' as const,
            scheduledDate: b.scheduledDate,
            intermediateKey: b.intermediateKey || '',
            dehydrator: b.dehydrator as 'midgy' | 'mama' | 'papa' | undefined,
            origin: 'draft' as const,
            status: 'planned' as const,
          })),
          { warehouseId: kitchenWarehouse.id, warehouseName: kitchenWarehouse.name },
        );

        // Build packaging CREATE tasks. Same SKU-less shortcut: Unleashed resolves BOM.
        const packagingTasks = buildPackagingPushTasks(
          newAssemblies.map(a => ({
            kind: 'packaging_run' as const,
            id: `pkg:create:${a.productCode}`,
            productCode: a.productCode,
            productName: a.productCode,
            quantity: a.quantity,
            lifecycle: 'draft' as const,
            dayInt: a.dayInt,
            scheduledDate: '',
            action: 'CREATE' as const,
          })),
          { warehouseId: packagingWarehouse.id, warehouseName: packagingWarehouse.name },
        );

        const tasks = [...packagingTasks, ...kitchenTasks];

        // Map succeeded ids back to the shapes handlePushComplete expects.
        const kitchenIdSet = new Set(pushableKitchenBatches.map(b => b.id));
        const packagingCodeById = new Map(
          newAssemblies.map(a => [`pkg:create:${a.productCode}`, a.productCode]),
        );

        const disableReason =
          (newAssemblies.length > 0 && !packagingWarehouse.id && !kitchenWarehouse.id)
            ? 'Kitchen and Packaging warehouses not configured.'
            : (newAssemblies.length > 0 && !packagingWarehouse.id)
              ? 'Packaging warehouse not configured.'
              : (pushableKitchenBatches.length > 0 && !kitchenWarehouse.id)
                ? 'Kitchen warehouse not resolved.'
                : null;

        const subtitleBits: string[] = [];
        if (existingEdits.length > 0) {
          subtitleBits.push(`${existingEdits.length} existing assembly edit${existingEdits.length !== 1 ? 's' : ''} skipped — use Packaging Plan to push updates.`);
        }
        if (activeTransfers.length > 0) {
          subtitleBits.push(`${activeTransfers.length} warehouse transfer${activeTransfers.length !== 1 ? 's' : ''} must be actioned manually in Unleashed.`);
        }

        return (
          <PushPlanDialog
            tasks={tasks}
            onClose={() => setShowPush(false)}
            onComplete={(ids) => {
              const kitIds = ids.filter(i => kitchenIdSet.has(i));
              const pkgCodes = ids
                .map(i => packagingCodeById.get(i))
                .filter((c): c is string => !!c);
              handlePushComplete(pkgCodes, kitIds);
            }}
            subtitle={subtitleBits.join(' ') || undefined}
            disableReason={disableReason}
          />
        );
      })()}
    </div>
  );
}


// ─── Section wrapper ──────────────────────────────────────────

function Section({
  title,
  subtitle,
  badge,
  badgeColor,
  defaultCollapsed = false,
  children,
}: {
  title: string;
  subtitle: string;
  badge: string;
  badgeColor: string;
  defaultCollapsed?: boolean;
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  return (
    <div className="rounded" style={{ border: '0.5px solid var(--border)' }}>
      <button
        className="w-full px-4 py-3 text-left hover:opacity-80 transition"
        style={{ background: 'var(--bg-surface)', borderBottom: collapsed ? 'none' : '0.5px solid var(--border)', borderRadius: collapsed ? '4px' : '4px 4px 0 0' }}
        onClick={() => setCollapsed(!collapsed)}
      >
        <div className="flex items-center gap-2">
          <span className="text-sm" style={{ color: 'var(--text-muted)' }}>{collapsed ? '▶' : '▼'}</span>
          <span className="text-sm" style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{title}</span>
          <span
            className="text-[11px] px-1.5 py-0.5 rounded"
            style={{ fontWeight: 600, color: badgeColor, background: `color-mix(in srgb, ${badgeColor} 15%, transparent)` }}
          >
            {badge}
          </span>
        </div>
        {!collapsed && <div className="text-xs mt-0.5 ml-5" style={{ color: 'var(--text-muted)' }}>{subtitle}</div>}
      </button>
      {!collapsed && (
        <div className="overflow-x-auto">
          {children}
        </div>
      )}
    </div>
  );
}
