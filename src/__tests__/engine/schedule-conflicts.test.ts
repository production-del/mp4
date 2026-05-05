import { detectScheduleConflicts } from '@/lib/engine/schedule-conflicts';
import type { CalendarActivity } from '@/lib/planning/calendar-projection';

// ─── Fixtures ───────────────────────────────────────────────

function packagingActivity(o: {
  stableId: string;
  productCode: string;
  date: string;
}): CalendarActivity {
  return {
    id: o.stableId,
    stableId: o.stableId,
    kind: 'packaging',
    date: o.date,
    weekStart: o.date,
    orderInWeek: 0,
    station: 'bottlo',
    productCode: o.productCode,
    productName: o.productCode,
    quantity: 100,
    durationMinutes: 60,
    changeoverMinutes: 0,
    family: null,
    extendedFamily: null,
  };
}

function kitchenRequired(o: {
  stableId: string;
  productCode: string;
  startDate: string;
  finishDate: string;
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
    finishDate: o.finishDate,
    family: o.productCode,
    extendedFamily: null,
  };
}

// ─── Tests ──────────────────────────────────────────────────

describe('detectScheduleConflicts', () => {
  describe('basic constraint', () => {
    test('no conflict when ingredient finishes BEFORE consumer date', () => {
      const conflicts = detectScheduleConflicts({
        activities: [
          packagingActivity({ stableId: 'P1', productCode: 'FCHOC', date: '2026-05-15' }),
          kitchenRequired({
            stableId: 'K1',
            productCode: 'ICC',
            startDate: '2026-05-13',
            finishDate: '2026-05-13',
          }),
        ],
        consumesMap: { FCHOC: ['ICC'] },
      });
      expect(conflicts).toEqual([]);
    });

    test('conflict when ingredient finishes ON consumer date (no buffer)', () => {
      const conflicts = detectScheduleConflicts({
        activities: [
          packagingActivity({ stableId: 'P1', productCode: 'FCHOC', date: '2026-05-15' }),
          kitchenRequired({
            stableId: 'K1',
            productCode: 'ICC',
            startDate: '2026-05-15',
            finishDate: '2026-05-15',
          }),
        ],
        consumesMap: { FCHOC: ['ICC'] },
      });
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].consumerStableId).toBe('P1');
      expect(conflicts[0].blockedByStableId).toBe('K1');
      expect(conflicts[0].ingredientCode).toBe('ICC');
    });

    test('conflict when ingredient finishes AFTER consumer date', () => {
      const conflicts = detectScheduleConflicts({
        activities: [
          packagingActivity({ stableId: 'P1', productCode: 'FCHOC', date: '2026-05-15' }),
          kitchenRequired({
            stableId: 'K1',
            productCode: 'ICC',
            startDate: '2026-05-20',
            finishDate: '2026-05-20',
          }),
        ],
        consumesMap: { FCHOC: ['ICC'] },
      });
      expect(conflicts).toHaveLength(1);
    });

    test('multiple candidates: any one satisfying clears the conflict', () => {
      const conflicts = detectScheduleConflicts({
        activities: [
          packagingActivity({ stableId: 'P1', productCode: 'FCHOC', date: '2026-05-15' }),
          kitchenRequired({ // too late
            stableId: 'K1',
            productCode: 'ICC',
            startDate: '2026-05-20',
            finishDate: '2026-05-20',
          }),
          kitchenRequired({ // satisfies
            stableId: 'K2',
            productCode: 'ICC',
            startDate: '2026-05-10',
            finishDate: '2026-05-10',
          }),
        ],
        consumesMap: { FCHOC: ['ICC'] },
      });
      expect(conflicts).toEqual([]);
    });
  });

  describe('absence of candidates', () => {
    test('no conflict emitted when no candidate exists at all (likely SOH-covered)', () => {
      const conflicts = detectScheduleConflicts({
        activities: [
          packagingActivity({ stableId: 'P1', productCode: 'FCHOC', date: '2026-05-15' }),
          // no ICC activity present
        ],
        consumesMap: { FCHOC: ['ICC'] },
      });
      expect(conflicts).toEqual([]);
    });

    test('skips consumers with no consumesMap entry', () => {
      const conflicts = detectScheduleConflicts({
        activities: [
          packagingActivity({ stableId: 'P1', productCode: 'NO_BOM', date: '2026-05-15' }),
        ],
        consumesMap: {},
      });
      expect(conflicts).toEqual([]);
    });
  });

  describe('cascade (intermediate dependent on sub-intermediate)', () => {
    test('detects ICC → ICCC violation when ICCC finishes too late for ICC start', () => {
      const conflicts = detectScheduleConflicts({
        activities: [
          packagingActivity({ stableId: 'P1', productCode: 'FCHOC', date: '2026-05-20' }),
          kitchenRequired({
            stableId: 'ICC',
            productCode: 'ICC',
            startDate: '2026-05-18',
            finishDate: '2026-05-18',
          }),
          kitchenRequired({
            // ICCC finishes ON ICC's start day — buffer rule violated
            stableId: 'ICCC',
            productCode: 'ICCC',
            startDate: '2026-05-18',
            finishDate: '2026-05-18',
          }),
        ],
        consumesMap: { FCHOC: ['ICC'], ICC: ['ICCC'] },
      });
      // P1 ↔ ICC is fine (ICC.finish 5/18 < P1.date 5/20)
      // ICC ↔ ICCC is violated (ICCC.finish 5/18 NOT < ICC.start 5/18)
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].consumerStableId).toBe('ICC');
      expect(conflicts[0].ingredientCode).toBe('ICCC');
    });
  });

  describe('dismissed activities', () => {
    test('dismissed consumers do not contribute conflicts', () => {
      const conflicts = detectScheduleConflicts({
        activities: [
          packagingActivity({ stableId: 'P1', productCode: 'FCHOC', date: '2026-05-15' }),
          kitchenRequired({
            stableId: 'K1',
            productCode: 'ICC',
            startDate: '2026-05-20',
            finishDate: '2026-05-20',
          }),
        ],
        consumesMap: { FCHOC: ['ICC'] },
        dismissedStableIds: new Set(['P1']),
      });
      expect(conflicts).toEqual([]);
    });

    test('dismissed ingredient suppliers do not satisfy', () => {
      const conflicts = detectScheduleConflicts({
        activities: [
          packagingActivity({ stableId: 'P1', productCode: 'FCHOC', date: '2026-05-15' }),
          // would satisfy if not dismissed
          kitchenRequired({
            stableId: 'K1',
            productCode: 'ICC',
            startDate: '2026-05-10',
            finishDate: '2026-05-10',
          }),
          // doesn't satisfy
          kitchenRequired({
            stableId: 'K2',
            productCode: 'ICC',
            startDate: '2026-05-20',
            finishDate: '2026-05-20',
          }),
        ],
        consumesMap: { FCHOC: ['ICC'] },
        dismissedStableIds: new Set(['K1']),
      });
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].blockedByStableId).toBe('K2');
    });
  });

  describe('output shape', () => {
    test('conflicts sorted by (consumerDate, consumerProductCode)', () => {
      const conflicts = detectScheduleConflicts({
        activities: [
          packagingActivity({ stableId: 'P_late', productCode: 'B', date: '2026-05-20' }),
          packagingActivity({ stableId: 'P_early', productCode: 'A', date: '2026-05-15' }),
          packagingActivity({ stableId: 'P_early2', productCode: 'AA', date: '2026-05-15' }),
          kitchenRequired({
            stableId: 'I_A',
            productCode: 'I_A',
            startDate: '2026-06-01',
            finishDate: '2026-06-01',
          }),
          kitchenRequired({
            stableId: 'I_AA',
            productCode: 'I_AA',
            startDate: '2026-06-01',
            finishDate: '2026-06-01',
          }),
          kitchenRequired({
            stableId: 'I_B',
            productCode: 'I_B',
            startDate: '2026-06-01',
            finishDate: '2026-06-01',
          }),
        ],
        consumesMap: {
          A: ['I_A'],
          AA: ['I_AA'],
          B: ['I_B'],
        },
      });
      expect(conflicts.map((c) => c.consumerStableId)).toEqual([
        'P_early',
        'P_early2',
        'P_late',
      ]);
    });
  });

  // ─── PO chip integration (Phase 4m.3) ──────────────────────

  describe('PO chip integration', () => {
    function poPlaced(o: {
      stableId: string;
      productCode: string;
      date: string;
    }): CalendarActivity {
      return {
        id: o.stableId,
        stableId: o.stableId,
        kind: 'po-placed',
        date: o.date,
        weekStart: o.date,
        orderInWeek: 0,
        station: null,
        productCode: o.productCode,
        productName: o.productCode,
        quantity: 100,
        durationMinutes: 0,
        changeoverMinutes: 0,
        family: null,
        extendedFamily: null,
      };
    }
    function poReceiving(o: {
      stableId: string;
      productCode: string;
      date: string;
    }): CalendarActivity {
      return {
        id: o.stableId,
        stableId: o.stableId,
        kind: 'po-receiving',
        date: o.date,
        weekStart: o.date,
        orderInWeek: 0,
        station: null,
        productCode: o.productCode,
        productName: o.productCode,
        quantity: 100,
        durationMinutes: 0,
        changeoverMinutes: 0,
        family: null,
        extendedFamily: null,
      };
    }

    test('po-receiving arriving in time satisfies the constraint (no conflict)', () => {
      const conflicts = detectScheduleConflicts({
        activities: [
          kitchenRequired({
            stableId: 'K1',
            productCode: 'ICC',
            startDate: '2026-05-15',
            finishDate: '2026-05-15',
          }),
          poPlaced({ stableId: 'PO-P|RAW', productCode: 'RAW', date: '2026-05-01' }),
          poReceiving({ stableId: 'PO-R|RAW', productCode: 'RAW', date: '2026-05-13' }),
        ],
        consumesMap: { ICC: ['RAW'] },
      });
      expect(conflicts).toEqual([]);
    });

    test('po-receiving arriving too late raises conflict on the consuming kitchen run', () => {
      const conflicts = detectScheduleConflicts({
        activities: [
          kitchenRequired({
            stableId: 'K1',
            productCode: 'ICC',
            startDate: '2026-05-15',
            finishDate: '2026-05-15',
          }),
          poPlaced({ stableId: 'PO-P|RAW', productCode: 'RAW', date: '2026-05-10' }),
          poReceiving({ stableId: 'PO-R|RAW', productCode: 'RAW', date: '2026-05-20' }),
        ],
        consumesMap: { ICC: ['RAW'] },
      });
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].consumerStableId).toBe('K1');
      expect(conflicts[0].ingredientCode).toBe('RAW');
      // Blocker should be the po-receiving chip, not po-placed.
      expect(conflicts[0].blockedByStableId).toBe('PO-R|RAW');
    });

    test('po-placed is excluded from suppliers (would otherwise be a false negative)', () => {
      // po-placed is on 5/01 (way before consumer 5/15) — if it were treated
      // as a supplier, the detector would say "satisfied" and miss the
      // genuine timing problem. Same productCode shared with po-receiving
      // arriving 5/20 (too late).
      const conflicts = detectScheduleConflicts({
        activities: [
          kitchenRequired({
            stableId: 'K1',
            productCode: 'ICC',
            startDate: '2026-05-15',
            finishDate: '2026-05-15',
          }),
          poPlaced({ stableId: 'PO-P|RAW', productCode: 'RAW', date: '2026-05-01' }),
          poReceiving({ stableId: 'PO-R|RAW', productCode: 'RAW', date: '2026-05-20' }),
        ],
        consumesMap: { ICC: ['RAW'] },
      });
      // If po-placed were counted, conflicts would be [] (false negative).
      expect(conflicts).toHaveLength(1);
    });

    test('packaging consuming a raw material directly: handles via PO chip', () => {
      const conflicts = detectScheduleConflicts({
        activities: [
          packagingActivity({ stableId: 'P1', productCode: 'FCHOC', date: '2026-05-15' }),
          poPlaced({ stableId: 'PO-P|LABEL', productCode: 'LABEL', date: '2026-05-10' }),
          poReceiving({ stableId: 'PO-R|LABEL', productCode: 'LABEL', date: '2026-05-20' }),
        ],
        consumesMap: { FCHOC: ['LABEL'] }, // depth-1 raw material consumption
      });
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].consumerStableId).toBe('P1');
      expect(conflicts[0].ingredientCode).toBe('LABEL');
    });
  });
});
