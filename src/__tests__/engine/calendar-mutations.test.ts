/**
 * Hand-rolled localStorage mock so this suite can run under the project's
 * default node test environment (no jsdom dep needed).
 */
import {
  applyDismiss,
  applyUndismiss,
  isDismissed,
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
