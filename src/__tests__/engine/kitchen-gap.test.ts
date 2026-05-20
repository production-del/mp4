import { computeKitchenGaps } from '@/lib/engine/kitchen-gap';
import type { IntermediateDemandEvent } from '@/lib/engine/intermediate-demand';

function demand(
  code: string,
  qty: number,
  date: string,
  driverProduct = 'FCHAGALG',
  driverQty = 100,
): IntermediateDemandEvent {
  return {
    intermediateCode: code,
    intermediateName: code,
    quantity: qty,
    requiredByDate: date,
    drivenBy: {
      productCode: driverProduct,
      productName: driverProduct,
      packagingQuantity: driverQty,
      packagingDate: date,
    },
  };
}

describe('computeKitchenGaps', () => {
  test('empty inputs → empty gaps', () => {
    expect(
      computeKitchenGaps({
        demand: [],
        scheduledSupply: [],
        lundbergSohByCode: {},
      }),
    ).toEqual([]);
  });

  test('SOH covers demand → no gaps', () => {
    const r = computeKitchenGaps({
      demand: [demand('XHBC', 30, '2026-05-15')],
      scheduledSupply: [],
      lundbergSohByCode: { XHBC: 50 },
    });
    expect(r).toEqual([]);
  });

  test('SOH zero, no supply → gap = full demand', () => {
    const r = computeKitchenGaps({
      demand: [demand('XHBC', 30, '2026-05-15')],
      scheduledSupply: [],
      lundbergSohByCode: {},
    });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      intermediateCode: 'XHBC',
      shortfallQuantity: 30,
      requiredByDate: '2026-05-15',
    });
  });

  test('partial SOH → gap is the difference', () => {
    const r = computeKitchenGaps({
      demand: [demand('XHBC', 100, '2026-05-15')],
      scheduledSupply: [],
      lundbergSohByCode: { XHBC: 30 },
    });
    expect(r).toHaveLength(1);
    expect(r[0].shortfallQuantity).toBe(70);
  });

  test('scheduled supply on the SAME date is applied BEFORE demand', () => {
    // If supply lands on the demand date, it should still help cover demand.
    const r = computeKitchenGaps({
      demand: [demand('XHBC', 100, '2026-05-15')],
      scheduledSupply: [
        { intermediateCode: 'XHBC', date: '2026-05-15', quantity: 60, source: 'A-1' },
      ],
      lundbergSohByCode: { XHBC: 30 },
    });
    expect(r).toHaveLength(1);
    expect(r[0].shortfallQuantity).toBe(10); // 30 + 60 = 90, demand 100, gap 10
  });

  test('horizon-total supply offsets gap qty (legacy, consumptionWindowDays=0)', () => {
    const r = computeKitchenGaps({
      demand: [demand('XHBC', 100, '2026-05-15')],
      scheduledSupply: [
        { intermediateCode: 'XHBC', date: '2026-05-22', quantity: 60, source: 'A-1' },
      ],
      lundbergSohByCode: { XHBC: 30 },
      consumptionWindowDays: 0, // legacy coalesce
    });
    // Legacy: total demand 100 − SOH 30 − supply 60 = 10, regardless of supply timing.
    expect(r).toHaveLength(1);
    expect(r[0].shortfallQuantity).toBe(10);
    expect(r[0].requiredByDate).toBe('2026-05-15');
  });

  test('multiple shortfalls coalesce into ONE gap (legacy, consumptionWindowDays=0)', () => {
    const r = computeKitchenGaps({
      demand: [
        demand('XHBC', 50, '2026-05-15'),
        demand('XHBC', 50, '2026-05-29'),
      ],
      scheduledSupply: [],
      lundbergSohByCode: { XHBC: 30 },
      consumptionWindowDays: 0, // legacy coalesce
    });
    // Legacy: one gap qty 70 dated at the FIRST crossing (5/15).
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      shortfallQuantity: 70,
      requiredByDate: '2026-05-15',
    });
  });

  test('Phase 4l.12: late supply does NOT offset early demand (window=5 default)', () => {
    // Same scenario as the legacy test above but with default windowed
    // behaviour — late supply lands after the window closes, so the
    // gap reflects the in-window deficit only.
    const r = computeKitchenGaps({
      demand: [demand('XHBC', 100, '2026-05-15')],
      scheduledSupply: [
        { intermediateCode: 'XHBC', date: '2026-05-22', quantity: 60, source: 'A-1' },
      ],
      lundbergSohByCode: { XHBC: 30 },
    });
    expect(r).toHaveLength(1);
    expect(r[0].shortfallQuantity).toBe(70); // 100 − 30 SOH, late supply ignored
    expect(r[0].requiredByDate).toBe('2026-05-15');
  });

  test('Phase 4l.12: two shortfalls 14 days apart emit TWO gaps (window=5 default)', () => {
    const r = computeKitchenGaps({
      demand: [
        demand('XHBC', 50, '2026-05-15'),
        demand('XHBC', 50, '2026-05-29'),
      ],
      scheduledSupply: [],
      lundbergSohByCode: { XHBC: 30 },
    });
    expect(r).toHaveLength(2);
    // Gap 1: SOH covers 30 of the 50 on 5/15 → deficit 20.
    expect(r[0]).toMatchObject({
      shortfallQuantity: 20,
      requiredByDate: '2026-05-15',
    });
    // Gap 2: no carry-over (window closes after 5/15), full 50 on 5/29.
    expect(r[1]).toMatchObject({
      shortfallQuantity: 50,
      requiredByDate: '2026-05-29',
    });
  });

  test('Phase 4l.12: preferredBatchSize surplus credits forward — two windows, one batch', () => {
    // Two 100kg demand events 7 days apart. SOH = 0. preferredBatchSize=300
    // (yield 1.0). The FIRST 100kg deficit triggers a 300kg run (recipe
    // floor); the 200kg surplus should carry forward and cover the
    // second 100kg demand without emitting another gap.
    const r = computeKitchenGaps({
      demand: [
        demand('XHBC', 100, '2026-05-15'),
        demand('XHBC', 100, '2026-05-22'),
      ],
      scheduledSupply: [],
      lundbergSohByCode: {},
      preferredBatchByIntermediate: { XHBC: { batch: 300, yield: 1 } },
    });
    expect(r).toHaveLength(1);
    expect(r[0].shortfallQuantity).toBe(100);
    expect(r[0].requiredByDate).toBe('2026-05-15');
  });

  test('Phase 4l.12: default windowDays=1 → per-event gaps for just-in-time', () => {
    // Two events 3 days apart with no surplus carryover should emit
    // TWO gaps, each dated to its specific event. The 5-day window
    // would have bundled them; 1-day default keeps them separate.
    const r = computeKitchenGaps({
      demand: [
        demand('XHBC', 50, '2026-05-15'),
        demand('XHBC', 50, '2026-05-18'),
      ],
      scheduledSupply: [],
      lundbergSohByCode: {},
      // No preferredBatchByIntermediate → no surplus carry → each
      // event triggers its own gap.
    });
    expect(r).toHaveLength(2);
    expect(r[0].requiredByDate).toBe('2026-05-15');
    expect(r[1].requiredByDate).toBe('2026-05-18');
  });

  test('Phase 4l.12: surplus credit accounts for yield rate', () => {
    // Same as above but yield = 0.5 → 300kg input only produces 150kg
    // output. First deficit = 100, batch produces 150 (output) → 50kg
    // surplus carries. Second demand 100 needs another 50kg → another
    // batch emitted.
    const r = computeKitchenGaps({
      demand: [
        demand('XHBC', 100, '2026-05-15'),
        demand('XHBC', 100, '2026-05-22'),
      ],
      scheduledSupply: [],
      lundbergSohByCode: {},
      preferredBatchByIntermediate: { XHBC: { batch: 300, yield: 0.5 } },
    });
    expect(r).toHaveLength(2);
    expect(r[0].shortfallQuantity).toBe(100);
    expect(r[1].shortfallQuantity).toBe(50);
  });

  test('supply between two demand events bridges a gap', () => {
    const r = computeKitchenGaps({
      demand: [
        demand('XHBC', 50, '2026-05-15'),
        demand('XHBC', 50, '2026-05-29'),
      ],
      scheduledSupply: [
        { intermediateCode: 'XHBC', date: '2026-05-22', quantity: 100, source: 'A-1' },
      ],
      lundbergSohByCode: { XHBC: 60 },
    });
    // 60 - 50 = 10 (no gap), +100 = 110, -50 = 60. No gaps.
    expect(r).toEqual([]);
  });

  test('supply for code with no demand is silently ignored', () => {
    const r = computeKitchenGaps({
      demand: [demand('XHBC', 30, '2026-05-15')],
      scheduledSupply: [
        { intermediateCode: 'IGB', date: '2026-05-15', quantity: 1000, source: 'A-1' },
      ],
      lundbergSohByCode: {},
    });
    expect(r).toHaveLength(1);
    expect(r[0].intermediateCode).toBe('XHBC');
  });

  test('multiple intermediates simulated independently', () => {
    const r = computeKitchenGaps({
      demand: [
        demand('XHBC', 30, '2026-05-15'),
        demand('IGB', 100, '2026-05-15'),
      ],
      scheduledSupply: [],
      lundbergSohByCode: { XHBC: 50 },
    });
    expect(r).toHaveLength(1);
    expect(r[0].intermediateCode).toBe('IGB');
    expect(r[0].shortfallQuantity).toBe(100);
  });

  test('drivers list contains the packaging batches inside the shortage window (Phase 4l.12)', () => {
    const r = computeKitchenGaps({
      demand: [
        demand('XHBC', 50, '2026-05-15', 'FCHAGALG', 100),
        demand('XHBC', 50, '2026-05-15', 'FCHAGASM', 200),
      ],
      scheduledSupply: [],
      lundbergSohByCode: {},
    });
    // SOH = 0. Both demands on 5/15 are inside the window — both contribute
    // as drivers since BOTH push the running balance into deficit.
    expect(r).toHaveLength(1);
    expect(r[0].shortfallQuantity).toBe(100);
    expect(new Set(r[0].drivers.map((d) => d.productCode))).toEqual(
      new Set(['FCHAGALG', 'FCHAGASM']),
    );
  });

  test('output is sorted by (date, code)', () => {
    const r = computeKitchenGaps({
      demand: [
        demand('IGB', 100, '2026-05-15'),
        demand('XHBC', 100, '2026-05-15'),
        demand('AAA', 100, '2026-05-22'),
      ],
      scheduledSupply: [],
      lundbergSohByCode: {},
    });
    expect(r.map((g) => `${g.requiredByDate}/${g.intermediateCode}`)).toEqual([
      '2026-05-15/IGB',
      '2026-05-15/XHBC',
      '2026-05-22/AAA',
    ]);
  });
});
