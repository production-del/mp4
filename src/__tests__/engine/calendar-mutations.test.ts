/**
 * Hand-rolled localStorage mock so this suite can run under the project's
 * default node test environment (no jsdom dep needed).
 */
import {
  applyDismiss,
  applyUndismiss,
  isDismissed,
  applyReschedule,
  applyClearReschedule,
  rescheduledTo,
  applyEditQuantity,
  applyClearEdit,
  editedQuantityOf,
  applyEditLeadTime,
  applyClearLeadTime,
  editedLeadTimeDaysOf,
  leadTimeOverridesByCode,
  clearStale,
  readMutationsFromStorage,
  writeMutationsToStorage,
  staleStableIds,
  type MutationsMap,
} from '@/lib/planning/calendar-mutations';

describe('calendar-mutations: pure operations', () => {
  describe('applyDismiss', () => {
    test('marks an activity dismissed in a new map', () => {
      const out = applyDismiss({}, 'A|2026-05-04|0');
      expect(isDismissed(out, 'A|2026-05-04|0')).toBe(true);
      expect(out['A|2026-05-04|0'].updatedAt).toBeDefined();
    });

    test('does not mutate the input map', () => {
      const input: MutationsMap = {};
      const out = applyDismiss(input, 'A|2026-05-04|0');
      expect(input).toEqual({});
      expect(out).not.toBe(input);
    });

    test('idempotent — second call returns the same reference', () => {
      const once = applyDismiss({}, 'A|2026-05-04|0');
      const twice = applyDismiss(once, 'A|2026-05-04|0');
      expect(twice).toBe(once); // no-op when already dismissed
    });
  });

  describe('applyUndismiss', () => {
    test('removes the dismissal flag', () => {
      const dismissed = applyDismiss({}, 'A|2026-05-04|0');
      const undone = applyUndismiss(dismissed, 'A|2026-05-04|0');
      expect(isDismissed(undone, 'A|2026-05-04|0')).toBe(false);
    });

    test('drops the entry entirely when no other fields remain', () => {
      const dismissed = applyDismiss({}, 'A|2026-05-04|0');
      const undone = applyUndismiss(dismissed, 'A|2026-05-04|0');
      expect(undone['A|2026-05-04|0']).toBeUndefined();
    });

    test('no-op when stableId is not in the map', () => {
      const map: MutationsMap = {};
      const out = applyUndismiss(map, 'A|2026-05-04|0');
      expect(out).toBe(map);
    });
  });

  describe('isDismissed', () => {
    test('returns false for absent entries', () => {
      expect(isDismissed({}, 'X')).toBe(false);
    });
    test('returns true after dismiss', () => {
      const m = applyDismiss({}, 'X');
      expect(isDismissed(m, 'X')).toBe(true);
    });
    test('returns false after dismiss + undismiss', () => {
      const m1 = applyDismiss({}, 'X');
      const m2 = applyUndismiss(m1, 'X');
      expect(isDismissed(m2, 'X')).toBe(false);
    });
  });

  describe('reschedule', () => {
    test('applyReschedule sets the field', () => {
      const out = applyReschedule({}, 'A|2026-05-04|0', '2026-05-06');
      expect(rescheduledTo(out, 'A|2026-05-04|0')).toBe('2026-05-06');
    });

    test('rescheduledTo returns null for absent entries', () => {
      expect(rescheduledTo({}, 'X')).toBeNull();
    });

    test('applyClearReschedule drops the entry when no other fields remain', () => {
      const sched = applyReschedule({}, 'A', '2026-05-06');
      const cleared = applyClearReschedule(sched, 'A');
      expect(cleared['A']).toBeUndefined();
    });

    test('applyClearReschedule preserves dismiss when both are set', () => {
      let m = applyReschedule({}, 'A', '2026-05-06');
      m = applyDismiss(m, 'A');
      const cleared = applyClearReschedule(m, 'A');
      expect(rescheduledTo(cleared, 'A')).toBeNull();
      expect(isDismissed(cleared, 'A')).toBe(true);
    });

    test('coexists with dismiss on the same stableId', () => {
      let m = applyDismiss({}, 'A');
      m = applyReschedule(m, 'A', '2026-05-06');
      expect(isDismissed(m, 'A')).toBe(true);
      expect(rescheduledTo(m, 'A')).toBe('2026-05-06');
    });
  });

  describe('edit quantity', () => {
    test('applyEditQuantity sets the field', () => {
      const out = applyEditQuantity({}, 'A', 250);
      expect(editedQuantityOf(out, 'A')).toBe(250);
    });

    test('rejects zero / negative / NaN quantities', () => {
      expect(applyEditQuantity({}, 'A', 0)).toEqual({});
      expect(applyEditQuantity({}, 'A', -10)).toEqual({});
      expect(applyEditQuantity({}, 'A', NaN)).toEqual({});
    });

    test('applyClearEdit drops the entry when no other fields remain', () => {
      const edited = applyEditQuantity({}, 'A', 250);
      const cleared = applyClearEdit(edited, 'A');
      expect(cleared['A']).toBeUndefined();
    });

    test('coexists with reschedule + dismiss on the same stableId', () => {
      let m = applyDismiss({}, 'A');
      m = applyReschedule(m, 'A', '2026-05-06');
      m = applyEditQuantity(m, 'A', 333);
      expect(isDismissed(m, 'A')).toBe(true);
      expect(rescheduledTo(m, 'A')).toBe('2026-05-06');
      expect(editedQuantityOf(m, 'A')).toBe(333);
    });
  });

  describe('clearStale', () => {
    test('drops entries whose stableId is not in the valid set', () => {
      let m: MutationsMap = {};
      m = applyDismiss(m, 'KEEP');
      m = applyReschedule(m, 'GONE', '2026-05-06');
      const cleaned = clearStale(m, new Set(['KEEP']));
      expect(cleaned['KEEP']).toBeDefined();
      expect(cleaned['GONE']).toBeUndefined();
    });

    test('returns a fresh map (no mutation of input)', () => {
      const m: MutationsMap = applyDismiss({}, 'X');
      const cleaned = clearStale(m, new Set(['X']));
      expect(cleaned).not.toBe(m);
    });
  });

  describe('staleStableIds', () => {
    test('finds map entries whose stableId is not in the valid set', () => {
      const m: MutationsMap = {
        'A|2026-05-04|0': { stableId: 'A|2026-05-04|0', dismissed: true, updatedAt: 'x' },
        'B|2026-05-04|0': { stableId: 'B|2026-05-04|0', dismissed: true, updatedAt: 'x' },
      };
      const stale = staleStableIds(m, new Set(['A|2026-05-04|0']));
      expect(stale).toEqual(['B|2026-05-04|0']);
    });

    test('returns empty when all entries are valid', () => {
      const m: MutationsMap = {
        'A|2026-05-04|0': { stableId: 'A|2026-05-04|0', dismissed: true, updatedAt: 'x' },
      };
      expect(staleStableIds(m, new Set(['A|2026-05-04|0']))).toEqual([]);
    });
  });

  describe('lead-time override (Phase 4m.4)', () => {
    test('applyEditLeadTime stores days on a place-by chip stableId', () => {
      const out = applyEditLeadTime({}, 'po-placed|RAW_X', 21);
      expect(out['po-placed|RAW_X']?.editedLeadTimeDays).toBe(21);
      expect(editedLeadTimeDaysOf(out, 'po-placed|RAW_X')).toBe(21);
    });

    test('rejects negative or non-finite days', () => {
      expect(applyEditLeadTime({}, 'po-placed|X', -1)).toEqual({});
      expect(applyEditLeadTime({}, 'po-placed|X', NaN)).toEqual({});
    });

    test('rounds non-integer days', () => {
      const out = applyEditLeadTime({}, 'po-placed|X', 14.7);
      expect(editedLeadTimeDaysOf(out, 'po-placed|X')).toBe(15);
    });

    test('applyClearLeadTime drops the field; entry vanishes when only it remained', () => {
      const m = applyEditLeadTime({}, 'po-placed|X', 21);
      const out = applyClearLeadTime(m, 'po-placed|X');
      expect(out['po-placed|X']).toBeUndefined();
    });

    test('applyClearLeadTime preserves other fields', () => {
      const m: MutationsMap = {
        'po-placed|X': {
          stableId: 'po-placed|X',
          dismissed: true,
          editedLeadTimeDays: 21,
          updatedAt: 'x',
        },
      };
      const out = applyClearLeadTime(m, 'po-placed|X');
      expect(out['po-placed|X']?.editedLeadTimeDays).toBeUndefined();
      expect(out['po-placed|X']?.dismissed).toBe(true);
    });

    test('leadTimeOverridesByCode extracts overrides keyed by raw material code', () => {
      const m: MutationsMap = {
        'po-placed|RAW_A': {
          stableId: 'po-placed|RAW_A',
          editedLeadTimeDays: 21,
          updatedAt: 'x',
        },
        'po-placed|RAW_B': {
          stableId: 'po-placed|RAW_B',
          editedLeadTimeDays: 7,
          updatedAt: 'x',
        },
        // Other mutations + non-place-by stableIds are ignored.
        'FCHOC|2026-05-04|0': {
          stableId: 'FCHOC|2026-05-04|0',
          editedQuantity: 200,
          updatedAt: 'x',
        },
        'po-receiving|RAW_A': {
          stableId: 'po-receiving|RAW_A',
          editedLeadTimeDays: 99, // would be wrong-key, ignored
          updatedAt: 'x',
        },
      };
      expect(leadTimeOverridesByCode(m)).toEqual({ RAW_A: 21, RAW_B: 7 });
    });
  });
});

describe('calendar-mutations: localStorage persistence (with mocked window)', () => {
  // Install a minimal window+localStorage onto globalThis so the
  // production code's `typeof window !== 'undefined'` branches activate.
  // Restored to the original (typically undefined) state after each test.
  let originalWindow: unknown;
  let store: Record<string, string>;

  beforeEach(() => {
    store = {};
    originalWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: (k: string) => (k in store ? store[k] : null),
        setItem: (k: string, v: string) => {
          store[k] = String(v);
        },
        removeItem: (k: string) => {
          delete store[k];
        },
        clear: () => {
          store = {};
        },
      },
    };
  });

  afterEach(() => {
    (globalThis as { window?: unknown }).window = originalWindow;
  });

  test('write then read round-trips the map', () => {
    const m = applyDismiss({}, 'A|2026-05-04|0');
    writeMutationsToStorage(m);
    const back = readMutationsFromStorage();
    expect(back['A|2026-05-04|0'].dismissed).toBe(true);
  });

  test('read returns empty map when storage is empty', () => {
    expect(readMutationsFromStorage()).toEqual({});
  });

  test('read tolerates malformed JSON', () => {
    store['byron-calendar-mutations-v1'] = 'not json {{{';
    expect(readMutationsFromStorage()).toEqual({});
  });

  test('read rejects non-object payloads', () => {
    store['byron-calendar-mutations-v1'] = '[1,2,3]';
    expect(readMutationsFromStorage()).toEqual({});
  });

  test('writes are silent no-ops when window is undefined (server context)', () => {
    (globalThis as { window?: unknown }).window = undefined;
    expect(() => writeMutationsToStorage({ x: { stableId: 'x', dismissed: true, updatedAt: '' } })).not.toThrow();
    expect(readMutationsFromStorage()).toEqual({});
  });
});
