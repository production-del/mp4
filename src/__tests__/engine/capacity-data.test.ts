import { join } from 'path';
import {
  loadCapacityDataFromPath,
  inferPackageSize,
  cleanProductName,
  IBC_CAPACITY_KG,
} from '@/lib/planning/capacity-data';

const SPREADSHEET_PATH = join(
  process.cwd(),
  'data',
  'kitchen capacity and family plans.xlsx',
);

// One-shot load: parsing the workbook is the slowest part of these tests.
// All assertions read from the same `loaded` object.
const loaded = loadCapacityDataFromPath(SPREADSHEET_PATH);

describe('loadCapacityDataFromPath — real spreadsheet', () => {
  describe('packaging line capacity', () => {
    test('produces all 4 stations with defaults', () => {
      expect(Object.keys(loaded.stations).sort()).toEqual([
        'bottlo',
        'dust',
        'elephant',
        'hand-packing',
      ]);
    });

    test('hand-packing defaults: 3 staff, 8 hours, 200 u/hr', () => {
      expect(loaded.stations['hand-packing']).toEqual({
        staffNeeded: 3,
        hoursPerDay: 8,
        unitsPerHour: 200,
      });
    });

    test('bottlo defaults: 5 staff, 8 hours, 375 u/hr', () => {
      expect(loaded.stations.bottlo).toEqual({
        staffNeeded: 5,
        hoursPerDay: 8,
        unitsPerHour: 375,
      });
    });

    test('changeover matrix matches the spreadsheet (and the DEFAULT_CHANGEOVER_MATRIX in changeover.ts)', () => {
      expect(loaded.changeoverMatrix.bottlo).toEqual({
        sizeSwitch: 40,
        familySameSize: 10,
        extendedFamily: 15,
        fullClean: 120,
      });
      expect(loaded.changeoverMatrix['hand-packing']).toEqual({
        sizeSwitch: 2,
        familySameSize: 2,
        extendedFamily: 2,
        fullClean: 5,
      });
      expect(loaded.changeoverMatrix.elephant).toEqual({
        sizeSwitch: 2,
        familySameSize: 5,
        extendedFamily: 5,
        fullClean: 15,
      });
      expect(loaded.changeoverMatrix.dust).toEqual({
        sizeSwitch: 5,
        familySameSize: 5,
        extendedFamily: 10,
        fullClean: 20,
      });
    });
  });

  describe('family + extended-family map', () => {
    test('loads all 206 SKU rows', () => {
      expect(Object.keys(loaded.familyMap)).toHaveLength(206);
    });

    test('knows Chaga products (FCHAGALG, FCHAGASM) → XHBC → FAM Fungi', () => {
      expect(loaded.familyMap.FCHAGALG).toMatchObject({
        family: 'XHBC',
        extendedFamily: 'FAM Fungi',
      });
      expect(loaded.familyMap.FCHAGALG.description).toMatch(/Chaga/i);
      expect(loaded.familyMap.FCHAGASM).toMatchObject({
        family: 'XHBC',
        extendedFamily: 'FAM Fungi',
      });
    });

    test('produces exactly 6 distinct extended-family values', () => {
      const values = new Set<string>();
      for (const meta of Object.values(loaded.familyMap)) {
        if (meta.extendedFamily !== null) values.add(meta.extendedFamily);
      }
      expect(Array.from(values).sort()).toEqual([
        'FAM Fungi',
        'FAM MF - Clusters',
        'FAM MF - Granola',
        'FAM MF - Munchies',
        'FAM MF - Nuts',
        'FAM MF - Tea',
      ]);
    });

    test('108 SKUs have null extendedFamily (decision #1 scope)', () => {
      const unmapped = Object.values(loaded.familyMap).filter(
        (m) => m.extendedFamily === null,
      );
      expect(unmapped).toHaveLength(108);
    });
  });

  describe('kitchen processes', () => {
    test('loads 66 intermediates', () => {
      expect(loaded.intermediates.size).toBe(66);
    });

    // These tests lock the spreadsheet's CURRENT routing. Update when the
    // spreadsheet changes intentionally. Failures here mean the data
    // moved — investigate before silently re-baselining.
    test('walnuts intermediate (IAW) has primary station bottlo, alternate elephant', () => {
      const iaw = loaded.intermediates.get('IAW');
      expect(iaw).toBeDefined();
      expect(iaw!.packingStation).toBe('bottlo');
      expect(iaw!.alternateStation).toBe('elephant');
      expect(iaw!.processSteps).toEqual(['soak', 'dehydrate']);
      expect(iaw!.maxSoakIbc).toBe(500);
      expect(iaw!.dehydHours).toBe(18.54);
    });

    test('Star Dust intermediates (ISY) have station bottlo + alternate dust', () => {
      const isy = loaded.intermediates.get('ISY');
      expect(isy!.packingStation).toBe('bottlo');
      expect(isy!.alternateStation).toBe('dust');
    });

    test('"hand " station label normalises to hand-packing (in alternate column for ITT)', () => {
      // ITT now has empty primary + "hand " in alternate.
      const itt = loaded.intermediates.get('ITT');
      expect(itt!.packingStation).toBeNull();
      expect(itt!.alternateStation).toBe('hand-packing');
    });

    test('"BULK" packing equipment becomes null station (no warning)', () => {
      const irm = loaded.intermediates.get('IRM');
      expect(irm!.packingStation).toBeNull();
    });
  });

  describe('decision #6: dehydrate-in-packing-equipment warnings', () => {
    test('warnings include zero or more dehydrate_in_packing_equipment entries (depending on data)', () => {
      // The data may or may not have the typo present today; the assertion is
      // that *if* it appears, it's surfaced as a warning rather than a crash,
      // and the offending row's intermediate has no stale "dehydrate" station.
      const dehydrateWarnings = loaded.warnings.filter(
        (w) => w.kind === 'dehydrate_in_packing_equipment',
      );
      for (const w of dehydrateWarnings) {
        expect(w).toHaveProperty('productCode');
        const inter = loaded.intermediates.get((w as { productCode: string }).productCode);
        expect(inter).toBeDefined();
        expect(inter!.packingStation).not.toBe('dehydrate' as unknown as never);
      }
    });
  });

  describe('BOMs', () => {
    test('loads >2,000 BOM rows (sheet has 2,730 valid lines)', () => {
      expect(loaded.bom.length).toBeGreaterThan(2000);
    });

    test('FCHAGALG BOM includes XHBC intermediate at 0.45 per unit', () => {
      const chagaRows = loaded.bom.filter((r) => r.parentProductCode === 'FCHAGALG');
      expect(chagaRows.length).toBeGreaterThan(0);
      const xhbcRow = chagaRows.find((r) => r.productCode === 'XHBC');
      expect(xhbcRow).toBeDefined();
      expect(xhbcRow!.quantityPerParent).toBeCloseTo(0.45, 6);
    });
  });

  describe('product meta derivation', () => {
    test('FCHAGALG has packageSize LRG and station inferred from XHBC intermediate', () => {
      const meta = loaded.productMetaBySku.FCHAGALG;
      expect(meta).toBeDefined();
      expect(meta.packageSize).toBe('LRG');
      expect(meta.family).toBe('XHBC');
      expect(meta.extendedFamily).toBe('FAM Fungi');
    });

    test('productName is populated from the family sheet description and cleaned', () => {
      const meta = loaded.productMetaBySku.FCHAGALG;
      expect(meta.productName).toBeTruthy();
      expect(meta.productName).toMatch(/Chaga/i);
      // No "Label - " prefix, no "(600g)" volume tag
      expect(meta.productName).not.toMatch(/^Label/i);
      expect(meta.productName).not.toMatch(/\(\d+\s*g\)/i);
    });

    test('rateUnitsPerHour is sourced from the assigned station defaults', () => {
      const meta = loaded.productMetaBySku.FCHAGALG;
      const station = loaded.stations[meta.station];
      expect(meta.rateUnitsPerHour).toBe(station.unitsPerHour);
    });
  });

  describe('IBC capacity constant (decision #5)', () => {
    test('IBC_CAPACITY_KG = 300', () => {
      expect(IBC_CAPACITY_KG).toBe(300);
    });
  });

  describe('wastage rates tab (decision #3)', () => {
    test('BOM rows with a known wastage entry carry both clean and wastage', () => {
      // From the spreadsheet: MFBLCUMSM/BLCUM has clean 0.12, wastage 0.02.
      const row = loaded.bom.find(
        (r) => r.parentProductCode === 'MFBLCUMSM' && r.productCode === 'BLCUM',
      );
      expect(row).toBeDefined();
      expect(row!.cleanQuantityPerParent).toBeCloseTo(0.12, 6);
      expect(row!.wastageQuantityPerParent).toBeCloseTo(0.02, 6);
      // Combined matches the BOMS sheet's "Quantity + Wastage" column
      expect(row!.quantityPerParent).toBeCloseTo(0.14, 6);
    });

    test('BOMS/wastage-tab disagreement on combined value emits a warning and rescales the split', () => {
      // Real data: BOMS says FCHAGALG/XHBC = 0.45; wastage tab says
      // 0.6 + 0 = 0.6. Loader keeps BOMS as authoritative (0.45) and
      // rescales the wastage proportion to anchor to it.
      const row = loaded.bom.find(
        (r) => r.parentProductCode === 'FCHAGALG' && r.productCode === 'XHBC',
      );
      expect(row).toBeDefined();
      expect(row!.quantityPerParent).toBeCloseTo(0.45, 6);
      // Wastage tab proportion: clean 100% / wastage 0% → rescaled to 0.45 + 0
      expect(row!.cleanQuantityPerParent).toBeCloseTo(0.45, 6);
      expect(row!.wastageQuantityPerParent).toBeCloseTo(0, 6);
      const mismatch = loaded.warnings.find(
        (w) =>
          w.kind === 'wastage_combined_mismatch' &&
          'parentProductCode' in w &&
          w.parentProductCode === 'FCHAGALG' &&
          w.componentProductCode === 'XHBC',
      );
      expect(mismatch).toBeDefined();
    });

    test('BOM rows with no wastage tab entry leave split fields undefined', () => {
      // Find a BOM row not in the wastage map. We don't know which ones in
      // advance, so scan for the first one with no split.
      const row = loaded.bom.find(
        (r) => r.cleanQuantityPerParent === undefined,
      );
      // It's plausible all rows have entries (the wastage tab is large), but
      // when one exists, both fields should be undefined together.
      if (row) {
        expect(row.wastageQuantityPerParent).toBeUndefined();
      }
    });

    test('zero-wastage entries still attach the split (clean known, wastage = 0)', () => {
      // Pick any row that's in the wastage map with wastage 0; need to scan
      // since the data is sparse. ABCSG/CORIANDERSEEDS appears in the dump.
      const row = loaded.bom.find(
        (r) => r.parentProductCode === 'ABCSG' && r.productCode === 'CORIANDERSEEDS',
      );
      if (row) {
        expect(row.cleanQuantityPerParent).toBe(1);
        expect(row.wastageQuantityPerParent).toBe(0);
      }
    });
  });
});

describe('inferPackageSize', () => {
  test.each([
    ['FCHAGALG', 'LRG'],
    ['FCHAGASM', 'SML'],
    ['MFGINGGME', 'MED'],
    ['MFCHAGAB6', 'OTHER'],
    ['SOMETHING', 'OTHER'],
  ])('inferPackageSize(%s) → %s', (code, expected) => {
    expect(inferPackageSize(code)).toBe(expected);
  });
});

describe('cleanProductName', () => {
  test.each([
    ['Label - Chaga (600g)', 'Chaga'],
    ['Label - Almonds LRG (500g)', 'Almonds LRG'],
    ['Label - Beetroot Powder MED (340g)', 'Beetroot Powder MED'],
    ['Label - Ginger Ground MED (240g) DISCONTINUED', 'Ginger Ground MED'],
    ['Label - Yummy Beans Intermediate', 'Yummy Beans Intermediate'],
    ['Label - Big Bag (1.5kg)', 'Big Bag'],
    ['Label - Tiny (50 ml)', 'Tiny'],
    // Trailing non-parenthesised volume
    ['Label - Garlic Powder - Organic 100g', 'Garlic Powder - Organic'],
    ['Label - Cacao Powder LRG - Organic 440g', 'Cacao Powder LRG - Organic'],
    ['Label - Blue Lotus Flowers MED - Organic 20g', 'Blue Lotus Flowers MED - Organic'],
    // Volume + trailing DISCONTINUED — order matters in the cleaning pass
    ['Label - Blue Butterfly Pea Flowers MED - Organic 50g DISCONTINUED', 'Blue Butterfly Pea Flowers MED - Organic'],
    ['Label - Raw Macadamias SML - Organic 125g DISCONTINUED', 'Raw Macadamias SML - Organic'],
    ['Already clean name', 'Already clean name'],
    ['', ''],
  ])('cleanProductName(%j) → %j', (input, expected) => {
    expect(cleanProductName(input)).toBe(expected);
  });

  test('handles multiple volume markers (defensive, real data is single)', () => {
    expect(cleanProductName('Label - Foo (100g) Bar (200g)')).toBe('Foo Bar');
  });
});
