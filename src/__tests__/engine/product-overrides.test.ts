import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  setOverride,
  clearOverride,
  resolveOverride,
  readProductOverrides,
  writeProductOverrides,
  type ProductOverridesMap,
} from '@/lib/planning/product-overrides';

describe('product-overrides: pure operations', () => {
  describe('setOverride', () => {
    test('creates a new entry when none exists', () => {
      const out = setOverride({}, 'A', { shelfLifeDays: 365 });
      expect(out['A']).toEqual({ shelfLifeDays: 365 });
    });

    test('merges with existing entry', () => {
      const start: ProductOverridesMap = { A: { shelfLifeDays: 365 } };
      const out = setOverride(start, 'A', { maxBatchSize: 800 });
      expect(out['A']).toEqual({ shelfLifeDays: 365, maxBatchSize: 800 });
    });

    test('rounds non-integer values', () => {
      const out = setOverride({}, 'A', { shelfLifeDays: 365.7 });
      expect(out['A'].shelfLifeDays).toBe(366);
    });

    test('rejects non-positive values silently', () => {
      const out = setOverride({}, 'A', { shelfLifeDays: 0, maxBatchSize: -10 });
      expect(out['A']).toBeUndefined();
    });

    test('rejects NaN', () => {
      const out = setOverride({}, 'A', { shelfLifeDays: NaN });
      expect(out['A']).toBeUndefined();
    });

    test('returns a new object (no mutation of input)', () => {
      const start: ProductOverridesMap = {};
      const out = setOverride(start, 'A', { shelfLifeDays: 365 });
      expect(start).toEqual({});
      expect(out).not.toBe(start);
    });
  });

  describe('clearOverride', () => {
    test('drops the entry', () => {
      const start: ProductOverridesMap = { A: { shelfLifeDays: 365 } };
      const out = clearOverride(start, 'A');
      expect(out['A']).toBeUndefined();
    });

    test('no-op when no entry exists', () => {
      const start: ProductOverridesMap = {};
      const out = clearOverride(start, 'A');
      expect(out).toBe(start);
    });
  });

  describe('resolveOverride', () => {
    const defaults = { shelfLifeDays: 540, maxBatchSize: 1500 };

    test('returns defaults when no override exists', () => {
      const r = resolveOverride({}, 'A', defaults);
      expect(r.shelfLifeDays).toBe(540);
      expect(r.maxBatchSize).toBe(1500);
      expect(r.overridden).toEqual({
        shelfLifeDays: false,
        maxBatchSize: false,
        sohFloorDays: false,
      });
    });

    test('partial override falls back per-field', () => {
      const map: ProductOverridesMap = { A: { shelfLifeDays: 365 } };
      const r = resolveOverride(map, 'A', defaults);
      expect(r.shelfLifeDays).toBe(365);
      expect(r.maxBatchSize).toBe(1500);
      expect(r.overridden).toEqual({
        shelfLifeDays: true,
        maxBatchSize: false,
        sohFloorDays: false,
      });
    });

    test('full override on both fields', () => {
      const map: ProductOverridesMap = {
        A: { shelfLifeDays: 90, maxBatchSize: 600 },
      };
      const r = resolveOverride(map, 'A', defaults);
      expect(r.shelfLifeDays).toBe(90);
      expect(r.maxBatchSize).toBe(600);
      expect(r.overridden).toEqual({
        shelfLifeDays: true,
        maxBatchSize: true,
        sohFloorDays: false,
      });
    });

    test('Phase 4l.12: sohFloorDays override is plumbed through', () => {
      const map: ProductOverridesMap = { A: { sohFloorDays: 14 } };
      const r = resolveOverride(map, 'A', defaults);
      expect(r.sohFloorDays).toBe(14);
      expect(r.overridden.sohFloorDays).toBe(true);
    });

    test('Phase 4l.12: sohFloorDays = 0 (disable floor for this SKU) is preserved', () => {
      const map: ProductOverridesMap = { A: { sohFloorDays: 0 } };
      const r = resolveOverride(map, 'A', defaults);
      expect(r.sohFloorDays).toBe(0);
      expect(r.overridden.sohFloorDays).toBe(true);
    });
  });
});

describe('product-overrides: file persistence', () => {
  let tempDir: string;
  let filePath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'product-overrides-test-'));
    filePath = join(tempDir, 'overrides.json');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('readProductOverrides returns empty when file missing', () => {
    expect(readProductOverrides(filePath)).toEqual({});
  });

  test('write then read round-trips the map', () => {
    const m: ProductOverridesMap = { A: { shelfLifeDays: 365, maxBatchSize: 800 } };
    writeProductOverrides(m, filePath);
    expect(readProductOverrides(filePath)).toEqual(m);
  });

  test('writes pretty-formatted JSON', () => {
    const m: ProductOverridesMap = { A: { shelfLifeDays: 365 } };
    writeProductOverrides(m, filePath);
    const text = readFileSync(filePath, 'utf-8');
    expect(text).toContain('  '); // indent
    expect(text.endsWith('\n')).toBe(true);
  });

  test('tolerates malformed JSON', () => {
    writeFileSync(filePath, 'not json {{{', 'utf-8');
    expect(readProductOverrides(filePath)).toEqual({});
  });

  test('rejects array root', () => {
    writeFileSync(filePath, '[1,2,3]', 'utf-8');
    expect(readProductOverrides(filePath)).toEqual({});
  });

  test('drops malformed entries from a partially-good file', () => {
    writeFileSync(
      filePath,
      JSON.stringify({
        A: { shelfLifeDays: 365 },
        B: 'not an object',
        C: { shelfLifeDays: -10 }, // dropped — non-positive
        D: [1, 2, 3], // dropped — array
      }),
      'utf-8',
    );
    const out = readProductOverrides(filePath);
    expect(out).toEqual({ A: { shelfLifeDays: 365 } });
  });

  test('creates parent directory if missing', () => {
    const nested = join(tempDir, 'nested', 'path', 'overrides.json');
    expect(existsSync(nested)).toBe(false);
    writeProductOverrides({ A: { shelfLifeDays: 365 } }, nested);
    expect(existsSync(nested)).toBe(true);
  });
});
