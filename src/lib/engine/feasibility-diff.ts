/**
 * Feasibility diff engine — pure function that compares two feasibility
 * snapshots and generates RiskEvents for any batches that worsened.
 *
 * No side effects. The caller is responsible for storing / dismissing events.
 */

import type { FeasibilityState, ComponentShortfall } from '@/lib/planning/engine-io';
import type { RiskEvent, RiskTrigger } from '@/lib/planning/risk-events';
import { isWorsened, generateRiskId } from '@/lib/planning/risk-events';

export interface FeasibilitySnapshot {
  state: FeasibilityState;
  productCode: string;
  missingComponents: ComponentShortfall[];
}

/**
 * Compare batch-by-batch feasibility and return RiskEvents for every batch
 * whose state worsened (green→amber, green→red, amber→red).
 *
 * Nearby changes with the same state transition are grouped into a single
 * event where possible (i.e. same previousState→newState pair).
 */
export function diffFeasibility(
  previous: Map<string, FeasibilitySnapshot>,
  current: Map<string, FeasibilitySnapshot>,
): RiskEvent[] {
  // Bucket worsened batches by their state transition for grouping.
  const buckets = new Map<
    string, // key: `${prev}->${next}`
    { batchIds: string[]; productCodes: Set<string>; descriptions: string[] }
  >();

  for (const [batchId, curSnap] of current) {
    const prevSnap = previous.get(batchId);
    if (!prevSnap) continue; // new batch — no prior state to compare

    if (!isWorsened(prevSnap.state, curSnap.state)) continue;

    const key = `${prevSnap.state}->${curSnap.state}`;

    if (!buckets.has(key)) {
      buckets.set(key, { batchIds: [], productCodes: new Set(), descriptions: [] });
    }

    const bucket = buckets.get(key)!;
    bucket.batchIds.push(batchId);
    bucket.productCodes.add(curSnap.productCode);

    // Build a human-readable description from shortfalls
    if (curSnap.missingComponents.length > 0) {
      for (const mc of curSnap.missingComponents) {
        bucket.descriptions.push(
          `${mc.productCode} short: need ${Math.round(mc.required)}, have ${Math.round(mc.available)}`
        );
      }
    } else {
      bucket.descriptions.push(
        `${curSnap.productCode} feasibility worsened from ${prevSnap.state} to ${curSnap.state}`
      );
    }
  }

  // Convert buckets to RiskEvents
  const events: RiskEvent[] = [];

  for (const [key, bucket] of buckets) {
    const [prev, next] = key.split('->') as [FeasibilityState, FeasibilityState];

    // Deduplicate descriptions
    const uniqueDescs = [...new Set(bucket.descriptions)];

    // Infer trigger: if a batch moved states it is most likely an SOH or demand change.
    // The caller can override this if they have more context, but for the diff engine
    // we use a sensible default.
    const trigger: RiskTrigger =
      next === 'amber' ? 'transfer_changed' : 'soh_changed';

    events.push({
      id: generateRiskId(),
      timestamp: new Date(),
      trigger,
      description: uniqueDescs.join('; '),
      affectedBatchIds: bucket.batchIds,
      affectedProductCodes: [...bucket.productCodes],
      previousState: prev,
      newState: next,
    });
  }

  return events;
}

/**
 * Build a FeasibilitySnapshot map from the current feasibility results and
 * a color resolver. This captures the three-state colour per batch along with
 * the raw shortfall data for description generation.
 */
export function buildFeasibilitySnapshot(
  feasibilityResults: Map<string, { productCode: string; missingComponents: ComponentShortfall[] }>,
  getFeasibilityColor: (batchId: string) => FeasibilityState,
): Map<string, FeasibilitySnapshot> {
  const snapshot = new Map<string, FeasibilitySnapshot>();

  for (const [batchId, result] of feasibilityResults) {
    snapshot.set(batchId, {
      state: getFeasibilityColor(batchId),
      productCode: result.productCode,
      missingComponents: result.missingComponents,
    });
  }

  return snapshot;
}
