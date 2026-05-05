'use client';

import { useEffect } from 'react';
import { initServerSync } from '@/lib/planning/plan-store-sync';

/**
 * Mounts once at app root to bootstrap the server-sync layer for the local
 * plan-draft-store. Pulls the authoritative state from the server, replaces
 * localStorage, and wires the focus/unload listeners that keep the local
 * cache in step with other browsers.
 */
export function PlanStoreInit(): null {
  useEffect(() => {
    void initServerSync();
  }, []);
  return null;
}
