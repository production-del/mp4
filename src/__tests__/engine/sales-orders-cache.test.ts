import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  buildSalesOrdersCache,
  readSalesOrdersCache,
  writeSalesOrdersCache,
  salesOrdersForProduct,
  totalCommittedFor,
  type SalesOrdersCache,
} from '@/lib/planning/sales-orders-cache';

describe('buildSalesOrdersCache', () => {
  test('keeps lines with positive remainder + valid date', () => {
    const out = buildSalesOrdersCache([
      {
        productCode: 'A',
        quantityOrdered: 100,
        quantityAllocated: 30,
        requiredDate: '2026-05-15',
        orderNumber: 'SO-1',
        customerName: 'Cust',
        orderStatus: 'Placed',
      },
    ]);
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0].quantityRemaining).toBe(70);
    expect(out.lines[0].requiredDate).toBe('2026-05-15');
  });

  test('drops lines with zero or negative remainder', () => {
    const out = buildSalesOrdersCache([
      {
        productCode: 'A',
        quantityOrdered: 50,
        quantityAllocated: 50,
        requiredDate: '2026-05-15',
        orderNumber: 'SO-1',
        customerName: 'Cust',
        orderStatus: 'Placed',
      },
      {
        productCode: 'B',
        quantityOrdered: 50,
        quantityAllocated: 60, // over-allocated, negative remainder
        requiredDate: '2026-05-15',
        orderNumber: 'SO-2',
        customerName: 'Cust',
        orderStatus: 'Placed',
      },
    ]);
    expect(out.lines).toEqual([]);
  });

  test('drops lines without a required date', () => {
    const out = buildSalesOrdersCache([
      {
        productCode: 'A',
        quantityOrdered: 100,
        quantityAllocated: 0,
        requiredDate: null,
        orderNumber: 'SO-1',
        customerName: 'Cust',
        orderStatus: 'Placed',
      },
    ]);
    expect(out.lines).toEqual([]);
  });

  test('trims requiredDate to YYYY-MM-DD', () => {
    const out = buildSalesOrdersCache([
      {
        productCode: 'A',
        quantityOrdered: 100,
        quantityAllocated: 0,
        requiredDate: '2026-05-15T08:30:00.000Z',
        orderNumber: 'SO-1',
        customerName: 'Cust',
        orderStatus: 'Placed',
      },
    ]);
    expect(out.lines[0].requiredDate).toBe('2026-05-15');
  });

  test('drops lines with malformed requiredDate', () => {
    const out = buildSalesOrdersCache([
      {
        productCode: 'A',
        quantityOrdered: 100,
        quantityAllocated: 0,
        requiredDate: 'not a date',
        orderNumber: 'SO-1',
        customerName: 'Cust',
        orderStatus: 'Placed',
      },
    ]);
    expect(out.lines).toEqual([]);
  });
});

describe('lookups', () => {
  const cache: SalesOrdersCache = {
    fetchedAt: '2026-05-01T00:00:00Z',
    lines: [
      {
        productCode: 'A',
        quantityRemaining: 30,
        requiredDate: '2026-05-20',
        orderNumber: 'SO-2',
        customerName: 'Cust',
        orderStatus: 'Placed',
      },
      {
        productCode: 'A',
        quantityRemaining: 50,
        requiredDate: '2026-05-15',
        orderNumber: 'SO-1',
        customerName: 'Cust',
        orderStatus: 'Backordered',
      },
      {
        productCode: 'B',
        quantityRemaining: 20,
        requiredDate: '2026-06-01',
        orderNumber: 'SO-3',
        customerName: 'Cust',
        orderStatus: 'Placed',
      },
    ],
    totalLines: 3,
  };

  test('salesOrdersForProduct returns all matches sorted by requiredDate', () => {
    const r = salesOrdersForProduct(cache, 'A');
    expect(r.map((l) => l.orderNumber)).toEqual(['SO-1', 'SO-2']);
    expect(r[0].requiredDate < r[1].requiredDate).toBe(true);
  });

  test('salesOrdersForProduct returns [] for absent code', () => {
    expect(salesOrdersForProduct(cache, 'X')).toEqual([]);
  });

  test('salesOrdersForProduct returns [] when cache is null', () => {
    expect(salesOrdersForProduct(null, 'A')).toEqual([]);
  });

  test('totalCommittedFor sums lines for a product', () => {
    expect(totalCommittedFor(cache, 'A')).toBe(80);
    expect(totalCommittedFor(cache, 'B')).toBe(20);
    expect(totalCommittedFor(cache, 'X')).toBe(0);
  });
});

describe('persistence', () => {
  let tempDir: string;
  let filePath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'sales-orders-cache-test-'));
    filePath = join(tempDir, 'cache.json');
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('round-trips through file', () => {
    const cache = buildSalesOrdersCache([
      {
        productCode: 'A',
        quantityOrdered: 100,
        quantityAllocated: 30,
        requiredDate: '2026-05-15',
        orderNumber: 'SO-1',
        customerName: 'Cust',
        orderStatus: 'Placed',
      },
    ]);
    writeSalesOrdersCache(cache, filePath);
    const back = readSalesOrdersCache(filePath);
    expect(back).not.toBeNull();
    expect(back!.lines).toHaveLength(1);
    expect(back!.lines[0].quantityRemaining).toBe(70);
  });

  test('readSalesOrdersCache returns null for missing file', () => {
    expect(readSalesOrdersCache(filePath)).toBeNull();
  });

  test('readSalesOrdersCache returns null on malformed JSON', () => {
    writeFileSync(filePath, 'not json {{{', 'utf-8');
    expect(readSalesOrdersCache(filePath)).toBeNull();
  });

  test('readSalesOrdersCache drops malformed line entries', () => {
    writeFileSync(
      filePath,
      JSON.stringify({
        fetchedAt: '2026-05-01T00:00:00Z',
        lines: [
          {
            productCode: 'A',
            quantityRemaining: 50,
            requiredDate: '2026-05-15',
            orderNumber: 'SO-1',
            customerName: 'Cust',
            orderStatus: 'Placed',
          },
          { productCode: 'B' /* missing fields */ },
          'not an object',
          {
            productCode: 'C',
            quantityRemaining: 0, // not positive
            requiredDate: '2026-05-15',
            orderNumber: 'SO-3',
            customerName: 'Cust',
            orderStatus: 'Placed',
          },
        ],
      }),
      'utf-8',
    );
    const back = readSalesOrdersCache(filePath);
    expect(back!.lines).toHaveLength(1);
    expect(back!.lines[0].productCode).toBe('A');
  });
});
