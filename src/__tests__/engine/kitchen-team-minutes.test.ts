import {
  kitchenTeamMinutesFor,
  SOAK_SETUP_MINUTES,
  DEHYD_INIT_MINUTES,
  COOK_MINUTES,
  KITCHEN_DEFAULT_MINUTES,
} from '@/lib/planning/capacity-data';

function intermediate(o: {
  productCode?: string;
  steps?: string[];
  dehydHours?: number | null;
}) {
  return {
    productCode: o.productCode ?? 'X',
    productName: o.productCode ?? 'X',
    processSteps: o.steps ?? [],
    packingStation: null,
    alternateStation: null,
    maxSoakIbc: null,
    maxSoakTub: null,
    maxMixBowl: null,
    ovenCapacityPerDay: null,
    kgPerTray: null,
    dehydHours: o.dehydHours ?? null,
    humidity: null,
    yieldRate: null,
    preferredBatchSize: null,
  };
}

describe('kitchenTeamMinutesFor (non-dehydrator: legacy fixed cost)', () => {
  test('cook only → COOK_MINUTES (no dehyd; quantity ignored)', () => {
    expect(kitchenTeamMinutesFor(intermediate({ steps: ['cook'] }), 1000)).toBe(COOK_MINUTES);
  });

  test('soak only (no dehyd) → SOAK_SETUP_MINUTES', () => {
    expect(kitchenTeamMinutesFor(intermediate({ steps: ['soak'] }))).toBe(SOAK_SETUP_MINUTES);
  });

  test('cook with explicit dehydHours=0 stays in legacy fixed cost path', () => {
    expect(
      kitchenTeamMinutesFor(intermediate({ steps: ['cook'], dehydHours: 0 })),
    ).toBe(COOK_MINUTES);
  });

  test('dehydHours=null treated same as 0 → cook-only fixed cost', () => {
    expect(
      kitchenTeamMinutesFor(intermediate({ steps: ['cook'], dehydHours: null })),
    ).toBe(COOK_MINUTES);
  });

  test('no recognised steps → KITCHEN_DEFAULT_MINUTES fallback', () => {
    expect(kitchenTeamMinutesFor(intermediate({ steps: [] }))).toBe(KITCHEN_DEFAULT_MINUTES);
    expect(kitchenTeamMinutesFor(intermediate({ steps: ['mystery'] }))).toBe(
      KITCHEN_DEFAULT_MINUTES,
    );
  });
});

describe('Phase 4l.10 — dehydrator recipes scale with quantity', () => {
  test('IABR worked example: soak + dehyd × 1200 units → 300 min (0.25 min/unit)', () => {
    // User-confirmed rate: 60 min soak-load + 180 min dehyd-load + 60 min dehyd-unload = 300 for 1200.
    const r = kitchenTeamMinutesFor(
      intermediate({ steps: ['soak', 'mix'], dehydHours: 18 }),
      1200,
    );
    expect(r).toBe(300);
  });

  test('half quantity → half time (linear)', () => {
    const r = kitchenTeamMinutesFor(
      intermediate({ steps: ['soak', 'mix'], dehydHours: 18 }),
      600,
    );
    expect(r).toBe(150);
  });

  test('dehyd only (no soak) → 0.20 min/unit (saves the soak-load 0.05/unit)', () => {
    const r = kitchenTeamMinutesFor(
      intermediate({ steps: ['mix'], dehydHours: 18 }),
      1000,
    );
    expect(r).toBe(200);
  });

  test('zero quantity gracefully floors at 1 min (no zero-cost chips)', () => {
    const r = kitchenTeamMinutesFor(
      intermediate({ steps: ['soak'], dehydHours: 18 }),
      0,
    );
    expect(r).toBe(1);
  });

  test('default quantity (250) used when caller omits it', () => {
    // Legacy callers that don't yet pass quantity get a sensible default
    // matching a typical recipe batch (= preferred-batch nominal).
    const r = kitchenTeamMinutesFor(
      intermediate({ steps: ['soak'], dehydHours: 18 }),
    );
    expect(r).toBe(Math.round(0.25 * 250));
  });

  test('dehydHours present AND cook step → still dehydrator regime (uses rate, not COOK_MINUTES)', () => {
    // Edge case — if a recipe somehow has both, dehyd-presence wins.
    // Legacy DEHYD_INIT_MINUTES const stays exported for back-compat but
    // isn't used by the new formula.
    void DEHYD_INIT_MINUTES;
    const r = kitchenTeamMinutesFor(
      intermediate({ steps: ['soak', 'cook'], dehydHours: 18 }),
      500,
    );
    // 0.25 × 500 = 125 (NOT 525 = SOAK + DEHYD_INIT + COOK)
    expect(r).toBe(125);
  });
});
