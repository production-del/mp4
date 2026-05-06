'use client';

import { useState, useEffect, useMemo } from 'react';
import { listByKind } from '@/lib/planning/plan-draft-store';
import { fromLocalISODate } from '@/lib/planning/working-day';
import type { KitchenRunItem } from '@/lib/planning/plan-item';

/**
 * Reads kitchen batches from the unified PlanDraftStore and aggregates
 * planned kg + ETA per intermediate code, so the packaging page can show
 * what's coming from the kitchen.
 *
 * Includes both draft and pushed (Unleashed-origin) batches — consumers
 * don't care about origin, just the total planned qty per intermediate.
 */

const DEMAND_STORE_KEY = 'byron-plan-drafts-v1';

export interface KitchenPlannedInfo {
  /** Total kg planned across all batches for this intermediate */
  totalKg: number;
  /** Number of batches */
  batchCount: number;
  /** Earliest scheduled date (when first batch lands) */
  earliestDate: Date;
  /** Latest scheduled date (when last batch lands — full ETA) */
  latestDate: Date;
}

/**
 * Returns a map of intermediate code → KitchenPlannedInfo for all
 * planned/scheduled kitchen batches. Listens for cross-tab storage events so
 * it updates when the kitchen page edits batches.
 */
export function useKitchenBatches(): Record<string, KitchenPlannedInfo> {
  const [items, setItems] = useState<KitchenRunItem[]>([]);

  useEffect(() => {
    setItems(listByKind('kitchen_run'));

    const onStorage = (e: StorageEvent) => {
      if (e.key === DEMAND_STORE_KEY) setItems(listByKind('kitchen_run'));
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  return useMemo(() => {
    const map: Record<string, KitchenPlannedInfo> = {};

    for (const batch of items) {
      // Skip completed batches
      if (batch.status === 'completed') continue;

      const code = batch.productCode;
      if (!code) continue;

      const date = fromLocalISODate(batch.scheduledDate);
      if (isNaN(date.getTime())) continue;

      if (!map[code]) {
        map[code] = {
          totalKg: 0,
          batchCount: 0,
          earliestDate: date,
          latestDate: date,
        };
      }

      map[code].totalKg += batch.quantity || 0;
      map[code].batchCount += 1;
      if (date < map[code].earliestDate) map[code].earliestDate = date;
      if (date > map[code].latestDate) map[code].latestDate = date;
    }

    return map;
  }, [items]);
}
