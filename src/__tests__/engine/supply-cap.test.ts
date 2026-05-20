import { applySupplyCaps } from '@/lib/engine/supply-cap';

// ─── Fixture helpers ─────────────────────────────────────────

function chip(
  stableId: string,
  productCode: string,
  quantity: number,
  profitPerItem: number | null = 1,
  date = '2026-06-01',
) {
  return { stableId, productCode, quantity, profitPerItem, date };
}

// ─── Tests ───────────────────────────────────────────────────

describe('applySupplyCaps', () => {
  test('no shortage → no caps', () => {
    const r = applySupplyCaps({
      packagingChips: [
        chip('a', 'MFA', 100, 2),
        chip('b', 'MFB', 50, 3),
      ],
      consumesQtyMap: {
        MFA: { IABKBR: 0.5 },
        MFB: { IABKBR: 0.3 },
      },
      intermediateOutputSupply: { IABKBR: 1000 },
    });
    expect(r.caps.size).toBe(0);
  });

  test('shortage → highest-profit chip keeps full qty, lowest gets capped', () => {
    // 2 chips compete for 50kg of IABKBR.
    //   MFA × 100 × 0.5 = 50kg needed, profit $5/unit
    //   MFB × 100 × 0.5 = 50kg needed, profit $1/unit
    // Supply 50kg → MFA wins full allocation, MFB caps to 0.
    const r = applySupplyCaps({
      packagingChips: [
        chip('a', 'MFA', 100, 5),
        chip('b', 'MFB', 100, 1),
      ],
      consumesQtyMap: {
        MFA: { IABKBR: 0.5 },
        MFB: { IABKBR: 0.5 },
      },
      intermediateOutputSupply: { IABKBR: 50 },
    });
    expect(r.caps.get('a')).toBeUndefined(); // full allocation
    expect(r.caps.get('b')).toEqual({
      cappedQuantity: 0,
      capFrom: 100,
      capCode: 'IABKBR',
    });
  });

  test('partial allocation: the first chip that doesnt fit gets the remainder', () => {
    // 3 chips, supply 70kg.
    //   A: 50kg need, profit $5  → gets 50kg, full
    //   B: 50kg need, profit $3  → gets 20kg remainder, capped to floor(20/0.5)=40 units
    //   C: 50kg need, profit $1  → 0 supply left, capped to 0
    const r = applySupplyCaps({
      packagingChips: [
        chip('a', 'MFA', 100, 5),
        chip('b', 'MFB', 100, 3),
        chip('c', 'MFC', 100, 1),
      ],
      consumesQtyMap: {
        MFA: { IABKBR: 0.5 },
        MFB: { IABKBR: 0.5 },
        MFC: { IABKBR: 0.5 },
      },
      intermediateOutputSupply: { IABKBR: 70 },
    });
    expect(r.caps.get('a')).toBeUndefined();
    expect(r.caps.get('b')).toEqual({
      cappedQuantity: 40,
      capFrom: 100,
      capCode: 'IABKBR',
    });
    expect(r.caps.get('c')).toEqual({
      cappedQuantity: 0,
      capFrom: 100,
      capCode: 'IABKBR',
    });
  });

  test('null profit ranks last (drops first)', () => {
    // Two chips: priced ($5) vs unpriced (null). Supply covers only one.
    const r = applySupplyCaps({
      packagingChips: [
        chip('priced', 'MFA', 100, 5),
        chip('unpriced', 'MFB', 100, null),
      ],
      consumesQtyMap: {
        MFA: { IABKBR: 0.5 },
        MFB: { IABKBR: 0.5 },
      },
      intermediateOutputSupply: { IABKBR: 50 },
    });
    expect(r.caps.get('priced')).toBeUndefined();
    expect(r.caps.get('unpriced')?.cappedQuantity).toBe(0);
  });

  test('chip with no BOM reference to the short intermediate is untouched', () => {
    const r = applySupplyCaps({
      packagingChips: [
        chip('drains', 'MFA', 100, 5), // consumes IABKBR
        chip('unrelated', 'MFB', 100, 1), // consumes ISBR (not short)
      ],
      consumesQtyMap: {
        MFA: { IABKBR: 0.5 },
        MFB: { ISBR: 0.3 },
      },
      intermediateOutputSupply: { IABKBR: 10 }, // very short
    });
    expect(r.caps.get('unrelated')).toBeUndefined();
    expect(r.caps.get('drains')).toBeDefined();
  });

  test('chip capped by two intermediates → takes the lower (min) cap', () => {
    // MFA needs both IABKBR (0.5/unit) and ISBR (0.4/unit).
    //   IABKBR supply 40kg → allows 80 units
    //   ISBR supply 30kg   → allows 75 units (more binding)
    // Final cap = 75.
    const r = applySupplyCaps({
      packagingChips: [chip('a', 'MFA', 100, 5)],
      consumesQtyMap: {
        MFA: { IABKBR: 0.5, ISBR: 0.4 },
      },
      intermediateOutputSupply: { IABKBR: 40, ISBR: 30 },
    });
    expect(r.caps.get('a')?.cappedQuantity).toBe(75);
  });

  test('tiebreak by date asc when profits equal', () => {
    // Two same-profit chips, supply only enough for one.
    const r = applySupplyCaps({
      packagingChips: [
        chip('later', 'MFA', 100, 2, '2026-06-15'),
        chip('earlier', 'MFB', 100, 2, '2026-06-01'),
      ],
      consumesQtyMap: {
        MFA: { IABKBR: 0.5 },
        MFB: { IABKBR: 0.5 },
      },
      intermediateOutputSupply: { IABKBR: 50 },
    });
    // Earlier date should keep its full qty.
    expect(r.caps.get('earlier')).toBeUndefined();
    expect(r.caps.get('later')?.cappedQuantity).toBe(0);
  });

  test('empty input → empty output', () => {
    const r = applySupplyCaps({
      packagingChips: [],
      consumesQtyMap: {},
      intermediateOutputSupply: {},
    });
    expect(r.caps.size).toBe(0);
    expect(r.diagnostics.size).toBe(0);
  });

  test('diagnostics record supply, demand and short-by per intermediate', () => {
    const r = applySupplyCaps({
      packagingChips: [
        chip('a', 'MFA', 100, 5),
        chip('b', 'MFB', 100, 1),
      ],
      consumesQtyMap: {
        MFA: { IABKBR: 0.5 },
        MFB: { IABKBR: 0.5 },
      },
      intermediateOutputSupply: { IABKBR: 60 },
    });
    const diag = r.diagnostics.get('IABKBR');
    expect(diag).toEqual({
      totalSupply: 60,
      totalDemand: 100,
      shortBy: 40,
      cappedChipCount: 1,
    });
  });
});
