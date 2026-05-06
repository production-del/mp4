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

  test('scheduled supply AFTER demand date does not help', () => {
    const r = computeKitchenGaps({
      demand: [demand('XHBC', 100, '2026-05-15')],
      scheduledSupply: [
        { intermediateCode: 'XHBC', date: '2026-05-22', quantity: 60, source: 'A-1' },
      ],
      lundbergSohByCode: { XHBC: 30 },
    });
    expect(r[0].shortfallQuantity).toBe(70); // late supply doesn't help week-15 demand
  });

  test('multiple shortfalls produce multiple gaps over time', () => {
    const r = computeKitchenGaps({
      demand: [
        demand('XHBC', 50, '2026-05-15'),
        demand('XHBC', 50, '2026-05-29'),
      ],
      scheduledSupply: [],
      lundbergSohByCode: { XHBC: 30 },
    });
    // First demand: 30 - 50 = -20 → gap 20 by 5/15. Reset to 0.
    // Second demand: 0 - 50 = -50 → gap 50 by 5/29.
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({
      shortfallQuantity: 20,
      requiredByDate: '2026-05-15',
    });
    expect(r[1]).toMatchObject({
      shortfallQuantity: 50,
      requiredByDate: '2026-05-29',
    });
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

  test('drivers list contains the packaging batches that caused the gap', () => {
    const r = computeKitchenGaps({
      demand: [
        demand('XHBC', 50, '2026-05-15', 'FCHAGALG', 100),
        demand('XHBC', 50, '2026-05-15', 'FCHAGASM', 200),
      ],
      scheduledSupply: [],
      lundbergSohByCode: {},
    });
    // 0 - 50 = -50 gap by 5/15. Reset. 0 - 50 = -50 → another gap.
    // Each gap lists pending drivers up to that point.
    expect(r[0].drivers.map((d) => d.productCode)).toEqual(['FCHAGALG']);
    expect(r[1].drivers.map((d) => d.productCode)).toEqual(['FCHAGASM']);
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
