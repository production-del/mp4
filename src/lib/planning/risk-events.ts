/**
 * Risk event types and utilities for backward risk propagation.
 *
 * When feasibility states worsen (green→amber, green→red, amber→red),
 * we generate ephemeral RiskEvents that surface warnings on affected batches.
 * These are session-only — not persisted to localStorage.
 */

import type { FeasibilityState } from '@/lib/planning/engine-io';

export type RiskTrigger =
  | 'soh_changed'
  | 'batch_rescheduled'
  | 'demand_changed'
  | 'transfer_changed';

export interface RiskEvent {
  id: string;
  timestamp: Date;
  trigger: RiskTrigger;
  description: string;
  affectedBatchIds: string[];
  affectedProductCodes: string[];
  previousState: FeasibilityState;
  newState: FeasibilityState;
}

/** Severity ordering for feasibility states (lower = better). */
const STATE_SEVERITY: Record<FeasibilityState, number> = {
  green: 0,
  amber: 1,
  red: 2,
};

/** Returns true when `next` is strictly worse than `prev`. */
export function isWorsened(prev: FeasibilityState, next: FeasibilityState): boolean {
  return STATE_SEVERITY[next] > STATE_SEVERITY[prev];
}

/** Generate a short unique ID for a risk event. */
export function generateRiskId(): string {
  return `risk-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}
