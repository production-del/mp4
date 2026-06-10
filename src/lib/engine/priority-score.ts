/**
 * Assembly priority score — the unified ranking key for contention points.
 *
 * Today the engine ranks work at three different contention points with three
 * different ad-hoc keys (`supply-cap` profit-per-unit, `day-assigner` profit-
 * per-minute, the overdue walk-forward profit-per-minute). This module gives
 * them ONE explainable score so a scarce resource is always rationed the same,
 * principled way — and the breakdown says *why* an assembly won or lost.
 *
 * Design (see docs/audit + the plan):
 *  - **Priority** = a weighted blend of `profit` (the dominant economic term),
 *    `urgency` (due-date critical ratio), `stockout` (FG SOH risk) and a manual
 *    flag. Each priority factor is OPTIONAL and contributes 0 when absent, so
 *    the score degrades gracefully wherever a signal isn't available.
 *  - **Ability** = a 0..1 makeability multiplier from feasibility (green/amber/
 *    red) × capacity headroom. It GATES the score (`score = priority × ability`)
 *    so an unmakeable assembly can't win a resource no matter how profitable.
 *  - **Behaviour-compatible by default.** `DEFAULT_WEIGHTS` is profit-only and
 *    `DEFAULT_ABILITY_FLOORS` leaves the gate off (amber=red=1 → ability≡1), so
 *    `score` collapses to exactly the profit magnitude the caller passes —
 *    reproducing today's ordering at every call site. Richer factors and the
 *    ability gate are an explicit operator opt-in (weights / floors).
 *
 * The CALLER chooses the *profit basis* appropriate to the binding resource —
 * raw `profitPerItem` (per-unit), `profitPerItem / qtyPerUnit` (profit per kg of
 * a scarce intermediate), or `profitPerItem × qty / minutes` (per station-
 * minute). This keeps the Theory-of-Constraints "value per unit of the binding
 * resource" choice where the binding resource is actually known.
 *
 * Pure: no I/O, no `Date.now()`, no mutation of inputs.
 */

import type { FeasibilityState } from '@/lib/planning/engine-io';
import { fromLocalISODate } from '@/lib/planning/working-day';

// ─── Weights & ability config ────────────────────────────────

export interface ScoreWeights {
  profit: number;
  urgency: number;
  stockout: number;
  manual: number;
}

/**
 * Profit-only. With these weights `priority === profitComponent`, so the score
 * reproduces every call site's current ranking key. The safe default.
 */
export const DEFAULT_WEIGHTS: ScoreWeights = {
  profit: 1,
  urgency: 0,
  stockout: 0,
  manual: 0,
};

export interface AbilityFloors {
  /** Multiplier when feasibility is `amber` (makeable, needs a transfer). */
  amber: number;
  /** Multiplier when feasibility is `red` (needs a PO). Floor > 0 so a red
   *  item that is the only option can still be scheduled. */
  red: number;
}

/** Gate OFF — ability is always 1, reproducing today's behaviour. */
export const DEFAULT_ABILITY_FLOORS: AbilityFloors = { amber: 1, red: 1 };

/** Sensible values once the operator turns the gate on. */
export const RECOMMENDED_ABILITY_FLOORS: AbilityFloors = { amber: 0.6, red: 0.2 };

// ─── Input / output ──────────────────────────────────────────

export type DominantFactor = 'profit' | 'urgency' | 'stockout' | 'manual';
export type AbilityBinding = 'feasibility' | 'capacity' | null;

export interface ScoreAssemblyInput {
  /**
   * The profit magnitude appropriate to the binding resource, chosen by the
   * caller: per-unit (`profitPerItem`), per-kg-of-intermediate
   * (`profitPerItem / qtyPerUnit`), or per-minute (`profitPerItem × qty /
   * minutes`). `null`/`undefined`/non-finite → 0 (today's "null profit ranks
   * last").
   */
  profit: number | null | undefined;

  // ── Priority signals — all optional; absent → 0 (neutral) ──
  /** Pre-normalised 0..1. If omitted, derived from `dueDate`/`today`. */
  urgency?: number;
  dueDate?: string;
  today?: string;
  /** Days-from-now at which urgency reaches 0 (linear). Default 14. */
  urgencyHorizonDays?: number;

  /** Pre-normalised 0..1. If omitted, derived from `availableStock`/`coverDays`. */
  stockout?: number;
  availableStock?: number;
  coverDays?: number;
  /** Days of cover at which stockout risk reaches 0 (linear). Default 14. */
  targetCoverDays?: number;

  manual?: boolean;

  // ── Ability signals — absent → 1 (neutral) ──
  feasibility?: FeasibilityState;
  /** 0..1 share of the needed resource time that is free. */
  capacityFit?: number;

  // ── Config ──
  weights?: Partial<ScoreWeights>;
  abilityFloors?: Partial<AbilityFloors>;
  /**
   * Scales the 0..1 priority factors onto the profit term's magnitude so the
   * weights are interpretable. Default 1. Inert under `DEFAULT_WEIGHTS` (the
   * non-profit weights are 0).
   */
  profitScale?: number;
}

export interface ScoreFactor {
  /** The 0..1 (or raw profit) input before weighting. */
  raw: number;
  /** The contribution actually summed into `priority`. */
  weighted: number;
}

export interface ScoreBreakdown {
  /** Final composite, higher = higher priority. `priority × ability`. */
  score: number;
  /** Pre-gate priority magnitude. */
  priority: number;
  /** 0..1 makeability gate. */
  ability: number;
  factors: {
    profit: ScoreFactor;
    urgency: ScoreFactor;
    stockout: ScoreFactor;
    manual: ScoreFactor;
  };
  abilityFactors: {
    feasibility: number;
    capacity: number;
  };
  /** Which weighted factor contributed most — the explainability headline. */
  dominantFactor: DominantFactor;
  /** What pulled ability below 1 (if anything). */
  abilityBinding: AbilityBinding;
}

// ─── Pure helpers (the normalisation logic lives in ONE place) ──

const clampUnit = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Due-date critical ratio → 0..1 urgency. Overdue/today = 1; `horizonDays`
 * away or further = 0; linear between.
 */
export function criticalRatioUrgency(
  dueDate: string,
  today: string,
  horizonDays = 14,
): number {
  const due = fromLocalISODate(dueDate).getTime();
  const now = fromLocalISODate(today).getTime();
  if (!Number.isFinite(due) || !Number.isFinite(now) || horizonDays <= 0) {
    return 0;
  }
  const days = (due - now) / 86_400_000;
  if (days <= 0) return 1;
  return clampUnit(1 - days / horizonDays);
}

/**
 * FG stockout risk → 0..1. Backorder (`availableStock < 0`) = 1; otherwise
 * scaled off days-of-cover toward `targetCoverDays`.
 */
export function stockoutRisk(
  availableStock?: number,
  coverDays?: number,
  targetCoverDays = 14,
): number {
  if (availableStock != null && availableStock < 0) return 1;
  if (coverDays != null && targetCoverDays > 0) {
    return clampUnit(1 - coverDays / targetCoverDays);
  }
  if (availableStock != null && availableStock <= 0) return 1;
  return 0;
}

// ─── The score ───────────────────────────────────────────────

/**
 * Compute the unified priority score for one assembly/chip, with an
 * explainable breakdown.
 *
 * Under `DEFAULT_WEIGHTS` + `DEFAULT_ABILITY_FLOORS` this returns
 * `score === profit` (the caller's chosen profit basis), reproducing today's
 * ranking exactly.
 */
export function scoreAssembly(input: ScoreAssemblyInput): ScoreBreakdown {
  const w: ScoreWeights = { ...DEFAULT_WEIGHTS, ...input.weights };
  const floors: AbilityFloors = { ...DEFAULT_ABILITY_FLOORS, ...input.abilityFloors };
  const scale = input.profitScale ?? 1;

  // Profit — the only term live at every call site.
  const profitRaw =
    typeof input.profit === 'number' && Number.isFinite(input.profit)
      ? input.profit
      : 0;

  // Urgency — explicit value wins; else derive from dates; else 0.
  let urgencyRaw = 0;
  if (input.urgency != null) {
    urgencyRaw = clampUnit(input.urgency);
  } else if (input.dueDate != null && input.today != null) {
    urgencyRaw = criticalRatioUrgency(
      input.dueDate,
      input.today,
      input.urgencyHorizonDays,
    );
  }

  // Stockout — explicit value wins; else derive; else 0.
  let stockoutRaw = 0;
  if (input.stockout != null) {
    stockoutRaw = clampUnit(input.stockout);
  } else if (input.availableStock != null || input.coverDays != null) {
    stockoutRaw = stockoutRisk(
      input.availableStock,
      input.coverDays,
      input.targetCoverDays,
    );
  }

  const manualRaw = input.manual ? 1 : 0;

  const profit: ScoreFactor = { raw: profitRaw, weighted: w.profit * profitRaw };
  const urgency: ScoreFactor = {
    raw: urgencyRaw,
    weighted: w.urgency * urgencyRaw * scale,
  };
  const stockout: ScoreFactor = {
    raw: stockoutRaw,
    weighted: w.stockout * stockoutRaw * scale,
  };
  const manual: ScoreFactor = {
    raw: manualRaw,
    weighted: w.manual * manualRaw * scale,
  };

  const priority =
    profit.weighted + urgency.weighted + stockout.weighted + manual.weighted;

  // Ability gate.
  const feasibility =
    input.feasibility == null
      ? 1
      : input.feasibility === 'green'
        ? 1
        : input.feasibility === 'amber'
          ? floors.amber
          : floors.red;
  const capacity = input.capacityFit == null ? 1 : clampUnit(input.capacityFit);
  const ability = feasibility * capacity;

  const score = priority * ability;

  // Explainability: which weighted factor dominated.
  const ranked: Array<[DominantFactor, number]> = [
    ['profit', profit.weighted],
    ['urgency', urgency.weighted],
    ['stockout', stockout.weighted],
    ['manual', manual.weighted],
  ];
  ranked.sort((a, b) => b[1] - a[1]);
  const dominantFactor = ranked[0][0];

  // What bound ability (the smaller, more-limiting factor).
  let abilityBinding: AbilityBinding = null;
  if (ability < 1) {
    abilityBinding = feasibility <= capacity ? 'feasibility' : 'capacity';
  }

  return {
    score,
    priority,
    ability,
    factors: { profit, urgency, stockout, manual },
    abilityFactors: { feasibility, capacity },
    dominantFactor,
    abilityBinding,
  };
}
