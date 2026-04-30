/**
 * Per-product "priority" flag store.
 *
 * A priority-flagged product is one the operator wants watched closely for
 * over-allocation. When the flag is set AND the product's `availableStock`
 * goes negative AND an intermediate is available somewhere, the Priorities
 * page proposes a draft assembly (plus a transfer if needed) for one-click
 * approval.
 *
 * The flag itself is a per-device preference stored in localStorage —
 * Products aren't writable from this app's Unleashed proxy, and sidecar
 * cloud state isn't worth the complexity for a flag-per-SKU. Uses the
 * versioned-store pattern from `plan-draft-store.ts`: session-guarded
 * lazy migration, clean-break policy, single key.
 */

const STORE_KEY = 'byron-priority-flags-v1';

export interface PriorityFlag {
  /** Whether this product is being watched for priority triggers. */
  enabled: boolean;
  /** ISO date the flag was last toggled — useful for audit/debug. */
  setAt: string;
}

interface StoreShape {
  version: 1;
  flags: Record<string, PriorityFlag>;
}

function emptyStore(): StoreShape {
  return { version: 1, flags: {} };
}

function readRaw(): StoreShape {
  if (typeof window === 'undefined') return emptyStore();
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    if (!raw) return emptyStore();
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== 1 || typeof parsed.flags !== 'object') {
      return emptyStore();
    }
    return parsed;
  } catch {
    return emptyStore();
  }
}

function writeRaw(store: StoreShape): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch {
    /* quota / serialization errors are non-fatal */
  }
}

// ─── Public API ─────────────────────────────────────────────

/** All priority flags as a plain record (for passing into selectors). */
export function listPriorityFlags(): Record<string, PriorityFlag> {
  return readRaw().flags;
}

/** Convenience: is this product flagged as priority? */
export function isPriority(productCode: string): boolean {
  return readRaw().flags[productCode]?.enabled === true;
}

/** Set/clear the flag. Writes immediately — caller doesn't need a save step. */
export function setPriority(productCode: string, enabled: boolean): void {
  const store = readRaw();
  if (enabled) {
    store.flags[productCode] = { enabled: true, setAt: new Date().toISOString() };
  } else {
    delete store.flags[productCode];
  }
  writeRaw(store);
}

/** Clear every flag (settings page nuclear option). */
export function clearAllPriorityFlags(): void {
  writeRaw(emptyStore());
}

/** Count of enabled flags — shown on the Priorities page header. */
export function countEnabledFlags(): number {
  const store = readRaw();
  let n = 0;
  for (const k of Object.keys(store.flags)) {
    if (store.flags[k]?.enabled) n++;
  }
  return n;
}
