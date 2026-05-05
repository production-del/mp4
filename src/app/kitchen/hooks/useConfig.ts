'use client';

import { useState, useCallback, useEffect } from 'react';
import {
  INTERMEDIATE_REGISTRY,
  PACKAGING_DEADLINES,
  BLOCK_START,
  BLOCK_END,
  EQUIPMENT_COLORS,
  DEFAULT_KITCHEN_RESOURCES,
  type IntermediateConfig,
  type KitchenResource,
} from '../data/intermediate-registry';
import { toLocalISODate } from '@/lib/planning/working-day';
import { readPackagingDemand, type Demand } from '@/lib/planning/demand';

const STORAGE_KEY = 'byron-kitchen-config';
const DEMAND_STORE_KEY = 'byron-demand-v1';

/**
 * Read packaging demand and group it into the `PackagingDeadline` shape
 * that `useKitchenPlanner` consumes (one entry per date, aggregating kg by
 * family and composing a label).
 *
 * The underlying contract is `Demand[]`; this function is a UI-facing adapter
 * that survives the refactor without changing planner internals. It is a
 * candidate for removal once kitchen-planner is updated to consume Demand
 * directly.
 */
function readPackagingDeadlines(): PackagingDeadline[] {
  const demands: Demand[] = readPackagingDemand();
  if (demands.length === 0) return [];

  const byDate = new Map<string, {
    familyCodes: Set<string>;
    demandKg: Record<string, number>;
    labels: Set<string>;
  }>();

  for (const d of demands) {
    if (d.source.type !== 'packaging_run') continue;
    const entry = byDate.get(d.needByDate) ?? {
      familyCodes: new Set<string>(),
      demandKg: {},
      labels: new Set<string>(),
    };
    entry.familyCodes.add(d.productCode);
    entry.demandKg[d.productCode] = (entry.demandKg[d.productCode] ?? 0) + d.quantityNeeded;
    if (d.source.runName) entry.labels.add(d.source.runName);
    byDate.set(d.needByDate, entry);
  }

  return [...byDate.entries()].map(([date, e]) => ({
    date,
    label: [...e.labels].join(', '),
    familyCodes: [...e.familyCodes],
    demandKg: e.demandKg,
  }));
}

export interface PackagingDeadline {
  date: string; // YYYY-MM-DD
  label: string;
  familyCodes?: string[]; // intermediate codes (e.g., IAW) for deadline matching
  demandKg?: Record<string, number>; // familyCode → kg consumed from that intermediate
}

export interface KitchenConfig {
  blockStart: string; // YYYY-MM-DD
  blockEnd: string;
  intermediates: Record<string, IntermediateConfig>;
  packagingDeadlines: PackagingDeadline[];
  kitchenWarehouseId: string; // Unleashed warehouse GUID for LB
  kitchenWarehouseName: string;
  /**
   * Ordered list of physical kitchen resources (dehydrator units, ovens,
   * mixers, …). The Kitchen Calendar renders one lane per resource in each
   * day cell. Edited on `/kitchen/parameters`.
   */
  kitchenResources: KitchenResource[];
}

function getDefaults(): KitchenConfig {
  return {
    blockStart: toLocalISODate(BLOCK_START),
    blockEnd: toLocalISODate(BLOCK_END),
    intermediates: { ...INTERMEDIATE_REGISTRY },
    packagingDeadlines: [...PACKAGING_DEADLINES],
    kitchenWarehouseId: '',
    kitchenWarehouseName: '',
    kitchenResources: [...DEFAULT_KITCHEN_RESOURCES],
  };
}

function loadFromStorage(): KitchenConfig | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<KitchenConfig>;
    // One-shot migration: older persisted configs lacked kitchenResources.
    // Seed with defaults so the calendar renders correctly before the user
    // opens `/kitchen/parameters`.
    if (!parsed.kitchenResources || parsed.kitchenResources.length === 0) {
      parsed.kitchenResources = [...DEFAULT_KITCHEN_RESOURCES];
    }
    return parsed as KitchenConfig;
  } catch {
    return null;
  }
}

function saveToStorage(config: KitchenConfig): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

export const EQUIPMENT_OPTIONS = Object.keys(EQUIPMENT_COLORS) as Array<
  keyof typeof EQUIPMENT_COLORS
>;

/**
 * Hook that manages kitchen planner configuration.
 * Loads from localStorage on mount, falls back to defaults from intermediate-registry.ts.
 * Exposes the config as runtime values + setters.
 */
export function useConfig() {
  const [config, setConfig] = useState<KitchenConfig>(getDefaults);

  // Load from localStorage on mount (client-side only)
  useEffect(() => {
    const stored = loadFromStorage();
    if (stored) setConfig(stored);

    // Read packaging demand from the typed store. Packaging planner is the
    // source of truth once it has published anything.
    const packagingDeadlines = readPackagingDeadlines();
    if (packagingDeadlines.length > 0) {
      setConfig(prev => ({
        ...prev,
        packagingDeadlines,
      }));
    }
  }, []);

  // Listen for cross-tab storage events on the demand store
  useEffect(() => {
    const handleStorage = (e: StorageEvent) => {
      if (e.key === DEMAND_STORE_KEY) {
        const deadlines = readPackagingDeadlines();
        setConfig(prev => {
          const next = { ...prev, packagingDeadlines: deadlines };
          saveToStorage(next);
          return next;
        });
      }
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  const updateConfig = useCallback((updates: Partial<KitchenConfig>) => {
    setConfig((prev) => {
      const next = { ...prev, ...updates };
      saveToStorage(next);
      return next;
    });
  }, []);

  const resetToDefaults = useCallback(() => {
    const defaults = getDefaults();
    setConfig(defaults);
    saveToStorage(defaults);
  }, []);

  // Convenience setters
  const setBlockDates = useCallback(
    (start: string, end: string) => {
      updateConfig({ blockStart: start, blockEnd: end });
    },
    [updateConfig]
  );

  const updateIntermediate = useCallback(
    (code: string, data: IntermediateConfig) => {
      setConfig((prev) => {
        const next = {
          ...prev,
          intermediates: { ...prev.intermediates, [code]: data },
        };
        saveToStorage(next);
        return next;
      });
    },
    []
  );

  const removeIntermediate = useCallback((code: string) => {
    setConfig((prev) => {
      const intermediates = { ...prev.intermediates };
      delete intermediates[code];
      const next = { ...prev, intermediates };
      saveToStorage(next);
      return next;
    });
  }, []);

  const setPackagingDeadlines = useCallback(
    (deadlines: PackagingDeadline[]) => {
      updateConfig({ packagingDeadlines: deadlines });
    },
    [updateConfig]
  );

  const shiftBlock = useCallback(
    (direction: 'prev' | 'next') => {
      const days = direction === 'next' ? 28 : -28;
      const newStart = new Date(config.blockStart);
      const newEnd = new Date(config.blockEnd);
      newStart.setDate(newStart.getDate() + days);
      newEnd.setDate(newEnd.getDate() + days);
      setBlockDates(
        toLocalISODate(newStart),
        toLocalISODate(newEnd)
      );
    },
    [config.blockStart, config.blockEnd, setBlockDates]
  );

  const setKitchenWarehouse = useCallback(
    (warehouseId: string, warehouseName: string) => {
      updateConfig({ kitchenWarehouseId: warehouseId, kitchenWarehouseName: warehouseName });
    },
    [updateConfig]
  );

  const setKitchenResources = useCallback(
    (resources: KitchenResource[]) => {
      updateConfig({ kitchenResources: resources });
    },
    [updateConfig]
  );

  /**
   * Patch any subset of a blend's config fields (equipment, durationDays,
   * prepDays, prepNotes, ...). Works for blends that don't yet have a
   * config entry — seeds a minimal one from the supplied fallback values
   * (typically `name` + `batchSize` pulled from the live intermediates list).
   */
  const updateIntermediateFields = useCallback(
    (
      code: string,
      patch: Partial<IntermediateConfig>,
      fallback?: {
        name?: string;
        batchSize?: number;
        level?: IntermediateConfig['level'];
        equipment?: IntermediateConfig['equipment'];
      },
    ) => {
      setConfig((prev) => {
        const existing = prev.intermediates[code];
        const base: IntermediateConfig =
          existing ?? {
            code,
            name: fallback?.name || code,
            level: fallback?.level || 'top',
            batchSize: fallback?.batchSize || 0,
            equipment: fallback?.equipment || 'mixer',
            requires: [],
          };
        const next = {
          ...prev,
          intermediates: {
            ...prev.intermediates,
            [code]: { ...base, ...patch },
          },
        };
        saveToStorage(next);
        return next;
      });
    },
    [],
  );

  // Thin wrapper for the common "just change equipment" case.
  const setIntermediateEquipment = useCallback(
    (
      code: string,
      equipment: IntermediateConfig['equipment'],
      fallback?: { name?: string; batchSize?: number; level?: IntermediateConfig['level'] },
    ) => updateIntermediateFields(code, { equipment }, fallback),
    [updateIntermediateFields],
  );

  return {
    config,
    updateConfig,
    resetToDefaults,
    setBlockDates,
    updateIntermediate,
    removeIntermediate,
    setPackagingDeadlines,
    setKitchenWarehouse,
    setKitchenResources,
    setIntermediateEquipment,
    updateIntermediateFields,
    shiftBlock,
    // Derived values for easy consumption
    blockStart: new Date(config.blockStart),
    blockEnd: new Date(config.blockEnd),
    intermediateRegistry: config.intermediates,
    packagingDeadlines: config.packagingDeadlines,
    kitchenWarehouseId: config.kitchenWarehouseId,
    kitchenWarehouseName: config.kitchenWarehouseName,
    kitchenResources: config.kitchenResources,
  };
}
