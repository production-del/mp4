'use client';

import { useState, useEffect, useCallback } from 'react';
import type { IntermediateData, ComponentData } from '../data/mock-data';
import {
  INTERMEDIATE_REGISTRY as DEFAULT_REGISTRY,
  type IntermediateConfig,
} from '../data/intermediate-registry';
import type { StockOnHandItem, Assembly, Warehouse } from '@/lib/unleashed/types';
import type { OpenPOLine } from '@/app/api/kitchen-data/route';
export type { OpenPOLine };
import { WarehouseSOH } from '@/lib/planning/warehouse-soh';
import { WAREHOUSES } from '@/lib/planning/warehouse-assignments';

// Re-export mock data for fallback
import {
  MOCK_INTERMEDIATES,
  MOCK_COMPONENT_SOH,
  MOCK_COMPONENTS,
} from '../data/mock-data';

export interface KitchenDataResult {
  intermediates: Record<string, IntermediateData>;
  componentSOH: Record<string, number>;        // Lundberg Storeroom SOH (production warehouse)
  globalComponentSOH: Record<string, number>;   // All warehouses summed (for amber detection)
  perProductSOH: Record<string, Record<string, number>>; // productCode → warehouseName → qty
  components: Record<string, ComponentData>;
  /** Live Open + PartiallyReceived PO lines from Unleashed (outstanding qty only) */
  openPOLines: OpenPOLine[];
  loading: boolean;
  error: string | null;
  refetch: () => void;
  updateIntermediateBatchSize: (key: string, size: number) => void;
}

const USE_MOCK = process.env.NEXT_PUBLIC_USE_MOCK_DATA === 'true';

/**
 * Hook that fetches live data from Unleashed via a single server-side
 * API route (with caching) and merges it with the local intermediate
 * registry to produce the same shape as mock data.
 */
export function useKitchenData(
  registry: Record<string, IntermediateConfig> = DEFAULT_REGISTRY,
  options?: {
    kitchenWarehouseId?: string;
    onWarehouseResolved?: (id: string, name: string) => void;
  }
): KitchenDataResult {
  const [intermediates, setIntermediates] = useState<Record<string, IntermediateData>>({});
  const [componentSOH, setComponentSOH] = useState<Record<string, number>>({});
  const [globalComponentSOH, setGlobalComponentSOH] = useState<Record<string, number>>({});
  const [perProductSOH, setPerProductSOH] = useState<Record<string, Record<string, number>>>({});
  const [components, setComponents] = useState<Record<string, ComponentData>>({});
  const [openPOLines, setOpenPOLines] = useState<OpenPOLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async (refresh = false) => {
    // Mock fallback — no API calls
    if (USE_MOCK) {
      setIntermediates(MOCK_INTERMEDIATES);
      setComponentSOH(MOCK_COMPONENT_SOH);
      setComponents(MOCK_COMPONENTS);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      // Server derives BOM codes from assembly product codes
      const refreshParam = refresh ? '?refresh=true' : '';
      const response = await fetch(`/api/kitchen-data${refreshParam}`);
      const json = await response.json();

      if (!json.success) {
        throw new Error(json.error || 'Failed to fetch kitchen data');
      }

      const { sohItems, assemblies, warehouses, openPOLines: apiOpenPOLines } = json.data as {
        sohItems: StockOnHandItem[];
        assemblies: Assembly[];
        warehouses: Warehouse[];
        openPOLines?: OpenPOLine[];
      };

      // 1. Build warehouse-aware SOH view.
      //    byWarehouseOrGlobalMap gracefully falls back to global when Unleashed
      //    returns aggregated SOH (empty warehouse fields on all items).
      const soh = new WarehouseSOH(sohItems);
      const effectiveSOH = soh.byWarehouseOrGlobalMap(WAREHOUSES.LUNDBERG);

      // 2. Build components registry from SOH product names
      const componentsMap = buildComponentsMap(sohItems);

      // 3. Build one IntermediateData per assembly (1:1 mapping)
      const merged = buildIntermediatesFromAssemblies(assemblies, registry);

      setIntermediates(merged);
      setComponentSOH(effectiveSOH);           // Lundberg (or global fallback)
      setGlobalComponentSOH(soh.globalOnHandMap()); // For amber-state detection
      setPerProductSOH(soh.perProductMap());   // Per-warehouse breakdown per product
      setComponents(componentsMap);
      setOpenPOLines(apiOpenPOLines ?? []);

      // Resolve kitchen warehouse ID if not already cached
      if (!options?.kitchenWarehouseId && options?.onWarehouseResolved) {
        const lb = warehouses.find(
          (w) => w.warehouseCode === 'LB' || w.warehouseName.includes('LB')
        );
        if (lb) {
          options.onWarehouseResolved(lb.warehouseId, lb.warehouseName);
        }
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to fetch kitchen data';
      setError(message);

      // Fall back to mock data on error so the UI is still usable
      setIntermediates(MOCK_INTERMEDIATES);
      setComponentSOH(MOCK_COMPONENT_SOH);
      setComponents(MOCK_COMPONENTS);
    } finally {
      setLoading(false);
    }
  }, [registry]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const updateIntermediateBatchSize = useCallback((key: string, size: number) => {
    setIntermediates((prev) => {
      const item = prev[key];
      if (!item) return prev;
      return { ...prev, [key]: { ...item, batchSize: size, demand: size } };
    });
  }, []);

  return {
    intermediates,
    componentSOH,
    globalComponentSOH,
    perProductSOH,
    components,
    openPOLines,
    loading,
    error,
    refetch: () => fetchData(true),
    updateIntermediateBatchSize,
  };
}

// ---- Helper functions ----

function buildComponentsMap(items: StockOnHandItem[]): Record<string, ComponentData> {
  const map: Record<string, ComponentData> = {};
  for (const item of items) {
    if (!map[item.productCode]) {
      map[item.productCode] = {
        code: item.productCode,
        name: item.productName,
      };
    }
  }
  return map;
}

/**
 * Build one IntermediateData entry per assembly (1:1 mapping).
 * Each assembly becomes exactly one batch in the pool.
 * The intermediates map is keyed by assemblyId.
 *
 * Components come from the assembly's own lines (not the BOM API,
 * which returns reverse-lookups — products that *use* the code).
 */
function buildIntermediatesFromAssemblies(
  assemblies: Assembly[],
  reg: Record<string, IntermediateConfig> = DEFAULT_REGISTRY
): Record<string, IntermediateData> {
  const result: Record<string, IntermediateData> = {};

  for (const assembly of assemblies) {
    const code = assembly.productCode;
    const config = reg[code];

    // Build components from assembly lines.
    // Assembly lines have absolute componentQuantity; convert to per-parent
    // ratio so the feasibility engine's (quantityPerParent × batchSize) math works.
    const components: Record<string, number> = {};
    for (const line of assembly.assemblyLines) {
      const ratio = assembly.quantity > 0
        ? line.componentQuantity / assembly.quantity
        : 0;
      components[line.productCode] = ratio;
    }

    result[assembly.assemblyId] = {
      name: config?.name || assembly.productName || code,
      code,
      level: config?.level || 'top',
      batchSize: assembly.quantity,
      equipment: config?.equipment || 'mixer',
      durationDays: config?.durationDays,
      prepDays: config?.prepDays,
      prepNotes: config?.prepNotes,
      demand: assembly.quantity,
      deadline: '', // Set by packaging deadlines in config, not assembly timestamps
      requires: config?.requires || [],
      components,
      assemblyId: assembly.assemblyId,
      assemblyNumber: assembly.assemblyNumber,
      createdOn: assembly.createdOn,
    };
  }

  return result;
}
