/**
 * Calendar mutations store — Phase 4d.1.
 *
 * Holds the user's per-activity overrides on top of the engine's computed
 * plan. Currently supports only `dismissed` (the user has opted out of an
 * activity). Future entries will support `rescheduledTo` (move to a
 * different working day) and `editedQuantity`.
 *
 * Persistence: localStorage under `byron-calendar-mutations-v1`. Keyed by
 * stable activity ID (`productCode|weekStart|orderInWeek`) so mutations
 * survive day-assignment changes between re-plans. If the engine reroutes
 * a product such that orderInWeek shifts (e.g. station change demotes its
 * position), the mutation becomes stale; consumers should treat unknown
 * stableIds as a soft warning rather than an error.
 *
 * Server safe: every entry point checks `typeof window` and degrades to a
 * no-op when running in Node (next.js server components, jest tests). No
 * imports of localStorage outside guarded paths.
 */

const STORAGE_KEY = 'byron-calendar-mutations-v1';

// ─── Types ───────────────────────────────────────────────────

export interface ActivityMutation {
  /** `productCode|weekStart|orderInWeek` — see `stableIdOf` in calendar-projection. */
  stableId: string;
  dismissed?: boolean;
  /**
   * If set, the activity has been moved to this date (must be a working day
   * in the same week as the activity's weekStart — caller validates).
   * `null`-able mutation slots aren't useful here; we just delete the field
   * to "clear" the reschedule.
   */
  rescheduledTo?: string;
  /** If set, the activity's quantity has been overridden by the user. */
  editedQuantity?: number;
  /** ISO timestamp of last write — useful for "stale mutation" warnings. */
  updatedAt: string;
}

export type MutationsMap = Record<string, ActivityMutation>;

// ─── Pure operations on a MutationsMap ──────────────────────

/** Returns a NEW map with the activity dismissed (or no-op if already dismissed). */
export function applyDismiss(
  map: MutationsMap,
  stableId: string,
): MutationsMap {
  const existing = map[stableId];
  if (existing?.dismissed === true) return map; // no change
  return {
    ...map,
    [stableId]: {
      ...(existing ?? { stableId, updatedAt: new Date().toISOString() }),
      stableId,
      dismissed: true,
      updatedAt: new Date().toISOString(),
    },
  };
}

/** Returns a NEW map with the activity un-dismissed. */
export function applyUndismiss(
  map: MutationsMap,
  stableId: string,
): MutationsMap {
  const existing = map[stableId];
  if (!existing) return map;
  // Drop the entry entirely if dismissed was the only field.
  const { dismissed: _dismissed, ...rest } = existing;
  if (Object.keys(rest).length <= 2 /* stableId + updatedAt */) {
    const out = { ...map };
    delete out[stableId];
    return out;
  }
  return {
    ...map,
    [stableId]: { ...rest, stableId, updatedAt: new Date().toISOString() },
  };
}

export function isDismissed(map: MutationsMap, stableId: string): boolean {
  return map[stableId]?.dismissed === true;
}

// ─── Reschedule + Edit ───────────────────────────────────────

/** Returns a NEW map with the activity rescheduled to `newDate`. Caller validates the date. */
export function applyReschedule(
  map: MutationsMap,
  stableId: string,
  newDate: string,
): MutationsMap {
  const existing = map[stableId];
  return {
    ...map,
    [stableId]: {
      ...(existing ?? { stableId, updatedAt: '' }),
      stableId,
      rescheduledTo: newDate,
      updatedAt: new Date().toISOString(),
    },
  };
}

/** Returns a NEW map without a reschedule (clears just that field). */
export function applyClearReschedule(
  map: MutationsMap,
  stableId: string,
): MutationsMap {
  const existing = map[stableId];
  if (!existing || existing.rescheduledTo === undefined) return map;
  const { rescheduledTo: _r, ...rest } = existing;
  // If only stableId+updatedAt remain, drop the entry.
  const remainingFields = Object.keys(rest).filter(
    (k) => k !== 'stableId' && k !== 'updatedAt',
  );
  if (remainingFields.length === 0) {
    const out = { ...map };
    delete out[stableId];
    return out;
  }
  return {
    ...map,
    [stableId]: { ...rest, stableId, updatedAt: new Date().toISOString() },
  };
}

export function rescheduledTo(
  map: MutationsMap,
  stableId: string,
): string | null {
  return map[stableId]?.rescheduledTo ?? null;
}

/** Returns a NEW map with the activity quantity edited. */
export function applyEditQuantity(
  map: MutationsMap,
  stableId: string,
  newQuantity: number,
): MutationsMap {
  if (!Number.isFinite(newQuantity) || newQuantity <= 0) return map;
  const existing = map[stableId];
  return {
    ...map,
    [stableId]: {
      ...(existing ?? { stableId, updatedAt: '' }),
      stableId,
      editedQuantity: newQuantity,
      updatedAt: new Date().toISOString(),
    },
  };
}

/** Returns a NEW map without a quantity override. */
export function applyClearEdit(
  map: MutationsMap,
  stableId: string,
): MutationsMap {
  const existing = map[stableId];
  if (!existing || existing.editedQuantity === undefined) return map;
  const { editedQuantity: _q, ...rest } = existing;
  const remainingFields = Object.keys(rest).filter(
    (k) => k !== 'stableId' && k !== 'updatedAt',
  );
  if (remainingFields.length === 0) {
    const out = { ...map };
    delete out[stableId];
    return out;
  }
  return {
    ...map,
    [stableId]: { ...rest, stableId, updatedAt: new Date().toISOString() },
  };
}

export function editedQuantityOf(
  map: MutationsMap,
  stableId: string,
): number | null {
  return map[stableId]?.editedQuantity ?? null;
}

// ─── Bulk operations ─────────────────────────────────────────

/** Drop all mutation entries whose stableIds are not in `validIds`. */
export function clearStale(
  map: MutationsMap,
  validIds: ReadonlySet<string>,
): MutationsMap {
  const out: MutationsMap = {};
  for (const [id, mut] of Object.entries(map)) {
    if (validIds.has(id)) out[id] = mut;
  }
  return out;
}

// ─── Storage I/O (localStorage-backed, server-safe) ─────────

/** Read mutations from localStorage. Returns empty map if storage unavailable or malformed. */
export function readMutationsFromStorage(): MutationsMap {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as MutationsMap;
    }
    return {};
  } catch {
    return {};
  }
}

export function writeMutationsToStorage(map: MutationsMap): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // localStorage can be disabled or full; swallow — mutations become
    // session-only, which is better than a render crash.
  }
}

/** Returns the stableIds in `map` that don't appear in `validIds` — useful for a "stale" warning. */
export function staleStableIds(
  map: MutationsMap,
  validIds: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  for (const id of Object.keys(map)) {
    if (!validIds.has(id)) out.push(id);
  }
  return out;
}
