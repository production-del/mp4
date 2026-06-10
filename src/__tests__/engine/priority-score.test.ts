import {
  scoreAssembly,
  criticalRatioUrgency,
  stockoutRisk,
  DEFAULT_WEIGHTS,
  DEFAULT_ABILITY_FLOORS,
  RECOMMENDED_ABILITY_FLOORS,
} from '@/lib/engine/priority-score';

// ─── The safety guarantee: defaults reproduce today's ranking ──

describe('scoreAssembly — default weights reproduce the current profit ranking', () => {
  test('score === the profit basis the caller passes (per-unit, supply-cap)', () => {
    expect(scoreAssembly({ profit: 5.4 }).score).toBe(5.4);
    expect(scoreAssembly({ profit: 2.1 }).score).toBe(2.1);
  });

  test('score === profit-per-minute when the caller passes that basis (day-assigner)', () => {
    const ppm = (3.0 * 100) / 250; // profitPerItem × qty / minutes
    expect(scoreAssembly({ profit: ppm }).score).toBeCloseTo(ppm, 10);
  });

  test('null / undefined / NaN profit ranks as 0 (today behaviour)', () => {
    expect(scoreAssembly({ profit: null }).score).toBe(0);
    expect(scoreAssembly({ profit: undefined }).score).toBe(0);
    expect(scoreAssembly({ profit: NaN }).score).toBe(0);
  });

  test('relative order under defaults matches sorting by raw profit', () => {
    const chips = [{ p: 2.1 }, { p: 5.4 }, { p: null as number | null }, { p: 3.3 }];
    const ranked = chips
      .map((c) => ({ c, s: scoreAssembly({ profit: c.p }).score }))
      .sort((a, b) => b.s - a.s)
      .map((x) => x.c.p);
    expect(ranked).toEqual([5.4, 3.3, 2.1, null]);
  });

  test('defaults: ability is exactly 1 even for amber/red (gate off)', () => {
    expect(scoreAssembly({ profit: 4, feasibility: 'amber' }).ability).toBe(1);
    expect(scoreAssembly({ profit: 4, feasibility: 'red' }).ability).toBe(1);
    expect(scoreAssembly({ profit: 4, feasibility: 'red' }).score).toBe(4);
  });

  test('exported defaults are profit-only / gate-off', () => {
    expect(DEFAULT_WEIGHTS).toEqual({ profit: 1, urgency: 0, stockout: 0, manual: 0 });
    expect(DEFAULT_ABILITY_FLOORS).toEqual({ amber: 1, red: 1 });
  });
});

// ─── Ability gate (opt-in) ───────────────────────────────────

describe('scoreAssembly — ability gate', () => {
  test('gate-by-multiply: recommended floors scale a red item down', () => {
    const r = scoreAssembly({
      profit: 10,
      feasibility: 'red',
      abilityFloors: RECOMMENDED_ABILITY_FLOORS,
    });
    expect(r.ability).toBe(0.2);
    expect(r.score).toBeCloseTo(2.0, 10);
    expect(r.abilityBinding).toBe('feasibility');
  });

  test('ability = 0 (floor red:0) zeroes the score regardless of profit', () => {
    const r = scoreAssembly({ profit: 999, feasibility: 'red', abilityFloors: { red: 0 } });
    expect(r.ability).toBe(0);
    expect(r.score).toBe(0);
  });

  test('capacityFit binds ability when it is the smaller factor', () => {
    const r = scoreAssembly({ profit: 8, feasibility: 'green', capacityFit: 0.5 });
    expect(r.ability).toBe(0.5);
    expect(r.score).toBe(4);
    expect(r.abilityBinding).toBe('capacity');
  });

  test('capacityFit is clamped to 0..1', () => {
    expect(scoreAssembly({ profit: 8, capacityFit: 2 }).ability).toBe(1);
    expect(scoreAssembly({ profit: 8, capacityFit: -1 }).ability).toBe(0);
  });

  test('a higher-profit unmakeable item loses to a lower-profit makeable one', () => {
    const floors = RECOMMENDED_ABILITY_FLOORS;
    const big = scoreAssembly({ profit: 10, feasibility: 'red', abilityFloors: floors }).score; // 2.0
    const small = scoreAssembly({ profit: 4, feasibility: 'green', abilityFloors: floors }).score; // 4.0
    expect(small).toBeGreaterThan(big);
  });
});

// ─── Priority factors (opt-in via weights) ───────────────────

describe('scoreAssembly — priority factors', () => {
  test('urgency contributes only when weighted', () => {
    const off = scoreAssembly({ profit: 1, urgency: 1 });
    expect(off.score).toBe(1); // default urgency weight 0
    const on = scoreAssembly({ profit: 1, urgency: 1, weights: { urgency: 3 } });
    expect(on.score).toBe(1 + 3); // profit 1 + urgency 1×3
  });

  test('urgency derived from dueDate/today when not given explicitly', () => {
    const overdue = scoreAssembly({
      profit: 0,
      dueDate: '2026-06-01',
      today: '2026-06-05',
      weights: { urgency: 1 },
    });
    expect(overdue.factors.urgency.raw).toBe(1);
  });

  test('explicit urgency overrides the date-derived value', () => {
    const r = scoreAssembly({
      profit: 0,
      urgency: 0.25,
      dueDate: '2026-06-01',
      today: '2026-06-05',
      weights: { urgency: 1 },
    });
    expect(r.factors.urgency.raw).toBe(0.25);
  });

  test('stockout: backorder = 1; manual flag adds when weighted', () => {
    const so = scoreAssembly({ profit: 0, availableStock: -5, weights: { stockout: 2 } });
    expect(so.factors.stockout.raw).toBe(1);
    expect(so.score).toBe(2);

    const man = scoreAssembly({ profit: 1, manual: true, weights: { manual: 5 } });
    expect(man.score).toBe(1 + 5);
  });

  test('profitScale lifts 0..1 factors onto the profit magnitude', () => {
    const r = scoreAssembly({
      profit: 0,
      urgency: 1,
      weights: { urgency: 1 },
      profitScale: 10,
    });
    expect(r.score).toBe(10);
  });

  test('dominantFactor reports the largest weighted contributor', () => {
    const profitWins = scoreAssembly({ profit: 100, urgency: 1, weights: { urgency: 1 } });
    expect(profitWins.dominantFactor).toBe('profit');

    const urgencyWins = scoreAssembly({
      profit: 1,
      urgency: 1,
      weights: { urgency: 50 },
    });
    expect(urgencyWins.dominantFactor).toBe('urgency');
  });
});

// ─── Helpers ─────────────────────────────────────────────────

describe('criticalRatioUrgency', () => {
  test('overdue or due today → 1', () => {
    expect(criticalRatioUrgency('2026-06-01', '2026-06-01')).toBe(1);
    expect(criticalRatioUrgency('2026-05-30', '2026-06-01')).toBe(1);
  });
  test('beyond the horizon → 0', () => {
    expect(criticalRatioUrgency('2026-07-01', '2026-06-01', 14)).toBe(0);
  });
  test('mid-horizon → linear between 0 and 1', () => {
    // 7 days out on a 14-day horizon → 0.5
    expect(criticalRatioUrgency('2026-06-08', '2026-06-01', 14)).toBeCloseTo(0.5, 6);
  });
  test('non-positive horizon → 0 (guard)', () => {
    expect(criticalRatioUrgency('2026-06-08', '2026-06-01', 0)).toBe(0);
  });
});

describe('stockoutRisk', () => {
  test('backorder → 1', () => {
    expect(stockoutRisk(-3)).toBe(1);
  });
  test('coverDays scales toward targetCoverDays', () => {
    expect(stockoutRisk(undefined, 7, 14)).toBeCloseTo(0.5, 6);
    expect(stockoutRisk(undefined, 0, 14)).toBe(1);
    expect(stockoutRisk(undefined, 28, 14)).toBe(0);
  });
  test('no signal → 0', () => {
    expect(stockoutRisk()).toBe(0);
  });
});
