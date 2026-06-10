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
    // Forward profitPerItem so per-batch fixtures can drive Phase 4l.9 trim ranking.
    profitPerItem: 'profitPerItem' in o ? o.profitPerItem! : undefined,
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

    test('week overflow: 6th batch is DEFERRED to the next week, not dropped (Phase 4l.14)', () => {
      // 6 batches each 480 min total. Capacity 480/day → 1 fits per day.
      // Days 1-5 take 5 batches; the 6th (trailing, by tiebreak) carries
      // forward to the next week rather than being dropped.
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
      // Nothing dropped — the 6th batch was deferred, not lost.
      expect(r.warnings.filter((w) => w.kind === 'week_overflow')).toHaveLength(0);
      // All 6 still assigned; F lands in the next week (2026-05-11 Monday).
      const dayOf = (code: string): string | null => {
        for (const [day, dl] of bottlo.byDay) {
          if (dl.batches.some((b) => b.productCode === code)) return day;
        }
        return null;
      };
      expect(dayOf('F')).toBe('2026-05-11');
      const all = new Set<string>();
      for (const dl of bottlo.byDay.values()) for (const b of dl.batches) all.add(b.productCode);
      expect(all).toEqual(new Set(['A', 'B', 'C', 'D', 'E', 'F']));
    });

    test('profit-aware trim drops lowest-profit batch first when week overflows (Phase 4l.9)', () => {
      // 6 batches at 480 min each → 2880 min demanded, 2400 available (5 × 480).
      // Profits chosen so the *least* valuable batch is C (not the trailing F).
      // The trim should drop C even though it sits in the middle.
      const profits: Record<string, number> = { A: 10, B: 8, C: 1, D: 9, E: 7, F: 6 };
      const batches = ['A', 'B', 'C', 'D', 'E', 'F'].map((p) => ({
        productCode: p,
        weekStart: MONDAY,
        quantity: 1600, // 480 min production
        changeover: 0,
        productMeta: { profitPerItem: profits[p] },
      }));
      const tl = syntheticTimeline('bottlo', batches);
      const perStation = new Map<Station, StationTimeline>();
      perStation.set('bottlo', tl);
      const r = assignBatchesToDays({ perStation });
      // Phase 4l.14 — the lowest-profit batch (C) is DEFERRED to the next
      // week rather than dropped, so there's no week_overflow warning.
      expect(r.warnings.filter((w) => w.kind === 'week_overflow')).toHaveLength(0);
      const bottlo = r.perStation.get('bottlo')!;
      const dayOf = (code: string): string | null => {
        for (const [day, dl] of bottlo.byDay) {
          if (dl.batches.some((b) => b.productCode === code)) return day;
        }
        return null;
      };
      // C (lowest profit) lands in the next week; the 5 others stay in the
      // MONDAY week (2026-05-04 … 2026-05-08).
      expect(dayOf('C')).toBe('2026-05-11');
      for (const code of ['A', 'B', 'D', 'E', 'F']) {
        expect(dayOf(code)! >= '2026-05-04' && dayOf(code)! <= '2026-05-08').toBe(true);
      }
    });

    test('joint profit × quantity ranking: tiny-demand high-margin survives, low-margin filler drops first', () => {
      // 6 batches × 480 min = 2880 demanded, 2400 capacity → trim 480+ min.
      // HiMargin (small qty, big $/unit) batch profit = 100 × $50 = $5000 over 30 min → $166/min
      // BigDemand batch profit = 1600 × $5 = $8000 over 480 min → $16.7/min
      // The four FillerN priced at $1, $0.7, $0.5, $0.3 per unit (batch profit $1600/$1120/$800/$480 → $3.3 / $2.3 / $1.7 / $1 per min)
      // Ranking ascending: Filler4 (1.0), Filler3 (1.7), Filler2 (2.3), Filler1 (3.3), BigDemand (16.7), HiMargin (166).
      // We need to free ≥ 480 min. Drop Filler4 (480 min) → deficit 0. Single drop.
      const batches = [
        { productCode: 'HiMargin', weekStart: MONDAY, quantity: 100, changeover: 0, productMeta: { profitPerItem: 50 } },
        { productCode: 'BigDemand', weekStart: MONDAY, quantity: 1600, changeover: 0, productMeta: { profitPerItem: 5 } },
        { productCode: 'Filler1', weekStart: MONDAY, quantity: 1600, changeover: 0, productMeta: { profitPerItem: 1 } },
        { productCode: 'Filler2', weekStart: MONDAY, quantity: 1600, changeover: 0, productMeta: { profitPerItem: 0.7 } },
        { productCode: 'Filler3', weekStart: MONDAY, quantity: 1600, changeover: 0, productMeta: { profitPerItem: 0.5 } },
        { productCode: 'Filler4', weekStart: MONDAY, quantity: 1600, changeover: 0, productMeta: { profitPerItem: 0.3 } },
      ];
      const tl = syntheticTimeline('bottlo', batches);
      const perStation = new Map<Station, StationTimeline>();
      perStation.set('bottlo', tl);
      const r = assignBatchesToDays({ perStation });
      // Phase 4l.14 — Filler4 (lowest $/min) is DEFERRED to the next week,
      // not dropped; HiMargin and BigDemand keep their MONDAY-week slots.
      expect(r.warnings.filter((w) => w.kind === 'week_overflow')).toHaveLength(0);
      const bottlo = r.perStation.get('bottlo')!;
      const dayOf = (code: string): string | null => {
        for (const [day, dl] of bottlo.byDay) {
          if (dl.batches.some((b) => b.productCode === code)) return day;
        }
        return null;
      };
      expect(dayOf('Filler4')).toBe('2026-05-11');
      expect(dayOf('HiMargin')! <= '2026-05-08').toBe(true);
      expect(dayOf('BigDemand')! <= '2026-05-08').toBe(true);
    });

    test('SKUs with no profit data drop first when overflowing (Phase 4l.9)', () => {
      // 6 batches each 480 min total, capacity 2400. Must drop one.
      // A-E priced, F has null profitPerItem → ranks at $0/min → drops first.
      const batches = ['A', 'B', 'C', 'D', 'E', 'F'].map((p, i) => ({
        productCode: p,
        weekStart: MONDAY,
        quantity: 1600,
        changeover: 0,
        productMeta: p === 'F' ? { profitPerItem: null } : { profitPerItem: 10 - i },
      }));
      const tl = syntheticTimeline('bottlo', batches);
      const perStation = new Map<Station, StationTimeline>();
      perStation.set('bottlo', tl);
      const r = assignBatchesToDays({ perStation });
      // Phase 4l.14 — the no-profit SKU (F) is deferred first, landing in the
      // next week rather than being dropped. No week_overflow warning fires
      // because it was placed.
      expect(r.warnings.filter((w) => w.kind === 'week_overflow')).toHaveLength(0);
      const bottlo = r.perStation.get('bottlo')!;
      const dayOf = (code: string): string | null => {
        for (const [day, dl] of bottlo.byDay) {
          if (dl.batches.some((b) => b.productCode === code)) return day;
        }
        return null;
      };
      expect(dayOf('F')).toBe('2026-05-11');
      for (const code of ['A', 'B', 'C', 'D', 'E']) {
        expect(dayOf(code)! <= '2026-05-08').toBe(true);
      }
    });

    test('cascading overflow defers across weeks until capacity absorbs it (Phase 4l.14)', () => {
      // 7 batches × 480 min in ONE week; week capacity = 2400 (5 days). 5 fit
      // the MONDAY week, the 2 trailing batches cascade into the next week.
      const batches = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((p) => ({
        productCode: p,
        weekStart: MONDAY,
        quantity: 1600, // 480 min
        changeover: 0,
      }));
      const tl = syntheticTimeline('bottlo', batches);
      const perStation = new Map<Station, StationTimeline>();
      perStation.set('bottlo', tl);
      const r = assignBatchesToDays({ perStation });
      // Nothing dropped — both overflow batches were deferred.
      expect(r.warnings.filter((w) => w.kind === 'week_overflow')).toHaveLength(0);
      const bottlo = r.perStation.get('bottlo')!;
      let w1 = 0;
      let w2 = 0;
      const all = new Set<string>();
      for (const [day, dl] of bottlo.byDay) {
        for (const b of dl.batches) {
          all.add(b.productCode);
          if (day <= '2026-05-08') w1 += 1;
          else w2 += 1;
        }
      }
      expect(all.size).toBe(7); // every batch placed
      expect(w1).toBe(5); // MONDAY week saturated at 5
      expect(w2).toBe(2); // remainder pushed to the next week
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
