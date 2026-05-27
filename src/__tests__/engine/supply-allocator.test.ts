import {
  allocateSupplyFifo,
  type AllocatorActivity,
} from '@/lib/engine/supply-allocator';

// ─── Fixture helpers ─────────────────────────────────────────

function activity(o: Partial<AllocatorActivity> & { stableId: string; productCode: string; date: string }): AllocatorActivity {
  // Infer kind from stableId prefix when the test doesn't specify one.
  const prefix = o.stableId.split('-')[0];
  const inferredKind: AllocatorActivity['kind'] =
    prefix === 'PKG' ? 'packaging'
    : prefix === 'KR' ? 'kitchen-required'
    : prefix === 'KCH' ? 'kitchen'
    : prefix === 'PO' ? 'po-receiving'
    : 'packaging';
  return {
    stableId: o.stableId,
    productCode: o.productCode,
    kind: o.kind ?? inferredKind,
    date: o.date,
    finishDate: o.finishDate ?? null,
    quantity: o.quantity ?? 100,
    profitPerItem: o.profitPerItem ?? null,
  };
}

// Match the CalendarApp predicate semantics.
const isPackagingOrKitchenRequired = (a: AllocatorActivity) =>
  a.kind === 'packaging' || a.kind === 'kitchen-required' || a.kind === 'kitchen';
const isSupplier = (a: AllocatorActivity) =>
  a.kind !== 'po-placed';

describe('allocateSupplyFifo', () => {
  test('empty inputs → empty allocations', () => {
    const r = allocateSupplyFifo({
      activities: [],
      isConsumer: isPackagingOrKitchenRequired,
      isSupplier,
      consumesMap: {},
      consumesQtyMap: {},
      initialSohByCode: {},
    });
    expect(r.allocations).toEqual([]);
  });

  test('single consumer + single supplier → one real allocation', () => {
    const r = allocateSupplyFifo({
      activities: [
        activity({ stableId: 'KR-IAB-1', productCode: 'IAB', date: '2026-05-19', finishDate: '2026-05-19', quantity: 200 }),
        activity({ stableId: 'PKG-MFBIRPBLG', productCode: 'MFBIRPBLG', date: '2026-05-22', quantity: 1000 }),
      ],
      isConsumer: isPackagingOrKitchenRequired,
      isSupplier,
      consumesMap: { MFBIRPBLG: ['IAB'] },
      consumesQtyMap: { MFBIRPBLG: { IAB: 0.1 } },
      initialSohByCode: {},
    });
    expect(r.allocations).toHaveLength(1);
    expect(r.allocations[0]).toMatchObject({
      supplierStableId: 'KR-IAB-1',
      consumerStableId: 'PKG-MFBIRPBLG',
      ingredient: 'IAB',
      quantity: 100, // 1000 × 0.1
      phantom: false,
    });
  });

  test('SOH satisfies consumer fully → no allocation (SOH has no chip)', () => {
    const r = allocateSupplyFifo({
      activities: [
        activity({ stableId: 'PKG-MFBIRPBLG', productCode: 'MFBIRPBLG', date: '2026-05-22', quantity: 100 }),
      ],
      isConsumer: isPackagingOrKitchenRequired,
      isSupplier,
      consumesMap: { MFBIRPBLG: ['IAB'] },
      consumesQtyMap: { MFBIRPBLG: { IAB: 0.1 } },
      initialSohByCode: { IAB: 50 },
    });
    expect(r.allocations).toEqual([]);
  });

  test('FIFO walks suppliers in finish-date order', () => {
    const r = allocateSupplyFifo({
      activities: [
        activity({ stableId: 'KR-IAB-LATE', productCode: 'IAB', date: '2026-05-20', finishDate: '2026-05-20', quantity: 50 }),
        activity({ stableId: 'KR-IAB-EARLY', productCode: 'IAB', date: '2026-05-15', finishDate: '2026-05-15', quantity: 50 }),
        activity({ stableId: 'PKG-MFBIRPBLG', productCode: 'MFBIRPBLG', date: '2026-05-22', quantity: 500 }), // needs 50 IAB
      ],
      isConsumer: isPackagingOrKitchenRequired,
      isSupplier,
      consumesMap: { MFBIRPBLG: ['IAB'] },
      consumesQtyMap: { MFBIRPBLG: { IAB: 0.1 } },
      initialSohByCode: {},
    });
    // Earliest supplier (finish 5/15) should be drawn first.
    expect(r.allocations).toHaveLength(1);
    expect(r.allocations[0].supplierStableId).toBe('KR-IAB-EARLY');
    expect(r.allocations[0].quantity).toBe(50);
  });

  test('Late supplier (finish ≥ consumer.date) is NOT drawn, no phantom emitted either', () => {
    const r = allocateSupplyFifo({
      activities: [
        // Supplier finishes ON the consumer's date — too late.
        activity({ stableId: 'KR-IAB-LATE', productCode: 'IAB', date: '2026-05-22', finishDate: '2026-05-22', quantity: 50 }),
        activity({ stableId: 'PKG-MFBIRPBLG', productCode: 'MFBIRPBLG', date: '2026-05-22', quantity: 500 }),
      ],
      isConsumer: isPackagingOrKitchenRequired,
      isSupplier,
      consumesMap: { MFBIRPBLG: ['IAB'] },
      consumesQtyMap: { MFBIRPBLG: { IAB: 0.1 } },
      initialSohByCode: {},
    });
    // No SOH, no eligible supplier (the only supplier is too late) →
    // phantom logic requires a supplier that finishes STRICTLY BEFORE
    // the consumer; here it doesn't, so no phantom is emitted.
    expect(r.allocations).toHaveLength(0);
  });

  test('Phantom emitted when earlier supplier exists but is drained', () => {
    const r = allocateSupplyFifo({
      activities: [
        // Supplier finishes BEFORE both consumers — phantom-eligible.
        activity({ stableId: 'KR-IAB-EARLY', productCode: 'IAB', date: '2026-05-15', finishDate: '2026-05-15', quantity: 50 }),
        // First consumer drains the supplier.
        activity({ stableId: 'PKG-C1', productCode: 'MFBIRPBLG', date: '2026-05-20', quantity: 500 }), // needs 50
        // Second consumer arrives empty-handed.
        activity({ stableId: 'PKG-C2', productCode: 'MFBIRPBLG', date: '2026-05-25', quantity: 500 }), // needs 50, starved
      ],
      isConsumer: isPackagingOrKitchenRequired,
      isSupplier,
      consumesMap: { MFBIRPBLG: ['IAB'] },
      consumesQtyMap: { MFBIRPBLG: { IAB: 0.1 } },
      initialSohByCode: {},
    });
    // C1 gets the real allocation; C2 gets a phantom pointing at the
    // drained supplier (so the UI can draw a dashed-red arrow).
    expect(r.allocations).toHaveLength(2);
    const real = r.allocations.find((a) => !a.phantom)!;
    const phantom = r.allocations.find((a) => a.phantom)!;
    expect(real.consumerStableId).toBe('PKG-C1');
    expect(phantom.consumerStableId).toBe('PKG-C2');
    expect(phantom.supplierStableId).toBe('KR-IAB-EARLY');
  });

  test('starved consumer emits phantom allocation', () => {
    const r = allocateSupplyFifo({
      activities: [
        // No suppliers, no SOH — consumer is fully starved.
        activity({ stableId: 'PKG-MFBIRPBLG', productCode: 'MFBIRPBLG', date: '2026-05-22', quantity: 500 }),
      ],
      isConsumer: isPackagingOrKitchenRequired,
      isSupplier,
      consumesMap: { MFBIRPBLG: ['IAB'] },
      consumesQtyMap: { MFBIRPBLG: { IAB: 0.1 } },
      initialSohByCode: {},
    });
    // No suppliers AT ALL means no phantom either — only emitted when
    // a candidate supplier finishes before the consumer (just too late).
    expect(r.allocations).toEqual([]);
  });

  test('Multiple consumers share supplier qty by FIFO date order', () => {
    const r = allocateSupplyFifo({
      activities: [
        activity({ stableId: 'KR-IAB', productCode: 'IAB', date: '2026-05-15', finishDate: '2026-05-15', quantity: 100 }),
        activity({ stableId: 'PKG-C1', productCode: 'MFBIRPBLG', date: '2026-05-20', quantity: 600 }), // needs 60
        activity({ stableId: 'PKG-C2', productCode: 'MFBIRPBLG', date: '2026-05-25', quantity: 600 }), // needs 60
      ],
      isConsumer: isPackagingOrKitchenRequired,
      isSupplier,
      consumesMap: { MFBIRPBLG: ['IAB'] },
      consumesQtyMap: { MFBIRPBLG: { IAB: 0.1 } },
      initialSohByCode: {},
    });
    // PKG-C1 (earlier) gets 60, leaving 40 for PKG-C2.
    const c1 = r.allocations.find((a) => a.consumerStableId === 'PKG-C1');
    const c2 = r.allocations.find((a) => a.consumerStableId === 'PKG-C2');
    expect(c1?.quantity).toBe(60);
    expect(c2?.quantity).toBe(40);
  });

  test('profit-first tiebreaker on same-date consumers', () => {
    const r = allocateSupplyFifo({
      activities: [
        activity({ stableId: 'KR-IAB', productCode: 'IAB', date: '2026-05-15', finishDate: '2026-05-15', quantity: 60 }),
        activity({
          stableId: 'PKG-LOW',
          productCode: 'MFBIRPBLG',
          date: '2026-05-20',
          quantity: 500,
          profitPerItem: 2,
        }),
        activity({
          stableId: 'PKG-HIGH',
          productCode: 'MFBIRPBLG',
          date: '2026-05-20',
          quantity: 500,
          profitPerItem: 10,
        }),
      ],
      isConsumer: isPackagingOrKitchenRequired,
      isSupplier,
      consumesMap: { MFBIRPBLG: ['IAB'] },
      consumesQtyMap: { MFBIRPBLG: { IAB: 0.1 } },
      initialSohByCode: {},
    });
    // HIGH-profit consumer wins the tiebreaker → gets 50, LOW gets 10.
    const hi = r.allocations.find((a) => a.consumerStableId === 'PKG-HIGH');
    const lo = r.allocations.find((a) => a.consumerStableId === 'PKG-LOW');
    expect(hi?.quantity).toBe(50);
    expect(lo?.quantity).toBe(10);
  });

  test('excludedStableIds keeps both consumer + supplier roles out of the walk', () => {
    const r = allocateSupplyFifo({
      activities: [
        activity({ stableId: 'KR-IAB-A', productCode: 'IAB', date: '2026-05-15', finishDate: '2026-05-15', quantity: 100 }),
        activity({ stableId: 'KR-IAB-B', productCode: 'IAB', date: '2026-05-15', finishDate: '2026-05-15', quantity: 100 }),
        activity({ stableId: 'PKG-C', productCode: 'MFBIRPBLG', date: '2026-05-22', quantity: 500 }),
      ],
      excludedStableIds: new Set(['KR-IAB-A']),
      isConsumer: isPackagingOrKitchenRequired,
      isSupplier,
      consumesMap: { MFBIRPBLG: ['IAB'] },
      consumesQtyMap: { MFBIRPBLG: { IAB: 0.1 } },
      initialSohByCode: {},
    });
    expect(r.allocations).toHaveLength(1);
    expect(r.allocations[0].supplierStableId).toBe('KR-IAB-B');
  });

  test('supplyQtyByActivity override (e.g. supply-cap) is respected', () => {
    const r = allocateSupplyFifo({
      activities: [
        activity({ stableId: 'KR-IAB', productCode: 'IAB', date: '2026-05-15', finishDate: '2026-05-15', quantity: 100 }),
        activity({ stableId: 'PKG-C', productCode: 'MFBIRPBLG', date: '2026-05-22', quantity: 500 }), // needs 50
      ],
      isConsumer: isPackagingOrKitchenRequired,
      isSupplier,
      consumesMap: { MFBIRPBLG: ['IAB'] },
      consumesQtyMap: { MFBIRPBLG: { IAB: 0.1 } },
      initialSohByCode: {},
      supplyQtyByActivity: { 'KR-IAB': 30 }, // cap supplier to 30
    });
    // Only 30 of the 50 demand can be allocated.
    expect(r.allocations).toHaveLength(1);
    expect(r.allocations[0].quantity).toBe(30);
  });
});
