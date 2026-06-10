/**
 * Capacity-data loader — Phase 3b of the 3-month planner.
 *
 * Parses `data/kitchen capacity and family plans.xlsx` into typed records
 * the optimiser and other engines consume. Pure parsing — no Date.now(),
 * no I/O beyond the buffer the caller provides.
 *
 * Supported sheets (see `docs/CAPACITY-DATA.md` for full schema):
 *   • Packaging Line Capacity → station defaults + changeover matrix
 *   • Kitchen capacities      → equipment counts + per-vessel sizes
 *   • Kitchen processes       → per-intermediate process recipe + station
 *   • family                  → SKU → family → extended-family map
 *   • BOMS                    → BOM rows (BOMComponent[])
 *
 * Resilient by design: load-time issues become `warnings`, not throws.
 * Throws only when the file itself can't be parsed (corrupt/missing sheet).
 *
 * Locked behaviours (from `docs/CAPACITY-DATA.md` §8):
 *   #1 unmapped extendedFamily ⇒ null in output
 *   #5 IBC capacity working constant: 300 kg
 *   #6 "dehydrate" in packing-equipment column ⇒ warning + drop value
 */

import * as XLSX from 'xlsx';
import { readFileSync } from 'fs';
import type {
  BOMComponent,
  ChangeoverCostMatrix,
  ChangeoverCostRow,
  ExtendedFamily,
  PackageSize,
  ProductMeta,
  Station,
} from './engine-io';
import type { FamilyMeta } from '@/lib/engine/bom-explode';

// ─── Constants ───────────────────────────────────────────────

/** Decision #5: working constant until the unit semantics are pinned down. */
export const IBC_CAPACITY_KG = 300;

const SHEETS = {
  packaging: 'Packaging Line Capacity',
  bom: 'BOMS',
  family: 'family',
  kitchenProcesses: 'Kitchen processes',
  kitchenCapacities: 'Kitchen capacities',
  wastageRates: 'wastage rates',
} as const;

const KNOWN_EXTENDED_FAMILIES: ReadonlySet<string> = new Set([
  'FAM Fungi',
  'FAM MF - Clusters',
  'FAM MF - Granola',
  'FAM MF - Munchies',
  'FAM MF - Nuts',
  'FAM MF - Tea',
]);

// ─── Public types ────────────────────────────────────────────

export interface StationDefaults {
  staffNeeded: number;
  hoursPerDay: number;
  unitsPerHour: number;
}

export interface KitchenIntermediate {
  productCode: string;
  productName: string;
  processSteps: string[];
  /** Primary packing station; null if "BULK" or unknown. */
  packingStation: Station | null;
  alternateStation: Station | null;
  maxSoakIbc: number | null;
  maxSoakTub: number | null;
  maxMixBowl: number | null;
  ovenCapacityPerDay: number | null;
  kgPerTray: number | null;
  dehydHours: number | null;
  humidity: number | null;
  /**
   * Recipe-level yield rate. A run scheduled for `quantity Q` produces
   * `Q × yieldRate` units of usable intermediate. `null` means no yield
   * data — callers should treat as 1.0 (no loss). Sourced from the
   * `yield` column of the `Kitchen processes` sheet.
   */
  yieldRate: number | null;
  /**
   * Preferred batch size (kg of INPUT material the recipe processes in
   * one run, e.g. one IBC, one bowl). The kitchen-run planner rounds the
   * required input quantity UP to a multiple of this — the team always
   * runs full batches rather than partials. `null` when no value in the
   * sheet (then no rounding is applied; runs are sized purely by demand).
   * Sourced from the `preffered batch size` column of `Kitchen processes`.
   */
  preferredBatchSize: number | null;
}

export type LoadWarning =
  | { kind: 'dehydrate_in_packing_equipment'; sheet: string; productCode: string; message: string }
  | { kind: 'unknown_extended_family'; sheet: string; productCode: string; value: string; message: string }
  | { kind: 'unknown_station'; sheet: string; productCode: string; value: string; message: string }
  | { kind: 'missing_sheet'; sheet: string; message: string }
  | { kind: 'malformed_row'; sheet: string; rowIndex: number; message: string }
  | {
      kind: 'wastage_combined_mismatch';
      parentProductCode: string;
      componentProductCode: string;
      bomsCombined: number;
      wastageCombined: number;
      message: string;
    };

/**
 * Phase 4l.10 — physical dehydrator equipment loaded from the
 * "Kitchen capacities" sheet. The planner treats total daily tray
 * availability across all dehydrators as a shared pool and enforces it
 * as a hard constraint on kitchen-run scheduling (= a recipe consuming
 * N trays for D days blocks N×D tray-day units of the daily 605-tray
 * budget).
 */
export interface Dehydrator {
  /** Equipment name, e.g. "Mamma", "Pappa", "Midgy". */
  name: string;
  /** Total physical tray slots (= trolleys × trays per trolley). */
  maxTraysPerLoad: number;
  /** Typical fill fraction (0-1). Top/bottom trays often skipped. */
  maxFill: number;
  /** Equipment-level effective tray cap = maxTraysPerLoad × maxFill, rounded. */
  effectiveTrays: number;
}

export interface DehydratorCapacity {
  /** All dehydrators in the kitchen, in sheet order. */
  dehydrators: Dehydrator[];
  /** Sum of `effectiveTrays` across all dehydrators — the shared daily pool. */
  totalEffectiveTrays: number;
}

export interface CapacityData {
  stations: Record<Station, StationDefaults>;
  changeoverMatrix: ChangeoverCostMatrix;
  intermediates: Map<string, KitchenIntermediate>;
  familyMap: Record<string, FamilyMeta>;
  productMetaBySku: Record<string, ProductMeta>;
  bom: BOMComponent[];
  /** Phase 4l.10 — physical dehydrator equipment (parsed from "Kitchen capacities"). */
  dehydratorCapacity: DehydratorCapacity;
  warnings: LoadWarning[];
}

// ─── Helpers ─────────────────────────────────────────────────

function normalise(s: unknown): string {
  return typeof s === 'string' ? s.trim().toLowerCase() : '';
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

/**
 * Map a packing-equipment cell value to a Station, or null if it's BULK /
 * empty / typo. Returns the warning kind alongside so the loader can
 * decide whether to record it.
 */
function parseStation(
  raw: unknown,
): { station: Station | null; warning: 'dehydrate_typo' | 'unknown' | null } {
  const s = normalise(raw);
  if (!s) return { station: null, warning: null };
  if (s === 'hand' || s === 'hand packing' || s === 'hand-packing') {
    return { station: 'hand-packing', warning: null };
  }
  if (s === 'elephant') return { station: 'elephant', warning: null };
  if (s === 'dust') return { station: 'dust', warning: null };
  if (s === 'bottlo') return { station: 'bottlo', warning: null };
  if (s === 'bulk') return { station: null, warning: null };
  // Decision #6: "dehydrate" is a process step, not a station.
  if (s === 'dehydrate' || s === 'dehyrdate' /* common misspelling guard */) {
    return { station: null, warning: 'dehydrate_typo' };
  }
  return { station: null, warning: 'unknown' };
}

/**
 * Infer package size from the SKU code suffix. Convention from the family
 * sheet: SM → SML, ME → MED, LG → LRG. Anything else → OTHER.
 */
export function inferPackageSize(productCode: string): PackageSize {
  const suffix = productCode.slice(-2).toUpperCase();
  if (suffix === 'SM') return 'SML';
  if (suffix === 'ME') return 'MED';
  if (suffix === 'LG') return 'LRG';
  return 'OTHER';
}

/**
 * Calendar-day duration of a kitchen production run for an intermediate.
 *
 * Derived from the `Kitchen processes` sheet:
 *   soak step (if present)         → 1 calendar day  (overnight soaking is the norm)
 *   dehyd hours / 24 (rounded up)  → N calendar days for dehydration
 *   cook step (if present)         → 1 calendar day
 *   mix step                       → assumed same-day with adjacent step
 *
 * Total is at least 1 day. The downstream caller adds one further day of
 * buffer between the finish date and any consumption (packaging or as input
 * to another recipe), per operator's "preferably one day before" rule.
 *
 * Scope notes / known approximations:
 *   - Some intermediates have soak in trays/tubs but the spreadsheet's
 *     soak/cook/dehyd hours aren't always populated. We default to 1
 *     calendar day for any process step with unknown duration.
 *   - We don't model parallel steps yet; a cooking + dehydrating product
 *     will count both days serially even if reality overlaps them.
 *   - Holidays and weekends aren't subtracted — `startDate` arithmetic
 *     uses calendar days, not working days. Fine until we model the
 *     kitchen working calendar (separate phase).
 */
export function productionDaysFor(intermediate: KitchenIntermediate): number {
  let days = 0;
  const steps = intermediate.processSteps.map((s) => s.toLowerCase().trim());
  if (steps.some((s) => s === 'soak' || s.includes('soak'))) days += 1;
  if (intermediate.dehydHours && intermediate.dehydHours > 0) {
    days += Math.ceil(intermediate.dehydHours / 24);
  }
  if (steps.some((s) => s === 'cook' || s.includes('cook'))) days += 1;
  return Math.max(1, days);
}

// ─── Kitchen-team minutes per intermediate (Phase 4l.8 / 4l.10) ───
// The 8-hour kitchen day (480 min) is shared across all kitchen runs that
// initiate, cook, or unload on a given day.
//
// Two regimes:
//
//   1. **Dehydrator recipes** (Phase 4l.10 — quantity-aware). Confirmed
//      with the kitchen team using IABR × 1200 as the reference point:
//        • soak-load        : 60 min for 1200 units → 0.05 min/unit
//        • dehydrator-load  : 180 min for 1200 units → 0.15 min/unit
//        • dehydrator-unload: 60 min for 1200 units → 0.05 min/unit
//        Total: 0.25 min/unit when the recipe has BOTH soak and dehyd;
//        0.20 min/unit when dehyd only (no soak-load).
//      All charged to the START day in the simplified model. Reality is
//      "load on start, unload on finish" — fine-grained spreading is a
//      future enhancement, the day-totals are conservative the way it is.
//
//   2. **Non-dehydrator recipes** (legacy fixed cost). We don't yet have
//      a quantity rate confirmed for cook-only or mix-only recipes, so
//      those keep the per-recipe fixed minutes:
//        soak (no dehyd)  → SOAK_SETUP_MINUTES (30) — load tubs/IBCs
//        cook             → COOK_MINUTES (240) — active stovetop/oven
//        no recognised    → KITCHEN_DEFAULT_MINUTES (240) — fallback
//
// Soaking & dehydrating run unattended after initiation; they don't
// re-charge the budget on the days the equipment is just running.

export const SOAK_SETUP_MINUTES = 30; // legacy: soak-only fixed cost
export const DEHYD_INIT_MINUTES = 15; // legacy — superseded by per-unit rate below
export const COOK_MINUTES = 240;
export const KITCHEN_DEFAULT_MINUTES = 240;

/**
 * Phase 4l.10 — dehydrator recipe rate constants (min per unit of intermediate).
 * Sum is 0.25 when the recipe has both soak and dehyd, 0.20 when dehyd only.
 */
export const DEHYD_SOAK_LOAD_PER_UNIT = 0.05;
export const DEHYD_LOAD_PER_UNIT = 0.15;
export const DEHYD_UNLOAD_PER_UNIT = 0.05;

export function kitchenTeamMinutesFor(
  intermediate: KitchenIntermediate,
  /**
   * Phase 4l.10: quantity in intermediate units (kg of INPUT material the
   * team weighs out). When omitted, falls back to a per-recipe estimate
   * using a nominal 250-unit batch — preserves the legacy "minutes per
   * recipe" semantics for callers that haven't been updated yet.
   */
  quantity: number = 250,
): number {
  const steps = intermediate.processSteps.map((s) => s.toLowerCase().trim());
  const hasSoak = steps.some((s) => s === 'soak' || s.includes('soak'));
  const hasDehyd = !!(intermediate.dehydHours && intermediate.dehydHours > 0);
  const hasCook = steps.some((s) => s === 'cook' || s.includes('cook'));

  // Dehydrator recipes scale with quantity.
  if (hasDehyd) {
    const perUnit =
      (hasSoak ? DEHYD_SOAK_LOAD_PER_UNIT : 0) +
      DEHYD_LOAD_PER_UNIT +
      DEHYD_UNLOAD_PER_UNIT;
    // Round to nearest minute; floor at 1 so a tiny batch still registers
    // some kitchen-team load (avoids 0-min chips that look free).
    return Math.max(1, Math.round(perUnit * quantity));
  }

  // Phase 4l.14 — cook & default recipes now scale LINEARLY with quantity
  // (kitchen-team confirmed: a half batch takes half as long). The legacy
  // flat-per-run cost made the FIFO split-and-redate inflate kitchen-team
  // load — a 270-unit chip split into a 252 + 18 shard was charged 240+240
  // instead of ~240 total — which over-saturated the kitchen budget while
  // the dehydrator sat idle. Calibrated so a FULL preferred batch costs the
  // legacy per-batch figure; sub-batch shards cost proportionally less.
  // Reference batch = preferredBatchSize when known, else a nominal 250.
  // NOTE: the per-unit cook rate is derived from the legacy flat figure, not
  // a measured rate like the dehydrator constants — recalibrate if the
  // kitchen team gives a confirmed min/unit.
  const refBatch =
    intermediate.preferredBatchSize && intermediate.preferredBatchSize > 0
      ? intermediate.preferredBatchSize
      : 250;
  if (hasCook) {
    return Math.max(1, Math.round((COOK_MINUTES / refBatch) * quantity));
  }
  // Soak-only (no dehyd): loading tubs/IBCs is a setup cost roughly
  // independent of batch size, so keep it flat.
  if (hasSoak) return SOAK_SETUP_MINUTES;
  return Math.max(1, Math.round((KITCHEN_DEFAULT_MINUTES / refBatch) * quantity));
}

/**
 * Subtract `days` calendar days from `iso` (YYYY-MM-DD) and return the
 * resulting ISO date. Local-time arithmetic to avoid UTC drift.
 */
export function shiftDateBackwards(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() - days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Clean the family-sheet description for display:
 *   - Strip leading "Label - " (or "Label -")
 *   - Strip parenthesised volume like " (600g)", " (1.5kg)", " (250 ml)"
 *   - Strip trailing "DISCONTINUED" tag
 *   - Collapse internal whitespace
 *
 * Examples:
 *   "Label - Chaga (600g)"                   → "Chaga"
 *   "Label - Almonds LRG (500g)"             → "Almonds LRG"
 *   "Label - Ginger Ground MED (240g) DISCONTINUED" → "Ginger Ground MED"
 *   "Label - Yummy Beans Intermediate"       → "Yummy Beans Intermediate"
 *
 * The raw description is preserved on `FamilyMeta.description`; this
 * cleaned form lands on `ProductMeta.productName` for UI rendering.
 */
export function cleanProductName(raw: string): string {
  let s = raw;
  s = s.replace(/^\s*Label\s*-\s*/i, '');
  // Parenthesised volume: "(600g)", "(1.5 kg)", "(250 ml)", "(1L)"
  s = s.replace(/\s*\(\s*[0-9.]+\s*(?:g|kg|ml|l)\s*\)\s*/gi, ' ');
  // Strip trailing DISCONTINUED first so the volume regex below can anchor
  // to the (now real) end-of-string.
  s = s.replace(/\s+DISCONTINUED\s*$/i, '');
  // Trailing non-parenthesised volume: "Organic 100g", "X 1.5kg"
  s = s.replace(/\s+[0-9.]+\s*(?:g|kg|ml|l)\s*$/i, '');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

function parseExtendedFamily(
  raw: unknown,
): { value: ExtendedFamily | null; unknown: string | null } {
  const s = asString(raw);
  if (!s) return { value: null, unknown: null };
  if (KNOWN_EXTENDED_FAMILIES.has(s)) return { value: s as ExtendedFamily, unknown: null };
  return { value: null, unknown: s };
}

// ─── Sheet parsers ───────────────────────────────────────────

/**
 * Parse the Packaging Line Capacity sheet. Returns station defaults and the
 * changeover matrix. The active block is rows 4–7 in the spreadsheet
 * (Hand packing / Elephant / Dust / Bottlo); subsequent rows are
 * product-specific overrides ("hand packing beetroot powder") which are
 * ignored here — the optimiser threads them in via `RateOverride[]`.
 */
function parsePackagingSheet(
  sheet: XLSX.WorkSheet,
): {
  stations: Record<Station, StationDefaults>;
  changeoverMatrix: ChangeoverCostMatrix;
} {
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '' });
  // Columns by position from row inspection (see CAPACITY-DATA.md §4):
  //   0: Station name, 2: staff, 4: hours/day, 5: units/hr,
  //   7: size switch, 8: family same-size, 9: extended family, 10: full clean.
  const stations: Partial<Record<Station, StationDefaults>> = {};
  const matrix: Partial<ChangeoverCostMatrix> = {};

  // Find rows whose first cell normalises to a known station name.
  const stationByLabel: Record<string, Station> = {
    'hand packing': 'hand-packing',
    elephant: 'elephant',
    dust: 'dust',
    bottlo: 'bottlo',
  };

  for (const row of rows) {
    const label = normalise(row[0]);
    const stationKey = stationByLabel[label];
    if (!stationKey) continue;
    const staff = asNumber(row[2]);
    const hours = asNumber(row[4]);
    const upHr = asNumber(row[5]);
    const sizeSwitch = asNumber(row[7]);
    const familySameSize = asNumber(row[8]);
    const extFam = asNumber(row[9]);
    const fullClean = asNumber(row[10]);
    if (staff !== null && hours !== null && upHr !== null) {
      stations[stationKey] = { staffNeeded: staff, hoursPerDay: hours, unitsPerHour: upHr };
    }
    if (
      sizeSwitch !== null &&
      familySameSize !== null &&
      extFam !== null &&
      fullClean !== null
    ) {
      const matrixRow: ChangeoverCostRow = {
        sizeSwitch,
        familySameSize,
        extendedFamily: extFam,
        fullClean,
      };
      matrix[stationKey] = matrixRow;
    }
  }

  return {
    stations: stations as Record<Station, StationDefaults>,
    changeoverMatrix: matrix as ChangeoverCostMatrix,
  };
}

function parseFamilySheet(
  sheet: XLSX.WorkSheet,
  warnings: LoadWarning[],
): Record<string, FamilyMeta> {
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '' });
  const out: Record<string, FamilyMeta> = {};
  // Column layout: 0=Assembled Product Code, 1=Description, 2=Family code, 3=Extended family.
  // Skip header row (index 0).
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const productCode = asString(row[0]);
    if (!productCode) continue;
    const description = asString(row[1]);
    const family = asString(row[2]);
    if (!family) {
      warnings.push({
        kind: 'malformed_row',
        sheet: SHEETS.family,
        rowIndex: i,
        message: `Row for ${productCode} has no family code`,
      });
      continue;
    }
    const ext = parseExtendedFamily(row[3]);
    if (ext.unknown) {
      warnings.push({
        kind: 'unknown_extended_family',
        sheet: SHEETS.family,
        productCode,
        value: ext.unknown,
        message: `Unknown extended family "${ext.unknown}" for ${productCode}; treating as null (full-clean per decision #1).`,
      });
    }
    out[productCode] = {
      family,
      extendedFamily: ext.value,
      description: description || undefined,
    };
  }
  return out;
}

function parseKitchenProcessesSheet(
  sheet: XLSX.WorkSheet,
  warnings: LoadWarning[],
): Map<string, KitchenIntermediate> {
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '' });
  const out = new Map<string, KitchenIntermediate>();
  // Column layout (index → column):
  //   0 Product, 1 product name, 2-4 process steps,
  //   5 PACKING EQUIPMENT Alternate, 6 PACKING EQUIPMENT (primary),
  //   7 max /soak ibc, 8 max soak /tub, 9 max mix /bowl,
  //   10 oven capacity/day, 11 kilos per tray, 12 dehyd hours, 13 humidity,
  //   14 yield, 15 preferred batch size (kg INPUT per run, Phase 4l.10).
  // Phase 4l.12: the live spreadsheet has "PACKING EQUIPMENT Alternate"
  // in col F (idx 5) and "PACKING EQUIPMENT" in col G (idx 6). The parser
  // previously had these swapped — fixed here so the primary station
  // is read from the column actually labelled "PACKING EQUIPMENT".
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const code = asString(row[0]);
    if (!code) continue;
    const steps: string[] = [];
    for (const idx of [2, 3, 4]) {
      const step = asString(row[idx]);
      if (step) steps.push(step.toLowerCase());
    }
    const primary = parseStation(row[6]);
    if (primary.warning === 'dehydrate_typo') {
      warnings.push({
        kind: 'dehydrate_in_packing_equipment',
        sheet: SHEETS.kitchenProcesses,
        productCode: code,
        message: `"dehydrate" in PACKING EQUIPMENT column for ${code} is a process step, not a station; dropping (decision #6).`,
      });
    } else if (primary.warning === 'unknown') {
      warnings.push({
        kind: 'unknown_station',
        sheet: SHEETS.kitchenProcesses,
        productCode: code,
        value: asString(row[6]),
        message: `Unknown packing-station value "${asString(row[6])}" for ${code}; treating as no primary station.`,
      });
    }
    const alt = parseStation(row[5]);
    if (alt.warning === 'dehydrate_typo') {
      warnings.push({
        kind: 'dehydrate_in_packing_equipment',
        sheet: SHEETS.kitchenProcesses,
        productCode: code,
        message: `"dehydrate" in PACKING EQUIPMENT Alternate column for ${code}; dropping.`,
      });
    }
    out.set(code, {
      productCode: code,
      productName: asString(row[1]),
      processSteps: steps,
      packingStation: primary.station,
      alternateStation: alt.station,
      maxSoakIbc: asNumber(row[7]),
      maxSoakTub: asNumber(row[8]),
      maxMixBowl: asNumber(row[9]),
      ovenCapacityPerDay: asNumber(row[10]),
      kgPerTray: asNumber(row[11]),
      dehydHours: asNumber(row[12]),
      humidity: asNumber(row[13]),
      yieldRate: asNumber(row[14]),
      preferredBatchSize: asNumber(row[15]),
    });
  }
  return out;
}

/** Tolerance for matching BOMS "Quantity + Wastage" against wastage-tab "clean + wastage". */
const WASTAGE_MISMATCH_TOLERANCE = 0.001;

function parseBomsSheet(
  sheet: XLSX.WorkSheet,
  wastageByEdge: Map<string, { clean: number; wastage: number }>,
  warnings: LoadWarning[],
): BOMComponent[] {
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '' });
  // Column layout:
  //   0 Assembled Product Code (= parent), 1 Component Product Code,
  //   2 description (component), 3 Product Group, 4 Quantity + Wastage, 5 SOH,
  //   6 Family, 7 Extended Family.
  const out: BOMComponent[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const parent = asString(row[0]);
    const code = asString(row[1]);
    if (!parent || !code) continue;
    const qty = asNumber(row[4]);
    if (qty === null) continue;
    const split = wastageByEdge.get(`${parent}|${code}`);

    // When both sheets have an entry, their combined values should agree.
    // When they don't (data drift between the operator-maintained BOMS and
    // the wastage tab), trust BOMS as the canonical quantity but rescale
    // the split to match — preserves the wastage proportion while keeping
    // the engine's plan consistent with the BOMS sheet.
    let cleanQuantityPerParent: number | undefined;
    let wastageQuantityPerParent: number | undefined;
    if (split) {
      const wastageCombined = split.clean + split.wastage;
      if (Math.abs(wastageCombined - qty) > WASTAGE_MISMATCH_TOLERANCE) {
        warnings.push({
          kind: 'wastage_combined_mismatch',
          parentProductCode: parent,
          componentProductCode: code,
          bomsCombined: qty,
          wastageCombined,
          message: `BOMS sheet says ${qty} for ${parent}/${code}; wastage tab says ${split.clean} + ${split.wastage} = ${wastageCombined}. Rescaling split to match BOMS.`,
        });
        // Rescale: keep the wastage tab's PROPORTION but anchor to BOMS total.
        if (wastageCombined > 0) {
          cleanQuantityPerParent = (split.clean / wastageCombined) * qty;
          wastageQuantityPerParent = (split.wastage / wastageCombined) * qty;
        }
      } else {
        cleanQuantityPerParent = split.clean;
        wastageQuantityPerParent = split.wastage;
      }
    }

    out.push({
      parentProductCode: parent,
      productCode: code,
      productName: asString(row[2]) || code,
      quantityPerParent: qty,
      cleanQuantityPerParent,
      wastageQuantityPerParent,
      level: 1, // sheet doesn't carry depth; exploder computes path-based depth
    });
  }
  return out;
}

/**
 * Parse the `wastage rates` sheet into a Map keyed by `parent|component`.
 *
 * Sheet layout:
 *   0 SKU, 1 Assembled Product Code, 2 Component Product Code, 3 Quantity, 4 Wastage Quantity
 *
 * The SKU column is populated on every row (acts as the parent code), while
 * the Assembled Product Code column is only populated on the first row of
 * each parent. We use the SKU column as the canonical parent reference.
 *
 * The `Quantity` column here is the CLEAN quantity (before wastage); add the
 * Wastage Quantity to get the combined figure that lives in the BOMS sheet.
 */
function parseWastageRatesSheet(
  sheet: XLSX.WorkSheet,
  warnings: LoadWarning[],
): Map<string, { clean: number; wastage: number }> {
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '' });
  const out = new Map<string, { clean: number; wastage: number }>();
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const parent = asString(row[0]); // SKU column = parent
    const component = asString(row[2]);
    if (!parent || !component) continue;
    const clean = asNumber(row[3]);
    const wastage = asNumber(row[4]);
    if (clean === null) {
      warnings.push({
        kind: 'malformed_row',
        sheet: SHEETS.wastageRates,
        rowIndex: i,
        message: `Wastage row for ${parent}/${component} has no quantity`,
      });
      continue;
    }
    // Wastage defaults to 0 when the cell is blank — that's the common case
    // (only ~17 of 2568 rows carry non-zero wastage).
    out.set(`${parent}|${component}`, { clean, wastage: wastage ?? 0 });
  }
  return out;
}

// ─── Public API ──────────────────────────────────────────────

/**
 * Load capacity data from a path on disk. Convenience wrapper for the API
 * route's typical use case. Tests use `loadCapacityDataFromBuffer` directly
 * to keep the file-system seam at one place.
 */
export function loadCapacityDataFromPath(filePath: string): CapacityData {
  const buf = readFileSync(filePath);
  return loadCapacityDataFromBuffer(buf);
}

/**
 * Load capacity data from a buffer. Throws only if the workbook is corrupt
 * or a required sheet is missing entirely. All other issues become
 * `warnings`.
 */
export function loadCapacityDataFromBuffer(buffer: Buffer | ArrayBuffer): CapacityData {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const warnings: LoadWarning[] = [];

  function getSheet(name: string): XLSX.WorkSheet {
    const sheet = wb.Sheets[name];
    if (!sheet) {
      throw new Error(`Capacity data: required sheet "${name}" not found in workbook.`);
    }
    return sheet;
  }

  const { stations, changeoverMatrix } = parsePackagingSheet(getSheet(SHEETS.packaging));
  const familyMap = parseFamilySheet(getSheet(SHEETS.family), warnings);
  const intermediates = parseKitchenProcessesSheet(
    getSheet(SHEETS.kitchenProcesses),
    warnings,
  );
  // Wastage tab is optional; not having it means BOM rows carry only the
  // combined figure (clean unknown). When present, every BOM row that has
  // an entry in the map gets its split attached.
  const wastageByEdge = wb.Sheets[SHEETS.wastageRates]
    ? parseWastageRatesSheet(wb.Sheets[SHEETS.wastageRates], warnings)
    : new Map();
  const bom = parseBomsSheet(getSheet(SHEETS.bom), wastageByEdge, warnings);

  // Phase 4l.10 — physical dehydrator equipment. The "Kitchen capacities"
  // sheet has a small header block listing each dehydrator (Mamma/Pappa/
  // Midgy) with `max trays per load × max fill = effective trays`. Sum
  // across all of them = the shared daily tray pool the planner enforces
  // when scheduling dehydration recipes.
  const dehydratorCapacity = wb.Sheets[SHEETS.kitchenCapacities]
    ? parseKitchenCapacitiesSheet(wb.Sheets[SHEETS.kitchenCapacities])
    : { dehydrators: [], totalEffectiveTrays: 0 };

  // Derive ProductMeta for every SKU in the family sheet. Station comes
  // from the intermediate's primary packing station (resolved via the
  // family code, which IS the intermediate code in the BOMS schema).
  const productMetaBySku: Record<string, ProductMeta> = {};
  for (const [productCode, fam] of Object.entries(familyMap)) {
    const intermediate = intermediates.get(fam.family);
    const station: Station = intermediate?.packingStation ?? 'hand-packing';
    const stationDefaults = stations[station];
    productMetaBySku[productCode] = {
      productCode,
      productName: fam.description ? cleanProductName(fam.description) : '',
      family: fam.family,
      extendedFamily: fam.extendedFamily as ExtendedFamily | null,
      packageSize: inferPackageSize(productCode),
      station,
      rateUnitsPerHour: stationDefaults?.unitsPerHour ?? 0,
    };
  }

  return {
    stations,
    changeoverMatrix,
    intermediates,
    familyMap,
    productMetaBySku,
    bom,
    dehydratorCapacity,
    warnings,
  };
}

/**
 * Phase 4l.10 — parse the "Kitchen capacities" sheet's dehydrator block.
 *
 * Expected layout:
 *   row 0: 'EQUIPMENT'  (label)
 *   row 1: header row → 'Dehydrators' | 'Max number of trays per load' | 'Trays per trolley' | 'trolleys' | 'Max fill'
 *   rows 2..K-1: one row per dehydrator until a blank row, e.g.
 *     'Mamma' | 196 | 70 | 4 | 0.7
 *     'Pappa' | 378 | 70 | 6 | 0.9
 *     'Midgy' | 160 | 50 | 4 | 0.8
 *   (blank row, then other equipment blocks for IBCs / bowls / etc. that
 *    the planner doesn't currently enforce)
 *
 * Defensive: stops parsing at the first row whose first column isn't a
 * non-empty string. Returns an empty `dehydrators` list if the sheet is
 * missing or the format doesn't match — the planner then degrades to "no
 * dehydrator constraint".
 */
function parseKitchenCapacitiesSheet(
  sheet: XLSX.WorkSheet,
): DehydratorCapacity {
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '' });
  const dehydrators: Dehydrator[] = [];
  // Find the header row containing "Dehydrators" in column 0.
  let headerRow = -1;
  for (let i = 0; i < Math.min(10, rows.length); i++) {
    const r = rows[i];
    if (
      typeof r?.[0] === 'string' &&
      r[0].toString().trim().toLowerCase().startsWith('dehydrator')
    ) {
      headerRow = i;
      break;
    }
  }
  if (headerRow === -1) {
    return { dehydrators: [], totalEffectiveTrays: 0 };
  }
  // Rows after the header until a blank/break row.
  for (let i = headerRow + 1; i < rows.length; i++) {
    const r = rows[i];
    const name = asString(r[0]);
    if (!name) break; // blank row ends the dehydrator block
    const maxTraysPerLoad = asNumber(r[1]) ?? 0;
    const maxFill = asNumber(r[4]) ?? 1;
    if (maxTraysPerLoad <= 0) continue;
    const effectiveTrays = Math.round(maxTraysPerLoad * maxFill);
    dehydrators.push({ name, maxTraysPerLoad, maxFill, effectiveTrays });
  }
  const totalEffectiveTrays = dehydrators.reduce(
    (s, d) => s + d.effectiveTrays,
    0,
  );
  return { dehydrators, totalEffectiveTrays };
}
