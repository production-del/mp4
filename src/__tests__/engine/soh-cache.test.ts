import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  readSohCacheFromFile,
  writeSohCacheToFile,
  buildSohCache,
  sohOf,
  sohBreakdownOf,
  type SohCache,
} from '@/lib/planning/soh-cache';

describe('buildSohCache', () => {
  test('aggregates all records preserving per-warehouse breakdown', () => {
    const out = buildSohCache([
      { productCode: 'A', warehouseName: 'WH1', qtyOnHand: 10 },
      { productCode: 'A', warehouseName: 'WH2', qtyOnHand: 5 },
      { productCode: 'B', warehouseName: 'WH1', qtyOnHand: 100 },
    ]);
    expect(out.byProductCode.A).toEqual({ WH1: 10, WH2: 5 });
    expect(out.byProductCode.B).toEqual({ WH1: 100 });
    expect(out.warehouses).toEqual(['WH1', 'WH2']);
    expect(out.totalRecords).toBe(3);
  });

  test('drops malformed records', () => {
    const out = buildSohCache([
      { productCode: '', warehouseName: 'WH1', qtyOnHand: 10 },
      { productCode: 'A', warehouseName: '', qtyOnHand: 10 }, // missing warehouse
      { productCode: 'A', warehouseName: 'WH1', qtyOnHand: NaN },
      { productCode: 'B', warehouseName: 'WH1', qtyOnHand: -5 },
      { productCode: 'C', warehouseName: 'WH1', qtyOnHand: 25 },
    ]);
    expect(Object.keys(out.byProductCode)).toEqual(['C']);
    expect(out.byProductCode.C).toEqual({ WH1: 25 });
  });

  test('duplicate (productCode, warehouseName) records sum', () => {
    const out = buildSohCache([
      { productCode: 'A', warehouseName: 'WH1', qtyOnHand: 10 },
      { productCode: 'A', warehouseName: 'WH1', qtyOnHand: 5 },
    ]);
    expect(out.byProductCode.A).toEqual({ WH1: 15 });
  });

  test('fetchedAt is a valid ISO timestamp', () => {
    const out = buildSohCache([]);
    expect(() => new Date(out.fetchedAt)).not.toThrow();
    expect(Number.isFinite(new Date(out.fetchedAt).getTime())).toBe(true);
  });
});

describe('sohOf', () => {
  const cache: SohCache = {
    fetchedAt: '2026-05-01T00:00:00Z',
    byProductCode: {
      FCHAGALG: { 'MF Packaging': 200, Lundberg: 34 },
      MFWALNUME: { 'MF Packaging': 1500 },
    },
    warehouses: ['Lundberg', 'MF Packaging'],
    totalRecords: 3,
  };

  test('without warehouse: sums across all warehouses', () => {
    expect(sohOf(cache, 'FCHAGALG')).toBe(234);
    expect(sohOf(cache, 'MFWALNUME')).toBe(1500);
  });
  test('with warehouse: returns that warehouse only', () => {
    expect(sohOf(cache, 'FCHAGALG', 'MF Packaging')).toBe(200);
    expect(sohOf(cache, 'FCHAGALG', 'Lundberg')).toBe(34);
  });
  test('returns 0 for warehouse with no record', () => {
    expect(sohOf(cache, 'FCHAGALG', 'TBC')).toBe(0);
  });
  test('returns 0 for absent product codes', () => {
    expect(sohOf(cache, 'UNKNOWN')).toBe(0);
    expect(sohOf(cache, 'UNKNOWN', 'MF Packaging')).toBe(0);
  });
  test('returns 0 when cache is null', () => {
    expect(sohOf(null, 'FCHAGALG')).toBe(0);
    expect(sohOf(null, 'FCHAGALG', 'MF Packaging')).toBe(0);
  });
});

describe('sohBreakdownOf', () => {
  const cache: SohCache = {
    fetchedAt: '2026-05-01T00:00:00Z',
    byProductCode: { A: { WH1: 10, WH2: 5 } },
    warehouses: ['WH1', 'WH2'],
    totalRecords: 2,
  };

  test('returns the per-warehouse map', () => {
    expect(sohBreakdownOf(cache, 'A')).toEqual({ WH1: 10, WH2: 5 });
  });
  test('returns null for absent codes', () => {
    expect(sohBreakdownOf(cache, 'X')).toBeNull();
  });
  test('returns null when cache is null', () => {
    expect(sohBreakdownOf(null, 'A')).toBeNull();
  });
});

describe('soh-cache: file persistence', () => {
  let tempDir: string;
  let filePath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'soh-cache-test-'));
    filePath = join(tempDir, 'soh.json');
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('readSohCacheFromFile returns null when file missing', () => {
    expect(readSohCacheFromFile(filePath)).toBeNull();
  });

  test('write then read round-trips per-warehouse data', () => {
    const cache = buildSohCache([
      { productCode: 'A', warehouseName: 'WH1', qtyOnHand: 10 },
      { productCode: 'A', warehouseName: 'WH2', qtyOnHand: 5 },
    ]);
    writeSohCacheToFile(cache, filePath);
    const back = readSohCacheFromFile(filePath);
    expect(back).not.toBeNull();
    expect(back!.byProductCode.A).toEqual({ WH1: 10, WH2: 5 });
    expect(back!.warehouses).toEqual(['WH1', 'WH2']);
    expect(back!.fetchedAt).toBe(cache.fetchedAt);
  });

  test('returns null on malformed JSON', () => {
    writeFileSync(filePath, 'not json {{{', 'utf-8');
    expect(readSohCacheFromFile(filePath)).toBeNull();
  });

  test('returns null on missing required fields', () => {
    writeFileSync(filePath, JSON.stringify({ wrong: 'shape' }), 'utf-8');
    expect(readSohCacheFromFile(filePath)).toBeNull();
  });

  test('returns null when byProductCode is an array', () => {
    writeFileSync(
      filePath,
      JSON.stringify({
        fetchedAt: '2026-05-01T00:00:00Z',
        byProductCode: [1, 2, 3],
      }),
      'utf-8',
    );
    expect(readSohCacheFromFile(filePath)).toBeNull();
  });

  test('drops non-numeric quantities from per-warehouse breakdown', () => {
    writeFileSync(
      filePath,
      JSON.stringify({
        fetchedAt: '2026-05-01T00:00:00Z',
        byProductCode: {
          A: { WH1: 10, WH2: 'not a number', WH3: -5, WH4: 20 },
          B: 'not an object',
          C: { WH1: 50 },
        },
        warehouses: ['WH1', 'WH2', 'WH3', 'WH4'],
      }),
      'utf-8',
    );
    const back = readSohCacheFromFile(filePath);
    expect(back!.byProductCode).toEqual({
      A: { WH1: 10, WH4: 20 },
      C: { WH1: 50 },
    });
  });

  test('creates parent directory when missing', () => {
    const nested = join(tempDir, 'nested', 'soh.json');
    const cache = buildSohCache([]);
    writeSohCacheToFile(cache, nested);
    expect(readSohCacheFromFile(nested)).not.toBeNull();
  });
});
