'use client';

import { useState, useCallback, useMemo, useEffect } from 'react';
import { BusinessCalendar } from '@/lib/engine/business-calendar';
import {
  projectComponentSOH,
  projectMultipleComponents,
} from '@/lib/engine/purchasing-projection';
import type {
  PurchasingProjectionResult,
  PurchaseOrderSchedule,
  KitchenBatch,
} from '@/lib/planning/engine-io';
import type { PurchaseOrder } from '@/lib/unleashed/types';
import type { PurchaseOrderItem } from '@/lib/planning/plan-item';
import { listByKind, replaceByKind } from '@/lib/planning/plan-draft-store';
import { fromLocalISODate, toLocalISODate } from '@/lib/planning/working-day';

// --- Draft PO types ---

export interface DraftPO {
  id: string;
  componentCode: string;
  componentName: string;
  supplierId: string;
  supplierName: string;
  deliveryDate: Date;
  quantity: number;
}

export type ComponentStatus = 'ok' | 'low' | 'stockout';

// --- Storage facade over PlanDraftStore ---

function toDraftPO(item: PurchaseOrderItem): DraftPO {
  return {
    id: item.id,
    componentCode: item.productCode,
    componentName: item.productName,
    supplierId: item.supplierId,
    supplierName: item.supplierName,
    deliveryDate: fromLocalISODate(item.deliveryDate),
    quantity: item.quantity,
  };
}

function toPurchaseOrderItem(d: DraftPO): PurchaseOrderItem {
  return {
    kind: 'purchase_order',
    id: d.id,
    productCode: d.componentCode,
    productName: d.componentName,
    quantity: d.quantity,
    lifecycle: 'draft',
    deliveryDate: toLocalISODate(d.deliveryDate),
    supplierId: d.supplierId,
    supplierName: d.supplierName,
  };
}

function loadDrafts(): DraftPO[] {
  return listByKind('purchase_order').map(toDraftPO);
}

function saveDrafts(drafts: DraftPO[]): void {
  replaceByKind('purchase_order', drafts.map(toPurchaseOrderItem));
}

function clearDrafts(): void {
  replaceByKind('purchase_order', []);
}

// --- Hook ---

interface UsePurchasingPlannerParams {
  componentSOH: Record<string, number>;
  /** Per-component warehouse-scoped SOH — used for projections when available */
  warehouseComponentSOH?: Record<string, number>;
  consumptionSchedule: Record<string, KitchenBatch[]>;
  /** Monthly demand rates from CSV — canonical consumption source */
  demandRates: Record<string, number>;
  existingPOs: PurchaseOrder[];
  blockStart: Date;
  blockEnd: Date;
}

export function usePurchasingPlanner({
  componentSOH,
  warehouseComponentSOH,
  consumptionSchedule,
  demandRates,
  existingPOs,
  blockStart,
  blockEnd,
}: UsePurchasingPlannerParams) {
  // Use warehouse-scoped SOH for projections when available, fall back to global
  const projectionSOH = warehouseComponentSOH && Object.keys(warehouseComponentSOH).length > 0
    ? warehouseComponentSOH
    : componentSOH;
  const [selectedComponent, setSelectedComponent] = useState<string | null>(null);
  const [draftPOs, setDraftPOs] = useState<DraftPO[]>([]);

  const calendar = useMemo(() => new BusinessCalendar(), []);

  // Restore drafts on mount, and rehydrate whenever the backing store
  // changes (cross-tab edits fire a `storage` event) or the operator focuses
  // the tab (in-same-tab edits don't fire `storage`, but switching back from
  // another tab or a different page is the natural re-check moment). Without
  // this, drafts created on the packaging or kitchen pages — which write to
  // the same PlanDraftStore — wouldn't appear here until a full reload.
  useEffect(() => {
    const rehydrate = () => setDraftPOs(loadDrafts());
    rehydrate();
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'byron-plan-drafts-v1' || e.key === null) rehydrate();
    };
    const onFocus = () => rehydrate();
    window.addEventListener('storage', onStorage);
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  // Convert existing Unleashed POs into PurchaseOrderSchedule per component
  const existingPOSchedules = useMemo(() => {
    const map: Record<string, PurchaseOrderSchedule[]> = {};
    for (const po of existingPOs) {
      for (const line of po.purchaseOrderLines) {
        if (!map[line.productCode]) map[line.productCode] = [];
        map[line.productCode].push({
          poId: po.purchaseOrderId,
          deliveryDate: new Date(line.expectedDeliveryDate || po.expectedDeliveryDate || po.requiredDate || po.orderedDate),
          quantity: line.quantityOrdered - line.quantityReceived,
          received: false,
        });
      }
    }
    return map;
  }, [existingPOs]);

  // Convert draft POs to PurchaseOrderSchedule per component
  const draftPOSchedules = useMemo(() => {
    const map: Record<string, PurchaseOrderSchedule[]> = {};
    for (const draft of draftPOs) {
      if (!map[draft.componentCode]) map[draft.componentCode] = [];
      map[draft.componentCode].push({
        poId: draft.id,
        deliveryDate: draft.deliveryDate,
        quantity: draft.quantity,
        received: false,
      });
    }
    return map;
  }, [draftPOs]);

  // Merge existing + draft PO schedules
  const mergedPOSchedules = useMemo(() => {
    const merged: Record<string, PurchaseOrderSchedule[]> = {};
    const allCodes = new Set([
      ...Object.keys(existingPOSchedules),
      ...Object.keys(draftPOSchedules),
    ]);
    for (const code of allCodes) {
      merged[code] = [
        ...(existingPOSchedules[code] || []),
        ...(draftPOSchedules[code] || []),
      ];
    }
    return merged;
  }, [existingPOSchedules, draftPOSchedules]);

  // Component status map (run projections for all components)
  const componentStatusMap = useMemo(() => {
    const codes = Object.keys(componentSOH);
    if (codes.length === 0) return new Map<string, ComponentStatus>();

    const components = codes.map((code) => ({
      code,
      soh: projectionSOH[code] || 0,
    }));

    const poMap = new Map<string, PurchaseOrderSchedule[]>();
    for (const code of codes) {
      poMap.set(code, mergedPOSchedules[code] || []);
    }

    // Build flat batch list for the engine
    const allBatches: KitchenBatch[] = [];
    for (const batches of Object.values(consumptionSchedule)) {
      allBatches.push(...batches);
    }

    const results = projectMultipleComponents(
      components,
      blockStart,
      blockEnd,
      allBatches,
      poMap,
      calendar,
      demandRates
    );

    const statusMap = new Map<string, ComponentStatus>();
    for (const [code, result] of results) {
      if (result.risks.some((r) => r.riskType === 'stockout')) {
        statusMap.set(code, 'stockout');
      } else if (result.risks.some((r) => r.riskType === 'low_stock')) {
        statusMap.set(code, 'low');
      } else {
        statusMap.set(code, 'ok');
      }
    }
    return statusMap;
  }, [componentSOH, projectionSOH, consumptionSchedule, demandRates, mergedPOSchedules, blockStart, blockEnd, calendar]);

  // Projection for selected component
  const selectedProjection = useMemo((): PurchasingProjectionResult | null => {
    if (!selectedComponent) return null;
    const soh = projectionSOH[selectedComponent] ?? 0;
    const rate = demandRates[selectedComponent];
    const batches = rate ? [] : (consumptionSchedule[selectedComponent] || []);
    const pos = mergedPOSchedules[selectedComponent] || [];

    return projectComponentSOH(
      selectedComponent,
      soh,
      blockStart,
      blockEnd,
      batches,
      pos,
      [],
      calendar,
      undefined,
      rate
    );
  }, [selectedComponent, projectionSOH, consumptionSchedule, demandRates, mergedPOSchedules, blockStart, blockEnd, calendar]);

  // Draft PO actions
  const addDraftPO = useCallback((draft: Omit<DraftPO, 'id'>) => {
    const newDraft: DraftPO = {
      ...draft,
      id: `draft-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    };
    setDraftPOs((prev) => {
      const next = [...prev, newDraft];
      saveDrafts(next);
      return next;
    });
  }, []);

  const removeDraftPO = useCallback((id: string) => {
    setDraftPOs((prev) => {
      const next = prev.filter((d) => d.id !== id);
      saveDrafts(next);
      return next;
    });
  }, []);

  const saveDraft = useCallback(() => {
    saveDrafts(draftPOs);
  }, [draftPOs]);

  const clearAllDrafts = useCallback(() => {
    setDraftPOs([]);
    clearDrafts();
  }, []);

  // Drafts for currently selected component
  const selectedDrafts = useMemo(() => {
    if (!selectedComponent) return [];
    return draftPOs.filter((d) => d.componentCode === selectedComponent);
  }, [draftPOs, selectedComponent]);

  // Stats
  const stats = useMemo(() => {
    let ok = 0;
    let low = 0;
    let stockout = 0;
    for (const status of componentStatusMap.values()) {
      if (status === 'ok') ok++;
      else if (status === 'low') low++;
      else stockout++;
    }
    return {
      total: componentStatusMap.size,
      ok,
      low,
      stockout,
      draftCount: draftPOs.length,
    };
  }, [componentStatusMap, draftPOs]);

  return {
    selectedComponent,
    setSelectedComponent,
    selectedProjection,
    selectedDrafts,
    draftPOs,
    componentStatusMap,
    stats,
    calendar,
    addDraftPO,
    removeDraftPO,
    saveDraft,
    clearAllDrafts,
  };
}
