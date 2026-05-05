'use client';

import { useState, useMemo, useCallback } from 'react';
import { BatchPool } from './components/BatchPool';
import { CalendarGrid } from './components/CalendarGrid';
import { ComponentModal } from './components/ComponentModal';
import { ConfigPanel } from './components/ConfigPanel';
import { PushPlanDialog } from '@/app/components/PushPlanDialog';
import { buildKitchenPushTasks } from '@/lib/planning/push-tasks';
import { LoadingSkeleton } from './components/LoadingSkeleton';
import { ErrorBanner } from './components/ErrorBanner';
import { useConfig } from './hooks/useConfig';
import { useKitchenData } from './hooks/useKitchenData';
import { useKitchenPlanner } from './hooks/useKitchenPlanner';
import { KitchenDataContext } from './context/KitchenDataContext';
import { usePersistedState } from '@/app/hooks/usePersistedState';

export default function KitchenCalendar() {
  const cfg = useConfig();
  const kitchenData = useKitchenData(cfg.intermediateRegistry, {
    kitchenWarehouseId: cfg.kitchenWarehouseId,
    onWarehouseResolved: cfg.setKitchenWarehouse,
  });
  const { intermediates, componentSOH, globalComponentSOH, perProductSOH, components, openPOLines, loading, error, refetch, updateIntermediateBatchSize } =
    kitchenData;
  const planner = useKitchenPlanner(
    intermediates,
    componentSOH,
    cfg.packagingDeadlines,
    cfg.blockStart,
    cfg.blockEnd,
    globalComponentSOH,
  );
  const [selectedIntermediate, setSelectedIntermediate] = useState<
    string | null
  >(null);
  const [showConfig, setShowConfig] = useState(false);
  const [showPushDialog, setShowPushDialog] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  // Persisted so the sidebar stays collapsed/expanded across navigation.
  const [poolCollapsed, setPoolCollapsed] = usePersistedState<boolean>('byron-kitchen-pool-collapsed', false);
  /**
   * Clickable stat-card filter. Dims batches on the calendar that don't match
   * the selected feasibility colour (null = no filter). Lets an operator
   * quickly focus on "only the red/at-risk batches" without losing context.
   * Persisted so the same view survives navigation.
   */
  const [feasibilityFilter, setFeasibilityFilter] = usePersistedState<'green' | 'amber' | 'red' | null>('byron-kitchen-feasibility-filter', null);
  const toggleFeasibilityFilter = useCallback(
    (f: 'green' | 'amber' | 'red') => setFeasibilityFilter(prev => prev === f ? null : f),
    [],
  );

  // Format block date range
  const blockDateRange = useMemo(() => {
    const start = cfg.blockStart.toLocaleDateString('en-AU', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
    const end = cfg.blockEnd.toLocaleDateString('en-AU', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
    return `${start} — ${end}`;
  }, [cfg.blockStart, cfg.blockEnd]);

  // Count feasibility status
  const stats = useMemo(() => {
    let feasible = 0;
    let atRisk = 0;
    let infeasible = 0;

    for (const batch of planner.scheduledBatches) {
      const color = planner.getFeasibilityColor(batch.id);
      if (color === 'green') feasible++;
      else if (color === 'amber') atRisk++;
      else infeasible++;
    }

    return { feasible, atRisk, infeasible };
  }, [planner.scheduledBatches, planner.getFeasibilityColor]);

  // After successful push, remove pushed batches from calendar and clear draft
  const handlePushComplete = useCallback(
    (succeededBatchIds: string[]) => {
      for (const id of succeededBatchIds) {
        planner.removeBatch(id);
      }
      planner.clearDraft();
    },
    [planner.removeBatch, planner.clearDraft]
  );

  // Show skeleton while loading (and no data yet)
  if (loading && Object.keys(intermediates).length === 0) {
    return <LoadingSkeleton />;
  }

  return (
    <KitchenDataContext.Provider
      value={{ intermediates, componentSOH, globalComponentSOH, perProductSOH, components, scheduledBatches: planner.scheduledBatches, blockStart: cfg.blockStart, blockEnd: cfg.blockEnd, packagingDeadlines: cfg.packagingDeadlines, openPOLines, updateBatchQuantity: planner.updateBatchQuantity, updateIntermediateBatchSize }}
    >
      <div className="h-screen flex flex-col" style={{ background: 'var(--bg-page)', color: 'var(--text-primary)' }}>
        {/* Error banner (non-blocking -- shown above content with fallback data) */}
        {error && <ErrorBanner message={error} onRetry={refetch} />}

        {/* Top bar */}
        <div className="px-6 py-4" style={{ borderBottom: '0.5px solid var(--border)' }}>
          <div className="flex items-center justify-between mb-4">
            <div>
              <h1 className="text-xl" style={{ fontWeight: 500, color: 'var(--text-primary)' }}>
                Kitchen Calendar Planner
              </h1>
              <div className="flex items-center gap-3 mt-1.5">
                <button
                  onClick={() => cfg.shiftBlock('prev')}
                  className="px-2 py-0.5 text-xs rounded transition hover:opacity-70"
                  style={{ color: 'var(--text-secondary)', border: '0.5px solid var(--border)', fontWeight: 500 }}
                >
                  Prev
                </button>
                <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                  {blockDateRange}
                </p>
                <button
                  onClick={() => cfg.shiftBlock('next')}
                  className="px-2 py-0.5 text-xs rounded transition hover:opacity-70"
                  style={{ color: 'var(--text-secondary)', border: '0.5px solid var(--border)', fontWeight: 500 }}
                >
                  Next
                </button>
              </div>
            </div>

            {/* Top bar buttons */}
            <div className="flex items-center gap-2">
              <a
                href="/kitchen/parameters"
                className="px-3 py-1.5 rounded text-sm transition hover:opacity-80 no-underline"
                style={{ color: 'var(--text-secondary)', border: '0.5px solid var(--border)', fontWeight: 400 }}
                title="Kitchen Parameters — assign resources per blend"
              >
                Parameters
              </a>
              <button
                onClick={() => setShowConfig(true)}
                className="px-3 py-1.5 rounded text-sm transition hover:opacity-80"
                style={{ color: 'var(--text-secondary)', border: '0.5px solid var(--border)', fontWeight: 400 }}
                title="Settings"
              >
                Settings
              </button>
              <button
                onClick={() => planner.reset()}
                className="px-3 py-1.5 rounded text-sm transition hover:opacity-80"
                style={{ color: 'var(--text-secondary)', border: '0.5px solid var(--border)', fontWeight: 400 }}
              >
                Reset
              </button>
              <button
                onClick={() => {
                  planner.saveDraft();
                  setSavedFlash(true);
                  setTimeout(() => setSavedFlash(false), 2000);
                }}
                disabled={planner.scheduledBatches.length === 0}
                className="px-3 py-1.5 rounded text-sm text-white transition disabled:opacity-30 disabled:cursor-not-allowed"
                style={{ background: 'var(--accent)', fontWeight: 500 }}
              >
                {savedFlash ? 'Saved' : 'Save Draft'}
              </button>
              <button
                onClick={() => setShowPushDialog(true)}
                disabled={planner.scheduledBatches.length === 0}
                className="px-3 py-1.5 rounded text-sm text-white transition disabled:opacity-30 disabled:cursor-not-allowed"
                style={{ background: 'var(--success)', fontWeight: 500 }}
              >
                Push to Unleashed
              </button>
            </div>
          </div>

          {/* Metric cards — each colour card is a clickable filter that
              dims non-matching batches on the calendar so an operator can
              focus on (e.g.) only the red infeasible ones. "Scheduled" is
              the total and clears the filter. */}
          <div className="grid grid-cols-4 gap-4">
            {([
              { label: 'Scheduled', value: planner.scheduledBatches.length, color: planner.scheduledBatches.length > 0 ? 'var(--accent)' : undefined, filter: null },
              { label: 'Feasible', value: stats.feasible, color: stats.feasible > 0 ? 'var(--success)' : undefined, filter: 'green' },
              { label: 'At Risk', value: stats.atRisk, color: stats.atRisk > 0 ? 'var(--warning)' : undefined, filter: 'amber' },
              { label: 'Infeasible', value: stats.infeasible, color: stats.infeasible > 0 ? 'var(--danger)' : undefined, filter: 'red' },
            ] as { label: string; value: number; color: string | undefined; filter: 'green' | 'amber' | 'red' | null }[]).map((card) => {
              const active = card.filter !== null && feasibilityFilter === card.filter;
              return (
                <button
                  key={card.label}
                  onClick={() => {
                    if (card.filter === null) setFeasibilityFilter(null);
                    else toggleFeasibilityFilter(card.filter);
                  }}
                  className="rounded px-4 py-3 text-left transition hover:opacity-85"
                  style={{
                    background: active ? 'var(--bg-hover)' : 'var(--bg-surface)',
                    border: active ? `1px solid ${card.color || 'var(--accent)'}` : '1px solid transparent',
                    cursor: 'pointer',
                  }}
                  title={active ? 'Click to clear filter' : card.filter ? `Dim all batches that aren't ${card.label.toLowerCase()}` : 'Clear filter'}
                >
                  <div className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--text-muted)', fontWeight: 500 }}>
                    {card.label}{active && ' · filtering'}
                  </div>
                  <div className="text-2xl mt-0.5" style={{ fontWeight: 500, color: card.color || 'var(--text-primary)' }}>
                    {card.value}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Main layout */}
        <div className="flex-1 flex overflow-hidden">
          {/* Left sidebar - Batch Pool (collapsible) */}
          <div
            className={`flex flex-col flex-shrink-0 transition-all duration-200 ${
              poolCollapsed ? 'w-10' : 'w-80'
            }`}
            style={{ borderRight: '0.5px solid var(--border)' }}
          >
            {/* Collapse toggle */}
            <button
              onClick={() => setPoolCollapsed(!poolCollapsed)}
              className="flex items-center justify-center py-2 text-xs transition hover:opacity-70"
              style={{
                background: 'var(--bg-surface)',
                color: 'var(--text-muted)',
                borderBottom: '0.5px solid var(--border)',
              }}
              title={poolCollapsed ? 'Show batch pool' : 'Hide batch pool'}
            >
              {poolCollapsed ? '>' : '<'}{' '}
              {!poolCollapsed && (
                <span className="ml-1">
                  Pool ({planner.unscheduledBatches.secondary.length + planner.unscheduledBatches.topLevel.length})
                </span>
              )}
            </button>
            {!poolCollapsed && (
              <BatchPool
                unscheduledBatches={planner.unscheduledBatches}
                onBatchDragStart={planner.handleDragStart}
                onBatchClick={setSelectedIntermediate}
              />
            )}
          </div>

          {/* Center - Calendar Grid */}
          <CalendarGrid
            calendar={planner.calendar}
            blockStart={cfg.blockStart}
            blockEnd={cfg.blockEnd}
            packagingDeadlines={cfg.packagingDeadlines}
            scheduledBatches={planner.scheduledBatches}
            draggedBatch={planner.draggedBatch}
            getBatchesForDate={planner.getBatchesForDate}
            getEquipmentOnDate={planner.getEquipmentOnDate}
            getFeasibilityColor={planner.getFeasibilityColor}
            getBatchWarnings={planner.getBatchWarnings}
            hasEquipmentConflict={planner.hasEquipmentConflict}
            onHandleDrop={planner.handleDrop}
            onBatchRemove={planner.removeBatch}
            onBatchReschedule={planner.rescheduleBatch}
            onBatchClick={setSelectedIntermediate}
            riskEvents={planner.riskEvents}
            kitchenResources={cfg.kitchenResources}
            feasibilityFilter={feasibilityFilter}
          />
        </div>

        {/* Legend bar */}
        <div className="px-6 py-3" style={{ borderTop: '0.5px solid var(--border)', background: 'var(--bg-surface)' }}>
          <div className="flex items-center gap-6 text-xs">
            <div>
              <span style={{ fontWeight: 500, color: 'var(--text-primary)' }}>Feasibility:</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded" style={{ background: 'var(--success)' }} />
              <span style={{ color: 'var(--text-secondary)' }}>Feasible</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded" style={{ background: 'var(--warning)' }} />
              <span style={{ color: 'var(--text-secondary)' }}>At Risk</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded" style={{ background: 'var(--danger)' }} />
              <span style={{ color: 'var(--text-secondary)' }}>Infeasible</span>
            </div>

            <div className="pl-6 ml-6" style={{ borderLeft: '0.5px solid var(--border)' }}>
              <span style={{ fontWeight: 500, color: 'var(--text-primary)' }}>Equipment:</span>
            </div>
            <div className="flex items-center gap-2">
              <div
                className="w-3 h-3 rounded-full"
                style={{ backgroundColor: 'var(--equip-oven)' }}
              />
              <span style={{ color: 'var(--text-secondary)' }}>Oven</span>
            </div>
            <div className="flex items-center gap-2">
              <div
                className="w-3 h-3 rounded-full"
                style={{ backgroundColor: 'var(--equip-dehydrator)' }}
              />
              <span style={{ color: 'var(--text-secondary)' }}>Dehydrator</span>
            </div>
            <div className="flex items-center gap-2">
              <div
                className="w-3 h-3 rounded-full"
                style={{ backgroundColor: 'var(--equip-mixer)' }}
              />
              <span style={{ color: 'var(--text-secondary)' }}>Mixer</span>
            </div>
          </div>
        </div>

        {/* Component Investigation Modal */}
        <ComponentModal
          intermediateCode={selectedIntermediate}
          onClose={() => setSelectedIntermediate(null)}
        />

        {/* Config Panel */}
        {showConfig && (
          <ConfigPanel
            config={cfg.config}
            onSetBlockDates={cfg.setBlockDates}
            onUpdateIntermediate={cfg.updateIntermediate}
            onRemoveIntermediate={cfg.removeIntermediate}
            onSetPackagingDeadlines={cfg.setPackagingDeadlines}
            onResetToDefaults={cfg.resetToDefaults}
            onClose={() => setShowConfig(false)}
          />
        )}

        {/* Push to Unleashed Dialog */}
        {showPushDialog && (() => {
          const tasks = buildKitchenPushTasks(
            planner.scheduledBatches
              .filter((b) => b.origin !== 'unleashed')
              .map((b) => ({
                kind: 'kitchen_run' as const,
                id: b.id,
                productCode: b.productCode,
                productName: b.productName,
                quantity: b.quantity,
                lifecycle: 'draft' as const,
                scheduledDate: '',
                intermediateKey: b.intermediateKey,
                dehydrator: b.dehydrator,
                origin: b.origin ?? 'draft',
                status: b.status as 'planned' | 'scheduled' | 'in_progress' | 'completed',
                assemblyNumber: b.assemblyNumber,
              })),
            { warehouseId: cfg.kitchenWarehouseId, warehouseName: cfg.kitchenWarehouseName, intermediates },
          );
          return (
            <PushPlanDialog
              tasks={tasks}
              onClose={() => setShowPushDialog(false)}
              onComplete={handlePushComplete}
              disableReason={!cfg.kitchenWarehouseId ? 'Kitchen warehouse not resolved. Check Settings.' : null}
            />
          );
        })()}
      </div>
    </KitchenDataContext.Provider>
  );
}
