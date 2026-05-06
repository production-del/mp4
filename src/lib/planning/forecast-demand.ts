/**
 * Forward demand forecaster — Phase 1 of the 3-month planner.
 *
 * Given the daily-refreshed Unleashed sales rate (a `Record<productCode,
 * monthlyDemand>` from `data/demand.csv` via `/api/demand-data`) plus any
 * dated `Demand` events from the packaging planner or Unleashed kitchen
 * assemblies, produce a `WeeklyDemand[]` covering the configured horizon.
 *
 * This is the input to Phase 3's batch optimiser. It is deliberately pure:
 * no I/O, no `Date.now()`, no localStorage. The horizon's `startWeek` is
 * passed explicitly so the function is fully deterministic from its inputs.
 *
 * Blending model
 * ──────────────
 * - **Rate-derived demand**: monthlyRate × 12 / 52 per week. Distributes the
 *   monthly rate evenly across all weeks of the horizon. Approximates the
 *   "steady drain" assumption already used by `purchasing-projection.ts`.
 * - **Event-derived demand**: each `Demand` event lands in the week containing
 *   its `needByDate`. Events outside the horizon window are dropped.
 * - **Sum**: a week's total quantity = rate contribution + sum of event
 *   contributions for that week and product.
 * - **Sources**: records which input categories fed each row. A row that has
 *   only rate contribution is `['rate']`; rate + an event is `['rate','event']`;
 *   a row with zero quantity has `[]` (no contributions).
 *
 * Output shape
 * ────────────
 * One row per (productCode × week) for every product that contributes either
 * a rate or an event, across the entire horizon. Products with zero
 * contribution are omitted (avoids inflating the output for the long tail of
 * SKUs that don't sell in this window).
 */

import type { Demand } from './demand';
import type { PlanningHorizon, WeeklyDemand } from './engine-io';
import { fromLocalISODate, toLocalISODate } from './working-day';

// ─── Constants ───────────────────────────────────────────────

/**
 * Conversion from monthly rate to weekly rate.
 *
 * Using 12/52 (≈0.2308) treats a year as exactly 12 months and 52 weeks. This
 * matches the assumption baked into rolling-window analytics: monthly-AVE
 * over a 12-month window divided by ~4.33 weeks per month gives a steady
 * weekly rate. The alternative (rate × 7 / 30.44) yields effectively the same
 * number to three decimal places; we prefer the integer-month form for clarity.
 */
const MONTHS_PER_WEEK = 12 / 52;

// ─── Helpers ─────────────────────────────────────────────────

/**
 * Local-time Monday for any date. Mirrors the (private) helper inside
 * `working-day.ts`. Replicated here so we don't widen that module's surface
 * just for one consumer; if a third caller needs it we'll promote.
 *
 * Weekday inputs (Mon-Fri) → Monday of the same calendar week.
 * Weekend inputs (Sat/Sun) → the **upcoming** Monday — same convention as
 * `getMondayOfWeek` in working-day.ts.
 */
function mondayOf(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const dow = d.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const diff = dow === 0 ? 1 : dow === 6 ? 2 : 1 - dow;
  d.setDate(d.getDate() + diff);
  return d;
}

/** Generate the ISO Monday strings for every week in the horizon. */
function horizonWeekStarts(horizon: PlanningHorizon): string[] {
  if (horizon.weeks <= 0) return [];
  const start = fromLocalISODate(horizon.startWeek);
  const out: string[] = [];
  for (let i = 0; i < horizon.weeks; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i * 7);
    out.push(toLocalISODate(d));
  }
  return out;
}

/**
 * Given a dated `needByDate`, return the ISO Monday of the horizon week that
 * contains it — or null if the date falls outside the horizon. The horizon
 * runs `[startWeek, startWeek + weeks*7)`.
 */
function bucketEventWeek(
  needByDate: string,
  horizon: PlanningHorizon,
  weekStarts: string[],
): string | null {
  if (weekStarts.length === 0) return null;
  const eventMonday = mondayOf(fromLocalISODate(needByDate));
  const eventISO = toLocalISODate(eventMonday);
  // Linear scan is fine — horizon is bounded (≤52 weeks even at 1y).
  return weekStarts.includes(eventISO) ? eventISO : null;
}

// ─── Public API ──────────────────────────────────────────────

export interface ForecastInput {
  /** Monthly demand rate per product, from `/api/demand-data`. */
  monthlyRates: Record<string, number>;
  /** Dated demand events from packaging plans / Unleashed assemblies. */
  events: Demand[];
  /** Horizon configuration. `startWeek` MUST be a Monday in `YYYY-MM-DD` form. */
  horizon: PlanningHorizon;
}

/**
 * Produce `WeeklyDemand` rows for every product with non-zero contribution
 * across the horizon. See module docstring for the blending model.
 *
 * Throws if `horizon.startWeek` is not a Monday — better to fail fast than
 * silently produce off-by-one buckets.
 */
export function forecastWeeklyDemand(input: ForecastInput): WeeklyDemand[] {
  const { monthlyRates, events, horizon } = input;

  // Validate startWeek is actually a Monday. Off-by-one bucket bugs are
  // the canonical kind of bug this project exists to avoid.
  const startDate = fromLocalISODate(horizon.startWeek);
  if (startDate.getDay() !== 1) {
    throw new Error(
      `PlanningHorizon.startWeek must be a Monday (YYYY-MM-DD); got ${horizon.startWeek} (day-of-week ${startDate.getDay()})`,
    );
  }
  if (horizon.weeks <= 0) return [];

  const weekStarts = horizonWeekStarts(horizon);

  // Per (productCode, weekStart) accumulator: { rateQty, eventQty }.
  // Using nested Map keeps the algorithm O(P*W + E).
  type Bucket = { rateQty: number; eventQty: number };
  const buckets = new Map<string, Map<string, Bucket>>();

  function ensureBucket(productCode: string, weekStart: string): Bucket {
    let perProduct = buckets.get(productCode);
    if (!perProduct) {
      perProduct = new Map();
      buckets.set(productCode, perProduct);
    }
    let bucket = perProduct.get(weekStart);
    if (!bucket) {
      bucket = { rateQty: 0, eventQty: 0 };
      perProduct.set(weekStart, bucket);
    }
    return bucket;
  }

  // Spread monthly rate evenly across the horizon for every product with a
  // positive rate. Zero/negative rates are skipped — they contribute nothing
  // and shouldn't allocate empty rows.
  for (const [productCode, monthly] of Object.entries(monthlyRates)) {
    if (!(monthly > 0)) continue;
    const weekly = monthly * MONTHS_PER_WEEK;
    for (const weekStart of weekStarts) {
      ensureBucket(productCode, weekStart).rateQty += weekly;
    }
  }

  // Bucket dated events. Out-of-horizon events are dropped — Phase 3's
  // optimiser only sees what's in the planning window.
  for (const ev of events) {
    if (!(ev.quantityNeeded > 0)) continue;
    const weekStart = bucketEventWeek(ev.needByDate, horizon, weekStarts);
    if (!weekStart) continue;
    ensureBucket(ev.productCode, weekStart).eventQty += ev.quantityNeeded;
  }

  // Flatten to WeeklyDemand[]. Iterate in deterministic order: products
  // alphabetically, weeks chronologically. Tests rely on this ordering.
  const out: WeeklyDemand[] = [];
  const productCodes = Array.from(buckets.keys()).sort();
  for (const productCode of productCodes) {
    const perProduct = buckets.get(productCode)!;
    for (const weekStart of weekStarts) {
      const bucket = perProduct.get(weekStart);
      if (!bucket) continue;
      const quantity = bucket.rateQty + bucket.eventQty;
      if (quantity <= 0) continue;
      const sources: Array<'rate' | 'event'> = [];
      if (bucket.rateQty > 0) sources.push('rate');
      if (bucket.eventQty > 0) sources.push('event');
      out.push({ productCode, weekStart, quantity, sources });
    }
  }
  return out;
}

/**
 * Convenience: build a `PlanningHorizon` anchored on the upcoming Monday
 * (matching the `mondayOf` weekend-rounding rule). Callers that want a
 * specific anchor should construct the object directly.
 */
export function defaultHorizon(weeks = 12, today: Date = new Date()): PlanningHorizon {
  return {
    startWeek: toLocalISODate(mondayOf(today)),
    weeks,
  };
}
