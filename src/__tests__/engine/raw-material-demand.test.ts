import {
  deriveRawMaterialDemand,
  projectRawMaterialSoh,
  derivePurchaseRequirements,
  analyzeRawMaterials,
  type ActivityForRawMaterials,
  type RawMaterialDemandEvent,
} from '@/lib/engine/raw-material-demand';
import type { BOMComponent } from '@/lib/planning/engine-io';

// ─── Fixtures ────────────────────────────────────────────────

function bomRow(o: {
  parent: string;
  code: string;
  qty: number;
  level?: number;
}): BOMComponent {
  return {
    productCode: o.code,
    productName: o.code,
    quantityPerParent: o.qty,
    level: o.level ?? 1,
    parentProductCode: o.parent,
  };
}

function packagingActivity(o: {
  stableId: string;
  productCode: string;
  date: string;
  quantity?: number;
}): ActivityForRawMaterials {
  return {
    stableId: o.stableId,
    productCode: o.productCode,
    productName: o.productCode,
    quantity: o.quantity ?? 100,
    date: o.date,
    kind: 'packaging',
  };
}

function kitchenActivity(o: {
  stableId: string;
  productCode: string;
  date: string;
  quantity?: number;
}): ActivityForRawMaterials {
  return {
    stableId: o.stableId,
    productCode: o.productCode,
    productName: o.productCode,
    quantity: o.quantity ?? 50,
    date: o.date,
    kind: 'kitchen-required',
  };
}

// ─── deriveRawMaterialDemand ─────────────────────────────────

describe('deriveRawMaterialDemand', () => {
  test('emits one event per (activity, raw material), depth-1 only', () => {
    // FCHOC has BOM [ICC, LABEL]. ICC is an intermediate; LABEL is a raw
    // material.
    const events = deriveRawMaterialDemand({
      activities: [
        packagingActivity({ stableId: 'P1', productCode: 'FCHOC', date: '2026-05-15' }),
      ],
      bom: [
        bomRow({ parent: 'FCHOC', code: 'ICC', qty: 0.5 }),
        bomRow({ parent: 'FCHOC', code: 'LABEL', qty: 1 }),
      ],
      intermediateCodes: new Set(['ICC']),
    });
    expect(events).toHaveLength(1);
    expect(events[0].rawMaterialCode).toBe('LABEL');
    expect(events[0].quantity).toBe(100); // 100 packaging units × 1 LABEL each
    expect(events[0].requiredByDate).toBe('2026-05-15');
    expect(events[0].drivenBy.stableId).toBe('P1');
  });

  test('skips intermediates at depth 1 (they have their own activities)', () => {
    const events = deriveRawMaterialDemand({
      activities: [
        packagingActivity({ stableId: 'P1', productCode: 'FCHOC', date: '2026-05-15' }),
      ],
      bom: [
        bomRow({ parent: 'FCHOC', code: 'ICC', qty: 0.5 }),
      ],
      intermediateCodes: new Set(['ICC']),
    });
    expect(events).toEqual([]);
  });

  test('walks kitchen-required activities to their raw materials', () => {
    // ICC is an intermediate; its BOM is [RAW_CACAO]. ICC has its own
    // kitchen-required activity, which drives RAW_CACAO demand on ICC's date.
    const events = deriveRawMaterialDemand({
      activities: [
        kitchenActivity({
          stableId: 'K1',
          productCode: 'ICC',
          date: '2026-05-13',
          quantity: 50,
        }),
      ],
      bom: [
        bomRow({ parent: 'ICC', code: 'RAW_CACAO', qty: 2 }),
      ],
      intermediateCodes: new Set(['ICC']),
    });
    expect(events).toHaveLength(1);
    expect(events[0].rawMaterialCode).toBe('RAW_CACAO');
    expect(events[0].quantity).toBe(100); // 50 ICC × 2 cacao each
    expect(events[0].requiredByDate).toBe('2026-05-13');
    expect(events[0].drivenBy.kind).toBe('kitchen-required');
  });

  test('skips dismissed activities', () => {
    const events = deriveRawMaterialDemand({
      activities: [
        kitchenActivity({ stableId: 'K1', productCode: 'ICC', date: '2026-05-13' }),
      ],
      bom: [
        bomRow({ parent: 'ICC', code: 'RAW_CACAO', qty: 1 }),
      ],
      intermediateCodes: new Set(['ICC']),
      dismissedStableIds: new Set(['K1']),
    });
    expect(events).toEqual([]);
  });

  test('diamond BOMs: same raw material via two paths sums into one event', () => {
    // FCHOC consumes RAW_X both directly and via INNER (which is NOT an
    // intermediate, just another nested BOM at depth 2 — so we only see the
    // depth-1 RAW_X path).
    const events = deriveRawMaterialDemand({
      activities: [
        packagingActivity({ stableId: 'P1', productCode: 'FCHOC', date: '2026-05-15', quantity: 100 }),
      ],
      bom: [
        bomRow({ parent: 'FCHOC', code: 'RAW_X', qty: 2 }),
        bomRow({ parent: 'FCHOC', code: 'RAW_X', qty: 3 }), // extra row, same code
      ],
      intermediateCodes: new Set(),
    });
    expect(events).toHaveLength(1);
    // Two BOM rows → 100 × 2 + 100 × 3 = 500.
    expect(events[0].quantity).toBe(500);
  });
});

// ─── projectRawMaterialSoh ───────────────────────────────────

describe('projectRawMaterialSoh', () => {
  test('no shortage when SOH covers all demand', () => {
    const events: RawMaterialDemandEvent[] = [
      makeEvent('RAW_X', '2026-05-15', 50, 'A1'),
      makeEvent('RAW_X', '2026-05-20', 30, 'A2'),
    ];
    const shortages = projectRawMaterialSoh({
      events,
      initialSohByCode: { RAW_X: 100 },
    });
    expect(shortages).toEqual([]);
  });

  test('shortage on first date that pushes SOH negative', () => {
    const events: RawMaterialDemandEvent[] = [
      makeEvent('RAW_X', '2026-05-15', 50, 'A1'),
      makeEvent('RAW_X', '2026-05-20', 80, 'A2'), // tips it over
      makeEvent('RAW_X', '2026-05-25', 10, 'A3'),
    ];
    const shortages = projectRawMaterialSoh({
      events,
      initialSohByCode: { RAW_X: 100 },
    });
    expect(shortages).toHaveLength(1);
    expect(shortages[0].rawMaterialCode).toBe('RAW_X');
    expect(shortages[0].shortageDate).toBe('2026-05-20');
    expect(shortages[0].shortageQuantity).toBe(30); // 100 - 50 - 80 = -30
    expect(shortages[0].totalDemand).toBe(140);
    expect(shortages[0].drivenBy).toEqual(['A1', 'A2', 'A3']);
  });

  test('zero initial SOH → first demand is the shortage', () => {
    const events: RawMaterialDemandEvent[] = [
      makeEvent('RAW_X', '2026-05-15', 25, 'A1'),
    ];
    const shortages = projectRawMaterialSoh({
      events,
      initialSohByCode: {},
    });
    expect(shortages).toHaveLength(1);
    expect(shortages[0].shortageDate).toBe('2026-05-15');
    expect(shortages[0].shortageQuantity).toBe(25);
  });

  test('events arrive out of order — shortage date is the first chronological negative', () => {
    const events: RawMaterialDemandEvent[] = [
      makeEvent('RAW_X', '2026-05-25', 10, 'late'),
      makeEvent('RAW_X', '2026-05-15', 50, 'early'),
      makeEvent('RAW_X', '2026-05-20', 80, 'mid'), // tips it
    ];
    const shortages = projectRawMaterialSoh({
      events,
      initialSohByCode: { RAW_X: 100 },
    });
    expect(shortages[0].shortageDate).toBe('2026-05-20');
  });

  test('per-material isolation: shortage in X does not cascade to Y', () => {
    const events: RawMaterialDemandEvent[] = [
      makeEvent('RAW_X', '2026-05-15', 200, 'A1'),
      makeEvent('RAW_Y', '2026-05-16', 50, 'A2'),
    ];
    const shortages = projectRawMaterialSoh({
      events,
      initialSohByCode: { RAW_X: 100, RAW_Y: 100 },
    });
    expect(shortages.map((s) => s.rawMaterialCode)).toEqual(['RAW_X']);
  });

  test('output sorted by (shortageDate, code)', () => {
    const events: RawMaterialDemandEvent[] = [
      makeEvent('B', '2026-05-15', 200, 'a'),
      makeEvent('A', '2026-05-15', 200, 'b'),
      makeEvent('C', '2026-05-10', 200, 'c'),
    ];
    const shortages = projectRawMaterialSoh({
      events,
      initialSohByCode: {},
    });
    expect(shortages.map((s) => s.rawMaterialCode)).toEqual(['C', 'A', 'B']);
  });
});

// ─── derivePurchaseRequirements ──────────────────────────────

describe('derivePurchaseRequirements', () => {
  test('placeBy = arriveBy - leadTime; arriveBy = shortage - 1 day', () => {
    const reqs = derivePurchaseRequirements({
      shortages: [
        {
          rawMaterialCode: 'RAW_X',
          rawMaterialName: 'Raw X',
          shortageDate: '2026-05-20',
          shortageQuantity: 30,
          totalDemand: 130,
          initialSoh: 100,
          drivenBy: ['A1'],
        },
      ],
      defaultLeadTimeDays: 14,
    });
    expect(reqs[0].arriveByDate).toBe('2026-05-19'); // shortage - 1
    expect(reqs[0].placeByDate).toBe('2026-05-05'); // arriveBy - 14
    expect(reqs[0].quantity).toBe(30);
    expect(reqs[0].leadTimeDays).toBe(14);
  });

  test('per-material lead time overrides default', () => {
    const reqs = derivePurchaseRequirements({
      shortages: [
        {
          rawMaterialCode: 'SLOW',
          rawMaterialName: 'Slow Vendor',
          shortageDate: '2026-05-20',
          shortageQuantity: 30,
          totalDemand: 30,
          initialSoh: 0,
          drivenBy: [],
        },
      ],
      defaultLeadTimeDays: 14,
      leadTimeDaysByCode: { SLOW: 30 },
    });
    expect(reqs[0].leadTimeDays).toBe(30);
    expect(reqs[0].arriveByDate).toBe('2026-05-19');
    expect(reqs[0].placeByDate).toBe('2026-04-19'); // arriveBy - 30 days
  });

  test('overdue flagged when placeBy < today', () => {
    const reqs = derivePurchaseRequirements({
      shortages: [
        {
          rawMaterialCode: 'RAW_X',
          rawMaterialName: 'Raw X',
          shortageDate: '2026-05-10',
          shortageQuantity: 30,
          totalDemand: 30,
          initialSoh: 0,
          drivenBy: [],
        },
      ],
      defaultLeadTimeDays: 14,
      today: '2026-05-05',
    });
    // arriveBy = 5/9, placeBy = 4/25 → before 5/5.
    expect(reqs[0].overdue).toBe(true);
  });

  test('not overdue when placeBy is in the future', () => {
    const reqs = derivePurchaseRequirements({
      shortages: [
        {
          rawMaterialCode: 'RAW_X',
          rawMaterialName: 'Raw X',
          shortageDate: '2026-06-15',
          shortageQuantity: 30,
          totalDemand: 30,
          initialSoh: 0,
          drivenBy: [],
        },
      ],
      defaultLeadTimeDays: 14,
      today: '2026-05-05',
    });
    expect(reqs[0].overdue).toBe(false);
  });

  test('overdue undefined-today never flags overdue', () => {
    const reqs = derivePurchaseRequirements({
      shortages: [
        {
          rawMaterialCode: 'RAW_X',
          rawMaterialName: 'Raw X',
          shortageDate: '2025-01-01', // ancient
          shortageQuantity: 30,
          totalDemand: 30,
          initialSoh: 0,
          drivenBy: [],
        },
      ],
      defaultLeadTimeDays: 14,
    });
    expect(reqs[0].overdue).toBe(false);
  });
});

// ─── analyzeRawMaterials orchestrator ────────────────────────

describe('analyzeRawMaterials (end-to-end)', () => {
  test('packaging + kitchen activities → events → shortages → requirements', () => {
    const result = analyzeRawMaterials({
      activities: [
        packagingActivity({ stableId: 'P1', productCode: 'FCHOC', date: '2026-05-20', quantity: 100 }),
        kitchenActivity({ stableId: 'K1', productCode: 'ICC', date: '2026-05-15', quantity: 50 }),
      ],
      bom: [
        bomRow({ parent: 'FCHOC', code: 'ICC', qty: 0.5 }),
        bomRow({ parent: 'FCHOC', code: 'LABEL', qty: 1 }),
        bomRow({ parent: 'ICC', code: 'RAW_CACAO', qty: 2 }),
      ],
      intermediateCodes: new Set(['ICC']),
      initialSohByCode: { LABEL: 50, RAW_CACAO: 80 }, // both will short
      defaultLeadTimeDays: 14,
      today: '2026-05-05',
    });
    // Events: FCHOC → LABEL (100 × 1), ICC → RAW_CACAO (50 × 2).
    expect(result.events).toHaveLength(2);
    // Shortages:
    //   LABEL: 50 - 100 = -50 short on 5/20.
    //   RAW_CACAO: 80 - 100 = -20 short on 5/15.
    expect(result.shortages).toHaveLength(2);
    const cacao = result.shortages.find((s) => s.rawMaterialCode === 'RAW_CACAO')!;
    expect(cacao.shortageDate).toBe('2026-05-15');
    expect(cacao.shortageQuantity).toBe(20);
    const label = result.shortages.find((s) => s.rawMaterialCode === 'LABEL')!;
    expect(label.shortageDate).toBe('2026-05-20');
    expect(label.shortageQuantity).toBe(50);
    // Requirements: placeBy = arriveBy - 14.
    expect(result.requirements).toHaveLength(2);
    const cacaoReq = result.requirements.find((r) => r.rawMaterialCode === 'RAW_CACAO')!;
    expect(cacaoReq.arriveByDate).toBe('2026-05-14');
    expect(cacaoReq.placeByDate).toBe('2026-04-30');
    // 4/30 < 5/5 → overdue.
    expect(cacaoReq.overdue).toBe(true);
  });
});

// ─── helpers ─────────────────────────────────────────────────

function makeEvent(
  code: string,
  date: string,
  qty: number,
  driverId: string,
): RawMaterialDemandEvent {
  return {
    rawMaterialCode: code,
    rawMaterialName: code,
    quantity: qty,
    requiredByDate: date,
    drivenBy: {
      stableId: driverId,
      productCode: 'X',
      productName: 'X',
      quantity: qty,
      date,
      kind: 'kitchen-required',
    },
  };
}
