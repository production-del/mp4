import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  buildAssembliesCache,
  readAssembliesCacheFromFile,
  writeAssembliesCacheToFile,
  assembliesAtWarehouse,
  type AssembliesCache,
} from '@/lib/planning/assemblies-cache';

describe('buildAssembliesCache', () => {
  test('keeps valid assemblies and derives YYYY-MM-DD date', () => {
    const out = buildAssembliesCache([
      {
        assemblyNumber: 'A-1',
        productCode: 'XHBC',
        productName: 'Chaga',
        quantity: 60,
        warehouseName: 'Lundberg Storeroom',
        status: 'InProgress',
        lastModifiedOn: '2026-05-15T08:30:00.000Z',
      },
    ]);
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0].scheduledDate).toMatch(/^2026-05-1[45]$/); // local conversion
    expect(out.lines[0].quantity).toBe(60);
  });

  test('falls back to createdOn when lastModifiedOn is absent', () => {
    const out = buildAssembliesCache([
      {
        assemblyNumber: 'A-1',
        productCode: 'X',
        productName: 'X',
        quantity: 10,
        warehouseName: 'WH',
        status: 'Open',
        createdOn: '2026-05-15T00:00:00Z',
      },
    ]);
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0].scheduledDate).toMatch(/^2026-05-1[45]$/);
  });

  test('Phase 4l.12: PREFERS assembleBy over lastModifiedOn / createdOn', () => {
    // AssembleBy is the user's intended scheduled date. Audit
    // timestamps (lastModifiedOn/createdOn) cluster on "today" rather
    // than reflecting real production timing, so they're fallbacks
    // only.
    const out = buildAssembliesCache([
      {
        assemblyNumber: 'A-1',
        productCode: 'X',
        productName: 'X',
        quantity: 10,
        warehouseName: 'WH',
        status: 'Parked',
        assembleBy: '2026-06-15T00:00:00Z',
        lastModifiedOn: '2026-05-15T00:00:00Z',
        createdOn: '2026-05-01T00:00:00Z',
      },
    ]);
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0].scheduledDate).toMatch(/^2026-06-1[45]$/);
  });

  test('Phase 4l.12: falls back to lastModifiedOn when assembleBy missing', () => {
    const out = buildAssembliesCache([
      {
        assemblyNumber: 'A-1',
        productCode: 'X',
        productName: 'X',
        quantity: 10,
        warehouseName: 'WH',
        status: 'Parked',
        lastModifiedOn: '2026-05-15T00:00:00Z',
      },
    ]);
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0].scheduledDate).toMatch(/^2026-05-1[45]$/);
  });

  test('drops assemblies with no usable date', () => {
    const out = buildAssembliesCache([
      {
        assemblyNumber: 'A-1',
        productCode: 'X',
        productName: 'X',
        quantity: 10,
        warehouseName: 'WH',
        status: 'Open',
      },
    ]);
    expect(out.lines).toEqual([]);
  });

  test('drops malformed quantities + missing codes', () => {
    const out = buildAssembliesCache([
      {
        assemblyNumber: '',
        productCode: 'X',
        productName: 'X',
        quantity: 10,
        warehouseName: 'WH',
        status: 'Open',
        lastModifiedOn: '2026-05-15T00:00:00Z',
      },
      {
        assemblyNumber: 'A-2',
        productCode: '',
        productName: 'X',
        quantity: 10,
        warehouseName: 'WH',
        status: 'Open',
        lastModifiedOn: '2026-05-15T00:00:00Z',
      },
      {
        assemblyNumber: 'A-3',
        productCode: 'X',
        productName: 'X',
        quantity: 0,
        warehouseName: 'WH',
        status: 'Open',
        lastModifiedOn: '2026-05-15T00:00:00Z',
      },
    ]);
    expect(out.lines).toEqual([]);
  });
});

describe('assembliesAtWarehouse', () => {
  const cache: AssembliesCache = {
    fetchedAt: '2026-05-01T00:00:00Z',
    lines: [
      {
        assemblyNumber: 'A-1',
        productCode: 'XHBC',
        productName: 'Chaga',
        quantity: 60,
        scheduledDate: '2026-05-15',
        warehouseName: 'Lundberg Storeroom',
        status: 'Open',
      },
      {
        assemblyNumber: 'A-2',
        productCode: 'FCHAGALG',
        productName: 'Chaga 600g',
        quantity: 200,
        scheduledDate: '2026-05-16',
        warehouseName: 'MF Packaging',
        status: 'Open',
      },
    ],
    totalLines: 2,
  };

  test('filters by warehouse name', () => {
    expect(assembliesAtWarehouse(cache, 'Lundberg Storeroom')).toHaveLength(1);
    expect(assembliesAtWarehouse(cache, 'MF Packaging')).toHaveLength(1);
  });

  test('returns [] for absent warehouse', () => {
    expect(assembliesAtWarehouse(cache, 'Other')).toEqual([]);
  });

  test('returns [] when cache is null', () => {
    expect(assembliesAtWarehouse(null, 'Lundberg Storeroom')).toEqual([]);
  });
});

describe('persistence', () => {
  let tempDir: string;
  let filePath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'assemblies-cache-test-'));
    filePath = join(tempDir, 'cache.json');
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('round-trips through file', () => {
    const cache = buildAssembliesCache([
      {
        assemblyNumber: 'A-1',
        productCode: 'X',
        productName: 'X',
        quantity: 10,
        warehouseName: 'WH',
        status: 'Open',
        lastModifiedOn: '2026-05-15T00:00:00Z',
      },
    ]);
    writeAssembliesCacheToFile(cache, filePath);
    const back = readAssembliesCacheFromFile(filePath);
    expect(back).not.toBeNull();
    expect(back!.lines).toHaveLength(1);
  });

  test('returns null for missing file', () => {
    expect(readAssembliesCacheFromFile(filePath)).toBeNull();
  });

  test('returns null on malformed JSON', () => {
    writeFileSync(filePath, 'not json {{{', 'utf-8');
    expect(readAssembliesCacheFromFile(filePath)).toBeNull();
  });

  test('drops malformed line entries on read', () => {
    writeFileSync(
      filePath,
      JSON.stringify({
        fetchedAt: '2026-05-01T00:00:00Z',
        lines: [
          {
            assemblyNumber: 'A-1',
            productCode: 'X',
            productName: 'X',
            quantity: 10,
            scheduledDate: '2026-05-15',
            warehouseName: 'WH',
            status: 'Open',
          },
          { assemblyNumber: 'A-2' /* missing fields */ },
          {
            assemblyNumber: 'A-3',
            productCode: 'X',
            productName: 'X',
            quantity: 10,
            scheduledDate: 'not a date',
            warehouseName: 'WH',
            status: 'Open',
          },
        ],
      }),
      'utf-8',
    );
    const back = readAssembliesCacheFromFile(filePath);
    expect(back!.lines).toHaveLength(1);
    expect(back!.lines[0].assemblyNumber).toBe('A-1');
  });
});
