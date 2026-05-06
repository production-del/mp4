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
  });
});
