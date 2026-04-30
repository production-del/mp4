import {
  projectToCalendar,
} from '@/lib/planning/calendar-projection';
import type {
  AssignedBatch,
  DailyStationTimeline,
  DayAssignerOutput,
} from '@/lib/engine/day-assigner';
import type { ProductMeta, Station } from '@/lib/planning/engine-io';

// ─── Fixture helpers ─────────────────────────────────────────

function meta(o: Partial<ProductMeta> & { productCode: string }): ProductMeta {
  return {
    productCode: o.productCode,
    productName: o.productName ?? o.productCode + ' name',
    family: 'family' in o ? (o.family as string) : 'XHBC',
    extendedFamily: 'extendedFamily' in o ? o.extendedFamily! : 'FAM Fungi',
    packageSize: o.packageSize ?? 'MED',
    station: o.station ?? 'bottlo',
    rateUnitsPerHour: o.rateUnitsPerHour ?? 200,
  };
}

function assignedBatch(o: {
  productCode: string;
  weekStart: string;
  scheduledDate: string;
  quantity: number;
  durationMinutes: number;
  changeoverMinutes: number;
  productMeta?: Partial<ProductMeta>;
  orderInWeek?: number;
}): AssignedBatch {
  return {
    productCode: o.productCode,
    weekStart: o.weekStart,
    quantity: o.quantity,
    productMeta: meta({ productCode: o.productCode, ...o.productMeta }),
    orderInWeek: o.orderInWeek ?? 0,
    scheduledDate: o.scheduledDate,
    durationMinutes: o.durationMinutes,
    changeoverMinutes: o.changeoverMinutes,
  };
}

function timeline(
  station: Station,
  byDay: Record<string, AssignedBatch[]>,
  capacityPerDay = 480,
): DailyStationTimeline {
  const map = new Map<string, { batches: AssignedBatch[]; usedMinutes: number; capacityMinutes: number }>();
  for (const [date, batches] of Object.entries(byDay)) {
    const used = batches.reduce(
      (s, b) => s + b.durationMinutes + b.changeoverMinutes,
      0,
    );
    map.set(date, { batches, usedMinutes: used, capacityMinutes: capacityPerDay });
  }
  return { station, byDay: map };
}

function output(
  perStation: Map<Station, DailyStationTimeline>,
): DayAssignerOutput {
  return { perStation, warnings: [] };
}

// ─── Tests ───────────────────────────────────────────────────

describe('projectToCalendar', () => {
  describe('boundary inputs', () => {
    test('empty day-assigner output → empty projection', () => {
      const r = projectToCalendar({ perStation: new Map(), warnings: [] });
      expect(r.activities).toEqual([]);
      expect(r.dayLoads).toEqual([]);
    });

    test('station with no batches contributes nothing', () => {
      const perStation = new Map<Station, DailyStationTimeline>();
      perStation.set('bottlo', { station: 'bottlo', byDay: new Map() });
      const r = projectToCalendar(output(perStation));
      expect(r.activities).toEqual([]);
      expect(r.dayLoads).toEqual([]);
    });
  });

  describe('single batch projection', () => {
    test('produces one activity with all fields populated', () => {
      const batch = assignedBatch({
        productCode: 'FCHAGALG',
        weekStart: '2026-05-04',
        scheduledDate: '2026-05-04',
        quantity: 200,
        durationMinutes: 60,
        changeoverMinutes: 10,
        productMeta: { productName: 'Chaga 600g', family: 'XHBC', extendedFamily: 'FAM Fungi' },
      });
      const perStation = new Map<Station, DailyStationTimeline>();
      perStation.set(
        'bottlo',
        timeline('bottlo', { '2026-05-04': [batch] }),
      );
      const r = projectToCalendar(output(perStation));
      expect(r.activities).toHaveLength(1);
      const a = r.activities[0];
      expect(a.kind).toBe('packaging');
      expect(a.date).toBe('2026-05-04');
      expect(a.station).toBe('bottlo');
      expect(a.productCode).toBe('FCHAGALG');
      expect(a.productName).toBe('Chaga 600g');
      expect(a.quantity).toBe(200);
      expect(a.durationMinutes).toBe(60);
      expect(a.changeoverMinutes).toBe(10);
      expect(a.family).toBe('XHBC');
      expect(a.extendedFamily).toBe('FAM Fungi');
      expect(a.id).toContain('2026-05-04');
      expect(a.id).toContain('bottlo');
      expect(a.id).toContain('FCHAGALG');
    });

    test('produces one dayLoad summary with utilisation', () => {
      const batch = assignedBatch({
        productCode: 'A',
        weekStart: '2026-05-04',
        scheduledDate: '2026-05-04',
        quantity: 100,
        durationMinutes: 240,
        changeoverMinutes: 0,
      });
      const perStation = new Map<Station, DailyStationTimeline>();
      perStation.set('bottlo', timeline('bottlo', { '2026-05-04': [batch] }, 480));
      const r = projectToCalendar(output(perStation));
      expect(r.dayLoads).toHaveLength(1);
      expect(r.dayLoads[0]).toEqual({
        date: '2026-05-04',
        station: 'bottlo',
        usedMinutes: 240,
        capacityMinutes: 480,
        utilisation: 0.5,
      });
    });

    test('utilisation > 1 indicates overrun', () => {
      const batch = assignedBatch({
        productCode: 'BIG',
        weekStart: '2026-05-04',
        scheduledDate: '2026-05-04',
        quantity: 1000,
        durationMinutes: 600,
        changeoverMinutes: 0,
      });
      const perStation = new Map<Station, DailyStationTimeline>();
      perStation.set('bottlo', timeline('bottlo', { '2026-05-04': [batch] }, 480));
      const r = projectToCalendar(output(perStation));
      expect(r.dayLoads[0].utilisation).toBeCloseTo(600 / 480, 6);
      expect(r.dayLoads[0].utilisation).toBeGreaterThan(1);
    });
  });

  describe('multiple batches', () => {
    test('one activity per batch, with stable IDs', () => {
      const batches = [
        assignedBatch({
          productCode: 'A',
          weekStart: '2026-05-04',
          scheduledDate: '2026-05-04',
          quantity: 100,
          durationMinutes: 60,
          changeoverMinutes: 0,
          orderInWeek: 0,
        }),
        assignedBatch({
          productCode: 'B',
          weekStart: '2026-05-04',
          scheduledDate: '2026-05-04',
          quantity: 100,
          durationMinutes: 60,
          changeoverMinutes: 10,
          orderInWeek: 1,
        }),
      ];
      const perStation = new Map<Station, DailyStationTimeline>();
      perStation.set('bottlo', timeline('bottlo', { '2026-05-04': batches }));
      const r = projectToCalendar(output(perStation));
      expect(r.activities).toHaveLength(2);
      const ids = r.activities.map((a) => a.id);
      expect(new Set(ids).size).toBe(2); // unique
    });
  });

  describe('multiple stations + multiple days', () => {
    test('flattens all batches into one activity array', () => {
      const perStation = new Map<Station, DailyStationTimeline>();
      perStation.set(
        'bottlo',
        timeline('bottlo', {
          '2026-05-04': [
            assignedBatch({
              productCode: 'A',
              weekStart: '2026-05-04',
              scheduledDate: '2026-05-04',
              quantity: 100,
              durationMinutes: 60,
              changeoverMinutes: 0,
            }),
          ],
          '2026-05-05': [
            assignedBatch({
              productCode: 'B',
              weekStart: '2026-05-04',
              scheduledDate: '2026-05-05',
              quantity: 100,
              durationMinutes: 60,
              changeoverMinutes: 10,
            }),
          ],
        }),
      );
      perStation.set(
        'elephant',
        timeline('elephant', {
          '2026-05-04': [
            assignedBatch({
              productCode: 'C',
              weekStart: '2026-05-04',
              scheduledDate: '2026-05-04',
              quantity: 100,
              durationMinutes: 60,
              changeoverMinutes: 0,
              productMeta: { station: 'elephant' },
            }),
          ],
        }),
      );
      const r = projectToCalendar(output(perStation));
      expect(r.activities).toHaveLength(3);
      expect(r.dayLoads).toHaveLength(3); // bottlo×2 + elephant×1
    });

    test('output is sorted by date then station for deterministic UI rendering', () => {
      const perStation = new Map<Station, DailyStationTimeline>();
      perStation.set(
        'bottlo',
        timeline('bottlo', {
          '2026-05-05': [
            assignedBatch({
              productCode: 'B',
              weekStart: '2026-05-04',
              scheduledDate: '2026-05-05',
              quantity: 100,
              durationMinutes: 60,
              changeoverMinutes: 0,
            }),
          ],
          '2026-05-04': [
            assignedBatch({
              productCode: 'A',
              weekStart: '2026-05-04',
              scheduledDate: '2026-05-04',
              quantity: 100,
              durationMinutes: 60,
              changeoverMinutes: 0,
            }),
          ],
        }),
      );
      perStation.set(
        'elephant',
        timeline('elephant', {
          '2026-05-04': [
            assignedBatch({
              productCode: 'C',
              weekStart: '2026-05-04',
              scheduledDate: '2026-05-04',
              quantity: 100,
              durationMinutes: 60,
              changeoverMinutes: 0,
              productMeta: { station: 'elephant' },
            }),
          ],
        }),
      );
      const r = projectToCalendar(output(perStation));
      // Expected order: 05-04/bottlo, 05-04/elephant, 05-05/bottlo
      expect(r.activities.map((a) => `${a.date}/${a.station}`)).toEqual([
        '2026-05-04/bottlo',
        '2026-05-04/elephant',
        '2026-05-05/bottlo',
      ]);
    });
  });

  describe('JSON-serialisable output (server-client boundary)', () => {
    test('output round-trips through JSON without losing information', () => {
      const batch = assignedBatch({
        productCode: 'FCHAGALG',
        weekStart: '2026-05-04',
        scheduledDate: '2026-05-04',
        quantity: 200,
        durationMinutes: 60,
        changeoverMinutes: 10,
      });
      const perStation = new Map<Station, DailyStationTimeline>();
      perStation.set('bottlo', timeline('bottlo', { '2026-05-04': [batch] }));
      const r = projectToCalendar(output(perStation));
      const roundTripped = JSON.parse(JSON.stringify(r));
      expect(roundTripped).toEqual(r);
    });
  });
});
