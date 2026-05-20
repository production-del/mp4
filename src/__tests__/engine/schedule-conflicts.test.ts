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

function kitchenLive(o: {
  stableId: string;
  productCode: string;
  date: string;
  quantity?: number;
}): CalendarActivity {
  return {
    id: o.stableId,
    stableId: o.stableId,
    kind: 'kitchen',
    date: o.date,
    weekStart: o.date,
    orderInWeek: 0,
    station: null,
    productCode: o.productCode,
    productName: o.productCode,
    quantity: o.quantity ?? 100,
    durationMinutes: 0,
    changeoverMinutes: 0,
    family: null,
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

  // ─── SOH-aware mode (Phase 4l.3) ───────────────────────────

  describe('SOH-aware mode', () => {
    function poReceiving(o: {
      stableId: string;
      productCode: string;
      date: string;
      quantity?: number;
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
        quantity: o.quantity ?? 100,
        durationMinutes: 0,
        changeoverMinutes: 0,
        family: null,
        extendedFamily: null,
      };
    }

    test('SOH covers single consumer → no conflict even when later PO arrives late', () => {
      // The LMFCACBPLG bug: 1997 in stock, P1 needs 1390. PO-R arrives
      // after P1 (sized for some later consumer that isn't in this fixture).
      const conflicts = detectScheduleConflicts({
        activities: [
          { ...packagingActivity({ stableId: 'P1', productCode: 'FCHOC', date: '2026-05-04' }), quantity: 1390 },
          poReceiving({ stableId: 'PO-R|LABEL', productCode: 'LABEL', date: '2026-06-07', quantity: 833 }),
        ],
        consumesMap: { FCHOC: ['LABEL'] },
        initialSohByCode: { LABEL: 1997 },
        consumesQtyMap: { FCHOC: { LABEL: 1 } },
        supplyQtyByActivity: { 'PO-R|LABEL': 833 },
      });
      expect(conflicts).toEqual([]);
    });

    test('SOH covers some consumers, runs out, later consumer with late PO is flagged', () => {
      // SOH=1000. P1@5/15 needs 600 (running SOH +400). P2@5/20 needs 600
      // (running SOH -200). PO-R arrives 5/25 → P2 flagged, P1 silent.
      const conflicts = detectScheduleConflicts({
        activities: [
          { ...packagingActivity({ stableId: 'P1', productCode: 'A', date: '2026-05-15' }), quantity: 600 },
          { ...packagingActivity({ stableId: 'P2', productCode: 'A', date: '2026-05-20' }), quantity: 600 },
          poReceiving({ stableId: 'PO-R|RAW', productCode: 'RAW', date: '2026-05-25', quantity: 200 }),
        ],
        consumesMap: { A: ['RAW'] },
        initialSohByCode: { RAW: 1000 },
        consumesQtyMap: { A: { RAW: 1 } },
        supplyQtyByActivity: { 'PO-R|RAW': 200 },
      });
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].consumerStableId).toBe('P2');
      expect(conflicts[0].ingredientCode).toBe('RAW');
      expect(conflicts[0].blockedByStableId).toBe('PO-R|RAW');
    });

    test('supplier in time AND sufficient qty → no conflict', () => {
      // SOH=0. P1@5/15 needs 100 of RAW. PO-R@5/12 produces 100. PO-R
      // becomes available 5/13 (buffer), 5/13 < 5/15 ✓
      const conflicts = detectScheduleConflicts({
        activities: [
          { ...packagingActivity({ stableId: 'P1', productCode: 'A', date: '2026-05-15' }), quantity: 100 },
          poReceiving({ stableId: 'PO-R|RAW', productCode: 'RAW', date: '2026-05-12', quantity: 100 }),
        ],
        consumesMap: { A: ['RAW'] },
        initialSohByCode: { RAW: 0 },
        consumesQtyMap: { A: { RAW: 1 } },
        supplyQtyByActivity: { 'PO-R|RAW': 100 },
      });
      expect(conflicts).toEqual([]);
    });

    test('supplier in time but insufficient qty → conflict', () => {
      // SOH=0. P1@5/15 needs 100. PO-R@5/12 produces only 30. Timing OK,
      // qty short → flagged.
      const conflicts = detectScheduleConflicts({
        activities: [
          { ...packagingActivity({ stableId: 'P1', productCode: 'A', date: '2026-05-15' }), quantity: 100 },
          poReceiving({ stableId: 'PO-R|RAW', productCode: 'RAW', date: '2026-05-12', quantity: 30 }),
        ],
        consumesMap: { A: ['RAW'] },
        initialSohByCode: { RAW: 0 },
        consumesQtyMap: { A: { RAW: 1 } },
        supplyQtyByActivity: { 'PO-R|RAW': 30 },
      });
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].consumerStableId).toBe('P1');
      expect(conflicts[0].blockedByStableId).toBe('PO-R|RAW');
    });

    test('yield rate discounts kitchen-run supply qty (kitchen produces less than nominal)', () => {
      // ICC kitchen-run at quantity 100 with yield 0.7 only produces 70.
      // Consumer P1 needs 80 → 10 short → conflict.
      const conflicts = detectScheduleConflicts({
        activities: [
          { ...packagingActivity({ stableId: 'P1', productCode: 'FCHOC', date: '2026-05-15' }), quantity: 80 },
          kitchenRequired({ stableId: 'K1', productCode: 'ICC', startDate: '2026-05-12', finishDate: '2026-05-12' }),
        ],
        consumesMap: { FCHOC: ['ICC'] },
        initialSohByCode: { ICC: 0 },
        consumesQtyMap: { FCHOC: { ICC: 1 } },
        supplyQtyByActivity: { K1: 35 }, // 50 nominal × 0.7 yield = 35 (the K1 fixture has quantity 50)
      });
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].consumerStableId).toBe('P1');
      expect(conflicts[0].ingredientCode).toBe('ICC');
    });

    test('SOH-aware mode preserves "no candidate at all" silence (no SOH, no PO)', () => {
      // Like the legacy behaviour: a consumer with nothing scheduled and
      // SOH=0 is silently skipped. Caller's responsibility to surface the
      // shortage via the raw-material analysis instead.
      const conflicts = detectScheduleConflicts({
        activities: [
          packagingActivity({ stableId: 'P1', productCode: 'FCHOC', date: '2026-05-15' }),
        ],
        consumesMap: { FCHOC: ['ICC'] },
        initialSohByCode: { ICC: 0 },
        consumesQtyMap: { FCHOC: { ICC: 1 } },
      });
      expect(conflicts).toEqual([]);
    });

    test('legacy fallback when initialSohByCode is undefined preserves old behaviour', () => {
      // Same fixture as the legacy "PO arrives late" test — must produce
      // the same result when no SOH is supplied.
      const conflicts = detectScheduleConflicts({
        activities: [
          packagingActivity({ stableId: 'P1', productCode: 'FCHOC', date: '2026-05-15' }),
          poReceiving({ stableId: 'PO-R|LABEL', productCode: 'LABEL', date: '2026-05-20' }),
        ],
        consumesMap: { FCHOC: ['LABEL'] },
      });
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].consumerStableId).toBe('P1');
      expect(conflicts[0].ingredientCode).toBe('LABEL');
    });
  });

  // ─── Live Unleashed assemblies as consumers (Phase 4l.4) ────

  describe('kitchen (live assembly) consumer behaviour', () => {
    test('legacy mode: live kitchen assembly is flagged when its raw material PO arrives too late', () => {
      // K1 is a Parked/Planned/Open assembly producing IAH on 5/15. It will
      // consume HAZELNUTS that day. PO-R for HAZELNUTS arrives 5/20 → too late.
      const conflicts = detectScheduleConflicts({
        activities: [
          {
            ...kitchenLive({ stableId: 'K1', productCode: 'IAH', date: '2026-05-15' }),
          },
          {
            id: 'PO-R|HAZELNUTS',
            stableId: 'PO-R|HAZELNUTS',
            kind: 'po-receiving',
            date: '2026-05-20',
            weekStart: '2026-05-18',
            orderInWeek: 0,
            station: null,
            productCode: 'HAZELNUTS',
            productName: 'HAZELNUTS',
            quantity: 100,
            durationMinutes: 0,
            changeoverMinutes: 0,
            family: null,
            extendedFamily: null,
          },
        ],
        consumesMap: { IAH: ['HAZELNUTS'] },
      });
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].consumerStableId).toBe('K1');
      expect(conflicts[0].ingredientCode).toBe('HAZELNUTS');
    });

    test('SOH-aware mode: live kitchen assembly draws from initial SOH like any other consumer', () => {
      // 50 HAZELNUTS in stock. K1 needs 100 (kitchen run for IAH at qty 100,
      // 1:1 ingredient ratio). 50 covered by SOH, 50 short → flagged.
      const conflicts = detectScheduleConflicts({
        activities: [
          {
            ...kitchenLive({
              stableId: 'K1',
              productCode: 'IAH',
              date: '2026-05-15',
              quantity: 100,
            }),
          },
        ],
        consumesMap: { IAH: ['HAZELNUTS'] },
        initialSohByCode: { HAZELNUTS: 50 },
        consumesQtyMap: { IAH: { HAZELNUTS: 1 } },
      });
      // No scheduled supplier and SOH alone covers 50 of 100 — but absence
      // of a "blocked by" supplier means the detector silently drops out
      // (consistent with legacy "no candidate at all" behaviour). Surfacing
      // this as a shortage is the raw-material analyzer's job.
      expect(conflicts).toEqual([]);
    });

    test('SOH-aware mode: yield discount applies to live kitchen supply, not just kitchen-required', () => {
      // K_live produces IAH at qty 100 with yield 0.7 → effective supply 70.
      // P1 needs 80 of IAH → 10 short → conflict.
      const conflicts = detectScheduleConflicts({
        activities: [
          {
            ...packagingActivity({
              stableId: 'P1',
              productCode: 'FCHOC',
              date: '2026-05-15',
            }),
            quantity: 80,
          },
          {
            ...kitchenLive({
              stableId: 'K_live',
              productCode: 'IAH',
              date: '2026-05-12',
              quantity: 100,
            }),
          },
        ],
        consumesMap: { FCHOC: ['IAH'] },
        initialSohByCode: { IAH: 0 },
        consumesQtyMap: { FCHOC: { IAH: 1 } },
        supplyQtyByActivity: { K_live: 70 }, // 100 nominal × 0.7 yield
      });
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].consumerStableId).toBe('P1');
      expect(conflicts[0].ingredientCode).toBe('IAH');
    });
  });
});
