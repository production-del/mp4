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
  preferredBatchSize?: number | null;
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
    preferredBatchSize: o.preferredBatchSize ?? null,
  };
}

describe('kitchenTeamMinutesFor (non-dehydrator: cook/default scale with quantity — Phase 4l.14)', () => {
  // Cook & default recipes now scale linearly (half batch = half the time).
  // Reference batch = preferredBatchSize when set, else a nominal 250, so a
  // full reference batch costs the legacy flat figure.
  test('cook scales linearly; a 250-unit nominal batch = COOK_MINUTES', () => {
    expect(kitchenTeamMinutesFor(intermediate({ steps: ['cook'] }), 250)).toBe(COOK_MINUTES);
    expect(kitchenTeamMinutesFor(intermediate({ steps: ['cook'] }), 125)).toBe(
      Math.round(COOK_MINUTES / 2),
    );
    expect(kitchenTeamMinutesFor(intermediate({ steps: ['cook'] }), 500)).toBe(COOK_MINUTES * 2);
  });

  test('cook uses preferredBatchSize as the reference when set (full batch = COOK_MINUTES)', () => {
    const i = intermediate({ steps: ['cook'], preferredBatchSize: 270 });
    expect(kitchenTeamMinutesFor(i, 270)).toBe(COOK_MINUTES); // full batch
    expect(kitchenTeamMinutesFor(i, 135)).toBe(Math.round(COOK_MINUTES / 2)); // half
    expect(kitchenTeamMinutesFor(i, 18)).toBe(Math.round((COOK_MINUTES / 270) * 18)); // sub-batch shard
  });

  test('soak only (no dehyd) → flat SOAK_SETUP_MINUTES (setup cost, not size-scaled)', () => {
    expect(kitchenTeamMinutesFor(intermediate({ steps: ['soak'] }))).toBe(SOAK_SETUP_MINUTES);
  });

  test('cook with dehydHours=0 stays in the non-dehydrator (scaled) path', () => {
    // Default quantity 250 against the nominal 250 reference = COOK_MINUTES.
    expect(
      kitchenTeamMinutesFor(intermediate({ steps: ['cook'], dehydHours: 0 })),
    ).toBe(COOK_MINUTES);
  });

  test('dehydHours=null treated same as 0 → cook (scaled) path', () => {
    expect(
      kitchenTeamMinutesFor(intermediate({ steps: ['cook'], dehydHours: null })),
    ).toBe(COOK_MINUTES);
  });

  test('no recognised steps → KITCHEN_DEFAULT_MINUTES scaled (250 nominal = default)', () => {
    expect(kitchenTeamMinutesFor(intermediate({ steps: [] }), 250)).toBe(KITCHEN_DEFAULT_MINUTES);
    expect(kitchenTeamMinutesFor(intermediate({ steps: ['mystery'] }), 125)).toBe(
      Math.round(KITCHEN_DEFAULT_MINUTES / 2),
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
