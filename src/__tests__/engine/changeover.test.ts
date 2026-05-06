import {
  costToSwitch,
  DEFAULT_CHANGEOVER_MATRIX,
} from '@/lib/engine/changeover';
import type { ProductMeta, Station } from '@/lib/planning/engine-io';

// ─── Fixture helpers ─────────────────────────────────────────

function meta(
  overrides: Partial<ProductMeta> & {
    productCode: string;
  },
): ProductMeta {
  // Use explicit `in` checks so callers can pass `null` to override
  // a defaulted field (e.g. `extendedFamily: null` for unmapped SKUs).
  // `??` would coalesce null → default, defeating the override.
  return {
    productCode: overrides.productCode,
    productName: overrides.productName ?? overrides.productCode,
    family: 'family' in overrides ? overrides.family! : 'XHBC',
    extendedFamily:
      'extendedFamily' in overrides ? overrides.extendedFamily! : 'FAM Fungi',
    packageSize: overrides.packageSize ?? 'MED',
    station: overrides.station ?? 'bottlo',
    rateUnitsPerHour: overrides.rateUnitsPerHour ?? 200,
  };
}

const STATIONS: Station[] = ['hand-packing', 'elephant', 'dust', 'bottlo'];

// ─── Tests ───────────────────────────────────────────────────

describe('DEFAULT_CHANGEOVER_MATRIX', () => {
  // Lock the numbers from data/kitchen capacity and family plans.xlsx →
  // Packaging Line Capacity. Spreadsheet edits that change these numbers
  // MUST be reflected here in the same commit.

  test('hand-packing: 2 / 2 / 2 / 5', () => {
    expect(DEFAULT_CHANGEOVER_MATRIX['hand-packing']).toEqual({
      sizeSwitch: 2,
      familySameSize: 2,
      extendedFamily: 2,
      fullClean: 5,
    });
  });

  test('elephant: 2 / 5 / 5 / 15', () => {
    expect(DEFAULT_CHANGEOVER_MATRIX.elephant).toEqual({
      sizeSwitch: 2,
      familySameSize: 5,
      extendedFamily: 5,
      fullClean: 15,
    });
  });

  test('dust: 5 / 5 / 10 / 20', () => {
    expect(DEFAULT_CHANGEOVER_MATRIX.dust).toEqual({
      sizeSwitch: 5,
      familySameSize: 5,
      extendedFamily: 10,
      fullClean: 20,
    });
  });

  test('bottlo: 40 / 10 / 15 / 120 (the gradient that drives family-clustering)', () => {
    expect(DEFAULT_CHANGEOVER_MATRIX.bottlo).toEqual({
      sizeSwitch: 40,
      familySameSize: 10,
      extendedFamily: 15,
      fullClean: 120,
    });
  });
});

describe('costToSwitch', () => {
  describe('identity short-circuits', () => {
    test('returns 0 when prev is null (first batch on station)', () => {
      const curr = meta({ productCode: 'FCHAGALG' });
      for (const s of STATIONS) {
        expect(costToSwitch(null, curr, s)).toBe(0);
      }
    });

    test('returns 0 when prev and curr are the same product code', () => {
      const p = meta({ productCode: 'FCHAGALG' });
      for (const s of STATIONS) {
        expect(costToSwitch(p, p, s)).toBe(0);
      }
    });
  });

  describe('decision #1: full clean cases', () => {
    test('different extended families → fullClean on every station', () => {
      const prev = meta({ productCode: 'X', extendedFamily: 'FAM Fungi' });
      const curr = meta({ productCode: 'Y', extendedFamily: 'FAM MF - Granola' });
      expect(costToSwitch(prev, curr, 'hand-packing')).toBe(5);
      expect(costToSwitch(prev, curr, 'elephant')).toBe(15);
      expect(costToSwitch(prev, curr, 'dust')).toBe(20);
      expect(costToSwitch(prev, curr, 'bottlo')).toBe(120);
    });

    test('prev unmapped (null extFam) → fullClean', () => {
      const prev = meta({ productCode: 'UNMAPPED', extendedFamily: null });
      const curr = meta({ productCode: 'X' });
      expect(costToSwitch(prev, curr, 'bottlo')).toBe(120);
    });

    test('curr unmapped (null extFam) → fullClean', () => {
      const prev = meta({ productCode: 'X' });
      const curr = meta({ productCode: 'UNMAPPED', extendedFamily: null });
      expect(costToSwitch(prev, curr, 'bottlo')).toBe(120);
    });

    test('both unmapped → fullClean (no partial credit, decision #1)', () => {
      const prev = meta({ productCode: 'A', extendedFamily: null });
      const curr = meta({ productCode: 'B', extendedFamily: null });
      expect(costToSwitch(prev, curr, 'bottlo')).toBe(120);
    });
  });

  describe('within same extended family: cost ladder', () => {
    test('same family, same size, different product → familySameSize', () => {
      // Hypothetical: two SKUs sharing intermediate XHBC at MED size
      const prev = meta({ productCode: 'A', family: 'XHBC', packageSize: 'MED' });
      const curr = meta({ productCode: 'B', family: 'XHBC', packageSize: 'MED' });
      expect(costToSwitch(prev, curr, 'bottlo')).toBe(10);
      expect(costToSwitch(prev, curr, 'hand-packing')).toBe(2);
    });

    test('different family within same extended family, same size → extendedFamily', () => {
      const prev = meta({ productCode: 'A', family: 'XHBC', packageSize: 'MED' });
      const curr = meta({ productCode: 'B', family: 'XHCP', packageSize: 'MED' });
      expect(costToSwitch(prev, curr, 'bottlo')).toBe(15);
      expect(costToSwitch(prev, curr, 'dust')).toBe(10);
    });

    test('same family, different size → sizeSwitch (size ≥ familySameSize on bottlo)', () => {
      const prev = meta({ productCode: 'A', family: 'XHBC', packageSize: 'LRG' });
      const curr = meta({ productCode: 'B', family: 'XHBC', packageSize: 'SML' });
      expect(costToSwitch(prev, curr, 'bottlo')).toBe(40);
    });
  });

  describe('decision #2: non-cumulative max rule', () => {
    test('different family AND different size on bottlo → max(extFam=15, size=40) = 40', () => {
      const prev = meta({ productCode: 'A', family: 'XHBC', packageSize: 'LRG' });
      const curr = meta({ productCode: 'B', family: 'XHCP', packageSize: 'SML' });
      // Both in FAM Fungi by default
      expect(costToSwitch(prev, curr, 'bottlo')).toBe(40);
    });

    test('different family AND different size on dust → max(extFam=10, size=5) = 10', () => {
      const prev = meta({ productCode: 'A', family: 'XHBC', packageSize: 'LRG' });
      const curr = meta({ productCode: 'B', family: 'XHCP', packageSize: 'SML' });
      expect(costToSwitch(prev, curr, 'dust')).toBe(10);
    });

    test('NEVER additive — bottlo size+extFam is 40, not 55 (15 + 40)', () => {
      const prev = meta({ productCode: 'A', family: 'XHBC', packageSize: 'LRG' });
      const curr = meta({ productCode: 'B', family: 'XHCP', packageSize: 'SML' });
      const cost = costToSwitch(prev, curr, 'bottlo');
      expect(cost).not.toBe(15 + 40); // not summed
      expect(cost).toBe(40);
    });

    test('hand-packing is near-flat: any same-extFam switch costs ≤ 2', () => {
      const prev = meta({ productCode: 'A', family: 'XHBC', packageSize: 'LRG' });
      const curr = meta({ productCode: 'B', family: 'XHCP', packageSize: 'SML' });
      expect(costToSwitch(prev, curr, 'hand-packing')).toBe(2);
    });
  });

  describe('clarification: fullClean never triggers within a family or extended family', () => {
    test('switching family-mates never costs fullClean — even on bottlo', () => {
      const prev = meta({ productCode: 'A', family: 'XHBC', packageSize: 'MED' });
      const curr = meta({ productCode: 'B', family: 'XHBC', packageSize: 'MED' });
      // Bottlo fullClean is 120; familySameSize is 10. Must be 10.
      expect(costToSwitch(prev, curr, 'bottlo')).toBe(10);
      expect(costToSwitch(prev, curr, 'bottlo')).toBeLessThan(120);
    });

    test('switching extended-family-mates never costs fullClean either', () => {
      const prev = meta({ productCode: 'A', family: 'XHBC', extendedFamily: 'FAM Fungi' });
      const curr = meta({ productCode: 'B', family: 'XHCP', extendedFamily: 'FAM Fungi' });
      expect(costToSwitch(prev, curr, 'bottlo')).toBe(15);
      expect(costToSwitch(prev, curr, 'bottlo')).toBeLessThan(120);
    });
  });

  describe('matrix override', () => {
    test('caller can pass a custom matrix (for testing or future tuning)', () => {
      const prev = meta({ productCode: 'A' });
      const curr = meta({ productCode: 'B' });
      const customMatrix = {
        ...DEFAULT_CHANGEOVER_MATRIX,
        bottlo: {
          sizeSwitch: 99,
          familySameSize: 99,
          extendedFamily: 99,
          fullClean: 99,
        },
      };
      expect(costToSwitch(prev, curr, 'bottlo', customMatrix)).toBe(99);
    });
  });
});
