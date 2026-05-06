'use client';

import { useState, useEffect } from 'react';
import type { ProductFamily } from '../hooks/usePackagingData';
import type { KitchenPlannedInfo } from '../hooks/useKitchenBatches';
import { SKURow } from './SKURow';
import { useCellNavigation } from '../context/CellNavigationContext';

interface ProductFamilyGroupProps {
  family: ProductFamily;
  getPlanned: (productCode: string) => { quantity: number; dayInt: number } | null;
  onSetQty: (productCode: string, qty: number) => void;
  onSetDay: (productCode: string, dayInt: number) => void;
  onSetExistingQty: (productCode: string, qty: number) => void;
  onSetExistingDay: (productCode: string, dayInt: number) => void;
  getExistingQty: (productCode: string) => number | null;
  getExistingDay: (productCode: string) => number | null;
  onFillSuggestion: (productCode: string) => void;
  onFillFamily: (familyCode: string) => void;
  onSetFamilyDay: (familyCode: string, dayInt: number) => void;
  onSetUsage: (productCode: string, usage: number) => void;
  familyTargetDays: number;
  onSetFamilyTargetDays: (familyCode: string, days: number) => void;
  onClearFamilyTargetDays: (familyCode: string) => void;
  globalTargetDays: number;
  plannedKg: number;
  kitchenPlanned: KitchenPlannedInfo | null;
  defaultCollapsed?: boolean;
  onOpenModal?: (productCode: string) => void;
}

function urgencyStyle(days: number): { text: string; color: string; bg: string } {
  if (days === Infinity) return { text: 'No usage data', color: 'var(--text-muted)', bg: 'var(--bg-surface)' };
  if (days < 7) return { text: `CRITICAL: ${Math.round(days)}d`, color: 'var(--danger)', bg: 'var(--danger-light)' };
  if (days < 14) return { text: `URGENT: ${Math.round(days)}d`, color: 'var(--warning)', bg: 'var(--warning-light)' };
  if (days < 30) return { text: `${Math.round(days)}d`, color: 'var(--warning)', bg: 'var(--warning-light)' };
  return { text: `${Math.round(days)}d`, color: 'var(--success)', bg: 'var(--success-light)' };
}

export function ProductFamilyGroup({
  family,
  getPlanned,
  onSetQty,
  onSetDay,
  onSetExistingQty,
  onSetExistingDay,
  getExistingQty,
  getExistingDay,
  onFillSuggestion,
  onFillFamily,
  onSetFamilyDay,
  onSetUsage,
  familyTargetDays,
  onSetFamilyTargetDays,
  onClearFamilyTargetDays,
  globalTargetDays,
  plannedKg,
  kitchenPlanned,
  defaultCollapsed = false,
  onOpenModal,
}: ProductFamilyGroupProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  // Sync with parent "collapse all / expand all" toggle
  useEffect(() => {
    setCollapsed(defaultCollapsed);
  }, [defaultCollapsed]);

  const { registerFamily, unregisterFamily } = useCellNavigation();
  const badge = urgencyStyle(family.urgency);
  const kgShort = plannedKg > family.componentSOH ? plannedKg - family.componentSOH : 0;
  const hasOverride = familyTargetDays !== globalTargetDays;

  useEffect(() => {
    if (!collapsed) {
      registerFamily(family.familyCode, family.skus.length);
      return () => unregisterFamily(family.familyCode);
    } else {
      unregisterFamily(family.familyCode);
    }
  }, [collapsed, family.familyCode, family.skus.length, registerFamily, unregisterFamily]);

  return (
    <div className="mb-2">
      {/* Family Header */}
      <div
        className="w-full flex items-center gap-3 px-4 py-2 text-left"
        style={{
          background: 'var(--bg-surface)',
          border: '0.5px solid var(--border)',
          borderRadius: collapsed ? '4px' : '4px 4px 0 0',
        }}
      >
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="flex items-center gap-3 flex-1 min-w-0 hover:opacity-70 transition"
        >
          <span className="text-sm" style={{ color: 'var(--text-muted)' }}>{collapsed ? '▶' : '▼'}</span>
          <span className="text-sm truncate" style={{ fontWeight: 500, color: 'var(--text-primary)' }}>
            {family.familyName}
          </span>
          <span className="text-xs font-mono flex-shrink-0" style={{ color: 'var(--text-muted)' }}>
            ({family.familyCode})
          </span>
          <span className="text-xs flex-shrink-0" style={{ color: 'var(--text-secondary)' }}>
            SOH: {Math.round(family.componentSOH)}kg
          </span>
          <span
            className="text-xs px-2 py-0.5 rounded flex-shrink-0"
            style={{ fontWeight: 500, color: badge.color, background: badge.bg }}
          >
            {badge.text}
          </span>
          {kitchenPlanned && (
            <span
              className="text-xs px-2 py-0.5 rounded flex-shrink-0"
              style={{ fontWeight: 500, color: 'var(--accent)', background: 'var(--accent-light)' }}
            >
              +{Math.round(kitchenPlanned.totalKg)}kg ETA {kitchenPlanned.latestDate.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}
            </span>
          )}
          <span className="text-xs ml-auto flex-shrink-0" style={{ color: 'var(--text-muted)' }}>
            {family.skus.length} SKU{family.skus.length !== 1 ? 's' : ''}
          </span>
        </button>
        {/* Per-family target days */}
        <div className="flex items-center gap-1 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
          <input
            type="number"
            value={familyTargetDays}
            min={1}
            max={365}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              if (!isNaN(v) && v > 0) onSetFamilyTargetDays(family.familyCode, v);
            }}
            onBlur={(e) => {
              if (!e.target.value.trim()) onClearFamilyTargetDays(family.familyCode);
            }}
            className="w-11 px-1 py-0.5 rounded text-sm text-center focus:outline-none transition"
            style={{
              fontWeight: 500,
              color: hasOverride ? 'var(--accent)' : 'var(--text-muted)',
              background: hasOverride ? 'var(--accent-light)' : 'var(--bg-page)',
              border: `0.5px solid ${hasOverride ? 'var(--accent)' : 'var(--border)'}`,
            }}
            title={hasOverride ? `Custom target (global: ${globalTargetDays}d)` : `Using global target: ${globalTargetDays}d`}
          />
          <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>d</span>
        </div>
      </div>

      {!collapsed && (
        <>
          {/* Table */}
          <div className="overflow-x-auto" style={{ borderLeft: '0.5px solid var(--border)', borderRight: '0.5px solid var(--border)' }}>
            <table className="w-full" style={{ tableLayout: 'fixed' }}>
              <colgroup>
                <col style={{ width: '11%' }} />{/* SKU */}
                <col style={{ width: '5%' }} /> {/* Size */}
                <col style={{ width: '5%' }} /> {/* Days */}
                <col style={{ width: '6%' }} /> {/* Usage/mo */}
                <col style={{ width: '5%' }} /> {/* FG SOH */}
                <col style={{ width: '5%' }} /> {/* Avail */}
                <col style={{ width: '7%' }} /> {/* Existing Qty */}
                <col style={{ width: '7%' }} /> {/* Ex. Day */}
                <col style={{ width: '7%' }} /> {/* Suggest */}
                <col style={{ width: '7%' }} /> {/* Qty */}
                <col style={{ width: '7%' }} /> {/* Day */}
                <col style={{ width: '6%' }} /> {/* Can Make */}
                <col style={{ width: '6%' }} /> {/* Labels */}
              </colgroup>
              <thead>
                <tr style={{ borderBottom: '0.5px solid var(--border)' }}>
                  {['SKU', 'Size', 'Days', 'Demand', 'SOH', 'Avail', 'Existing', 'Ex. Day', 'Suggest', 'Qty', 'Day', 'Limit', 'Labels'].map((h, i) => {
                    // Grouped columns: 6-7 = Existing pair, 9-10 = Plan pair
                    const isExistingGroup = i === 6 || i === 7;
                    const isPlanGroup = i === 9 || i === 10;
                    const isGroupLeft = i === 6 || i === 9;
                    return (
                      <th
                        key={h}
                        className={`px-2 py-1 text-[11px] uppercase tracking-wider ${
                          i <= 1 ? (i === 1 ? 'text-center' : 'text-left') : 'text-right'
                        }`}
                        style={{
                          fontWeight: 500,
                          color: 'var(--text-muted)',
                          ...(isExistingGroup || isPlanGroup ? { background: 'var(--bg-surface)' } : {}),
                          ...(isGroupLeft ? { borderLeft: '2px solid var(--border)' } : {}),
                        }}
                      >
                        {h}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {family.skus.map((sku, idx) => (
                  <SKURow
                    key={sku.productCode}
                    sku={sku}
                    planned={getPlanned(sku.productCode)}
                    existingQtyEdit={getExistingQty(sku.productCode)}
                    existingDayEdit={getExistingDay(sku.productCode)}
                    onSetQty={onSetQty}
                    onSetDay={onSetDay}
                    onSetExistingQty={onSetExistingQty}
                    onSetExistingDay={onSetExistingDay}
                    onFillSuggestion={(code) => {
                      const s = family.skus.find(s => s.productCode === code);
                      if (s && s.suggestedQty > 0) onSetQty(code, s.suggestedQty);
                    }}
                    onSetUsage={onSetUsage}
                    onOpenModal={onOpenModal}
                    familyCode={family.familyCode}
                    rowIndex={idx}
                  />
                ))}
              </tbody>
              {family.totalSuggestedKg > 0 && (
                <tfoot>
                  <tr style={{ borderTop: '0.5px solid var(--border)' }}>
                    <td colSpan={8} className="px-2 py-1 text-right text-xs" style={{ color: 'var(--text-muted)' }}>
                      Total
                    </td>
                    <td className="px-2 py-1 text-right text-xs font-mono" style={{ fontWeight: 500, color: family.feasible ? 'var(--text-secondary)' : 'var(--warning)' }}>
                      {Math.round(family.totalSuggestedKg)}kg
                    </td>
                    <td colSpan={4} />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>

          {/* Family Footer */}
          <div
            className="flex items-center justify-between px-4 py-2 text-sm"
            style={{
              background: 'var(--bg-surface)',
              border: '0.5px solid var(--border)',
              borderTop: 'none',
              borderRadius: '0 0 4px 4px',
            }}
          >
            <div className="flex items-center gap-4">
              {plannedKg > 0 ? (
                <span style={{ fontWeight: 500, color: kgShort > 0 ? 'var(--danger)' : 'var(--success)' }}>
                  {Math.round(plannedKg)}kg required
                  {kgShort > 0 && ` · ${Math.round(kgShort)}kg short`}
                  {kgShort === 0 && ` · ${Math.round(family.componentSOH)}kg available`}
                </span>
              ) : (
                <span style={{ color: 'var(--text-muted)' }}>
                  {Math.round(family.totalSuggestedKg)}kg suggested
                  {!family.feasible && (
                    <span style={{ color: 'var(--warning)' }}> · exceeds {Math.round(family.componentSOH)}kg available</span>
                  )}
                </span>
              )}
              {kitchenPlanned && (
                <span
                  className="text-xs px-2 py-0.5 rounded"
                  style={{
                    fontWeight: 500,
                    color: 'var(--accent)',
                    background: 'var(--accent-light)',
                  }}
                >
                  {Math.round(kitchenPlanned.totalKg)}kg planned in kitchen
                  {' · '}
                  ETA {kitchenPlanned.latestDate.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}
                  {kitchenPlanned.batchCount > 1 && ` (${kitchenPlanned.batchCount} batches)`}
                </span>
              )}
            </div>
            <button
              onClick={() => onFillFamily(family.familyCode)}
              className="px-2.5 py-1 rounded text-xs transition hover:opacity-70"
              style={{
                fontWeight: 500,
                color: 'var(--accent)',
                background: 'var(--accent-light)',
                border: '0.5px solid var(--accent)',
              }}
            >
              Fill All Suggested
            </button>
          </div>
        </>
      )}
    </div>
  );
}
