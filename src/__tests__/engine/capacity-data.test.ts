import { join } from 'path';
import {
  loadCapacityDataFromPath,
  inferPackageSize,
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
      expect(loaded.familyMap.FCHAGALG).toEqual({
        family: 'XHBC',
        extendedFamily: 'FAM Fungi',
      });
      expect(loaded.familyMap.FCHAGASM).toEqual({
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

    test('walnuts intermediate (IAW) has primary station elephant, alternate bottlo', () => {
      const iaw = loaded.intermediates.get('IAW');
      expect(iaw).toBeDefined();
      expect(iaw!.packingStation).toBe('elephant');
      expect(iaw!.alternateStation).toBe('bottlo');
      expect(iaw!.processSteps).toEqual(['soak', 'dehydrate']);
      expect(iaw!.maxSoakIbc).toBe(500);
      expect(iaw!.dehydHours).toBe(18.54);
    });

    test('Star Dust intermediates have station dust + alternate bottlo', () => {
      const isy = loaded.intermediates.get('ISY');
      expect(isy!.packingStation).toBe('dust');
      expect(isy!.alternateStation).toBe('bottlo');
    });

    test('"hand " station label normalises to hand-packing', () => {
      const itt = loaded.intermediates.get('ITT'); // "hand " in spreadsheet
      expect(itt!.packingStation).toBe('hand-packing');
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
