import {
  forecastWeeklyDemand,
  defaultHorizon,
} from '@/lib/planning/forecast-demand';
import type { Demand } from '@/lib/planning/demand';
import type { PlanningHorizon } from '@/lib/planning/engine-io';

// All tests use a fixed Monday so the assertions are deterministic regardless
// of when the suite runs. 2026-05-04 is a Monday.
const MONDAY: string = '2026-05-04';

function horizon(weeks: number, startWeek: string = MONDAY): PlanningHorizon {
  return { startWeek, weeks };
}

function packagingEvent(
  productCode: string,
  needByDate: string,
  quantityNeeded: number,
): Demand {
  return {
    productCode,
    quantityNeeded,
    needByDate,
    destinationWarehouse: 'MF_PACKAGING',
    source: { type: 'packaging_run', runId: `${needByDate}-${productCode}`, runName: 'test' },
  };
}

describe('forecastWeeklyDemand', () => {
  describe('empty / boundary inputs', () => {
    test('returns empty array when there are no rates and no events', () => {
      const out = forecastWeeklyDemand({
        monthlyRates: {},
        events: [],
        horizon: horizon(12),
      });
      expect(out).toEqual([]);
    });

    test('returns empty array when horizon.weeks is 0', () => {
      const out = forecastWeeklyDemand({
        monthlyRates: { SKU1: 100 },
        events: [packagingEvent('SKU1', MONDAY, 50)],
        horizon: horizon(0),
      });
      expect(out).toEqual([]);
    });

    test('throws when startWeek is not a Monday', () => {
      // 2026-05-05 is a Tuesday
      expect(() =>
        forecastWeeklyDemand({
          monthlyRates: { SKU1: 100 },
          events: [],
          horizon: horizon(4, '2026-05-05'),
        }),
      ).toThrow(/Monday/);
    });

    test('skips products with zero or negative monthly rate', () => {
      const out = forecastWeeklyDemand({
        monthlyRates: { SKU1: 0, SKU2: -10 },
        events: [],
        horizon: horizon(4),
      });
      expect(out).toEqual([]);
    });
  });

  describe('rate-only behaviour', () => {
    test('distributes monthly rate evenly across all weeks of the horizon', () => {
      const out = forecastWeeklyDemand({
        monthlyRates: { SKU1: 100 }, // monthly rate
        events: [],
        horizon: horizon(12),
      });
      expect(out).toHaveLength(12);
      // Per-week qty = 100 * 12 / 52 ≈ 23.0769...
      const expectedWeekly = (100 * 12) / 52;
      for (const row of out) {
        expect(row.productCode).toBe('SKU1');
        expect(row.sources).toEqual(['rate']);
        expect(row.quantity).toBeCloseTo(expectedWeekly, 6);
      }
    });

    test('totals across the horizon equal monthlyRate × (weeks × 12 / 52)', () => {
      const out = forecastWeeklyDemand({
        monthlyRates: { SKU1: 130 }, // chosen so 130 * 12 / 52 = exactly 30
        events: [],
        horizon: horizon(4),
      });
      expect(out).toHaveLength(4);
      const total = out.reduce((s, r) => s + r.quantity, 0);
      expect(total).toBeCloseTo(120, 6); // 30 per week × 4 weeks
    });
  });

  describe('event-only behaviour', () => {
    test('event lands in the week containing its needByDate', () => {
      const out = forecastWeeklyDemand({
        monthlyRates: {},
        events: [packagingEvent('SKU1', '2026-05-13', 40)], // Wed of week 1
        horizon: horizon(4),
      });
      expect(out).toHaveLength(1);
      expect(out[0]).toEqual({
        productCode: 'SKU1',
        weekStart: '2026-05-11', // Monday of that week
        quantity: 40,
        sources: ['event'],
      });
    });

    test('multiple events in the same week sum into one row', () => {
      const out = forecastWeeklyDemand({
        monthlyRates: {},
        events: [
          packagingEvent('SKU1', '2026-05-04', 10),
          packagingEvent('SKU1', '2026-05-06', 25),
          packagingEvent('SKU1', '2026-05-08', 5),
        ],
        horizon: horizon(2),
      });
      expect(out).toHaveLength(1);
      expect(out[0].quantity).toBe(40);
      expect(out[0].sources).toEqual(['event']);
    });

    test('Phase 4l.10: past-due events bucket into week 0; future out-of-horizon still dropped', () => {
      // Past-due commitments are real obligations — make them ASAP, don't
      // drop. Future out-of-horizon events stay dropped (we'll plan them in
      // a future re-plan when they enter the horizon window).
      const out = forecastWeeklyDemand({
        monthlyRates: {},
        events: [
          packagingEvent('SKU1', '2026-04-27', 100), // past-due (was dropped)
          packagingEvent('SKU2', '2026-06-01', 200), // after a 2-week horizon → still dropped
          packagingEvent('SKU3', '2026-05-06', 50), // inside
        ],
        horizon: horizon(2),
      });
      const codes = out.map((r) => r.productCode).sort();
      expect(codes).toEqual(['SKU1', 'SKU3']);
      const sku1Row = out.find((r) => r.productCode === 'SKU1')!;
      expect(sku1Row.weekStart).toBe('2026-05-04'); // first horizon week
      expect(sku1Row.quantity).toBe(100);
      const sku3Row = out.find((r) => r.productCode === 'SKU3')!;
      expect(sku3Row.quantity).toBe(50);
    });

    test('weekend needByDate buckets to upcoming Monday (matches mondayOf rule)', () => {
      const out = forecastWeeklyDemand({
        monthlyRates: {},
        events: [packagingEvent('SKU1', '2026-05-10', 30)], // Sunday
        horizon: horizon(4),
      });
      // Sunday 2026-05-10 → upcoming Monday 2026-05-11
      expect(out[0].weekStart).toBe('2026-05-11');
    });
  });

  describe('blended rate + event behaviour', () => {
    test("week with both rate and event has sources=['rate','event'] and summed quantity", () => {
      const out = forecastWeeklyDemand({
        monthlyRates: { SKU1: 130 }, // 30/week
        events: [packagingEvent('SKU1', '2026-05-06', 50)], // week 0
        horizon: horizon(4),
      });
      expect(out).toHaveLength(4);
      const week0 = out.find((r) => r.weekStart === MONDAY)!;
      expect(week0.sources).toEqual(['rate', 'event']);
      expect(week0.quantity).toBeCloseTo(80, 6); // 30 rate + 50 event

      // Other weeks have rate only
      for (const row of out.filter((r) => r.weekStart !== MONDAY)) {
        expect(row.sources).toEqual(['rate']);
        expect(row.quantity).toBeCloseTo(30, 6);
      }
    });

    test('event for a product without a rate produces an event-only row', () => {
      const out = forecastWeeklyDemand({
        monthlyRates: { SKU1: 130 },
        events: [packagingEvent('SKU2', '2026-05-06', 75)],
        horizon: horizon(2),
      });
      const sku2Rows = out.filter((r) => r.productCode === 'SKU2');
      expect(sku2Rows).toHaveLength(1);
      expect(sku2Rows[0].sources).toEqual(['event']);
      expect(sku2Rows[0].quantity).toBe(75);
    });
  });

  describe('output shape', () => {
    test('returns rows in deterministic order: productCode asc, weekStart asc', () => {
      const out = forecastWeeklyDemand({
        monthlyRates: { ZULU: 100, ALPHA: 100 },
        events: [],
        horizon: horizon(3),
      });
      // First three rows should all be ALPHA, in chronological week order
      expect(out.slice(0, 3).map((r) => r.productCode)).toEqual([
        'ALPHA',
        'ALPHA',
        'ALPHA',
      ]);
      expect(out.slice(0, 3).map((r) => r.weekStart)).toEqual([
        '2026-05-04',
        '2026-05-11',
        '2026-05-18',
      ]);
      expect(out.slice(3).map((r) => r.productCode)).toEqual([
        'ZULU',
        'ZULU',
        'ZULU',
      ]);
    });

    test('omits zero-quantity rows entirely (no spurious empty buckets)', () => {
      // Single event in week 0, no rate. Weeks 1–3 should not appear.
      const out = forecastWeeklyDemand({
        monthlyRates: {},
        events: [packagingEvent('SKU1', MONDAY, 10)],
        horizon: horizon(4),
      });
      expect(out).toHaveLength(1);
      expect(out[0].weekStart).toBe(MONDAY);
    });
  });

  describe('defaultHorizon', () => {
    test('produces a Monday startWeek and the requested number of weeks', () => {
      const h = defaultHorizon(8, new Date('2026-05-07T10:00:00')); // Thursday
      expect(h.weeks).toBe(8);
      // Monday of that week is 2026-05-04
      expect(h.startWeek).toBe('2026-05-04');
    });

    test('defaults to a 12-week horizon', () => {
      const h = defaultHorizon(undefined, new Date('2026-05-04T00:00:00'));
      expect(h.weeks).toBe(12);
    });

    test('weekend dates roll forward to upcoming Monday', () => {
      // Sunday 2026-05-10 → upcoming Monday 2026-05-11
      const h = defaultHorizon(4, new Date('2026-05-10T12:00:00'));
      expect(h.startWeek).toBe('2026-05-11');
    });
  });
});
