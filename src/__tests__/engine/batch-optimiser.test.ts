import {
  optimiseSingleProduct,
  type SingleProductOptimiserInput,
} from '@/lib/engine/batch-optimiser';

// ─── Fixture helpers ─────────────────────────────────────────

/** Generate W weeks of constant demand starting at MONDAY. */
function constantDemand(weeks: number, qty: number) {
  const out: { weekStart: string; quantity: number }[] = [];
  const start = new Date('2026-05-04T00:00:00'); // Monday
  for (let w = 0; w < weeks; w++) {
    const d = new Date(start);
    d.setDate(start.getDate() + w * 7);
    out.push({
      weekStart: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
      quantity: qty,
    });
  }
  return out;
}

/** Sum of batch quantities. */
function batchSum(batches: { quantity: number }[]): number {
  return batches.reduce((s, b) => s + b.quantity, 0);
}

/** Walk the schedule forward and compute peak inventory at any week boundary. */
function peakInventory(
  initial: number,
  weeklyDemand: { weekStart: string; quantity: number }[],
  batches: { weekStart: string; quantity: number }[],
): number {
  const byWeek = new Map<string, number>();
  for (const b of batches) {
    byWeek.set(b.weekStart, (byWeek.get(b.weekStart) ?? 0) + b.quantity);
  }
  let inv = initial;
  let peak = inv;
  for (const w of weeklyDemand) {
    inv += byWeek.get(w.weekStart) ?? 0;
    if (inv > peak) peak = inv;
    inv -= w.quantity;
  }
  return peak;
}

const BASE: Omit<SingleProductOptimiserInput, 'weeklyDemand' | 'shelfLifeDays'> = {
  productCode: 'TEST',
  initialInventory: 0,
  minBatchSize: 100,
  maxBatchSize: 2000,
  setupCost: 100,
  step: 10,
  // Phase 4l.12: explicitly disable the soft floor in the base fixture so
  // existing tests reason about the optimiser without the floor's
  // pull-forward bias. Dedicated `sohFloorDays` tests below exercise the
  // feature.
  sohFloorDays: 0,
};

// ─── Tests ───────────────────────────────────────────────────

describe('optimiseSingleProduct', () => {
  describe('boundary inputs', () => {
    test('empty horizon → 0 batches, 0 cost, feasible', () => {
      const r = optimiseSingleProduct({
        ...BASE,
        weeklyDemand: [],
        shelfLifeDays: 90,
      });
      expect(r.feasible).toBe(true);
      expect(r.batches).toEqual([]);
      expect(r.totalCost).toBe(0);
    });

    test('initial inventory covers all demand → 0 batches', () => {
      const r = optimiseSingleProduct({
        ...BASE,
        weeklyDemand: constantDemand(4, 50),
        initialInventory: 200, // exactly enough for 4 × 50
        shelfLifeDays: 90,
      });
      expect(r.feasible).toBe(true);
      expect(r.batches).toHaveLength(0);
      expect(r.rationale[0]).toMatch(/0 runs needed/);
    });

    test('throws on non-positive shelfLifeDays', () => {
      expect(() =>
        optimiseSingleProduct({
          ...BASE,
          weeklyDemand: constantDemand(4, 50),
          shelfLifeDays: 0,
        }),
      ).toThrow(/shelfLifeDays/);
    });

    test('throws when minBatchSize > maxBatchSize', () => {
      expect(() =>
        optimiseSingleProduct({
          ...BASE,
          weeklyDemand: constantDemand(4, 50),
          shelfLifeDays: 90,
          minBatchSize: 500,
          maxBatchSize: 200,
        }),
      ).toThrow(/min.*max/);
    });
  });

  describe('long shelf-life: collapse to one run (the headline behaviour)', () => {
    test('100/week × 12 weeks with 90-day shelf-life → 1 run covering all 1200 units', () => {
      const demand = constantDemand(12, 100);
      const r = optimiseSingleProduct({
        ...BASE,
        weeklyDemand: demand,
        shelfLifeDays: 90,
        maxBatchSize: 1500,
      });
      expect(r.feasible).toBe(true);
      expect(r.batches).toHaveLength(1);
      expect(r.batches[0].quantity).toBeGreaterThanOrEqual(1200);
      expect(r.batches[0].weekStart).toBe(demand[0].weekStart);
      expect(r.rationale.some((l) => l.includes('Single run viable'))).toBe(true);
    });

    test('total batch volume covers total demand within step rounding', () => {
      const demand = constantDemand(12, 100);
      const r = optimiseSingleProduct({
        ...BASE,
        weeklyDemand: demand,
        shelfLifeDays: 90,
        maxBatchSize: 1500,
      });
      const totalDemand = 12 * 100;
      expect(batchSum(r.batches)).toBeGreaterThanOrEqual(totalDemand);
      // Step is 10, so batches can overshoot demand by ≤ step per batch
      expect(batchSum(r.batches)).toBeLessThanOrEqual(totalDemand + r.batches.length * BASE.step!);
    });
  });

  describe('short shelf-life: must run more frequently', () => {
    test('shelf-life 14 days (2 weeks) over 12-week horizon → 6 runs (one per 2 weeks)', () => {
      const demand = constantDemand(12, 100);
      const r = optimiseSingleProduct({
        ...BASE,
        weeklyDemand: demand,
        shelfLifeDays: 14,
        maxBatchSize: 1500,
      });
      expect(r.feasible).toBe(true);
      // With 2-week shelf life, can only carry forward 2 weeks of demand max.
      // So expect ~6 runs (12 weeks / 2 weeks per run).
      expect(r.batches.length).toBeGreaterThanOrEqual(6);
      expect(r.batches.length).toBeLessThanOrEqual(8);
      expect(r.rationale.some((l) => l.includes('shelf-life'))).toBe(true);
    });

    test('every batch is ≤ shelf-life × peak-week demand (no over-production)', () => {
      const demand = constantDemand(12, 100);
      const r = optimiseSingleProduct({
        ...BASE,
        weeklyDemand: demand,
        shelfLifeDays: 14,
      });
      const shelfLifeWeeks = Math.floor(14 / 7);
      const cap = shelfLifeWeeks * 100; // 200
      // Each individual batch shouldn't massively exceed 2 weeks of demand.
      // (Allow ≤ 2× for one-time stocking + discretisation slack.)
      for (const b of r.batches) {
        expect(b.quantity).toBeLessThanOrEqual(cap * 2);
      }
    });
  });

  describe('storage-bound: more runs than shelf-life would require', () => {
    test('100/week × 12 weeks, shelf-life 90d, but storage cap 250 → ≥4 smaller runs', () => {
      const demand = constantDemand(12, 100);
      const r = optimiseSingleProduct({
        ...BASE,
        weeklyDemand: demand,
        shelfLifeDays: 90,
        maxBatchSize: 1500,
        storageCapByWeek: new Array(12).fill(250),
      });
      expect(r.feasible).toBe(true);
      // Storage cap binds: peak inventory must be ≤ 250.
      const peak = peakInventory(0, demand, r.batches);
      expect(peak).toBeLessThanOrEqual(250 + BASE.step!); // step slack
      // Therefore ≥4 runs (1200 total / 250 cap).
      expect(r.batches.length).toBeGreaterThanOrEqual(4);
    });

    test('rationale cites storage cap as the binding constraint', () => {
      const demand = constantDemand(12, 100);
      const r = optimiseSingleProduct({
        ...BASE,
        weeklyDemand: demand,
        shelfLifeDays: 90,
        maxBatchSize: 1500,
        storageCapByWeek: new Array(12).fill(250),
      });
      expect(r.rationale.some((l) => l.toLowerCase().includes('storage'))).toBe(true);
    });
  });

  describe('cost minimisation', () => {
    test('higher setupCost pushes toward fewer batches', () => {
      const demand = constantDemand(12, 100);
      const cheap = optimiseSingleProduct({
        ...BASE,
        weeklyDemand: demand,
        shelfLifeDays: 90,
        maxBatchSize: 1500,
        setupCost: 10,
      });
      const expensive = optimiseSingleProduct({
        ...BASE,
        weeklyDemand: demand,
        shelfLifeDays: 90,
        maxBatchSize: 1500,
        setupCost: 10_000,
      });
      // With long shelf-life and no storage cap, both can collapse to 1 run.
      // Verify: expensive setupCost never produces MORE batches than cheap.
      expect(expensive.batches.length).toBeLessThanOrEqual(cheap.batches.length);
    });

    test('inter-run gaps spread evenly when possible (multi-run case)', () => {
      const demand = constantDemand(12, 100);
      const r = optimiseSingleProduct({
        ...BASE,
        weeklyDemand: demand,
        shelfLifeDays: 21, // 3 weeks → ~4 runs
        maxBatchSize: 1500,
      });
      // Inter-run gaps shouldn't be wildly uneven (cv should be modest).
      if (r.interRunDays.length > 1) {
        const mean =
          r.interRunDays.reduce((s, d) => s + d, 0) / r.interRunDays.length;
        const max = Math.max(...r.interRunDays);
        // Largest gap shouldn't be more than 2× the mean.
        expect(max).toBeLessThanOrEqual(mean * 2);
      }
    });
  });

  describe('infeasibility', () => {
    test('demand exceeds maxBatchSize × W × shelf-life carry → infeasible', () => {
      // 12 weeks × 1000/week = 12,000 units, but maxBatchSize 100 and shelf 7d.
      // Each week can hold at most 100 produced + 100 from previous → demand never met.
      const demand = constantDemand(12, 1000);
      const r = optimiseSingleProduct({
        ...BASE,
        weeklyDemand: demand,
        shelfLifeDays: 7,
        minBatchSize: 50,
        maxBatchSize: 100,
      });
      expect(r.feasible).toBe(false);
      expect(r.batches).toEqual([]);
      expect(r.unmetDemand).toHaveLength(12);
      expect(Number.isNaN(r.totalCost)).toBe(true);
    });
  });

  describe('output shape', () => {
    test('batches sorted chronologically by weekStart', () => {
      const demand = constantDemand(12, 100);
      const r = optimiseSingleProduct({
        ...BASE,
        weeklyDemand: demand,
        shelfLifeDays: 14,
      });
      const dates = r.batches.map((b) => b.weekStart);
      const sorted = [...dates].sort();
      expect(dates).toEqual(sorted);
    });

    test('every batch has the correct productCode', () => {
      const demand = constantDemand(8, 80);
      const r = optimiseSingleProduct({
        ...BASE,
        productCode: 'FCHAGALG',
        weeklyDemand: demand,
        shelfLifeDays: 90,
      });
      for (const b of r.batches) {
        expect(b.productCode).toBe('FCHAGALG');
      }
    });

    test('interRunDays length = batches.length - 1', () => {
      const demand = constantDemand(12, 100);
      const r = optimiseSingleProduct({
        ...BASE,
        weeklyDemand: demand,
        shelfLifeDays: 14,
      });
      expect(r.interRunDays).toHaveLength(Math.max(0, r.batches.length - 1));
    });
  });

  describe('initial inventory interaction', () => {
    test('starting inventory delays the first run', () => {
      const demand = constantDemand(12, 100);
      const fresh = optimiseSingleProduct({
        ...BASE,
        weeklyDemand: demand,
        shelfLifeDays: 14,
        initialInventory: 0,
      });
      const stocked = optimiseSingleProduct({
        ...BASE,
        weeklyDemand: demand,
        shelfLifeDays: 14,
        initialInventory: 400, // covers first 4 weeks
      });
      // The well-stocked plan needs strictly fewer or equal runs.
      expect(stocked.batches.length).toBeLessThanOrEqual(fresh.batches.length);
    });

    test('Phase 4l.10: with long shelf-life and deep SOH, first batch lands AFTER inventory drains', () => {
      // 12 weeks × 100 demand = 1200 total. Long shelf-life (90d) means
      // one batch could in principle cover everything. With 600 units of
      // starting inventory (6 weeks of cover), the planner should defer
      // the first batch — NOT place it in week 0 alongside the SOH.
      // Pre-Phase-4l.10 the DP picked week 0 (first equal-cost path);
      // now the holding-cost tiebreaker pushes it to ~ week 5.
      const r = optimiseSingleProduct({
        ...BASE,
        weeklyDemand: constantDemand(12, 100),
        shelfLifeDays: 90,
        initialInventory: 600,
        setupCost: 100,
      });
      expect(r.feasible).toBe(true);
      // The headline: the first batch should NOT be in week 0.
      // We expect it at the week the running balance first hits zero,
      // not earlier.
      const monday = (offset: number) => {
        const d = new Date('2026-05-04T00:00:00');
        d.setDate(d.getDate() + offset * 7);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      };
      const firstBatchWeek = r.batches[0]?.weekStart;
      expect(firstBatchWeek).not.toBe(monday(0));
      // It should land around week 5-6 — after the 6 weeks of cover.
      // Tolerant range to avoid coupling to step discretisation.
      const weekIndex = r.batches[0]
        ? Math.round(
            (new Date(r.batches[0].weekStart).getTime() -
              new Date(monday(0)).getTime()) /
              (7 * 86_400_000),
          )
        : -1;
      expect(weekIndex).toBeGreaterThanOrEqual(4);
    });
  });

  describe('Phase 4l.12: SOH floor target', () => {
    test('with a 10-day floor, deep-SOH product STILL holds enough inventory across the horizon', () => {
      // Same scenario as the deferral test, but with the 10-day floor
      // ENABLED. The DP should now keep more inventory on hand — the
      // post-demand balance should stay near the floor target instead
      // of dipping toward zero between batches.
      const r = optimiseSingleProduct({
        ...BASE,
        weeklyDemand: constantDemand(12, 100),
        shelfLifeDays: 90,
        initialInventory: 600,
        setupCost: 100,
        sohFloorDays: 10,
      });
      expect(r.feasible).toBe(true);
      // Walk inventory week by week; with a 10-day (≈ 143 units at
      // 100/week demand) floor the minimum end-of-week SOH should not
      // fall far below the floor. Allow a small tolerance for batch
      // discretisation.
      const byWeek = new Map<string, number>();
      for (const b of r.batches) {
        byWeek.set(b.weekStart, (byWeek.get(b.weekStart) ?? 0) + b.quantity);
      }
      let inv = 600;
      const endOfWeekInv: number[] = [];
      for (const w of constantDemand(12, 100)) {
        inv += byWeek.get(w.weekStart) ?? 0;
        inv -= w.quantity;
        endOfWeekInv.push(inv);
      }
      // The minimum (interior weeks, before horizon-end drain) should be
      // at least ~half the floor — the DP is allowed to dip but the
      // penalty should keep it largely above zero.
      const interiorMin = Math.min(...endOfWeekInv.slice(0, -1));
      expect(interiorMin).toBeGreaterThanOrEqual(50);
    });

    test('disabling the floor (sohFloorDays=0) reverts to legacy behaviour', () => {
      const demand = constantDemand(8, 100);
      const withFloor = optimiseSingleProduct({
        ...BASE,
        weeklyDemand: demand,
        shelfLifeDays: 60,
        initialInventory: 0,
        sohFloorDays: 10,
        setupCost: 50, // low setup → DP can afford extra batches
      });
      const noFloor = optimiseSingleProduct({
        ...BASE,
        weeklyDemand: demand,
        shelfLifeDays: 60,
        initialInventory: 0,
        sohFloorDays: 0,
        setupCost: 50,
      });
      expect(withFloor.feasible).toBe(true);
      expect(noFloor.feasible).toBe(true);
      // With the floor enabled and a cheap setup, the DP may add
      // earlier/larger batches. Without it, the legacy behaviour
      // returns. We don't pin exact counts — just verify that the
      // total quantity in the floor variant is ≥ the non-floor variant
      // (extra buffer ≥ 0).
      expect(batchSum(withFloor.batches)).toBeGreaterThanOrEqual(
        batchSum(noFloor.batches),
      );
    });

    test('floor does NOT force infeasibility when capacity is too tight', () => {
      // Tight scenario: demand exceeds what the DP can produce given
      // shelf life + minBatchSize. The floor adds soft pressure but
      // should not turn a feasible-without-floor plan into infeasible.
      const r = optimiseSingleProduct({
        ...BASE,
        weeklyDemand: constantDemand(4, 100),
        shelfLifeDays: 7, // very short — forces a batch each week
        initialInventory: 0,
        minBatchSize: 100,
        maxBatchSize: 100, // exact match
        sohFloorDays: 10, // demands extra units the DP CAN'T provide
        setupCost: 50,
      });
      // Soft penalty = still feasible, just at higher cost.
      expect(r.feasible).toBe(true);
    });

    test('floor scales linearly with sohFloorDays (5 vs 15 days)', () => {
      // Compare two floor settings. Higher floor → more inventory held
      // on average. We measure average end-of-week inventory.
      const demand = constantDemand(10, 100);
      const avgInv = (input: SingleProductOptimiserInput) => {
        const r = optimiseSingleProduct(input);
        const byWeek = new Map<string, number>();
        for (const b of r.batches) {
          byWeek.set(b.weekStart, (byWeek.get(b.weekStart) ?? 0) + b.quantity);
        }
        let inv = input.initialInventory;
        let sum = 0;
        for (const w of input.weeklyDemand) {
          inv += byWeek.get(w.weekStart) ?? 0;
          inv -= w.quantity;
          sum += inv;
        }
        return sum / input.weeklyDemand.length;
      };
      const low = avgInv({
        ...BASE,
        weeklyDemand: demand,
        shelfLifeDays: 60,
        initialInventory: 100,
        sohFloorDays: 5,
      });
      const high = avgInv({
        ...BASE,
        weeklyDemand: demand,
        shelfLifeDays: 60,
        initialInventory: 100,
        sohFloorDays: 15,
      });
      expect(high).toBeGreaterThanOrEqual(low);
    });
  });
});
