'use client';

import { useState, useCallback, useMemo } from 'react';
import { ComponentTable } from './components/ComponentTable';
import { ProjectionTimeline } from './components/ProjectionTimeline';
import { DraftPOModal } from './components/DraftPOModal';
import { PushPlanDialog } from '@/app/components/PushPlanDialog';
import { buildPurchaseOrderPushTasks } from '@/lib/planning/push-tasks';
import { toLocalISODate } from '@/lib/planning/working-day';
import { usePurchasingData } from './hooks/usePurchasingData';
import { usePurchasingPlanner } from './hooks/usePurchasingPlanner';
import { buildAssignmentMap } from '@/lib/planning/warehouse-assignments';
import { usePersistedState } from '@/app/hooks/usePersistedState';

type ViewMode = 'table' | 'detail';

export default function ComponentPlanner() {
  const data = usePurchasingData();
  const {
    componentSOH,
    perWarehouseSOH,
    componentNames,
    componentSuppliers,
    suppliers,
    consumptionSchedule,
    demandRates,
    existingPOs,
    loading,
    error,
    refetch,
  } = data;

  const blockStart = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }, []);
  const blockEnd = useMemo(() => {
    const d = new Date(blockStart);
    d.setDate(d.getDate() + 55);
    return d;
  }, [blockStart]);

  // Build warehouse-scoped SOH: for each component, resolve its planning warehouse
  // and use only that warehouse's SOH for projections
  const warehouseComponentSOH = useMemo(() => {
    const codes = Object.keys(componentSOH);
    if (codes.length === 0 || Object.keys(perWarehouseSOH).length === 0) return {};
    const assignments = buildAssignmentMap(codes, perWarehouseSOH);
    const result: Record<string, number> = {};
    for (const code of codes) {
      const wh = assignments[code]?.warehouseName || '';
      const perProd = perWarehouseSOH[code] || {};
      result[code] = wh && perProd[wh] !== undefined ? perProd[wh] : (componentSOH[code] || 0);
    }
    return result;
  }, [componentSOH, perWarehouseSOH]);

  const planner = usePurchasingPlanner({
    componentSOH,
    warehouseComponentSOH,
    consumptionSchedule,
    demandRates,
    existingPOs,
    blockStart,
    blockEnd,
  });

  const [viewMode, setViewMode] = usePersistedState<ViewMode>('byron-purchasing-view-mode', 'table');
  const [showPushDialog, setShowPushDialog] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [draftModal, setDraftModal] = useState<{
    componentCode: string;
    prefilledDate: Date;
  } | null>(null);
  /**
   * Quick-filter driven by the stat cards. Click a card to filter the table
   * down to that slice; click the active card again to clear. The 'all' case
   * is represented as `null` rather than a distinct value to keep the
   * toggle logic uniform.
   */
  const [statFilter, setStatFilter] = usePersistedState<'ok' | 'low' | 'stockout' | 'draft' | null>('byron-purchasing-stat-filter', null);
  const toggleStatFilter = useCallback(
    (f: 'ok' | 'low' | 'stockout' | 'draft') =>
      setStatFilter(prev => (prev === f ? null : f)),
    [],
  );

  const handleComponentClick = useCallback((code: string) => {
    planner.setSelectedComponent(code);
  }, [planner]);

  const handleDayClick = useCallback((date: Date) => {
    if (!planner.selectedComponent) return;
    setDraftModal({
      componentCode: planner.selectedComponent,
      prefilledDate: date,
    });
  }, [planner.selectedComponent]);

  const handlePushComplete = useCallback((succeededIds: string[]) => {
    for (const id of succeededIds) planner.removeDraftPO(id);
  }, [planner.removeDraftPO]);

  const blockDateRange = useMemo(() => {
    const fmt = (d: Date) => d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
    return `${fmt(blockStart)} \u2014 ${fmt(blockEnd)}`;
  }, [blockStart, blockEnd]);

  if (loading && Object.keys(componentSOH).length === 0) {
    return (
      <div className="h-screen flex items-center justify-center" style={{ background: 'var(--bg-page)' }}>
        <div className="text-center">
          <div className="text-sm mb-2" style={{ color: 'var(--text-muted)' }}>Loading component data...</div>
          <div className="w-48 h-0.5 rounded overflow-hidden" style={{ background: 'var(--bg-surface)' }}>
            <div className="h-full rounded animate-pulse" style={{ width: '60%', background: 'var(--accent)' }} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col overflow-hidden" style={{ background: 'var(--bg-page)', color: 'var(--text-primary)' }}>
      {/* Error banner */}
      {error && (
        <div className="px-6 py-2 flex items-center justify-between text-sm" style={{ background: 'var(--danger-light)', color: 'var(--danger)', borderBottom: '0.5px solid var(--border)' }}>
          <span>{error} (using fallback data)</span>
          <button onClick={refetch} className="underline opacity-70 hover:opacity-100 text-xs">Retry</button>
        </div>
      )}

      {/* Top bar */}
      <div className="px-6 pt-5 pb-4" style={{ borderBottom: '0.5px solid var(--border)' }}>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-xl" style={{ fontWeight: 500, color: 'var(--text-primary)' }}>Component Planner</h1>
            <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
              SOH projections: {blockDateRange}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {/* View toggle */}
            <div className="flex rounded overflow-hidden" style={{ border: '0.5px solid var(--border)' }}>
              {(['table', 'detail'] as ViewMode[]).map(mode => (
                <button
                  key={mode}
                  onClick={() => setViewMode(mode)}
                  className="px-3 py-1.5 text-xs transition"
                  style={{
                    fontWeight: viewMode === mode ? 500 : 400,
                    color: viewMode === mode ? 'var(--accent)' : 'var(--text-muted)',
                    background: viewMode === mode ? 'var(--accent-light)' : 'var(--bg-page)',
                  }}
                >
                  {mode === 'table' ? 'Table' : 'Detail'}
                </button>
              ))}
            </div>
            <button
              onClick={refetch}
              className="px-3 py-1.5 rounded text-sm transition hover:opacity-80"
              style={{ color: 'var(--text-secondary)', border: '0.5px solid var(--border)' }}
            >
              Refresh
            </button>
            <button
              onClick={() => { planner.saveDraft(); setSavedFlash(true); setTimeout(() => setSavedFlash(false), 2000); }}
              disabled={planner.draftPOs.length === 0}
              className="px-3 py-1.5 rounded text-sm text-white transition disabled:opacity-30 disabled:cursor-not-allowed"
              style={{ background: 'var(--accent)', fontWeight: 500 }}
            >
              {savedFlash ? 'Saved' : 'Save Draft'}
            </button>
            <button
              onClick={() => setShowPushDialog(true)}
              disabled={planner.draftPOs.length === 0}
              className="px-3 py-1.5 rounded text-sm text-white transition disabled:opacity-30 disabled:cursor-not-allowed"
              style={{ background: 'var(--success)', fontWeight: 500 }}
            >
              Push POs
            </button>
          </div>
        </div>

        {/* Stats row — each card is a quick filter for the table below. */}
        <div className="grid grid-cols-5 gap-3">
          {([
            { label: 'Components', value: planner.stats.total, color: undefined as string | undefined, filter: null, hint: 'Show all' },
            { label: 'Sufficient', value: planner.stats.ok, color: planner.stats.ok > 0 ? 'var(--success)' : undefined, filter: 'ok', hint: 'Show only components with sufficient stock' },
            { label: 'Low Stock', value: planner.stats.low, color: planner.stats.low > 0 ? 'var(--warning)' : undefined, filter: 'low', hint: 'Show only low-stock components' },
            { label: 'Stockout', value: planner.stats.stockout, color: planner.stats.stockout > 0 ? 'var(--danger)' : undefined, filter: 'stockout', hint: 'Show only stockout components' },
            { label: 'Draft POs', value: planner.stats.draftCount, color: planner.stats.draftCount > 0 ? 'var(--accent)' : undefined, filter: 'draft', hint: 'Show only components with a draft PO' },
          ] as { label: string; value: number; color: string | undefined; filter: 'ok' | 'low' | 'stockout' | 'draft' | null; hint: string }[]).map(card => {
            const active = card.filter !== null && statFilter === card.filter;
            const clearsFilter = card.filter === null;
            return (
              <button
                key={card.label}
                onClick={() => {
                  if (clearsFilter || card.filter === null) setStatFilter(null);
                  else toggleStatFilter(card.filter);
                }}
                className="rounded px-3 py-2 text-left transition hover:opacity-80"
                style={{
                  background: active ? 'var(--bg-hover)' : 'var(--bg-surface)',
                  border: active ? `1px solid ${card.color || 'var(--accent)'}` : '1px solid transparent',
                  cursor: 'pointer',
                }}
                title={active ? 'Click to clear filter' : card.hint}
              >
                <div className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-muted)', fontWeight: 500 }}>
                  {card.label}{active && ' · filtering'}
                </div>
                <div className="text-xl mt-0.5" style={{ fontWeight: 500, color: card.color || 'var(--text-primary)' }}>{card.value}</div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 flex overflow-hidden min-w-0">
        {viewMode === 'table' ? (
          /* Dense table view */
          <div className="flex-1 flex flex-col overflow-hidden min-w-0">
            <ComponentTable
              componentSOH={componentSOH}
              perWarehouseSOH={perWarehouseSOH}
              componentNames={componentNames}
              componentSuppliers={componentSuppliers}
              suppliers={suppliers}
              consumptionSchedule={consumptionSchedule}
              demandRates={demandRates}
              existingPOs={existingPOs}
              draftPOs={planner.draftPOs}
              componentStatusMap={planner.componentStatusMap}
              onComponentClick={handleComponentClick}
              statFilter={statFilter}
            />

            {/* Inline detail panel for selected component */}
            {planner.selectedComponent && planner.selectedProjection && (
              <div style={{ borderTop: '0.5px solid var(--border)', height: 280, flexShrink: 0 }}>
                <div className="flex items-center justify-between px-4 py-1.5" style={{ borderBottom: '0.5px solid var(--border)', background: 'var(--bg-surface)' }}>
                  <div className="flex items-center gap-2">
                    <span className="text-sm" style={{ fontWeight: 500, color: 'var(--text-primary)' }}>
                      {componentNames[planner.selectedComponent] || planner.selectedComponent}
                    </span>
                    <span className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>
                      {planner.selectedComponent}
                    </span>
                    <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                      SOH: {Math.round(warehouseComponentSOH[planner.selectedComponent] ?? componentSOH[planner.selectedComponent] ?? 0)}
                      {warehouseComponentSOH[planner.selectedComponent] !== undefined && warehouseComponentSOH[planner.selectedComponent] !== componentSOH[planner.selectedComponent] && (
                        <span> (global: {Math.round(componentSOH[planner.selectedComponent] || 0)})</span>
                      )}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setDraftModal({
                        componentCode: planner.selectedComponent!,
                        prefilledDate: planner.selectedProjection?.recommendedPODate || new Date(),
                      })}
                      className="px-2 py-1 rounded text-xs transition hover:opacity-70"
                      style={{ color: 'var(--accent)', border: '0.5px solid var(--accent)', fontWeight: 500 }}
                    >
                      + Draft PO
                    </button>
                    <button
                      onClick={() => planner.setSelectedComponent(null)}
                      className="text-xs transition hover:opacity-70"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      Close
                    </button>
                  </div>
                </div>
                <ProjectionTimeline
                  componentCode={planner.selectedComponent}
                  componentName={componentNames[planner.selectedComponent] || planner.selectedComponent}
                  soh={warehouseComponentSOH[planner.selectedComponent] ?? componentSOH[planner.selectedComponent] ?? 0}
                  projection={planner.selectedProjection}
                  drafts={planner.selectedDrafts}
                  onDayClick={handleDayClick}
                />
              </div>
            )}
          </div>
        ) : (
          /* Detail view (original sidebar + timeline) */
          <>
            <div className="w-72 flex flex-col flex-shrink-0" style={{ borderRight: '0.5px solid var(--border)' }}>
              <ComponentSidebarLite
                componentSOH={componentSOH}
                componentNames={componentNames}
                componentStatusMap={planner.componentStatusMap}
                selectedComponent={planner.selectedComponent}
                onSelect={planner.setSelectedComponent}
              />
            </div>
            <div className="flex-1 flex flex-col overflow-hidden">
              {planner.selectedComponent && planner.selectedProjection ? (
                <ProjectionTimeline
                  componentCode={planner.selectedComponent}
                  componentName={componentNames[planner.selectedComponent] || planner.selectedComponent}
                  soh={warehouseComponentSOH[planner.selectedComponent] ?? componentSOH[planner.selectedComponent] ?? 0}
                  projection={planner.selectedProjection}
                  drafts={planner.selectedDrafts}
                  onDayClick={handleDayClick}
                />
              ) : (
                <div className="flex-1 flex items-center justify-center text-sm" style={{ color: 'var(--text-muted)' }}>
                  Select a component to view its SOH projection
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Modals */}
      {draftModal && planner.selectedComponent && (
        <DraftPOModal
          componentCode={draftModal.componentCode}
          componentName={componentNames[draftModal.componentCode] || draftModal.componentCode}
          supplierId={componentSuppliers[draftModal.componentCode] || ''}
          supplierName={suppliers[componentSuppliers[draftModal.componentCode]]?.supplierName || ''}
          prefilledDate={draftModal.prefilledDate}
          recommendedQuantity={planner.selectedProjection?.recommendedQuantity || 0}
          recommendedDate={planner.selectedProjection?.recommendedPODate || null}
          existingDrafts={planner.selectedDrafts}
          onAdd={planner.addDraftPO}
          onRemove={planner.removeDraftPO}
          onClose={() => setDraftModal(null)}
        />
      )}
      {showPushDialog && (() => {
        const tasks = buildPurchaseOrderPushTasks(
          planner.draftPOs.map((d) => ({
            kind: 'purchase_order' as const,
            id: d.id,
            productCode: d.componentCode,
            productName: d.componentName,
            quantity: d.quantity,
            lifecycle: 'draft' as const,
            deliveryDate: toLocalISODate(d.deliveryDate),
            supplierId: d.supplierId,
            supplierName: d.supplierName,
          })),
        );
        return (
          <PushPlanDialog
            tasks={tasks}
            onClose={() => setShowPushDialog(false)}
            onComplete={handlePushComplete}
          />
        );
      })()}
    </div>
  );
}

/** Compact sidebar for detail view mode */
function ComponentSidebarLite({
  componentSOH,
  componentNames,
  componentStatusMap,
  selectedComponent,
  onSelect,
}: {
  componentSOH: Record<string, number>;
  componentNames: Record<string, string>;
  componentStatusMap: Map<string, string>;
  selectedComponent: string | null;
  onSelect: (code: string) => void;
}) {
  const [search, setSearch] = useState('');
  const codes = Object.keys(componentSOH).filter(code => {
    if (!search) return true;
    const q = search.toLowerCase();
    return code.toLowerCase().includes(q) || (componentNames[code] || '').toLowerCase().includes(q);
  }).sort((a, b) => {
    const statusOrder: Record<string, number> = { stockout: 0, low: 1, ok: 2 };
    const sa = statusOrder[componentStatusMap.get(a) || 'ok'] ?? 2;
    const sb = statusOrder[componentStatusMap.get(b) || 'ok'] ?? 2;
    return sa - sb;
  });

  const statusColor: Record<string, string> = {
    ok: 'var(--success)',
    low: 'var(--warning)',
    stockout: 'var(--danger)',
  };

  return (
    <div className="flex flex-col h-full">
      <div className="p-3" style={{ borderBottom: '0.5px solid var(--border)' }}>
        <input
          type="text"
          placeholder="Search..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full rounded px-3 py-1.5 text-sm focus:outline-none"
          style={{ color: 'var(--text-primary)', background: 'var(--bg-surface)', border: '0.5px solid var(--border)' }}
        />
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
        {codes.map(code => {
          const status = componentStatusMap.get(code) || 'ok';
          const isSelected = selectedComponent === code;
          return (
            <button
              key={code}
              onClick={() => onSelect(code)}
              className="w-full text-left px-3 py-2 rounded text-sm transition"
              style={{
                background: isSelected ? 'var(--accent-light)' : 'transparent',
                border: isSelected ? '0.5px solid var(--accent)' : '0.5px solid transparent',
              }}
              onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = 'var(--bg-hover)'; }}
              onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = isSelected ? 'var(--accent-light)' : 'transparent'; }}
            >
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: statusColor[status] }} />
                <span className="truncate" style={{ color: 'var(--text-primary)' }}>{componentNames[code] || code}</span>
                <span className="text-xs ml-auto flex-shrink-0" style={{ color: 'var(--text-muted)' }}>{Math.round(componentSOH[code] || 0)}</span>
              </div>
              <div className="text-xs ml-4" style={{ color: 'var(--text-muted)' }}>{code}</div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
