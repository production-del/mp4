'use client';

import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { BusinessCalendar } from '@/lib/engine/business-calendar';
import { analyzeKitchenBatches } from '@/lib/engine/kitchen-projection';
import { diffFeasibility, buildFeasibilitySnapshot } from '@/lib/engine/feasibility-diff';
import type { FeasibilitySnapshot } from '@/lib/engine/feasibility-diff';
import type { KitchenBatch, BatchFeasibility } from '@/lib/planning/engine-io';
import type { RiskEvent } from '@/lib/planning/risk-events';
import type { IntermediateData } from '../data/mock-data';
import type { PackagingDeadline } from './useConfig';
import { toLocalISODate, fromLocalISODate } from '@/lib/planning/working-day';
import type { KitchenRunItem } from '@/lib/planning/plan-item';
import {
  listByKind,
  replaceByKind,
  listDismissedKitchenKeys,
  addDismissedKitchenKey,
  removeDismissedKitchenKey,
  clearDismissedKitchenKeys,
} from '@/lib/planning/plan-draft-store';

/**
 * Re-export from the canonical plan-item definition. Widened to `string` so
 * ovens, mixers, and any user-added resource can use the same lane system.
 * The constant `DEHYDRATOR_SLOTS` is gone — the lane list is now owned by
 * `KitchenConfig.kitchenResources` (edited on `/kitchen/parameters`).
 */
import type { DehydratorSlot } from '@/lib/planning/plan-item';
export type { DehydratorSlot };

export interface ScheduledBatch extends KitchenBatch {
  intermediateKey: string; // assemblyId — key into the intermediates map
  assemblyNumber?: string;
  feasibility?: BatchFeasibility;
  /** Where this batch came from: auto-placed from Unleashed or user-created draft */
  origin?: 'unleashed' | 'draft';
  /** Which dehydrator this batch is assigned to (dehydrator batches only) */
  dehydrator?: DehydratorSlot;
}

// --- Draft persistence (facade over PlanDraftStore) ---

/**
 * Internal `ScheduledBatch` keeps `scheduledDate: Date` for the UI; the store
 * persists ISO strings. These helpers bridge the two without leaking the
 * conversion through the whole hook.
 */
function toKitchenRunItem(b: ScheduledBatch): KitchenRunItem {
  return {
    kind: 'kitchen_run',
    id: b.id,
    productCode: b.productCode,
    productName: b.productName,
    quantity: b.quantity,
    lifecycle: b.origin === 'unleashed' ? 'pushed' : 'draft',
    scheduledDate: toLocalISODate(b.scheduledDate),
    intermediateKey: b.intermediateKey,
    dehydrator: b.dehydrator,
    origin: b.origin ?? 'draft',
    status: b.status as KitchenRunItem['status'],
    assemblyNumber: b.assemblyNumber,
  };
}

function fromKitchenRunItem(item: KitchenRunItem): ScheduledBatch {
  return {
    id: item.id,
    productCode: item.productCode,
    productName: item.productName,
    quantity: item.quantity,
    scheduledDate: fromLocalISODate(item.scheduledDate),
    status: (item.status ?? 'planned') as ScheduledBatch['status'],
    dependencies: [],
    intermediateKey: item.intermediateKey,
    dehydrator: item.dehydrator,
    origin: item.origin,
    assemblyNumber: item.assemblyNumber,
  };
}

function loadDraftFromStorage(): ScheduledBatch[] | null {
  const items = listByKind('kitchen_run');
  if (items.length === 0) return null;
  // Planner only cares about draft-origin batches here; unleashed ones are
  // rebuilt fresh on each data fetch.
  return items
    .filter(i => i.origin !== 'unleashed')
    .map(fromKitchenRunItem);
}

function saveDraftToStorage(batches: ScheduledBatch[]): void {
  // Preserve pushed/unleashed batches already in the store when we replace
  // the kitchen_run slice. Planner owns the draft-origin subset; unleashed
  // batches are re-derived from API but may still be present after a push.
  const existing = listByKind('kitchen_run').filter(i => i.origin === 'unleashed');
  const draftItems = batches.map(toKitchenRunItem);
  replaceByKind('kitchen_run', [...existing, ...draftItems]);
}

function clearDraftFromStorage(): void {
  const existing = listByKind('kitchen_run').filter(i => i.origin === 'unleashed');
  replaceByKind('kitchen_run', existing);
}

function replaceAllScheduledBatches(batches: ScheduledBatch[]): void {
  replaceByKind('kitchen_run', batches.map(toKitchenRunItem));
}

/** A batch slot in the sidebar — one per Unleashed assembly */
export interface UnscheduledBatchSlot {
  intermediate: IntermediateData;
  intermediateKey: string; // assemblyId — key into intermediates map
  /** True if this assembly is already placed on the calendar */
  isScheduled?: boolean;
  /** Date the assembly is scheduled on the calendar (undefined when not scheduled) */
  scheduledDate?: Date;
}

/**
 * Custom hook managing kitchen planner state:
 * - Batch scheduling
 * - Drag and drop handlers
 * - Feasibility calculations
 *
 * Accepts intermediates and SOH data as parameters — the data source
 * (live Unleashed or mock) is determined by the caller (useKitchenData).
 */
export function useKitchenPlanner(
  intermediates: Record<string, IntermediateData>,
  componentSOH: Record<string, number>,
  packagingDeadlines: PackagingDeadline[] = [],
  blockStart?: Date,
  blockEnd?: Date,
  globalComponentSOH?: Record<string, number>,
) {
  const [scheduledBatches, setScheduledBatches] = useState<ScheduledBatch[]>([]);
  const [draggedBatch, setDraggedBatch] = useState<{
    intermediateCode: string;
    count: number;
  } | null>(null);
  // Intermediate keys the operator has hidden from the calendar. Auto-scheduled
  // unleashed batches whose key is in this set are held back in the sidebar
  // until the operator drags them in again. Persisted via plan-draft-store.
  const [dismissedKeys, setDismissedKeys] = useState<Set<string>>(() => new Set());

  // Restore draft + dismissed keys from localStorage on mount. SSR guard: the
  // initial useState can't read localStorage (store functions bail on SSR),
  // so hydrate here once the client is alive.
  useEffect(() => {
    const draft = loadDraftFromStorage();
    if (draft && draft.length > 0) {
      setScheduledBatches(draft);
    }
    const persisted = listDismissedKitchenKeys();
    if (persisted.length > 0) {
      setDismissedKeys(new Set(persisted));
    }
  }, []);

  // Auto-schedule assemblies whose createdOn falls within the block.
  // Unleashed-origin batches are recalculated whenever intermediates or block changes.
  // Draft batches (user-placed or rescheduled) take precedence — if a draft exists
  // for an assemblyId, the unleashed auto-placement is skipped for that one.
  useEffect(() => {
    if (Object.keys(intermediates).length === 0) return;
    if (!blockStart || !blockEnd) return;

    const startStr = toLocalISODate(blockStart);
    const endStr = toLocalISODate(blockEnd);

    setScheduledBatches((prev) => {
      // Keep all draft-origin batches (user-placed or rescheduled)
      const draftBatches = prev.filter((b) => b.origin !== 'unleashed');
      const draftKeys = new Set(draftBatches.map((b) => b.intermediateKey));

      // Build new unleashed batch list for this block
      const unleashedBatches: ScheduledBatch[] = [];

      for (const [key, intermediate] of Object.entries(intermediates)) {
        if (draftKeys.has(key)) continue; // Draft overrides unleashed
        if (dismissedKeys.has(key)) continue; // Operator hid this from the calendar
        if (!intermediate.createdOn) continue;

        const createdDate = intermediate.createdOn.split('T')[0];
        if (createdDate >= startStr && createdDate <= endStr) {
          unleashedBatches.push({
            id: `unleashed-${key}`,
            intermediateKey: key,
            assemblyNumber: intermediate.assemblyNumber,
            productCode: intermediate.code,
            productName: intermediate.name,
            quantity: intermediate.batchSize,
            scheduledDate: new Date(intermediate.createdOn),
            status: 'planned',
            dependencies: intermediate.requires,
            origin: 'unleashed',
          });
        }
      }

      const combined = [...draftBatches, ...unleashedBatches];
      // Only update state if something actually changed
      if (combined.length === prev.length &&
          combined.every((b, i) => b.id === prev[i]?.id)) {
        return prev;
      }
      return combined;
    });
  }, [intermediates, blockStart, blockEnd, dismissedKeys]);

  // Initialize business calendar
  const calendar = useMemo(() => new BusinessCalendar(), []);

  // Calculate feasibility for all scheduled batches
  const feasibilityResults = useMemo(() => {
    if (scheduledBatches.length === 0) return new Map<string, BatchFeasibility>();

    // Build BOM from intermediate data
    // De-duplicate: only emit one set of BOM entries per product code
    const boms = [];
    const seenProductCodes = new Set<string>();
    // Build set of all intermediate product codes (for level detection)
    const intermediateProductCodes = new Set(
      Object.values(intermediates).map((i) => i.code)
    );
    for (const [, intermediate] of Object.entries(intermediates)) {
      if (seenProductCodes.has(intermediate.code)) continue;
      seenProductCodes.add(intermediate.code);
      for (const [componentCode, qty] of Object.entries(
        intermediate.components
      )) {
        boms.push({
          productCode: componentCode,
          productName: intermediate.code,
          quantityPerParent: qty,
          level: intermediateProductCodes.has(componentCode) ? 2 : 1,
          parentProductCode: intermediate.code,
        });
      }
    }

    // Convert SOH to array format, deducting committed packaging demand.
    // Packaging runs consume intermediate stock — this must be reserved
    // so kitchen feasibility doesn't double-count available stock.
    const packagingReserved = new Map<string, number>();
    for (const deadline of packagingDeadlines) {
      if (!deadline.demandKg) continue;
      for (const [code, kg] of Object.entries(deadline.demandKg)) {
        packagingReserved.set(code, (packagingReserved.get(code) || 0) + kg);
      }
    }

    const sohArray = Object.entries(componentSOH).map(([code, quantity]) => ({
      productCode: code,
      productName: code,
      quantity: quantity - (packagingReserved.get(code) || 0),
      warehouseId: 'default',
    }));

    // Build global SOH array for amber state detection
    const globalSohArray = globalComponentSOH
      ? Object.entries(globalComponentSOH).map(([code, quantity]) => ({
          productCode: code,
          productName: code,
          quantity,
          warehouseId: 'global',
        }))
      : undefined;

    // Enrich batches with durationDays from their blend config. The engine
    // reads `durationDays` on each batch to know when the output becomes
    // available; deriving at call-time (rather than persisting on the batch)
    // means a later Kitchen Parameters edit takes effect on the next render
    // without any batch-record migration.
    const batchesForEngine = scheduledBatches.map((b) => ({
      ...b,
      durationDays: intermediates[b.intermediateKey]?.durationDays,
    }));

    // Run projection engine
    const result = analyzeKitchenBatches({
      batches: batchesForEngine,
      boms,
      soh: sohArray,
      globalSOH: globalSohArray,
      businessCalendar: calendar,
    });

    // Map by batch ID for quick lookup
    const map = new Map<string, BatchFeasibility>();
    for (const batch of result.batches) {
      map.set(batch.batchId, batch);
    }
    return map;
  }, [scheduledBatches, calendar, intermediates, componentSOH, globalComponentSOH, packagingDeadlines]);

  // Get ALL batch slots grouped by level.
  // Each slot = one Unleashed assembly (1:1 mapping).
  // Scheduled assemblies are included but flagged so the sidebar can show them.
  const unscheduledBatches = useMemo(() => {
    // Map the scheduled date per intermediate key. If an assembly has multiple
    // batches (rare but possible), the earliest date wins — that's the one an
    // operator scanning the sidebar cares about first.
    const scheduledDateByKey = new Map<string, Date>();
    for (const b of scheduledBatches) {
      const existing = scheduledDateByKey.get(b.intermediateKey);
      if (!existing || b.scheduledDate < existing) {
        scheduledDateByKey.set(b.intermediateKey, b.scheduledDate);
      }
    }

    const secondary: UnscheduledBatchSlot[] = [];
    const topLevel: UnscheduledBatchSlot[] = [];

    for (const [key, intermediate] of Object.entries(intermediates)) {
      const scheduledDate = scheduledDateByKey.get(key);
      const slot: UnscheduledBatchSlot = {
        intermediate,
        intermediateKey: key,
        isScheduled: scheduledDate !== undefined,
        scheduledDate,
      };
      if (intermediate.level === 'secondary') {
        secondary.push(slot);
      } else {
        topLevel.push(slot);
      }
    }

    return { secondary, topLevel };
  }, [scheduledBatches, intermediates]);

  // Calculate how many batches needed for a product code
  const calculateBatchesNeeded = useCallback(
    (code: string): number => {
      // Count assemblies for this product code
      return Object.values(intermediates).filter((i) => i.code === code).length;
    },
    [intermediates]
  );

  // Schedule a single batch on a date.
  // If the assembly is already on the calendar (unleashed or draft), move it instead of duplicating.
  const scheduleBatch = useCallback(
    (intermediateKey: string, scheduledDate: Date, dehydrator?: DehydratorSlot) => {
      const intermediate = intermediates[intermediateKey];
      if (!intermediate) return;

      // Placing a batch on the calendar clears any prior dismissal so it
      // stays put across renders.
      setDismissedKeys((prev) => {
        if (!prev.has(intermediateKey)) return prev;
        const next = new Set(prev);
        next.delete(intermediateKey);
        return next;
      });
      removeDismissedKitchenKey(intermediateKey);

      setScheduledBatches((prev) => {
        const existing = prev.find((b) => b.intermediateKey === intermediateKey);
        if (existing) {
          // Move the existing batch to the new date, convert to draft
          return prev.map((b) =>
            b.intermediateKey === intermediateKey
              ? { ...b, scheduledDate, origin: 'draft' as const, dehydrator: dehydrator ?? b.dehydrator }
              : b
          );
        }

        // Create new batch
        const batch: ScheduledBatch = {
          id: `batch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          intermediateKey,
          assemblyNumber: intermediate.assemblyNumber,
          productCode: intermediate.code,
          productName: intermediate.name,
          quantity: intermediate.batchSize,
          scheduledDate,
          status: 'planned',
          dependencies: intermediate.requires,
          origin: 'draft',
          dehydrator,
        };
        return [...prev, batch];
      });
    },
    [intermediates]
  );

  // Reschedule a batch to a new date (unleashed batches become draft when moved)
  const rescheduleBatch = useCallback((batchId: string, newDate: Date, dehydrator?: DehydratorSlot) => {
    setScheduledBatches((prev) => {
      const target = prev.find((b) => b.id === batchId);
      // Moving a batch implies "keep this on the calendar" — clear any stale
      // dismissal. Harmless when the key isn't dismissed.
      if (target) {
        setDismissedKeys((d) => {
          if (!d.has(target.intermediateKey)) return d;
          const next = new Set(d);
          next.delete(target.intermediateKey);
          return next;
        });
        removeDismissedKitchenKey(target.intermediateKey);
      }
      return prev.map((batch) =>
        batch.id === batchId
          ? { ...batch, scheduledDate: newDate, origin: 'draft', dehydrator: dehydrator ?? batch.dehydrator }
          : batch
      );
    });
  }, []);

  // Update a scheduled batch's quantity
  const updateBatchQuantity = useCallback((batchId: string, quantity: number) => {
    setScheduledBatches((prev) =>
      prev.map((batch) =>
        batch.id === batchId ? { ...batch, quantity } : batch
      )
    );
  }, []);

  // Remove a batch. For unleashed-origin batches we also persist a dismissal
  // so the auto-schedule effect doesn't immediately re-add the assembly on
  // the next render. Draft batches are purely user-authored — removing them
  // is a plain delete.
  const removeBatch = useCallback((batchId: string) => {
    setScheduledBatches((prev) => {
      const target = prev.find((b) => b.id === batchId);
      if (target && target.origin === 'unleashed') {
        setDismissedKeys((d) => {
          if (d.has(target.intermediateKey)) return d;
          const next = new Set(d);
          next.add(target.intermediateKey);
          return next;
        });
        addDismissedKitchenKey(target.intermediateKey);
      }
      return prev.filter((batch) => batch.id !== batchId);
    });
  }, []);

  // Get scheduled batches for a specific date
  const getBatchesForDate = useCallback(
    (date: Date): ScheduledBatch[] => {
      const dateStr = toLocalISODate(date);
      return scheduledBatches.filter(
        (batch) => toLocalISODate(batch.scheduledDate) === dateStr
      );
    },
    [scheduledBatches]
  );

  // Get equipment utilization for a date
  const getEquipmentOnDate = useCallback(
    (date: Date): Record<string, number> => {
      const batches = getBatchesForDate(date);
      const equipment: Record<string, number> = {};

      for (const batch of batches) {
        const intermediate = intermediates[batch.intermediateKey];
        if (intermediate) {
          equipment[intermediate.equipment] =
            (equipment[intermediate.equipment] || 0) + 1;
        }
      }

      return equipment;
    },
    [getBatchesForDate, intermediates]
  );

  // Build a deadline lookup: intermediate code → earliest packaging deadline
  const deadlineMap = useMemo(() => {
    const map: Record<string, string> = {};
    // 1. From intermediate data (if populated directly)
    for (const intermediate of Object.values(intermediates)) {
      if (intermediate.deadline) {
        map[intermediate.code] = intermediate.deadline;
      }
    }
    // 2. From packaging calendar's planned deadlines (via familyCodes)
    // Each deadline has familyCodes (e.g., ["IAW"]) mapping to intermediate codes
    for (const deadline of packagingDeadlines) {
      if (!deadline.familyCodes) continue;
      for (const familyCode of deadline.familyCodes) {
        // Keep the earliest deadline per intermediate
        if (!map[familyCode] || deadline.date < map[familyCode]) {
          map[familyCode] = deadline.date;
        }
      }
    }
    return map;
  }, [intermediates, packagingDeadlines]);

  // Check if a batch will finish after its packaging deadline.
  // For multi-day batches we compare the LAST processing day — not the
  // start — since that's when the output becomes available. A 2-day batch
  // that starts the day before its deadline still finishes on deadline day,
  // which is fine; but starting on deadline day pushes finish past it.
  const isBatchPastDeadline = useCallback(
    (batch: ScheduledBatch): boolean => {
      const deadline = deadlineMap[batch.productCode];
      if (!deadline) return false;
      const intermediate = intermediates[batch.intermediateKey];
      const duration = Math.max(1, intermediate?.durationDays ?? 1);
      const lastProcessingDay = new Date(batch.scheduledDate);
      lastProcessingDay.setDate(lastProcessingDay.getDate() + (duration - 1));
      const batchDate = toLocalISODate(lastProcessingDay);
      // Normalize deadline to date-only for consistent comparison
      const deadlineDate = deadline.includes('T') ? deadline.split('T')[0] : deadline;
      return batchDate > deadlineDate;
    },
    [deadlineMap, intermediates]
  );

  // --- Backward risk propagation ---
  // Track previous feasibility snapshot to detect worsening states.
  const prevSnapshotRef = useRef<Map<string, FeasibilitySnapshot>>(new Map());
  const [riskEvents, setRiskEvents] = useState<RiskEvent[]>([]);

  // After feasibility recalculates, diff against previous snapshot.
  // We inline the color logic (mirrors getFeasibilityColor) to avoid a
  // circular dependency — this effect fires when feasibilityResults changes
  // and getFeasibilityColor is derived from the same data.
  useEffect(() => {
    const currentSnapshot = buildFeasibilitySnapshot(
      feasibilityResults,
      (batchId) => {
        const batch = scheduledBatches.find((b) => b.id === batchId);
        if (batch && isBatchPastDeadline(batch)) return 'red';

        const feasibility = feasibilityResults.get(batchId);
        if (!feasibility) return 'green';

        if (feasibility.feasible && feasibility.missingComponents.length === 0) return 'green';

        if (feasibility.missingComponents.length > 0) {
          const allTransferable = feasibility.missingComponents.every(
            (mc) => mc.globalAvailable >= mc.required,
          );
          return allTransferable ? 'amber' : 'red';
        }

        return feasibility.feasible ? 'green' : 'red';
      },
    );

    // Only diff if we have a previous snapshot (skip the initial render).
    if (prevSnapshotRef.current.size > 0) {
      const newEvents = diffFeasibility(prevSnapshotRef.current, currentSnapshot);
      if (newEvents.length > 0) {
        setRiskEvents((prev) => [...prev, ...newEvents]);
      }
    }

    prevSnapshotRef.current = currentSnapshot;
  }, [feasibilityResults, scheduledBatches, isBatchPastDeadline]);

  // Dismiss a single risk event by ID.
  const dismissRisk = useCallback((riskId: string) => {
    setRiskEvents((prev) => prev.filter((e) => e.id !== riskId));
  }, []);

  // Check if a date has equipment conflicts (same equipment used by 2+ batches)
  const hasEquipmentConflict = useCallback(
    (date: Date): boolean => {
      const batches = getBatchesForDate(date);
      const seen = new Set<string>();
      for (const batch of batches) {
        const intermediate = intermediates[batch.intermediateKey];
        if (intermediate) {
          if (seen.has(intermediate.equipment)) return true;
          seen.add(intermediate.equipment);
        }
      }
      return false;
    },
    [getBatchesForDate, intermediates]
  );

  // Get feasibility color for a batch — three-state with warehouse awareness
  // green = sufficient SOH at Lundberg Storeroom
  // amber = insufficient at Lundberg, but sufficient globally (needs transfer)
  // red   = insufficient globally (needs purchasing)
  const getFeasibilityColor = useCallback(
    (batchId: string): 'green' | 'amber' | 'red' => {
      const batch = scheduledBatches.find((b) => b.id === batchId);
      if (batch && isBatchPastDeadline(batch)) return 'red';

      const feasibility = feasibilityResults.get(batchId);
      if (!feasibility) return 'green';

      if (feasibility.feasible && feasibility.missingComponents.length === 0) return 'green';

      // Check missing components — if all shortfalls are coverable globally, it's amber (transferable)
      if (feasibility.missingComponents.length > 0) {
        const allTransferable = feasibility.missingComponents.every(
          mc => mc.globalAvailable >= mc.required
        );
        return allTransferable ? 'amber' : 'red';
      }

      return feasibility.feasible ? 'green' : 'red';
    },
    [feasibilityResults, scheduledBatches, isBatchPastDeadline]
  );

  // Get human-readable warnings for a batch (shown as tooltip)
  const getBatchWarnings = useCallback(
    (batchId: string): string[] => {
      const warnings: string[] = [];
      const batch = scheduledBatches.find((b) => b.id === batchId);
      if (!batch) return warnings;

      // Deadline check
      if (isBatchPastDeadline(batch)) {
        const deadline = deadlineMap[batch.productCode];
        const deadlineLabel = packagingDeadlines.find(
          (d) => d.date === deadline
        )?.label;
        warnings.push(
          `Past deadline: ${deadlineLabel || deadline}`
        );
      }

      // Engine feasibility
      const feasibility = feasibilityResults.get(batchId);
      if (feasibility) {
        for (const shortfall of feasibility.missingComponents) {
          warnings.push(
            `${shortfall.productCode}: need ${Math.round(shortfall.required)}, have ${Math.round(shortfall.available)} (short ${Math.round(shortfall.shortfall)})`
          );
        }
        // Include engine constraints that aren't about components
        for (const constraint of feasibility.constraints) {
          if (!constraint.startsWith('Insufficient')) {
            warnings.push(constraint);
          }
        }
      }

      // Equipment conflict
      if (hasEquipmentConflict(batch.scheduledDate)) {
        const intermediate = intermediates[batch.intermediateKey];
        if (intermediate) {
          const batches = getBatchesForDate(batch.scheduledDate);
          const sameEquip = batches.filter((b) => {
            const other = intermediates[b.intermediateKey];
            return other && other.equipment === intermediate.equipment && b.id !== batchId;
          });
          if (sameEquip.length > 0) {
            warnings.push(
              `Equipment conflict: ${intermediate.equipment} also used by ${sameEquip.map((b) => b.productCode).join(', ')}`
            );
          }
        }
      }

      return warnings;
    },
    [scheduledBatches, feasibilityResults, isBatchPastDeadline, deadlineMap, hasEquipmentConflict, intermediates, getBatchesForDate]
  );

  // Drag handlers — each drag represents a single assembly batch
  const handleDragStart = useCallback((intermediateKey: string) => {
    setDraggedBatch({ intermediateCode: intermediateKey, count: 1 });
  }, []);

  const handleDragEnd = useCallback(() => {
    setDraggedBatch(null);
  }, []);

  const handleDrop = useCallback((date: Date, dehydrator?: DehydratorSlot) => {
    if (!draggedBatch) return;
    scheduleBatch(draggedBatch.intermediateCode, date, dehydrator);
    setDraggedBatch(null);
  }, [draggedBatch, scheduleBatch]);

  // Broadcast ALL scheduled batches (draft + unleashed) so other pages can
  // read them. Formerly a separate localStorage key; now the same PlanDraftStore
  // slice that holds draft items — consumers filter by `origin` if they care.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    replaceAllScheduledBatches(scheduledBatches);
  }, [scheduledBatches]);

  // Draft persistence — only save user-placed/rescheduled batches.
  // Unleashed-origin batches are recalculated from live data on next load.
  const saveDraft = useCallback(() => {
    const draftOnly = scheduledBatches.filter((b) => b.origin !== 'unleashed');
    saveDraftToStorage(draftOnly);
  }, [scheduledBatches]);

  const clearDraft = useCallback(() => {
    clearDraftFromStorage();
  }, []);

  // Reset everything
  const reset = useCallback(() => {
    setScheduledBatches([]);
    setDraggedBatch(null);
    setDismissedKeys(new Set());
    clearDraftFromStorage();
    clearDismissedKitchenKeys();
  }, []);

  return {
    // State
    scheduledBatches,
    unscheduledBatches,
    draggedBatch,
    feasibilityResults,
    calendar,
    riskEvents,

    // Actions
    saveDraft,
    clearDraft,
    scheduleBatch,
    rescheduleBatch,
    removeBatch,
    updateBatchQuantity,
    calculateBatchesNeeded,
    getBatchesForDate,
    getEquipmentOnDate,
    getFeasibilityColor,
    getBatchWarnings,
    hasEquipmentConflict,
    dismissRisk,
    handleDragStart,
    handleDragEnd,
    handleDrop,
    reset,
  };
}
