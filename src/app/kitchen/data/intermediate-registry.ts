/**
 * Intermediate Registry — local process/recipe metadata
 *
 * This is domain knowledge that does NOT come from Unleashed:
 * batch sizes, equipment assignments, dependency chains, and levels.
 *
 * Inventory data (SOH, demand, component ratios) comes from Unleashed.
 * The useKitchenData hook merges these two sources.
 */

export interface IntermediateConfig {
  code: string;
  name: string;
  level: 'top' | 'secondary';
  batchSize: number; // kg per batch
  /**
   * What kind of kitchen equipment this blend runs on. Dehydrator blends
   * can land in any of the three dehydrator lanes on the calendar — the
   * operator drags them into a specific unit at execution time. Oven and
   * mixer are single-resource types and don't have lanes.
   */
  equipment: 'oven' | 'dehydrator' | 'mixer';
  requires: string[]; // codes of intermediates that must be produced first
  /**
   * Number of calendar days the batch occupies its equipment (e.g., a
   * dehydrator lane) from start. 1 = same-day. 2 = starts today, done
   * tomorrow. Undefined is treated as 1 by the calendar. Calendar days
   * (not working days) because dehydrators run continuously.
   */
  durationDays?: number;
  /**
   * Number of days of prep required *before* the batch starts (e.g. soaking
   * overnight). Surfaced on the batch detail card so operators know when
   * prep has to happen. Not currently rendered as its own calendar block.
   */
  prepDays?: number;
  /**
   * Free-form prep instructions (e.g. "Soak overnight in filtered water,
   * rinse before loading"). Shown verbatim on the batch detail card.
   */
  prepNotes?: string;
}

/**
 * A named physical resource (dehydrator unit, oven, mixer, …) that batches
 * run on. The calendar renders one lane per resource within each day cell.
 * `equipment` is a category hint used for the dot-colour legend.
 */
export interface KitchenResource {
  id: string;
  label: string;
  equipment: 'oven' | 'dehydrator' | 'mixer';
}

export const INTERMEDIATE_REGISTRY: Record<string, IntermediateConfig> = {
  IGC: {
    code: 'IGC',
    name: 'Cacao Granola',
    level: 'top',
    batchSize: 270,
    equipment: 'oven',
    requires: ['IAA'],
  },
  IMM: {
    code: 'IMM',
    name: 'Maple Munchies',
    level: 'top',
    batchSize: 500,
    equipment: 'oven',
    requires: [],
  },
  IGE: {
    code: 'IGE',
    name: 'Eros Granola',
    level: 'top',
    batchSize: 225,
    equipment: 'oven',
    requires: ['IAA'],
  },
  IAW: {
    code: 'IAW',
    name: 'Walnuts Activated',
    level: 'top',
    batchSize: 450,
    equipment: 'dehydrator',
    requires: [],
  },
  IABR: {
    code: 'IABR',
    name: 'Brazil Nuts Activated',
    level: 'top',
    batchSize: 400,
    equipment: 'dehydrator',
    requires: [],
    durationDays: 2,
    prepDays: 1,
    prepNotes: 'Soak brazil nuts overnight in filtered water. Rinse thoroughly before loading into the dehydrator.',
  },
  ICC: {
    code: 'ICC',
    name: 'Choc Clusters',
    level: 'top',
    batchSize: 300,
    equipment: 'mixer',
    requires: [],
  },
  IAM: {
    code: 'IAM',
    name: 'Mixed Nuts Activated',
    level: 'top',
    batchSize: 500,
    equipment: 'dehydrator',
    requires: [],
  },
  IAA: {
    code: 'IAA',
    name: 'Almonds Activated',
    level: 'secondary',
    batchSize: 500,
    equipment: 'dehydrator',
    requires: [],
  },
  IAB: {
    code: 'IAB',
    name: 'Buckwheat Activated',
    level: 'secondary',
    batchSize: 50,
    equipment: 'dehydrator',
    requires: [],
  },
};

/**
 * Default set of kitchen resources (physical lanes on the calendar).
 *
 * Only dehydrators need multi-unit lane tracking — the kitchen runs three
 * dehydrators in parallel (Midgy, Mama, Papa) and conflicts matter per-unit.
 * Ovens and mixers are single resources that process batches sequentially,
 * so their batches appear in the main cell area without a lane.
 *
 * The `equipment` field is reserved in the data model for future extension
 * (e.g., multiple ovens) but the v1 Kitchen Calendar only renders lanes for
 * `equipment === 'dehydrator'` resources. Users can extend, rename, or remove
 * units via `/kitchen/parameters`.
 */
export const DEFAULT_KITCHEN_RESOURCES: KitchenResource[] = [
  { id: 'midgy', label: 'Midgy', equipment: 'dehydrator' },
  { id: 'mama', label: 'Mama', equipment: 'dehydrator' },
  { id: 'papa', label: 'Papa', equipment: 'dehydrator' },
];

// ---- Planning constants ----

// Packaging deadlines are now sourced dynamically from the Packaging Calendar page.
// The packaging planner publishes typed `Demand[]` via `DemandStore` (see
// `src/lib/planning/demand.ts`); kitchen's `useConfig` subscribes on mount and
// via a storage event listener. This empty array is the fallback when no
// packaging plan data exists.
export const PACKAGING_DEADLINES: { date: string; label: string }[] = [];

export const BLOCK_START = new Date('2026-04-06');
export const BLOCK_END = new Date('2026-05-01');

// ---- Presentation constants ----

export const EQUIPMENT_COLORS = {
  oven: { bg: 'var(--equip-oven)', name: 'Oven' },
  dehydrator: { bg: 'var(--equip-dehydrator)', name: 'Dehydrator' },
  mixer: { bg: 'var(--equip-mixer)', name: 'Mixer' },
};

export const FEASIBILITY_COLORS = {
  green: { bg: 'var(--success-light)', border: 'var(--success)', name: 'Feasible' },
  amber: { bg: 'var(--warning-light)', border: 'var(--warning)', name: 'At Risk' },
  red: { bg: 'var(--danger-light)', border: 'var(--danger)', name: 'Infeasible' },
};
