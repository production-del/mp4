import {
  deriveIntermediateDemand,
  aggregateIntermediateDemand,
} from '@/lib/engine/intermediate-demand';
import type { BOMComponent } from '@/lib/planning/engine-io';

// ─── Fixture helpers ─────────────────────────────────────────

function bomRow(
  parent: string,
  product: string,
  qty: number,
  name = product,
): BOMComponent {
  return {
    parentProductCode: parent,
    productCode: product,
    productName: name,
    quantityPerParent: qty,
    level: 1,
  };
}

const FCHAGALG_BOM: BOMComponent[] = [
  // 1 unit FCHAGALG → 0.45 of XHBC, 1 jar, 1 lid, etc.
  bomRow('FCHAGALG', 'XHBC', 0.45, 'Chaga'),
  bomRow('FCHAGALG', 'JAR1000', 1, '1L Jar'),
  bomRow('FCHAGALG', 'LID82', 1, 'Lid'),
];

const INTERMEDIATES = new Set(['XHBC', 'IGB', 'IAW']);

// ─── Tests ───────────────────────────────────────────────────

describe('deriveIntermediateDemand', () => {
  test('extracts XHBC demand from a single FCHAGALG batch', () => {
    const events = deriveIntermediateDemand({
      packagingActivities: [
        {
          productCode: 'FCHAGALG',
          productName: 'Chaga 600g',
          quantity: 100,
          date: '2026-05-15',
        },
      ],
      bom: FCHAGALG_BOM,
      intermediateCodes: INTERMEDIATES,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      intermediateCode: 'XHBC',
      quantity: 45, // 100 × 0.45
      requiredByDate: '2026-05-15',
    });
    expect(events[0].drivenBy).toMatchObject({
      productCode: 'FCHAGALG',
      packagingQuantity: 100,
    });
  });

  test('ignores non-intermediate components (jar, lid, etc.)', () => {
    const events = deriveIntermediateDemand({
      packagingActivities: [
        {
          productCode: 'FCHAGALG',
          productName: 'Chaga',
          quantity: 100,
          date: '2026-05-15',
        },
      ],
      bom: FCHAGALG_BOM,
      intermediateCodes: INTERMEDIATES,
    });
    expect(events.map((e) => e.intermediateCode)).toEqual(['XHBC']);
  });

  test('produces separate events per packaging batch', () => {
    const events = deriveIntermediateDemand({
      packagingActivities: [
        { productCode: 'FCHAGALG', productName: 'X', quantity: 100, date: '2026-05-15' },
        { productCode: 'FCHAGALG', productName: 'X', quantity: 200, date: '2026-05-22' },
      ],
      bom: FCHAGALG_BOM,
      intermediateCodes: INTERMEDIATES,
    });
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.quantity)).toEqual([45, 90]);
    expect(events.map((e) => e.requiredByDate)).toEqual(['2026-05-15', '2026-05-22']);
  });

  test('handles cascading BOMs — finished good → intermediate → sub-intermediate', () => {
    // A 3-level BOM: FG → IGB (intermediate) → IAW (sub-intermediate) → raw
    const cascading: BOMComponent[] = [
      bomRow('FG', 'IGB', 1.0),
      bomRow('IGB', 'IAW', 0.5),
      bomRow('IAW', 'WALNUT_RAW', 1.0),
    ];
    const events = deriveIntermediateDemand({
      packagingActivities: [
        { productCode: 'FG', productName: 'Granola', quantity: 100, date: '2026-05-15' },
      ],
      bom: cascading,
      intermediateCodes: new Set(['IGB', 'IAW']),
    });
    // BOTH intermediates should appear: IGB at 100, IAW at 100×1×0.5=50
    expect(events).toHaveLength(2);
    const igb = events.find((e) => e.intermediateCode === 'IGB');
    const iaw = events.find((e) => e.intermediateCode === 'IAW');
    expect(igb?.quantity).toBe(100);
    expect(iaw?.quantity).toBe(50);
  });

  test('empty inputs → empty output', () => {
    expect(
      deriveIntermediateDemand({
        packagingActivities: [],
        bom: [],
        intermediateCodes: new Set(),
      }),
    ).toEqual([]);
  });

  test('packaging activity with no BOM returns nothing (raw-material case)', () => {
    const events = deriveIntermediateDemand({
      packagingActivities: [
        { productCode: 'NO_BOM', productName: 'X', quantity: 100, date: '2026-05-15' },
      ],
      bom: FCHAGALG_BOM,
      intermediateCodes: INTERMEDIATES,
    });
    expect(events).toEqual([]);
  });

  test('skips zero-quantity components', () => {
    const events = deriveIntermediateDemand({
      packagingActivities: [
        { productCode: 'FG', productName: 'X', quantity: 0, date: '2026-05-15' },
      ],
      bom: [bomRow('FG', 'XHBC', 0.45)],
      intermediateCodes: new Set(['XHBC']),
    });
    expect(events).toEqual([]);
  });
});

describe('aggregateIntermediateDemand', () => {
  test('sums quantities for the same (intermediate, date)', () => {
    const events = [
      {
        intermediateCode: 'XHBC',
        intermediateName: 'Chaga',
        quantity: 30,
        requiredByDate: '2026-05-15',
        drivenBy: { productCode: 'FCHAGALG', productName: 'X', packagingQuantity: 60, packagingDate: '2026-05-15' },
      },
      {
        intermediateCode: 'XHBC',
        intermediateName: 'Chaga',
        quantity: 50,
        requiredByDate: '2026-05-15',
        drivenBy: { productCode: 'FCHAGASM', productName: 'X', packagingQuantity: 100, packagingDate: '2026-05-15' },
      },
    ];
    const out = aggregateIntermediateDemand(events);
    expect(out).toHaveLength(1);
    expect(out[0].totalQuantity).toBe(80);
    expect(out[0].drivers).toHaveLength(2);
  });

  test('keeps separate rows for different dates', () => {
    const events = [
      {
        intermediateCode: 'XHBC',
        intermediateName: 'Chaga',
        quantity: 30,
        requiredByDate: '2026-05-15',
        drivenBy: { productCode: 'X', productName: 'X', packagingQuantity: 60, packagingDate: '2026-05-15' },
      },
      {
        intermediateCode: 'XHBC',
        intermediateName: 'Chaga',
        quantity: 50,
        requiredByDate: '2026-05-22',
        drivenBy: { productCode: 'X', productName: 'X', packagingQuantity: 100, packagingDate: '2026-05-22' },
      },
    ];
    const out = aggregateIntermediateDemand(events);
    expect(out).toHaveLength(2);
  });

  test('output is sorted by (date asc, intermediate asc)', () => {
    const events = [
      {
        intermediateCode: 'IGB',
        intermediateName: 'IGB',
        quantity: 10,
        requiredByDate: '2026-05-22',
        drivenBy: { productCode: 'X', productName: 'X', packagingQuantity: 1, packagingDate: '2026-05-22' },
      },
      {
        intermediateCode: 'XHBC',
        intermediateName: 'XHBC',
        quantity: 10,
        requiredByDate: '2026-05-15',
        drivenBy: { productCode: 'Y', productName: 'Y', packagingQuantity: 1, packagingDate: '2026-05-15' },
      },
      {
        intermediateCode: 'AAA',
        intermediateName: 'AAA',
        quantity: 10,
        requiredByDate: '2026-05-15',
        drivenBy: { productCode: 'Z', productName: 'Z', packagingQuantity: 1, packagingDate: '2026-05-15' },
      },
    ];
    const out = aggregateIntermediateDemand(events);
    expect(out.map((e) => `${e.date}/${e.intermediateCode}`)).toEqual([
      '2026-05-15/AAA',
      '2026-05-15/XHBC',
      '2026-05-22/IGB',
    ]);
  });
});
