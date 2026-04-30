/**
 * Versioned localStorage store — the pattern we arrived at in the planner,
 * extracted as a reusable primitive.
 *
 * The painful bits this helper handles for you:
 *
 *   1. Versioned payload (`{ version, items }`), not raw arrays. Lets you
 *      bump the schema cleanly later.
 *   2. Session-guarded migration. If you migrate inside `read()`, and a
 *      React effect writes an empty array before the migration has run,
 *      you lose data. The module-level flag here guarantees migration
 *      fires at most once per tab, before any writes.
 *   3. Clean break on migration: legacy keys are deleted after a successful
 *      read, not kept around "for safety" (where they'd stay forever).
 *   4. `typeof window` guards for SSR/test environments.
 *
 * Consumer responsibility: supply a `migrateLegacy` function that reads
 * whatever old keys existed and returns `items[]`. Don't worry about idempotence
 * or timing — the store handles both.
 *
 * Typical use in a tracker app:
 *
 *     const ingredientStore = createVersionedStore<Ingredient>({
 *       key: 'byron-tracker-ingredients-v1',
 *       version: 1,
 *       migrateLegacy: () => {
 *         const raw = localStorage.getItem('byron-tracker-ingredients');
 *         if (!raw) return [];
 *         const items = JSON.parse(raw) as Ingredient[];
 *         localStorage.removeItem('byron-tracker-ingredients');
 *         return items;
 *       },
 *     });
 *
 *     ingredientStore.list();
 *     ingredientStore.replace(newItems);
 *     ingredientStore.upsert(ingredient, (a, b) => a.productCode === b.productCode);
 *     ingredientStore.remove(i => i.productCode === 'WLN-RAW');
 */

export interface VersionedStore<T> {
  /** Read all items. Triggers lazy migration on first call per tab. */
  list: () => T[];

  /** Replace the entire item set. */
  replace: (items: T[]) => void;

  /**
   * Upsert a single item. Caller supplies the equality predicate so the
   * store stays agnostic about what "same item" means for the domain.
   */
  upsert: (item: T, eq: (a: T, b: T) => boolean) => void;

  /** Remove items matching a predicate. Returns count removed. */
  remove: (predicate: (item: T) => boolean) => number;

  /** Force-run the legacy migration now (e.g., at app mount). */
  runMigration: () => void;

  /** Remove the store's localStorage key entirely (testing / reset). */
  clear: () => void;
}

export interface CreateStoreOptions<T> {
  /** The localStorage key to use, e.g. `"byron-tracker-suppliers-v1"`. */
  key: string;

  /** Schema version. Bump when the payload shape changes. */
  version: number;

  /**
   * Read + return legacy data, deleting any legacy keys on the way out.
   * Called at most once per tab. Return `[]` when there's nothing to migrate.
   * Must be idempotent (will be called defensively in some edge cases).
   */
  migrateLegacy?: () => T[];
}

interface StoreShape<T> {
  version: number;
  items: T[];
}

export function createVersionedStore<T>(options: CreateStoreOptions<T>): VersionedStore<T> {
  const { key, version, migrateLegacy } = options;

  let migrationChecked = false;

  function readRaw(): StoreShape<T> {
    if (typeof window === 'undefined') return { version, items: [] };
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) return { version, items: [] };
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.version !== version || !Array.isArray(parsed.items)) {
        return { version, items: [] };
      }
      return parsed as StoreShape<T>;
    } catch {
      return { version, items: [] };
    }
  }

  function writeRaw(store: StoreShape<T>): void {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(key, JSON.stringify(store));
    } catch {
      // quota / serialization errors are non-fatal
    }
  }

  function maybeMigrate(): void {
    if (migrationChecked) return;
    migrationChecked = true;
    if (typeof window === 'undefined') return;
    if (!migrateLegacy) return;

    // Only migrate if the new store is empty. Legacy keys, if still present
    // alongside populated new data, are stale — the `migrateLegacy` function
    // is responsible for deleting them regardless of whether it imports.
    const current = readRaw();
    if (current.items.length > 0) {
      // Still give migrateLegacy a chance to clean up legacy keys.
      try {
        migrateLegacy();
      } catch {
        /* ignore */
      }
      return;
    }

    try {
      const items = migrateLegacy();
      if (items.length > 0) writeRaw({ version, items });
    } catch {
      /* ignore */
    }
  }

  function read(): StoreShape<T> {
    maybeMigrate();
    return readRaw();
  }

  return {
    list() {
      return read().items;
    },
    replace(items: T[]) {
      writeRaw({ version, items });
    },
    upsert(item: T, eq: (a: T, b: T) => boolean) {
      const store = read();
      const idx = store.items.findIndex((existing) => eq(existing, item));
      const next = [...store.items];
      if (idx === -1) next.push(item);
      else next[idx] = item;
      writeRaw({ version, items: next });
    },
    remove(predicate: (item: T) => boolean) {
      const store = read();
      const kept = store.items.filter((i) => !predicate(i));
      const removed = store.items.length - kept.length;
      writeRaw({ version, items: kept });
      return removed;
    },
    runMigration() {
      maybeMigrate();
    },
    clear() {
      if (typeof window === 'undefined') return;
      window.localStorage.removeItem(key);
      migrationChecked = false;
    },
  };
}
