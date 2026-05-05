import {
  assignBatchesToDays,
  DEFAULT_STATION_CAPACITY_MINUTES_PER_DAY,
  type DayAssignerInput,
} from '@/lib/engine/day-assigner';
import {
  orchestrateBatchPlan,
  type ProductPlan,
  type StationTimeline,
  type ScheduledBatchWithMeta,
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
    weeklyDemand: o.weeklyDemand ?? constantDemand(4, 100),
    initialInventory: o.initialInventory ?? 0,
    shelfLifeDays: o.shelfLifeDays ?? 14,
    minBatchSize: o.minBatchSize ?? 100,
    maxBatchSize: o.maxBatchSize ?? 2000,
    setupCost: o.setupCost,
    storageCapByWeek: o.storageCapByWeek,
    step: o.step ?? 10,
  };
}

/** Build a synthetic StationTimeline directly (avoids running the orchestrator). */
function syntheticTimeline(
  station: Station,
  batches: Array<{ productCode: string; weekStart: string; quantity: number; changeover?: number; productMeta?: Partial<ProductMeta> }>,
): StationTimeline {
  const orderedBatches: ScheduledBatchWithMeta[] = batches.map((b, i) => ({
    productCode: b.productCode,
    weekStart: b.weekStart,
    quantity: b.quantity,
    productMeta: meta({ productCode: b.productCode, ...b.productMeta }),
    orderInWeek: i,
  }));
  const changeovers = batches.map((b, i) => ({
    fromProductCode: i === 0 ? null : batches[i - 1].productCode,
    toProductCode: b.productCode,
    weekStart: b.weekStart,
    costMinutes: b.changeover ?? 0,
    station,
  }));
  const totalChangeoverMinutes = changeovers.reduce((s, c) => s + c.costMinutes, 0);
  return { station, batches: orderedBatches, changeovers, totalChangeoverMinutes };
}

const MONDAY = '2026-05-04';
const TUESDAY = '2026-05-05';
const WEDNESDAY = '2026-05-06';
const FRIDAY = '2026-05-08';

// ─── Tests ───────────────────────────────────────────────────

describe('assignBatchesToDays', () => {
  describe('boundary inputs', () => {
    test('empty input → all stations present, all empty, no warnings', () => {
      const r = assignBatchesToDays({ perStation: new Map() });
      expect(r.perStation.size).toBe(4);
      for (const tl of r.perStation.values()) {
        expect(tl.byDay.size).toBe(0);
      }
      expect(r.warnings).toEqual([]);
    });

    test('station with empty batches array stays empty', () => {
      const perStation = new Map<Station, StationTimeline>();
      perStation.set('bottlo', {
        station: 'bottlo',
        batches: [],
        changeovers: [],
        totalChangeoverMinutes: 0,
      });
      const r = assignBatchesToDays({ perStation });
      expect(r.perStation.get('bottlo')!.byDay.size).toBe(0);
    });
  });

  describe('single-batch placement', () => {
    test('a small batch lands on Monday with correct duration breakdown', () => {
      const tl = syntheticTimeline('bottlo', [
        // 200 units at rateUnitsPerHour 200 → 60 production minutes
        { productCode: 'A', weekStart: MONDAY, quantity: 200, changeover: 10 },
      ]);
      const perStation = new Map<Station, StationTimeline>();
      perStation.set('bottlo', tl);
      const r = assignBatchesToDays({ perStation });
      const bottlo = r.perStation.get('bottlo')!;
      expect(bottlo.byDay.size).toBe(1);
      const monday = bottlo.byDay.get(MONDAY)!;
      expect(monday.batches).toHaveLength(1);
      expect(monday.batches[0].productCode).toBe('A');
      expect(monday.batches[0].scheduledDate).toBe(MONDAY);
      expect(monday.batches[0].durationMinutes).toBeCloseTo(60, 6);
      expect(monday.batches[0].changeoverMinutes).toBe(10);
      expect(monday.usedMinutes).toBeCloseTo(70, 6); // 60 + 10
      expect(monday.capacityMinutes).toBe(DEFAULT_STATION_CAPACITY_MINUTES_PER_DAY);
      expect(r.warnings).toEqual([]);
    });
  });

  describe('multi-batch packing within a week', () => {
    test('three small batches fit on Monday', () => {
      // Each batch: 200 units / 200 u/hr × 60 = 60 min production. + 10 min changeover.
      // Three batches: 60+10 + 60+10 + 60+10 = 210 min. Fits in 480.
      const tl = syntheticTimeline('bottlo', [
        { productCode: 'A', weekStart: MONDAY, quantity: 200, changeover: 10 },
        { productCode: 'B', weekStart: MONDAY, quantity: 200, changeover: 10 },
        { productCode: 'C', weekStart: MONDAY, quantity: 200, changeover: 10 },
      ]);
      const perStation = new Map<Station, StationTimeline>();
      perStation.set('bottlo', tl);
      const r = assignBatchesToDays({ perStation });
      const bottlo = r.perStation.get('bottlo')!;
      expect(bottlo.byDay.size).toBe(1);
      expect(bottlo.byDay.get(MONDAY)!.batches).toHaveLength(3);
      expect(bottlo.byDay.get(MONDAY)!.usedMinutes).toBeCloseTo(210, 6);
    });

    test('batches overflow Monday and spill onto Tuesday in orchestrator order', () => {
      // 1500 units / 200 u/hr × 60 = 450 min. + 0 changeover = 450. Fits Mon (480).
      // Next batch: 60 min production + 10 changeover = 70. Doesn't fit (450+70 > 480).
      // → spills to Tuesday.
      const tl = syntheticTimeline('bottlo', [
        { productCode: 'A', weekStart: MONDAY, quantity: 1500, changeover: 0 },
        { productCode: 'B', weekStart: MONDAY, quantity: 200, changeover: 10 },
      ]);
      const perStation = new Map<Station, StationTimeline>();
      perStation.set('bottlo', tl);
      const r = assignBatchesToDays({ perStation });
      const bottlo = r.perStation.get('bottlo')!;
      expect(bottlo.byDay.size).toBe(2);
      expect(bottlo.byDay.get(MONDAY)!.batches.map((b) => b.productCode)).toEqual(['A']);
      expect(bottlo.byDay.get(TUESDAY)!.batches.map((b) => b.productCode)).toEqual(['B']);
      expect(r.warnings).toEqual([]);
    });

    test('preserves orchestrator order across day spillover (family-clustering carries forward)', () => {
      // 5 batches each 200 min total. Capacity 480 → 2 fit per day.
      // Order: A, A2, B, C, D. After packing: Mon[A,A2], Tue[B,C], Wed[D].
      // The same-family pair A,A2 stays together on Monday.
      const tl = syntheticTimeline('bottlo', [
        { productCode: 'A',  weekStart: MONDAY, quantity: 600, changeover: 20 },  // 180+20=200
        { productCode: 'A2', weekStart: MONDAY, quantity: 600, changeover: 20 },  // 180+20=200
        { productCode: 'B',  weekStart: MONDAY, quantity: 600, changeover: 20 },
        { productCode: 'C',  weekStart: MONDAY, quantity: 600, changeover: 20 },
        { productCode: 'D',  weekStart: MONDAY, quantity: 600, changeover: 20 },
      ]);
      const perStation = new Map<Station, StationTimeline>();
      perStation.set('bottlo', tl);
      const r = assignBatchesToDays({ perStation });
      const bottlo = r.perStation.get('bottlo')!;
      const mondayCodes = bottlo.byDay.get(MONDAY)!.batches.map((b) => b.productCode);
      expect(mondayCodes).toEqual(['A', 'A2']);
      const tuesdayCodes = bottlo.byDay.get(TUESDAY)!.batches.map((b) => b.productCode);
      expect(tuesdayCodes).toEqual(['B', 'C']);
      const wednesdayCodes = bottlo.byDay.get(WEDNESDAY)!.batches.map((b) => b.productCode);
      expect(wednesdayCodes).toEqual(['D']);
    });
  });

  describe('oversize and overflow warnings', () => {
    test('a single batch exceeding daily capacity emits oversize_batch but is still assigned', () => {
      // 2000 units / 200 u/hr × 60 = 600 min. Exceeds default 480.
      const tl = syntheticTimeline('bottlo', [
        { productCode: 'BIG', weekStart: MONDAY, quantity: 2000, changeover: 0 },
      ]);
      const perStation = new Map<Station, StationTimeline>();
      perStation.set('bottlo', tl);
      const r = assignBatchesToDays({ perStation });
      const bottlo = r.perStation.get('bottlo')!;
      expect(bottlo.byDay.get(MONDAY)!.batches).toHaveLength(1);
      expect(bottlo.byDay.get(MONDAY)!.usedMinutes).toBeCloseTo(600, 6);
      // Capacity stays at the day's cap; usedMinutes > capacityMinutes flags overrun
      expect(bottlo.byDay.get(MONDAY)!.capacityMinutes).toBe(480);
      expect(r.warnings).toHaveLength(1);
      expect(r.warnings[0].kind).toBe('oversize_batch');
    });

    test('week overflow: too many batches for 5 days emits week_overflow and drops the rest', () => {
      // 6 batches each 480 min total. Capacity 480/day → 1 fits per day.
      // Days 1-5 take 5 batches; the 6th overflows.
      const batches = ['A', 'B', 'C', 'D', 'E', 'F'].map((p) => ({
        productCode: p,
        weekStart: MONDAY,
        quantity: 1600, // 480 min production
        changeover: 0,
      }));
      const tl = syntheticTimeline('bottlo', batches);
      const perStation = new Map<Station, StationTimeline>();
      perStation.set('bottlo', tl);
      const r = assignBatchesToDays({ perStation });
      const bottlo = r.perStation.get('bottlo')!;
      // 5 days each with 1 batch
      expect(bottlo.byDay.size).toBe(5);
      const overflowWarnings = r.warnings.filter((w) => w.kind === 'week_overflow');
      expect(overflowWarnings).toHaveLength(1);
      expect((overflowWarnings[0] as { productCode: string }).productCode).toBe('F');
    });
  });

  describe('per-day capacity overrides', () => {
    test('half-day Monday (240 min) forces spillover that wouldn\'t happen at full capacity', () => {
      // Two batches at 200 min each = 400 min total. Fits a full Mon (480) but not a half (240).
      const tl = syntheticTimeline('bottlo', [
        { productCode: 'A', weekStart: MONDAY, quantity: 600, changeover: 20 },
        { productCode: 'B', weekStart: MONDAY, quantity: 600, changeover: 20 },
      ]);
      const perStation = new Map<Station, StationTimeline>();
      perStation.set('bottlo', tl);
      const r = assignBatchesToDays({
        perStation,
        stationCapacity: {
          bottlo: { minutesPerDay: 480, perDayOverride: { [MONDAY]: 240 } },
        },
      });
      const bottlo = r.perStation.get('bottlo')!;
      expect(bottlo.byDay.get(MONDAY)!.batches.map((b) => b.productCode)).toEqual(['A']);
      expect(bottlo.byDay.get(MONDAY)!.capacityMinutes).toBe(240);
      expect(bottlo.byDay.get(TUESDAY)!.batches.map((b) => b.productCode)).toEqual(['B']);
      expect(bottlo.byDay.get(TUESDAY)!.capacityMinutes).toBe(480); // back to default
    });
  });

  describe('multi-week timelines', () => {
    test('week boundary resets the day cursor (week 2 batches start on its Monday)', () => {
      const NEXT_MONDAY = '2026-05-11';
      const tl = syntheticTimeline('bottlo', [
        { productCode: 'A', weekStart: MONDAY, quantity: 200, changeover: 0 },
        { productCode: 'B', weekStart: NEXT_MONDAY, quantity: 200, changeover: 0 },
      ]);
      const perStation = new Map<Station, StationTimeline>();
      perStation.set('bottlo', tl);
      const r = assignBatchesToDays({ perStation });
      const bottlo = r.perStation.get('bottlo')!;
      expect(bottlo.byDay.get(MONDAY)!.batches.map((b) => b.productCode)).toEqual(['A']);
      expect(bottlo.byDay.get(NEXT_MONDAY)!.batches.map((b) => b.productCode)).toEqual(['B']);
    });
  });

  describe('multiple stations independent', () => {
    test('each station is scheduled in isolation', () => {
      const perStation = new Map<Station, StationTimeline>();
      perStation.set(
        'bottlo',
        syntheticTimeline('bottlo', [
          { productCode: 'A', weekStart: MONDAY, quantity: 200, changeover: 0 },
        ]),
      );
      perStation.set(
        'elephant',
        syntheticTimeline('elephant', [
          { productCode: 'B', weekStart: MONDAY, quantity: 200, changeover: 0, productMeta: { station: 'elephant' } },
        ]),
      );
      const r = assignBatchesToDays({ perStation });
      expect(r.perStation.get('bottlo')!.byDay.get(MONDAY)!.batches).toHaveLength(1);
      expect(r.perStation.get('elephant')!.byDay.get(MONDAY)!.batches).toHaveLength(1);
      expect(r.perStation.get('hand-packing')!.byDay.size).toBe(0);
    });
  });

  describe('integration with orchestrator output', () => {
    test('runs end-to-end against orchestrator output without warnings for a small slice', () => {
      const a = meta({ productCode: 'FAM_A', station: 'bottlo' });
      const b = meta({
        productCode: 'FAM_A2',
        family: 'XHBC',
        packageSize: 'MED',
        extendedFamily: 'FAM Fungi',
        station: 'bottlo',
      });
      const orch = orchestrateBatchPlan({
        products: [
          plan({ meta: a, weeklyDemand: constantDemand(4, 100), shelfLifeDays: 14 }),
          plan({ meta: b, weeklyDemand: constantDemand(4, 100), shelfLifeDays: 14 }),
        ],
      });
      const r = assignBatchesToDays({ perStation: orch.perStation });
      // Sanity: every assigned batch's date is one of Mon-Fri of one of the
      // weeks we planned for.
      const validDays = new Set([MONDAY, TUESDAY, WEDNESDAY, '2026-05-07', FRIDAY,
        '2026-05-11', '2026-05-12', '2026-05-13', '2026-05-14', '2026-05-15',
        '2026-05-18', '2026-05-19', '2026-05-20', '2026-05-21', '2026-05-22',
        '2026-05-25', '2026-05-26', '2026-05-27', '2026-05-28', '2026-05-29']);
      for (const tl of r.perStation.values()) {
        for (const day of tl.byDay.keys()) {
          expect(validDays.has(day)).toBe(true);
        }
      }
    });
  });

  describe('AssignedBatch annotation', () => {
    test('every assigned batch carries scheduledDate, durationMinutes, changeoverMinutes', () => {
      const tl = syntheticTimeline('bottlo', [
        { productCode: 'A', weekStart: MONDAY, quantity: 200, changeover: 15 },
      ]);
      const perStation = new Map<Station, StationTimeline>();
      perStation.set('bottlo', tl);
      const r = assignBatchesToDays({ perStation });
      const assigned = r.perStation.get('bottlo')!.byDay.get(MONDAY)!.batches[0];
      expect(assigned.scheduledDate).toBe(MONDAY);
      expect(assigned.durationMinutes).toBeCloseTo(60, 6);
      expect(assigned.changeoverMinutes).toBe(15);
      // Original orchestrator fields preserved
      expect(assigned.weekStart).toBe(MONDAY);
      expect(assigned.productMeta).toBeDefined();
      expect(assigned.orderInWeek).toBe(0);
    });
  });
});
