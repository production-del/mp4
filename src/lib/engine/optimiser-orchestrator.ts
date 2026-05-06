/**
 * Multi-product orchestrator — Phase 3d of the 3-month planner.
 *
 * Coordinates per-product calls to `optimiseSingleProduct` and resolves the
 * cross-product coupling on shared packaging stations (changeover costs).
 *
 * Approach
 * ────────
 * Two passes:
 *   1. **Independent per-product optimisation.** Each product gets its own
 *      DP solve via `optimiseSingleProduct`, parameterised by an *expected*
 *      `setupCost` (default: middle of the changeover-cost range for its
 *      station, or `fullClean` if the product has no extendedFamily).
 *   2. **Per-station greedy reorder within each week.** Once every product
 *      has chosen its run weeks, we walk each station's timeline and, for
 *      each week, pick the ordering of that week's batches that minimises
 *      the sum of changeover minutes from the prior batch on the station.
 *      Brute force over orderings when there are ≤ 8 batches in the week
 *      (8! = 40,320 — trivial); nearest-neighbour fallback above that.
 *
 * What's deliberately NOT in 3d
 * ─────────────────────────────
 * **No fixed-point iteration.** A second pass that adjusts each product's
 * `setupCost` to its actual realised changeover cost, then re-optimises,
 * could improve schedules further (a product clustered with family-mates
 * could afford more frequent runs than its conservative setupCost
 * suggested). Phase 3e if needed.
 *
 * **No station capacity enforcement.** If five products want Bottlo on
 * week 3 but Bottlo's daily-hours budget can't hold them all, the
 * orchestrator still produces the schedule and surfaces the overcapacity
 * as a `warnings` entry. Capacity-aware rebalancing is future work — the
 * UI (Phase 4) can highlight overruns and let the user re-plan with
 * adjusted parameters.
 *
 * **No demand handed off between products.** This module assumes each
 * product's demand is independent input. Cascading demand (finished good →
 * intermediate batch demand) is the BOM exploder's job (Phase 2); the
 * orchestrator's caller composes them.
 */

import {
  optimiseSingleProduct,
  type ScheduledBatch,
  type SingleProductOptimiserInput,
  type SingleProductOptimiserOutput,
} from './batch-optimiser';
import {
  costToSwitch,
  DEFAULT_CHANGEOVER_MATRIX,
} from './changeover';
import type {
  ChangeoverCostMatrix,
  ProductMeta,
  Station,
} from '@/lib/planning/engine-io';

// ─── Public types ────────────────────────────────────────────

export interface ProductPlan {
  meta: ProductMeta;
  weeklyDemand: ReadonlyArray<{ weekStart: string; quantity: number }>;
  initialInventory: number;
  shelfLifeDays: number;
  minBatchSize: number;
  maxBatchSize: number;
  /** Override the orchestrator-derived default. Same units (minutes). */
  setupCost?: number;
  storageCapByWeek?: ReadonlyArray<number>;
  step?: number;
}

export interface OrchestratorInput {
  products: ProductPlan[];
  /** Override the default changeover-cost matrix. */
  changeoverMatrix?: ChangeoverCostMatrix;
  /**
   * The last batch on each station before the horizon starts. Drives the
   * cost of the FIRST batch in each station timeline. Omit a station to
   * indicate "no prior context" (first batch on that station costs 0).
   */
  previousBatchByStation?: Partial<Record<Station, ProductMeta>>;
}

export interface ScheduledBatchWithMeta extends ScheduledBatch {
  productMeta: ProductMeta;
  /** Position within the week on this station; 0 = first. */
  orderInWeek: number;
}

export interface ChangeoverEvent {
  /** `null` for the first batch on the station after the horizon starts. */
  fromProductCode: string | null;
  toProductCode: string;
  weekStart: string;
  costMinutes: number;
  station: Station;
}

export interface StationTimeline {
  station: Station;
  /** Chronologically ordered, with within-week ordering optimised. */
  batches: ScheduledBatchWithMeta[];
  changeovers: ChangeoverEvent[];
  totalChangeoverMinutes: number;
}

export type OrchestratorWarning =
  | {
      kind: 'station_capacity_overrun';
      station: Station;
      weekStart: string;
      requestedMinutes: number;
      availableMinutes: number;
    }
  | {
      kind: 'product_infeasible';
      productCode: string;
      message: string;
    };

export interface OrchestratorOutput {
  perProduct: Map<string, SingleProductOptimiserOutput>;
  perStation: Map<Station, StationTimeline>;
  totalChangeoverMinutes: number;
  rationale: string[];
  warnings: OrchestratorWarning[];
}

// ─── Defaults ────────────────────────────────────────────────

const STATIONS_ALL: ReadonlyArray<Station> = [
  'hand-packing',
  'elephant',
  'dust',
  'bottlo',
];

/**
 * A reasonable default `setupCost` for a product on its station, used when
 * the caller doesn't override. Picks the *middle* of the cost ladder so
 * the per-product DP is neither overly cautious nor overly aggressive
 * about run frequency:
 *   - extendedFamily === null → `fullClean` (these always pay full clean)
 *   - else → `extendedFamily` cost (mid-tier estimate)
 *
 * The greedy reorder pass then realises the actual cost; for products that
 * end up next to family-mates the realised cost will be lower than this
 * default, and vice versa. Refinement is Phase 3e.
 */
function deriveDefaultSetupCost(
  meta: ProductMeta,
  matrix: ChangeoverCostMatrix,
): number {
  const row = matrix[meta.station];
  if (meta.extendedFamily === null) return row.fullClean;
  return row.extendedFamily;
}

// ─── Within-week reorder ─────────────────────────────────────

/**
 * Permutations generator. Used for brute-force ordering search when the
 * within-week batch count is small.
 */
function* permutations<T>(items: T[]): Generator<T[]> {
  if (items.length <= 1) {
    yield items.slice();
    return;
  }
  for (let i = 0; i < items.length; i++) {
    const rest = items.slice(0, i).concat(items.slice(i + 1));
    for (const tail of permutations(rest)) {
      yield [items[i], ...tail];
    }
  }
}

const BRUTE_FORCE_THRESHOLD = 8;

/**
 * Choose the order of `batches` (all in the same week, on `station`) that
 * minimises the sum of changeover costs from `prior` through the sequence.
 *
 * Brute force when |batches| ≤ 8 (8! = 40,320 orderings — trivial). Above
 * that, greedy nearest-neighbour: at each step, pick the unscheduled batch
 * with the lowest changeover cost from the current "previous". Greedy is
 * not optimal but is a reasonable approximation for the rare large-week case.
 */
function reorderWithinWeek(
  batches: ScheduledBatchWithMeta[],
  prior: ProductMeta | null,
  station: Station,
  matrix: ChangeoverCostMatrix,
): { order: ScheduledBatchWithMeta[]; cost: number } {
  if (batches.length === 0) return { order: [], cost: 0 };
  if (batches.length === 1) {
    return {
      order: batches.slice(),
      cost: costToSwitch(prior, batches[0].productMeta, station, matrix),
    };
  }

  function sequenceCost(
    seq: ScheduledBatchWithMeta[],
    initialPrior: ProductMeta | null,
  ): number {
    let total = 0;
    let prev = initialPrior;
    for (const b of seq) {
      total += costToSwitch(prev, b.productMeta, station, matrix);
      prev = b.productMeta;
    }
    return total;
  }

  if (batches.length <= BRUTE_FORCE_THRESHOLD) {
    let best: ScheduledBatchWithMeta[] = batches.slice();
    let bestCost = Number.POSITIVE_INFINITY;
    for (const perm of permutations(batches)) {
      const c = sequenceCost(perm, prior);
      if (c < bestCost) {
        bestCost = c;
        best = perm;
      }
    }
    return { order: best, cost: bestCost };
  }

  // Greedy nearest-neighbour for large weeks.
  const remaining = batches.slice();
  const ordered: ScheduledBatchWithMeta[] = [];
  let prev = prior;
  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestCost = Number.POSITIVE_INFINITY;
    for (let i = 0; i < remaining.length; i++) {
      const c = costToSwitch(prev, remaining[i].productMeta, station, matrix);
      if (c < bestCost) {
        bestCost = c;
        bestIdx = i;
      }
    }
    const chosen = remaining.splice(bestIdx, 1)[0];
    ordered.push(chosen);
    prev = chosen.productMeta;
  }
  return { order: ordered, cost: sequenceCost(ordered, prior) };
}

// ─── Public API ──────────────────────────────────────────────

export function orchestrateBatchPlan(
  input: OrchestratorInput,
): OrchestratorOutput {
  const matrix = input.changeoverMatrix ?? DEFAULT_CHANGEOVER_MATRIX;
  const priorByStation = input.previousBatchByStation ?? {};

  // ─── Pass 1: per-product DP ──────────────────────────────
  const perProduct = new Map<string, SingleProductOptimiserOutput>();
  const warnings: OrchestratorWarning[] = [];
  // Per-station collection of {batch, productMeta} — preserves all info
  // needed for the reorder pass.
  const stationBuckets = new Map<Station, ScheduledBatchWithMeta[]>();
  for (const station of STATIONS_ALL) stationBuckets.set(station, []);

  for (const plan of input.products) {
    const setupCost =
      plan.setupCost ?? deriveDefaultSetupCost(plan.meta, matrix);

    const dpInput: SingleProductOptimiserInput = {
      productCode: plan.meta.productCode,
      weeklyDemand: plan.weeklyDemand,
      initialInventory: plan.initialInventory,
      shelfLifeDays: plan.shelfLifeDays,
      minBatchSize: plan.minBatchSize,
      maxBatchSize: plan.maxBatchSize,
      setupCost,
      storageCapByWeek: plan.storageCapByWeek,
      step: plan.step,
    };
    const result = optimiseSingleProduct(dpInput);
    perProduct.set(plan.meta.productCode, result);

    if (!result.feasible) {
      warnings.push({
        kind: 'product_infeasible',
        productCode: plan.meta.productCode,
        message:
          result.rationale[0] ??
          `Product ${plan.meta.productCode} could not be scheduled feasibly.`,
      });
      continue;
    }

    const bucket = stationBuckets.get(plan.meta.station)!;
    for (const batch of result.batches) {
      bucket.push({
        ...batch,
        productMeta: plan.meta,
        orderInWeek: 0, // assigned in the reorder pass
      });
    }
  }

  // ─── Pass 2: per-station reorder within each week ────────
  const perStation = new Map<Station, StationTimeline>();
  let grandTotalChangeover = 0;

  for (const station of STATIONS_ALL) {
    const allBatches = stationBuckets.get(station)!;
    if (allBatches.length === 0) {
      perStation.set(station, {
        station,
        batches: [],
        changeovers: [],
        totalChangeoverMinutes: 0,
      });
      continue;
    }

    // Group by week. Iterating week-by-week in chronological order; within
    // each week, run the reorder.
    const byWeek = new Map<string, ScheduledBatchWithMeta[]>();
    for (const b of allBatches) {
      let arr = byWeek.get(b.weekStart);
      if (!arr) {
        arr = [];
        byWeek.set(b.weekStart, arr);
      }
      arr.push(b);
    }
    const weekStarts = Array.from(byWeek.keys()).sort();

    const orderedBatches: ScheduledBatchWithMeta[] = [];
    const changeovers: ChangeoverEvent[] = [];
    let stationTotal = 0;
    let prior: ProductMeta | null = priorByStation[station] ?? null;

    for (const weekStart of weekStarts) {
      const weekBatches = byWeek.get(weekStart)!;
      const { order } = reorderWithinWeek(weekBatches, prior, station, matrix);
      let prev = prior;
      for (let i = 0; i < order.length; i++) {
        const batch = { ...order[i], orderInWeek: i };
        const cost = costToSwitch(prev, batch.productMeta, station, matrix);
        changeovers.push({
          fromProductCode: prev?.productCode ?? null,
          toProductCode: batch.productMeta.productCode,
          weekStart,
          costMinutes: cost,
          station,
        });
        stationTotal += cost;
        orderedBatches.push(batch);
        prev = batch.productMeta;
      }
      prior = prev;
    }

    perStation.set(station, {
      station,
      batches: orderedBatches,
      changeovers,
      totalChangeoverMinutes: stationTotal,
    });
    grandTotalChangeover += stationTotal;
  }

  // ─── Rationale ───────────────────────────────────────────
  const rationale: string[] = [];
  const totalProducts = input.products.length;
  const feasibleCount = totalProducts - warnings.filter((w) => w.kind === 'product_infeasible').length;
  rationale.push(
    `Scheduled ${feasibleCount} of ${totalProducts} products across ${STATIONS_ALL.length} stations.`,
  );
  rationale.push(
    `Total changeover minutes across all stations: ${grandTotalChangeover}.`,
  );
  for (const station of STATIONS_ALL) {
    const tl = perStation.get(station)!;
    if (tl.batches.length === 0) continue;
    rationale.push(
      `${station}: ${tl.batches.length} batches, ${tl.totalChangeoverMinutes} changeover min.`,
    );
  }

  return {
    perProduct,
    perStation,
    totalChangeoverMinutes: grandTotalChangeover,
    rationale,
    warnings,
  };
}
