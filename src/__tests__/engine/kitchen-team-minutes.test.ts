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
  };
}

describe('kitchenTeamMinutesFor', () => {
  test('cook only → COOK_MINUTES', () => {
    expect(kitchenTeamMinutesFor(intermediate({ steps: ['cook'] }))).toBe(COOK_MINUTES);
  });

  test('soak only → SOAK_SETUP_MINUTES (no cook, no dehyd)', () => {
    expect(kitchenTeamMinutesFor(intermediate({ steps: ['soak'] }))).toBe(SOAK_SETUP_MINUTES);
  });

  test('dehyd only (hours > 0) → DEHYD_INIT_MINUTES', () => {
    expect(
      kitchenTeamMinutesFor(intermediate({ steps: [], dehydHours: 12 })),
    ).toBe(DEHYD_INIT_MINUTES);
  });

  test('soak + dehyd + cook stack', () => {
    expect(
      kitchenTeamMinutesFor(
        intermediate({ steps: ['soak', 'cook'], dehydHours: 24 }),
      ),
    ).toBe(SOAK_SETUP_MINUTES + DEHYD_INIT_MINUTES + COOK_MINUTES);
  });

  test('case-insensitive step matching', () => {
    expect(
      kitchenTeamMinutesFor(intermediate({ steps: ['SOAK', 'COOK'] })),
    ).toBe(SOAK_SETUP_MINUTES + COOK_MINUTES);
  });

  test('substring match: "pre-soak" counts as soak', () => {
    expect(
      kitchenTeamMinutesFor(intermediate({ steps: ['pre-soak'] })),
    ).toBe(SOAK_SETUP_MINUTES);
  });

  test('dehydHours = 0 does NOT add the dehyd init cost', () => {
    expect(
      kitchenTeamMinutesFor(intermediate({ steps: ['cook'], dehydHours: 0 })),
    ).toBe(COOK_MINUTES);
  });

  test('dehydHours = null does NOT add the dehyd init cost', () => {
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
