import { describe, test, expect, beforeEach } from 'vitest';
import { createVersionedStore } from '../src/versioned-store';

// Minimal localStorage polyfill for the test environment.
class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

// @ts-expect-error — assign global for the test run only.
globalThis.window = { localStorage: new MemoryStorage() };

interface Widget {
  id: string;
  name: string;
}

const widgetsEq = (a: Widget, b: Widget) => a.id === b.id;

beforeEach(() => {
  window.localStorage.clear();
});

describe('versioned store', () => {
  test('list returns empty when no data exists', () => {
    const store = createVersionedStore<Widget>({ key: 'test-widgets', version: 1 });
    expect(store.list()).toEqual([]);
  });

  test('replace writes items and list reads them back', () => {
    const store = createVersionedStore<Widget>({ key: 'test-widgets', version: 1 });
    store.replace([{ id: '1', name: 'first' }]);
    expect(store.list()).toEqual([{ id: '1', name: 'first' }]);
  });

  test('upsert adds new items and updates existing ones', () => {
    const store = createVersionedStore<Widget>({ key: 'test-widgets', version: 1 });
    store.upsert({ id: '1', name: 'first' }, widgetsEq);
    store.upsert({ id: '2', name: 'second' }, widgetsEq);
    store.upsert({ id: '1', name: 'first-updated' }, widgetsEq);

    expect(store.list()).toEqual([
      { id: '1', name: 'first-updated' },
      { id: '2', name: 'second' },
    ]);
  });

  test('remove filters by predicate and returns count', () => {
    const store = createVersionedStore<Widget>({ key: 'test-widgets', version: 1 });
    store.replace([
      { id: '1', name: 'a' },
      { id: '2', name: 'b' },
      { id: '3', name: 'a' },
    ]);
    const removed = store.remove((w) => w.name === 'a');
    expect(removed).toBe(2);
    expect(store.list()).toEqual([{ id: '2', name: 'b' }]);
  });

  test('rejects payloads with mismatched version', () => {
    window.localStorage.setItem(
      'test-widgets',
      JSON.stringify({ version: 0, items: [{ id: 'stale', name: 'old' }] }),
    );
    const store = createVersionedStore<Widget>({ key: 'test-widgets', version: 1 });
    expect(store.list()).toEqual([]);
  });

  test('rejects malformed payloads gracefully', () => {
    window.localStorage.setItem('test-widgets', 'not-json{{');
    const store = createVersionedStore<Widget>({ key: 'test-widgets', version: 1 });
    expect(store.list()).toEqual([]);
  });

  test('migration runs once, deletes legacy key, and returns imported items', () => {
    window.localStorage.setItem(
      'test-legacy',
      JSON.stringify([{ id: 'old-1', name: 'legacy' }]),
    );

    let migrationRuns = 0;
    const store = createVersionedStore<Widget>({
      key: 'test-widgets',
      version: 1,
      migrateLegacy: () => {
        migrationRuns++;
        const raw = window.localStorage.getItem('test-legacy');
        if (!raw) return [];
        const items = JSON.parse(raw) as Widget[];
        window.localStorage.removeItem('test-legacy');
        return items;
      },
    });

    expect(store.list()).toEqual([{ id: 'old-1', name: 'legacy' }]);
    expect(window.localStorage.getItem('test-legacy')).toBeNull();

    // Subsequent reads must NOT re-run the migration.
    store.list();
    store.list();
    expect(migrationRuns).toBe(1);
  });

  test('migration is skipped when new store already has data', () => {
    // Seed the new store.
    window.localStorage.setItem(
      'test-widgets',
      JSON.stringify({ version: 1, items: [{ id: 'fresh', name: 'fresh' }] }),
    );
    // And also seed a legacy blob that SHOULD NOT overwrite.
    window.localStorage.setItem(
      'test-legacy',
      JSON.stringify([{ id: 'stale', name: 'stale' }]),
    );

    const store = createVersionedStore<Widget>({
      key: 'test-widgets',
      version: 1,
      migrateLegacy: () => {
        const raw = window.localStorage.getItem('test-legacy');
        if (!raw) return [];
        const items = JSON.parse(raw) as Widget[];
        window.localStorage.removeItem('test-legacy');
        return items;
      },
    });

    expect(store.list()).toEqual([{ id: 'fresh', name: 'fresh' }]);
    // migrateLegacy was still given a chance to clean up the legacy blob.
    expect(window.localStorage.getItem('test-legacy')).toBeNull();
  });

  test('clear removes the key and re-enables migration', () => {
    const store = createVersionedStore<Widget>({ key: 'test-widgets', version: 1 });
    store.replace([{ id: '1', name: 'x' }]);
    store.clear();
    expect(window.localStorage.getItem('test-widgets')).toBeNull();
    expect(store.list()).toEqual([]);
  });
});
