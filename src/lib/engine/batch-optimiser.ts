/**
 * Single-product batch optimiser — Phase 3c of the 3-month planner.
 *
 * Decides batch dates and sizes for ONE product across the planning horizon
 * to minimise total cost subject to demand-coverage, shelf-life, and
 * storage constraints. Uses dynamic programming over a weekly grid with
 * discretised inventory states.
 *
 * Why single-product first
 * ────────────────────────
 * Multi-product optimisation couples products through shared-station
 * changeover costs (the cost of running Chaga depends on what Bottlo was
 * doing immediately before). That coupling demands an orchestration layer
 * — Phase 3d — that this module is designed to be wrapped by. Solving a
 * single product cleanly first gives us a tested unit of optimisation that
 * the orchestrator can call iteratively per product, and a known-good API
 * shape to build on.
 *
 * Cost model
 * ──────────
 * Total cost is a sum of:
 *   - `setupCost × num_batches`      — the lever the user tunes per product
 *                                       to control "fewer, longer-spaced runs"
 *                                       behaviour. Phase 3d will derive this
 *                                       from `costToSwitch` given the
 *                                       station's prior occupant.
 *   - storage overflow penalty       — large; effectively a hard constraint
 *                                       except when no feasible plan exists.
 *   - linear holding cost            — tiny per-unit-per-week charge on
 *      (Phase 4l.10)                   carried inventory. Way smaller than
 *                                       setupCost so it never adds a batch,
 *                                       but discriminates between otherwise-
 *                                       equal plans: a batch placed earlier
 *                                       than necessary pays more carry-time
 *                                       than one placed later. The DP thus
 *                                       defers production while initial SOH
 *                                       covers demand, fixing the "MFWALNUSM
 *                                       has 42d SOH but is still planned for
 *                                       18/5" class of bug.
 *
 * Hard constraints (rejected branches in the DP):
 *   - Demand by week must be covered: post-demand inventory ≥ 0.
 *   - Inventory never exceeds shelf-life cap (proxy: max weeks of forward
 *     demand × peak-week demand). Approximate but conservative.
 *   - Inventory never exceeds per-week storage cap (decision #4 says daily,
 *     but for single-product flow we operate weekly; daily resource caps
 *     belong to the multi-product orchestrator).
 *   - Batch size ∈ {0} ∪ [minBatchSize, maxBatchSize], discretised by `step`.
 *
 * Algorithm
 * ─────────
 * Forward DP over weeks 0..W-1. State `(week, inventoryStep)`. Transition:
 * pick a run size from the allowed set; update inventory; pay cost. Track
 * back-pointers to reconstruct the chosen plan.
 *
 * Complexity: O(W × I × B) where W = horizon weeks, I = inventory steps,
 * B = batch-size choices. Trivial for W ≤ 26, I ≤ 1000, B ≤ 100.
 */

// ─── Types ───────────────────────────────────────────────────

export interface SingleProductOptimiserInput {
  productCode: string;
  /**
   * One row per week of the horizon, in chronological order. `quantity` is
   * the expected demand for that week. Weeks with zero demand are valid.
   */
  weeklyDemand: ReadonlyArray<{ weekStart: string; quantity: number }>;
  /** Inventory at the start of week 0, before any production or demand. */
  initialInventory: number;
  /** Maximum days a unit may sit in inventory. Determines effective inventory cap. */
  shelfLifeDays: number;
  /** Smallest batch size the equipment can produce (inclusive). */
  minBatchSize: number;
  /** Largest batch size the equipment can produce (inclusive). */
  maxBatchSize: number;
  /** Per-batch fixed cost; raise to push the optimiser toward fewer runs. */
  setupCost: number;
  /**
   * Per-week storage cap. Index 0 = first horizon week. Defaults to no cap
   * (Number.POSITIVE_INFINITY). Caller may pass a partial array; missing
   * indices read as no cap.
   */
  storageCapByWeek?: ReadonlyArray<number>;
  /**
   * Per-unit-per-week penalty for inventory above the storage cap. Default
   * `1e9` makes the cap effectively hard. Lower values let the optimiser
   * trade a small overflow against fewer batches when the user wants that.
   */
  storageOverflowPenalty?: number;
  /**
   * Discretisation granularity for inventory and batch sizes. Smaller =
   * finer-grained but bigger state space. Default 10.
   */
  step?: number;
  /**
   * Phase 4l.10: per-unit-per-week holding cost on carried inventory.
   * Default `1e-3` — tiny enough that it never adds a batch (always
   * dwarfed by `setupCost`) but enough to discriminate between feasible
   * placements, so the DP picks the latest workable week and stops
   * producing through deep starting SOH. Set 0 to disable.
   */
  holdingCostPerUnitPerWeek?: number;
  /**
   * Phase 4l.12: target SOH floor in DAYS of forward demand. The DP pays
   * a soft `floorShortfallPenalty` per unit-per-week of post-demand
   * inventory below this floor. Default 10 — the planner tries to land
   * end-of-week with at least 10 days of upcoming demand on the shelf.
   * Set 0 to disable the floor entirely.
   */
  sohFloorDays?: number;
  /**
   * Phase 4l.12: per-unit-per-week penalty for inventory below the
   * `sohFloorDays` floor. Default 1.0 — meaningfully larger than
   * `holdingCostPerUnitPerWeek` (1e-3) so it actually pulls production
   * forward, but small relative to `setupCost` (typically 100–1000) so
   * it doesn't force a batch when there's no feasible week to place it.
   * Soft: a near-empty week still validates, just at higher cost.
   */
  floorShortfallPenalty?: number;
}

export interface ScheduledBatch {
  productCode: string;
  /** ISO Monday of the week the batch is produced in. */
  weekStart: string;
  quantity: number;
}

export interface UnmetDemand {
  weekStart: string;
  quantity: number;
}

export interface SingleProductOptimiserOutput {
  batches: ScheduledBatch[];
  /** Human-readable rationale lines for the planner UI. */
  rationale: string[];
  /** Days between consecutive batches. Empty when ≤1 batch. */
  interRunDays: number[];
  /**
   * Demand the optimiser couldn't cover. Empty when feasible. Populated when
   * total demand exceeds total capacity over the horizon.
   */
  unmetDemand: UnmetDemand[];
  /** Total cost-units of the chosen plan. NaN if infeasible. */
  totalCost: number;
  /** Whether a feasible plan was found at all. */
  feasible: boolean;
}

// ─── Public API ──────────────────────────────────────────────

const INF = Number.POSITIVE_INFINITY;
const DEFAULT_STEP = 10;
const DEFAULT_OVERFLOW_PENALTY = 1e9;
const DEFAULT_HOLDING_COST_PER_UNIT_PER_WEEK = 1e-3;
const DEFAULT_SOH_FLOOR_DAYS = 10;
const DEFAULT_FLOOR_SHORTFALL_PENALTY = 1.0;

export function optimiseSingleProduct(
  input: SingleProductOptimiserInput,
): SingleProductOptimiserOutput {
  // ─── Validate ─────────────────────────────────────────────
  if (input.shelfLifeDays <= 0) {
    throw new Error(`shelfLifeDays must be positive; got ${input.shelfLifeDays}`);
  }
  if (input.minBatchSize > input.maxBatchSize) {
    throw new Error(
      `minBatchSize (${input.minBatchSize}) must be ≤ maxBatchSize (${input.maxBatchSize})`,
    );
  }
  if (input.minBatchSize <= 0) {
    throw new Error(`minBatchSize must be positive; got ${input.minBatchSize}`);
  }

  const W = input.weeklyDemand.length;
  const step = input.step ?? DEFAULT_STEP;
  const overflowPenalty = input.storageOverflowPenalty ?? DEFAULT_OVERFLOW_PENALTY;
  const holdingCostRate =
    input.holdingCostPerUnitPerWeek ?? DEFAULT_HOLDING_COST_PER_UNIT_PER_WEEK;
  const sohFloorDays = input.sohFloorDays ?? DEFAULT_SOH_FLOOR_DAYS;
  const floorShortfallPenalty =
    input.floorShortfallPenalty ?? DEFAULT_FLOOR_SHORTFALL_PENALTY;

  // Empty horizon: nothing to plan.
  if (W === 0) {
    return {
      batches: [],
      rationale: ['Empty horizon: no demand provided.'],
      interRunDays: [],
      unmetDemand: [],
      totalCost: 0,
      feasible: true,
    };
  }

  // ─── Compute inventory cap from shelf-life ───────────────
  // A unit produced this week can be held at most `shelfLifeWeeks` weeks
  // before it spoils. Peak inventory at week w must not exceed the demand
  // consumable in the window [w, w+shelfLifeWeeks). We pre-compute that
  // window sum per starting week so the DP can apply a tight per-state
  // cap; the global `shelfLifeInventoryCap` is the max for sizing arrays.
  const shelfLifeWeeks = Math.max(1, Math.floor(input.shelfLifeDays / 7));
  const forwardWindowDemand: number[] = new Array(W).fill(0);
  for (let w = 0; w < W; w++) {
    let windowSum = 0;
    for (let k = w; k < Math.min(W, w + shelfLifeWeeks); k++) {
      windowSum += input.weeklyDemand[k].quantity;
    }
    forwardWindowDemand[w] = windowSum;
  }
  const shelfLifeInventoryCap = forwardWindowDemand.reduce(
    (m, v) => (v > m ? v : m),
    0,
  );

  // When `initialInventory` exceeds the shelf-life-window cap, we'd otherwise
  // mark the product infeasible — the initial state can't pass the cap check.
  // But initial inventory is real: we already have it, the cap can't reduce
  // it. We allow inventory to remain ABOVE the cap as long as it's draining
  // monotonically (no production added on top). `naturalCarry[w]` = the
  // inventory level reachable purely by draining from week 0 with no
  // production — anything ≤ this is permissible at week w even if above
  // forwardWindowDemand[w].
  const cumulativeDemand: number[] = new Array(W + 1).fill(0);
  for (let w = 0; w < W; w++) {
    cumulativeDemand[w + 1] = cumulativeDemand[w] + input.weeklyDemand[w].quantity;
  }
  function naturalCarry(week: number): number {
    return Math.max(0, input.initialInventory - cumulativeDemand[week]);
  }
  // Phase 4l.10: when shelf life extends past the planning horizon, the
  // spoilage constraint doesn't bind within the window — we can hold a
  // batch's worth of inventory beyond the forward-demand-window without
  // anything going bad. Without this relaxation, low-demand products
  // with long shelf life (e.g. SDREDLOB3 with 540d shelf, 12-week horizon,
  // demand=11) become infeasible because the forward-window cap shrinks
  // to 0 by end of horizon while the DP needs to hold ≥minBatch units
  // (an indivisible batch larger than remaining demand).
  const shelfLifeBindsInHorizon = shelfLifeWeeks < W;
  const longShelfBuffer = shelfLifeBindsInHorizon ? 0 : input.maxBatchSize;
  function effectiveCapAt(week: number): number {
    const tight = Math.max(forwardWindowDemand[week] ?? 0, naturalCarry(week));
    return tight + longShelfBuffer;
  }
  const overallCap = Math.max(
    shelfLifeInventoryCap,
    input.initialInventory,
  ) + longShelfBuffer;

  // The hard storage cap is per-week from the input; the *modelled* cap is
  // shelf-life-bounded. Both apply: state must satisfy both.
  function storageCap(w: number): number {
    return input.storageCapByWeek?.[w] ?? INF;
  }

  // Phase 4l.12 — SOH floor target per week end. End-of-week-w post-demand
  // inventory should be ≥ `sohFloorDays` of forward demand, where forward
  // demand starts at week w+1. We approximate "10 days from start of week
  // w+1" as a full week + a partial week:
  //   floor = weeklyDemand[w+1] + (sohFloorDays - 7)/7 × weeklyDemand[w+2]
  // For the last horizon week we fall back to the same week's demand
  // (assume the tail is roughly flat). When sohFloorDays ≤ 0 the floor
  // is disabled entirely.
  const floorByWeekEnd: number[] = new Array(W).fill(0);
  if (sohFloorDays > 0) {
    const fullWeeks = Math.floor(sohFloorDays / 7);
    const partialDays = sohFloorDays - fullWeeks * 7;
    for (let w = 0; w < W; w++) {
      let sum = 0;
      // Whole-week chunks of forward demand.
      for (let k = 0; k < fullWeeks; k++) {
        const idx = Math.min(W - 1, w + 1 + k);
        sum += input.weeklyDemand[idx].quantity;
      }
      // Trailing partial week.
      if (partialDays > 0) {
        const idx = Math.min(W - 1, w + 1 + fullWeeks);
        sum += (partialDays / 7) * input.weeklyDemand[idx].quantity;
      }
      floorByWeekEnd[w] = sum;
    }
  }

  // ─── Build batch-size choice set ─────────────────────────
  // {0} ∪ {min, min+step, ..., max} (each rounded up to a step boundary).
  // Phase 4l.10: cap useful max at `totalDemand + minBatch` so the DP
  // doesn't waste cycles considering enormous batches that the cap check
  // will reject anyway. Without this cap, low-demand products with high
  // maxBatchSize generate ~1600 batch candidates per (week, state),
  // making the DP visibly slow.
  const totalDemand = cumulativeDemand[W];
  const usefulMaxBatch = Math.min(
    input.maxBatchSize,
    Math.max(input.minBatchSize, Math.ceil(totalDemand) + input.minBatchSize),
  );
  const batchSizes: number[] = [0];
  const firstSize = Math.ceil(input.minBatchSize / step) * step;
  for (let s = firstSize; s <= usefulMaxBatch; s += step) {
    batchSizes.push(s);
  }

  // ─── Discretise inventory ────────────────────────────────
  // Highest inventory we ever model. Add headroom = step so rounding doesn't
  // chop the top.
  const ceilForState = Math.max(overallCap, input.maxBatchSize);
  const stepCount = Math.max(1, Math.ceil(ceilForState / step) + 2);

  // ─── DP tables ────────────────────────────────────────────
  // dp[w][i] = min cost to be at the START of week w with inventory level i*step.
  // back[w][i] = back-pointer: how we got here (prevI, runSize taken in the
  // PREVIOUS week to land at this state).
  const dp: number[][] = Array.from({ length: W + 1 }, () => new Array(stepCount).fill(INF));
  const back: ({ prevI: number; runSize: number } | null)[][] = Array.from(
    { length: W + 1 },
    () => new Array(stepCount).fill(null),
  );

  const initialI = Math.min(stepCount - 1, Math.round(input.initialInventory / step));
  dp[0][initialI] = 0;

  for (let w = 0; w < W; w++) {
    const demand = input.weeklyDemand[w].quantity;
    const cap = storageCap(w);
    for (let i = 0; i < stepCount; i++) {
      const baseCost = dp[w][i];
      if (baseCost === INF) continue;
      const inventoryAtStart = i * step;

      for (const runSize of batchSizes) {
        const inventoryAfterRun = inventoryAtStart + runSize;
        // Reject states that exceed the OVERALL cap (shelf-life cap, but
        // relaxed to accept the initial inventory we actually have).
        if (inventoryAfterRun > overallCap + step) continue;
        const inventoryAfterDemand = inventoryAfterRun - demand;
        if (inventoryAfterDemand < 0) continue; // demand uncovered
        // Per-state cap at week w+1: forward-window demand OR the natural
        // drain from initial inventory, whichever is larger. The natural-
        // carry term lets us drain through high starting stock without
        // being prematurely cut off.
        //
        // Phase 4l.10: include `longShelfBuffer` on the LAST-week cap
        // too, otherwise long-shelf-life products (shelfLifeWeeks ≥ W)
        // still reject end-of-horizon leftover inventory — a batch
        // produced in week W-N to cover weeks W-N..W-1 typically leaves
        // a few units of carry-over at horizon end, which is fine for
        // long shelf life but was being rejected here.
        const nextCap =
          w + 1 < W
            ? effectiveCapAt(w + 1)
            : naturalCarry(W) + longShelfBuffer;
        if (inventoryAfterDemand > nextCap + step) continue;
        const nextI = Math.round(inventoryAfterDemand / step);
        if (nextI < 0 || nextI >= stepCount) continue;

        // Cost terms
        let cost = 0;
        if (runSize > 0) cost += input.setupCost;
        if (inventoryAfterRun > cap) {
          cost += (inventoryAfterRun - cap) * overflowPenalty;
        }
        // Phase 4l.10: linear holding cost on inventory carried into next
        // week. Tiny absolute value (<< setupCost) so it never changes how
        // MANY batches the DP picks; large enough to break the tie between
        // "batch in week 1" and "batch in week 6" when initial SOH covers
        // the early weeks. Without this the DP picks the first equal-cost
        // placement it encounters → always week 0, ignoring deep starting
        // stock.
        cost += inventoryAfterDemand * holdingCostRate;
        // Phase 4l.12: SOH floor soft penalty. Pay
        // `floorShortfallPenalty` per unit-per-week of post-demand
        // inventory below the floor target. Soft = state still valid
        // when below floor (no `continue`); just costs more. When the
        // setupCost dominates this penalty the DP keeps the same number
        // of batches but prefers placements that keep SOH near the
        // floor. When spare capacity is available the penalty motivates
        // an extra earlier batch to build buffer ahead of demand.
        if (floorShortfallPenalty > 0 && sohFloorDays > 0) {
          const floor = floorByWeekEnd[w];
          const shortfall = floor - inventoryAfterDemand;
          if (shortfall > 0) {
            cost += shortfall * floorShortfallPenalty;
          }
        }

        const total = baseCost + cost;
        if (total < dp[w + 1][nextI]) {
          dp[w + 1][nextI] = total;
          back[w + 1][nextI] = { prevI: i, runSize };
        }
      }
    }
  }

  // ─── Pick best end state ──────────────────────────────────
  let bestEndI = -1;
  let bestCost = INF;
  for (let i = 0; i < stepCount; i++) {
    if (dp[W][i] < bestCost) {
      bestCost = dp[W][i];
      bestEndI = i;
    }
  }

  // ─── Infeasible: every end state is INF ──────────────────
  if (bestEndI === -1 || bestCost === INF) {
    return {
      batches: [],
      rationale: [
        'No feasible plan: total demand exceeds available production capacity within shelf-life and storage constraints.',
      ],
      interRunDays: [],
      unmetDemand: input.weeklyDemand
        .filter((w) => w.quantity > 0)
        .map((w) => ({ weekStart: w.weekStart, quantity: w.quantity })),
      totalCost: NaN,
      feasible: false,
    };
  }

  // ─── Reconstruct plan via back-pointers ──────────────────
  const batches: ScheduledBatch[] = [];
  let cursor = bestEndI;
  for (let w = W; w > 0; w--) {
    const bp = back[w][cursor];
    if (bp === null) break; // shouldn't happen if dp[w][cursor] < INF
    if (bp.runSize > 0) {
      batches.push({
        productCode: input.productCode,
        weekStart: input.weeklyDemand[w - 1].weekStart,
        quantity: bp.runSize,
      });
    }
    cursor = bp.prevI;
  }
  batches.reverse();

  // ─── Inter-run days ──────────────────────────────────────
  const interRunDays: number[] = [];
  for (let i = 1; i < batches.length; i++) {
    const a = new Date(batches[i - 1].weekStart);
    const b = new Date(batches[i].weekStart);
    interRunDays.push(Math.round((b.getTime() - a.getTime()) / 86_400_000));
  }

  // ─── Rationale ───────────────────────────────────────────
  const rationale = buildRationale(input, batches, interRunDays, shelfLifeWeeks);

  return {
    batches,
    rationale,
    interRunDays,
    unmetDemand: [],
    totalCost: bestCost,
    feasible: true,
  };
}

// ─── Helpers ─────────────────────────────────────────────────

function buildRationale(
  input: SingleProductOptimiserInput,
  batches: ScheduledBatch[],
  interRunDays: number[],
  shelfLifeWeeks: number,
): string[] {
  const W = input.weeklyDemand.length;
  const totalDemand = input.weeklyDemand.reduce((s, x) => s + x.quantity, 0);
  const lines: string[] = [];

  if (batches.length === 0) {
    if (totalDemand <= input.initialInventory) {
      lines.push(
        `0 runs needed: starting inventory (${input.initialInventory}) covers all ${totalDemand} units of horizon demand.`,
      );
    } else {
      lines.push(`0 runs scheduled (this is unexpected for non-zero demand and may indicate a bug).`);
    }
    return lines;
  }

  lines.push(
    `${batches.length} run${batches.length === 1 ? '' : 's'} planned across ${W} weeks for total ${batches
      .reduce((s, b) => s + b.quantity, 0)
      .toFixed(0)} units (demand: ${totalDemand.toFixed(0)}).`,
  );

  if (interRunDays.length > 0) {
    const avgGap = interRunDays.reduce((s, d) => s + d, 0) / interRunDays.length;
    lines.push(`Average inter-run gap: ${avgGap.toFixed(0)} days (min ${Math.min(...interRunDays)}, max ${Math.max(...interRunDays)}).`);
  }

  // Diagnose the binding constraint when more than one run was chosen.
  if (batches.length > 1 && totalDemand <= input.maxBatchSize) {
    if (shelfLifeWeeks < W) {
      lines.push(
        `Multiple runs forced by shelf-life (${input.shelfLifeDays}d ≈ ${shelfLifeWeeks} weeks vs ${W}-week horizon).`,
      );
    } else if (
      input.storageCapByWeek &&
      input.storageCapByWeek.some((c) => c < totalDemand)
    ) {
      const minCap = Math.min(...input.storageCapByWeek);
      lines.push(`Multiple runs forced by storage cap (min ${minCap} vs total demand ${totalDemand}).`);
    }
  }

  if (batches.length === 1 && shelfLifeWeeks >= W) {
    lines.push(
      `Single run viable: shelf-life (${input.shelfLifeDays}d) covers full ${W}-week horizon.`,
    );
  }

  return lines;
}
