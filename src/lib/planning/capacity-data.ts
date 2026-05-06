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
}

export type LoadWarning =
  | { kind: 'dehydrate_in_packing_equipment'; sheet: string; productCode: string; message: string }
  | { kind: 'unknown_extended_family'; sheet: string; productCode: string; value: string; message: string }
  | { kind: 'unknown_station'; sheet: string; productCode: string; value: string; message: string }
  | { kind: 'missing_sheet'; sheet: string; message: string }
  | { kind: 'malformed_row'; sheet: string; rowIndex: number; message: string };

export interface CapacityData {
  stations: Record<Station, StationDefaults>;
  changeoverMatrix: ChangeoverCostMatrix;
  intermediates: Map<string, KitchenIntermediate>;
  familyMap: Record<string, FamilyMeta>;
  productMetaBySku: Record<string, ProductMeta>;
  bom: BOMComponent[];
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
    out[productCode] = { family, extendedFamily: ext.value };
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
  //   5 PACKING EQUIPMENT, 6 PACKING EQUIPMENT Alternate,
  //   7 max /soak ibc, 8 max soak /tub, 9 max mix /bowl,
  //   10 oven capacity/day, 11 kilos per tray, 12 dehyd hours, 13 humidity.
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const code = asString(row[0]);
    if (!code) continue;
    const steps: string[] = [];
    for (const idx of [2, 3, 4]) {
      const step = asString(row[idx]);
      if (step) steps.push(step.toLowerCase());
    }
    const primary = parseStation(row[5]);
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
        value: asString(row[5]),
        message: `Unknown packing-station value "${asString(row[5])}" for ${code}; treating as no primary station.`,
      });
    }
    const alt = parseStation(row[6]);
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
    });
  }
  return out;
}

function parseBomsSheet(sheet: XLSX.WorkSheet): BOMComponent[] {
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
    out.push({
      parentProductCode: parent,
      productCode: code,
      productName: asString(row[2]) || code,
      quantityPerParent: qty,
      level: 1, // sheet doesn't carry depth; exploder computes path-based depth
    });
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
  const bom = parseBomsSheet(getSheet(SHEETS.bom));

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
      productName: '', // family sheet description is in row[1] but not threaded here; populated by caller if needed
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
    warnings,
  };
}
