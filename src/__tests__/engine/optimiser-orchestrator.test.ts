import {
  orchestrateBatchPlan,
  type ProductPlan,
} from '@/lib/engine/optimiser-orchestrator';
import type { ProductMeta, Station } from '@/lib/planning/engine-io';

// ─── Fixture helpers ─────────────────────────────────────────

function meta(o: Partial<ProductMeta> & { productCode: string }): ProductMeta {
  return {
    productCode: o.productCode,
    productName: o.productName ?? o.productCode,
    family: 'family' in o ? (o.family as string) : 'XHBC',
    extendedFamily: 'extendedFamily' in o ? o.extendedFamily! : 'FAM Fungi',
    packageSize: o.packageSize ?? 'MED',
    station: o.station ?? 'bottlo',
    rateUnitsPerHour: o.rateUnitsPerHour ?? 200,
  };
}

function constantDemand(weeks: number, qty: number) {
  const out: { weekStart: string; quantity: number }[] = [];
  const start = new Date('2026-05-04T00:00:00');
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

function plan(o: Partial<ProductPlan> & { meta: ProductMeta }): ProductPlan {
  return {
    meta: o.meta,
    weeklyDemand: o.weeklyDemand ?? constantDemand(8, 100),
    initialInventory: o.initialInventory ?? 0,
    shelfLifeDays: o.shelfLifeDays ?? 90,
    minBatchSize: o.minBatchSize ?? 100,
    maxBatchSize: o.maxBatchSize ?? 2000,
    setupCost: o.setupCost,
    storageCapByWeek: o.storageCapByWeek,
    step: o.step ?? 10,
  };
}

// ─── Tests ───────────────────────────────────────────────────

describe('orchestrateBatchPlan', () => {
  describe('boundary inputs', () => {
    test('empty product list → empty output, no warnings', () => {
      const r = orchestrateBatchPlan({ products: [] });
      expect(r.perProduct.size).toBe(0);
      expect(r.totalChangeoverMinutes).toBe(0);
      expect(r.warnings).toEqual([]);
      // All stations present but empty
      expect(r.perStation.size).toBe(4);
      for (const tl of r.perStation.values()) {
        expect(tl.batches).toEqual([]);
      }
    });

    test('single product matches optimiseSingleProduct output (no inter-product coupling)', () => {
      const m = meta({ productCode: 'SOLO', station: 'bottlo' });
      const r = orchestrateBatchPlan({
        products: [plan({ meta: m })],
      });
      const product = r.perProduct.get('SOLO')!;
      expect(product.feasible).toBe(true);
      const station = r.perStation.get('bottlo')!;
      expect(station.batches).toHaveLength(product.batches.length);
      expect(station.batches.map((b) => b.weekStart)).toEqual(
        product.batches.map((b) => b.weekStart),
      );
    });
  });

  describe('per-station bucketing', () => {
    test('routes batches to the correct station', () => {
      const r = orchestrateBatchPlan({
        products: [
          plan({ meta: meta({ productCode: 'A', station: 'bottlo' }) }),
          plan({
            meta: meta({
              productCode: 'B',
              station: 'elephant',
              extendedFamily: 'FAM MF - Nuts',
              family: 'IAW',
            }),
          }),
        ],
      });
      const bottlo = r.perStation.get('bottlo')!;
      const elephant = r.perStation.get('elephant')!;
      expect(bottlo.batches.every((b) => b.productMeta.productCode === 'A')).toBe(true);
      expect(elephant.batches.every((b) => b.productMeta.productCode === 'B')).toBe(true);
      expect(r.perStation.get('hand-packing')!.batches).toHaveLength(0);
      expect(r.perStation.get('dust')!.batches).toHaveLength(0);
    });
  });

  describe('within-week reorder: family clustering', () => {
    test('two products from the same family in the same week are scheduled adjacent', () => {
      // Two same-family same-size products, both forced to run in week 0
      // (small shelf life makes the optimiser pick week 0).
      const a = meta({
        productCode: 'A',
        family: 'XHBC',
        packageSize: 'LRG',
        extendedFamily: 'FAM Fungi',
        station: 'bottlo',
      });
      const b = meta({
        productCode: 'B',
        family: 'XHBC',
        packageSize: 'LRG',
        extendedFamily: 'FAM Fungi',
        station: 'bottlo',
      });
      const r = orchestrateBatchPlan({
        products: [
          plan({ meta: a, weeklyDemand: constantDemand(2, 100), shelfLifeDays: 14 }),
          plan({ meta: b, weeklyDemand: constantDemand(2, 100), shelfLifeDays: 14 }),
        ],
      });
      const bottlo = r.perStation.get('bottlo')!;
      const week0Batches = bottlo.batches.filter((x) => x.weekStart === '2026-05-04');
      expect(week0Batches).toHaveLength(2);
      // Same family + same size → familySameSize cost = 10 on bottlo
      const intraWeekChangeover = bottlo.changeovers.find(
        (c) => c.weekStart === '2026-05-04' && c.fromProductCode === week0Batches[0].productMeta.productCode,
      );
      expect(intraWeekChangeover?.costMinutes).toBe(10);
    });

    test('different extended-family products on bottlo cost fullClean (120) when adjacent', () => {
      const a = meta({
        productCode: 'A',
        family: 'XHBC',
        extendedFamily: 'FAM Fungi',
        station: 'bottlo',
      });
      const b = meta({
        productCode: 'B',
        family: 'IGB',
        extendedFamily: 'FAM MF - Granola',
        station: 'bottlo',
      });
      const r = orchestrateBatchPlan({
        products: [
          plan({ meta: a, weeklyDemand: constantDemand(2, 100), shelfLifeDays: 14 }),
          plan({ meta: b, weeklyDemand: constantDemand(2, 100), shelfLifeDays: 14 }),
        ],
      });
      const bottlo = r.perStation.get('bottlo')!;
      const week0Changeovers = bottlo.changeovers.filter(
        (c) => c.weekStart === '2026-05-04' && c.fromProductCode !== null,
      );
      expect(week0Changeovers.some((c) => c.costMinutes === 120)).toBe(true);
    });

    test('reorder picks the optimal sequence among multiple within-week batches', () => {
      // Three products on bottlo: A, B (same family), C (different family but same extFam).
      // Optimal sequence: A → B (same fam, 10) → C (extFam, 15) = total 25 from prior=null.
      // Worst sequence: A → C (extFam, 15) → B (extFam, 15) = total 30.
      const a = meta({ productCode: 'A', family: 'XHBC', extendedFamily: 'FAM Fungi' });
      const b = meta({ productCode: 'B', family: 'XHBC', extendedFamily: 'FAM Fungi' });
      const c = meta({ productCode: 'C', family: 'XHCP', extendedFamily: 'FAM Fungi' });
      const r = orchestrateBatchPlan({
        products: [
          plan({ meta: a, weeklyDemand: constantDemand(2, 100), shelfLifeDays: 14 }),
          plan({ meta: b, weeklyDemand: constantDemand(2, 100), shelfLifeDays: 14 }),
          plan({ meta: c, weeklyDemand: constantDemand(2, 100), shelfLifeDays: 14 }),
        ],
      });
      const bottlo = r.perStation.get('bottlo')!;
      const week0Changeovers = bottlo.changeovers.filter(
        (cv) => cv.weekStart === '2026-05-04',
      );
      // Sum of intra-week changeovers (skipping the first batch which has fromProductCode null)
      const intra = week0Changeovers
        .filter((c) => c.fromProductCode !== null)
        .reduce((s, c) => s + c.costMinutes, 0);
      // Optimal intra-week sum = 10 (A→B) + 15 (B→C) = 25, OR
      //                          10 (B→A) + 15 (A→C) = 25.
      // Either way, the same-family pair must be adjacent.
      expect(intra).toBe(25);
    });
  });

  describe('previous-batch handover', () => {
    test('previousBatchByStation makes the first batch incur a real changeover cost', () => {
      const prevOnBottlo = meta({
        productCode: 'PREV',
        family: 'OLD',
        extendedFamily: 'FAM MF - Nuts',
      });
      const a = meta({
        productCode: 'A',
        family: 'XHBC',
        extendedFamily: 'FAM Fungi',
      });
      const r = orchestrateBatchPlan({
        products: [plan({ meta: a, weeklyDemand: constantDemand(2, 100), shelfLifeDays: 14 })],
        previousBatchByStation: { bottlo: prevOnBottlo },
      });
      const bottlo = r.perStation.get('bottlo')!;
      const firstChangeover = bottlo.changeovers[0];
      // PREV is FAM MF - Nuts; A is FAM Fungi → different extFam → fullClean = 120
      expect(firstChangeover.fromProductCode).toBe('PREV');
      expect(firstChangeover.costMinutes).toBe(120);
    });

    test('without previousBatchByStation, first batch costs 0', () => {
      const a = meta({ productCode: 'A' });
      const r = orchestrateBatchPlan({
        products: [plan({ meta: a, weeklyDemand: constantDemand(2, 100), shelfLifeDays: 14 })],
      });
      const bottlo = r.perStation.get('bottlo')!;
      expect(bottlo.changeovers[0].fromProductCode).toBeNull();
      expect(bottlo.changeovers[0].costMinutes).toBe(0);
    });
  });

  describe('infeasible products', () => {
    test('infeasible product surfaces as warning; feasible products still scheduled', () => {
      const ok = meta({ productCode: 'OK' });
      const bad = meta({ productCode: 'BAD', station: 'bottlo' });
      const r = orchestrateBatchPlan({
        products: [
          plan({ meta: ok }),
          plan({
            meta: bad,
            // Demand 1000/week × 12 weeks but maxBatchSize 100 + shelf-life 7d → infeasible
            weeklyDemand: constantDemand(12, 1000),
            shelfLifeDays: 7,
            minBatchSize: 50,
            maxBatchSize: 100,
          }),
        ],
      });
      expect(r.perProduct.get('OK')!.feasible).toBe(true);
      expect(r.perProduct.get('BAD')!.feasible).toBe(false);
      expect(
        r.warnings.some(
          (w) => w.kind === 'product_infeasible' && w.productCode === 'BAD',
        ),
      ).toBe(true);
      // BAD's batches don't appear on any station
      for (const tl of r.perStation.values()) {
        expect(tl.batches.every((b) => b.productMeta.productCode !== 'BAD')).toBe(true);
      }
    });
  });

  describe('orderInWeek annotation', () => {
    test('within-week batches receive 0..N-1 ordering', () => {
      const a = meta({ productCode: 'A' });
      const b = meta({ productCode: 'B' });
      const c = meta({ productCode: 'C' });
      const r = orchestrateBatchPlan({
        products: [
          plan({ meta: a, weeklyDemand: constantDemand(2, 100), shelfLifeDays: 14 }),
          plan({ meta: b, weeklyDemand: constantDemand(2, 100), shelfLifeDays: 14 }),
          plan({ meta: c, weeklyDemand: constantDemand(2, 100), shelfLifeDays: 14 }),
        ],
      });
      const bottlo = r.perStation.get('bottlo')!;
      const week0 = bottlo.batches.filter((b) => b.weekStart === '2026-05-04');
      const orders = week0.map((b) => b.orderInWeek).sort();
      expect(orders).toEqual([0, 1, 2]);
    });
  });

  describe('rationale + total changeover sum', () => {
    test('totalChangeoverMinutes is sum of per-station totals', () => {
      const a = meta({ productCode: 'A', station: 'bottlo' });
      const b = meta({
        productCode: 'B',
        station: 'elephant',
        extendedFamily: 'FAM MF - Nuts',
        family: 'IAW',
      });
      const r = orchestrateBatchPlan({
        products: [
          plan({ meta: a, weeklyDemand: constantDemand(2, 100), shelfLifeDays: 14 }),
          plan({ meta: b, weeklyDemand: constantDemand(2, 100), shelfLifeDays: 14 }),
        ],
      });
      let sum = 0;
      for (const tl of r.perStation.values()) sum += tl.totalChangeoverMinutes;
      expect(r.totalChangeoverMinutes).toBe(sum);
    });

    test('rationale mentions per-station counts', () => {
      const r = orchestrateBatchPlan({
        products: [
          plan({ meta: meta({ productCode: 'A', station: 'bottlo' }) }),
        ],
      });
      expect(r.rationale.some((l) => l.toLowerCase().includes('bottlo'))).toBe(true);
    });
  });

  describe('hand-packing has near-flat changeover (family ordering barely matters)', () => {
    test('any two products on hand-packing cost ≤ 5 min to switch', () => {
      const a = meta({
        productCode: 'A',
        family: 'F1',
        extendedFamily: 'FAM Fungi',
        station: 'hand-packing',
      });
      const b = meta({
        productCode: 'B',
        family: 'F2',
        extendedFamily: 'FAM MF - Granola',
        station: 'hand-packing',
      });
      const r = orchestrateBatchPlan({
        products: [
          plan({ meta: a, weeklyDemand: constantDemand(2, 100), shelfLifeDays: 14 }),
          plan({ meta: b, weeklyDemand: constantDemand(2, 100), shelfLifeDays: 14 }),
        ],
      });
      const handPacking = r.perStation.get('hand-packing')!;
      for (const c of handPacking.changeovers) {
        // Worst on hand-packing is fullClean = 5 min
        expect(c.costMinutes).toBeLessThanOrEqual(5);
      }
    });
  });

  describe('Phase 4l.12: low-velocity skip', () => {
    test('product with adequate SOH + tiny demand + large minBatch is SKIPPED', () => {
      // Mirrors the real MFTERIMB5 case: 0.42 units/week demand, 3 SOH,
      // 50-unit minBatch. Without the skip, the DP forces a 50-unit
      // batch leaving ~114 weeks of carry. With the skip, no batch.
      const m = meta({ productCode: 'MFTERIMB5', station: 'hand-packing' });
      const r = orchestrateBatchPlan({
        products: [
          plan({
            meta: m,
            weeklyDemand: constantDemand(12, 0.42),
            initialInventory: 3,
            minBatchSize: 50,
            maxBatchSize: 2000,
            shelfLifeDays: 540,
          }),
        ],
      });
      const result = r.perProduct.get('MFTERIMB5')!;
      expect(result.feasible).toBe(true);
      expect(result.batches.length).toBe(0);
      expect(result.rationale[0]).toMatch(/Skipped/);
    });

    test('product where minBatch is justified by demand is NOT skipped', () => {
      // Normal case: high-demand product still gets planned.
      const m = meta({ productCode: 'MFBEETPME', station: 'bottlo' });
      const r = orchestrateBatchPlan({
        products: [
          plan({
            meta: m,
            weeklyDemand: constantDemand(12, 200),
            initialInventory: 0,
            minBatchSize: 100,
            maxBatchSize: 2000,
            shelfLifeDays: 540,
          }),
        ],
      });
      const result = r.perProduct.get('MFBEETPME')!;
      expect(result.feasible).toBe(true);
      expect(result.batches.length).toBeGreaterThan(0);
    });

    test('zero-demand product is left alone (no batches, no skip warning)', () => {
      // Edge case: no demand at all. DP returns 0 batches naturally;
      // our skip predicate requires avgWeekly > 0 so it doesn't fire.
      const m = meta({ productCode: 'MFDEAD', station: 'hand-packing' });
      const r = orchestrateBatchPlan({
        products: [
          plan({
            meta: m,
            weeklyDemand: constantDemand(8, 0),
            initialInventory: 10,
            minBatchSize: 50,
            maxBatchSize: 2000,
            shelfLifeDays: 540,
          }),
        ],
      });
      const result = r.perProduct.get('MFDEAD')!;
      expect(result.feasible).toBe(true);
      expect(result.batches.length).toBe(0);
      // Should NOT have the "Skipped" rationale — natural zero-demand.
      expect(result.rationale[0] ?? '').not.toMatch(/Skipped/);
    });
  });
});
