'use client';

import { createContext, useContext } from 'react';
import type { IntermediateData, ComponentData } from '../data/mock-data';
import type { ScheduledBatch } from '../hooks/useKitchenPlanner';
import type { PackagingDeadline } from '../hooks/useConfig';
import type { OpenPOLine } from '../hooks/useKitchenData';

/**
 * Context for kitchen data — shared across all kitchen planner components.
 * Avoids prop-drilling intermediates/SOH through CalendarGrid → BatchCard etc.
 */
export interface KitchenDataContextValue {
  intermediates: Record<string, IntermediateData>;
  componentSOH: Record<string, number>;        // Lundberg Storeroom (production warehouse)
  globalComponentSOH: Record<string, number>;   // All warehouses (for amber state detection)
  perProductSOH: Record<string, Record<string, number>>; // productCode → warehouseName → qty
  components: Record<string, ComponentData>;
  scheduledBatches: ScheduledBatch[];
  blockStart: Date;
  blockEnd: Date;
  /** Packaging deadlines with component demand (from packaging calendar) */
  packagingDeadlines: PackagingDeadline[];
  /** Live Open + PartiallyReceived PO lines from Unleashed (outstanding qty only) */
  openPOLines?: OpenPOLine[];
  /** Update quantity on a scheduled batch (calendar card) */
  updateBatchQuantity?: (batchId: string, quantity: number) => void;
  /** Update batchSize on an unscheduled intermediate (pool card) */
  updateIntermediateBatchSize?: (intermediateKey: string, size: number) => void;
}

export const KitchenDataContext = createContext<KitchenDataContextValue | null>(
  null
);

export function useKitchenDataContext(): KitchenDataContextValue {
  const ctx = useContext(KitchenDataContext);
  if (!ctx) {
    throw new Error(
      'useKitchenDataContext must be used within a KitchenDataContext.Provider'
    );
  }
  return ctx;
}
