import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  loadFromSheet,
  loadFromFile,
  loadMonthlyDemand,
  parseDemandCsv,
} from '@/lib/planning/demand-data-loader';

// ─── parseDemandCsv ─────────────────────────────────────────

describe('parseDemandCsv', () => {
  test('reads Product Code + AVE columns; ignores everything else', () => {
    const csv = `Product Code,Product Group,Product Description,AVE,6,3,1
SDYELLOSM,Stardust,Yellow,"1,789","1,839","1,797","1,731"
MFMAPLEME,Munchies,Maple,"1,576",1693,1738,1297`;
    const { rates } = parseDemandCsv(csv);
    expect(rates).toEqual({ SDYELLOSM: 1789, MFMAPLEME: 1576 });
  });

  test('handles compound-quoted product names with embedded commas', () => {
    const csv = `Product Code,Product Description,AVE
SDYELLOSM,"STARDUST Yellow ""Anti-Inflammatory"" - Organic SML (120g)","1,789"`;
    const { rates } = parseDemandCsv(csv);
    expect(rates.SDYELLOSM).toBe(1789);
  });

  test('uppercases product codes and strips whitespace', () => {
    const csv = `Product Code,AVE
sdyellosm  , 1789
  MFMAPLEME,1500`;
    const { rates } = parseDemandCsv(csv);
    expect(rates).toEqual({ SDYELLOSM: 1789, MFMAPLEME: 1500 });
  });

  test('drops rows with non-numeric or negative AVE', () => {
    const csv = `Product Code,AVE
A,100
B,not-a-number
C,-5
D,
E,200`;
    const { rates } = parseDemandCsv(csv);
    expect(rates).toEqual({ A: 100, E: 200 });
  });

  test('keeps the LARGEST value when same code appears twice', () => {
    const csv = `Product Code,AVE
A,100
A,250
A,150`;
    const { rates } = parseDemandCsv(csv);
    expect(rates.A).toBe(250);
  });

  test('returns empty when required columns are missing', () => {
    const csv = `Foo,Bar\n1,2\n`;
    expect(parseDemandCsv(csv)).toEqual({ rates: {}, groups: {} });
  });

  test('returns empty for header-only or empty input', () => {
    expect(parseDemandCsv('Product Code,AVE\n')).toEqual({ rates: {}, groups: {} });
    expect(parseDemandCsv('')).toEqual({ rates: {}, groups: {} });
  });

  test('accepts alternative column names (sku, demand, average)', () => {
    expect(parseDemandCsv('SKU,demand\nA,100').rates).toEqual({ A: 100 });
    expect(parseDemandCsv('productcode,average\nB,200').rates).toEqual({ B: 200 });
  });

  test('captures product group when the column is present (Phase 4l.8)', () => {
    const csv = `Product Code,AVE,Unleashed Product Group
MFCHOCLSM,500,MF - Clusters
NT-NAKED100,100,TBC - Naked Tallow`;
    const { rates, groups } = parseDemandCsv(csv);
    expect(rates).toEqual({ MFCHOCLSM: 500, 'NT-NAKED100': 100 });
    expect(groups).toEqual({
      MFCHOCLSM: 'MF - Clusters',
      'NT-NAKED100': 'TBC - Naked Tallow',
    });
  });
});

// ─── loadFromSheet ──────────────────────────────────────────

describe('loadFromSheet', () => {
  function makeFetch(impl: (url: string) => Response | Promise<Response>): typeof fetch {
    return ((url: string | URL | Request) =>
      Promise.resolve(impl(typeof url === 'string' ? url : (url as URL).toString()))) as typeof fetch;
  }

  test('builds the public CSV-export URL from sheetId + gid', async () => {
    let calledUrl = '';
    await loadFromSheet({
      sheetId: 'ABC123',
      gid: '1055955921',
      fetchImpl: makeFetch((url) => {
        calledUrl = url;
        return new Response('Product Code,AVE\nA,100', {
          status: 200,
          headers: { 'Content-Type': 'text/csv' },
        });
      }),
    });
    expect(calledUrl).toBe(
      'https://docs.google.com/spreadsheets/d/ABC123/export?format=csv&gid=1055955921',
    );
  });

  test('parses the response body and reports source as "sheet"', async () => {
    const result = await loadFromSheet({
      sheetId: 'X',
      gid: '0',
      fetchImpl: makeFetch(
        () =>
          new Response('Product Code,AVE\nA,100\nB,250', { status: 200 }),
      ),
    });
    expect(result?.rates).toEqual({ A: 100, B: 250 });
    expect(result?.source).toBe('sheet');
    expect(result?.sourcePath).toContain('docs.google.com');
    expect(result?.sourceMtime).toBeTruthy();
  });

  test('throws a helpful error on non-2xx responses', async () => {
    await expect(
      loadFromSheet({
        sheetId: 'X',
        gid: '0',
        fetchImpl: makeFetch(() => new Response('forbidden', { status: 403 })),
      }),
    ).rejects.toThrow(/HTTP 403/);
  });
});

// ─── loadFromFile ───────────────────────────────────────────

describe('loadFromFile', () => {
  function withTmpCwd(demandCsv: string | null): string {
    const dir = mkdtempSync(join(tmpdir(), 'demand-'));
    if (demandCsv !== null) {
      mkdirSync(join(dir, 'data'));
      writeFileSync(join(dir, 'data', 'demand.csv'), demandCsv, 'utf8');
    }
    return dir;
  }

  test('reads data/demand.csv and reports source as "file"', () => {
    const dir = withTmpCwd('Product Code,AVE\nA,123');
    const result = loadFromFile(dir);
    expect(result?.rates).toEqual({ A: 123 });
    expect(result?.source).toBe('file');
    expect(result?.sourcePath.endsWith('demand.csv')).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test('returns null when data/demand.csv is missing', () => {
    const dir = withTmpCwd(null);
    expect(loadFromFile(dir)).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});

// ─── loadMonthlyDemand fallback chain ───────────────────────

describe('loadMonthlyDemand (fallback chain)', () => {
  // Save & restore env vars so we don't leak state across tests.
  const ORIGINAL_ENV = { ...process.env };
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  test('uses file when sheet env vars are absent', async () => {
    delete process.env.GOOGLE_SHEETS_ID;
    delete process.env.DEMAND_SHEET_GID;
    const dir = mkdtempSync(join(tmpdir(), 'demand-'));
    mkdirSync(join(dir, 'data'));
    writeFileSync(join(dir, 'data', 'demand.csv'), 'Product Code,AVE\nFILE_ONLY,99', 'utf8');
    const result = await loadMonthlyDemand(dir);
    expect(result?.source).toBe('file');
    expect(result?.rates.FILE_ONLY).toBe(99);
    rmSync(dir, { recursive: true, force: true });
  });

  test('treats placeholder "your-sheets-id" as not configured', async () => {
    process.env.GOOGLE_SHEETS_ID = 'your-sheets-id';
    const dir = mkdtempSync(join(tmpdir(), 'demand-'));
    mkdirSync(join(dir, 'data'));
    writeFileSync(join(dir, 'data', 'demand.csv'), 'Product Code,AVE\nA,1', 'utf8');
    const result = await loadMonthlyDemand(dir);
    expect(result?.source).toBe('file');
    rmSync(dir, { recursive: true, force: true });
  });

  test('returns null when neither sheet nor file is available', async () => {
    delete process.env.GOOGLE_SHEETS_ID;
    const dir = mkdtempSync(join(tmpdir(), 'demand-empty-'));
    // No data/ subdir at all.
    expect(await loadMonthlyDemand(dir)).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});
