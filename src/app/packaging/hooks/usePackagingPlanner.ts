'use client';

import { useState, useCallback, useEffect, useMemo } from 'react';
import type { PackagingSKU, ProductFamily } from './usePackagingData';
import { dayIntToISO, dateToDayInt, toLocalISODate } from '@/lib/planning/working-day';
import {
  publishPackagingDemand,
  migrateLegacyPackagingDeadlines,
  type Demand,
} from '@/lib/planning/demand';
import { WAREHOUSES } from '@/lib/planning/warehouse-assignments';
import type { PackagingRunItem } from '@/lib/planning/plan-item';
import { listByKind, replaceByKind } from '@/lib/planning/plan-draft-store';

// ─── Types ──────────────────────────────────────────────────

export const PACKING_TEAMS = ['elephant', 'dust', 'hand', 'bottling', 'bulk'] as const;
export type PackingTeam = (typeof PACKING_TEAMS)[number];

export const TEAM_LABELS: Record<PackingTeam, string> = {
  elephant: 'Elephant',
  dust: 'Dust',
  hand: 'Hand',
  bottling: 'Bottling',
  bulk: 'Bulk',
};

export const TEAM_COLORS: Record<PackingTeam, string> = {
  elephant: 'var(--success)',
  dust: 'var(--warning)',
  hand: 'var(--accent)',
  bottling: '#a78bfa',
  bulk: '#0ea5e9',
};

export interface PlannedAssembly {
  productCode: string;
  quantity: number;
  dayInt: number;
  resolvedDate: string; // YYYY-MM-DD
  team?: PackingTeam;
  action: 'CREATE' | 'UPDATE';
  existingAssemblyId?: string;
}

interface PlannedEntry {
  quantity: number;
  dayInt: number;
  team?: PackingTeam;
  /**
   * `true` when this CREATE originated from the Priority workflow. Carried
   * through the draft so `saveDraft` doesn't silently drop the attribution
   * on the next state change, and so the push adapter emits the
   * `[SOURCE:priority]` tag.
   */
  prioritySource?: boolean;
  /**
   * Sales-order numbers the Priority proposal attributed this run to. Same
   * round-trip concern as `prioritySource`.
   */
  salesOrders?: string[];
}

interface DraftState {
  /** productCode → { quantity, dayInt, team?, prioritySource?, salesOrders? } — NEW assemblies (CREATE) */
  planned: Record<string, PlannedEntry>;
  /** productCode → { qty, dayInt, team? } — edits to EXISTING assemblies (UPDATE) */
  existingEdits?: Record<string, { qty: number; dayInt: number; team?: PackingTeam }>;
}

// ─── Storage (facade over PlanDraftStore) ──────────────────

const BLOCKERS_KEY = 'byron-review-blockers';

/**
 * Load the packaging draft from the unified PlanItem store. The historical
 * shape (`{ planned, existingEdits }` keyed by productCode) is reconstructed
 * here so the hook body stays unchanged.
 */
function loadDraft(): DraftState {
  const items = listByKind('packaging_run');
  const state: DraftState = { planned: {}, existingEdits: {} };
  for (const item of items) {
    if (item.action === 'CREATE') {
      state.planned[item.productCode] = {
        quantity: item.quantity,
        dayInt: item.dayInt,
        team: item.team,
        prioritySource: item.prioritySource,
        salesOrders: item.salesOrders,
      };
    } else {
      state.existingEdits![item.productCode] = {
        qty: item.quantity,
        dayInt: item.dayInt,
        team: item.team,
      };
    }
  }
  return state;
}

/** Persist the packaging draft by writing the full variant's slice. */
function saveDraft(state: DraftState, skuMap: Map<string, PackagingSKU>) {
  const items: PackagingRunItem[] = [];

  for (const [code, plan] of Object.entries(state.planned)) {
    if (!plan || plan.quantity <= 0) continue;
    const sku = skuMap.get(code);
    items.push({
      kind: 'packaging_run',
      id: `pkg:create:${code}`,
      productCode: code,
      productName: sku?.productName ?? code,
      quantity: plan.quantity,
      lifecycle: 'draft',
      dayInt: plan.dayInt,
      scheduledDate: plan.dayInt > 0 ? dayIntToISO(plan.dayInt) : '',
      team: plan.team,
      action: 'CREATE',
      prioritySource: plan.prioritySource,
      salesOrders: plan.salesOrders,
    });
  }

  for (const [code, edit] of Object.entries(state.existingEdits ?? {})) {
    if (!edit || edit.qty <= 0) continue;
    const sku = skuMap.get(code);
    items.push({
      kind: 'packaging_run',
      id: `pkg:update:${code}`,
      productCode: code,
      productName: sku?.productName ?? code,
      quantity: edit.qty,
      lifecycle: 'draft',
      dayInt: edit.dayInt,
      scheduledDate: edit.dayInt > 0 ? dayIntToISO(edit.dayInt) : '',
      team: edit.team,
      action: 'UPDATE',
    });
  }

  replaceByKind('packaging_run', items);
}

/**
 * Publish packaging demand — one `Demand` per (date, intermediate family).
 *
 * Replaces the old `broadcastDeadlines` which wrote a bespoke JSON blob to
 * `byron-packaging-planned-dates`. Now we emit typed demand via the shared
 * store, which the kitchen calendar and logistics gap detector subscribe to.
 */
function publishDemandFromDraft(
  planned: Record<string, { quantity: number; dayInt: number }>,
  skuMap: Map<string, PackagingSKU>,
) {
  // Aggregate by (dayInt, familyCode) so each intermediate × date
  // yields one Demand — matches the old demandKg shape but typed.
  type Key = string; // `${dayInt}::${familyCode}`
  const agg = new Map<Key, {
    dayInt: number;
    familyCode: string;
    kg: number;
    familyName: string;
    sizeNames: Set<string>;
  }>();

  for (const [code, plan] of Object.entries(planned)) {
    if (plan.quantity <= 0 || plan.dayInt <= 0) continue;
    const sku = skuMap.get(code);
    if (!sku) continue;

    const key: Key = `${plan.dayInt}::${sku.familyCode}`;
    const entry = agg.get(key) ?? {
      dayInt: plan.dayInt,
      familyCode: sku.familyCode,
      kg: 0,
      familyName: sku.familyName,
      sizeNames: new Set<string>(),
    };
    entry.kg += plan.quantity * sku.kgPerUnit;
    if (sku.sizeVariant) entry.sizeNames.add(sku.sizeVariant);
    agg.set(key, entry);
  }

  const demands: Demand[] = [];
  for (const entry of agg.values()) {
    const shortName = entry.familyName.replace(/\s*(Activated|Granola)\s*/gi, '').trim();
    const sizes = [...entry.sizeNames];
    const runName = sizes.length > 0 ? `${shortName} ${sizes.join('+')}` : shortName;
    const needByDate = dayIntToISO(entry.dayInt);
    demands.push({
      productCode: entry.familyCode,
      productName: entry.familyName,
      quantityNeeded: entry.kg,
      needByDate,
      destinationWarehouse: WAREHOUSES.MF_PACKAGING,
      source: {
        type: 'packaging_run',
        runId: `${needByDate}::${entry.familyCode}`,
        runName,
      },
    });
  }

  publishPackagingDemand(demands);
}

/** Write blocker snapshot to shared key for Review Drafts page */
function broadcastBlockers(
  families: ProductFamily[],
  skus: PackagingSKU[],
  draft: DraftState
) {
  try {
    const blockers: {
      type: 'component' | 'labels';
      familyCode: string;
      familyName: string;
      productCode?: string;
      required: number;
      available: number;
      shortfall: number;
      unit: string;
      affectedSKUs: { code: string; qty: number; dayInt: number; source: string }[];
    }[] = [];

    // Component shortfalls — planned packaging kg exceeds intermediate SOH
    for (const family of families) {
      let totalKg = 0;
      const affected: { code: string; qty: number; dayInt: number; source: string }[] = [];

      for (const sku of skus) {
        if (sku.familyCode !== family.familyCode) continue;
        if (sku.kgPerUnit <= 0) continue;

        // New assemblies (Qty column)
        const plan = draft.planned[sku.productCode];
        if (plan?.quantity > 0) {
          totalKg += plan.quantity * sku.kgPerUnit;
          affected.push({ code: sku.productCode, qty: plan.quantity, dayInt: plan.dayInt, source: 'new' });
        }

        // Existing assemblies (Existing column)
        const existingEdit = draft.existingEdits?.[sku.productCode];
        const existingQty = existingEdit !== undefined ? existingEdit.qty : (sku.existingAssemblyQty ?? 0);
        if (existingQty > 0) {
          totalKg += existingQty * sku.kgPerUnit;
          affected.push({ code: sku.productCode, qty: existingQty, dayInt: existingEdit?.dayInt ?? 0, source: 'existing' });
        }
      }

      if (totalKg > family.componentSOH) {
        blockers.push({
          type: 'component',
          familyCode: family.familyCode,
          familyName: family.familyName,
          required: Math.round(totalKg * 10) / 10,
          available: Math.round(family.componentSOH * 10) / 10,
          shortfall: Math.round((totalKg - family.componentSOH) * 10) / 10,
          unit: 'kg',
          affectedSKUs: affected,
        });
      }
    }

    // Label shortfalls — planned qty exceeds labels on hand
    for (const sku of skus) {
      const plan = draft.planned[sku.productCode];
      const existingEdit = draft.existingEdits?.[sku.productCode];
      const newQty = plan?.quantity ?? 0;
      const existingQty = existingEdit !== undefined ? existingEdit.qty : (sku.existingAssemblyQty ?? 0);
      const totalQty = newQty + existingQty;

      if (totalQty > 0 && totalQty > sku.labelsOnHand) {
        const affected: { code: string; qty: number; dayInt: number; source: string }[] = [];
        if (newQty > 0) affected.push({ code: sku.productCode, qty: newQty, dayInt: plan?.dayInt ?? 0, source: 'new' });
        if (existingQty > 0) affected.push({ code: sku.productCode, qty: existingQty, dayInt: existingEdit?.dayInt ?? 0, source: 'existing' });

        blockers.push({
          type: 'labels',
          familyCode: sku.familyCode,
          familyName: sku.familyName,
          productCode: sku.productCode,
          required: totalQty,
          available: sku.labelsOnHand,
          shortfall: totalQty - sku.labelsOnHand,
          unit: 'labels',
          affectedSKUs: affected,
        });
      }
    }

    localStorage.setItem(BLOCKERS_KEY, JSON.stringify({ updatedAt: new Date().toISOString(), blockers }));
  } catch {
    // ignore
  }
}

// ─── Hook ───────────────────────────────────────────────────

export function usePackagingPlanner(
  families: ProductFamily[],
  skus: PackagingSKU[]
) {
  const [draft, setDraft] = useState<DraftState>(loadDraft);

  // Build SKU lookup map
  const skuMap = useMemo(() => {
    const map = new Map<string, PackagingSKU>();
    for (const sku of skus) map.set(sku.productCode, sku);
    return map;
  }, [skus]);

  // One-shot migration of legacy packaging-deadlines blob into the typed
  // demand store. Runs once at mount; subsequent writes go through the store.
  useEffect(() => {
    migrateLegacyPackagingDeadlines();
  }, []);

  // Persist draft and publish demand + blockers on change
  useEffect(() => {
    saveDraft(draft, skuMap);
    publishDemandFromDraft(draft.planned, skuMap);
    broadcastBlockers(families, skus, draft);
  }, [draft, skuMap, families, skus]);

  // Get planned values for a SKU (CREATE)
  const getPlanned = useCallback(
    (productCode: string) => draft.planned[productCode] || null,
    [draft.planned]
  );

  // Get edited existing assembly qty (UPDATE). Returns null if unedited.
  const getExistingQty = useCallback(
    (productCode: string): number | null => {
      const edited = draft.existingEdits?.[productCode];
      return edited !== undefined ? edited.qty : null;
    },
    [draft.existingEdits]
  );

  // Get edited existing assembly day (UPDATE). Returns null if unedited.
  const getExistingDay = useCallback(
    (productCode: string): number | null => {
      const edited = draft.existingEdits?.[productCode];
      return edited !== undefined ? edited.dayInt : null;
    },
    [draft.existingEdits]
  );

  // Set edited existing assembly qty
  const setExistingQty = useCallback((productCode: string, quantity: number) => {
    setDraft(prev => {
      const existing = prev.existingEdits?.[productCode];
      const sku = skuMap.get(productCode);
      const defaultDay = sku?.existingAssemblyDate
        ? dateToDayInt(new Date(sku.existingAssemblyDate), undefined, { weekend: 'up' })
        : 0;
      return {
        ...prev,
        existingEdits: {
          ...(prev.existingEdits || {}),
          [productCode]: {
            qty: quantity,
            dayInt: existing?.dayInt ?? defaultDay,
            team: existing?.team,
          },
        },
      };
    });
  }, [skuMap]);

  // Set edited existing assembly day
  const setExistingDay = useCallback((productCode: string, dayInt: number) => {
    setDraft(prev => {
      const existing = prev.existingEdits?.[productCode];
      const sku = skuMap.get(productCode);
      const defaultQty = sku?.existingAssemblyQty ?? 0;
      return {
        ...prev,
        existingEdits: {
          ...(prev.existingEdits || {}),
          [productCode]: {
            qty: existing?.qty ?? defaultQty,
            dayInt,
            team: existing?.team,
          },
        },
      };
    });
  }, [skuMap]);

  /**
   * Set edited team on an existing assembly. Used by the calendar when the
   * user drags a live assembly to a new team lane.
   */
  const setExistingTeam = useCallback(
    (productCode: string, team: PackingTeam | undefined) => {
      setDraft(prev => {
        const existing = prev.existingEdits?.[productCode];
        const sku = skuMap.get(productCode);
        const defaultDay = sku?.existingAssemblyDate
          ? dateToDayInt(new Date(sku.existingAssemblyDate), undefined, { weekend: 'up' })
          : 0;
        const defaultQty = sku?.existingAssemblyQty ?? 0;
        return {
          ...prev,
          existingEdits: {
            ...(prev.existingEdits || {}),
            [productCode]: {
              qty: existing?.qty ?? defaultQty,
              dayInt: existing?.dayInt ?? defaultDay,
              team,
            },
          },
        };
      });
    },
    [skuMap],
  );

  /**
   * Convenience: move an existing assembly to a specific (day, team) slot
   * in one state update — used by the calendar's drop handler.
   */
  const moveExisting = useCallback(
    (productCode: string, dayInt: number, team: PackingTeam | undefined) => {
      setDraft(prev => {
        const existing = prev.existingEdits?.[productCode];
        const sku = skuMap.get(productCode);
        const defaultQty = sku?.existingAssemblyQty ?? 0;
        return {
          ...prev,
          existingEdits: {
            ...(prev.existingEdits || {}),
            [productCode]: {
              qty: existing?.qty ?? defaultQty,
              dayInt,
              team,
            },
          },
        };
      });
    },
    [skuMap],
  );

  /** Read the current team edit for an existing assembly. */
  const getExistingTeam = useCallback(
    (productCode: string): PackingTeam | undefined => {
      return draft.existingEdits?.[productCode]?.team;
    },
    [draft.existingEdits],
  );

  // Set planned quantity for a SKU (CREATE)
  const setPlanQty = useCallback((productCode: string, quantity: number) => {
    setDraft(prev => ({
      ...prev,
      planned: {
        ...prev.planned,
        [productCode]: {
          ...prev.planned[productCode],
          quantity,
          dayInt: prev.planned[productCode]?.dayInt || 0,
        },
      },
    }));
  }, []);

  // Set planned day for a SKU
  const setPlanDay = useCallback((productCode: string, dayInt: number) => {
    setDraft(prev => ({
      ...prev,
      planned: {
        ...prev.planned,
        [productCode]: {
          ...prev.planned[productCode],
          dayInt,
          quantity: prev.planned[productCode]?.quantity || 0,
        },
      },
    }));
  }, []);

  // Set planned team for a SKU
  const setPlanTeam = useCallback((productCode: string, team: PackingTeam | undefined) => {
    setDraft(prev => ({
      ...prev,
      planned: {
        ...prev.planned,
        [productCode]: {
          ...prev.planned[productCode],
          team,
          quantity: prev.planned[productCode]?.quantity || 0,
          dayInt: prev.planned[productCode]?.dayInt || 0,
        },
      },
    }));
  }, []);

  // Assign team + day for a SKU in one call (used by calendar drag-drop)
  const assignToCalendar = useCallback((productCode: string, dayInt: number, team: PackingTeam) => {
    setDraft(prev => {
      const existing = prev.planned[productCode];
      const sku = skuMap.get(productCode);
      const qty = existing?.quantity || sku?.suggestedQty || 0;
      return {
        ...prev,
        planned: {
          ...prev.planned,
          [productCode]: { quantity: qty, dayInt, team },
        },
      };
    });
  }, [skuMap]);

  // Set planned day for all SKUs in a family at once
  const setFamilyDay = useCallback(
    (familyCode: string, dayInt: number) => {
      setDraft(prev => {
        const updated = { ...prev.planned };
        for (const sku of skus) {
          if (sku.familyCode === familyCode) {
            updated[sku.productCode] = {
              ...updated[sku.productCode],
              dayInt,
              quantity: updated[sku.productCode]?.quantity || 0,
            };
          }
        }
        return { ...prev, planned: updated };
      });
    },
    [skus]
  );

  // Fill all suggested quantities for a family
  const fillFamilySuggestions = useCallback(
    (familyCode: string, dayInt?: number) => {
      setDraft(prev => {
        const updated = { ...prev.planned };
        for (const sku of skus) {
          if (sku.familyCode === familyCode && sku.suggestedQty > 0) {
            updated[sku.productCode] = {
              quantity: sku.suggestedQty,
              dayInt: dayInt ?? updated[sku.productCode]?.dayInt ?? 0,
            };
          }
        }
        return { ...prev, planned: updated };
      });
    },
    [skus]
  );

  // Clear all planned for a family
  const clearFamily = useCallback(
    (familyCode: string) => {
      setDraft(prev => {
        const updated = { ...prev.planned };
        for (const sku of skus) {
          if (sku.familyCode === familyCode) {
            delete updated[sku.productCode];
          }
        }
        return { ...prev, planned: updated };
      });
    },
    [skus]
  );

  // Clear all drafts
  const clearAll = useCallback(() => {
    setDraft({ planned: {} });
  }, []);

  // Build planned assemblies for push (CREATE from planned, UPDATE from existingEdits)
  const plannedAssemblies = useMemo((): PlannedAssembly[] => {
    const result: PlannedAssembly[] = [];

    // CREATE entries — new assemblies from Qty column
    for (const [productCode, plan] of Object.entries(draft.planned)) {
      if (plan.quantity <= 0 || plan.dayInt <= 0) continue;
      result.push({
        productCode,
        quantity: plan.quantity,
        dayInt: plan.dayInt,
        resolvedDate: dayIntToISO(plan.dayInt),
        team: plan.team,
        action: 'CREATE',
      });
    }

    // UPDATE entries — edits to existing assemblies from Existing columns
    for (const [productCode, edit] of Object.entries(draft.existingEdits || {})) {
      if (edit.qty <= 0) continue;
      const sku = skuMap.get(productCode);
      if (!sku?.existingAssemblyId) continue;
      // Only include if qty, date, or team actually changed from the original.
      const origDayInt = sku.existingAssemblyDate
        ? dateToDayInt(new Date(sku.existingAssemblyDate), undefined, { weekend: 'up' })
        : 0;
      const origTeam = sku.existingAssemblyTeam;
      const qtyChanged = edit.qty !== sku.existingAssemblyQty;
      const dayChanged = edit.dayInt > 0 && edit.dayInt !== origDayInt;
      const teamChanged = edit.team !== origTeam;
      if (!qtyChanged && !dayChanged && !teamChanged) continue;
      const useDayInt = edit.dayInt > 0 ? edit.dayInt : origDayInt || 1;
      result.push({
        productCode,
        quantity: edit.qty,
        dayInt: useDayInt,
        resolvedDate: dayIntToISO(useDayInt),
        team: edit.team,
        action: 'UPDATE',
        existingAssemblyId: sku.existingAssemblyId,
      });
    }

    return result;
  }, [draft.planned, draft.existingEdits, skuMap]);

  // Stats
  const stats = useMemo(() => {
    let totalFamilies = families.length;
    let urgent = 0;
    let planned = 0;

    for (const family of families) {
      if (family.urgency < 7) urgent++;
    }

    for (const [, plan] of Object.entries(draft.planned)) {
      if (plan.quantity > 0 && plan.dayInt > 0) planned++;
    }

    return { totalFamilies, urgent, planned, totalSKUs: skus.length };
  }, [families, draft.planned, skus.length]);

  // Compute total planned kg per family for feasibility footer.
  // Includes BOTH new assemblies (Qty column) AND existing assemblies
  // (Existing column) — both consume food ingredient when completed.
  const getFamilyPlannedKg = useCallback(
    (familyCode: string) => {
      let total = 0;
      for (const sku of skus) {
        if (sku.familyCode !== familyCode) continue;
        if (sku.kgPerUnit <= 0) continue;

        // New assemblies (CREATE — Qty column)
        const plan = draft.planned[sku.productCode];
        if (plan?.quantity > 0) {
          total += plan.quantity * sku.kgPerUnit;
        }

        // Existing assemblies (UPDATE — Existing column)
        // Use edited qty if available, otherwise original from Unleashed
        const existingEdit = draft.existingEdits?.[sku.productCode];
        const existingQty = existingEdit !== undefined
          ? existingEdit.qty
          : (sku.existingAssemblyQty ?? 0);
        if (existingQty > 0) {
          total += existingQty * sku.kgPerUnit;
        }
      }
      return total;
    },
    [skus, draft.planned, draft.existingEdits]
  );

  return {
    getPlanned,
    getExistingQty,
    getExistingDay,
    getExistingTeam,
    setExistingQty,
    setExistingDay,
    setExistingTeam,
    moveExisting,
    setPlanQty,
    setPlanDay,
    setPlanTeam,
    assignToCalendar,
    setFamilyDay,
    fillFamilySuggestions,
    clearFamily,
    clearAll,
    plannedAssemblies,
    stats,
    getFamilyPlannedKg,
  };
}
