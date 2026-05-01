import {
  balanceStationLoads,
  type ProductRouting,
} from '@/lib/engine/load-balancer';
import type { CandidateEvaluation } from '@/lib/engine/station-router';
import type { Station } from '@/lib/planning/engine-io';
import type { StationDefaults } from '@/lib/planning/capacity-data';

const DEFAULTS: Record<Station, StationDefaults> = {
  'hand-packing': { staffNeeded: 3, hoursPerDay: 8, unitsPerHour: 200 },
  elephant: { staffNeeded: 3, hoursPerDay: 8, unitsPerHour: 187.5 },
  dust: { staffNeeded: 3, hoursPerDay: 8, unitsPerHour: 187.5 },
  bottlo: { staffNeeded: 5, hoursPerDay: 8, unitsPerHour: 375 },
};

// Each station has horizon capacity = 8h × 60 × 5 days × 12 weeks = 28800 min.

function ev(
  station: Station,
  productionMinutes: number,
  changeoverMinutes = 0,
): CandidateEvaluation {
  return {
    station,
    productionMinutes,
    changeoverMinutes,
    totalMinutes: productionMinutes + changeoverMinutes,
    estimatedBatches: 1,
  };
}

function routing(
  productCode: string,
  current: Station,
  evals: CandidateEvaluation[],
): ProductRouting {
  return { productCode, currentStation: current, evaluations: evals };
}

describe('balanceStationLoads', () => {
  describe('no redistribution needed', () => {
    test('all stations under threshold → no moves', () => {
      const r = balanceStationLoads({
        routings: [
          routing('A', 'bottlo', [ev('bottlo', 1000), ev('elephant', 1500)]),
        ],
        stationDefaults: DEFAULTS,
        horizonWeeks: 12,
      });
      expect(r.redistributions).toEqual([]);
      expect(r.routings[0].currentStation).toBe('bottlo');
    });

    test('empty routings → empty output', () => {
      const r = balanceStationLoads({
        routings: [],
        stationDefaults: DEFAULTS,
        horizonWeeks: 12,
      });
      expect(r.redistributions).toEqual([]);
      expect(r.routings).toEqual([]);
    });
  });

  describe('redistributes from over-subscribed stations', () => {
    test('one heavy product on bottlo over threshold → moves the cheapest-penalty candidate', () => {
      // bottlo capacity 28800 min, threshold 0.85 → 24480 min cap.
      // Two products on bottlo, total 27000 min; over by 2520.
      // Product A has cheaper alternate (penalty +500), B has worse (+2000).
      // Expect A to move.
      const r = balanceStationLoads({
        routings: [
          routing('A', 'bottlo', [ev('bottlo', 12000), ev('elephant', 12500)]),
          routing('B', 'bottlo', [ev('bottlo', 15000), ev('elephant', 17000)]),
        ],
        stationDefaults: DEFAULTS,
        horizonWeeks: 12,
      });
      expect(r.redistributions).toHaveLength(1);
      expect(r.redistributions[0].productCode).toBe('A');
      expect(r.redistributions[0].fromStation).toBe('bottlo');
      expect(r.redistributions[0].toStation).toBe('elephant');
      expect(r.routings.find((x) => x.productCode === 'A')!.currentStation).toBe('elephant');
      expect(r.routings.find((x) => x.productCode === 'B')!.currentStation).toBe('bottlo');
    });

    test('redistributes multiple until station drops below threshold', () => {
      // bottlo over by a lot — needs multiple moves.
      const r = balanceStationLoads({
        routings: [
          routing('A', 'bottlo', [ev('bottlo', 8000), ev('elephant', 8500)]),
          routing('B', 'bottlo', [ev('bottlo', 9000), ev('elephant', 9700)]),
          routing('C', 'bottlo', [ev('bottlo', 10000), ev('elephant', 11500)]),
        ],
        stationDefaults: DEFAULTS,
        horizonWeeks: 12,
      });
      // Total bottlo: 27000 min, cap at 0.85 = 24480. Over by 2520.
      // Penalties: A=500, B=700, C=1500. Move A first (drops bottlo by 8000 → 19000).
      // 19000/28800 = 66% — well under threshold. Stop.
      expect(r.redistributions).toHaveLength(1);
      expect(r.redistributions[0].productCode).toBe('A');
    });

    test('skips moves that would push the destination over threshold', () => {
      // bottlo overloaded; elephant nearly full too.
      const r = balanceStationLoads({
        routings: [
          // bottlo total 27000 (over)
          routing('A', 'bottlo', [ev('bottlo', 12000), ev('elephant', 12500)]),
          routing('B', 'bottlo', [ev('bottlo', 15000), ev('elephant', 16000)]),
          // elephant baseline 22000 (already at 76%; A's 12500 would take it to 34500, over cap)
          routing('PRE_E', 'elephant', [ev('elephant', 22000)]),
        ],
        stationDefaults: DEFAULTS,
        horizonWeeks: 12,
      });
      // No move possible — elephant can't absorb either A or B without going over.
      expect(r.redistributions).toEqual([]);
      expect(r.routings.find((x) => x.productCode === 'A')!.currentStation).toBe('bottlo');
    });
  });

  describe('output shape', () => {
    test('stationLoad reports utilisation for every station with defaults', () => {
      const r = balanceStationLoads({
        routings: [
          routing('A', 'bottlo', [ev('bottlo', 1000)]),
        ],
        stationDefaults: DEFAULTS,
        horizonWeeks: 12,
      });
      expect(Object.keys(r.stationLoad).sort()).toEqual([
        'bottlo',
        'dust',
        'elephant',
        'hand-packing',
      ]);
      expect(r.stationLoad['bottlo'].requestedMinutes).toBe(1000);
      expect(r.stationLoad['bottlo'].capacityMinutes).toBe(28800);
      expect(r.stationLoad['bottlo'].utilisation).toBeCloseTo(1000 / 28800, 6);
    });

    test('redistribution records carry meaningful fields', () => {
      const r = balanceStationLoads({
        routings: [
          routing('A', 'bottlo', [ev('bottlo', 12000), ev('elephant', 12300)]),
          routing('B', 'bottlo', [ev('bottlo', 15000), ev('elephant', 17000)]),
        ],
        stationDefaults: DEFAULTS,
        horizonWeeks: 12,
      });
      expect(r.redistributions).toHaveLength(1);
      const rec = r.redistributions[0];
      expect(rec.fromStation).toBe('bottlo');
      expect(rec.toStation).toBe('elephant');
      expect(rec.costPenaltyMinutes).toBe(300);
      expect(rec.reason).toMatch(/over-subscribed/i);
    });
  });

  describe('threshold tuning', () => {
    test('higher threshold = fewer moves', () => {
      // Same input, but threshold=1.0 (only redistribute on actual overrun).
      const tight = balanceStationLoads({
        routings: [
          routing('A', 'bottlo', [ev('bottlo', 12000), ev('elephant', 12500)]),
          routing('B', 'bottlo', [ev('bottlo', 14000), ev('elephant', 15500)]),
        ],
        stationDefaults: DEFAULTS,
        horizonWeeks: 12,
        threshold: 1.0,
      });
      // 26000/28800 = 90% — under 100% threshold. No move.
      expect(tight.redistributions).toEqual([]);
    });

    test('lower threshold = more aggressive redistribution', () => {
      const inputs = {
        routings: [
          routing('A', 'bottlo', [ev('bottlo', 8000), ev('elephant', 8500)]),
          routing('B', 'bottlo', [ev('bottlo', 14000), ev('elephant', 15000)]),
        ],
        stationDefaults: DEFAULTS,
        horizonWeeks: 12,
      };
      // Total bottlo 22000 / 28800 = 76%.
      const lenient = balanceStationLoads({ ...inputs, threshold: 0.85 });
      expect(lenient.redistributions).toEqual([]);

      // Strict threshold (0.5 = 14400 min cap) fires a redistribution.
      // A is the lower-penalty candidate (+500 vs B's +1000) → A moves.
      // After: bottlo 14000 (≤ 14400), stop.
      const strict = balanceStationLoads({ ...inputs, threshold: 0.5 });
      expect(strict.redistributions).toHaveLength(1);
      expect(strict.redistributions[0].productCode).toBe('A');
    });
  });
});
