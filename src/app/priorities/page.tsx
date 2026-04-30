'use client';

/**
 * Priorities page.
 *
 * For every product flagged as priority (on Products page) whose
 * `availableStock` is at or below the configured threshold, compute a
 * proposal: how many to pack, which intermediate + transfer are required,
 * and which sales orders are waiting. Operator edits the quantity if they
 * wish and clicks Approve — at which point the proposal becomes a real
 * `PackagingRunItem` (+ optional `TransferItem`) in the unified draft store.
 *
 * Derived state, every mount. Proposals are never persisted; only approved
 * items enter `byron-plan-drafts-v1`.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePackagingData, type PackagingSKU } from '@/app/packaging/hooks/usePackagingData';
import { usePackagingConfig } from '@/app/packaging/hooks/usePackagingConfig';
import { listPriorityFlags } from '@/lib/planning/priority-flags';
import { readPrioritySettings } from '@/lib/planning/priority-settings';
import {
  buildPriorityProposals,
  type PriorityProposal,
} from '@/lib/planning/priority-proposals';
import { upsertMany } from '@/lib/planning/plan-draft-store';
import type { PackagingRunItem, TransferItem } from '@/lib/planning/plan-item';
import { WAREHOUSES } from '@/lib/planning/warehouse-assignments';
import { dayIntToISO, dateToDayInt, toLocalISODate } from '@/lib/planning/working-day';
import type { SalesOrderAttribution } from '@/app/api/sales-orders/route';

const PACKAGING_WAREHOUSE = WAREHOUSES.MF_PACKAGING;

export default function PrioritiesPage() {
  const config = usePackagingConfig();
  const { skus, soh, loading, error, refetch } = usePackagingData(
    config.settings,
    config.monthlyUsage,
    config.familyTargetDays,
  );

  // Priority flags + settings refresh when the operator toggles something on
  // another page. We re-read from localStorage on focus and on a manual
  // refresh click, same pattern the review page uses.
  const [flagsVersion, setFlagsVersion] = useState(0);
  const flags = useMemo(() => {
    void flagsVersion;
    return listPriorityFlags();
  }, [flagsVersion]);
  const prioritySettings = useMemo(() => {
    void flagsVersion;
    return readPrioritySettings();
  }, [flagsVersion]);

  useEffect(() => {
    const onFocus = () => setFlagsVersion(v => v + 1);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  // Flagged product codes → fetch sales orders for just these products so
  // the attribution column is populated with real customer + order data.
  const flaggedCodes = useMemo(
    () =>
      Object.entries(flags)
        .filter(([, f]) => f.enabled)
        .map(([code]) => code),
    [flags],
  );

  const [salesOrdersByProduct, setSalesOrdersByProduct] = useState<
    Record<string, SalesOrderAttribution[]>
  >({});
  const [ordersLoading, setOrdersLoading] = useState(false);

  useEffect(() => {
    if (flaggedCodes.length === 0) {
      setSalesOrdersByProduct({});
      return;
    }
    let cancelled = false;
    setOrdersLoading(true);
    const params = new URLSearchParams({ products: flaggedCodes.join(',') });
    fetch(`/api/sales-orders?${params.toString()}`)
      .then(r => r.json())
      .then(j => {
        if (cancelled) return;
        if (j.success) setSalesOrdersByProduct(j.data.byProduct || {});
      })
      .catch(() => {
        /* tolerable — proposals still render without SO attribution */
      })
      .finally(() => {
        if (!cancelled) setOrdersLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [flaggedCodes]);

  // Build proposals whenever inputs change. Pure function; no side effects.
  const proposals = useMemo<PriorityProposal[]>(() => {
    if (!soh || skus.length === 0) return [];
    return buildPriorityProposals({
      skus,
      flags,
      settings: prioritySettings,
      salesOrdersByProduct,
      soh,
      packagingWarehouse: PACKAGING_WAREHOUSE,
    });
  }, [skus, soh, flags, prioritySettings, salesOrdersByProduct]);

  // Proposed qty is editable per row; default = deficit.
  const [qtyOverrides, setQtyOverrides] = useState<Record<string, number>>({});
  const effectiveQty = useCallback(
    (p: PriorityProposal) => qtyOverrides[p.productCode] ?? p.deficitQty,
    [qtyOverrides],
  );

  const skuByCode = useMemo(() => {
    const m = new Map<string, PackagingSKU>();
    for (const s of skus) m.set(s.productCode, s);
    return m;
  }, [skus]);

  // ── Approval ────────────────────────────────────────────
  const handleApprove = useCallback(
    (p: PriorityProposal) => {
      const qty = Math.max(0, Math.round(effectiveQty(p)));
      if (qty <= 0) return;

      const sku = skuByCode.get(p.productCode);
      // Pick the nearest working-day (today's dayInt). This is consistent with
      // how the rest of the planner treats "schedule this now".
      const now = new Date();
      const dayInt = dateToDayInt(now);
      const scheduledDate = toLocalISODate(now);

      const packagingItem: PackagingRunItem = {
        kind: 'packaging_run',
        id: `pkg:priority:${p.productCode}:${Date.now()}`,
        productCode: p.productCode,
        productName: sku?.productName ?? p.productName,
        quantity: qty,
        lifecycle: 'draft',
        dayInt,
        scheduledDate: dayIntToISO(dayInt),
        action: 'CREATE',
        prioritySource: true,
        salesOrders: p.salesOrders.map(s => s.orderNumber),
      };

      const items: Array<PackagingRunItem | TransferItem> = [packagingItem];

      // Amber → include a Transfer proposal for the intermediate.
      if (p.feasibility === 'amber' && p.transferSource && p.transferKg && p.transferKg > 0) {
        const transfer: TransferItem = {
          kind: 'transfer',
          id: `txfr:priority:${p.productCode}:${Date.now()}`,
          productCode: p.foodComponentCode,
          productName: `${p.familyName} (${p.foodComponentCode})`,
          quantity: Math.ceil(p.transferKg),
          lifecycle: 'draft',
          transferDate: scheduledDate,
          needByDate: scheduledDate,
          fromWarehouse: p.transferSource,
          toWarehouse: PACKAGING_WAREHOUSE,
          status: 'draft',
          reason: `Priority: ${p.productName} (${p.productCode})`,
          linkedBatchId: packagingItem.id,
        };
        items.push(transfer);
      }

      upsertMany(items);
      // Bump version so the proposal disappears on next render (it now lives
      // in byron-plan-drafts-v1 as a real draft; the page re-derives from
      // flags + SOH which haven't changed, so we have to re-compute).
      setFlagsVersion(v => v + 1);
      // Clear any qty override for this row.
      setQtyOverrides(o => {
        const next = { ...o };
        delete next[p.productCode];
        return next;
      });
    },
    [effectiveQty, skuByCode],
  );

  // Render ────────────────────────────────────────────────

  if (loading && skus.length === 0) {
    return (
      <div className="h-screen flex items-center justify-center" style={{ background: 'var(--bg-page)' }}>
        <div className="text-sm" style={{ color: 'var(--text-muted)' }}>Loading priority data…</div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col overflow-hidden" style={{ background: 'var(--bg-page)', color: 'var(--text-primary)' }}>
      {/* Header */}
      <div className="px-6 pt-5 pb-4" style={{ borderBottom: '0.5px solid var(--border)' }}>
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-xl" style={{ fontWeight: 500 }}>Priorities</h1>
            <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
              Flagged products whose available stock has gone negative. Approve a row to create a draft
              assembly (plus a transfer if needed) in Review Drafts and the Packaging Plan calendar.
            </p>
          </div>
          <button
            onClick={() => {
              refetch();
              setFlagsVersion(v => v + 1);
            }}
            className="text-xs px-3 py-1.5 rounded transition hover:opacity-80"
            style={{
              color: 'var(--text-secondary)',
              background: 'var(--bg-surface)',
              border: '0.5px solid var(--border)',
            }}
          >
            Refresh
          </button>
        </div>

        {/* Summary strip */}
        <div className="flex gap-6 mt-4 text-xs">
          <Stat label="Flagged products" value={flaggedCodes.length} />
          <Stat label="Proposals live" value={proposals.length} color="var(--warning)" />
          <Stat
            label="Attributed orders"
            value={Object.values(salesOrdersByProduct).reduce((n, list) => n + list.length, 0)}
          />
          {error && (
            <span style={{ color: 'var(--danger)' }}>{typeof error === 'string' ? error : 'Data error'}</span>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto px-6 py-4">
        {proposals.length === 0 ? (
          <EmptyState flaggedCount={flaggedCodes.length} ordersLoading={ordersLoading} />
        ) : (
          <table className="w-full text-xs" style={{ borderCollapse: 'separate', borderSpacing: 0 }}>
            <thead className="sticky top-0 z-10">
              <tr>
                {['Product', 'Deficit', 'Suggest', 'Proposed', 'Ceiling', 'Status', 'Transfer', 'Orders', 'Approve'].map(h => (
                  <th
                    key={h}
                    className={`px-3 py-2 ${['Deficit', 'Suggest', 'Proposed', 'Ceiling'].includes(h) ? 'text-right' : 'text-left'}`}
                    style={{
                      fontWeight: 600,
                      fontSize: 11,
                      color: 'var(--text-secondary)',
                      background: 'var(--bg-surface)',
                      borderBottom: '0.5px solid var(--border)',
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {proposals.map(p => (
                <ProposalRow
                  key={p.productCode}
                  proposal={p}
                  proposedQty={effectiveQty(p)}
                  onProposedQtyChange={(qty) => {
                    setQtyOverrides(o => ({ ...o, [p.productCode]: qty }));
                  }}
                  onApprove={() => handleApprove(p)}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ─── Row ─────────────────────────────────────────────────

function ProposalRow({
  proposal,
  proposedQty,
  onProposedQtyChange,
  onApprove,
}: {
  proposal: PriorityProposal;
  proposedQty: number;
  onProposedQtyChange: (n: number) => void;
  onApprove: () => void;
}) {
  const p = proposal;
  const clampedQty = Math.min(
    Math.max(0, Math.round(proposedQty)),
    isFinite(p.ingredientLimitQty) ? p.ingredientLimitQty : Number.MAX_SAFE_INTEGER,
  );
  const overCeiling = proposedQty > p.ingredientLimitQty;
  const canApprove = clampedQty > 0 && !overCeiling;

  const feasColor =
    p.feasibility === 'green' ? 'var(--success)'
    : p.feasibility === 'amber' ? 'var(--warning)'
    : 'var(--danger)';
  const feasBg =
    p.feasibility === 'green' ? 'color-mix(in srgb, var(--success) 12%, var(--bg-surface))'
    : p.feasibility === 'amber' ? 'color-mix(in srgb, var(--warning) 12%, var(--bg-surface))'
    : 'color-mix(in srgb, var(--danger) 14%, var(--bg-surface))';

  return (
    <tr style={{ borderBottom: '0.5px solid var(--border)', background: feasBg }}>
      <td className="px-3 py-2 align-top" style={{ minWidth: 200 }}>
        <div className="font-mono" style={{ fontWeight: 500, color: 'var(--text-primary)' }}>
          {p.productCode}
        </div>
        <div className="text-[11px] truncate" style={{ color: 'var(--text-muted)', maxWidth: 220 }} title={p.productName}>
          {p.productName}
        </div>
      </td>
      <td className="px-3 py-2 text-right font-mono align-top" style={{ color: 'var(--danger)', fontWeight: 500 }}>
        {p.availableStock}
      </td>
      <td className="px-3 py-2 text-right font-mono align-top" style={{ color: 'var(--text-muted)' }}>
        {p.suggestedQty > 0 ? p.suggestedQty : '—'}
      </td>
      <td className="px-3 py-2 text-right align-top">
        <input
          type="number"
          min={0}
          step={1}
          value={Number.isFinite(proposedQty) ? proposedQty : 0}
          onChange={(e) => onProposedQtyChange(Number(e.target.value))}
          className="w-20 px-2 py-1 text-right font-mono text-xs rounded"
          style={{
            background: 'var(--bg-page)',
            border: `0.5px solid ${overCeiling ? 'var(--danger)' : 'var(--border)'}`,
            color: overCeiling ? 'var(--danger)' : 'var(--text-primary)',
            fontWeight: 500,
          }}
          title={overCeiling ? `Exceeds ingredient ceiling of ${p.ingredientLimitQty}` : ''}
        />
      </td>
      <td
        className="px-3 py-2 text-right font-mono align-top"
        style={{ color: overCeiling ? 'var(--danger)' : 'var(--text-muted)' }}
        title="Max units you can propose given available intermediate across every warehouse"
      >
        {Number.isFinite(p.ingredientLimitQty) ? p.ingredientLimitQty : '∞'}
      </td>
      <td className="px-3 py-2 align-top">
        <span
          className="text-[10px] px-2 py-0.5 rounded uppercase tracking-wider"
          style={{ fontWeight: 600, color: feasColor, background: 'var(--bg-page)' }}
          title={p.feasibilityReason}
        >
          {p.feasibility}
        </span>
      </td>
      <td className="px-3 py-2 align-top" style={{ fontSize: 11 }}>
        {p.feasibility === 'amber' && p.transferSource ? (
          <div>
            <div style={{ color: 'var(--text-secondary)' }}>
              <span style={{ color: 'var(--text-muted)' }}>From</span>{' '}
              <span style={{ fontWeight: 500 }}>{p.transferSource}</span>
            </div>
            <div className="font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>
              {Math.ceil(p.transferKg || 0)}kg of {p.foodComponentCode}
            </div>
          </div>
        ) : p.feasibility === 'red' ? (
          <span style={{ color: 'var(--danger)' }}>Insufficient globally</span>
        ) : (
          <span style={{ color: 'var(--text-muted)' }}>No transfer needed</span>
        )}
      </td>
      <td className="px-3 py-2 align-top" style={{ minWidth: 180, maxWidth: 260 }}>
        {p.salesOrders.length === 0 ? (
          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>—</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {p.salesOrders.slice(0, 6).map(s => (
              <span
                key={`${s.orderNumber}-${s.line.lineNumber}`}
                className="text-[10px] px-1.5 py-0.5 rounded"
                style={{
                  background: s.orderStatus === 'Backordered' ? 'var(--warning-light)' : 'var(--bg-surface)',
                  color: s.orderStatus === 'Backordered' ? 'var(--warning)' : 'var(--text-secondary)',
                  fontWeight: 500,
                  border: '0.5px solid var(--border)',
                }}
                title={`${s.customerName} — ${s.orderStatus} — ${s.line.quantityOrdered} ordered${s.requiredDate ? ', need by ' + s.requiredDate.slice(0, 10) : ''}`}
              >
                {s.orderNumber} · {s.line.quantityOrdered}
              </span>
            ))}
            {p.salesOrders.length > 6 && (
              <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                +{p.salesOrders.length - 6} more
              </span>
            )}
          </div>
        )}
      </td>
      <td className="px-3 py-2 align-top text-right">
        <button
          onClick={onApprove}
          disabled={!canApprove}
          className="text-xs px-3 py-1.5 rounded text-white transition hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
          style={{ fontWeight: 500, background: 'var(--success)' }}
          title={!canApprove ? 'Adjust qty within the ceiling' : 'Create draft assembly + transfer'}
        >
          Approve
        </button>
      </td>
    </tr>
  );
}

// ─── Empty state ─────────────────────────────────────────

function EmptyState({
  flaggedCount,
  ordersLoading,
}: {
  flaggedCount: number;
  ordersLoading: boolean;
}) {
  return (
    <div className="flex items-center justify-center py-20">
      <div className="text-center max-w-md">
        <div className="text-base" style={{ color: 'var(--text-secondary)', fontWeight: 500 }}>
          No priorities right now
        </div>
        <p className="text-sm mt-2" style={{ color: 'var(--text-muted)' }}>
          {flaggedCount === 0 ? (
            <>
              No products are flagged yet. Open <a href="/products" className="underline" style={{ color: 'var(--accent)' }}>Products</a> and enable the <strong>Priority</strong> checkbox for SKUs you want watched.
            </>
          ) : ordersLoading ? (
            <>Fetching sales-order data for {flaggedCount} flagged product{flaggedCount === 1 ? '' : 's'}…</>
          ) : (
            <>
              {flaggedCount} product{flaggedCount === 1 ? ' is' : 's are'} flagged — none have gone negative.
              Proposals will appear here when availability drops below the deficit threshold.
            </>
          )}
        </p>
      </div>
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span style={{ color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, fontSize: 10 }}>
        {label}
      </span>
      <span style={{ color: color || 'var(--text-primary)', fontWeight: 500, fontSize: 14 }}>
        {value}
      </span>
    </span>
  );
}
