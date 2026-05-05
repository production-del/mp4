/**
 * Global priority-settings store.
 *
 * Thresholds and preferences that shape how `buildPriorityProposals` behaves.
 * Lives on its own localStorage key rather than piggybacking on the packaging
 * config so the Settings page can own this concern independently of the
 * Packaging Plan page.
 *
 * Defaults are conservative — priority proposes only when available stock is
 * truly negative, and the operator is always kept in the loop.
 */

const STORE_KEY = 'byron-priority-settings-v1';

export interface PrioritySettings {
  /**
   * Propose a priority run when `availableStock <= this`. Default `0` means
   * "only when already over-allocated". Operators who want early-warning
   * behaviour can set this to e.g. `10` to propose when stock drops below
   * that buffer, even without a hard backorder.
   */
  deficitThreshold: number;
  /**
   * Preferred warehouses (in order) to source the transferred intermediate
   * from. The first match with sufficient SOH wins. MF Packaging is the
   * destination and is excluded.
   */
  transferSourcePreference: string[];
  /**
   * Always require explicit operator approval. `false` is reserved for a
   * future autopilot pass and has no effect in v1.
   */
  requireApproval: boolean;
}

interface StoreShape {
  version: 1;
  settings: PrioritySettings;
}

const DEFAULTS: PrioritySettings = {
  deficitThreshold: 0,
  transferSourcePreference: ['Lundberg Storeroom', 'MF Operations', 'TBC', 'TBC Height'],
  requireApproval: true,
};

function emptyStore(): StoreShape {
  return { version: 1, settings: { ...DEFAULTS } };
}

function readRaw(): StoreShape {
  if (typeof window === 'undefined') return emptyStore();
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    if (!raw) return emptyStore();
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== 1 || typeof parsed.settings !== 'object') {
      return emptyStore();
    }
    // Defensive merge: if a field is missing (added later), fall back to default.
    return {
      version: 1,
      settings: { ...DEFAULTS, ...parsed.settings },
    };
  } catch {
    return emptyStore();
  }
}

function writeRaw(store: StoreShape): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch {
    /* ignore */
  }
}

// ─── Public API ─────────────────────────────────────────────

/** Read the current settings (merged with defaults for any missing fields). */
export function readPrioritySettings(): PrioritySettings {
  return readRaw().settings;
}

/** Patch one or more fields. Missing fields retain their current values. */
export function updatePrioritySettings(patch: Partial<PrioritySettings>): void {
  const current = readRaw().settings;
  writeRaw({ version: 1, settings: { ...current, ...patch } });
}

/** Reset to bundled defaults (Settings page nuclear option). */
export function resetPrioritySettings(): void {
  writeRaw(emptyStore());
}
