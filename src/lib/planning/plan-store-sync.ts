/**
 * Server-sync layer for the local plan-draft-store.
 *
 * Architecture:
 * - localStorage stays the canonical fast/sync read source for components.
 * - Each mutation also enqueues a `MutateOp` here, debounced 400ms.
 * - On window mount we pull the server snapshot and replace localStorage.
 * - On focus we re-pull (so changes from another browser appear).
 * - On `pagehide` we flush any pending ops via `sendBeacon`.
 *
 * The store API stays synchronous; this module is purely additive.
 */

import type { PlanItem, PlanItemKind } from './plan-item';

export type MutateOp =
  | { op: 'upsert'; items: PlanItem[] }
  | { op: 'remove'; ids: string[] }
  | { op: 'replaceByKind'; kind: PlanItemKind; items: PlanItem[] }
  | { op: 'markPushed'; ids: string[] }
  | { op: 'addDismissed'; key: string }
  | { op: 'removeDismissed'; key: string }
  | { op: 'clearDismissed' };

const DEBOUNCE_MS = 400;
const MUTATE_ENDPOINT = '/api/plan-drafts/mutate';
const GET_ENDPOINT = '/api/plan-drafts';

interface PullResponse {
  items: PlanItem[];
  dismissedKitchenKeys: string[];
  serverTime: string;
}

let queue: MutateOp[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of listeners) {
    try { fn(); } catch { /* listener errors must not break sync */ }
  }
}

/**
 * Subscribe to "server pulled fresh state" events. Called after a pull
 * replaces localStorage so React components can rehydrate from the store.
 */
export function onServerStateChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function enqueue(op: MutateOp): void {
  if (typeof window === 'undefined') return;
  queue.push(op);
  scheduleFlush();
}

function scheduleFlush(): void {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, DEBOUNCE_MS);
}

async function flush(): Promise<void> {
  if (flushing) return;
  if (queue.length === 0) return;
  const ops = queue;
  queue = [];
  flushing = true;
  try {
    const res = await fetch(MUTATE_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ops }),
      credentials: 'same-origin',
    });
    if (!res.ok) {
      console.warn('[plan-store-sync] mutate failed', res.status);
      // Best-effort retry once on transient failure.
      queue.unshift(...ops);
      scheduleFlush();
    }
  } catch (err) {
    console.warn('[plan-store-sync] mutate error', err);
    queue.unshift(...ops);
    scheduleFlush();
  } finally {
    flushing = false;
  }
}

/**
 * Best-effort flush triggered before tab close. `sendBeacon` survives
 * navigation/close where `fetch` would be cancelled.
 */
function flushOnUnload(): void {
  if (queue.length === 0) return;
  if (typeof navigator === 'undefined' || !navigator.sendBeacon) return;
  try {
    const blob = new Blob([JSON.stringify({ ops: queue })], {
      type: 'application/json',
    });
    navigator.sendBeacon(MUTATE_ENDPOINT, blob);
    queue = [];
  } catch {
    /* ignore */
  }
}

/**
 * Pull authoritative state from the server and overwrite localStorage.
 * Used on mount and on window focus.
 */
export async function pullFromServer(): Promise<void> {
  if (typeof window === 'undefined') return;
  try {
    const res = await fetch(GET_ENDPOINT, { credentials: 'same-origin' });
    if (!res.ok) return;
    const body = await res.json() as PullResponse;
    writeToLocalStorage(body);
    notify();
  } catch (err) {
    console.warn('[plan-store-sync] pull failed', err);
  }
}

/**
 * Push a local snapshot up to seed an empty server. Called once on first
 * mount when the server is empty but localStorage has data — typically the
 * very first time a user opens the app after this feature ships.
 */
async function pushSeedToServer(snapshot: StoredShape): Promise<void> {
  const ops: MutateOp[] = [];
  if (snapshot.items.length > 0) ops.push({ op: 'upsert', items: snapshot.items });
  for (const key of snapshot.dismissedKitchenKeys) {
    ops.push({ op: 'addDismissed', key });
  }
  if (ops.length === 0) return;

  await fetch(MUTATE_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ops }),
    credentials: 'same-origin',
  }).catch(err => console.warn('[plan-store-sync] seed push failed', err));
}

const STORE_KEY = 'byron-plan-drafts-v1';

interface StoredShape {
  version: 1;
  items: PlanItem[];
  dismissedKitchenKeys: string[];
}

function readFromLocalStorage(): StoredShape {
  if (typeof window === 'undefined') {
    return { version: 1, items: [], dismissedKitchenKeys: [] };
  }
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return { version: 1, items: [], dismissedKitchenKeys: [] };
    const parsed = JSON.parse(raw);
    return {
      version: 1,
      items: Array.isArray(parsed?.items) ? parsed.items : [],
      dismissedKitchenKeys: Array.isArray(parsed?.dismissedKitchenKeys)
        ? parsed.dismissedKitchenKeys : [],
    };
  } catch {
    return { version: 1, items: [], dismissedKitchenKeys: [] };
  }
}

function writeToLocalStorage(snapshot: PullResponse): void {
  if (typeof window === 'undefined') return;
  const next: StoredShape = {
    version: 1,
    items: snapshot.items,
    dismissedKitchenKeys: snapshot.dismissedKitchenKeys,
  };
  localStorage.setItem(STORE_KEY, JSON.stringify(next));
}

let initialized = false;

/**
 * One-shot client init. Idempotent — safe to call from React mount.
 */
export async function initServerSync(): Promise<void> {
  if (typeof window === 'undefined') return;
  if (initialized) return;
  initialized = true;

  // Capture local BEFORE the pull so we can seed the server with it if the
  // server turns out to be empty (the pull would otherwise overwrite local
  // with the server's empty snapshot before we get a chance to read it).
  const beforeLocal = readFromLocalStorage();
  await pullFromServer();
  const afterLocal = readFromLocalStorage();
  const serverWasEmpty =
    afterLocal.items.length === 0 &&
    afterLocal.dismissedKitchenKeys.length === 0;
  const localHadData =
    beforeLocal.items.length > 0 ||
    beforeLocal.dismissedKitchenKeys.length > 0;
  if (serverWasEmpty && localHadData) {
    await pushSeedToServer(beforeLocal);
    await pullFromServer();
  }

  window.addEventListener('focus', () => { void pullFromServer(); });
  window.addEventListener('pagehide', flushOnUnload);
}
