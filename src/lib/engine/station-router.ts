/**
 * Station router — per-product cost-efficient choice of packaging station.
 *
 * The spreadsheet declares which stations a product CAN run on (primary +
 * alternate columns of the `Kitchen processes` sheet). Which station it
 * SHOULD run on is a planning decision driven by total horizon demand,
 * station throughput, and changeover costs.
 *
 * This module's job: pick one station from the candidate set per product,
 * minimising estimated total minutes (production + amortised changeover).
 *
 * Per-product, independent — no cross-product coupling. Different products
 * routed to the same station then go through the orchestrator's family-
 * clustering pass to minimise actual changeover sequence cost. So this is
 * a routing heuristic, not a globally optimal solution; it estimates
 * changeover with a midpoint of the family-vs-extended-family ladder for
 * mapped products, and pessimistically assumes `fullClean` for the 108
 * unmapped extended-family SKUs (decision #1).
 *
 * Cost model
 * ──────────
 * For each candidate station S and product with horizon demand D:
 *   batches      ≈ ceil(D / dailyOutputOf(S))         // capped by daily cap
 *   productionMin = D / S.unitsPerHour × 60           // total prod time
 *   perBatchChange = (S.familySameSize + S.extendedFamily) / 2  // mid
 *                  | S.fullClean if extendedFamily === null     // pessim
 *   changeoverMin = batches × perBatchChange
 *   total         = productionMin + changeoverMin
 *
 * Lowest `total` wins. Ties broken by primary preference (caller-supplied
 * order — typically the spreadsheet's primary first).
 *
 * What this DOESN'T do
 * ────────────────────
 * - Account for cross-product station load (a station might already be
 *   over-subscribed by other routings). Phase 4c would add a load-aware
 *   refinement.
 * - Consider product-specific rate overrides (RateOverride is on the
 *   roadmap; not used yet by the router).
 * - Pick from > 2 candidate stations smartly — works fine for any N but
 *   the spreadsheet currently only ever gives 2.
 */

import type {
  ChangeoverCostMatrix,
  ExtendedFamily,
  Station,
} from '@/lib/planning/engine-io';
import type { StationDefaults } from '@/lib/planning/capacity-data';

// ─── Public types ────────────────────────────────────────────

export interface RoutingInput {
  productCode: string;
  /**
   * Stations the product CAN run on, in spreadsheet-declared preference
   * order (typically [primary, alternate]). Empty list returns the
   * `fallback` station with rationale.
   */
  candidateStations: Station[];
  /** Total demand across the planning horizon. Drives batch count + production time. */
  totalHorizonDemand: number;
  /** For changeover-cost estimation. */
  extendedFamily: ExtendedFamily | null;
  stationDefaults: Partial<Record<Station, StationDefaults>>;
  changeoverMatrix: ChangeoverCostMatrix;
  /** Returned when `candidateStations` is empty. Default 'hand-packing'. */
  fallback?: Station;
}

export interface CandidateEvaluation {
  station: Station;
  productionMinutes: number;
  changeoverMinutes: number;
  totalMinutes: number;
  estimatedBatches: number;
}

export interface RoutingDecision {
  station: Station;
  rationale: string;
  /** Sorted ascending by totalMinutes; first entry is the chosen station. */
  evaluations: CandidateEvaluation[];
}

// ─── Public API ──────────────────────────────────────────────

export function chooseEfficientStation(input: RoutingInput): RoutingDecision {
  const fallback = input.fallback ?? 'hand-packing';

  if (input.candidateStations.length === 0) {
    return {
      station: fallback,
      rationale: `No candidate stations declared for ${input.productCode}; falling back to ${fallback}.`,
      evaluations: [],
    };
  }

  // Evaluate each candidate; drop ones with no station defaults available.
  const evaluations: CandidateEvaluation[] = [];
  for (const s of input.candidateStations) {
    const defaults = input.stationDefaults[s];
    if (!defaults) continue;
    evaluations.push(evaluate(s, defaults, input));
  }

  if (evaluations.length === 0) {
    return {
      station: input.candidateStations[0],
      rationale: `No defaults loaded for any candidate; using first declared (${input.candidateStations[0]}).`,
      evaluations: [],
    };
  }

  // Stable sort: by total minutes, then by candidate-input order on ties
  // (preserves "primary preferred when equal" semantics).
  const indexOf = new Map<Station, number>();
  input.candidateStations.forEach((s, i) => indexOf.set(s, i));
  evaluations.sort((a, b) => {
    if (a.totalMinutes !== b.totalMinutes) return a.totalMinutes - b.totalMinutes;
    return (indexOf.get(a.station) ?? 0) - (indexOf.get(b.station) ?? 0);
  });

  const best = evaluations[0];
  const rationale = formatRationale(best, evaluations, input);

  return { station: best.station, rationale, evaluations };
}

// ─── Internals ───────────────────────────────────────────────

function evaluate(
  station: Station,
  defaults: StationDefaults,
  input: RoutingInput,
): CandidateEvaluation {
  const dailyOutput = Math.max(1, defaults.unitsPerHour * defaults.hoursPerDay);
  const batches = Math.max(
    1,
    Math.ceil(input.totalHorizonDemand / dailyOutput),
  );
  const productionMinutes =
    defaults.unitsPerHour > 0
      ? (input.totalHorizonDemand / defaults.unitsPerHour) * 60
      : 0;

  const matrixRow = input.changeoverMatrix[station];
  const perBatchChangeover =
    input.extendedFamily === null
      ? matrixRow.fullClean // pessimistic: no family to cluster with
      : (matrixRow.familySameSize + matrixRow.extendedFamily) / 2;
  const changeoverMinutes = batches * perBatchChangeover;

  return {
    station,
    productionMinutes,
    changeoverMinutes,
    totalMinutes: productionMinutes + changeoverMinutes,
    estimatedBatches: batches,
  };
}

function formatRationale(
  best: CandidateEvaluation,
  all: CandidateEvaluation[],
  _input: RoutingInput,
): string {
  if (all.length === 1) {
    return `${best.station} is the only candidate (~${Math.round(best.totalMinutes)} min total over ${best.estimatedBatches} batch${best.estimatedBatches === 1 ? '' : 'es'}).`;
  }
  const next = all[1];
  const savedMin = Math.round(next.totalMinutes - best.totalMinutes);
  // Pick the reason that explains the WIN by looking at which dimension
  // dominated — production-time gap vs changeover-time gap. (The earlier
  // version keyed off `extendedFamily === null` which gave misleading
  // "unmapped penalises high-changeover" text even when the
  // high-changeover station won on throughput.)
  const prodGap = next.productionMinutes - best.productionMinutes;
  const changeGap = next.changeoverMinutes - best.changeoverMinutes;
  let reason: string;
  if (prodGap > 0 && changeGap >= 0) {
    reason = 'wins on both throughput and changeover cost';
  } else if (prodGap > 0 && changeGap < 0) {
    reason = `higher throughput (saves ${Math.round(prodGap)} prod min) outweighs ${Math.round(-changeGap)} extra changeover min`;
  } else if (prodGap <= 0 && changeGap > 0) {
    reason = `lower changeover cost (saves ${Math.round(changeGap)} min) outweighs ${Math.round(-prodGap)} extra prod min`;
  } else {
    reason = 'tie on both dimensions; picked by candidate-input order';
  }
  return `${best.station}: ~${Math.round(best.totalMinutes)} min total, ${savedMin} min cheaper than ${next.station} (${reason}).`;
}
