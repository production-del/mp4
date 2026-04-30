/**
 * Kitchen production projection engine
 * Pure functional implementation with no side effects
 *
 * Key constraint: No-same-day-chaining
 * - Output from a batch becomes available the next working day after its
 *   LAST processing day. Single-day batches (durationDays undefined or 1)
 *   are ready next working day. Multi-day batches (e.g., Brazil nuts at
 *   durationDays=2) push that out: a 2-day batch starting Monday finishes
 *   Tuesday, output available Wednesday.
 * - Supports two-level intermediate dependencies
 *
 * Forward simulation:
 * - Batches are processed chronologically
 * - Component consumption reduces running SOH
 * - Production output increases running SOH for later batches
 */

import { BusinessCalendar } from "./business-calendar";
import type {
  KitchenBatch,
  BOMComponent,
  SOHItem,
  BatchFeasibility,
  ComponentShortfall,
  KitchenProjectionResult,
  BatchTimeline,
  KitchenProjectionInput,
} from "@/lib/planning/engine-io";

/**
 * Compute when a batch's output becomes available downstream, accounting for
 * multi-day processing. For a batch starting `scheduledDate` that runs for
 * `durationDays` calendar days, the last processing day is
 * `scheduledDate + durationDays - 1` and the output is ready the next
 * working day after that. Undefined/1 matches legacy behaviour (ready next
 * working day).
 */
function availableDateOf(
  batch: KitchenBatch,
  calendar: BusinessCalendar,
): Date {
  const duration = Math.max(1, batch.durationDays ?? 1);
  const last = new Date(batch.scheduledDate);
  last.setDate(last.getDate() + (duration - 1));
  return calendar.nextWorkingDay(last);
}

/**
 * Analyze kitchen batch feasibility with forward simulation.
 *
 * Batches are sorted by date and processed chronologically.
 * As each batch is processed:
 *   1. Pending production from earlier batches is added to running SOH
 *   2. Component availability is checked against running SOH
 *   3. If feasible, consumed components are deducted from running SOH
 *   4. Production output is queued for the next working day
 */
export function analyzeKitchenBatches(
  input: KitchenProjectionInput
): KitchenProjectionResult {
  const { batches, boms, soh, globalSOH, businessCalendar } = input;

  // Build running SOH (mutable copy) — based on planning warehouse
  const runningSOH = new Map<string, number>();
  for (const item of soh) {
    runningSOH.set(
      item.productCode,
      (runningSOH.get(item.productCode) || 0) + item.quantity
    );
  }

  // Build global SOH map (for amber state detection — stock exists elsewhere)
  const globalSOHMap = new Map<string, number>();
  if (globalSOH) {
    for (const item of globalSOH) {
      globalSOHMap.set(
        item.productCode,
        (globalSOHMap.get(item.productCode) || 0) + item.quantity
      );
    }
  }

  // Build BOM lookup (parent product code -> components)
  const bomMap = new Map<string, BOMComponent[]>();
  for (const component of boms) {
    const key = component.parentProductCode;
    if (!bomMap.has(key)) {
      bomMap.set(key, []);
    }
    bomMap.get(key)!.push(component);
  }

  // Identify product codes that are themselves produced by batches
  // (i.e. intermediates whose output can feed later batches)
  const producedCodes = new Set(batches.map((b) => b.productCode));

  // Pending production: output not yet available (keyed by product code)
  // Each entry: { availableDate, quantity }
  const pendingProduction: { productCode: string; availableDate: Date; quantity: number }[] = [];

  // Sort batches by scheduled date (stable sort preserves order for same-day)
  const sortedBatches = [...batches].sort(
    (a, b) => a.scheduledDate.getTime() - b.scheduledDate.getTime()
  );

  // Map from batch ID to feasibility result (to return in original order)
  const feasibilityMap = new Map<string, BatchFeasibility>();
  const timeline: BatchTimeline[] = [];

  for (const batch of sortedBatches) {
    // 1. Release any pending production that's now available
    for (const pending of pendingProduction) {
      if (batch.scheduledDate >= pending.availableDate && pending.quantity > 0) {
        runningSOH.set(
          pending.productCode,
          (runningSOH.get(pending.productCode) || 0) + pending.quantity
        );
        pending.quantity = 0; // Mark as released
      }
    }

    // 2. Check feasibility against running SOH
    const components = bomMap.get(batch.productCode) || [];
    const missingComponents: ComponentShortfall[] = [];
    const constraints: string[] = [];
    let canStart = true;

    for (const component of components) {
      const available = runningSOH.get(component.productCode) || 0;
      const required = component.quantityPerParent * batch.quantity;

      if (available < required) {
        missingComponents.push({
          productCode: component.productCode,
          productName: component.productName,
          available,
          required,
          shortfall: required - available,
          canBeProcured: !producedCodes.has(component.productCode),
          globalAvailable: globalSOHMap.get(component.productCode) || available,
        });
        canStart = false;
        constraints.push(
          `Insufficient ${component.productCode}: need ${required.toFixed(1)}, have ${available.toFixed(1)}`
        );
      }
    }

    // Check working day constraint
    if (!businessCalendar.isWorkingDay(batch.scheduledDate)) {
      canStart = false;
      constraints.push("Scheduled date is not a working day");
    }

    const feasible = canStart && missingComponents.length === 0;

    // 3. If feasible, deduct consumed components and queue production
    if (feasible) {
      for (const component of components) {
        const required = component.quantityPerParent * batch.quantity;
        const current = runningSOH.get(component.productCode) || 0;
        runningSOH.set(component.productCode, current - required);
      }

      // Queue production output (available next working day after the
      // batch's last processing day — see `availableDateOf`).
      const availableDate = availableDateOf(batch, businessCalendar);
      pendingProduction.push({
        productCode: batch.productCode,
        availableDate,
        quantity: batch.quantity,
      });

      // Timeline events
      timeline.push(
        {
          batchId: batch.id,
          productCode: batch.productCode,
          date: batch.scheduledDate,
          event: "scheduled",
          notes: `Batch scheduled: ${batch.quantity} units`,
        },
        {
          batchId: batch.id,
          productCode: batch.productCode,
          date: availableDate,
          event: "available_next_day",
          notes: `Output available (${batch.quantity} units)`,
        }
      );
    } else {
      timeline.push({
        batchId: batch.id,
        productCode: batch.productCode,
        date: batch.scheduledDate,
        event: "scheduled",
        notes: `Batch scheduled but infeasible: ${constraints.join("; ")}`,
      });
    }

    // Calculate available quantity (max batches producible from current stock)
    const availableQuantity =
      components.length > 0
        ? Math.min(
            ...components.map((c) => {
              const avail = runningSOH.get(c.productCode) || 0;
              return c.quantityPerParent > 0
                ? Math.floor(avail / c.quantityPerParent)
                : Infinity;
            })
          )
        : 0;

    feasibilityMap.set(batch.id, {
      batchId: batch.id,
      productCode: batch.productCode,
      feasible,
      constraints,
      availableQuantity: Math.max(0, availableQuantity),
      requiredQuantity: batch.quantity,
      canStart,
      missingComponents,
    });
  }

  // Return results in original batch order
  const batchFeasibilities = batches.map(
    (b) => feasibilityMap.get(b.id)!
  );

  // Sort timeline by date
  timeline.sort((a, b) => a.date.getTime() - b.date.getTime());

  return {
    batches: batchFeasibilities,
    aggregated: {
      totalFeasible: batchFeasibilities.filter((b) => b.feasible).length,
      totalInfeasible: batchFeasibilities.filter((b) => !b.feasible).length,
      totalAtRisk: batchFeasibilities.filter(
        (b) => b.missingComponents.length > 0
      ).length,
    },
    timeline,
  };
}

/**
 * Check if output from one batch can be used as input to another, given
 * the no-same-day-chaining constraint and the producer's processing
 * duration. Callers supply `producerDurationDays` when the producing batch
 * takes more than a day; undefined/1 preserves legacy behaviour.
 */
export function canChainBatches(
  producerBatchDate: Date,
  consumerBatchDate: Date,
  calendar: BusinessCalendar,
  producerDurationDays?: number,
): boolean {
  const duration = Math.max(1, producerDurationDays ?? 1);
  const last = new Date(producerBatchDate);
  last.setDate(last.getDate() + (duration - 1));
  const availableDate = calendar.nextWorkingDay(last);
  return consumerBatchDate >= availableDate;
}

/**
 * Get the production timeline for a set of batches
 * Respects no-same-day-chaining constraint
 */
export function getProductionTimeline(
  batches: KitchenBatch[],
  calendar: BusinessCalendar
): BatchTimeline[] {
  const timeline: BatchTimeline[] = [];

  for (const batch of batches) {
    const availableDate = availableDateOf(batch, calendar);

    timeline.push(
      {
        batchId: batch.id,
        productCode: batch.productCode,
        date: batch.scheduledDate,
        event: "scheduled",
        notes: `${batch.quantity} units scheduled`,
      },
      {
        batchId: batch.id,
        productCode: batch.productCode,
        date: availableDate,
        event: "available_next_day",
        notes: "Output available (next working day)",
      }
    );
  }

  return timeline.sort((a, b) => a.date.getTime() - b.date.getTime());
}

/**
 * Calculate the critical path for batch dependencies
 */
export function calculateCriticalPath(
  batches: KitchenBatch[],
  calendar: BusinessCalendar
): number {
  const batchMap = new Map<string, KitchenBatch>();
  for (const batch of batches) {
    batchMap.set(batch.id, batch);
  }

  const pathCache = new Map<string, number>();

  function getCriticalPathForBatch(batchId: string): number {
    if (pathCache.has(batchId)) {
      return pathCache.get(batchId)!;
    }

    const batch = batchMap.get(batchId);
    if (!batch || batch.dependencies.length === 0) {
      pathCache.set(batchId, 1);
      return 1;
    }

    let maxPath = 1;
    for (const depId of batch.dependencies) {
      const depPath = getCriticalPathForBatch(depId);
      maxPath = Math.max(maxPath, depPath + 1);
    }

    pathCache.set(batchId, maxPath);
    return maxPath;
  }

  let criticalPath = 0;
  for (const batch of batches) {
    criticalPath = Math.max(criticalPath, getCriticalPathForBatch(batch.id));
  }

  return criticalPath;
}
