import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  readSohCache,
  writeSohCache,
  buildSohCache,
  sohOf,
  type SohCache,
} from '@/lib/planning/soh-cache';

describe('buildSohCache', () => {
  test('aggregates all records when no filter', () => {
    const out = buildSohCache([
      { productCode: 'A', warehouseName: 'WH1', qtyOnHand: 10 },
      { productCode: 'A', warehouseName: 'WH2', qtyOnHand: 5 },
      { productCode: 'B', warehouseName: 'WH1', qtyOnHand: 100 },
    ]);
    expect(out.byProductCode.A).toBe(15);
    expect(out.byProductCode.B).toBe(100);
    expect(out.totalRecords).toBe(3);
    expect(out.warehouseFilter).toBe('');
  });

  test('warehouseFilter restricts which records contribute', () => {
    const out = buildSohCache(
      [
        { productCode: 'A', warehouseName: 'MF Packaging', qtyOnHand: 10 },
        { productCode: 'A', warehouseName: 'Lundberg', qtyOnHand: 5 },
        { productCode: 'B', warehouseName: 'MF Packaging', qtyOnHand: 100 },
      ],
      'MF Packaging',
    );
    expect(out.byProductCode.A).toBe(10);
    expect(out.byProductCode.B).toBe(100);
    expect(out.totalRecords).toBe(2);
  });

  test('drops malformed records', () => {
    const out = buildSohCache([
      { productCode: '', warehouseName: 'WH1', qtyOnHand: 10 },
      { productCode: 'A', warehouseName: 'WH1', qtyOnHand: NaN },
      { productCode: 'B', warehouseName: 'WH1', qtyOnHand: -5 },
      { productCode: 'C', warehouseName: 'WH1', qtyOnHand: 25 },
    ]);
    expect(Object.keys(out.byProductCode)).toEqual(['C']);
    expect(out.byProductCode.C).toBe(25);
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
    warehouseFilter: '',
    byProductCode: { FCHAGALG: 234 },
    totalRecords: 1,
  };

  test('returns the cached quantity when present', () => {
    expect(sohOf(cache, 'FCHAGALG')).toBe(234);
  });
  test('returns 0 for absent codes', () => {
    expect(sohOf(cache, 'UNKNOWN')).toBe(0);
  });
  test('returns 0 when cache is null (no cache file)', () => {
    expect(sohOf(null, 'FCHAGALG')).toBe(0);
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

  test('readSohCache returns null when file missing', () => {
    expect(readSohCache(filePath)).toBeNull();
  });

  test('write then read round-trips', () => {
    const cache = buildSohCache([
      { productCode: 'A', warehouseName: '', qtyOnHand: 10 },
    ]);
    writeSohCache(cache, filePath);
    const back = readSohCache(filePath);
    expect(back).not.toBeNull();
    expect(back!.byProductCode.A).toBe(10);
    expect(back!.fetchedAt).toBe(cache.fetchedAt);
  });

  test('returns null on malformed JSON', () => {
    writeFileSync(filePath, 'not json {{{', 'utf-8');
    expect(readSohCache(filePath)).toBeNull();
  });

  test('returns null on missing required fields', () => {
    writeFileSync(filePath, JSON.stringify({ wrong: 'shape' }), 'utf-8');
    expect(readSohCache(filePath)).toBeNull();
  });

  test('returns null when byProductCode is an array', () => {
    writeFileSync(
      filePath,
      JSON.stringify({
        fetchedAt: '2026-05-01T00:00:00Z',
        warehouseFilter: '',
        byProductCode: [1, 2, 3],
      }),
      'utf-8',
    );
    expect(readSohCache(filePath)).toBeNull();
  });

  test('drops non-numeric quantities from byProductCode', () => {
    writeFileSync(
      filePath,
      JSON.stringify({
        fetchedAt: '2026-05-01T00:00:00Z',
        warehouseFilter: '',
        byProductCode: { A: 10, B: 'not a number', C: -5, D: 20 },
      }),
      'utf-8',
    );
    const back = readSohCache(filePath);
    expect(back!.byProductCode).toEqual({ A: 10, D: 20 });
  });

  test('creates parent directory when missing', () => {
    const nested = join(tempDir, 'nested', 'soh.json');
    const cache = buildSohCache([]);
    writeSohCache(cache, nested);
    expect(readSohCache(nested)).not.toBeNull();
  });
});
