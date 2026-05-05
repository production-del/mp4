import {
  buildPoHtml,
  buildPackagingHtml,
  buildKitchenHtml,
} from '@/lib/planning/report-html';
import type { CalendarActivity } from '@/lib/planning/calendar-projection';
import type { PurchaseRequirement } from '@/lib/engine/raw-material-demand';
import { applyDismiss, applyEditLeadTime } from '@/lib/planning/calendar-mutations';

function packagingActivity(o: {
  stableId: string;
  productCode: string;
  date: string;
  station?: 'bottlo' | 'hand-packing';
  weekStart?: string;
  duration?: number;
  changeover?: number;
  family?: string;
}): CalendarActivity {
  return {
    id: o.stableId,
    stableId: o.stableId,
    kind: 'packaging',
    date: o.date,
    weekStart: o.weekStart ?? o.date,
    orderInWeek: 0,
    station: o.station ?? 'bottlo',
    productCode: o.productCode,
    productName: o.productCode,
    quantity: 100,
    durationMinutes: o.duration ?? 60,
    changeoverMinutes: o.changeover ?? 0,
    family: o.family ?? null,
    extendedFamily: null,
  };
}

function kitchenRequired(o: {
  stableId: string;
  productCode: string;
  startDate: string;
  finishDate?: string;
  requiredByDate?: string;
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
    durationDays: 1,
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

// ─── PO HTML ─────────────────────────────────────────────────

describe('buildPoHtml', () => {
  test('returns a complete HTML document with auto-print', () => {
    const html = buildPoHtml({
      purchaseRequirements: [],
      vendorByCode: {},
      mutations: {},
      today: '2026-05-05',
    });
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('window.print()');
    expect(html).toContain('Purchase orders');
  });

  test('groups by vendor, sorted alphabetically', () => {
    const html = buildPoHtml({
      purchaseRequirements: [
        req({ rawMaterialCode: 'X', placeByDate: '2026-05-10', arriveByDate: '2026-05-24', leadTimeDays: 14, quantity: 100 }),
        req({ rawMaterialCode: 'Y', placeByDate: '2026-05-12', arriveByDate: '2026-05-26', leadTimeDays: 14, quantity: 50 }),
      ],
      vendorByCode: { X: 'Zenith Co', Y: 'Acme' },
      mutations: {},
      today: '2026-05-01',
    });
    const acmePos = html.indexOf('Acme');
    const zenithPos = html.indexOf('Zenith Co');
    expect(acmePos).toBeGreaterThan(0);
    expect(zenithPos).toBeGreaterThan(0);
    expect(acmePos).toBeLessThan(zenithPos);
  });

  test('materials with no vendor go into "(no vendor specified)" group', () => {
    const html = buildPoHtml({
      purchaseRequirements: [
        req({ rawMaterialCode: 'NO_V', placeByDate: '2026-05-10', arriveByDate: '2026-05-24', leadTimeDays: 14, quantity: 10 }),
      ],
      vendorByCode: {},
      mutations: {},
      today: '2026-05-01',
    });
    expect(html).toContain('(no vendor specified)');
  });

  test('overdue rows are flagged within their vendor group', () => {
    const html = buildPoHtml({
      purchaseRequirements: [
        req({ rawMaterialCode: 'X', placeByDate: '2026-04-25', arriveByDate: '2026-05-09', leadTimeDays: 14, quantity: 100 }),
      ],
      vendorByCode: { X: 'Acme' },
      mutations: {},
      today: '2026-05-05',
    });
    expect(html).toContain('class="overdue"');
    expect(html).toContain('overdue');
  });

  test('lead-time override shows new value with default for context', () => {
    const html = buildPoHtml({
      purchaseRequirements: [
        req({ rawMaterialCode: 'X', placeByDate: '2026-05-10', arriveByDate: '2026-05-24', leadTimeDays: 14, quantity: 100 }),
      ],
      vendorByCode: {},
      mutations: applyEditLeadTime({}, 'po-placed|X', 21),
      today: '2026-05-01',
    });
    expect(html).toContain('21'); // override value
    expect(html).toContain('default 14'); // muted note
  });

  test('escapes HTML in vendor and product names', () => {
    const html = buildPoHtml({
      purchaseRequirements: [
        req({
          rawMaterialCode: 'X',
          rawMaterialName: 'Cacao <Premium>',
          placeByDate: '2026-05-10',
          arriveByDate: '2026-05-24',
          leadTimeDays: 14,
          quantity: 100,
        }),
      ],
      vendorByCode: { X: 'Acme & Co' },
      mutations: {},
      today: '2026-05-01',
    });
    expect(html).toContain('Acme &amp; Co');
    expect(html).toContain('Cacao &lt;Premium&gt;');
    expect(html).not.toContain('Cacao <Premium>');
  });

  test('shows summary line with PO + vendor + overdue counts', () => {
    const html = buildPoHtml({
      purchaseRequirements: [
        req({ rawMaterialCode: 'A', placeByDate: '2026-04-25', arriveByDate: '2026-05-09', leadTimeDays: 14, quantity: 1 }),
        req({ rawMaterialCode: 'B', placeByDate: '2026-05-10', arriveByDate: '2026-05-24', leadTimeDays: 14, quantity: 1 }),
      ],
      vendorByCode: { A: 'V1', B: 'V2' },
      mutations: {},
      today: '2026-05-05',
    });
    expect(html).toMatch(/2 POs across 2 vendors/);
    expect(html).toMatch(/1 overdue/);
  });

  test('empty input renders an explanatory paragraph', () => {
    const html = buildPoHtml({
      purchaseRequirements: [],
      vendorByCode: {},
      mutations: {},
      today: '2026-05-01',
    });
    expect(html).toContain('No purchase orders required');
  });
});

// ─── Packaging HTML ──────────────────────────────────────────

describe('buildPackagingHtml', () => {
  test('groups by week, then by station', () => {
    const html = buildPackagingHtml({
      activities: [
        packagingActivity({
          stableId: 'P1',
          productCode: 'A',
          date: '2026-05-04',
          weekStart: '2026-05-04',
          station: 'bottlo',
        }),
        packagingActivity({
          stableId: 'P2',
          productCode: 'B',
          date: '2026-05-11',
          weekStart: '2026-05-11',
          station: 'hand-packing',
        }),
      ],
      mutations: {},
      stationDailyMinutes: { bottlo: 480, 'hand-packing': 480 },
      today: '2026-05-01',
    });
    expect(html).toContain('Week of 04/05/2026');
    expect(html).toContain('Week of 11/05/2026');
    expect(html).toContain('bottlo');
    expect(html).toContain('hand-packing');
  });

  test('appends per-day daily-totals rows with utilisation %', () => {
    const html = buildPackagingHtml({
      activities: [
        packagingActivity({
          stableId: 'P1',
          productCode: 'A',
          date: '2026-05-04',
          duration: 240,
          changeover: 0,
        }),
        packagingActivity({
          stableId: 'P2',
          productCode: 'B',
          date: '2026-05-04',
          duration: 240,
          changeover: 0,
        }),
      ],
      mutations: {},
      stationDailyMinutes: { bottlo: 480 },
      today: '2026-05-01',
    });
    expect(html).toContain('Daily total');
    expect(html).toContain('100%');
  });

  test('excludes dismissed packaging chips', () => {
    const html = buildPackagingHtml({
      activities: [
        packagingActivity({ stableId: 'P1', productCode: 'A', date: '2026-05-04' }),
        packagingActivity({ stableId: 'P2', productCode: 'DISMISSED', date: '2026-05-04' }),
      ],
      mutations: applyDismiss({}, 'P2'),
      stationDailyMinutes: {},
      today: '2026-05-01',
    });
    expect(html).not.toContain('DISMISSED');
  });

  test('excludes kitchen-required activities', () => {
    const html = buildPackagingHtml({
      activities: [
        packagingActivity({ stableId: 'P1', productCode: 'A', date: '2026-05-04' }),
        kitchenRequired({ stableId: 'K1', productCode: 'ICC', startDate: '2026-05-03' }),
      ],
      mutations: {},
      stationDailyMinutes: {},
      today: '2026-05-01',
    });
    expect(html).not.toContain('ICC');
  });

  test('empty input renders an explanatory paragraph', () => {
    const html = buildPackagingHtml({
      activities: [],
      mutations: {},
      stationDailyMinutes: {},
      today: '2026-05-01',
    });
    expect(html).toContain('No packaging activities');
  });
});

// ─── Kitchen HTML ────────────────────────────────────────────

describe('buildKitchenHtml', () => {
  test('renders a single chronological table', () => {
    const html = buildKitchenHtml({
      activities: [
        kitchenRequired({ stableId: 'K1', productCode: 'A', startDate: '2026-05-04', finishDate: '2026-05-05' }),
      ],
      mutations: {},
      kitchenMinutesByProductCode: { A: 180 },
      kitchenDefaultMinutes: 240,
      today: '2026-05-01',
    });
    expect(html).toContain('04/05/2026');
    expect(html).toContain('05/05/2026');
    expect(html).toContain('180');
  });

  test('uses default minutes when product not in map', () => {
    const html = buildKitchenHtml({
      activities: [
        kitchenRequired({ stableId: 'K1', productCode: 'UNKNOWN', startDate: '2026-05-04' }),
      ],
      mutations: {},
      kitchenMinutesByProductCode: {},
      kitchenDefaultMinutes: 240,
      today: '2026-05-01',
    });
    expect(html).toContain('240');
  });

  test('excludes dismissed', () => {
    const html = buildKitchenHtml({
      activities: [
        kitchenRequired({ stableId: 'K1', productCode: 'DROPPED', startDate: '2026-05-04' }),
      ],
      mutations: applyDismiss({}, 'K1'),
      kitchenMinutesByProductCode: {},
      kitchenDefaultMinutes: 240,
      today: '2026-05-01',
    });
    expect(html).not.toContain('DROPPED');
  });

  test('empty input renders an explanatory paragraph', () => {
    const html = buildKitchenHtml({
      activities: [],
      mutations: {},
      kitchenMinutesByProductCode: {},
      kitchenDefaultMinutes: 240,
      today: '2026-05-01',
    });
    expect(html).toContain('No kitchen runs required');
  });
});
