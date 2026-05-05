'use client';

/**
 * Drop-in replacement for `useState` that persists its value to
 * `localStorage` under a stable key. Reads on mount, writes on every
 * change. SSR-safe: the initialiser runs client-side only, so the first
 * client render immediately reflects the persisted value without a flash.
 *
 * Why this exists: the planner pages (packaging, kitchen, purchasing)
 * have a lot of view/filter state that the operator expects to carry
 * across page navigation. Using plain `useState` resets them on every
 * remount; wrapping each one in this helper keeps the experience steady
 * without adding a full state-management layer.
 *
 * The `serialize` / `deserialize` options let you round-trip values that
 * plain JSON can't handle — most notably `Set`, which the packaging page
 * uses for product-group filter chips.
 */

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';

export interface PersistedStateOptions<T> {
  serialize?: (value: T) => string;
  deserialize?: (raw: string) => T;
}

export function usePersistedState<T>(
  key: string,
  initial: T,
  opts: PersistedStateOptions<T> = {},
): [T, Dispatch<SetStateAction<T>>] {
  const serialize = opts.serialize ?? (JSON.stringify as (v: T) => string);
  const deserialize = opts.deserialize ?? (JSON.parse as (s: string) => T);

  const [value, setValue] = useState<T>(() => {
    if (typeof window === 'undefined') return initial;
    try {
      const raw = window.localStorage.getItem(key);
      if (raw === null) return initial;
      return deserialize(raw);
    } catch {
      return initial;
    }
  });

  // Avoid an immediate write-back of the initial value on mount — only
  // persist when the operator actually changes something. Without this
  // guard, every page mount rewrites the key to its current content,
  // which is harmless but noisy (extra storage events cross-tab).
  const didMount = useRef(false);
  useEffect(() => {
    if (!didMount.current) {
      didMount.current = true;
      return;
    }
    try {
      window.localStorage.setItem(key, serialize(value));
    } catch {
      /* quota/serialization errors are non-fatal */
    }
  }, [key, value, serialize]);

  // Stable setter reference (React's `setState` is already stable, but
  // re-exporting through `useCallback` makes lint rules happier in
  // dependency arrays).
  const set = useCallback<Dispatch<SetStateAction<T>>>((v) => setValue(v), []);
  return [value, set];
}

// ─── Common serializers ─────────────────────────────────────────

/**
 * Serialize/deserialize a `Set<string>`. Use via
 * `usePersistedState<Set<string>>(key, new Set(), setStringSerializer)`.
 */
export const setStringSerializer: PersistedStateOptions<Set<string>> = {
  serialize: (v) => JSON.stringify([...v]),
  deserialize: (raw) => new Set(JSON.parse(raw) as string[]),
};
