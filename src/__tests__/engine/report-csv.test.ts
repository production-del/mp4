import {
  buildPoCsv,
  buildPackagingCsv,
  buildKitchenCsv,
} from '@/lib/planning/report-csv';
import type { CalendarActivity } from '@/lib/planning/calendar-projection';
import type { PurchaseRequirement } from '@/lib/engine/raw-material-demand';
import { applyDismiss, applyEditLeadTime } from '@/lib/planning/calendar-mutations';

// ─── Fixtures ────────────────────────────────────────────────

function packagingActivity(o: {
  stableId: string;
  productCode: string;
  date: string;
  station?: 'bottlo' | 'hand-packing';
  quantity?: number;
  duration?: number;
  changeover?: number;
  family?: string | null;
  orderInWeek?: number;
}): CalendarActivity {
  return {
    id: o.stableId,
    stableId: o.stableId,
    kind: 'packaging',
    date: o.date,
    weekStart: o.date,
    orderInWeek: o.orderInWeek ?? 0,
    station: o.station ?? 'bottlo',
    productCode: o.productCode,
    productName: o.productCode,
    quantity: o.quantity ?? 100,
    durationMinutes: o.duration ?? 60,
    changeoverMinutes: o.changeover ?? 0,
    family: o.family === undefined ? null : o.family,
    extendedFamily: null,
  };
}

function kitchenRequired(o: {
  stableId: string;
  productCode: string;
  startDate: string;
  finishDate?: string;
  requiredByDate?: string;
  durationDays?: number;
}): CalendarActivity {
  return {
    id: o.stableId,
    stableId: o.stableId,
    kind: 'kitchen-required',
    date: o.startDate,
    weekStart: o.startDate,
    orderInWeek: 0,
    station: null,
    productCode: o.productCode,
    productName: o.productCode,
    quantity: 50,
    durationMinutes: 0,
    changeoverMinutes: 0,
    durationDays: o.durationDays ?? 1,
    finishDate: o.finishDate ?? o.startDate,
    requiredByDate: o.requiredByDate,
    family: o.productCode,
    extendedFamily: null,
  };
}

function req(o: Partial<PurchaseRequirement> & {
  rawMaterialCode: string;
  placeByDate: string;
  arriveByDate: string;
  leadTimeDays: number;
  quantity: number;
}): PurchaseRequirement {
  return {
    rawMaterialCode: o.rawMaterialCode,
    rawMaterialName: o.rawMaterialName ?? o.rawMaterialCode,
    placeByDate: o.placeByDate,
    arriveByDate: o.arriveByDate,
    leadTimeDays: o.leadTimeDays,
    quantity: o.quantity,
    overdue: o.overdue ?? false,
    drivenBy: o.drivenBy ?? [],
  };
}

// ─── PO CSV ──────────────────────────────────────────────────

describe('buildPoCsv', () => {
  test('header row + one row per requirement, dates in dd/mm/yyyy', () => {
    const csv = buildPoCsv({
      purchaseRequirements: [
        req({
          rawMaterialCode: 'RAW_X',
          placeByDate: '2026-05-10',
          arriveByDate: '2026-05-24',
          leadTimeDays: 14,
          quantity: 100,
        }),
      ],
      vendorByCode: { RAW_X: 'Acme' },
      mutations: {},
      today: '2026-05-01',
    });
    // Strip BOM for assertion clarity
    const text = csv.replace(/^﻿/, '');
    const lines = text.trim().split('\n');
    expect(lines[0]).toContain('Place by');
    expect(lines[0]).toContain('Vendor');
    expect(lines[1]).toContain('10/05/2026');
    expect(lines[1]).toContain('24/05/2026');
    expect(lines[1]).toContain('Acme');
    expect(lines[1]).toContain('RAW_X');
  });

  test('overdue rows sort first, then by placeBy ascending', () => {
    const csv = buildPoCsv({
      purchaseRequirements: [
        req({
          rawMaterialCode: 'LATE',
          placeByDate: '2026-05-20',
          arriveByDate: '2026-06-03',
          leadTimeDays: 14,
          quantity: 50,
        }),
        req({
          rawMaterialCode: 'OVERDUE_A',
          placeByDate: '2026-04-20',
          arriveByDate: '2026-05-04',
          leadTimeDays: 14,
          quantity: 50,
        }),
        req({
          rawMaterialCode: 'OVERDUE_B',
          placeByDate: '2026-04-25',
          arriveByDate: '2026-05-09',
          leadTimeDays: 14,
          quantity: 50,
        }),
      ],
      vendorByCode: {},
      mutations: {},
      today: '2026-05-01',
    });
    const lines = csv.replace(/^﻿/, '').trim().split('\n');
    // Skip header row.
    const codes = lines.slice(1).map((l) => l.split(',')[2]);
    expect(codes).toEqual(['OVERDUE_A', 'OVERDUE_B', 'LATE']);
  });

  test('lead-time override: place-by clamped to today, arrive-by uses override', () => {
    const csv = buildPoCsv({
      purchaseRequirements: [
        req({
          rawMaterialCode: 'RAW_X',
          placeByDate: '2026-04-20',
          arriveByDate: '2026-05-04',
          leadTimeDays: 14,
          quantity: 100,
        }),
      ],
      vendorByCode: {},
      mutations: applyEditLeadTime({}, 'po-placed|RAW_X', 7),
      today: '2026-05-05',
    });
    const lines = csv.replace(/^﻿/, '').trim().split('\n');
    const cells = lines[1].split(',');
    expect(cells[0]).toBe('05/05/2026'); // place-by clamped to today
    expect(cells[1]).toBe('12/05/2026'); // today + 7 (override)
    expect(cells[6]).toBe('7'); // lead time used
    expect(cells[7]).toBe('14'); // file default
    expect(cells[8]).toBe('Y'); // overdue flag
  });

  test('escapes commas and quotes in vendor / drives names', () => {
    const csv = buildPoCsv({
      purchaseRequirements: [
        req({
          rawMaterialCode: 'X',
          placeByDate: '2026-05-10',
          arriveByDate: '2026-05-24',
          leadTimeDays: 14,
          quantity: 100,
          drivenBy: ['driver|with,comma', 'plain'],
        }),
      ],
      vendorByCode: { X: 'Acme, Inc' },
      mutations: {},
      today: '2026-05-01',
    });
    expect(csv).toContain('"Acme, Inc"');
    expect(csv).toContain('"driver|with,comma; plain"');
  });

  test('starts with UTF-8 BOM for Excel', () => {
    const csv = buildPoCsv({
      purchaseRequirements: [],
      vendorByCode: {},
      mutations: {},
      today: '2026-05-01',
    });
    expect(csv.charCodeAt(0)).toBe(0xfeff);
  });
});

// ─── Packaging CSV ───────────────────────────────────────────

describe('buildPackagingCsv', () => {
  test('one row per packaging chip, sorted by date/station/orderInWeek', () => {
    const csv = buildPackagingCsv({
      activities: [
        packagingActivity({ stableId: 'P3', productCode: 'C', date: '2026-05-15', orderInWeek: 0 }),
        packagingActivity({ stableId: 'P1', productCode: 'A', date: '2026-05-14', orderInWeek: 0 }),
        packagingActivity({ stableId: 'P2', productCode: 'B', date: '2026-05-14', orderInWeek: 1 }),
      ],
      mutations: {},
      stationDailyMinutes: { bottlo: 480 },
    });
    const lines = csv.replace(/^﻿/, '').trim().split('\n');
    const codes = lines
      .slice(1)
      .filter((l) => l.split(',')[2]) // skip totals block
      .map((l) => l.split(',')[2])
      .filter((c) => c === 'A' || c === 'B' || c === 'C');
    expect(codes).toEqual(['A', 'B', 'C']);
  });

  test('excludes dismissed activities', () => {
    const csv = buildPackagingCsv({
      activities: [
        packagingActivity({ stableId: 'P1', productCode: 'A', date: '2026-05-14' }),
        packagingActivity({ stableId: 'P2', productCode: 'B', date: '2026-05-14' }),
      ],
      mutations: applyDismiss({}, 'P2'),
      stationDailyMinutes: {},
    });
    expect(csv).toContain('A');
    // Ensure 'B' isn't anywhere in a row (header has 'B' in 'BOM' for some
    // characters? No — header is plain ASCII and Production-only. Just
    // assert the dismissed code's row signature isn't there.
    expect(csv).not.toContain(',B,');
  });

  test('excludes non-packaging kinds', () => {
    const csv = buildPackagingCsv({
      activities: [
        packagingActivity({ stableId: 'P1', productCode: 'A', date: '2026-05-14' }),
        kitchenRequired({ stableId: 'K1', productCode: 'ICC', startDate: '2026-05-13' }),
      ],
      mutations: {},
      stationDailyMinutes: {},
    });
    expect(csv).not.toContain('ICC');
  });

  test('appends a daily totals block with utilisation %', () => {
    const csv = buildPackagingCsv({
      activities: [
        packagingActivity({
          stableId: 'P1',
          productCode: 'A',
          date: '2026-05-14',
          duration: 200,
          changeover: 40,
        }),
        packagingActivity({
          stableId: 'P2',
          productCode: 'B',
          date: '2026-05-14',
          duration: 100,
          changeover: 20,
        }),
      ],
      mutations: {},
      stationDailyMinutes: { bottlo: 480 },
    });
    expect(csv).toContain('Daily totals');
    // 200+40+100+20 = 360 / 480 = 75%
    expect(csv).toContain('360');
    expect(csv).toContain('75%');
  });

  test('total min = production + changeover', () => {
    const csv = buildPackagingCsv({
      activities: [
        packagingActivity({
          stableId: 'P1',
          productCode: 'A',
          date: '2026-05-14',
          duration: 50,
          changeover: 10,
        }),
      ],
      mutations: {},
      stationDailyMinutes: {},
    });
    const lines = csv.replace(/^﻿/, '').trim().split('\n');
    const cells = lines[1].split(',');
    // Production min, Changeover min, Total min are columns 5/6/7.
    expect(cells[5]).toBe('50');
    expect(cells[6]).toBe('10');
    expect(cells[7]).toBe('60');
  });
});

// ─── Kitchen CSV ─────────────────────────────────────────────

describe('buildKitchenCsv', () => {
  test('one row per kitchen-required chip, sorted by start date', () => {
    const csv = buildKitchenCsv({
      activities: [
        kitchenRequired({ stableId: 'K2', productCode: 'B', startDate: '2026-05-13' }),
        kitchenRequired({ stableId: 'K1', productCode: 'A', startDate: '2026-05-10' }),
      ],
      mutations: {},
      kitchenMinutesByProductCode: {},
      kitchenDefaultMinutes: 240,
    });
    const lines = csv.replace(/^﻿/, '').trim().split('\n');
    const codes = lines.slice(1).map((l) => l.split(',')[3]);
    expect(codes).toEqual(['A', 'B']);
  });

  test('uses per-recipe kitchen minutes when present, default otherwise', () => {
    const csv = buildKitchenCsv({
      activities: [
        kitchenRequired({ stableId: 'K1', productCode: 'KNOWN', startDate: '2026-05-10' }),
        kitchenRequired({ stableId: 'K2', productCode: 'UNKNOWN', startDate: '2026-05-11' }),
      ],
      mutations: {},
      kitchenMinutesByProductCode: { KNOWN: 180 },
      kitchenDefaultMinutes: 240,
    });
    const lines = csv.replace(/^﻿/, '').trim().split('\n');
    const knownRow = lines.find((l) => l.includes('KNOWN'))!;
    const unknownRow = lines.find((l) => l.includes('UNKNOWN'))!;
    expect(knownRow.split(',').pop()).toBe('180');
    expect(unknownRow.split(',').pop()).toBe('240');
  });

  test('finishDate falls back to startDate; requiredBy is blank when absent', () => {
    const csv = buildKitchenCsv({
      activities: [
        kitchenRequired({
          stableId: 'K1',
          productCode: 'A',
          startDate: '2026-05-10',
          // no finishDate, no requiredByDate
        }),
      ],
      mutations: {},
      kitchenMinutesByProductCode: {},
      kitchenDefaultMinutes: 240,
    });
    const cells = csv.replace(/^﻿/, '').trim().split('\n')[1].split(',');
    expect(cells[0]).toBe('10/05/2026'); // start
    expect(cells[1]).toBe('10/05/2026'); // finish defaults to start
    expect(cells[2]).toBe(''); // required by absent
  });

  test('excludes dismissed', () => {
    const csv = buildKitchenCsv({
      activities: [
        kitchenRequired({ stableId: 'K1', productCode: 'A', startDate: '2026-05-10' }),
      ],
      mutations: applyDismiss({}, 'K1'),
      kitchenMinutesByProductCode: {},
      kitchenDefaultMinutes: 240,
    });
    const lines = csv.replace(/^﻿/, '').trim().split('\n');
    expect(lines).toHaveLength(1); // header only
  });
});
