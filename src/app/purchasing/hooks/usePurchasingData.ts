'use client';

import { useState, useEffect, useCallback } from 'react';
import type {
  PurchaseOrder,
  StockOnHandItem,
  Assembly,
  Supplier,
  Product,
} from '@/lib/unleashed/types';
import type { KitchenBatch } from '@/lib/planning/engine-io';
import type { SupplierInfo } from '../data/mock-purchasing-data';
import { WarehouseSOH } from '@/lib/planning/warehouse-soh';
import {
  demandsFromKitchenAssemblies,
  consumptionScheduleFromDemands,
} from '@/lib/planning/demand';
import {
  MOCK_SUPPLIERS,
  MOCK_COMPONENT_SUPPLIERS,
  MOCK_COMPONENT_NAMES,
  MOCK_PURCHASING_SOH,
  MOCK_CONSUMPTION_SCHEDULE,
  MOCK_EXISTING_POS,
} from '../data/mock-purchasing-data';

const USE_MOCK = process.env.NEXT_PUBLIC_USE_MOCK_DATA === 'true';

export interface PurchasingDataResult {
  componentSOH: Record<string, number>;
  /** productCode → warehouseName → qty (for warehouse-scoped projections) */
  perWarehouseSOH: Record<string, Record<string, number>>;
  componentNames: Record<string, string>;
  componentSuppliers: Record<string, string>; // componentCode → supplierId
  suppliers: Record<string, SupplierInfo>;
  consumptionSchedule: Record<string, KitchenBatch[]>;
  /** productCode → monthly demand from CSV (authoritative demand rates) */
  demandRates: Record<string, number>;
  existingPOs: PurchaseOrder[];
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

/**
 * Fetches all data needed for the purchasing calendar via a single
 * server-side API route that handles pagination + caching.
 */
export function usePurchasingData(): PurchasingDataResult {
  const [componentSOH, setComponentSOH] = useState<Record<string, number>>({});
  const [perWarehouseSOH, setPerWarehouseSOH] = useState<Record<string, Record<string, number>>>({});
  const [componentNames, setComponentNames] = useState<Record<string, string>>({});
  const [componentSuppliers, setComponentSuppliers] = useState<Record<string, string>>({});
  const [suppliers, setSuppliers] = useState<Record<string, SupplierInfo>>({});
  const [consumptionSchedule, setConsumptionSchedule] = useState<Record<string, KitchenBatch[]>>({});
  const [demandRates, setDemandRates] = useState<Record<string, number>>({});
  const [existingPOs, setExistingPOs] = useState<PurchaseOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async (refresh = false) => {
    if (USE_MOCK) {
      setComponentSOH(MOCK_PURCHASING_SOH);
      setPerWarehouseSOH({});
      setComponentNames(MOCK_COMPONENT_NAMES);
      setComponentSuppliers(MOCK_COMPONENT_SUPPLIERS);
      setSuppliers(MOCK_SUPPLIERS);
      setConsumptionSchedule(MOCK_CONSUMPTION_SCHEDULE);
      setExistingPOs(MOCK_EXISTING_POS);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      // Client-side override (uploaded via Settings → Demand Import) wins
      // over the server CSV — we only hit the network when no override is
      // present. The network fetch for purchasing-data still runs in parallel.
      const { readDemandOverride } = await import('@/lib/planning/demand-override');
      const override = readDemandOverride();
      const [response, demandRes] = await Promise.all([
        fetch(refresh ? '/api/purchasing-data?refresh=true' : '/api/purchasing-data'),
        override ? null : fetch('/api/demand-data'),
      ]);
      const json = await response.json();

      if (!json.success) {
        throw new Error(json.error || 'Failed to fetch purchasing data');
      }

      // Demand rates: override first, else server CSV.
      if (override) {
        setDemandRates(override.demand);
      } else if (demandRes) {
        const demandJson = await demandRes.json();
        if (demandJson.success && demandJson.data?.demand) {
          setDemandRates(demandJson.data.demand as Record<string, number>);
        }
      }

      const { sohItems, openPOs, partialPOs, assemblies, suppliers: supplierList, products } = json.data as {
        sohItems: StockOnHandItem[];
        openPOs: PurchaseOrder[];
        partialPOs: PurchaseOrder[];
        assemblies: Assembly[];
        suppliers: Supplier[];
        products: Product[];
      };

      // Build warehouse-aware SOH view
      const soh = new WarehouseSOH(sohItems);
      const sohMap = soh.globalOnHandMap();     // backward compat: global totals
      const perProdSOH = soh.perProductMap();   // productCode → warehouseName → qty

      // Build name map
      const nameMap: Record<string, string> = {};
      for (const item of sohItems) {
        if (!nameMap[item.productCode]) {
          nameMap[item.productCode] = item.productName;
        }
      }

      // Build supplier map
      const supMap: Record<string, SupplierInfo> = {};
      for (const s of supplierList) {
        supMap[s.supplierId] = { supplierId: s.supplierId, supplierName: s.supplierName };
      }

      // Build component → supplier mapping from products
      const compSupMap: Record<string, string> = {};
      for (const p of products) {
        if (p.supplier) {
          compSupMap[p.productCode] = p.supplier.supplierId;
          if (!supMap[p.supplier.supplierId]) {
            supMap[p.supplier.supplierId] = {
              supplierId: p.supplier.supplierId,
              supplierName: p.supplier.supplierName,
            };
          }
        }
      }

      // Derive consumption schedule from assemblies via the shared demand helper.
      // Identical to the derivation the logistics page does — now both use one path.
      const consumption = consumptionScheduleFromDemands(
        demandsFromKitchenAssemblies(assemblies),
      );

      // Merge POs
      const allPOs = [...openPOs, ...partialPOs];

      setComponentSOH(sohMap);
      setPerWarehouseSOH(perProdSOH);
      setComponentNames(nameMap);
      setComponentSuppliers(compSupMap);
      setSuppliers(supMap);
      setConsumptionSchedule(consumption);
      setExistingPOs(allPOs);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch purchasing data';
      setError(message);

      // Fallback to mock data
      setComponentSOH(MOCK_PURCHASING_SOH);
      setPerWarehouseSOH({});
      setComponentNames(MOCK_COMPONENT_NAMES);
      setComponentSuppliers(MOCK_COMPONENT_SUPPLIERS);
      setSuppliers(MOCK_SUPPLIERS);
      setConsumptionSchedule(MOCK_CONSUMPTION_SCHEDULE);
      setExistingPOs(MOCK_EXISTING_POS);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    // Refresh when the operator imports/clears a demand override in Settings.
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'byron-demand-override-v1' || e.key === null) {
        fetchData();
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [fetchData]);

  return {
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
    refetch: () => fetchData(true),
  };
}

