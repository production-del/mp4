'use client';

import { useMemo, useCallback } from 'react';
import type { ProductFamily, PackagingSKU } from '../hooks/usePackagingData';
import type { KitchenPlannedInfo } from '../hooks/useKitchenBatches';
import { ProductFamilyGroup } from './ProductFamilyGroup';
import { FlatSKUTable } from './FlatSKUTable';
import { CellNavigationProvider } from '../context/CellNavigationContext';

interface PackagingTableProps {
  families: ProductFamily[];
  skus: PackagingSKU[];
  viewMode: 'family' | 'sku';
  search: string;
  selectedGroups: Set<string>;
  allCollapsed: boolean;
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
  getFamilyTargetDays: (familyCode: string) => number;
  onSetFamilyTargetDays: (familyCode: string, days: number) => void;
  onClearFamilyTargetDays: (familyCode: string) => void;
  globalTargetDays: number;
  getFamilyPlannedKg: (familyCode: string) => number;
  kitchenBatches: Record<string, KitchenPlannedInfo>;
  onClearAll: () => void;
  /** Opens the shared BOM investigation modal for the clicked SKU. */
  onOpenModal?: (productCode: string) => void;
  /**
   * Quick filter driven by the page-level stat cards:
   * - `'urgent'`  → SKUs with daysAvailable < 7
   * - `'planned'` → SKUs with a non-zero planned qty in the draft
   */
  statFilter?: 'urgent' | 'planned' | null;
  /** Reads the planned quantity for a given productCode. Used by statFilter. */
  getPlannedForFilter?: (productCode: string) => number;
}

export function PackagingTable({
  families,
  skus: allSkus,
  viewMode,
  search,
  selectedGroups,
  allCollapsed,
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
  getFamilyTargetDays,
  onSetFamilyTargetDays,
  onClearFamilyTargetDays,
  globalTargetDays,
  getFamilyPlannedKg,
  kitchenBatches,
  onClearAll,
  onOpenModal,
  statFilter,
  getPlannedForFilter,
}: PackagingTableProps) {
  /**
   * SKU-level filter shared by both the family-grouped view and the flat
   * SKU view. Encapsulates the stat-card filter (urgent / planned) so the
   * two memos below stay identical in behaviour.
   */
  const passesStatFilter = useCallback((sku: PackagingSKU) => {
    if (!statFilter) return true;
    if (statFilter === 'urgent') return sku.daysAvailable < 7;
    if (statFilter === 'planned') return (getPlannedForFilter?.(sku.productCode) ?? 0) > 0;
    return true;
  }, [statFilter, getPlannedForFilter]);

  // Filter families by search and product group
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const hasGroups = selectedGroups.size > 0;

    return families
      .map((family) => {
        // Filter SKUs within each family
        const filteredSKUs = family.skus.filter((sku) => {
          // Group filter
          if (hasGroups && !selectedGroups.has(sku.productGroup)) return false;
          // Stat-card filter
          if (!passesStatFilter(sku)) return false;
          // Search filter
          if (q) {
            return (
              sku.productCode.toLowerCase().includes(q) ||
              sku.productName.toLowerCase().includes(q) ||
              sku.familyCode.toLowerCase().includes(q) ||
              sku.familyName.toLowerCase().includes(q)
            );
          }
          return true;
        });

        if (filteredSKUs.length === 0) return null;

        return {
          ...family,
          skus: filteredSKUs,
          urgency: filteredSKUs.length > 0
            ? Math.min(...filteredSKUs.map(s => s.daysAvailable))
            : Infinity,
        };
      })
      .filter(Boolean) as ProductFamily[];
  }, [families, search, selectedGroups, passesStatFilter]);

  // Flat SKU list — filtered and sorted by days available
  const flatSkus = useMemo(() => {
    if (viewMode !== 'sku') return [];
    const q = search.trim().toLowerCase();
    const hasGroups = selectedGroups.size > 0;

    return allSkus
      .filter((sku) => {
        if (hasGroups && !selectedGroups.has(sku.productGroup)) return false;
        if (!passesStatFilter(sku)) return false;
        if (q) {
          return (
            sku.productCode.toLowerCase().includes(q) ||
            sku.productName.toLowerCase().includes(q) ||
            sku.familyCode.toLowerCase().includes(q) ||
            sku.familyName.toLowerCase().includes(q)
          );
        }
        return true;
      })
      .sort((a, b) => a.daysAvailable - b.daysAvailable);
  }, [allSkus, viewMode, search, selectedGroups, passesStatFilter]);

  // Ordered family codes for cell navigation
  const familyOrder = useMemo(
    () => filtered.map((f) => f.familyCode),
    [filtered]
  );

  const isEmpty = viewMode === 'family' ? filtered.length === 0 : flatSkus.length === 0;

  if (isEmpty) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-lg" style={{ color: 'var(--text-muted)' }}>
          {search || selectedGroups.size > 0
            ? 'No SKUs match your filters'
            : 'No packaging data available'}
        </p>
      </div>
    );
  }

  if (viewMode === 'sku') {
    return (
      <FlatSKUTable
        skus={flatSkus}
        getPlanned={getPlanned}
        onSetQty={onSetQty}
        onSetDay={onSetDay}
        onSetExistingQty={onSetExistingQty}
        onSetExistingDay={onSetExistingDay}
        getExistingQty={getExistingQty}
        getExistingDay={getExistingDay}
        onFillSuggestion={onFillSuggestion}
        onSetUsage={onSetUsage}
        onOpenModal={onOpenModal}
      />
    );
  }

  // Check if any planned data exists
  const hasPlannedData = filtered.some((family) =>
    family.skus.some((sku) => {
      const p = getPlanned(sku.productCode);
      return p && (p.quantity > 0 || p.dayInt > 0);
    })
  );

  return (
    <CellNavigationProvider familyOrder={familyOrder}>
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-1">
        {hasPlannedData && (
          <div className="flex justify-end mb-1">
            <button
              onClick={onClearAll}
              className="px-2.5 py-1 rounded text-xs transition hover:opacity-70"
              style={{
                fontWeight: 500,
                color: 'var(--danger)',
                background: 'var(--danger-light)',
                border: '0.5px solid var(--danger)',
              }}
            >
              Clear All Planned
            </button>
          </div>
        )}
        {(() => {
          // Group sub-families by their `topGroup` so the table renders
          // a two-level hierarchy: top-group section header, then the
          // existing per-family blocks. Top groups sorted alphabetically;
          // sub-families keep their urgency-ascending order from
          // `groupByFamily`.
          const byTopGroup = new Map<string, typeof filtered>();
          for (const family of filtered) {
            const key = family.topGroup || 'Other';
            const arr = byTopGroup.get(key);
            if (arr) arr.push(family);
            else byTopGroup.set(key, [family]);
          }
          const topGroups = [...byTopGroup.entries()].sort((a, b) => a[0].localeCompare(b[0]));

          return topGroups.map(([topGroupName, topFamilies]) => (
            <div key={topGroupName} className="mb-3">
              <div
                className="sticky top-0 z-[5] px-3 py-1.5 text-xs uppercase tracking-wider rounded"
                style={{
                  fontWeight: 600,
                  color: 'var(--text-secondary)',
                  background: 'var(--bg-surface)',
                  borderBottom: '0.5px solid var(--border)',
                  marginBottom: 4,
                }}
              >
                {topGroupName} <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>· {topFamilies.length} {topFamilies.length === 1 ? 'family' : 'families'}</span>
              </div>
              {topFamilies.map((family) => (
                <ProductFamilyGroup
                  key={family.familyCode}
                  family={family}
                  getPlanned={getPlanned}
                  onSetQty={onSetQty}
                  onSetDay={onSetDay}
                  onSetExistingQty={onSetExistingQty}
                  onSetExistingDay={onSetExistingDay}
                  getExistingQty={getExistingQty}
                  getExistingDay={getExistingDay}
                  onFillSuggestion={onFillSuggestion}
                  onFillFamily={onFillFamily}
                  onSetFamilyDay={onSetFamilyDay}
                  onSetUsage={onSetUsage}
                  familyTargetDays={getFamilyTargetDays(family.familyCode)}
                  onSetFamilyTargetDays={onSetFamilyTargetDays}
                  onClearFamilyTargetDays={onClearFamilyTargetDays}
                  globalTargetDays={globalTargetDays}
                  plannedKg={getFamilyPlannedKg(family.familyCode)}
                  kitchenPlanned={kitchenBatches[family.familyCode] || null}
                  defaultCollapsed={allCollapsed}
                  onOpenModal={onOpenModal}
                />
              ))}
            </div>
          ));
        })()}
      </div>
    </CellNavigationProvider>
  );
}
