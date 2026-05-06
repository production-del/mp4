import {
  explodeBom,
  aggregateExplodedComponents,
  type FamilyMeta,
} from '@/lib/engine/bom-explode';
import type { BOMComponent } from '@/lib/planning/engine-io';

// ─── Fixture helpers ─────────────────────────────────────────

function row(
  parent: string,
  product: string,
  qty: number,
  level = 1,
  name = product,
): BOMComponent {
  return {
    parentProductCode: parent,
    productCode: product,
    productName: name,
    quantityPerParent: qty,
    level,
  };
}

// Realistic-ish 3-level BOM modelled on the data in the spreadsheet:
//   GRANOLA (finished) → IGB (intermediate) → OATS_RAW + WALNUT_INT
//                                              ↑
//                          IGB also → HONEY_RAW directly
//   WALNUT_INT (intermediate) → WALNUT_RAW
const THREE_LEVEL_BOM: BOMComponent[] = [
  // root → intermediate
  row('GRANOLA', 'IGB', 0.5),
  row('GRANOLA', 'JAR1000', 1, 1, '1L Jar'),
  row('GRANOLA', 'LID82', 1, 1, 'Lid 82mm'),
  // intermediate → sub-components
  row('IGB', 'OATS_RAW', 0.6, 2),
  row('IGB', 'WALNUT_INT', 0.3, 2),
  row('IGB', 'HONEY_RAW', 0.1, 2),
  // sub-intermediate → raw
  row('WALNUT_INT', 'WALNUT_RAW', 1.0, 3),
];

// ─── Tests ───────────────────────────────────────────────────

describe('explodeBom', () => {
  describe('basic shapes', () => {
    test('explodes a flat one-level BOM', () => {
      const bom: BOMComponent[] = [
        row('A', 'B', 2),
        row('A', 'C', 3),
      ];
      const r = explodeBom({ rootProductCode: 'A', rootQuantity: 1, bom });
      expect(r.warnings).toEqual([]);
      expect(r.components).toHaveLength(2);
      expect(r.components.map((c) => c.productCode).sort()).toEqual(['B', 'C']);
      for (const c of r.components) {
        expect(c.depth).toBe(1);
        expect(c.path[0]).toBe('A');
        expect(c.path[c.path.length - 1]).toBe(c.productCode);
      }
    });

    test('scales by rootQuantity', () => {
      const bom: BOMComponent[] = [row('A', 'B', 0.45)];
      const r = explodeBom({ rootProductCode: 'A', rootQuantity: 100, bom });
      expect(r.components[0].totalQuantity).toBe(45);
    });

    test('returns empty + warning when root has no BOM', () => {
      const bom: BOMComponent[] = [row('OTHER', 'X', 1)];
      const r = explodeBom({ rootProductCode: 'A', rootQuantity: 1, bom });
      expect(r.components).toEqual([]);
      expect(r.warnings).toHaveLength(1);
      expect(r.warnings[0].kind).toBe('no_bom_for_root');
      expect(r.warnings[0].productCode).toBe('A');
    });
  });

  describe('cascading', () => {
    test('explodes a two-level BOM with intermediate', () => {
      const bom: BOMComponent[] = [
        row('FG', 'INT', 1.0),
        row('INT', 'RAW', 2.0),
      ];
      const r = explodeBom({ rootProductCode: 'FG', rootQuantity: 10, bom });
      expect(r.components).toHaveLength(2);
      const int = r.components.find((c) => c.productCode === 'INT')!;
      const raw = r.components.find((c) => c.productCode === 'RAW')!;
      expect(int.depth).toBe(1);
      expect(int.totalQuantity).toBe(10); // 10 × 1.0
      expect(raw.depth).toBe(2);
      expect(raw.totalQuantity).toBe(20); // 10 × 1.0 × 2.0
      expect(raw.path).toEqual(['FG', 'INT', 'RAW']);
    });

    test('explodes a three-level BOM (Granola → IGB → WALNUT_INT → WALNUT_RAW)', () => {
      const r = explodeBom({
        rootProductCode: 'GRANOLA',
        rootQuantity: 100,
        bom: THREE_LEVEL_BOM,
      });
      const walnutRaw = r.components.find((c) => c.productCode === 'WALNUT_RAW');
      expect(walnutRaw).toBeDefined();
      expect(walnutRaw!.depth).toBe(3);
      expect(walnutRaw!.path).toEqual(['GRANOLA', 'IGB', 'WALNUT_INT', 'WALNUT_RAW']);
      // 100 × 0.5 (IGB per granola) × 0.3 (WALNUT_INT per IGB) × 1.0 = 15
      expect(walnutRaw!.totalQuantity).toBeCloseTo(15, 6);
    });

    test('handles diamond dependencies — same component reached via multiple paths', () => {
      // ROOT → A → SHARED
      // ROOT → B → SHARED
      const bom: BOMComponent[] = [
        row('ROOT', 'A', 1),
        row('ROOT', 'B', 1),
        row('A', 'SHARED', 2),
        row('B', 'SHARED', 3),
      ];
      const r = explodeBom({ rootProductCode: 'ROOT', rootQuantity: 1, bom });
      const sharedRows = r.components.filter((c) => c.productCode === 'SHARED');
      expect(sharedRows).toHaveLength(2);
      const viaA = sharedRows.find((c) => c.path.includes('A'))!;
      const viaB = sharedRows.find((c) => c.path.includes('B'))!;
      expect(viaA.totalQuantity).toBe(2);
      expect(viaB.totalQuantity).toBe(3);
    });

    test('leaf raw materials terminate naturally without warnings', () => {
      const bom: BOMComponent[] = [
        row('FG', 'INT', 1),
        row('INT', 'LEAF_RAW', 1), // LEAF_RAW has no BOM rows of its own
      ];
      const r = explodeBom({ rootProductCode: 'FG', rootQuantity: 1, bom });
      expect(r.warnings).toEqual([]);
      expect(r.components.find((c) => c.productCode === 'LEAF_RAW')).toBeDefined();
    });
  });

  describe('cycle detection', () => {
    test('throws on direct self-cycle A → A', () => {
      const bom: BOMComponent[] = [row('A', 'A', 1)];
      expect(() =>
        explodeBom({ rootProductCode: 'A', rootQuantity: 1, bom }),
      ).toThrow(/cycle detected.*A.*A/);
    });

    test('throws on indirect cycle A → B → A', () => {
      const bom: BOMComponent[] = [row('A', 'B', 1), row('B', 'A', 1)];
      expect(() =>
        explodeBom({ rootProductCode: 'A', rootQuantity: 1, bom }),
      ).toThrow(/cycle detected.*A.*B.*A/);
    });

    test('throws on deeper cycle A → B → C → B', () => {
      const bom: BOMComponent[] = [
        row('A', 'B', 1),
        row('B', 'C', 1),
        row('C', 'B', 1),
      ];
      expect(() =>
        explodeBom({ rootProductCode: 'A', rootQuantity: 1, bom }),
      ).toThrow(/cycle detected.*B.*C.*B/);
    });

    test('cycle path in error message names every node so users can locate the bad row', () => {
      const bom: BOMComponent[] = [row('X', 'Y', 1), row('Y', 'X', 1)];
      try {
        explodeBom({ rootProductCode: 'X', rootQuantity: 1, bom });
        fail('should have thrown');
      } catch (e) {
        const msg = (e as Error).message;
        expect(msg).toContain('X');
        expect(msg).toContain('Y');
      }
    });
  });

  describe('depth limit', () => {
    test('respects custom maxDepth', () => {
      // Linear chain of depth 5: A → B → C → D → E → F
      const bom: BOMComponent[] = [
        row('A', 'B', 1),
        row('B', 'C', 1),
        row('C', 'D', 1),
        row('D', 'E', 1),
        row('E', 'F', 1),
      ];
      // maxDepth=3 should fail before reaching E (depth 4)
      expect(() =>
        explodeBom({ rootProductCode: 'A', rootQuantity: 1, bom, maxDepth: 3 }),
      ).toThrow(/depth exceeded 3/);
    });

    test('default maxDepth (10) handles realistic 3-level BOMs comfortably', () => {
      const r = explodeBom({
        rootProductCode: 'GRANOLA',
        rootQuantity: 1,
        bom: THREE_LEVEL_BOM,
      });
      expect(r.components.length).toBeGreaterThan(0);
    });
  });

  describe('wastage split (decision #3)', () => {
    test('with no wastage rate, cleanQuantity = totalQuantity and wastageQuantity is null', () => {
      const bom: BOMComponent[] = [row('A', 'B', 100)];
      const r = explodeBom({ rootProductCode: 'A', rootQuantity: 1, bom });
      expect(r.components[0].cleanQuantity).toBe(100);
      expect(r.components[0].wastageQuantity).toBeNull();
    });

    test('with wastage rate r, cleanQuantity = total / (1+r) and wastage = total - clean', () => {
      // Spreadsheet says 108 (combined). Rate 0.08 means clean = 108/1.08 = 100, wastage = 8.
      const bom: BOMComponent[] = [row('A', 'B', 108)];
      const r = explodeBom({
        rootProductCode: 'A',
        rootQuantity: 1,
        bom,
        wastageRates: { B: 0.08 },
      });
      expect(r.components[0].totalQuantity).toBe(108);
      expect(r.components[0].cleanQuantity).toBeCloseTo(100, 6);
      expect(r.components[0].wastageQuantity).toBeCloseTo(8, 6);
    });

    test('different rates per component produce independent splits', () => {
      const bom: BOMComponent[] = [row('ROOT', 'X', 110), row('ROOT', 'Y', 105)];
      const r = explodeBom({
        rootProductCode: 'ROOT',
        rootQuantity: 1,
        bom,
        wastageRates: { X: 0.1, Y: 0.05 },
      });
      const x = r.components.find((c) => c.productCode === 'X')!;
      const y = r.components.find((c) => c.productCode === 'Y')!;
      expect(x.cleanQuantity).toBeCloseTo(100, 6); // 110 / 1.1
      expect(y.cleanQuantity).toBeCloseTo(100, 6); // 105 / 1.05
    });

    test('zero wastage rate is valid: clean = total, wastage = 0', () => {
      const bom: BOMComponent[] = [row('A', 'B', 100)];
      const r = explodeBom({
        rootProductCode: 'A',
        rootQuantity: 1,
        bom,
        wastageRates: { B: 0 },
      });
      expect(r.components[0].cleanQuantity).toBe(100);
      expect(r.components[0].wastageQuantity).toBe(0);
    });
  });

  describe('family annotation (Phase 3 input)', () => {
    test('annotates family + extendedFamily from familyMap', () => {
      const bom: BOMComponent[] = [row('FCHAGALG', 'XHBC', 0.45)];
      const familyMap: Record<string, FamilyMeta> = {
        XHBC: { family: 'XHBC', extendedFamily: 'FAM Fungi' },
      };
      const r = explodeBom({
        rootProductCode: 'FCHAGALG',
        rootQuantity: 1,
        bom,
        familyMap,
      });
      expect(r.components[0].family).toBe('XHBC');
      expect(r.components[0].extendedFamily).toBe('FAM Fungi');
    });

    test('null annotations for components not in the familyMap (decision #1)', () => {
      const bom: BOMComponent[] = [row('A', 'UNMAPPED', 1)];
      const r = explodeBom({ rootProductCode: 'A', rootQuantity: 1, bom });
      expect(r.components[0].family).toBeNull();
      expect(r.components[0].extendedFamily).toBeNull();
    });

    test('extendedFamily can be null even when family is present', () => {
      const bom: BOMComponent[] = [row('A', 'X', 1)];
      const r = explodeBom({
        rootProductCode: 'A',
        rootQuantity: 1,
        bom,
        familyMap: { X: { family: 'X', extendedFamily: null } },
      });
      expect(r.components[0].family).toBe('X');
      expect(r.components[0].extendedFamily).toBeNull();
    });
  });
});

describe('aggregateExplodedComponents', () => {
  test('sums quantities by productCode across paths', () => {
    // Diamond: ROOT → A → SHARED (qty 2), ROOT → B → SHARED (qty 3)
    const bom: BOMComponent[] = [
      row('ROOT', 'A', 1),
      row('ROOT', 'B', 1),
      row('A', 'SHARED', 2),
      row('B', 'SHARED', 3),
    ];
    const r = explodeBom({ rootProductCode: 'ROOT', rootQuantity: 1, bom });
    const agg = aggregateExplodedComponents(r.components);
    const shared = agg.find((a) => a.productCode === 'SHARED')!;
    expect(shared.totalQuantity).toBe(5);
    expect(shared.pathCount).toBe(2);
  });

  test('sums wastage when all contributors have it', () => {
    const bom: BOMComponent[] = [
      row('ROOT', 'A', 1),
      row('ROOT', 'B', 1),
      row('A', 'SHARED', 2),
      row('B', 'SHARED', 3),
    ];
    const r = explodeBom({
      rootProductCode: 'ROOT',
      rootQuantity: 1,
      bom,
      wastageRates: { SHARED: 0.1 },
    });
    const agg = aggregateExplodedComponents(r.components);
    const shared = agg.find((a) => a.productCode === 'SHARED')!;
    // total 5, rate 0.1 → clean 5/1.1 ≈ 4.545, wastage ≈ 0.4545
    // Each path contributes its own clean+wastage; sum should match
    expect(shared.cleanQuantity).toBeCloseTo(5 / 1.1, 6);
    expect(shared.wastageQuantity).toBeCloseTo(5 - 5 / 1.1, 6);
  });

  test('aggregated wastage is null when any contributor had unknown wastage', () => {
    // SHARED has wastage rate via path A but not via path B (impossible in
    // practice since rate is per-code, but the rule is per-row null
    // propagation). Simulate by providing rate only when wastage rates is omitted.
    const bom: BOMComponent[] = [
      row('ROOT', 'A', 1),
      row('A', 'SHARED', 2),
    ];
    const r = explodeBom({ rootProductCode: 'ROOT', rootQuantity: 1, bom });
    // No wastageRates → SHARED's wastageQuantity is null
    const agg = aggregateExplodedComponents(r.components);
    const shared = agg.find((a) => a.productCode === 'SHARED')!;
    expect(shared.wastageQuantity).toBeNull();
  });

  test('output is sorted alphabetically by productCode', () => {
    const bom: BOMComponent[] = [
      row('ROOT', 'ZULU', 1),
      row('ROOT', 'ALPHA', 1),
      row('ROOT', 'MIKE', 1),
    ];
    const r = explodeBom({ rootProductCode: 'ROOT', rootQuantity: 1, bom });
    const agg = aggregateExplodedComponents(r.components);
    expect(agg.map((a) => a.productCode)).toEqual(['ALPHA', 'MIKE', 'ZULU']);
  });

  test('preserves family annotation (taken from first occurrence)', () => {
    const bom: BOMComponent[] = [row('A', 'X', 1)];
    const r = explodeBom({
      rootProductCode: 'A',
      rootQuantity: 1,
      bom,
      familyMap: { X: { family: 'X', extendedFamily: 'FAM MF - Nuts' } },
    });
    const agg = aggregateExplodedComponents(r.components);
    expect(agg[0].family).toBe('X');
    expect(agg[0].extendedFamily).toBe('FAM MF - Nuts');
  });
});
