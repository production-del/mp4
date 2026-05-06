/**
 * Mock data for Byron Co-op kitchen calendar planner
 * Realistic intermediates and components for Mindful Foods production
 *
 * Used as fallback when NEXT_PUBLIC_USE_MOCK_DATA=true or when
 * Unleashed API calls fail. Live data is fetched by useKitchenData hook.
 */

export interface IntermediateData {
  name: string;
  code: string;
  level: 'top' | 'secondary';
  batchSize: number;
  equipment: 'oven' | 'dehydrator' | 'mixer';
  /** Calendar days the batch occupies its equipment lane from start. Defaults to 1 when unset. */
  durationDays?: number;
  /** Calendar days of prep work required before the batch starts. Defaults to 0. */
  prepDays?: number;
  /** Free-form prep instructions shown on the batch detail card. */
  prepNotes?: string;
  demand: number;
  deadline: string; // YYYY-MM-DD
  requires: string[]; // Codes of required intermediates
  components: Record<string, number>; // Component code -> quantity per batch
  assemblyId?: string;
  assemblyNumber?: string;
  createdOn?: string; // ISO date — when the assembly was created in Unleashed
}

export interface ComponentData {
  code: string;
  name: string;
}

export const MOCK_INTERMEDIATES: Record<string, IntermediateData> = {
  IGC: {
    name: 'Cacao Granola',
    code: 'IGC',
    level: 'top',
    batchSize: 270,
    equipment: 'oven',
    demand: 1080,
    deadline: '2026-04-20',
    requires: ['IAA'],
    components: { IAA: 0.15, CACPOW: 0.08, COCOSUG: 0.12, ABCTCO: 0.1 },
  },
  IMM: {
    name: 'Maple Munchies',
    code: 'IMM',
    level: 'top',
    batchSize: 500,
    equipment: 'oven',
    demand: 1000,
    deadline: '2026-04-17',
    requires: [],
    components: { BOBKGF: 0.2, RAWCASH: 0.15 },
  },
  IGE: {
    name: 'Eros Granola',
    code: 'IGE',
    level: 'top',
    batchSize: 225,
    equipment: 'oven',
    demand: 450,
    deadline: '2026-04-24',
    requires: ['IAA'],
    components: { IAA: 0.12, ABCTCO: 0.08 },
  },
  IAW: {
    name: 'Walnuts Activated',
    code: 'IAW',
    level: 'top',
    batchSize: 450,
    equipment: 'dehydrator',
    demand: 900,
    deadline: '2026-04-15',
    requires: [],
    components: { RAWWALNUT: 1.05 },
  },
  IABR: {
    name: 'Brazil Nuts Activated',
    code: 'IABR',
    level: 'top',
    batchSize: 400,
    equipment: 'dehydrator',
    demand: 800,
    deadline: '2026-04-16',
    requires: [],
    components: { ABBNR: 1.05 },
  },
  ICC: {
    name: 'Choc Clusters',
    code: 'ICC',
    level: 'top',
    batchSize: 300,
    equipment: 'mixer',
    demand: 300,
    deadline: '2026-04-22',
    requires: [],
    components: { CACPOW: 0.15, COCOSUG: 0.2 },
  },
  IAM: {
    name: 'Mixed Nuts Activated',
    code: 'IAM',
    level: 'top',
    batchSize: 500,
    equipment: 'dehydrator',
    demand: 1000,
    deadline: '2026-04-18',
    requires: [],
    components: {
      RAWWALNUT: 0.25,
      ABBNR: 0.25,
      RAWCASH: 0.25,
      ABARNPO: 0.25,
    },
  },
  IAA: {
    name: 'Almonds Activated',
    code: 'IAA',
    level: 'secondary',
    batchSize: 500,
    equipment: 'dehydrator',
    demand: 750,
    deadline: '2026-04-18',
    requires: [],
    components: { ABARNPO: 1.05 },
  },
  IAB: {
    name: 'Buckwheat Activated',
    code: 'IAB',
    level: 'secondary',
    batchSize: 50,
    equipment: 'dehydrator',
    demand: 200,
    deadline: '2026-04-20',
    requires: [],
    components: { BOBKGF: 1.1 },
  },
};

export const MOCK_COMPONENT_SOH: Record<string, number> = {
  ABARNPO: 501,
  RAWWALNUT: 2200,
  ABBNR: 2921,
  RAWCASH: 2601,
  BOBKGF: 410,
  CACPOW: 199,
  COCOSUG: 258,
  ABCTCO: 856,
  IAA: 373,
  IAB: 207,
  IGC: 5,
  IMM: 200,
  IGE: 0,
  IAW: 451,
  IABR: 421,
  ICC: 0,
  IAM: 246,
};

export const MOCK_COMPONENTS: Record<string, ComponentData> = {
  ABARNPO: { code: 'ABARNPO', name: 'Almonds (Raw)' },
  RAWWALNUT: { code: 'RAWWALNUT', name: 'Walnuts (Raw)' },
  ABBNR: { code: 'ABBNR', name: 'Brazil Nuts (Raw)' },
  RAWCASH: { code: 'RAWCASH', name: 'Cashews (Raw)' },
  BOBKGF: { code: 'BOBKGF', name: 'Buckwheat (Whole)' },
  CACPOW: { code: 'CACPOW', name: 'Cacao Powder' },
  COCOSUG: { code: 'COCOSUG', name: 'Coconut Sugar' },
  ABCTCO: { code: 'ABCTCO', name: 'Almond Butter' },
  IAA: { code: 'IAA', name: 'Almonds Activated' },
  IAB: { code: 'IAB', name: 'Buckwheat Activated' },
  IGC: { code: 'IGC', name: 'Cacao Granola' },
  IMM: { code: 'IMM', name: 'Maple Munchies' },
  IGE: { code: 'IGE', name: 'Eros Granola' },
  IAW: { code: 'IAW', name: 'Walnuts Activated' },
  IABR: { code: 'IABR', name: 'Brazil Nuts Activated' },
  ICC: { code: 'ICC', name: 'Choc Clusters' },
  IAM: { code: 'IAM', name: 'Mixed Nuts Activated' },
};
