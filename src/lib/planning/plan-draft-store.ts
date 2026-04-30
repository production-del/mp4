/**
 * PlanDraftStore — one localStorage-backed store for every planner variant.
 *
 * Replaces five per-planner localStorage keys:
 *   - `byron-packaging-draft`
 *   - `byron-kitchen-draft`
 *   - `byron-kitchen-scheduled`
 *   - `byron-purchasing-draft-pos`
 *   - `byron-logistics-draft-transfers`
 *
 * A single versioned key (`byron-plan-drafts-v1`) holds every draft as a
 * discriminated `PlanItem`. Consumers filter by `kind` via the helpers here
 * (`listByKind`, `replaceByKind`) so no caller has to reason about the union.
 *
 * Legacy data is migrated once, on first read. The five legacy keys are then
 * removed — a clean break per the approved plan (user is sole user; regression
 * cost is low).
 */

import type {
  PlanItem,
  PlanItemKind,
  KitchenRunItem,
  PackagingRunItem,
  PurchaseOrderItem,
  TransferItem,
  Lifecycle,
} from './plan-item';
import { ofKind } from './plan-item';
import { toLocalISODate, dayIntToISO } from './working-day';

const STORE_KEY = 'byron-plan-drafts-v1';

const LEGACY_KEYS = {
  packaging: 'byron-packaging-draft',
  kitchenDraft: 'byron-kitchen-draft',
  kitchenScheduled: 'byron-kitchen-scheduled',
  purchasingPOs: 'byron-purchasing-draft-pos',
  logisticsTransfers: 'byron-logistics-draft-transfers',
} as const;

interface StoreShape {
  version: 1;
  items: PlanItem[];
  /**
   * Intermediate keys the operator has dismissed from the kitchen calendar.
   * Auto-scheduled unleashed-origin batches whose key appears here are held
   * out of the calendar until the operator re-drags them from the sidebar.
   */
  dismissedKitchenKeys?: string[];
}

function emptyStore(): StoreShape {
  return { version: 1, items: [], dismissedKitchenKeys: [] };
}

// One-shot migration guard per tab session. After migration runs once, reads
// go straight through — this prevents migrated data being re-migrated after a
// planner writes an empty set (a problem solved the same way for Demand).
let migrationChecked = false;

// ─── Core read/write ─────────────────────────────────────────

function readStoreRaw(): StoreShape {
  if (typeof window === 'undefined') return emptyStore();
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return emptyStore();
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.items)) {
      return emptyStore();
    }
    return parsed;
  } catch {
    return emptyStore();
  }
}

function writeStoreRaw(store: StoreShape): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch {
    /* quota/serialization errors are non-fatal */
  }
}

function readStore(): StoreShape {
  maybeMigrateLegacy();
  return readStoreRaw();
}

// ─── Public API ─────────────────────────────────────────────

/** All plan items across every kind. */
export function listPlanItems(): PlanItem[] {
  return readStore().items;
}

/** Plan items of a specific kind, narrowed to the correct variant type. */
export function listByKind<K extends PlanItemKind>(
  kind: K,
): Extract<PlanItem, { kind: K }>[] {
  return ofKind(readStore().items, kind);
}

/**
 * Replace ALL items of a given kind. The primary write path for planner
 * facades — a planner treats its entire variant space as authoritative and
 * hands back the whole list on each change.
 */
export function replaceByKind<K extends PlanItemKind>(
  kind: K,
  items: Extract<PlanItem, { kind: K }>[],
): void {
  const store = readStore();
  const kept = store.items.filter(i => i.kind !== kind);
  writeStoreRaw({ ...store, version: 1, items: [...kept, ...items] });
}

/** Upsert a single item by id (keeping its existing kind). */
export function upsertPlanItem(item: PlanItem): void {
  const store = readStore();
  const idx = store.items.findIndex(i => i.id === item.id);
  const next = [...store.items];
  if (idx === -1) next.push(item);
  else next[idx] = item;
  writeStoreRaw({ ...store, version: 1, items: next });
}

/**
 * Atomic batch upsert. Used when a single operator action produces multiple
 * items that should never exist in isolation — e.g., a Priority approval
 * writes a `PackagingRunItem` PLUS a paired `TransferItem` to feed it. A
 * naive pair of `upsertPlanItem` calls would render an inconsistent
 * intermediate state to any subscriber watching the store; this helper
 * collapses the writes into one `localStorage.setItem`.
 */
export function upsertMany(items: PlanItem[]): void {
  if (items.length === 0) return;
  const store = readStore();
  const byId = new Map(items.map(i => [i.id, i] as const));
  const next: PlanItem[] = [];
  const seen = new Set<string>();
  // Keep ordering stable: existing items retain their position; new items
  // append in the order they were passed in.
  for (const existing of store.items) {
    const replacement = byId.get(existing.id);
    if (replacement) {
      next.push(replacement);
      seen.add(existing.id);
    } else {
      next.push(existing);
    }
  }
  for (const item of items) {
    if (!seen.has(item.id)) next.push(item);
  }
  writeStoreRaw({ ...store, version: 1, items: next });
}

/** Remove a single item by id. */
export function removePlanItem(id: string): void {
  const store = readStore();
  writeStoreRaw({
    ...store,
    version: 1,
    items: store.items.filter(i => i.id !== id),
  });
}

/** Mark many items as pushed (e.g., after a successful Unleashed push). */
export function markPushed(ids: string[]): void {
  if (ids.length === 0) return;
  const idSet = new Set(ids);
  const store = readStore();
  writeStoreRaw({
    ...store,
    version: 1,
    items: store.items.map(i =>
      idSet.has(i.id) ? ({ ...i, lifecycle: 'pushed' as Lifecycle }) : i,
    ),
  });
}

// ─── Dismissed kitchen keys ──────────────────────────────────
//
// Intermediate keys the operator has hidden from the kitchen calendar.
// Used by `useKitchenPlanner` to suppress the auto-schedule of unleashed-origin
// batches whose key was dismissed. Dismissal is cleared by re-dragging the
// assembly back onto the calendar (scheduleBatch / rescheduleBatch).

/** Snapshot of the current dismissed kitchen key list. */
export function listDismissedKitchenKeys(): string[] {
  return readStore().dismissedKitchenKeys ?? [];
}

/** Add a key to the dismissed set; no-op if already present. */
export function addDismissedKitchenKey(key: string): void {
  const store = readStore();
  const current = store.dismissedKitchenKeys ?? [];
  if (current.includes(key)) return;
  writeStoreRaw({ ...store, version: 1, dismissedKitchenKeys: [...current, key] });
}

/** Remove a key from the dismissed set; no-op if absent. */
export function removeDismissedKitchenKey(key: string): void {
  const store = readStore();
  const current = store.dismissedKitchenKeys ?? [];
  if (!current.includes(key)) return;
  writeStoreRaw({
    ...store,
    version: 1,
    dismissedKitchenKeys: current.filter(k => k !== key),
  });
}

/** Clear all dismissed keys (used by Reset). */
export function clearDismissedKitchenKeys(): void {
  const store = readStore();
  writeStoreRaw({ ...store, version: 1, dismissedKitchenKeys: [] });
}

// ─── Legacy migration ────────────────────────────────────────

function maybeMigrateLegacy(): void {
  if (typeof window === 'undefined') return;
  if (migrationChecked) return;
  migrationChecked = true;

  try {
    // If the new store already has data, any legacy keys are stale — delete
    // them without overwriting the authoritative new data.
    const existing = readStoreRaw();
    if (existing.items.length > 0) {
      for (const key of Object.values(LEGACY_KEYS)) localStorage.removeItem(key);
      return;
    }

    const items: PlanItem[] = [];

    items.push(...migratePackagingDraft());
    items.push(...migrateKitchenBatches());
    items.push(...migratePurchasingPOs());
    items.push(...migrateTransfers());

    if (items.length > 0) {
      writeStoreRaw({ version: 1, items });
    }

    // Clean break: remove legacy keys once we've read them.
    for (const key of Object.values(LEGACY_KEYS)) localStorage.removeItem(key);
  } catch {
    /* migration is best-effort — ignore */
  }
}

/**
 * Force-migrate (useful at app mount). Idempotent — re-running after the
 * first run is a no-op because the session flag is set.
 */
export function runLegacyMigration(): void {
  maybeMigrateLegacy();
}

// ─── Per-variant legacy readers ──────────────────────────────

function migratePackagingDraft(): PackagingRunItem[] {
  const raw = localStorage.getItem(LEGACY_KEYS.packaging);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    const planned = (parsed.planned ?? {}) as Record<
      string,
      { quantity: number; dayInt: number; team?: PackagingRunItem['team'] }
    >;
    const existing = (parsed.existingEdits ?? {}) as Record<
      string,
      { qty: number; dayInt: number }
    >;

    const out: PackagingRunItem[] = [];

    for (const [code, plan] of Object.entries(planned)) {
      if (!plan || plan.quantity <= 0) continue;
      out.push({
        kind: 'packaging_run',
        id: `pkg:create:${code}`,
        productCode: code,
        productName: code, // legacy shape didn't store name; planner will hydrate
        quantity: plan.quantity,
        lifecycle: 'draft',
        dayInt: plan.dayInt,
        scheduledDate: plan.dayInt > 0 ? dayIntToISO(plan.dayInt) : '',
        team: plan.team,
        action: 'CREATE',
      });
    }

    for (const [code, edit] of Object.entries(existing)) {
      if (!edit || edit.qty <= 0) continue;
      out.push({
        kind: 'packaging_run',
        id: `pkg:update:${code}`,
        productCode: code,
        productName: code,
        quantity: edit.qty,
        lifecycle: 'draft',
        dayInt: edit.dayInt,
        scheduledDate: edit.dayInt > 0 ? dayIntToISO(edit.dayInt) : '',
        action: 'UPDATE',
      });
    }

    return out;
  } catch {
    return [];
  }
}

function migrateKitchenBatches(): KitchenRunItem[] {
  // Merge draft + scheduled — scheduled may include unleashed-origin batches.
  const out: KitchenRunItem[] = [];
  const seenIds = new Set<string>();

  for (const key of [LEGACY_KEYS.kitchenScheduled, LEGACY_KEYS.kitchenDraft]) {
    const raw = localStorage.getItem(key);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as Array<Record<string, unknown>>;
      for (const b of parsed) {
        const id = (b.id as string) || '';
        if (!id || seenIds.has(id)) continue;
        const intermediateKey = (b.intermediateKey as string) || '';
        if (!intermediateKey) continue; // skip old-format drafts
        seenIds.add(id);

        const origin = (b.origin as KitchenRunItem['origin']) ?? 'draft';
        const scheduledRaw = b.scheduledDate as string | undefined;
        const scheduledISO = scheduledRaw
          ? (() => {
              const d = new Date(scheduledRaw);
              return isNaN(d.getTime()) ? '' : toLocalISODate(d);
            })()
          : '';

        out.push({
          kind: 'kitchen_run',
          id,
          productCode: (b.productCode as string) || '',
          productName: (b.productName as string) || '',
          quantity: (b.quantity as number) || 0,
          lifecycle: origin === 'unleashed' ? 'pushed' : 'draft',
          scheduledDate: scheduledISO,
          intermediateKey,
          dehydrator: b.dehydrator as KitchenRunItem['dehydrator'],
          origin,
          status: (b.status as KitchenRunItem['status']) || 'planned',
          assemblyNumber: b.assemblyNumber as string | undefined,
        });
      }
    } catch {
      /* ignore */
    }
  }

  return out;
}

function migratePurchasingPOs(): PurchaseOrderItem[] {
  const raw = localStorage.getItem(LEGACY_KEYS.purchasingPOs);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as Array<Record<string, unknown>>;
    const out: PurchaseOrderItem[] = [];
    for (const p of parsed) {
      const id = (p.id as string) || '';
      if (!id) continue;
      const deliveryRaw = p.deliveryDate as string | undefined;
      const deliveryISO = deliveryRaw
        ? (() => {
            const d = new Date(deliveryRaw);
            return isNaN(d.getTime()) ? '' : toLocalISODate(d);
          })()
        : '';
      out.push({
        kind: 'purchase_order',
        id,
        productCode: (p.componentCode as string) || '',
        productName: (p.componentName as string) || '',
        quantity: (p.quantity as number) || 0,
        lifecycle: 'draft',
        deliveryDate: deliveryISO,
        supplierId: (p.supplierId as string) || '',
        supplierName: (p.supplierName as string) || '',
      });
    }
    return out;
  } catch {
    return [];
  }
}

function migrateTransfers(): TransferItem[] {
  const raw = localStorage.getItem(LEGACY_KEYS.logisticsTransfers);
  // Also check the very-old kitchen transfer key (predates the canonical one).
  const oldKitchenRaw = localStorage.getItem('byron-kitchen-draft-transfers');
  const combined: Array<Record<string, unknown>> = [];
  for (const r of [raw, oldKitchenRaw]) {
    if (!r) continue;
    try {
      const arr = JSON.parse(r);
      if (Array.isArray(arr)) combined.push(...arr);
    } catch {
      /* ignore */
    }
  }
  if (oldKitchenRaw) localStorage.removeItem('byron-kitchen-draft-transfers');
  if (combined.length === 0) return [];

  const out: TransferItem[] = [];
  const seenIds = new Set<string>();
  for (const t of combined) {
    const id = (t.id as string) || '';
    if (!id || seenIds.has(id)) continue;
    seenIds.add(id);

    // Old kitchen format used `componentCode`/`componentName`/`date`.
    const transferRaw = (t.transferDate || t.date) as string | undefined;
    const needByRaw = (t.needByDate || t.transferDate || t.date) as string | undefined;
    const toISO = (s: string | undefined): string => {
      if (!s) return '';
      const d = new Date(s);
      return isNaN(d.getTime()) ? '' : toLocalISODate(d);
    };

    const status = (t.status as TransferItem['status']) || 'draft';
    out.push({
      kind: 'transfer',
      id,
      productCode: (t.productCode || t.componentCode) as string,
      productName: (t.productName || t.componentName) as string,
      quantity: (t.quantity as number) || 0,
      lifecycle: status === 'pushed' ? 'pushed' : 'draft',
      transferDate: toISO(transferRaw),
      needByDate: toISO(needByRaw),
      fromWarehouse: (t.fromWarehouse as string) || '',
      toWarehouse: ((t.toWarehouse as string) || 'Lundberg Storeroom'),
      status,
      reason: (t.reason as string) || '',
      linkedBatchId: t.linkedBatchId as string | undefined,
    });
  }
  return out;
}
