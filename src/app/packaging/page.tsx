'use client';

import { useState, useCallback } from 'react';
import { usePackagingConfig } from './hooks/usePackagingConfig';
import { usePackagingData } from './hooks/usePackagingData';
import { usePackagingPlanner } from './hooks/usePackagingPlanner';
import { useKitchenBatches } from './hooks/useKitchenBatches';
import { PackagingDataContext } from './context/PackagingDataContext';
import { PackagingTable } from './components/PackagingTable';
import { FilterBar } from './components/FilterBar';
import { SettingsPanel } from './components/SettingsPanel';
// UsageImportModal removed — usage rates are not user-editable
import { PushPlanDialog } from '@/app/components/PushPlanDialog';
import { buildPackagingPushTasks } from '@/lib/planning/push-tasks';
import { PackagingCalendar } from './components/PackagingCalendar';
import { PackagingCardModal } from './components/PackagingCardModal';
import { downloadPackagingPlan, type ScheduledRun } from './utils/exportPlan';
import { dateToDayInt } from '@/lib/planning/working-day';
import type { PackingTeam } from './hooks/usePackagingPlanner';
import { usePersistedState, setStringSerializer } from '@/app/hooks/usePersistedState';

export default function PackagingPage() {
  const config = usePackagingConfig();
  const { skus, families, sohMap, rawData, loading, error, refetch } =
    usePackagingData(config.settings, config.monthlyUsage, config.familyTargetDays);
  const planner = usePackagingPlanner(families, skus);
  const kitchenBatches = useKitchenBatches();

  // View / filter state — persisted so switching between packaging,
  // kitchen, purchasing (or table ↔ calendar) preserves what the
  // operator was last looking at.
  const [pageView, setPageView] = usePersistedState<'table' | 'calendar'>('byron-packaging-page-view', 'table');
  const [search, setSearch] = usePersistedState<string>('byron-packaging-search', '');
  const [selectedGroups, setSelectedGroups] = usePersistedState<Set<string>>('byron-packaging-selected-groups', new Set(), setStringSerializer);
  const [viewMode, setViewMode] = usePersistedState<'family' | 'sku'>('byron-packaging-view-mode', 'sku');
  const [allCollapsed, setAllCollapsed] = usePersistedState<boolean>('byron-packaging-all-collapsed', false);
  const [showSettings, setShowSettings] = useState(false);
  // showImport removed — usage rates are not user-editable
  const [showPush, setShowPush] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [panelExpanded, setPanelExpanded] = useState(true);
  /**
   * Clickable stat-card filter. Narrows the table down to urgent SKUs
   * (daysAvailable < 7) or SKUs with a planned quantity > 0. The "total"
   * cards (Families / Total SKUs) clear the filter.
   */
  const [statFilter, setStatFilter] = usePersistedState<'urgent' | 'planned' | null>('byron-packaging-stat-filter', null);
  const toggleStatFilter = useCallback(
    (f: 'urgent' | 'planned') => setStatFilter(prev => prev === f ? null : f),
    [],
  );
  /**
   * BOM investigation modal state. Shared between the calendar and table views
   * so clicking a card or a table row opens the same modal with the same run
   * context (planned qty / day / team) where available.
   */
  const [cardModal, setCardModal] = useState<
    | { productCode: string; runQuantity?: number; runDayInt?: number; runTeam?: PackingTeam }
    | null
  >(null);
  const openCardModal = useCallback(
    (args: { productCode: string; runQuantity?: number; runDayInt?: number; runTeam?: PackingTeam }) =>
      setCardModal(args),
    [],
  );

  const toggleGroup = useCallback((group: string) => {
    setSelectedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  }, []);

  const handleSave = useCallback(() => {
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 2000);
  }, []);

  /**
   * Build the scheduled-runs snapshot that feeds the export. Both draft
   * CREATE entries (from `planner.plannedAssemblies`) and edited EXISTING
   * assemblies that carry a day (via `planner.existingEdits`) count — the
   * export describes "what the operator has planned right now", not just
   * what's going to push to Unleashed.
   */
  const handleExportPlan = useCallback(() => {
    if (!rawData) return;
    const runs: ScheduledRun[] = [];
    // `plannedAssemblies` already contains BOTH:
    //   • CREATE drafts (from Qty column entries), and
    //   • UPDATE entries for existing Unleashed assemblies the user has
    //     edited (qty/day/team change).
    // Pulling from it is the single source of truth — iterating existing
    // assemblies from `skus` in addition used to double-count any SKU the
    // operator had nudged on the calendar.
    const coveredCodes = new Set<string>();
    for (const p of planner.plannedAssemblies) {
      if (!p.dayInt || !p.quantity || p.quantity <= 0) continue;
      runs.push({
        productCode: p.productCode,
        quantity: p.quantity,
        dayInt: p.dayInt,
        team: p.team,
      });
      coveredCodes.add(p.productCode);
    }
    // Add **unedited** existing assemblies — those not already represented
    // as an UPDATE in plannedAssemblies. These still consume components on
    // their scheduled day, so the procurement list has to see them.
    for (const sku of skus) {
      if (coveredCodes.has(sku.productCode)) continue;
      if (!sku.existingAssemblyId || !sku.existingAssemblyQty) continue;
      if (!sku.existingAssemblyDate) continue;
      const d = new Date(sku.existingAssemblyDate);
      if (isNaN(d.getTime())) continue;
      // `weekend: 'up'` matches the calendar's resolution for existing
      // assemblies — a Sat/Sun date becomes next Monday so the card
      // appears where the operator sees it.
      const dayInt = dateToDayInt(d, undefined, { weekend: 'up' });
      if (dayInt <= 0) continue;
      runs.push({
        productCode: sku.productCode,
        quantity: sku.existingAssemblyQty,
        dayInt,
        team: sku.existingAssemblyTeam,
      });
    }

    downloadPackagingPlan({
      runs,
      skus,
      bomEntries: rawData.bomEntries || [],
      sohItems: rawData.sohItems || [],
      supplierByCode: rawData.supplierByCode || {},
      monthlyUsage: config.monthlyUsage,
      productGroups: rawData.productGroups || {},
    });
  }, [planner, skus, rawData, config.monthlyUsage]);

  const handlePushComplete = useCallback(
    (succeededCodes: string[]) => {
      for (const code of succeededCodes) {
        planner.setPlanQty(code, 0);
      }
      refetch();
    },
    [planner, refetch]
  );

  return (
    <PackagingDataContext.Provider value={{ skus, families, sohMap, loading }}>
      <div
        className={`h-screen flex flex-col mx-auto w-full ${pageView === 'calendar' ? 'max-w-full px-2' : 'max-w-[90%]'}`}
        style={{ background: 'var(--bg-page)', color: 'var(--text-primary)' }}
      >
        {/* Error banner */}
        {error && (
          <div
            className="px-6 py-2 flex items-center justify-between text-lg"
            style={{ background: 'var(--danger-light)', color: 'var(--danger)', borderBottom: '0.5px solid var(--border)' }}
          >
            <span>{error}</span>
            <button onClick={refetch} className="underline opacity-70 hover:opacity-100 text-base">
              Retry
            </button>
          </div>
        )}

        {/* Top bar — sticky */}
        <div className="px-6 pt-4 pb-3" style={{ borderBottom: '0.5px solid var(--border)', position: 'sticky', top: 0, zIndex: 20, background: 'var(--bg-page)' }}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <h1 className="text-xl" style={{ fontWeight: 500, color: 'var(--text-primary)' }}>
                Packaging Plan
              </h1>
              <div className="flex items-center gap-1.5">
                <span className="text-sm" style={{ color: 'var(--text-muted)' }}>Target</span>
                <input
                  type="number"
                  value={config.settings.targetDays}
                  min={1}
                  max={365}
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10);
                    if (!isNaN(v) && v > 0) config.updateSettings({ targetDays: v });
                  }}
                  className="w-12 px-1.5 py-0.5 rounded text-sm text-center focus:outline-none transition"
                  style={{
                    fontWeight: 500,
                    color: 'var(--accent)',
                    background: 'var(--bg-surface)',
                    border: '0.5px solid var(--border)',
                  }}
                />
                <span className="text-sm" style={{ color: 'var(--text-muted)' }}>days</span>
              </div>
              <button
                onClick={() => setPanelExpanded(p => !p)}
                className="ml-2 px-2 py-0.5 rounded text-xs transition hover:opacity-70"
                style={{ color: 'var(--text-muted)', border: '0.5px solid var(--border)' }}
                title={panelExpanded ? 'Collapse stats & filters' : 'Expand stats & filters'}
              >
                {panelExpanded ? '▲ Hide' : '▼ Show'}
              </button>
            </div>

            <div className="flex items-center gap-2">
              {/* View toggle */}
              <div className="flex rounded overflow-hidden" style={{ border: '0.5px solid var(--border)' }}>
                <button
                  onClick={() => setPageView('table')}
                  className="px-2 py-1 text-sm transition"
                  style={{
                    background: pageView === 'table' ? 'var(--accent)' : 'transparent',
                    color: pageView === 'table' ? '#fff' : 'var(--text-secondary)',
                    fontWeight: pageView === 'table' ? 500 : 400,
                  }}
                >
                  Table
                </button>
                <button
                  onClick={() => setPageView('calendar')}
                  className="px-2 py-1 text-sm transition"
                  style={{
                    background: pageView === 'calendar' ? 'var(--accent)' : 'transparent',
                    color: pageView === 'calendar' ? '#fff' : 'var(--text-secondary)',
                    fontWeight: pageView === 'calendar' ? 500 : 400,
                  }}
                >
                  Calendar
                </button>
              </div>
              <button
                onClick={() => setShowSettings(true)}
                className="px-2.5 py-1 rounded text-sm transition hover:opacity-80"
                style={{ color: 'var(--text-secondary)', border: '0.5px solid var(--border)', fontWeight: 400 }}
              >
                Settings
              </button>
              <button
                onClick={refetch}
                className="px-2.5 py-1 rounded text-sm transition hover:opacity-80"
                style={{ color: 'var(--text-secondary)', border: '0.5px solid var(--border)', fontWeight: 400 }}
              >
                Refresh
              </button>
              <button
                onClick={handleSave}
                disabled={planner.plannedAssemblies.length === 0}
                className="px-2.5 py-1 rounded text-sm text-white transition disabled:opacity-30 disabled:cursor-not-allowed"
                style={{ background: 'var(--accent)', fontWeight: 500 }}
              >
                {savedFlash ? 'Saved' : 'Save Draft'}
              </button>
              <button
                onClick={handleExportPlan}
                disabled={planner.plannedAssemblies.length === 0 || !rawData}
                className="px-2.5 py-1 rounded text-sm transition hover:opacity-80 disabled:opacity-30 disabled:cursor-not-allowed"
                style={{ color: 'var(--accent)', border: '0.5px solid var(--accent)', fontWeight: 500 }}
                title="Download an .xlsx listing every component the scheduled plan needs, grouped by supplier"
              >
                Export Plan
              </button>
              <button
                onClick={() => setShowPush(true)}
                disabled={planner.plannedAssemblies.length === 0}
                className="px-2.5 py-1 rounded text-sm text-white transition disabled:opacity-30 disabled:cursor-not-allowed"
                style={{ background: 'var(--success)', fontWeight: 500 }}
              >
                Push to Unleashed
              </button>
            </div>
          </div>
        </div>

        {/* Collapsible: Metric cards + Filter bar (hidden in calendar view) */}
        {panelExpanded && pageView === 'table' && (
          <>
          {/* Metric cards */}
          <div className="px-6 pt-3 pb-3" style={{ borderBottom: '0.5px solid var(--border)' }}>
            <div className="grid grid-cols-4 gap-3">
              {([
                { label: 'Families', value: planner.stats.totalFamilies, color: undefined, filter: null },
                { label: 'Urgent (<7d)', value: planner.stats.urgent, color: planner.stats.urgent > 0 ? 'var(--danger)' : undefined, filter: 'urgent' },
                { label: 'Planned', value: planner.stats.planned, color: planner.stats.planned > 0 ? 'var(--accent)' : undefined, filter: 'planned' },
                { label: 'Total SKUs', value: planner.stats.totalSKUs, color: undefined, filter: null },
              ] as { label: string; value: number; color: string | undefined; filter: 'urgent' | 'planned' | null }[]).map((card) => {
                const active = card.filter !== null && statFilter === card.filter;
                return (
                  <button
                    key={card.label}
                    onClick={() => {
                      if (card.filter === null) setStatFilter(null);
                      else toggleStatFilter(card.filter);
                    }}
                    className="rounded px-3 py-2 text-left transition hover:opacity-85"
                    style={{
                      background: active ? 'var(--bg-hover)' : 'var(--bg-surface)',
                      border: active ? `1px solid ${card.color || 'var(--accent)'}` : '1px solid transparent',
                      cursor: 'pointer',
                    }}
                    title={active ? 'Click to clear filter' : card.filter ? `Show only ${card.label} SKUs` : 'Clear filter'}
                  >
                    <div className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--text-muted)', fontWeight: 500 }}>
                      {card.label}{active && ' · filtering'}
                    </div>
                    <div className="text-xl mt-0.5" style={{ fontWeight: 500, color: card.color || 'var(--text-primary)' }}>
                      {card.value}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
          {/* Filter bar */}
          <FilterBar
            families={families}
            search={search}
            onSearchChange={setSearch}
            selectedGroups={selectedGroups}
            onToggleGroup={toggleGroup}
            viewMode={viewMode}
            onSetViewMode={setViewMode}
            allCollapsed={allCollapsed}
            onToggleCollapseAll={() => setAllCollapsed(!allCollapsed)}
          />
          </>
        )}

        {/* Loading state */}
        {loading && families.length === 0 ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <div className="text-sm mb-2" style={{ color: 'var(--text-muted)' }}>Loading packaging data...</div>
              <div className="w-48 h-0.5 rounded overflow-hidden" style={{ background: 'var(--bg-surface)' }}>
                <div className="h-full rounded animate-pulse" style={{ width: '60%', background: 'var(--accent)' }} />
              </div>
            </div>
          </div>
        ) : pageView === 'calendar' ? (
          <PackagingCalendar
            skus={skus}
            families={families}
            getPlanned={planner.getPlanned}
            assignToCalendar={planner.assignToCalendar}
            setPlanQty={planner.setPlanQty}
            setPlanDay={planner.setPlanDay}
            setPlanTeam={planner.setPlanTeam}
            fillFamilySuggestions={planner.fillFamilySuggestions}
            getExistingTeam={planner.getExistingTeam}
            getExistingQty={planner.getExistingQty}
            getExistingDay={planner.getExistingDay}
            moveExisting={planner.moveExisting}
            onOpenCardModal={openCardModal}
          />
        ) : (
          <PackagingTable
            families={families}
            skus={skus}
            viewMode={viewMode}
            search={search}
            selectedGroups={selectedGroups}
            allCollapsed={allCollapsed}
            getPlanned={planner.getPlanned}
            onSetQty={planner.setPlanQty}
            onSetDay={planner.setPlanDay}
            onSetExistingQty={planner.setExistingQty}
            onSetExistingDay={planner.setExistingDay}
            getExistingQty={planner.getExistingQty}
            getExistingDay={planner.getExistingDay}
            onFillSuggestion={(code) => {
              const sku = skus.find(s => s.productCode === code);
              if (sku && sku.suggestedQty > 0) {
                planner.setPlanQty(code, sku.suggestedQty);
              }
            }}
            onFillFamily={planner.fillFamilySuggestions}
            onSetFamilyDay={planner.setFamilyDay}
            onSetUsage={() => {}} /* usage not user-editable */
            getFamilyTargetDays={config.getTargetDaysForFamily}
            onSetFamilyTargetDays={config.setFamilyTargetDays}
            onClearFamilyTargetDays={config.clearFamilyTargetDays}
            globalTargetDays={config.settings.targetDays}
            getFamilyPlannedKg={planner.getFamilyPlannedKg}
            kitchenBatches={kitchenBatches}
            onClearAll={planner.clearAll}
            statFilter={statFilter}
            getPlannedForFilter={(code) => planner.getPlanned(code)?.quantity ?? 0}
            onOpenModal={(productCode) => {
              // From the table view we don't know the run context (the
              // table doesn't render per-run cards) — hand the modal what
              // we can so it falls back to the SKU-level suggested qty.
              const planned = planner.getPlanned(productCode);
              openCardModal({
                productCode,
                runQuantity: planned?.quantity,
                runDayInt: planned?.dayInt,
                runTeam: planned?.team,
              });
            }}
          />
        )}

        {showSettings && (
          <SettingsPanel
            settings={config.settings}
            onUpdateSettings={config.updateSettings}
            onUpdateFetchIntervals={config.updateFetchIntervals}
            onResetToDefaults={config.resetToDefaults}
            onClose={() => setShowSettings(false)}
          />
        )}
        {showPush && (() => {
          const skuMeta = new Map(
            skus.map((s) => [
              s.productCode,
              {
                productName: s.productName,
                familyName: s.familyName,
                foodComponentCode: s.foodComponentCode,
                kgPerUnit: s.kgPerUnit,
                existingAssemblyId: s.existingAssemblyId,
                existingAssemblyNotes: s.existingAssemblyNotes,
              },
            ]),
          );
          const tasks = buildPackagingPushTasks(
            planner.plannedAssemblies.map((a) => ({
              kind: 'packaging_run' as const,
              id: `pkg:${a.action.toLowerCase()}:${a.productCode}`,
              productCode: a.productCode,
              productName: skuMeta.get(a.productCode)?.productName ?? a.productCode,
              quantity: a.quantity,
              lifecycle: 'draft' as const,
              dayInt: a.dayInt,
              scheduledDate: a.resolvedDate,
              team: a.team,
              action: a.action,
              existingAssemblyId: a.existingAssemblyId,
            })),
            {
              warehouseId: config.settings.warehouseId,
              warehouseName: config.settings.warehouseName,
              skus: skuMeta,
            },
          );
          // The existing `handlePushComplete` clears by productCode; adapt by
          // mapping item ids back to codes from `plannedAssemblies`.
          const idToCode = new Map(
            planner.plannedAssemblies.map((a) => [
              `pkg:${a.action.toLowerCase()}:${a.productCode}`,
              a.productCode,
            ]),
          );
          return (
            <PushPlanDialog
              tasks={tasks}
              onClose={() => setShowPush(false)}
              onComplete={(ids) => {
                const codes = ids.map((id) => idToCode.get(id)).filter((c): c is string => !!c);
                handlePushComplete(codes);
              }}
              disableReason={!config.settings.warehouseId ? 'Packaging warehouse not configured.' : null}
            />
          );
        })()}

        {/* BOM investigation modal — opens for both calendar card clicks and
            table row clicks. State lives here so the two views share the
            same modal instance and data bundle. */}
        {cardModal && (
          <PackagingCardModal
            productCode={cardModal.productCode}
            runQuantity={cardModal.runQuantity}
            runDayInt={cardModal.runDayInt}
            runTeam={cardModal.runTeam}
            skus={skus}
            bomEntries={rawData?.bomEntries || []}
            sohItems={rawData?.sohItems || []}
            supplierByCode={rawData?.supplierByCode || {}}
            onClose={() => setCardModal(null)}
          />
        )}
      </div>
    </PackagingDataContext.Provider>
  );
}
