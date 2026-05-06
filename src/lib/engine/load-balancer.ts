/**
 * Load balancer — Phase 4c.2.
 *
 * Refines the station-router's per-product decisions by considering
 * cross-product station load. The router (Phase 4c.1) is per-product
 * independent, so when many products independently pick Bottlo because
 * of its 2× throughput, Bottlo can end up over-subscribed while
 * elephant/dust sit idle.
 *
 * Algorithm (single-pass, deterministic, pure)
 * ────────────────────────────────────────────
 * 1. Compute total horizon minutes the per-product routing requires per
 *    station (production minutes only — changeover is small enough at
 *    this granularity to ignore).
 * 2. Compute each station's horizon capacity in minutes
 *    (hoursPerDay × 60 × workingDaysPerWeek × horizonWeeks).
 * 3. For each station that exceeds `threshold × capacity`, find products
 *    that:
 *      - Are currently routed there
 *      - Have an alternate station whose extra-load (for THIS product
 *        only) wouldn't push the alternate over `threshold`
 *      - Among those candidates, move the products with the SMALLEST
 *        cost penalty for switching (totalMinutes_alternate −
 *        totalMinutes_current). This minimises planning regret.
 * 4. Stop redistributing the station once it's at or below threshold.
 *
 * The router's existing `evaluations` carry per-station total-minute
 * estimates per product, so we reuse them rather than recomputing.
 *
 * Single-pass — no iteration. If after one pass the alternate also goes
 * over, we surface that as a warning and leave the redistribution as
 * "best-effort." Phase 4c.3 could iterate, but in practice the alternate
 * relationship in this data is thin enough that a single pass is fine.
 */

import type { Station } from '@/lib/planning/engine-io';
import type { StationDefaults } from '@/lib/planning/capacity-data';
import type { CandidateEvaluation } from './station-router';

// ─── Public types ────────────────────────────────────────────

export interface ProductRouting {
  productCode: string;
  /** The station the per-product router originally chose. */
  currentStation: Station;
  /**
   * Router's evaluations, sorted ascending by totalMinutes. evaluations[0]
   * is the current pick; evaluations[1..] are alternates with their
   * estimated cost on each.
   */
  evaluations: CandidateEvaluation[];
}

export interface LoadBalanceInput {
  routings: ProductRouting[];
  stationDefaults: Partial<Record<Station, StationDefaults>>;
  /** Number of weeks in the planning horizon (used to size capacity). */
  horizonWeeks: number;
  /**
   * Working days per week. Spreadsheet assumes 5 (Mon–Fri); separable
   * for tests / future calendar support.
   */
  workingDaysPerWeek?: number;
  /**
   * Utilisation cap above which a station is considered over-subscribed.
   * Default 0.85 — leaves 15% slack for changeovers + variability.
   */
  threshold?: number;
}

export interface RedistributionRecord {
  productCode: string;
  fromStation: Station;
  toStation: Station;
  costPenaltyMinutes: number;
  reason: string;
}

export interface LoadBalanceOutput {
  /** Updated routings — same shape, with currentStation possibly changed. */
  routings: ProductRouting[];
  /** Diagnostic records of every move made. */
  redistributions: RedistributionRecord[];
  /** Per-station {requestedMinutes, capacityMinutes, utilisation} after redistribution. */
  stationLoad: Record<string, { requestedMinutes: number; capacityMinutes: number; utilisation: number }>;
}

// ─── Defaults ────────────────────────────────────────────────

const DEFAULT_THRESHOLD = 0.85;
const DEFAULT_WORKING_DAYS_PER_WEEK = 5;

// ─── Public API ──────────────────────────────────────────────

export function balanceStationLoads(input: LoadBalanceInput): LoadBalanceOutput {
  const threshold = input.threshold ?? DEFAULT_THRESHOLD;
  const wdays = input.workingDaysPerWeek ?? DEFAULT_WORKING_DAYS_PER_WEEK;
  const horizonMinutesByStation: Record<string, number> = {};
  for (const [s, d] of Object.entries(input.stationDefaults)) {
    if (d) horizonMinutesByStation[s] = d.hoursPerDay * 60 * wdays * input.horizonWeeks;
  }

  // Working copy of routings — will be mutated as we redistribute.
  const working: ProductRouting[] = input.routings.map((r) => ({ ...r }));

  // Per-station total minutes requested.
  const requestedByStation = sumByStation(working);
  const redistributions: RedistributionRecord[] = [];

  // Iterate stations in deterministic order so the output is reproducible.
  const stations = Object.keys(horizonMinutesByStation).sort() as Station[];

  for (const station of stations) {
    const capacity = horizonMinutesByStation[station] ?? 0;
    if (capacity <= 0) continue;
    let utilisation = (requestedByStation[station] ?? 0) / capacity;
    if (utilisation <= threshold) continue;

    // Candidates: products currently routed here that have an alternate
    // (i.e. evaluations.length > 1). Sort by smallest cost penalty for
    // switching — products that gain the least from staying.
    const candidates = working
      .filter((r) => r.currentStation === station && r.evaluations.length > 1)
      .map((r) => {
        const current = r.evaluations.find((e) => e.station === station);
        const next = r.evaluations.find((e) => e.station !== station);
        if (!current || !next) return null;
        return {
          routing: r,
          fromMinutes: current.productionMinutes + current.changeoverMinutes,
          toStation: next.station,
          toMinutes: next.productionMinutes + next.changeoverMinutes,
          penalty: next.totalMinutes - current.totalMinutes,
        };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null)
      .sort((a, b) => a.penalty - b.penalty);

    for (const cand of candidates) {
      if (utilisation <= threshold) break;

      // Will moving push the destination over threshold?
      const destCapacity = horizonMinutesByStation[cand.toStation] ?? 0;
      const destCurrent = requestedByStation[cand.toStation] ?? 0;
      const destAfter = destCurrent + cand.toMinutes;
      if (destCapacity > 0 && destAfter / destCapacity > threshold) {
        // Skip — moving here would just create a new over-subscription.
        continue;
      }

      // Apply the move.
      cand.routing.currentStation = cand.toStation;
      requestedByStation[station] = (requestedByStation[station] ?? 0) - cand.fromMinutes;
      requestedByStation[cand.toStation] = destAfter;
      utilisation = requestedByStation[station] / capacity;

      redistributions.push({
        productCode: cand.routing.productCode,
        fromStation: station,
        toStation: cand.toStation,
        costPenaltyMinutes: cand.penalty,
        reason: `${station} over-subscribed (>${Math.round(threshold * 100)}% horizon utilisation); ${cand.toStation} has spare capacity at penalty +${Math.round(cand.penalty)} min.`,
      });
    }
  }

  // Final station load report.
  const stationLoad: LoadBalanceOutput['stationLoad'] = {};
  for (const station of stations) {
    const cap = horizonMinutesByStation[station] ?? 0;
    const req = requestedByStation[station] ?? 0;
    stationLoad[station] = {
      requestedMinutes: req,
      capacityMinutes: cap,
      utilisation: cap > 0 ? req / cap : 0,
    };
  }

  return { routings: working, redistributions, stationLoad };
}

// ─── Internals ───────────────────────────────────────────────

function sumByStation(routings: ProductRouting[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of routings) {
    const ev = r.evaluations.find((e) => e.station === r.currentStation);
    if (!ev) continue;
    const min = ev.productionMinutes + ev.changeoverMinutes;
    out[r.currentStation] = (out[r.currentStation] ?? 0) + min;
  }
  return out;
}
