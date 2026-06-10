'use client';

/**
 * CalendarApp — Phase 4a/b/c/d client component.
 *
 * Reads pre-computed projection data from the server component and renders:
 *   - A 12-week month-by-month calendar grid with activity chips per day
 *   - Per-station layer toggles (left rail) with peak-load badges
 *   - Coverage / changeover summary KPIs (left rail)
 *   - Activity drawer (right rail) with Dismiss/Undismiss
 *   - Persistent dismissals overlaid on the engine output
 *
 * Mutation model: the server runs the engine, the client applies a
 * localStorage-backed mutations layer on top (`calendar-mutations.ts`).
 * Dismissed activities render with reduced opacity and don't count
 * toward day-load. A "Show dismissed" toggle in the left rail hides
 * them entirely.
 */

import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from 'react';
import { useRouter } from 'next/navigation';
import type {
  CalendarActivity,
  DayLoadSummary,
} from '@/lib/planning/calendar-projection';
import {
  applyDismiss,
  applyUndismiss,
  isDismissed,
  applyReschedule,
  applyClearReschedule,
  rescheduledTo,
  applyEditQuantity,
  applyClearEdit,
  editedQuantityOf,
  applyEditLeadTime,
  applyClearLeadTime,
  editedLeadTimeDaysOf,
  applyEditStation,
  applyClearStation,
  editedStationOf,
  leadTimeOverridesByCode,
  clearStale,
  staleStableIds,
  pruneStaleReschedules,
  readMutationsFromStorage,
  writeMutationsToStorage,
  applyMutationsToActivities,
  type MutationsMap,
} from '@/lib/planning/calendar-mutations';
import { projectPoChips } from '@/lib/planning/po-projection';
import {
  buildPoCsv,
  buildPackagingCsv,
  buildKitchenCsv,
} from '@/lib/planning/report-csv';
import {
  buildPoHtml,
  buildPackagingHtml,
  buildKitchenHtml,
} from '@/lib/planning/report-html';
import {
  detectScheduleConflicts,
  type ScheduleConflict,
} from '@/lib/engine/schedule-conflicts';
import type {
  RawMaterialShortage,
  PurchaseRequirement,
} from '@/lib/engine/raw-material-demand';
import {
  resolveScheduleConflicts,
  type ResolveStrategy,
} from '@/lib/engine/resolve-conflicts';
import type {
  ChangeoverCostMatrix,
  ExtendedFamily,
  PackageSize,
  PlanningHorizon,
  Station,
} from '@/lib/planning/engine-io';
import { costToSwitch } from '@/lib/engine/changeover';
import { allocateSupplyFifo } from '@/lib/engine/supply-allocator';
import { toLocalISODate } from '@/lib/planning/working-day';
import {
  readManualActivitiesFromStorage,
  writeManualActivitiesToStorage,
  type ManualActivity,
} from '@/lib/planning/manual-activities';

// ─── Types ───────────────────────────────────────────────────

interface SummaryProps {
  productCount: number;
  feasibleCount: number;
  infeasibleCount: number;
  totalChangeoverMinutes: number;
  orchestratorWarningCount: number;
  dayAssignerWarningCount: number;
  capacityWarningCount: number;
  demandSourceMtime: string | null;
}

interface InfeasibleProduct {
  productCode: string;
  productName: string;
  station: string;
  unmetUnits: number;
  reason: string;
}

interface ProductOverrideShape {
  shelfLifeDays?: number;
  maxBatchSize?: number;
}

interface CalendarAppProps {
  horizon: PlanningHorizon;
  activities: CalendarActivity[];
  dayLoads: DayLoadSummary[];
  assembliesFetchedAt: string | null;
  kitchenActivityCount: number;
  kitchenRequiredCount: number;
  /** Per-station daily capacity in minutes. Used for client-side load recompute. */
  stationDailyMinutes: Record<string, number>;
  /**
   * Per-recipe kitchen-team minutes (Phase 4l.8). Used by the kitchen
   * heatmap and by the resolver for capacity walks. Activities whose
   * productCode isn't in the map fall back to KITCHEN_DEFAULT_MINUTES.
   */
  kitchenMinutesByProductCode: Record<string, number>;
  /**
   * Phase 4l.10 — total effective dehydrator-tray pool across all kitchen
   * dehydrators (Mamma + Pappa + Midgy at typical max-fill, currently 605).
   * The day-header D% column = sum(dehydratorTrays of chips occupying day)
   * / dehydratorTotalTrays. Zero if no dehydrator data found in spreadsheet.
   */
  dehydratorTotalTrays: number;
  /**
   * Phase 4l.11 — per-product weekly demand. The client walks this plus
   * initial SOH plus per-day production from packaging chips to compute
   * an availability-over-time timeline per product. Drives chip BG
   * lightness (availability heat) and the sparkline overlay.
   * Structure: { productCode: [{ weekStart: 'YYYY-MM-DD', quantity: N }] }.
   */
  weeklyDemandByProduct: Record<string, Array<{ weekStart: string; quantity: number }>>;
  infeasibleProducts: InfeasibleProduct[];
  /** productCode → cost-router rationale string (why this station was chosen). */
  routingDecisions: Record<string, string>;
  /** Per-product override map currently on disk (server reads on each render). */
  productOverrides: Record<string, ProductOverrideShape>;
  /** Per-product station daily output (units), used as default for max-batch override. */
  productStationDailyOutput: Record<string, number>;
  /** Phase 4l.12 — all plannable packaging SKUs (allowlist ∩ has-station).
   *  Drives the left-rail "Add to plan" lookup so the user can pick SKUs
   *  that aren't currently in the plan. Tier A (plannable=true) = SKUs
   *  the planner can schedule; Tier B (plannable=false) = SKUs the
   *  operator can still drag manually but the planner won't touch
   *  (no allowlist entry / no family routing). */
  productCatalog: ReadonlyArray<{
    productCode: string;
    productName: string;
    station: Station;
    plannable: boolean;
  }>;
  /** SOH per (product code, warehouse name); empty when no cache file exists. */
  sohByProductCode: Record<string, Record<string, number>>;
  /** ISO timestamp of the last SOH refresh, or null when cache is missing. */
  sohFetchedAt: string | null;
  /** Warehouses present in the SOH cache (informational, for the drawer breakdown). */
  availableWarehouses: string[];
  /** Warehouses whose stock the planner counts as fulfilment-eligible (FG side). */
  eligibleWarehouses: string[];
  /** Phase 4l.12 — warehouses the planner counts toward intermediate
   *  SOH (Lundberg + MF Packaging + MF Operations). The drawer uses
   *  this when the selected chip is an intermediate so the "excluded"
   *  label reflects the right rule for that chip's kind. */
  intermediateEligibleWarehouses: readonly string[];
  /** Per-product effective initialInventory (= sum of SOH across eligibleWarehouses). */
  initialInventoryByProduct: Record<string, number>;
  /** Phase 4l.12 — per-intermediate effective SOH (= sum across the
   *  three intermediate-eligible warehouses). Surfaced in the drawer
   *  for `kitchen` / `kitchen-required` chips. */
  intermediateSohByCode: Record<string, number>;
  /** Allowlisted FGs the planner could NOT schedule because no BOM was
   *  found in the family-sheet workbook. Surfaced in the FG drawer via
   *  the "Show unplanned" filter so the operator can see which SKUs are
   *  waiting on recipe data. */
  unplannedFinishedGoods: string[];
  /** Per-product list of active sales-order lines. Empty when no commitments. */
  salesOrdersByProduct: Record<
    string,
    Array<{
      orderNumber: string;
      customerName: string;
      orderStatus: string;
      requiredDate: string;
      quantityRemaining: number;
    }>
  >;
  /** Per-product total committed units across all active orders. */
  committedByProduct: Record<string, number>;
  salesOrdersFetchedAt: string | null;
  totalSalesOrderLines: number;
  /** Raw-material projection — first-shortage rows for the risks panel. */
  rawMaterialShortages: RawMaterialShortage[];
  /** Derived PO place-by requirements (Phase 4m.1). */
  purchaseRequirements: PurchaseRequirement[];
  /** Per-raw-material vendor name from data/raw-material-lead-times.json. */
  vendorByCode: Record<string, string>;
  /** Today's date as YYYY-MM-DD local — used by the client-side PO projector. */
  todayLocal: string;
  /** Global defaults the user can override per product. */
  globalDefaults: { shelfLifeDays: number };
  /** Horizon-week options surfaced in the picker (e.g. 12 / 16 / 20 / 26). */
  horizonOptions: number[];
  /** productCode → list of intermediate codes its BOM consumes (depth 1). For conflict detection. */
  consumesMap: Record<string, string[]>;
  /** Per-ingredient starting SOH (sum across all warehouses) for SOH-aware conflict detection. */
  conflictInitialSohByCode: Record<string, number>;
  /** consumer productCode → ingredient code → qty per unit of consumer (combined clean+wastage). */
  consumesQtyMap: Record<string, Record<string, number>>;
  /** intermediate code → recipe yield rate (output qty per unit nominal). Missing = 1.0. */
  yieldRateByCode: Record<string, number>;
  /** Per-station changeover-cost matrix from the spreadsheet (Phase 4l.7 client recompute). */
  changeoverMatrix: ChangeoverCostMatrix;
  /** Non-null when URL `?from=...` overrides the planner's "today" anchor. */
  planFromDate: string | null;
  summary: SummaryProps;
}

// ─── Constants ───────────────────────────────────────────────

const STATIONS: Station[] = ['hand-packing', 'elephant', 'dust', 'bottlo'];

/**
 * Kitchen-team capacity model (Phase 4l.7 / 4l.8 / 4l.10).
 * Used both by the resolver (push/pull past kitchen-overloaded days) and by
 * the calendar heatmap so the user sees the same load picture the resolver
 * does.
 *
 * Phase 4l.10: 3 people × 7-hour shift = 1260 person-minutes per day.
 * (Previously hard-coded as 480, which assumed one person — gave inflated
 * K% utilisation readings.)
 *
 * Per-chip minutes come from `activity.kitchenMinutes` (preferred —
 * computed server-side as `quantity × per-unit-rate` for dehydrator
 * recipes), with fallback to `kitchenMinutesByProductCode[code]` (the
 * legacy per-recipe map) or `KITCHEN_DEFAULT_CHIP_MINUTES` for unknown
 * recipes.
 */
const KITCHEN_DAILY_MINUTES = 1260;
const KITCHEN_DEFAULT_CHIP_MINUTES = 240;

// Phase 4l.12 — target SOH floor in days of forward demand. MUST match
// `DEFAULT_SOH_FLOOR_DAYS` in `batch-optimiser.ts`; the client uses this
// only to render a reference line on each chip's inventory sparkline so
// the user can see at-a-glance when SOH dips toward the planner's target.
const SOH_FLOOR_DAYS = 10;

interface ChipColor { bg: string; border: string; text: string; dot: string }

// ─── Phase 4l.11 — packaging chip colours: profit-tier green on a fixed hue ───
// One profit axis driving TWO visual properties:
//   • SATURATION climbs with profit (15% → 100%).
//   • LIGHTNESS drops with profit (92% → 45%).
// Together they shade low-profit chips towards WHITE (faint, recede)
// and high-profit chips towards full #00E676 (vivid, foreground).
//
// Hue is locked at 151° — top band matches #00E676 exactly. 20 bands of
// $700 each scale the gradient up to the observed real-world maximum
// (~$14k chip profit from MFBEETPME ×1010 @ $14.17/unit). This keeps
// the spread useful inside the high-profit half — with the previous
// 10-band/$500 scheme almost every chip ≥ $4500 pegged at vivid green,
// killing discrimination at the top.
//
//     band 0  (<$700)    → sat 15%,  lit 92%   (near white)
//     band 5  (<$4200)   → sat 37%,  lit 80%
//     band 10 (<$7700)   → sat 60%,  lit 67%
//     band 15 (<$11200)  → sat 82%,  lit 55%
//     band 19 (≥$13300)  → sat 100%, lit 45%   (full #00E676)
//
// Per-chip: captures both margin AND scale. A 1000-unit run of a $1/unit
// SKU can outrank a 50-unit run of a $5/unit SKU.
//   • LIGHTNESS = inventory availability at this point in time. Walked
//     per-day from initial SOH + production events − daily demand. Each
//     chip's BG is rendered as a horizontal gradient: left edge = inv
//     immediately after this batch lands (vivid, dark — "stocked up");
//     right edge = inv just before the next event (pale — "running
//     low"). Reading a column at a glance shows which SKUs were just
//     produced vs which are starving for the next batch.
//
// Kitchen chips sit in the blue/cyan family — visually orthogonal to
// the packaging purples so kitchen vs packaging reads at a glance.
const STATION_HUE: Record<Station, number> = {
  'hand-packing': 280,
  elephant: 280,
  dust: 280,
  bottlo: 280,
};

/**
 * Map total profit per chip (= profit/item × quantity) to a (saturation,
 * lightness) pair on the fixed green hue (151°). 10 bands of $500 each —
 * band 0 is $0–499, band 9 is $4500+. Missing/zero data falls into
 * band 0 (most faded). Top band lands at sat=100, lit=45 which (combined
 * with hue=151) is #00E676 exactly.
 *
 * Lightness sweeps DOWN as profit climbs so low-profit chips fade
 * towards white (high lightness, low saturation) and high-profit chips
 * intensify towards vivid green.
 */
const PROFIT_BAND_WIDTH = 700;
const PROFIT_BAND_COUNT = 20;
const PACKAGING_HUE = 151;
const PROFIT_SAT_MIN = 15;
const PROFIT_SAT_MAX = 100;
const PROFIT_LIT_HIGH = 92; // low-profit → near white
const PROFIT_LIT_LOW = 45;  // high-profit → vivid #00E676

function profitTierColor(chipProfit: number | null | undefined): { sat: number; lit: number } {
  const value =
    chipProfit != null && Number.isFinite(chipProfit) && chipProfit > 0
      ? chipProfit
      : 0;
  const band = Math.min(
    PROFIT_BAND_COUNT - 1,
    Math.floor(value / PROFIT_BAND_WIDTH),
  );
  const t = band / (PROFIT_BAND_COUNT - 1); // 0..1
  return {
    sat: Math.round(PROFIT_SAT_MIN + t * (PROFIT_SAT_MAX - PROFIT_SAT_MIN)),
    lit: Math.round(PROFIT_LIT_HIGH - t * (PROFIT_LIT_HIGH - PROFIT_LIT_LOW)),
  };
}

/**
 * Build a chip colour for a packaging activity. Hue is fixed at 151°
 * (green). `sat`/`lit` come from `profitTierColor` (low profit → low
 * sat + high lit = near white; high profit → vivid #00E676).
 *
 * Text colour flips at lit ≈ 65: pale chips get dark green text, vivid
 * chips get white. Border is always a deep saturated green so even the
 * near-white low-profit chips have a defined outline.
 *
 * `station` and the trailing legacy arg are kept on the signature for
 * compat but ignored.
 */
function packagingChipColor(station: Station, sat: number, lit: number = PROFIT_LIT_LOW): ChipColor {
  void station;
  const h = PACKAGING_HUE;
  const borderLit = 22;
  const text = lit > 65 ? `hsl(${h}, 60%, 18%)` : '#ffffff';
  return {
    bg: `hsl(${h}, ${sat}%, ${lit}%)`,
    border: `hsl(${h}, 85%, ${borderLit}%)`,
    text,
    dot: `hsl(${h}, 85%, ${borderLit}%)`,
  };
}

/**
 * Phase 4l.11 — build an SVG polyline path for the inventory sparkline
 * embedded in each packaging chip. The polyline traces the per-day
 * inventory ratio (0..1) across the horizon as a curve at the bottom
 * of the chip. Replaces the earlier gradient-as-availability approach
 * (which the eye read as hazy because sRGB interpolation between many
 * close-lightness purple stops produced perceptual mush).
 *
 * Returns the SVG path string AND a vertical marker x-position
 * representing where this chip's date falls within the horizon — so
 * you can see "this batch lands HERE on the inventory journey."
 */
interface SparklineGeometry {
  points: string;
  fillPath: string;
  markerX: number | null;
}

interface ShortageGeometry {
  points: string;
  fillPath: string;
}

/** Inventory curve: bottom-anchored, fills bottom strip of the chip. */
function buildSparklineGeometry(
  ratios: number[],
  chipDateIndex: number | null,
  viewW: number,
  viewH: number,
): SparklineGeometry {
  if (ratios.length === 0) {
    return { points: '', fillPath: '', markerX: null };
  }
  const lastIdx = ratios.length - 1;
  const xOf = (i: number) =>
    lastIdx === 0 ? 0 : (i / lastIdx) * viewW;
  const yOf = (r: number) =>
    viewH - 0.5 - Math.max(0, Math.min(1, r)) * (viewH - 1);
  const points = ratios
    .map((r, i) => `${xOf(i).toFixed(2)},${yOf(r).toFixed(2)}`)
    .join(' ');
  const fillParts: string[] = [`M 0 ${viewH}`];
  for (let i = 0; i < ratios.length; i++) {
    fillParts.push(`L ${xOf(i).toFixed(2)} ${yOf(ratios[i]).toFixed(2)}`);
  }
  fillParts.push(`L ${viewW} ${viewH}`);
  fillParts.push('Z');
  const markerX =
    chipDateIndex == null
      ? null
      : xOf(Math.max(0, Math.min(lastIdx, chipDateIndex)));
  return {
    points,
    fillPath: fillParts.join(' '),
    markerX,
  };
}

/**
 * Phase 4l.12 — floor reference curve: a thin dashed line traced at the
 * SOH-floor target across the horizon. Uses the SAME bottom-anchored y
 * mapping as the inventory sparkline so the floor sits at its correct
 * relative height. Returns just the polyline points (no fill); the
 * caller renders it as a dashed `<polyline>`.
 */
function buildFloorPoints(
  floorRatios: number[] | null,
  viewW: number,
  viewH: number,
): string | null {
  if (!floorRatios || floorRatios.length === 0) return null;
  if (!floorRatios.some((r) => r > 0)) return null;
  const lastIdx = floorRatios.length - 1;
  const xOf = (i: number) => (lastIdx === 0 ? 0 : (i / lastIdx) * viewW);
  const yOf = (r: number) =>
    viewH - 0.5 - Math.max(0, Math.min(1, r)) * (viewH - 1);
  return floorRatios
    .map((r, i) => `${xOf(i).toFixed(2)},${yOf(r).toFixed(2)}`)
    .join(' ');
}

/**
 * Shortage curve: top-anchored, inverted. Higher shortage ratio = larger
 * y (= further down from the top edge). Renders as a red icicle hanging
 * from the top border of the chip. Returns null when there's no shortage
 * to show (= caller should skip the SVG entirely).
 */
function buildShortageGeometry(
  shortageRatios: number[] | null,
  viewW: number,
  viewH: number,
): ShortageGeometry | null {
  if (!shortageRatios || !shortageRatios.some((r) => r > 0)) return null;
  const lastIdx = shortageRatios.length - 1;
  const xOf = (i: number) =>
    lastIdx === 0 ? 0 : (i / lastIdx) * viewW;
  const yOf = (r: number) =>
    0.5 + Math.max(0, Math.min(1, r)) * (viewH - 1);
  const points = shortageRatios
    .map((r, i) => `${xOf(i).toFixed(2)},${yOf(r).toFixed(2)}`)
    .join(' ');
  const fillParts: string[] = ['M 0 0'];
  for (let i = 0; i < shortageRatios.length; i++) {
    fillParts.push(
      `L ${xOf(i).toFixed(2)} ${yOf(shortageRatios[i]).toFixed(2)}`,
    );
  }
  fillParts.push(`L ${viewW} 0`);
  fillParts.push('Z');
  return {
    points,
    fillPath: fillParts.join(' '),
  };
}

const STATION_LABELS: Record<Station, string> = {
  'hand-packing': 'Hand packing',
  elephant: 'Elephant',
  dust: 'Dust',
  bottlo: 'Bottlo',
};

/**
 * Phase 4l.11: Kitchen ACTIVITIES (live Unleashed assemblies) — cyan.
 * Chosen so it's visually orthogonal to every packaging station hue
 * (amber/blue/violet/emerald) and the kitchen-required magenta. "Live"
 * = already booked into Unleashed; operator should NOT need to act.
 */
const KITCHEN_COLOR: ChipColor = {
  bg: 'hsl(190, 70%, 90%)',
  border: 'hsl(190, 85%, 38%)',
  text: 'hsl(195, 90%, 20%)',
  dot: 'hsl(190, 85%, 38%)',
};

/**
 * Phase 4l.11: Kitchen-REQUIRED (planner-derived shortfalls) — deep
 * indigo/navy. Stays in the blue family for visual harmony with the
 * live-kitchen cyan (both = "kitchen domain") while sitting 50° apart
 * in hue from the elephant packaging blue (h=215) so they don't merge
 * at high saturation. Darker lightness than live kitchen so it still
 * reads as "action needed" without breaking the blue palette.
 */
const KITCHEN_REQUIRED_COLOR: ChipColor = {
  bg: 'hsl(235, 75%, 90%)',
  border: 'hsl(240, 75%, 45%)',
  text: 'hsl(240, 85%, 25%)',
  dot: 'hsl(240, 75%, 45%)',
};

/** PO place-by chip — yellow/amber to read as "action needed". */
const PO_PLACED_COLOR: ChipColor = {
  bg: '#fef3c7',
  border: '#d97706',
  text: '#78350f',
  dot: '#d97706',
};
/** PO arrive-by chip — soft green to read as "delivery, positive". */
const PO_RECEIVING_COLOR: ChipColor = {
  bg: '#d1fae5',
  border: '#059669',
  text: '#064e3b',
  dot: '#059669',
};
/** Override colour when a PO is overdue (placeBy < today). */
const PO_OVERDUE_COLOR: ChipColor = {
  bg: '#fee2e2',
  border: '#dc2626',
  text: '#7f1d1d',
  dot: '#dc2626',
};

/** Pick the chip's colour scheme based on kind + station + profit heat. */
function colorOf(activity: CalendarActivity): ChipColor {
  if (activity.kind === 'kitchen') return KITCHEN_COLOR;
  if (activity.kind === 'kitchen-required') return KITCHEN_REQUIRED_COLOR;
  if (activity.kind === 'po-placed') {
    return activity.poInfo?.overdue ? PO_OVERDUE_COLOR : PO_PLACED_COLOR;
  }
  if (activity.kind === 'po-receiving') {
    return activity.poInfo?.overdue ? PO_OVERDUE_COLOR : PO_RECEIVING_COLOR;
  }
  // Phase 4l.11: packaging chips use a profit-tier saturation on the
  // fixed green hue. Top profit band lands on #00E676 exactly.
  if (activity.station) {
    // Total profit this chip produces = profit/item × units run. Captures
    // both margin AND scale: a big run of a mid-margin SKU now reads
    // more saturated than a tiny run of a high-margin one.
    // Phase 4l.12 — distinguish missing profit data from zero profit.
    // Missing data renders as a NEUTRAL grey-green (sat=8, lit=80) so
    // it's visually distinct from the green profit gradient and
    // doesn't blend with low-profit chips. Drawer/chip ? indicator
    // tells the user to fill in `_profit-gaps-todo.tsv`.
    if (activity.profitPerItem == null) {
      return packagingChipColor(activity.station, 8, 80);
    }
    const chipProfit = activity.profitPerItem * activity.quantity;
    const { sat, lit } = profitTierColor(chipProfit);
    return packagingChipColor(activity.station, sat, lit);
  }
  return KITCHEN_COLOR;
}

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// ─── Helpers ─────────────────────────────────────────────────

/** ISO YYYY-MM-DD → Date in local time (avoids UTC drift). */
function fromISO(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** Date → ISO YYYY-MM-DD in local time. */
function toISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Add `days` to an ISO date in local time. Used by the drawer for PO arrive-by computation. */
function addDaysIso(iso: string, days: number): string {
  const d = fromISO(iso);
  d.setDate(d.getDate() + days);
  return toISO(d);
}

/** Group activities by date for fast per-day lookup. */
function groupByDate(activities: CalendarActivity[]): Map<string, CalendarActivity[]> {
  const out = new Map<string, CalendarActivity[]>();
  for (const a of activities) {
    let arr = out.get(a.date);
    if (!arr) {
      arr = [];
      out.set(a.date, arr);
    }
    arr.push(a);
  }
  return out;
}

/**
 * Write the demand-affecting subset of mutations to a cookie the server
 * can read on the next render. Phase 4l.7 (dismissals + qty edits).
 *
 * Payload shape: `{ [stableId]: { d?: true, q?: number } }`. Compact keys
 * to keep the cookie under the 4KB browser limit even with many mutations.
 *
 * The server uses this to:
 *   - drop dismissed activities from the kitchen-run planner + raw-material
 *     analyzer (cancelling a chip shrinks upstream demand)
 *   - replace activity.quantity with `editedQuantity` (editing a chip's qty
 *     resizes upstream POs and kitchen-required chips)
 */
const MUTATIONS_COOKIE_NAME = 'byron-mutations-v1';
const MANUAL_ACTIVITIES_COOKIE_NAME = 'byron-manual-activities-v1';

/** Phase 4l.8: write user-created manual activities to a cookie so the
 *  server can inject them into `projection.activities` on next render. */
function writeManualActivitiesCookie(activities: readonly ManualActivity[]): void {
  if (typeof document === 'undefined') return;
  const value = encodeURIComponent(JSON.stringify(activities));
  document.cookie = `${MANUAL_ACTIVITIES_COOKIE_NAME}=${value};path=/;max-age=604800;SameSite=Lax`;
}
/**
 * Maximum bytes for the encoded mutations cookie. Browsers cap individual
 * cookies at ~4096 bytes; over-budget writes are silently dropped, which
 * is how Phase 4l.10 surfaced the "cookie stays `{}` despite 71 mutations
 * in state" bug. We budget 3800 to leave headroom for cookie key + attrs.
 */
const MUTATIONS_COOKIE_MAX_BYTES = 3800;

function writeMutationsCookie(mutations: MutationsMap): void {
  if (typeof document === 'undefined') return;
  // Build candidate entries (filter to fields the server actually reads).
  type Entry = { d?: true; q?: number; r?: string };
  const candidates: Array<{ id: string; entry: Entry; updatedAt: string }> = [];
  for (const [id, m] of Object.entries(mutations)) {
    const entry: Entry = {};
    if (m.dismissed) entry.d = true;
    if (typeof m.editedQuantity === 'number' && Number.isFinite(m.editedQuantity)) {
      entry.q = m.editedQuantity;
    }
    if (typeof m.rescheduledTo === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(m.rescheduledTo)) {
      entry.r = m.rescheduledTo;
    }
    if (Object.keys(entry).length > 0) {
      candidates.push({ id, entry, updatedAt: m.updatedAt ?? '' });
    }
  }
  // Sort by updatedAt DESC so the most-recently-edited mutations win when
  // we hit the size budget. Stable tie-break by id for determinism.
  candidates.sort((a, b) => {
    if (a.updatedAt !== b.updatedAt) return b.updatedAt.localeCompare(a.updatedAt);
    return a.id.localeCompare(b.id);
  });
  // Greedily add candidates until adding the next would exceed the budget.
  const payload: Record<string, Entry> = {};
  let truncated = 0;
  for (const c of candidates) {
    const tentative = { ...payload, [c.id]: c.entry };
    const encoded = encodeURIComponent(JSON.stringify(tentative));
    if (encoded.length > MUTATIONS_COOKIE_MAX_BYTES) {
      truncated = candidates.length - Object.keys(payload).length;
      break;
    }
    payload[c.id] = c.entry;
  }
  if (truncated > 0) {
    console.warn(
      `[writeMutationsCookie] cookie size budget (${MUTATIONS_COOKIE_MAX_BYTES} bytes) exceeded — kept ${Object.keys(payload).length} most-recent mutations, dropped ${truncated} older. Use "Clear all" in the header to reset and start fresh.`,
    );
  }
  const value = encodeURIComponent(JSON.stringify(payload));
  document.cookie = `${MUTATIONS_COOKIE_NAME}=${value};path=/;max-age=604800;SameSite=Lax`;
}

/** Build a flat list of dates spanning N weeks from a Monday startDate. */
function horizonDates(startWeek: string, weeks: number): string[] {
  const start = fromISO(startWeek);
  const out: string[] = [];
  for (let i = 0; i < weeks * 7; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    out.push(toISO(d));
  }
  return out;
}

function fmtDayShort(iso: string): string {
  const d = fromISO(iso);
  return `${d.getDate()}`;
}

function fmtMonthYear(iso: string): string {
  const d = fromISO(iso);
  return d.toLocaleDateString('en-AU', { month: 'long', year: 'numeric' });
}

/**
 * Display format for any user-visible date: dd/mm/yyyy.
 * Internal storage stays in ISO YYYY-MM-DD; this is the single conversion
 * point so every date label in the UI matches.
 */
function fmtDate(iso: string): string {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

/** Format an ISO timestamp (e.g. fs mtime) as dd/mm/yyyy in local time. */
function fmtDateFromTimestamp(iso: string): string {
  const dt = new Date(iso);
  if (isNaN(dt.getTime())) return '';
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const d = String(dt.getDate()).padStart(2, '0');
  return `${d}/${m}/${y}`;
}

/** Trigger a browser download of `csv` as a file with `filename`. */
function downloadCsv(csv: string, filename: string): void {
  if (typeof window === 'undefined') return;
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Allow the click handler to flush before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Open a printable report in a new window. The HTML carries its own
 * `window.print()` call, so the print dialog opens automatically once the
 * window finishes loading. Falls back to alerting when popups are blocked.
 */
function openPrintWindow(html: string): void {
  if (typeof window === 'undefined') return;
  const w = window.open('', '_blank');
  if (!w) {
    window.alert(
      'Could not open the print window — your browser may have blocked the popup. Allow popups for this site and try again.',
    );
    return;
  }
  w.document.open();
  w.document.write(html);
  w.document.close();
}

/** Format an ISO timestamp as dd/mm/yyyy HH:mm in local time. */
function fmtDateTimeFromTimestamp(iso: string): string {
  const dt = new Date(iso);
  if (isNaN(dt.getTime())) return '';
  const y = dt.getFullYear();
  const mo = String(dt.getMonth() + 1).padStart(2, '0');
  const d = String(dt.getDate()).padStart(2, '0');
  const h = String(dt.getHours()).padStart(2, '0');
  const mi = String(dt.getMinutes()).padStart(2, '0');
  return `${d}/${mo}/${y} ${h}:${mi}`;
}

// ─── Component ───────────────────────────────────────────────

export function CalendarApp(props: CalendarAppProps) {
  const {
    horizon,
    activities,
    dayLoads,
    assembliesFetchedAt,
    kitchenActivityCount,
    kitchenRequiredCount,
    stationDailyMinutes,
    kitchenMinutesByProductCode,
    dehydratorTotalTrays,
    weeklyDemandByProduct,
    infeasibleProducts,
    routingDecisions,
    productOverrides,
    productStationDailyOutput,
    productCatalog,
    sohByProductCode,
    sohFetchedAt,
    availableWarehouses,
    eligibleWarehouses,
    intermediateEligibleWarehouses,
    initialInventoryByProduct,
    intermediateSohByCode,
    unplannedFinishedGoods,
    salesOrdersByProduct,
    committedByProduct,
    salesOrdersFetchedAt,
    totalSalesOrderLines,
    rawMaterialShortages,
    purchaseRequirements,
    vendorByCode,
    todayLocal,
    globalDefaults,
    horizonOptions,
    consumesMap,
    conflictInitialSohByCode,
    consumesQtyMap,
    yieldRateByCode,
    changeoverMatrix,
    planFromDate,
    summary,
  } = props;
  const [infeasibleOpen, setInfeasibleOpen] = useState(false);

  // Re-plan: triggers Next.js to re-fetch the server component, which re-runs
  // the full pipeline against whatever's in the spreadsheet + demand.csv right
  // now. useTransition gives us isPending so we can show a loading indicator
  // while the server re-renders without blocking the UI.
  const router = useRouter();
  const [isReplanning, startReplan] = useTransition();
  function replan() {
    startReplan(() => {
      router.refresh();
    });
  }

  // SOH refresh: hit /api/refresh-soh to pull from Unleashed and write the
  // cache, then trigger a page re-render so the new initialInventory flows
  // through the optimiser.
  const [refreshingSoh, setRefreshingSoh] = useState(false);
  const [sohRefreshError, setSohRefreshError] = useState<string | null>(null);
  async function refreshSoh() {
    setRefreshingSoh(true);
    setSohRefreshError(null);
    try {
      const res = await fetch('/api/refresh-soh', { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail ?? data.error ?? `HTTP ${res.status}`);
      }
      router.refresh();
    } catch (e) {
      setSohRefreshError(e instanceof Error ? e.message : 'Refresh failed');
    } finally {
      setRefreshingSoh(false);
    }
  }

  // Sales-orders refresh: same shape as SOH refresh.
  const [refreshingSO, setRefreshingSO] = useState(false);
  const [soRefreshError, setSORefreshError] = useState<string | null>(null);
  async function refreshSalesOrders() {
    setRefreshingSO(true);
    setSORefreshError(null);
    try {
      const res = await fetch('/api/refresh-sales-orders', { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail ?? data.error ?? `HTTP ${res.status}`);
      }
      router.refresh();
    } catch (e) {
      setSORefreshError(e instanceof Error ? e.message : 'Refresh failed');
    } finally {
      setRefreshingSO(false);
    }
  }

  // Assemblies (kitchen production) refresh.
  const [refreshingAssemblies, setRefreshingAssemblies] = useState(false);
  const [assembliesRefreshError, setAssembliesRefreshError] = useState<string | null>(null);
  async function refreshAssemblies() {
    setRefreshingAssemblies(true);
    setAssembliesRefreshError(null);
    try {
      const res = await fetch('/api/refresh-assemblies', { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail ?? data.error ?? `HTTP ${res.status}`);
      }
      router.refresh();
    } catch (e) {
      setAssembliesRefreshError(e instanceof Error ? e.message : 'Refresh failed');
    } finally {
      setRefreshingAssemblies(false);
    }
  }

  // Purchase orders (Unleashed outstanding POs) refresh — Phase 4l.5.
  const [refreshingPo, setRefreshingPo] = useState(false);
  const [poRefreshError, setPoRefreshError] = useState<string | null>(null);
  async function refreshPurchaseOrders() {
    setRefreshingPo(true);
    setPoRefreshError(null);
    try {
      const res = await fetch('/api/refresh-purchase-orders', { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail ?? data.error ?? `HTTP ${res.status}`);
      }
      router.refresh();
    } catch (e) {
      setPoRefreshError(e instanceof Error ? e.message : 'Refresh failed');
    } finally {
      setRefreshingPo(false);
    }
  }

  // Layer-toggle state: which packaging stations are visible. Default all on.
  const [visibleStations, setVisibleStations] = useState<Set<Station>>(
    () => new Set(STATIONS),
  );
  // Top-level category toggles: packaging (chips for the four stations) and
  // kitchen (chips for Lundberg assemblies). Either off hides ALL activities
  // of that kind regardless of per-station toggles.
  const [showPackaging, setShowPackaging] = useState(true);
  const [showKitchen, setShowKitchen] = useState(true);
  // Sub-toggles within Kitchen: scheduled (live Unleashed) vs required
  // (planner-derived gaps). Default both on; kitchen master gates the lot.
  const [showKitchenScheduled, setShowKitchenScheduled] = useState(true);
  const [showKitchenRequired, setShowKitchenRequired] = useState(true);
  // Purchasing chips (Phase 4m.2): place-by and arrive-by chips for raw
  // materials projected to run short. Default on so the user sees them.
  const [showPO, setShowPO] = useState(true);
  // Sub-toggles under Purchasing (Phase 4l.8): three independent slices
  // — place-by chips, receive-by chips, and urgent (overdue) chips. A PO
  // chip is visible iff its master toggle is on AND at least one of its
  // applicable sub-toggles is on. Urgent is an additional category that
  // overlaps the place/receive split (the same overdue chip belongs to
  // both its kind's slice and the urgent slice).
  const [showPoPlaced, setShowPoPlaced] = useState(true);
  const [showPoReceiving, setShowPoReceiving] = useState(true);
  const [showPoUrgent, setShowPoUrgent] = useState(true);

  // Selected activity for the drawer.
  const [selected, setSelected] = useState<CalendarActivity | null>(null);
  // The chip's STABLE id (won't change across mutations / layer toggles /
  // re-renders). Kept alongside `selected` so the selection visual sticks
  // even when the underlying CalendarActivity object reference changes —
  // e.g. when the user adds a layer to visibility and the calendar re-
  // renders with a fresh `mutatedActivities` array.
  const selectedStableId = selected?.stableId ?? null;

  // Phase 4l.14 — Finished-goods drilldown. A FG code (not a single chip)
  // selected from the "Finished goods in planner" panel opens a
  // product-level drawer interrogating planned production + limiting
  // factors across the horizon. Mutually exclusive with the chip drawer:
  // selecting a FG clears the chip selection and vice-versa.
  const [selectedFG, setSelectedFG] = useState<string | null>(null);
  const selectChip = useCallback((a: CalendarActivity | null) => {
    setSelectedFG(null);
    setSelected(a);
  }, []);
  const selectFG = useCallback((code: string) => {
    setSelected(null);
    setSelectedFG(code);
  }, []);

  // Real today (client clock) — used by drag-guards and stale-reschedule
  // prune. We keep this independent of `planFromDate` so that when the user
  // is planning from a future anchor, chips can still be dragged backwards
  // through the calendar at least as far as today (Phase 4l.8).
  //
  // Phase 4l.14 — must NOT compute `new Date()` during render: that runs at
  // SSR (server clock) AND at hydration (client clock), and the two disagree
  // whenever the server (e.g. Vercel UTC) and client (AEST) straddle a
  // calendar boundary → hydration mismatch. Anchor the first render to the
  // server-provided `todayLocal` (deterministic on both sides), then correct
  // to the true client clock after mount, where a state change is safe.
  // Drag-guards / backward-extension only matter post-mount, so the one-frame
  // anchor value is harmless.
  const [realToday, setRealToday] = useState<string>(todayLocal);
  useEffect(() => {
    const t = toLocalISODate(new Date());
    if (t !== realToday) setRealToday(t);
    // Intentionally keyed on `todayLocal` only — re-sync if the server anchor
    // changes (e.g. plan-from edit). `realToday` is read, not a trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [todayLocal]);
  const clientToday = realToday;

  // ─── Manual activities (Phase 4l.8) ────────────────────────
  // User-created packaging chips, persisted in localStorage + synced to
  // a server-readable cookie so the next render injects them into
  // `projection.activities`. Added by dragging from the Infeasible
  // products panel; removed via the mutations indicator.
  const [manualActivities, setManualActivities] = useState<ManualActivity[]>([]);
  useEffect(() => {
    const hydrated = readManualActivitiesFromStorage();
    setManualActivities(hydrated);
    writeManualActivitiesCookie(hydrated);
  }, []);
  function persistManualActivities(next: ManualActivity[]) {
    writeManualActivitiesToStorage(next);
    writeManualActivitiesCookie(next);
    return next;
  }
  function addManualActivity(input: Omit<ManualActivity, 'id'>) {
    const id = `${input.productCode}|${input.date}|${Date.now()}`;
    setManualActivities((curr) =>
      persistManualActivities([...curr, { id, ...input }]),
    );
    setUnplaceableIds([]);
  }
  function removeManualActivity(id: string) {
    setManualActivities((curr) => persistManualActivities(curr.filter((m) => m.id !== id)));
    setUnplaceableIds([]);
  }
  // Auto-refresh when manual activities change so server re-injects.
  const manualSignature = useMemo(
    () => manualActivities.map((m) => `${m.id}@${m.date}×${m.quantity}@${m.station}`).sort().join('|'),
    [manualActivities],
  );
  const lastManualSignature = useRef<string | null>(null);
  useEffect(() => {
    if (lastManualSignature.current === null) {
      lastManualSignature.current = manualSignature;
      return;
    }
    if (lastManualSignature.current === manualSignature) return;
    const t = setTimeout(() => {
      lastManualSignature.current = manualSignature;
      router.refresh();
    }, 350);
    return () => clearTimeout(t);
  }, [manualSignature, router]);

  // ─── Mutations indicator (Phase 4l.8) ──────────────────────
  // Header dropdown showing every active mutation with per-entry Clear
  // and Clear-all. Surfaces what would otherwise be invisible state
  // (a reschedule whose chip ended up outside the current month view
  // is the canonical motivating case).
  const [mutationsOpen, setMutationsOpen] = useState(false);
  // Header "Tools" dropdown — collects the resolve-conflicts strategies
  // and the clear-* operations under one affordance so the header doesn't
  // sprout a fresh button every time we add a maintenance action.
  const [toolsOpen, setToolsOpen] = useState(false);
  const [showStaleDetails, setShowStaleDetails] = useState(false);
  const [productLookupQuery, setProductLookupQuery] = useState('');

  // ─── Mutations (dismiss) ─────────────────────────────────
  // Hydrated from localStorage on mount; written on every mutation.
  const [mutations, setMutations] = useState<MutationsMap>({});
  const [showDismissed, setShowDismissed] = useState(true);

  // Phase 4l.12 — auto-scroll while dragging chips. When a chip drag
  // hovers near the top or bottom of the viewport, scroll the page in
  // that direction so the user can target dates outside the current
  // view. Triggered by any HTML5 drag (chip reschedule or manual-add
  // from the left rail).
  useEffect(() => {
    let raf: number | null = null;
    let direction = 0; // -1 = up, 1 = down, 0 = idle
    const SCROLL_ZONE_PX = 90; // edge band that triggers scroll
    const SCROLL_SPEED_PX = 14; // px per animation frame
    const step = () => {
      if (direction === 0) {
        raf = null;
        return;
      }
      window.scrollBy(0, direction * SCROLL_SPEED_PX);
      raf = requestAnimationFrame(step);
    };
    const updateFromY = (clientY: number) => {
      const vh = window.innerHeight;
      let next = 0;
      if (clientY < SCROLL_ZONE_PX) next = -1;
      else if (clientY > vh - SCROLL_ZONE_PX) next = 1;
      if (next !== direction) {
        direction = next;
        if (direction !== 0 && raf === null) {
          raf = requestAnimationFrame(step);
        }
      }
    };
    const onDragOver = (e: DragEvent) => {
      updateFromY(e.clientY);
    };
    const stop = () => {
      direction = 0;
      if (raf !== null) {
        cancelAnimationFrame(raf);
        raf = null;
      }
    };
    document.addEventListener('dragover', onDragOver);
    document.addEventListener('dragend', stop);
    document.addEventListener('drop', stop);
    return () => {
      document.removeEventListener('dragover', onDragOver);
      document.removeEventListener('dragend', stop);
      document.removeEventListener('drop', stop);
      if (raf !== null) cancelAnimationFrame(raf);
    };
  }, []);

  useEffect(() => {
    const hydrated = readMutationsFromStorage();
    // Phase 4l.8: drop reschedules to dates that are now in the past.
    // Drags performed in earlier sessions can leave behind zombie
    // mutations targeting dates the calendar can no longer render.
    const today = toLocalISODate(new Date());
    const pruned = pruneStaleReschedules(hydrated, today);
    setMutations(pruned);
    // Sync localStorage + cookie only if we actually changed anything.
    if (pruned !== hydrated) {
      writeMutationsToStorage(pruned);
    }
    writeMutationsCookie(pruned);
  }, []);

  // Auto-refresh the server payload when the demand-affecting subset of
  // mutations changes (dismissals + qty edits), so the kitchen-run planner
  // + raw-material analyzer reflow upstream demand without the user
  // pressing Re-plan. Phase 4l.7. Debounced; reschedules and lead-time
  // overrides are client-only and skipped here.
  const reflowSignature = useMemo(() => {
    const entries: string[] = [];
    for (const [id, m] of Object.entries(mutations)) {
      const parts: string[] = [];
      if (m.dismissed) parts.push('d');
      if (typeof m.editedQuantity === 'number' && Number.isFinite(m.editedQuantity)) {
        parts.push(`q${m.editedQuantity}`);
      }
      if (typeof m.rescheduledTo === 'string') {
        parts.push(`r${m.rescheduledTo}`);
      }
      if (parts.length > 0) entries.push(`${id}:${parts.join(',')}`);
    }
    entries.sort();
    return entries.join('|');
  }, [mutations]);
  const lastReflowedSignature = useRef<string | null>(null);
  useEffect(() => {
    // Skip the first render — mutations hydrate async and we don't want an
    // extra fetch on mount.
    if (lastReflowedSignature.current === null) {
      lastReflowedSignature.current = reflowSignature;
      return;
    }
    if (lastReflowedSignature.current === reflowSignature) return;
    const t = setTimeout(() => {
      lastReflowedSignature.current = reflowSignature;
      router.refresh();
    }, 350);
    return () => clearTimeout(t);
  }, [reflowSignature, router]);

  // Unplaceable chips from the most-recent Resolve-all run. Cleared by any
  // subsequent mutation (the situation has changed; the user should re-run
  // resolve to get a fresh verdict). Phase 4l.4.
  const [unplaceableIds, setUnplaceableIds] = useState<string[]>([]);

  // Mutation actions — every one writes through to localStorage AND a
  // server-readable cookie. The cookie ships dismissed stableIds (only
  // the subset the server needs to reflow upstream demand) so the next
  // server render can drop those activities from the kitchen-run planner
  // and raw-material analyzer. Phase 4l.7.
  function persist(next: MutationsMap) {
    writeMutationsToStorage(next);
    writeMutationsCookie(next);
    return next;
  }
  function dismiss(stableId: string) {
    setMutations((curr) => persist(applyDismiss(curr, stableId)));
    setUnplaceableIds([]);
  }
  function undismiss(stableId: string) {
    setMutations((curr) => persist(applyUndismiss(curr, stableId)));
    setUnplaceableIds([]);
  }
  function reschedule(stableId: string, newDate: string) {
    setMutations((curr) => persist(applyReschedule(curr, stableId, newDate)));
    setUnplaceableIds([]);
  }
  function clearReschedule(stableId: string) {
    setMutations((curr) => persist(applyClearReschedule(curr, stableId)));
    setUnplaceableIds([]);
  }
  function editQuantity(stableId: string, qty: number) {
    // Phase 4l.10: persist BEFORE setMutations so the cookie write
    // happens synchronously, not deferred inside a React state updater.
    // Then trigger a server re-render so the supply-cap pass and kitchen
    // sizing re-derive against the new quantity. Without this, editing a
    // packaging chip leaves the kitchen chip stale; editing a kitchen
    // chip leaves downstream packaging un-capped.
    const next = applyEditQuantity(mutations, stableId, qty);
    persist(next);
    setMutations(next);
    setUnplaceableIds([]);
    // Diagnostic: log to browser console so we can verify the click reached
    // here, the next map has the edit, and the cookie write didn't throw.
    // Remove once the bidirectional-link bug is resolved.
    console.log('[editQuantity] called', {
      stableId,
      qty,
      mutationsBefore: Object.keys(mutations).length,
      mutationsAfter: Object.keys(next).length,
      cookieAfter:
        typeof document !== 'undefined' ? document.cookie : '(no document)',
    });
    router.refresh();
  }
  function clearEdit(stableId: string) {
    const next = applyClearEdit(mutations, stableId);
    persist(next);
    setMutations(next);
    setUnplaceableIds([]);
    router.refresh();
  }
  /** Edit lead time on a PO. Always passed the place-by chip's stableId. */
  function editLeadTime(placeByStableId: string, days: number) {
    setMutations((curr) => persist(applyEditLeadTime(curr, placeByStableId, days)));
    setUnplaceableIds([]);
  }
  function clearLeadTime(placeByStableId: string) {
    setMutations((curr) => persist(applyClearLeadTime(curr, placeByStableId)));
    setUnplaceableIds([]);
  }
  function editStation(stableId: string, newStation: Station, productCode?: string) {
    setMutations((curr) => persist(applyEditStation(curr, stableId, newStation)));
    setUnplaceableIds([]);
    // Phase 4l.12 — also persist as the SKU's default station so subsequent
    // chips for this product use the new station too. Fire-and-forget; if
    // the request fails we just lose the default-for-future behaviour, the
    // per-chip mutation still applies. The router refresh re-renders the
    // server component which picks up the new override.
    if (productCode) {
      fetch('/api/product-overrides', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productCode,
          override: { defaultStation: newStation },
        }),
      })
        .then(() => router.refresh())
        .catch((err) =>
          console.error(
            '[editStation] failed to persist defaultStation override:',
            err,
          ),
        );
    }
  }
  function clearStation(stableId: string) {
    setMutations((curr) => persist(applyClearStation(curr, stableId)));
    setUnplaceableIds([]);
  }
  function clearStaleMutations() {
    setMutations((curr) => persist(clearStale(curr, validStableIds)));
    setUnplaceableIds([]);
  }
  /**
   * Strip every `rescheduledTo` field from the mutations map. Keeps
   * dismissals, qty edits, lead-time edits, and station overrides so the
   * operator's other deliberate choices survive. Drops the entry entirely
   * when reschedule was its only override.
   *
   * Use case (post-Phase-4l.13 incident): undo a bulk-resolve sweep that
   * moved hundreds of chips without losing dismissals you've also made.
   */
  function clearAllReschedules() {
    setMutations((curr) => {
      const out: MutationsMap = {};
      const now = new Date().toISOString();
      for (const [id, mut] of Object.entries(curr)) {
        const { rescheduledTo: _r, ...rest } = mut;
        // Did this entry have other overrides? `rest` always includes
        // stableId + updatedAt; check for any other key.
        const hasOther = Object.keys(rest).some(
          (k) => k !== 'stableId' && k !== 'updatedAt',
        );
        if (hasOther) out[id] = { ...rest, updatedAt: now };
      }
      return persist(out);
    });
    setUnplaceableIds([]);
  }
  function clearAllMutations() {
    setMutations(persist({}));
    setUnplaceableIds([]);
  }
  /**
   * Phase 4l.12 — wipe every manually-dropped chip (drag-from-lookup or
   * drag-from-infeasible). Used by the mutations dropdown's "Clear all"
   * so the operator can return to a pristine planner view in one click
   * instead of removing each manual entry individually.
   */
  function clearAllManualActivities() {
    setManualActivities(() => persistManualActivities([]));
    setUnplaceableIds([]);
  }

  /**
   * Auto-cascade conflict resolution (Phase 4l.3 + 4l.4 + 4l.6).
   *
   * Delegates to the pure `resolveScheduleConflicts` engine module. Wired
   * to two button pairs (banner + drawer), each offering both strategies:
   *
   *   - 'push': move consumers later (capacity-aware via stationDailyMinutes).
   *   - 'pull': move blocking suppliers earlier (floor at horizon.startWeek
   *     so we don't pull anything into the past).
   *
   * Both call the same function with a different `strategy` flag.
   */
  function resolveAllConflicts(strategy: ResolveStrategy) {
    const result = resolveScheduleConflicts({
      // Use `activitiesWithPo` (not the raw `activities` prop) so the
      // resolver sees client-projected PO chips as suppliers. Without
      // them, raw-material conflicts like "needs LMFRASLFME by 26/05;
      // closest run finishes 09/06" are invisible to the resolver
      // (the PO chip arriving 09/06 is the supplier) — Resolve auto
      // would silently return zero mutations and the chip wouldn't
      // move. The UI builds its conflict view from `mutatedActivities`
      // which is layered on top of `activitiesWithPo`, so the
      // resolver now sees the same suppliers as the user.
      activities: activitiesWithPo,
      mutations,
      consumesMap,
      strategy,
      stationDailyMinutes,
      // Kitchen team's 8-hour day, shared with the heatmap below so the
      // resolver and the user see the same load picture.
      kitchenDailyMinutes: KITCHEN_DAILY_MINUTES,
      kitchenStartMinutesByProductCode: kitchenMinutesByProductCode,
      kitchenStartMinutesDefault: KITCHEN_DEFAULT_CHIP_MINUTES,
      // Pull-supplier floor: never pull a chip earlier than the planning
      // horizon's first day. (For 'push' this argument is ignored.)
      earliestDate: horizon.startWeek,
      // SOH-aware detection so resolver and UI agree on what's a conflict.
      initialSohByCode: conflictInitialSohByCode,
      consumesQtyMap,
      supplyQtyByActivity,
    });
    setMutations(persist(result.mutations));
    setUnplaceableIds(result.unplaceableStableIds);
  }

  // Set of stable IDs in the current engine output — used to detect stale
  // mutation entries (entries whose activity no longer exists in the plan).
  // Includes PO chip stableIds so lead-time overrides aren't flagged stale.
  const validStableIds = useMemo(() => {
    const out = new Set(activities.map((a) => a.stableId));
    for (const r of purchaseRequirements) {
      out.add(`po-placed|${r.rawMaterialCode}`);
      out.add(`po-receiving|${r.rawMaterialCode}`);
    }
    return out;
  }, [activities, purchaseRequirements]);

  const staleIds = useMemo(
    () => staleStableIds(mutations, validStableIds),
    [mutations, validStableIds],
  );

  // PO chips are projected client-side (Phase 4m.4) so user-set lead-time
  // overrides flow through naturally via the mutations map. Built before
  // applying mutations so subsequent steps can reschedule/dismiss them.
  const poChips = useMemo<CalendarActivity[]>(() => {
    return projectPoChips({
      purchaseRequirements,
      today: todayLocal,
      leadTimeOverrideDaysByCode: leadTimeOverridesByCode(mutations),
      vendorByCode,
    });
  }, [purchaseRequirements, todayLocal, mutations, vendorByCode]);

  // Combined activities = server-side (packaging + kitchen + kitchen-required)
  // + client-projected PO chips.
  const activitiesWithPo = useMemo<CalendarActivity[]>(() => {
    return [...activities, ...poChips].sort((a, b) =>
      a.date.localeCompare(b.date),
    );
  }, [activities, poChips]);

  // Apply mutations to each activity: override date if rescheduled, override
  // quantity if edited (with proportional duration + finishDate adjustment).
  // Dismiss is applied later by the visibility filter.
  //
  // The projection logic itself lives in `calendar-mutations` so the engine
  // resolver can use the same code path; here we just memoise the result.
  //
  // Phase 4l.7 also corrects per-chip changeoverMinutes after mutations.
  // The planner-assigned values are based on the planner's original
  // sequence; rescheduling chips around can make them stale. We re-run
  // the changeover engine over each (date, station) sequence in its
  // current mutated order — handling same-product (→ 0), different-
  // product same-extendedFamily (→ extendedFamily / familySameSize /
  // sizeSwitch), and full-clean cases via the same matrix the planner used.
  const mutatedActivities = useMemo(() => {
    const applied = applyMutationsToActivities(activitiesWithPo, mutations);
    type Bucket = CalendarActivity[];
    const buckets = new Map<string, Bucket>();
    for (const a of applied) {
      if (a.kind !== 'packaging' || !a.station) continue;
      const key = `${a.date}|${a.station}`;
      let arr = buckets.get(key);
      if (!arr) { arr = []; buckets.set(key, arr); }
      arr.push(a);
    }
    const overrideByStableId = new Map<string, number>();
    const toChangeoverProduct = (a: CalendarActivity) => ({
      productCode: a.productCode,
      family: a.family,
      // `costToSwitch` only reads these for the equality / null-fallback
      // branches; the type system narrows further but the values come
      // from the planner's projection so they match `ProductMeta` shape.
      extendedFamily: a.extendedFamily as ExtendedFamily | null,
      packageSize: (a.packageSize ?? 'OTHER') as PackageSize,
    });
    for (const arr of buckets.values()) {
      arr.sort((a, b) => a.orderInWeek - b.orderInWeek);
      let prev: CalendarActivity | null = null;
      for (const curr of arr) {
        if (curr.station) {
          const recomputed = costToSwitch(
            prev ? toChangeoverProduct(prev) : null,
            toChangeoverProduct(curr),
            curr.station,
            changeoverMatrix,
          );
          if (recomputed !== curr.changeoverMinutes) {
            overrideByStableId.set(curr.stableId, recomputed);
          }
        }
        prev = curr;
      }
    }
    if (overrideByStableId.size === 0) return applied;
    return applied.map((a) => {
      const o = overrideByStableId.get(a.stableId);
      return o !== undefined && o !== a.changeoverMinutes
        ? { ...a, changeoverMinutes: o }
        : a;
    });
  }, [activitiesWithPo, mutations, changeoverMatrix]);

  // Selection survives layer toggles via stableId matching on the chip
  // render side (ActivityChip / ClusterChip already compare both
  // `selectedStableId` and `selectedId`). No useEffect sync needed —
  // an earlier attempt to also refresh the `selected` object reference
  // here could ping-pong with React's commit cycle when the calendar
  // is heavy (cookie mutations + many manual chips re-render fast
  // enough that the effect's `find()` returns a new reference each
  // pass, which the stale-reference check failed to spot).

  // Number of dismissed activities present in the current plan.
  const dismissedCount = useMemo(
    () => activities.filter((a) => isDismissed(mutations, a.stableId)).length,
    [activities, mutations],
  );

  // Counts for the PO sub-toggles (Phase 4l.8). Drawn from activitiesWithPo
  // so synthetic + Unleashed po-receiving chips both contribute.
  const poCounts = useMemo(() => {
    let placed = 0;
    let receiving = 0;
    let urgent = 0;
    for (const a of activitiesWithPo) {
      if (isDismissed(mutations, a.stableId)) continue;
      if (a.kind === 'po-placed') placed += 1;
      else if (a.kind === 'po-receiving') receiving += 1;
      else continue;
      if (a.poInfo?.overdue) urgent += 1;
    }
    return { placed, receiving, urgent };
  }, [activitiesWithPo, mutations]);

  // Mutations indicator entries (Phase 4l.8). One row per kind of change
  // on each stableId, so a single chip with both a reschedule and a qty edit
  // gets two rows. Each row knows how to clear just its own change.
  interface MutationEntry {
    key: string;
    stableId: string;
    productCode: string;
    productName: string;
    description: string;
    onClear: () => void;
  }
  const mutationEntries = useMemo<MutationEntry[]>(() => {
    const byStableId = new Map<string, CalendarActivity>();
    for (const a of activitiesWithPo) byStableId.set(a.stableId, a);
    const out: MutationEntry[] = [];
    for (const [stableId, m] of Object.entries(mutations)) {
      const ref = byStableId.get(stableId);
      const productCode = ref?.productCode ?? stableId.split('|')[1] ?? stableId;
      const productName = ref?.productName ?? '';
      if (m.dismissed) {
        out.push({
          key: `${stableId}|dismiss`,
          stableId,
          productCode,
          productName,
          description: 'Dismissed',
          onClear: () => undismiss(stableId),
        });
      }
      if (typeof m.rescheduledTo === 'string') {
        const orig = ref?.date ? fmtDate(ref.date) : '?';
        out.push({
          key: `${stableId}|reschedule`,
          stableId,
          productCode,
          productName,
          description: `Rescheduled to ${fmtDate(m.rescheduledTo)} (was ${orig})`,
          onClear: () => clearReschedule(stableId),
        });
      }
      if (typeof m.editedQuantity === 'number') {
        const orig = ref?.quantity ?? '?';
        out.push({
          key: `${stableId}|qty`,
          stableId,
          productCode,
          productName,
          description: `Qty → ${m.editedQuantity} (was ${orig})`,
          onClear: () => clearEdit(stableId),
        });
      }
      if (typeof m.editedLeadTimeDays === 'number') {
        out.push({
          key: `${stableId}|leadtime`,
          stableId,
          productCode,
          productName,
          description: `Lead time → ${m.editedLeadTimeDays} days`,
          onClear: () => clearLeadTime(stableId),
        });
      }
      if (typeof m.editedStation === 'string' && m.editedStation) {
        const wasStation = ref?.station ? STATION_LABELS[ref.station as Station] : '?';
        const nowLabel = STATION_LABELS[m.editedStation as Station] ?? m.editedStation;
        out.push({
          key: `${stableId}|station`,
          stableId,
          productCode,
          productName,
          description: `Station → ${nowLabel} (was ${wasStation})`,
          onClear: () => clearStation(stableId),
        });
      }
    }
    // Phase 4l.8: manual activities (user-created via drag from Infeasible).
    for (const m of manualActivities) {
      out.push({
        key: `manual-${m.id}`,
        stableId: `manual|${m.id}`,
        productCode: m.productCode,
        productName: m.productName,
        description: `Manually scheduled ×${Math.round(m.quantity)} on ${fmtDate(m.date)} (${STATION_LABELS[m.station] ?? m.station})`,
        onClear: () => removeManualActivity(m.id),
      });
    }
    return out;
  }, [mutations, activitiesWithPo, manualActivities]);

  // Close the mutations dropdown on outside click.
  const mutationsDropdownRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!mutationsOpen) return;
    function onDocClick(e: MouseEvent) {
      const el = mutationsDropdownRef.current;
      if (el && !el.contains(e.target as Node)) setMutationsOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [mutationsOpen]);

  // Close the Tools dropdown on outside click (same pattern as mutations).
  const toolsDropdownRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!toolsOpen) return;
    function onDocClick(e: MouseEvent) {
      const el = toolsDropdownRef.current;
      if (el && !el.contains(e.target as Node)) setToolsOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [toolsOpen]);

  // Schedule conflicts: re-detect on every mutation change so dragging a
  // chip immediately surfaces (or clears) downstream dependency breaks.
  // Phase 4l.3: SOH-aware. The detector walks a per-ingredient SOH+supply
  // timeline so that consumers covered by existing stock aren't flagged just
  // because some later PO arrives late.
  const supplyQtyByActivity = useMemo<Record<string, number>>(() => {
    const out: Record<string, number> = {};
    for (const a of mutatedActivities) {
      // Yield applies to anything the kitchen produces, whether system-planned
      // (kitchen-required) or already entered in Unleashed (kitchen).
      if (a.kind !== 'kitchen-required' && a.kind !== 'kitchen') continue;
      const yieldRate = yieldRateByCode[a.productCode];
      if (typeof yieldRate === 'number' && yieldRate > 0 && yieldRate !== 1) {
        out[a.stableId] = a.quantity * yieldRate;
      }
      // No entry → detector defaults to a.quantity, which is correct when
      // yield is 1 or unknown. PO receipts likewise default to a.quantity.
    }
    return out;
  }, [mutatedActivities, yieldRateByCode]);

  const conflicts = useMemo<ScheduleConflict[]>(() => {
    const dismissedSet = new Set<string>();
    for (const a of activities) {
      if (isDismissed(mutations, a.stableId)) dismissedSet.add(a.stableId);
    }
    return detectScheduleConflicts({
      activities: mutatedActivities,
      consumesMap,
      dismissedStableIds: dismissedSet,
      initialSohByCode: conflictInitialSohByCode,
      consumesQtyMap,
      supplyQtyByActivity,
    });
  }, [
    mutatedActivities,
    consumesMap,
    mutations,
    activities,
    conflictInitialSohByCode,
    consumesQtyMap,
    supplyQtyByActivity,
  ]);

  // Index conflicts by stableId for fast chip-render lookup. A consumer can
  // have multiple conflicts (one per missing ingredient).
  const conflictsByConsumer = useMemo(() => {
    const out = new Map<string, ScheduleConflict[]>();
    for (const c of conflicts) {
      let arr = out.get(c.consumerStableId);
      if (!arr) {
        arr = [];
        out.set(c.consumerStableId, arr);
      }
      arr.push(c);
    }
    return out;
  }, [conflicts]);

  // ─── FIFO supply-allocation for arrow drawing (Phase 4l.6) ──
  // Phase 4l.12: extracted to `src/lib/engine/supply-allocator.ts` so
  // the server can also run the FIFO (Option 2 post-FIFO batch
  // redating). Behaviour identical to the previous inline implementation.
  type RelKind = 'supplier' | 'consumer';
  interface RelEntry {
    stableId: string;
    kind: RelKind;
    /** Phase 4l.11: phantom rel = consumer was starved (got 0 supply at
     * its scheduled date) but COULD have pulled from this supplier if
     * earlier consumers hadn't drained the pool first. Renderer draws
     * these dashed-red so the visual story stays honest about the
     * supply shortage rather than leaving the chip silently arrowless. */
    phantom?: boolean;
  }
  const relatedByStableId = useMemo<Map<string, RelEntry[]>>(() => {
    // Excluded set = dismissed chips (= no consumer or supplier role).
    const dismissedSet = new Set<string>();
    for (const a of mutatedActivities) {
      if (isDismissed(mutations, a.stableId)) dismissedSet.add(a.stableId);
    }
    const result = allocateSupplyFifo({
      activities: mutatedActivities.map((a) => ({
        stableId: a.stableId,
        productCode: a.productCode,
        kind: a.kind,
        date: a.date,
        finishDate: a.finishDate,
        quantity: a.quantity,
        profitPerItem: a.profitPerItem,
      })),
      excludedStableIds: dismissedSet,
      isConsumer: (a) =>
        a.kind === 'packaging' || a.kind === 'kitchen-required' || a.kind === 'kitchen',
      isSupplier: (a) => a.kind !== 'po-placed',
      consumesMap,
      consumesQtyMap,
      initialSohByCode: conflictInitialSohByCode,
      supplyQtyByActivity,
    });

    // Build bidirectional map, deduped (same pair can show up across
    // multiple ingredients when a product feeds via several pathways).
    // A real (non-phantom) allocation overrides a phantom one with the
    // same (from, to, kind) pair — phantom is the fallback for starved
    // consumers, real wins when both exist.
    const out = new Map<string, RelEntry[]>();
    const addRel = (
      from: string,
      to: string,
      kind: RelKind,
      phantom: boolean,
    ) => {
      let arr = out.get(from);
      if (!arr) { arr = []; out.set(from, arr); }
      const existing = arr.find((r) => r.stableId === to && r.kind === kind);
      if (existing) {
        if (existing.phantom && !phantom) existing.phantom = false;
        return;
      }
      arr.push({ stableId: to, kind, phantom });
    };
    for (const a of result.allocations) {
      addRel(a.consumerStableId, a.supplierStableId, 'supplier', a.phantom);
      addRel(a.supplierStableId, a.consumerStableId, 'consumer', a.phantom);
    }
    return out;
  }, [mutatedActivities, mutations, consumesMap, consumesQtyMap, supplyQtyByActivity, conflictInitialSohByCode]);

  // Phase 4l.12 — "supply-starved" chip flag. A chip is supply-starved
  // when at least one of its required ingredients has no real supplier
  // finishing in time (= a phantom incoming arrow). Such chips will
  // physically arrive at their production day with missing inputs and
  // won't actually run — surfacing this on the chip itself (not just
  // the arrow) helps the operator spot infeasible runs at a glance.
  //
  // Kitchen-required chips whose own production date is overdue often
  // create this cascade: the cascade tried to schedule a sub-
  // intermediate backwards from the consumer's required date, the
  // backoff went into the past, so the planner couldn't emit it in
  // time → its consumer reads as phantom.
  const supplyStarvedStableIds = useMemo<ReadonlySet<string>>(() => {
    const out = new Set<string>();
    for (const [stableId, rels] of relatedByStableId.entries()) {
      // Only flag consumers (chips with phantom INCOMING suppliers).
      // A chip whose OUTGOING consumers are phantoms is a different
      // issue (over-production / orphan supplier).
      for (const r of rels) {
        if (r.kind === 'supplier' && r.phantom) {
          out.add(stableId);
          break;
        }
      }
    }
    return out;
  }, [relatedByStableId]);

  // Currently-hovered chip — drives arrow drawing. null = no arrows.
  const [hoveredStableId, setHoveredStableId] = useState<string | null>(null);
  const onChipHover = useCallback((id: string | null) => {
    setHoveredStableId(id);
  }, []);

  // Phase 4l.12 — "view connected" focus mode. When set, the calendar
  // hides every chip except this stableId + its direct suppliers and
  // consumers (resolved via `relatedByStableId`). Toggled from the
  // drawer button next to the productCode; cleared via a banner at
  // the top of the calendar.
  const [focusedRelationsId, setFocusedRelationsId] = useState<string | null>(null);
  // Stable set of stableIds to keep visible when focused. The set is:
  //   1. The focused chip itself.
  //   2. Direct suppliers + consumers (depth-1 via FIFO allocations).
  //   3. EVERY other chip with the SAME productCode — past and future
  //      runs of the same SKU on the calendar, regardless of FIFO
  //      relation. This lets the operator see the full production
  //      lifecycle of a SKU (previous batches, current selection,
  //      upcoming batches) alongside the upstream/downstream chain.
  // Computed against `mutatedActivities` so it picks up the latest
  // mutation-applied dates / clusters.
  const focusedRelatedSet = useMemo<ReadonlySet<string> | null>(() => {
    if (!focusedRelationsId) return null;
    const out = new Set<string>([focusedRelationsId]);
    const rels = relatedByStableId.get(focusedRelationsId) ?? [];
    for (const r of rels) out.add(r.stableId);
    // Find the focused chip's productCode, then add every other chip
    // sharing it. Falls back to no-op if the focused id isn't found
    // (e.g. cluster member that got reshuffled).
    const focused = mutatedActivities.find((a) => a.stableId === focusedRelationsId);
    if (focused) {
      for (const a of mutatedActivities) {
        if (a.productCode === focused.productCode) out.add(a.stableId);
      }
    }
    return out;
  }, [focusedRelationsId, relatedByStableId, mutatedActivities]);

  // When "view connected" turns ON (transition from null → some id),
  // auto-enable every category/station toggle so the operator sees the
  // FULL connected set immediately. From that baseline, they can turn
  // individual layers off to narrow further (e.g. hide PO chips to
  // study the kitchen+packaging flow in isolation). Doesn't fire on
  // every render — only when the focus id changes from null to non-null.
  const prevFocusedRef = useRef<string | null>(null);
  // Phase 4l.14 — snapshot of the layer view taken when focus mode is
  // entered, so exiting "View connected" restores the operator's prior view
  // (e.g. PO hidden, bottlo-only) instead of leaving every layer revealed.
  const preFocusViewRef = useRef<{
    showPackaging: boolean;
    showKitchen: boolean;
    showKitchenScheduled: boolean;
    showKitchenRequired: boolean;
    showPO: boolean;
    showPoPlaced: boolean;
    showPoReceiving: boolean;
    showPoUrgent: boolean;
    visibleStations: Set<Station>;
  } | null>(null);
  useEffect(() => {
    const wasFocused = prevFocusedRef.current !== null;
    const isFocused = focusedRelationsId !== null;
    prevFocusedRef.current = focusedRelationsId;
    if (!wasFocused && isFocused) {
      // Entering focus: capture the current view, then reveal all layers so
      // the whole connected set is visible.
      preFocusViewRef.current = {
        showPackaging,
        showKitchen,
        showKitchenScheduled,
        showKitchenRequired,
        showPO,
        showPoPlaced,
        showPoReceiving,
        showPoUrgent,
        visibleStations: new Set(visibleStations),
      };
      setShowPackaging(true);
      setShowKitchen(true);
      setShowKitchenScheduled(true);
      setShowKitchenRequired(true);
      setShowPO(true);
      setShowPoPlaced(true);
      setShowPoReceiving(true);
      setShowPoUrgent(true);
      setVisibleStations(new Set(STATIONS));
    } else if (wasFocused && !isFocused) {
      // Exiting focus: restore the pre-focus view verbatim.
      const snap = preFocusViewRef.current;
      if (snap) {
        setShowPackaging(snap.showPackaging);
        setShowKitchen(snap.showKitchen);
        setShowKitchenScheduled(snap.showKitchenScheduled);
        setShowKitchenRequired(snap.showKitchenRequired);
        setShowPO(snap.showPO);
        setShowPoPlaced(snap.showPoPlaced);
        setShowPoReceiving(snap.showPoReceiving);
        setShowPoUrgent(snap.showPoUrgent);
        setVisibleStations(snap.visibleStations);
        preFocusViewRef.current = null;
      }
    }
    // Snapshot is read via closure at the focus transition (intentionally not
    // a dep — re-running on every toggle change would clobber the snapshot).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedRelationsId]);

  // Fast lookup for chips that the most-recent Resolve-all left unplaced.
  const unplaceableSet = useMemo(
    () => new Set(unplaceableIds),
    [unplaceableIds],
  );

  // Filter mutated activities through layer toggles + dismissal visibility.
  const visibleActivities = useMemo(() => {
    return mutatedActivities.filter((a) => {
      // Phase 4l.12 — "view connected" focus mode acts as an EXTRA
      // filter: a chip must be in the connected set AND pass the
      // standard layer toggles. When focus mode is activated, the
      // toggles are auto-enabled (see useEffect below) so the whole
      // connected set is visible by default — the user can then turn
      // individual layers off to narrow the view further (e.g. focus
      // on a chip and then hide the PO chain to study just the
      // kitchen/packaging flow).
      if (focusedRelatedSet && !focusedRelatedSet.has(a.stableId)) return false;
      // Category toggle (top-level): Packaging master / Kitchen master.
      if (a.kind === 'packaging' && !showPackaging) return false;
      if (a.kind === 'kitchen' && (!showKitchen || !showKitchenScheduled)) return false;
      if (a.kind === 'kitchen-required' && (!showKitchen || !showKitchenRequired)) return false;
      // PO master + sub-toggles (Phase 4l.8). A chip is visible iff:
      //   1. master `showPO` is on
      //   2. at least one of its applicable sub-toggles is on
      //      — `showPoPlaced` if kind=po-placed
      //      — `showPoReceiving` if kind=po-receiving
      //      — `showPoUrgent` if poInfo.overdue (additional overlay)
      if (a.kind === 'po-placed' || a.kind === 'po-receiving') {
        if (!showPO) return false;
        const isUrgent = a.poInfo?.overdue === true;
        const matchesKind =
          (a.kind === 'po-placed' && showPoPlaced) ||
          (a.kind === 'po-receiving' && showPoReceiving);
        const matchesUrgent = isUrgent && showPoUrgent;
        if (!matchesKind && !matchesUrgent) return false;
      }
      // Per-station toggle within packaging
      if (a.kind === 'packaging' && a.station && !visibleStations.has(a.station)) return false;
      if (!showDismissed && isDismissed(mutations, a.stableId)) return false;
      // Phase 4l.10: a packaging chip capped to zero by upstream supply is
      // treated functionally like dismissed — hidden behind the "Show
      // dismissed" toggle so the operator can see what got bumped.
      if (
        !showDismissed &&
        a.kind === 'packaging' &&
        a.supplyCappedFrom !== undefined &&
        a.quantity <= 0
      ) {
        return false;
      }
      return true;
    });
  }, [
    mutatedActivities,
    visibleStations,
    showPackaging,
    showKitchen,
    showKitchenScheduled,
    showPoPlaced,
    showPoReceiving,
    showPoUrgent,
    showKitchenRequired,
    showPO,
    mutations,
    showDismissed,
    focusedRelatedSet,
  ]);

  const activitiesByDate = useMemo(() => {
    const grouped = groupByDate(visibleActivities);
    // Phase 4l.11/4l.12 — sort each day's chips into three layers
    // (packaging → kitchen → po) and then by total chip profit
    // (profitPerItem × quantity) descending within each layer.
    //
    // 4l.12: distinguish "missing profit data" from "zero profit".
    // Previously both treated `profitPerItem ?? 0` → zero → sunk to
    // the bottom of the layer. Now missing-data chips sit ABOVE zero
    // chips (they might be high-value but we don't know) and BELOW
    // chips with known positive profit. Within the missing-data tier
    // we use the global median chip profit as a heuristic position so
    // a 1000-unit run isn't ranked next to a 50-unit one. Tiebreak by
    // productCode for determinism.
    const layerOf = (a: CalendarActivity): number => {
      if (a.kind === 'packaging') return 0;
      if (a.kind === 'kitchen' || a.kind === 'kitchen-required') return 1;
      return 2; // po-placed, po-receiving
    };
    // Compute a median profit-per-item across packaging chips with
    // known profit so we can place missing-data chips at a reasonable
    // tier within their layer.
    const knownPpi: number[] = [];
    for (const list of grouped.values()) {
      for (const a of list) {
        if (a.profitPerItem != null && Number.isFinite(a.profitPerItem) && a.profitPerItem > 0) {
          knownPpi.push(a.profitPerItem);
        }
      }
    }
    knownPpi.sort((x, y) => x - y);
    const medianPpi =
      knownPpi.length > 0 ? knownPpi[Math.floor(knownPpi.length / 2)] : 0;
    const chipSortValue = (a: CalendarActivity): number => {
      if (a.profitPerItem != null && Number.isFinite(a.profitPerItem)) {
        // Known data — including zero/negative (real claim).
        return a.profitPerItem * a.quantity;
      }
      // Missing data — assume median profit-per-item but penalise
      // slightly so known-positive chips outrank unknown ones at
      // similar scale.
      return medianPpi * a.quantity * 0.9;
    };
    for (const list of grouped.values()) {
      list.sort((a, b) => {
        const la = layerOf(a);
        const lb = layerOf(b);
        if (la !== lb) return la - lb;
        const av = chipSortValue(a);
        const bv = chipSortValue(b);
        if (bv !== av) return bv - av;
        return a.productCode.localeCompare(b.productCode);
      });
    }
    return grouped;
  }, [visibleActivities]);

  // ─── Phase 4l.11: per-product inventory timeline ───────────
  // Walk each product's inventory day-by-day across the horizon.
  // Drives the SVG sparkline overlay on every chip kind (packaging,
  // kitchen, kitchen-required, po-placed, po-receiving).
  //
  // Inventory model per day:
  //   inv[day] = inv[day-1]
  //              + supply events landing on `day` (packaging output,
  //                kitchen output, PO arrivals)
  //              − daily demand for this product, which is the sum of:
  //                  • forecast demand spread over 7 (packaging FGs)
  //                  • BOM-driven demand: any consumer chip on `day`
  //                    contributes consumer.qty × bom_ratio
  // Floored at 0 (negative = unmet demand → conflict-detector territory).
  //
  // Initial SOH: prefers `initialInventoryByProduct` (= what the planner
  // used for FGs). Falls back to `sohByProductCode` summed across all
  // warehouses for intermediates / raw materials.
  const inventoryTimelineByProduct = useMemo(() => {
    const out = new Map<
      string,
      {
        byDate: Map<string, number>;
        shortageByDate: Map<string, number>;
        /** Phase 4l.12: per-day target SOH floor (= SOH_FLOOR_DAYS of
         *  forward demand at that day's local demand rate). Used to draw
         *  a dashed reference line on each chip's inventory sparkline. */
        floorByDate: Map<string, number>;
        peak: number;
        peakShortage: number;
      }
    >();
    const horizonStart = horizon.startWeek;
    const horizonDays = horizon.weeks * 7;
    // Supply events: packaging output, kitchen output, PO arrivals.
    const productionByCodeDate = new Map<string, Map<string, number>>();
    // BOM-driven consumer demand: per consumer chip, for each ingredient,
    // add (consumer.qty × ratio) to that ingredient on the consumer's date.
    const consumerDemandByCodeDate = new Map<string, Map<string, number>>();
    for (const a of mutatedActivities) {
      if (isDismissed(mutations, a.stableId)) continue;
      // Supply contributions
      if (
        a.kind === 'packaging' ||
        a.kind === 'kitchen' ||
        a.kind === 'kitchen-required' ||
        a.kind === 'po-receiving'
      ) {
        let m = productionByCodeDate.get(a.productCode);
        if (!m) {
          m = new Map();
          productionByCodeDate.set(a.productCode, m);
        }
        m.set(a.date, (m.get(a.date) ?? 0) + a.quantity);
      }
      // Demand contributions (consumer pulls from its ingredients)
      if (a.kind === 'packaging' || a.kind === 'kitchen-required') {
        const consumes = consumesQtyMap[a.productCode];
        if (consumes) {
          for (const [ingredient, ratio] of Object.entries(consumes)) {
            const amount = a.quantity * ratio;
            if (amount <= 0) continue;
            let m = consumerDemandByCodeDate.get(ingredient);
            if (!m) {
              m = new Map();
              consumerDemandByCodeDate.set(ingredient, m);
            }
            m.set(a.date, (m.get(a.date) ?? 0) + amount);
          }
        }
      }
    }
    // Every code that appears in forecast, production, or BOM demand.
    const allCodes = new Set<string>([
      ...Object.keys(weeklyDemandByProduct),
      ...productionByCodeDate.keys(),
      ...consumerDemandByCodeDate.keys(),
    ]);
    const startDate = fromISO(horizonStart);
    for (const code of allCodes) {
      // Daily demand = forecast (per 7-day week) + BOM-driven consumer demand.
      const dailyDemand = new Map<string, number>();
      for (const w of weeklyDemandByProduct[code] ?? []) {
        const wDate = fromISO(w.weekStart);
        const perDay = w.quantity / 7;
        for (let i = 0; i < 7; i++) {
          const d = new Date(wDate);
          d.setDate(wDate.getDate() + i);
          const iso = toISO(d);
          dailyDemand.set(iso, (dailyDemand.get(iso) ?? 0) + perDay);
        }
      }
      const consumerDemand = consumerDemandByCodeDate.get(code);
      if (consumerDemand) {
        for (const [date, qty] of consumerDemand.entries()) {
          dailyDemand.set(date, (dailyDemand.get(date) ?? 0) + qty);
        }
      }
      const productionByDate = productionByCodeDate.get(code) ?? new Map();
      // Initial SOH: prefer planner's value, fall back to summed warehouse SOH.
      let initial = initialInventoryByProduct[code] ?? 0;
      if (initial === 0 && sohByProductCode[code]) {
        for (const qty of Object.values(sohByProductCode[code])) {
          initial += qty;
        }
      }
      let inv = initial;
      let peak = inv;
      let peakShortage = 0;
      const byDate = new Map<string, number>();
      const shortageByDate = new Map<string, number>();
      // Phase 4l.12: floor target per day = `SOH_FLOOR_DAYS` × daily
      // demand rate on that day. Mirrors the DP's per-week floor target
      // but at daily granularity. Falls back to 0 on days with no
      // demand data.
      const floorByDate = new Map<string, number>();
      const cursor = new Date(startDate);
      for (let i = 0; i < horizonDays; i++) {
        const iso = toISO(cursor);
        inv += productionByDate.get(iso) ?? 0;
        if (inv > peak) peak = inv;
        inv -= dailyDemand.get(iso) ?? 0;
        if (inv >= 0) {
          byDate.set(iso, inv);
          shortageByDate.set(iso, 0);
        } else {
          // Demand exceeded supply on this day. Carry the deficit forward
          // (= a real backlog: future supply must pay down the debt before
          // building positive inventory again). The inverted sparkline
          // shows the magnitude of this debt over time.
          const shortage = -inv;
          byDate.set(iso, 0);
          shortageByDate.set(iso, shortage);
          if (shortage > peakShortage) peakShortage = shortage;
        }
        const dailyRate = dailyDemand.get(iso) ?? 0;
        floorByDate.set(iso, dailyRate * SOH_FLOOR_DAYS);
        cursor.setDate(cursor.getDate() + 1);
      }
      if (peak > 0 || peakShortage > 0) {
        out.set(code, { byDate, shortageByDate, floorByDate, peak, peakShortage });
      }
    }
    return out;
  }, [
    mutatedActivities,
    mutations,
    weeklyDemandByProduct,
    initialInventoryByProduct,
    sohByProductCode,
    consumesQtyMap,
    horizon,
  ]);

  // ─── Phase 4l.11 — per-chip availability sample arrays ─────
  // For each packaging chip, build a daily inventory-ratio array
  // spanning horizon start → horizon end. The chip's BG renders as a
  // multi-stop gradient using these samples — one stop per day. Sharp
  // inventory transitions (batch landings) appear as sharp colour
  // steps; gradual drain days fade smoothly. Same product → same
  // gradient (the inventory journey is shared); the chip's calendar
  // position tells you WHICH batch within the journey.
  //
  // Index 0 = horizon start SOH ratio. Each subsequent index = next day
  // end-of-day inventory ÷ peak. Floor of 0 → pale; peak → vivid.
  const chipAvailabilityByStableId = useMemo(() => {
    const out = new Map<
      string,
      {
        ratios: number[];
        shortageRatios: number[] | null;
        floorRatios: number[] | null;
        chipDateIndex: number;
        /** Phase 4l.12 — absolute projected stock-on-hand at this chip's
         *  date (end-of-day inventory from the timeline). For future
         *  chips this is the PREDICTED SOH; for the first day it's the
         *  current SOH baseline. null when the product has no timeline. */
        predictedSoh: number | null;
        /** Phase 4l.12 — days of forward demand the predicted SOH covers
         *  (= SOH ÷ daily demand rate at the chip's date). null when the
         *  product has no demand on/around that date (infinite cover). */
        availableDays: number | null;
      }
    >();
    const horizonStart = fromISO(horizon.startWeek);
    const horizonDays = horizon.weeks * 7;
    // Pre-compute per-product ratio arrays once. Inventory normalised to
    // peak; shortage normalised independently to peakShortage so the
    // inverted line shows the relative severity of the deficit period.
    // Phase 4l.12: floor normalised to the SAME peak as inventory so the
    // reference line sits at its true relative height on the sparkline.
    const ratiosByProduct = new Map<
      string,
      { ratios: number[]; shortageRatios: number[] | null; floorRatios: number[] | null }
    >();
    for (const [code, timeline] of inventoryTimelineByProduct.entries()) {
      const peak = timeline.peak;
      const peakShortage = timeline.peakShortage;
      if (peak <= 0 && peakShortage <= 0) continue;
      const ratios: number[] = [];
      const shortageRatios: number[] = [];
      const floorRatios: number[] = [];
      // Index 0 = horizon start (initial SOH baseline, no shortage yet).
      const initialInv = initialInventoryByProduct[code] ?? 0;
      ratios.push(peak > 0 ? Math.max(0, Math.min(1, initialInv / peak)) : 0);
      shortageRatios.push(0);
      // Floor at index 0 — peek at day 0's daily-demand to derive the
      // initial floor reference (matches the per-day computation below).
      const day0Iso = toISO(horizonStart);
      const day0Floor = timeline.floorByDate.get(day0Iso) ?? 0;
      floorRatios.push(peak > 0 ? Math.max(0, Math.min(1, day0Floor / peak)) : 0);
      // Indices 1..horizonDays = end-of-day inventory / shortage per day.
      const cursor = new Date(horizonStart);
      let anyFloor = day0Floor > 0;
      for (let i = 0; i < horizonDays; i++) {
        const iso = toISO(cursor);
        const inv = timeline.byDate.get(iso) ?? 0;
        const sh = timeline.shortageByDate.get(iso) ?? 0;
        const fl = timeline.floorByDate.get(iso) ?? 0;
        if (fl > 0) anyFloor = true;
        ratios.push(peak > 0 ? Math.max(0, Math.min(1, inv / peak)) : 0);
        shortageRatios.push(
          peakShortage > 0 ? Math.max(0, Math.min(1, sh / peakShortage)) : 0,
        );
        floorRatios.push(peak > 0 ? Math.max(0, Math.min(1, fl / peak)) : 0);
        cursor.setDate(cursor.getDate() + 1);
      }
      ratiosByProduct.set(code, {
        ratios,
        shortageRatios: peakShortage > 0 ? shortageRatios : null,
        floorRatios: anyFloor ? floorRatios : null,
      });
    }
    // Every chip kind (packaging, kitchen, kitchen-required, po-placed,
    // po-receiving) gets its product's full ratio array plus the index
    // within that array corresponding to its own date (for the vertical
    // marker on the sparkline). Kitchen chips trace the intermediate's
    // inventory curve; PO chips trace the raw material's.
    for (const a of mutatedActivities) {
      const entry = ratiosByProduct.get(a.productCode);
      if (!entry) continue;
      const chipDay = fromISO(a.date);
      const daysFromStart = Math.round(
        (chipDay.getTime() - horizonStart.getTime()) / 86400000,
      );
      const chipDateIndex = Math.max(
        0,
        Math.min(entry.ratios.length - 1, daysFromStart),
      );
      // Absolute projected SOH + available days at the chip's date.
      const timeline = inventoryTimelineByProduct.get(a.productCode);
      let predictedSoh: number | null = null;
      let availableDays: number | null = null;
      if (timeline) {
        const iso = a.date;
        // End-of-day inventory at the chip's date. Index 0 (horizon
        // start) falls back to the initial SOH baseline.
        predictedSoh =
          timeline.byDate.get(iso) ??
          (initialInventoryByProduct[a.productCode] ?? 0);
        // Daily demand rate = floor ÷ SOH_FLOOR_DAYS (floor was
        // computed as dailyRate × SOH_FLOOR_DAYS). 0 → no demand → leave
        // availableDays null ("infinite" cover, shown as "—").
        const floor = timeline.floorByDate.get(iso) ?? 0;
        const dailyRate = floor / SOH_FLOOR_DAYS;
        if (dailyRate > 0 && predictedSoh != null) {
          availableDays = predictedSoh / dailyRate;
        }
      }
      out.set(a.stableId, {
        ratios: entry.ratios,
        shortageRatios: entry.shortageRatios,
        floorRatios: entry.floorRatios,
        chipDateIndex,
        predictedSoh,
        availableDays,
      });
    }
    return out;
  }, [
    mutatedActivities,
    inventoryTimelineByProduct,
    initialInventoryByProduct,
    horizon,
  ]);

  // ─── Finished-goods summary (Phase 4l.13) ──────────────────
  // One row per FG product code the planner has assessed (i.e. produced
  // packaging chips for, active OR dismissed). Surfaces current SOH,
  // forward-cover days, a horizon-spanning sparkline and any predicted
  // stockouts so the operator can see at a glance which FGs are at risk.
  const finishedGoodsSummary = useMemo(() => {
    const byCode = new Map<
      string,
      {
        code: string;
        name: string;
        currentSoh: number;
        peak: number;
        ratios: number[];
        floorRatios: number[] | null;
        stockoutIndices: number[];
        firstStockoutDate: string | null;
        dailyRate: number;
        availableDays: number | null;
        activeChips: number;
        dismissedChips: number;
        // Net change across the horizon (end-of-horizon − start) so we can
        // tell at a glance whether the planner's runs cover demand or
        // not. Negative = depleting; positive = building.
        netChange: number;
        // The packaging chips the planner has produced for this FG.
        // Surfaced via the Status-column tooltip so the operator can see
        // exactly which runs make up the active/dismissed totals — and
        // whether each chip is an Unleashed assembly (carries assemblyNumber)
        // or planner-emitted (no assemblyNumber).
        activities: {
          stableId: string;
          date: string;
          quantity: number;
          dismissed: boolean;
          station: string | null;
          assemblyNumber: string | null;
        }[];
        /** True when the FG is allowlisted but has no BOM → planner can't
         *  schedule it. Surfaced as the "Unplanned" filter / badge. */
        isUnplanned: boolean;
      }
    >();
    const horizonStart = fromISO(horizon.startWeek);
    const horizonDays = horizon.weeks * 7;

    // Collect codes from every packaging chip — active and dismissed —
    // because "assessed by the planner" includes the ones the operator
    // has chosen to skip. Tally each + retain per-chip detail.
    const chipStats = new Map<string, {
      active: number;
      dismissed: number;
      name: string;
      activities: {
        stableId: string;
        date: string;
        quantity: number;
        dismissed: boolean;
        station: string | null;
        assemblyNumber: string | null;
      }[];
    }>();
    for (const a of mutatedActivities) {
      if (a.kind !== 'packaging') continue;
      let stat = chipStats.get(a.productCode);
      if (!stat) {
        stat = { active: 0, dismissed: 0, name: a.productName || a.productCode, activities: [] };
        chipStats.set(a.productCode, stat);
      }
      const dismissed = isDismissed(mutations, a.stableId);
      if (dismissed) stat.dismissed += 1;
      else stat.active += 1;
      stat.activities.push({
        stableId: a.stableId,
        date: a.date,
        quantity: a.quantity,
        dismissed,
        station: a.station ?? null,
        // Unleashed-sourced chips carry assemblyNumber set by the routing
        // pass in page.tsx. Planner-emitted chips leave it undefined.
        assemblyNumber: a.assemblyNumber ?? null,
      });
    }

    for (const [code, stat] of chipStats.entries()) {
      const timeline = inventoryTimelineByProduct.get(code);
      const currentSoh = initialInventoryByProduct[code] ?? 0;
      const peak = timeline?.peak ?? Math.max(currentSoh, 0);

      // Build a normalised ratio series for the sparkline.
      const ratios: number[] = [];
      const floorRatios: number[] = [];
      const stockoutIndices: number[] = [];
      let firstStockoutDate: string | null = null;
      let anyFloor = false;
      let endOfHorizonSoh = currentSoh;

      ratios.push(peak > 0 ? Math.max(0, Math.min(1, currentSoh / peak)) : 0);
      const day0Iso = toISO(horizonStart);
      const day0Floor = timeline?.floorByDate.get(day0Iso) ?? 0;
      if (day0Floor > 0) anyFloor = true;
      floorRatios.push(peak > 0 ? Math.max(0, Math.min(1, day0Floor / peak)) : 0);

      const cursor = new Date(horizonStart);
      for (let i = 0; i < horizonDays; i++) {
        const iso = toISO(cursor);
        const inv = timeline?.byDate.get(iso) ?? currentSoh;
        const sh = timeline?.shortageByDate.get(iso) ?? 0;
        const fl = timeline?.floorByDate.get(iso) ?? 0;
        if (fl > 0) anyFloor = true;
        ratios.push(peak > 0 ? Math.max(0, Math.min(1, inv / peak)) : 0);
        floorRatios.push(peak > 0 ? Math.max(0, Math.min(1, fl / peak)) : 0);
        // Stockout day: unmet demand recorded → inventory hit zero with
        // demand still pulling. Index is i+1 because ratios[0] is the
        // baseline before day 0.
        if (sh > 0) {
          stockoutIndices.push(i + 1);
          if (firstStockoutDate == null) firstStockoutDate = iso;
        }
        endOfHorizonSoh = inv;
        cursor.setDate(cursor.getDate() + 1);
      }

      // Daily rate from day-0 floor (matches the chip-availability calc).
      const dailyRate = day0Floor / SOH_FLOOR_DAYS;
      const availableDays = dailyRate > 0 ? currentSoh / dailyRate : null;

      byCode.set(code, {
        code,
        name: stat.name,
        currentSoh,
        peak,
        ratios,
        floorRatios: anyFloor ? floorRatios : null,
        stockoutIndices,
        firstStockoutDate,
        dailyRate,
        availableDays,
        activeChips: stat.active,
        dismissedChips: stat.dismissed,
        netChange: endOfHorizonSoh - currentSoh,
        // Sort by date so the tooltip reads chronologically.
        activities: stat.activities.sort((x, y) => x.date.localeCompare(y.date)),
        isUnplanned: false,
      });
    }

    // Append unplanned FGs — allowlisted SKUs the planner couldn't schedule
    // because no BOM exists. Stub rows with zeroed projection data so they
    // sort/render without breaking the sparkline maths.
    for (const code of unplannedFinishedGoods) {
      if (byCode.has(code)) continue; // shouldn't happen — defensive
      const currentSoh = initialInventoryByProduct[code] ?? 0;
      byCode.set(code, {
        code,
        name: code, // No BOM → no name lookup. Code is identifying enough.
        currentSoh,
        peak: Math.max(currentSoh, 0),
        ratios: [],
        floorRatios: null,
        stockoutIndices: [],
        firstStockoutDate: null,
        dailyRate: 0,
        availableDays: null,
        activeChips: 0,
        dismissedChips: 0,
        netChange: 0,
        activities: [],
        isUnplanned: true,
      });
    }

    // Sort: stockouts first (earliest stockout date wins), then by
    // available-days ascending (lowest cover first), then alpha.
    return Array.from(byCode.values()).sort((a, b) => {
      if ((a.stockoutIndices.length > 0) !== (b.stockoutIndices.length > 0)) {
        return a.stockoutIndices.length > 0 ? -1 : 1;
      }
      if (a.firstStockoutDate && b.firstStockoutDate) {
        const c = a.firstStockoutDate.localeCompare(b.firstStockoutDate);
        if (c !== 0) return c;
      }
      const aDays = a.availableDays ?? Number.POSITIVE_INFINITY;
      const bDays = b.availableDays ?? Number.POSITIVE_INFINITY;
      if (aDays !== bDays) return aDays - bDays;
      return a.code.localeCompare(b.code);
    });
  }, [
    mutatedActivities,
    mutations,
    inventoryTimelineByProduct,
    initialInventoryByProduct,
    unplannedFinishedGoods,
    horizon,
  ]);

  // Phase 4l.14 — stableIds with at least one active schedule conflict, for
  // the FG drawer's limiting-factors flags.
  const conflictedStableIds = useMemo(() => {
    const s = new Set<string>();
    for (const [id, list] of conflictsByConsumer) if (list.length > 0) s.add(id);
    return s;
  }, [conflictsByConsumer]);

  // Phase 4l.14 — per-intermediate scheduled supply (kitchen + kitchen-
  // required runs), for the FG drawer's limiting-factors view. Tells the
  // operator how much of each consumed intermediate the planner is making
  // and when the first run lands.
  const intermediateSupplyByCode = useMemo(() => {
    const m = new Map<string, { runs: number; totalQty: number; firstDate: string | null }>();
    for (const a of mutatedActivities) {
      if (a.kind !== 'kitchen' && a.kind !== 'kitchen-required') continue;
      if (isDismissed(mutations, a.stableId)) continue;
      const e = m.get(a.productCode) ?? { runs: 0, totalQty: 0, firstDate: null };
      e.runs += 1;
      e.totalQty += a.quantity;
      if (!e.firstDate || a.date < e.firstDate) e.firstDate = a.date;
      m.set(a.productCode, e);
    }
    return m;
  }, [mutatedActivities, mutations]);

  // ─── Cluster computation (Phase 4l.6) ──────────────────────
  // Two or more visible chips sharing (date, productCode, kind) collapse
  // into one ClusterChip on the calendar. We compute the membership map
  // once so each cell, each constituent's hover/select state and the
  // drawer can look up siblings cheaply.
  const clusterMembersByStableId = useMemo<Map<string, CalendarActivity[]>>(() => {
    const groups = new Map<string, CalendarActivity[]>();
    for (const a of visibleActivities) {
      const key = `${a.date}|${a.kind}|${a.productCode}`;
      let arr = groups.get(key);
      if (!arr) { arr = []; groups.set(key, arr); }
      arr.push(a);
    }
    const out = new Map<string, CalendarActivity[]>();
    for (const arr of groups.values()) {
      if (arr.length < 2) continue;
      for (const a of arr) out.set(a.stableId, arr);
    }
    return out;
  }, [visibleActivities]);

  // Aggregate per-day load across visible stations, EXCLUDING dismissed
  // activities and using the MUTATED activities (so reschedule and edit
  // both flow through to the badges).
  const peakLoadByDate = useMemo(() => {
    type Bucket = { usedMinutes: number; capacityMinutes: number; station: Station };
    const perDayPerStation = new Map<string, Map<Station, number>>();
    for (const a of mutatedActivities) {
      // Load is a packaging-station concept; kitchen activities don't have
      // a station capacity in this model.
      if (a.kind !== 'packaging' || !a.station) continue;
      if (!showPackaging) continue;
      if (!visibleStations.has(a.station)) continue;
      if (isDismissed(mutations, a.stableId)) continue;
      let stationMap = perDayPerStation.get(a.date);
      if (!stationMap) {
        stationMap = new Map();
        perDayPerStation.set(a.date, stationMap);
      }
      stationMap.set(
        a.station,
        (stationMap.get(a.station) ?? 0) + a.durationMinutes + a.changeoverMinutes,
      );
    }
    const out = new Map<string, Bucket & { utilisation: number }>();
    for (const [date, stationMap] of perDayPerStation.entries()) {
      let peak: (Bucket & { utilisation: number }) | null = null;
      for (const [station, used] of stationMap.entries()) {
        const cap = stationDailyMinutes[station] ?? 480;
        const util = cap > 0 ? used / cap : 0;
        if (!peak || util > peak.utilisation) {
          peak = { usedMinutes: used, capacityMinutes: cap, station, utilisation: util };
        }
      }
      if (peak) out.set(date, peak);
    }
    return out;
  }, [mutatedActivities, visibleStations, showPackaging, mutations, stationDailyMinutes]);

  // Per-day kitchen-team load (Phase 4l.7 + 4l.8 per-recipe). Mirrors the
  // kitchen capacity model the resolver uses: each kitchen-required chip
  // costs `kitchenMinutesByProductCode[code] ?? KITCHEN_DEFAULT_CHIP_MINUTES`
  // on its start day. Respects the kitchen visibility toggles so hiding
  // kitchen-required chips clears their load contribution.
  const kitchenLoadByDate = useMemo(() => {
    const out = new Map<string, { usedMinutes: number; capacityMinutes: number; utilisation: number }>();
    if (!showKitchen || !showKitchenRequired) return out;
    const used = new Map<string, number>();
    for (const a of mutatedActivities) {
      if (a.kind !== 'kitchen-required') continue;
      if (isDismissed(mutations, a.stableId)) continue;
      // Phase 4l.10: prefer per-chip minutes (computed server-side from
      // recipe × quantity). Fallback to map-by-code, then to default.
      const cost =
        a.kitchenMinutes ??
        kitchenMinutesByProductCode[a.productCode] ??
        KITCHEN_DEFAULT_CHIP_MINUTES;
      used.set(a.date, (used.get(a.date) ?? 0) + cost);
    }
    for (const [date, mins] of used.entries()) {
      out.set(date, {
        usedMinutes: mins,
        capacityMinutes: KITCHEN_DAILY_MINUTES,
        utilisation: KITCHEN_DAILY_MINUTES > 0 ? mins / KITCHEN_DAILY_MINUTES : 0,
      });
    }
    return out;
  }, [mutatedActivities, mutations, showKitchen, showKitchenRequired, kitchenMinutesByProductCode]);

  // Phase 4l.10 — per-day dehydrator-tray load. Each kitchen chip whose
  // recipe has dehydHours > 0 carries `dehydratorTrays` and a calendar-
  // day window `[dehydratorOccupiesFrom, dehydratorOccupiesTo]`. The
  // dehydrator equipment runs through weekends, so we charge every day
  // in that window — not just workdays. Utilisation = sum trays / pool
  // (~605 from the Kitchen capacities sheet).
  const dehydratorLoadByDate = useMemo(() => {
    const out = new Map<
      string,
      { usedTrays: number; capacityTrays: number; utilisation: number }
    >();
    if (dehydratorTotalTrays <= 0) return out;
    const trayUsed = new Map<string, number>();
    for (const a of mutatedActivities) {
      if (a.kind !== 'kitchen-required' && a.kind !== 'kitchen') continue;
      if (isDismissed(mutations, a.stableId)) continue;
      const trays = a.dehydratorTrays;
      if (!trays || trays <= 0) continue;
      const from = a.dehydratorOccupiesFrom;
      const to = a.dehydratorOccupiesTo;
      if (!from || !to) continue;
      // Walk every calendar day in [from, to] inclusive.
      const fromDate = new Date(from + 'T00:00:00');
      const toDate = new Date(to + 'T00:00:00');
      const cursor = new Date(fromDate);
      while (cursor.getTime() <= toDate.getTime()) {
        const iso = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`;
        trayUsed.set(iso, (trayUsed.get(iso) ?? 0) + trays);
        cursor.setDate(cursor.getDate() + 1);
      }
    }
    for (const [date, trays] of trayUsed.entries()) {
      out.set(date, {
        usedTrays: trays,
        capacityTrays: dehydratorTotalTrays,
        utilisation: trays / dehydratorTotalTrays,
      });
    }
    return out;
  }, [mutatedActivities, mutations, dehydratorTotalTrays]);

  // Per-station counts (for the chip labels in the rail) — count BEFORE
  // filtering so the user can see what they'd un-hide. Kitchen activities
  // (station=null) don't contribute to packaging-station counts.
  const stationCounts = useMemo(() => {
    const counts: Record<Station, number> = {
      'hand-packing': 0,
      elephant: 0,
      dust: 0,
      bottlo: 0,
    };
    for (const a of activities) {
      if (a.kind === 'packaging' && a.station) counts[a.station] += 1;
    }
    return counts;
  }, [activities]);

  // Build the date grid: planner's horizon plus an optional backward
  // extension when `planFromDate` is in the future (Phase 4l.8). The
  // extension shows the weeks between real-today's Monday and the
  // planner's anchor, so chips can be dragged backwards onto today even
  // though the planner itself isn't scheduling anything there.
  const dates = useMemo(() => {
    // Monday on or before `realToday`. Day-of-week: 0=Sun,1=Mon,...,6=Sat.
    const [y, m, d] = realToday.split('-').map(Number);
    const rt = new Date(y, m - 1, d);
    const back = (rt.getDay() + 6) % 7; // Mon → 0, ..., Sun → 6
    rt.setDate(rt.getDate() - back);
    const realTodayMonday = toLocalISODate(rt);

    if (realTodayMonday >= horizon.startWeek) {
      // Planner anchor is on or before real today — no backward extension.
      return horizonDates(horizon.startWeek, horizon.weeks);
    }
    // Extend backwards: compute extra weeks between real-today's Monday and
    // the planner's start week.
    const startMs = rt.getTime();
    const [hy, hm, hd] = horizon.startWeek.split('-').map(Number);
    const horizonStart = new Date(hy, hm - 1, hd);
    const diffWeeks = Math.round(
      (horizonStart.getTime() - startMs) / (1000 * 60 * 60 * 24 * 7),
    );
    return horizonDates(realTodayMonday, horizon.weeks + diffWeeks);
  }, [horizon, realToday]);

  // Per-week per-station utilisation, from mutated activities. Used by the
  // capacity heatmap panel below the calendar. For each (week, station)
  // we surface the PEAK day utilisation in that week (overruns are what
  // matter most operationally); the tooltip shows the weekly total minutes.
  // The kitchen row is computed alongside using the same constants the
  // resolver uses (one source of truth for kitchen load).
  const heatmapByWeek = useMemo(() => {
    type Cell = { peakUtilisation: number; totalMinutes: number };
    const usedByDateStation = new Map<string, Map<Station, number>>();
    const usedByDateKitchen = new Map<string, number>();
    for (const a of mutatedActivities) {
      if (isDismissed(mutations, a.stableId)) continue;
      if (a.kind === 'packaging' && a.station) {
        let stMap = usedByDateStation.get(a.date);
        if (!stMap) {
          stMap = new Map();
          usedByDateStation.set(a.date, stMap);
        }
        stMap.set(a.station, (stMap.get(a.station) ?? 0) + a.durationMinutes + a.changeoverMinutes);
      } else if (a.kind === 'kitchen-required') {
        // Phase 4l.10: prefer per-chip minutes (quantity-aware).
        const cost =
          a.kitchenMinutes ??
          kitchenMinutesByProductCode[a.productCode] ??
          KITCHEN_DEFAULT_CHIP_MINUTES;
        usedByDateKitchen.set(
          a.date,
          (usedByDateKitchen.get(a.date) ?? 0) + cost,
        );
      }
    }
    const weekStarts: string[] = [];
    {
      const start = fromISO(horizon.startWeek);
      for (let i = 0; i < horizon.weeks; i++) {
        const d = new Date(start);
        d.setDate(start.getDate() + i * 7);
        weekStarts.push(toISO(d));
      }
    }
    const out = new Map<string, Map<Station, Cell>>();
    const kitchenByWeek = new Map<string, Cell>();
    for (const ws of weekStarts) {
      const stationMap = new Map<Station, Cell>();
      const days: string[] = [];
      const monday = fromISO(ws);
      for (let i = 0; i < 5; i++) {
        const d = new Date(monday);
        d.setDate(monday.getDate() + i);
        days.push(toISO(d));
      }
      for (const station of STATIONS) {
        let peakUtil = 0;
        let totalMin = 0;
        const cap = stationDailyMinutes[station] ?? 480;
        for (const d of days) {
          const used = usedByDateStation.get(d)?.get(station) ?? 0;
          totalMin += used;
          const util = cap > 0 ? used / cap : 0;
          if (util > peakUtil) peakUtil = util;
        }
        stationMap.set(station, { peakUtilisation: peakUtil, totalMinutes: totalMin });
      }
      // Commit this week's per-station map into `out`. Without this the
      // packaging row of the heatmap renders as all-idle even when chips
      // are saturating the stations (kitchen row was unaffected because
      // it has its own per-week map).
      out.set(ws, stationMap);
      // Kitchen-team row: peak day utilisation across the working week.
      let kPeak = 0;
      let kTotal = 0;
      for (const d of days) {
        const used = usedByDateKitchen.get(d) ?? 0;
        kTotal += used;
        const util = KITCHEN_DAILY_MINUTES > 0 ? used / KITCHEN_DAILY_MINUTES : 0;
        if (util > kPeak) kPeak = util;
      }
      kitchenByWeek.set(ws, { peakUtilisation: kPeak, totalMinutes: kTotal });
    }
    return { weekStarts, byWeek: out, kitchenByWeek };
  }, [mutatedActivities, mutations, horizon, stationDailyMinutes, kitchenMinutesByProductCode]);

  // Group dates into months for section headers.
  const monthGroups = useMemo(() => {
    const groups: { monthKey: string; label: string; dates: string[] }[] = [];
    let currentKey: string | null = null;
    for (const iso of dates) {
      const d = fromISO(iso);
      const key = `${d.getFullYear()}-${d.getMonth()}`;
      if (key !== currentKey) {
        groups.push({ monthKey: key, label: fmtMonthYear(iso), dates: [] });
        currentKey = key;
      }
      groups[groups.length - 1].dates.push(iso);
    }
    return groups;
  }, [dates]);

  function toggleStation(s: Station) {
    setVisibleStations((curr) => {
      const next = new Set(curr);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  }

  return (
    // align-items: flex-start lets the sticky children opt out of being
    // stretched to the parent's full height (default `stretch` would defeat
    // sticky). The rails then anchor at top of viewport (offset by the
    // page's sticky header) and scroll internally if their content exceeds
    // the viewport.
    <div
      style={{
        display: 'flex',
        minHeight: 'calc(100vh - 130px)',
        alignItems: 'flex-start',
      }}
    >
      {/* ─── Left rail ─────────────────────────────────── */}
      <aside
        style={{
          width: 260,
          padding: 16,
          borderRight: '0.5px solid var(--border)',
          background: 'var(--bg-surface)',
          flexShrink: 0,
          position: 'sticky',
          top: 60, // sits below the layout's sticky nav header
          maxHeight: 'calc(100vh - 60px)',
          overflowY: 'auto',
          alignSelf: 'flex-start',
        }}
      >
        <Section title="Plan summary">
          <KPIRow label="Products" value={`${summary.productCount}`} />
          <KPIRow
            label="Feasible"
            value={`${summary.feasibleCount}`}
            tone={summary.infeasibleCount > 0 ? 'amber' : 'green'}
          />
          {summary.infeasibleCount > 0 && (
            <KPIRow
              label="Infeasible"
              value={`${summary.infeasibleCount}`}
              tone="red"
            />
          )}
          <KPIRow
            label="Changeover (total)"
            value={`${Math.round(summary.totalChangeoverMinutes)} min`}
          />
          <KPIRow label="Activities" value={`${activities.length}`} />
        </Section>

        {/* Phase 4l.12 — product lookup. Search by SKU code or
            product name; matches are draggable onto any day cell to
            create a manual packaging activity (same path as
            drag-from-infeasible). Source: all packaging products in
            the visible activity list, deduplicated by code. */}
        <Section title="Add to plan">
          {(() => {
            // Build a deduplicated product index. Source order:
            //   1. activities (= current plan; freshest productName)
            //   2. productCatalog Tier A + Tier B (plannable + manual-
            //      drag-only). Tier B SKUs (plannable=false) carry a
            //      visible badge so the user knows the auto-planner
            //      won't touch them.
            // First-seen wins so in-plan products keep their up-to-
            // date productName / station.
            const productIndex = new Map<
              string,
              {
                productCode: string;
                productName: string;
                station: Station;
                plannable: boolean;
              }
            >();
            for (const a of activities) {
              if (a.kind !== 'packaging') continue;
              if (!a.station) continue;
              if (productIndex.has(a.productCode)) continue;
              productIndex.set(a.productCode, {
                productCode: a.productCode,
                productName: a.productName,
                station: a.station,
                plannable: true,
              });
            }
            for (const p of productCatalog) {
              if (productIndex.has(p.productCode)) continue;
              productIndex.set(p.productCode, p);
            }
            const products = Array.from(productIndex.values());
            // Phase 4l.12 — tolerant search. Split the query into
            // whitespace-separated tokens and require EVERY token to
            // appear (case-insensitive substring) in either the code
            // OR the name. Lets users find "MFMIXENB11" via "mix b11"
            // even when they don't remember the full code. Order-
            // independent.
            const q = productLookupQuery.trim().toLowerCase();
            const tokens = q.split(/\s+/).filter((t) => t.length > 0);
            const matches = tokens.length === 0
              ? []
              : products
                  .filter((p) => {
                    const hay = (p.productCode + ' ' + p.productName).toLowerCase();
                    return tokens.every((t) => hay.includes(t));
                  })
                  .slice(0, 12);
            return (
              <div style={{ position: 'relative' }}>
                <input
                  type="text"
                  value={productLookupQuery}
                  onChange={(e) => setProductLookupQuery(e.target.value)}
                  placeholder="Search by code or name…"
                  style={{
                    width: '100%',
                    padding: '6px 8px',
                    fontSize: 12,
                    border: '0.5px solid var(--border)',
                    borderRadius: 4,
                    background: 'var(--bg-page)',
                    color: 'inherit',
                    fontFamily: 'inherit',
                    boxSizing: 'border-box',
                  }}
                />
                {q.length > 0 && (
                  <div
                    style={{
                      marginTop: 4,
                      maxHeight: 240,
                      overflowY: 'auto',
                      border: '0.5px solid var(--border)',
                      borderRadius: 4,
                      background: 'var(--bg-elevated, #fff)',
                      fontSize: 11,
                    }}
                  >
                    {matches.length === 0 ? (
                      <div style={{ padding: '8px 10px', color: 'var(--text-muted)' }}>
                        No matching SKUs.
                      </div>
                    ) : (
                      matches.map((p) => (
                        <div
                          key={p.productCode}
                          draggable
                          onDragStart={(e) => {
                            const payload = {
                              productCode: p.productCode,
                              productName: p.productName,
                              quantity: 1,
                              station: p.station,
                            };
                            e.dataTransfer.setData(
                              'application/byron-manual-add',
                              JSON.stringify(payload),
                            );
                            e.dataTransfer.effectAllowed = 'copy';
                          }}
                          style={{
                            padding: '6px 10px',
                            borderBottom: '0.5px solid var(--border)',
                            cursor: 'grab',
                          }}
                          title={
                            p.plannable
                              ? `Drag onto a day to schedule a manual packaging chip (qty 1; edit in drawer afterwards).`
                              : `Manual-only — this SKU isn't on the planner allowlist and won't be auto-scheduled, but you can still drop it on a day for one-off runs. Add it to data/finished-goods-allowlist.json to make it auto-plannable.`
                          }
                        >
                          <div
                            style={{
                              fontWeight: 500,
                              display: 'flex',
                              alignItems: 'center',
                              gap: 4,
                            }}
                          >
                            {p.productCode}
                            {!p.plannable && (
                              <span
                                style={{
                                  padding: '0 4px',
                                  borderRadius: 2,
                                  background: '#1f2937',
                                  color: '#fff',
                                  fontSize: 9,
                                  fontWeight: 700,
                                  letterSpacing: '0.04em',
                                }}
                              >
                                M
                              </span>
                            )}
                          </div>
                          <div style={{ color: 'var(--text-muted)', marginTop: 1 }}>
                            {p.productName}
                          </div>
                          <div
                            style={{
                              color: 'var(--text-muted)',
                              fontSize: 10,
                              marginTop: 1,
                              opacity: 0.8,
                            }}
                          >
                            → {STATION_LABELS[p.station]}
                          </div>
                        </div>
                      ))
                    )}
                    <div
                      style={{
                        padding: '6px 10px',
                        fontSize: 10,
                        color: 'var(--text-muted)',
                        background: 'var(--bg-page)',
                        borderTop: '0.5px solid var(--border)',
                      }}
                    >
                      Drag a result onto any day on the calendar.
                    </div>
                  </div>
                )}
              </div>
            );
          })()}
        </Section>

        <Section title="Layers">
          {/* Category-level toggles: Packaging master + Kitchen master. */}
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 0',
              fontSize: 13,
              cursor: 'pointer',
              opacity: showPackaging ? 1 : 0.4,
              userSelect: 'none',
              fontWeight: 500,
            }}
          >
            <input
              type="checkbox"
              checked={showPackaging}
              onChange={() => setShowPackaging((v) => !v)}
            />
            <span style={{ flex: 1 }}>Packaging</span>
            <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
              {Object.values(stationCounts).reduce((s, n) => s + n, 0)}
            </span>
          </label>

          {/* Per-station detail toggles within Packaging — indented; greyed
              when the master Packaging toggle is off. */}
          <div
            style={{
              paddingLeft: 18,
              opacity: showPackaging ? 1 : 0.5,
              pointerEvents: showPackaging ? 'auto' : 'none',
            }}
          >
            {STATIONS.map((s) => {
              const on = visibleStations.has(s);
              // Phase 4l.11: legend uses a mid-band sat/lit (band 10 of
              // 20, ~$7000 profit chip) so the dot reads as a
              // representative packaging green without being maximally
              // vivid or faded.
              const colors = packagingChipColor(s, 60, 67);
              return (
                <label
                  key={s}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '4px 0',
                    fontSize: 12,
                    cursor: 'pointer',
                    opacity: on ? 1 : 0.4,
                    userSelect: 'none',
                  }}
                >
                  <input type="checkbox" checked={on} onChange={() => toggleStation(s)} />
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      background: colors.dot,
                      display: 'inline-block',
                    }}
                  />
                  <span style={{ flex: 1 }}>{STATION_LABELS[s]}</span>
                  <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                    {stationCounts[s]}
                  </span>
                </label>
              );
            })}
          </div>

          {/* Kitchen master toggle, with two sub-toggles for scheduled
              (live Unleashed) vs required (planner-derived gaps). */}
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 0',
              marginTop: 4,
              fontSize: 13,
              cursor: 'pointer',
              opacity: showKitchen ? 1 : 0.4,
              userSelect: 'none',
              fontWeight: 500,
            }}
          >
            <input
              type="checkbox"
              checked={showKitchen}
              onChange={() => setShowKitchen((v) => !v)}
            />
            <span style={{ flex: 1 }}>Kitchen</span>
            <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
              {kitchenActivityCount + kitchenRequiredCount}
            </span>
          </label>
          <div
            style={{
              paddingLeft: 18,
              opacity: showKitchen ? 1 : 0.5,
              pointerEvents: showKitchen ? 'auto' : 'none',
            }}
          >
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '4px 0',
                fontSize: 12,
                cursor: 'pointer',
                opacity: showKitchenScheduled ? 1 : 0.4,
                userSelect: 'none',
              }}
            >
              <input
                type="checkbox"
                checked={showKitchenScheduled}
                onChange={() => setShowKitchenScheduled((v) => !v)}
              />
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: KITCHEN_COLOR.dot,
                  display: 'inline-block',
                }}
              />
              <span style={{ flex: 1 }}>Scheduled</span>
              <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                {kitchenActivityCount}
              </span>
            </label>
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '4px 0',
                fontSize: 12,
                cursor: 'pointer',
                opacity: showKitchenRequired ? 1 : 0.4,
                userSelect: 'none',
              }}
            >
              <input
                type="checkbox"
                checked={showKitchenRequired}
                onChange={() => setShowKitchenRequired((v) => !v)}
              />
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: KITCHEN_REQUIRED_COLOR.dot,
                  display: 'inline-block',
                }}
              />
              <span style={{ flex: 1 }}>Required (planner)</span>
              <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                {kitchenRequiredCount}
              </span>
            </label>
          </div>
          {/* Purchasing toggle (Phase 4m.2). Single master switch — both
              place-by and arrive-by chips toggle together. The count is
              the requirement count (one PO per material). */}
          {purchaseRequirements.length > 0 && (
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 0',
                marginTop: 4,
                fontSize: 13,
                cursor: 'pointer',
                opacity: showPO ? 1 : 0.4,
                userSelect: 'none',
                fontWeight: 500,
              }}
            >
              <input
                type="checkbox"
                checked={showPO}
                onChange={() => setShowPO((v) => !v)}
              />
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: PO_PLACED_COLOR.dot,
                  display: 'inline-block',
                }}
              />
              <span style={{ flex: 1 }}>Purchasing</span>
              <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                {purchaseRequirements.length}
              </span>
            </label>
          )}
          {/* Phase 4l.8 — PO sub-toggles. Mirrors the kitchen master's
              nested scheduled/required pattern. Three independent slices:
              Place-by chips, Receive-by chips, and Urgent (overdue).
              Indented under the master to signal the parent-child link. */}
          {purchaseRequirements.length > 0 && (
            <div style={{ paddingLeft: 18, marginBottom: 4 }}>
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '4px 0',
                  fontSize: 12,
                  cursor: 'pointer',
                  opacity: showPO && showPoPlaced ? 1 : 0.4,
                  userSelect: 'none',
                }}
              >
                <input
                  type="checkbox"
                  checked={showPoPlaced}
                  onChange={() => setShowPoPlaced((v) => !v)}
                  disabled={!showPO}
                />
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: PO_PLACED_COLOR.dot,
                    display: 'inline-block',
                  }}
                />
                <span style={{ flex: 1 }}>To place</span>
                <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                  {poCounts.placed}
                </span>
              </label>
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '4px 0',
                  fontSize: 12,
                  cursor: 'pointer',
                  opacity: showPO && showPoReceiving ? 1 : 0.4,
                  userSelect: 'none',
                }}
              >
                <input
                  type="checkbox"
                  checked={showPoReceiving}
                  onChange={() => setShowPoReceiving((v) => !v)}
                  disabled={!showPO}
                />
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: PO_RECEIVING_COLOR.dot,
                    display: 'inline-block',
                  }}
                />
                <span style={{ flex: 1 }}>To receive</span>
                <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                  {poCounts.receiving}
                </span>
              </label>
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '4px 0',
                  fontSize: 12,
                  cursor: 'pointer',
                  opacity: showPO && showPoUrgent ? 1 : 0.4,
                  userSelect: 'none',
                }}
              >
                <input
                  type="checkbox"
                  checked={showPoUrgent}
                  onChange={() => setShowPoUrgent((v) => !v)}
                  disabled={!showPO}
                />
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: '#dc2626',
                    display: 'inline-block',
                  }}
                />
                <span style={{ flex: 1 }}>Urgent (overdue)</span>
                <span
                  style={{
                    color: poCounts.urgent > 0 ? '#dc2626' : 'var(--text-muted)',
                    fontWeight: poCounts.urgent > 0 ? 600 : 400,
                    fontSize: 11,
                  }}
                >
                  {poCounts.urgent}
                </span>
              </label>
            </div>
          )}
          {dismissedCount > 0 && (
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 0',
                fontSize: 13,
                cursor: 'pointer',
                userSelect: 'none',
                marginTop: 4,
                paddingTop: 8,
                borderTop: '0.5px solid var(--border)',
              }}
            >
              <input
                type="checkbox"
                checked={showDismissed}
                onChange={() => setShowDismissed((v) => !v)}
              />
              <span style={{ flex: 1, color: 'var(--text-muted)' }}>Show dismissed</span>
              <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                {dismissedCount}
              </span>
            </label>
          )}
        </Section>

        {infeasibleProducts.length > 0 && (
          <Section title={`Infeasible (${infeasibleProducts.length})`}>
            <button
              type="button"
              onClick={() => setInfeasibleOpen((v) => !v)}
              style={{
                width: '100%',
                textAlign: 'left',
                padding: '6px 8px',
                fontSize: 12,
                background: '#fef2f2',
                color: '#991b1b',
                border: '0.5px solid #fecaca',
                borderRadius: 4,
                cursor: 'pointer',
                marginBottom: 6,
                fontFamily: 'inherit',
              }}
            >
              {infeasibleOpen ? '▾' : '▸'} {infeasibleProducts.length} products couldn't be scheduled
            </button>
            {infeasibleOpen && (
              <ul
                style={{
                  listStyle: 'none',
                  padding: 0,
                  margin: 0,
                  maxHeight: 280,
                  overflowY: 'auto',
                  fontSize: 11,
                }}
              >
                {infeasibleProducts.map((p) => (
                  <li
                    key={p.productCode}
                    draggable
                    onDragStart={(e) => {
                      // Phase 4l.8: drag-to-place. Drop on a day cell to
                      // create a manual packaging chip.
                      e.dataTransfer.setData(
                        'application/byron-manual-add',
                        JSON.stringify({
                          productCode: p.productCode,
                          productName: p.productName,
                          quantity: Math.max(1, Math.round(p.unmetUnits)),
                          station: p.station,
                        }),
                      );
                      e.dataTransfer.effectAllowed = 'copy';
                    }}
                    style={{
                      padding: '6px 0',
                      borderBottom: '0.5px solid var(--border)',
                      cursor: 'grab',
                    }}
                    title={`${p.reason}\n\nDrag onto a day to schedule manually.`}
                  >
                    <div style={{ fontWeight: 500 }}>{p.productCode}</div>
                    <div style={{ color: 'var(--text-muted)' }}>
                      {p.station} • unmet ≈ {p.unmetUnits} units
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        )}

        <Section title="Reports">
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8, lineHeight: 1.4 }}>
            Each report reflects the current plan with your edits applied.
            Print opens a formatted view; CSV opens in Excel.
          </div>
          {/* Build the driver lookup once so both PO buttons share it. */}
          {(() => {
            const driverLookup = new Map(
              activitiesWithPo.map((a) => [
                a.stableId,
                { productCode: a.productCode, productName: a.productName, date: a.date },
              ]),
            );
            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {/* PO row */}
                <ReportRow
                  label={`Purchase orders (${purchaseRequirements.length})`}
                  enabled={purchaseRequirements.length > 0}
                  onPrint={() =>
                    openPrintWindow(
                      buildPoHtml({
                        purchaseRequirements,
                        vendorByCode,
                        mutations,
                        today: todayLocal,
                        driverLookup,
                      }),
                    )
                  }
                  onCsv={() =>
                    downloadCsv(
                      buildPoCsv({
                        purchaseRequirements,
                        vendorByCode,
                        mutations,
                        today: todayLocal,
                        driverLookup,
                      }),
                      `byron-po-plan-${todayLocal}.csv`,
                    )
                  }
                />
                <ReportRow
                  label="Packaging schedule"
                  enabled
                  onPrint={() =>
                    openPrintWindow(
                      buildPackagingHtml({
                        activities: mutatedActivities,
                        mutations,
                        stationDailyMinutes,
                        today: todayLocal,
                      }),
                    )
                  }
                  onCsv={() =>
                    downloadCsv(
                      buildPackagingCsv({
                        activities: mutatedActivities,
                        mutations,
                        stationDailyMinutes,
                      }),
                      `byron-packaging-plan-${todayLocal}.csv`,
                    )
                  }
                />
                <ReportRow
                  label={`Kitchen runs (${kitchenRequiredCount})`}
                  enabled={kitchenRequiredCount > 0}
                  onPrint={() =>
                    openPrintWindow(
                      buildKitchenHtml({
                        activities: mutatedActivities,
                        mutations,
                        kitchenMinutesByProductCode,
                        kitchenDefaultMinutes: KITCHEN_DEFAULT_CHIP_MINUTES,
                        today: todayLocal,
                      }),
                    )
                  }
                  onCsv={() =>
                    downloadCsv(
                      buildKitchenCsv({
                        activities: mutatedActivities,
                        mutations,
                        kitchenMinutesByProductCode,
                        kitchenDefaultMinutes: KITCHEN_DEFAULT_CHIP_MINUTES,
                      }),
                      `byron-kitchen-plan-${todayLocal}.csv`,
                    )
                  }
                />
              </div>
            );
          })()}
        </Section>

        <Section title="Data">
          <KPIRow
            label="Demand source"
            value={summary.demandSourceMtime ? fmtDateFromTimestamp(summary.demandSourceMtime) : '—'}
          />
          <KPIRow
            label="SOH refreshed"
            value={
              sohFetchedAt
                ? fmtDateTimeFromTimestamp(sohFetchedAt)
                : 'never'
            }
            tone={sohFetchedAt ? undefined : 'amber'}
          />
          <KPIRow
            label="Sales orders"
            value={
              salesOrdersFetchedAt
                ? `${totalSalesOrderLines} lines · ${fmtDateTimeFromTimestamp(salesOrdersFetchedAt)}`
                : 'never'
            }
            tone={salesOrdersFetchedAt ? undefined : 'amber'}
          />
          <KPIRow
            label="Kitchen assemblies"
            value={
              assembliesFetchedAt
                ? `${kitchenActivityCount} runs · ${fmtDateTimeFromTimestamp(assembliesFetchedAt)}`
                : 'never'
            }
            tone={assembliesFetchedAt ? undefined : 'amber'}
          />
          {availableWarehouses.length > 0 && (
            <div style={{ marginTop: 4, fontSize: 11, color: 'var(--text-muted)' }}>
              <div style={{ marginBottom: 2 }}>Eligible warehouses (sum):</div>
              <ul style={{ margin: 0, paddingLeft: 16 }}>
                {eligibleWarehouses.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
              {availableWarehouses.some((w) => !eligibleWarehouses.includes(w)) && (
                <div style={{ marginTop: 4 }}>
                  Excluded:{' '}
                  {availableWarehouses
                    .filter((w) => !eligibleWarehouses.includes(w))
                    .join(', ')}
                </div>
              )}
            </div>
          )}
          {(summary.orchestratorWarningCount + summary.dayAssignerWarningCount + summary.capacityWarningCount) > 0 && (
            <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted)' }}>
              Warnings: {summary.capacityWarningCount} loader,{' '}
              {summary.orchestratorWarningCount} planner,{' '}
              {summary.dayAssignerWarningCount} day-assigner
            </div>
          )}
        </Section>
      </aside>

      {/* ─── Main calendar ─────────────────────────────── */}
      <main style={{ flex: 1, padding: 24, overflowX: 'auto' }}>
        <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
          <h1 style={{ fontSize: 20, fontWeight: 600 }}>Production Calendar</h1>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {/* Plan from: anchor date for the planner. Defaults to today; when
                set via URL ?from=YYYY-MM-DD the planner treats that day as
                today — horizon starts there, today-floors clamp there, PO
                overdue checks reference it. Phase 4l.8. */}
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--text-muted)' }}>
              <span>Plan from:</span>
              <input
                type="date"
                value={todayLocal}
                onChange={(e) => {
                  const v = e.target.value;
                  const url = new URL(window.location.href);
                  if (!v) {
                    url.searchParams.delete('from');
                  } else {
                    url.searchParams.set('from', v);
                  }
                  window.location.assign(url.toString());
                }}
                disabled={isReplanning || refreshingSoh}
                style={{
                  padding: '4px 6px',
                  fontSize: 12,
                  border: '0.5px solid var(--border)',
                  borderRadius: 3,
                  background: 'var(--bg-page)',
                  color: 'inherit',
                  fontFamily: 'inherit',
                  cursor: 'pointer',
                  // Make non-default state visually obvious so the user
                  // remembers they're not on today.
                  fontWeight: planFromDate ? 600 : 400,
                }}
                title={
                  planFromDate
                    ? `Planning from ${fmtDate(planFromDate)} — click "Reset" to go back to today`
                    : "Anchor date for the planner (defaults to today)"
                }
              />
              {planFromDate && (
                <button
                  type="button"
                  onClick={() => {
                    const url = new URL(window.location.href);
                    url.searchParams.delete('from');
                    window.location.assign(url.toString());
                  }}
                  disabled={isReplanning || refreshingSoh}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: '#1e40af',
                    fontSize: 11,
                    cursor: 'pointer',
                    textDecoration: 'underline',
                    fontFamily: 'inherit',
                    padding: 0,
                  }}
                  title="Reset to today"
                >
                  Reset
                </button>
              )}
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--text-muted)' }}>
              <span>Horizon:</span>
              <select
                value={horizon.weeks}
                onChange={(e) => {
                  const url = new URL(window.location.href);
                  url.searchParams.set('horizonWeeks', e.target.value);
                  window.location.assign(url.toString());
                }}
                disabled={isReplanning || refreshingSoh}
                style={{
                  padding: '4px 6px',
                  fontSize: 12,
                  border: '0.5px solid var(--border)',
                  borderRadius: 3,
                  background: 'var(--bg-page)',
                  color: 'inherit',
                  fontFamily: 'inherit',
                  cursor: 'pointer',
                }}
              >
                {horizonOptions.map((weeks) => (
                  <option key={weeks} value={weeks}>
                    {weeks} weeks {weeks === 26 ? '(6 mo)' : weeks === 12 ? '(3 mo)' : ''}
                  </option>
                ))}
              </select>
            </label>
            <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
              from {fmtDate(horizon.startWeek)}
            </span>
            <button
              type="button"
              onClick={refreshSoh}
              disabled={refreshingSoh || refreshingSO || isReplanning}
              style={{
                padding: '6px 12px',
                fontSize: 13,
                background: 'var(--bg-page)',
                color: 'inherit',
                border: '0.5px solid var(--border)',
                borderRadius: 4,
                cursor: refreshingSoh ? 'wait' : 'pointer',
                fontFamily: 'inherit',
              }}
              title="Pull current stock-on-hand from Unleashed and re-plan"
            >
              {refreshingSoh ? 'Refreshing SOH…' : 'Refresh SOH'}
            </button>
            <button
              type="button"
              onClick={refreshSalesOrders}
              disabled={refreshingSoh || refreshingSO || refreshingAssemblies || isReplanning}
              style={{
                padding: '6px 12px',
                fontSize: 13,
                background: 'var(--bg-page)',
                color: 'inherit',
                border: '0.5px solid var(--border)',
                borderRadius: 4,
                cursor: refreshingSO ? 'wait' : 'pointer',
                fontFamily: 'inherit',
              }}
              title="Pull active customer sales orders from Unleashed and re-plan"
            >
              {refreshingSO ? 'Refreshing SO…' : 'Refresh SO'}
            </button>
            <button
              type="button"
              onClick={refreshAssemblies}
              disabled={refreshingSoh || refreshingSO || refreshingAssemblies || refreshingPo || isReplanning}
              style={{
                padding: '6px 12px',
                fontSize: 13,
                background: 'var(--bg-page)',
                color: 'inherit',
                border: '0.5px solid var(--border)',
                borderRadius: 4,
                cursor: refreshingAssemblies ? 'wait' : 'pointer',
                fontFamily: 'inherit',
              }}
              title="Pull active Unleashed assemblies (kitchen + packaging) and re-plan"
            >
              {refreshingAssemblies ? 'Refreshing assemblies…' : 'Refresh assemblies'}
            </button>
            <button
              type="button"
              onClick={refreshPurchaseOrders}
              disabled={refreshingSoh || refreshingSO || refreshingAssemblies || refreshingPo || isReplanning}
              style={{
                padding: '6px 12px',
                fontSize: 13,
                background: 'var(--bg-page)',
                color: 'inherit',
                border: '0.5px solid var(--border)',
                borderRadius: 4,
                cursor: refreshingPo ? 'wait' : 'pointer',
                fontFamily: 'inherit',
              }}
              title="Pull outstanding Open + PartiallyReceived purchase orders from Unleashed"
            >
              {refreshingPo ? 'Refreshing POs…' : 'Refresh POs'}
            </button>
            {mutationEntries.length > 0 && (
              <div ref={mutationsDropdownRef} style={{ position: 'relative' }}>
                <button
                  type="button"
                  onClick={() => setMutationsOpen((o) => !o)}
                  style={{
                    padding: '6px 12px',
                    fontSize: 13,
                    background: 'var(--bg-page)',
                    color: 'inherit',
                    border: '0.5px solid var(--border)',
                    borderRadius: 4,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                  }}
                  title="Active manual changes — click to view and clear"
                >
                  ⚙ {mutationEntries.length} change{mutationEntries.length === 1 ? '' : 's'}{' '}
                  {mutationsOpen ? '▴' : '▾'}
                </button>
                {mutationsOpen && (
                  <div
                    style={{
                      position: 'absolute',
                      top: 'calc(100% + 4px)',
                      right: 0,
                      width: 360,
                      maxHeight: 420,
                      overflowY: 'auto',
                      background: 'var(--bg-page)',
                      border: '0.5px solid var(--border)',
                      borderRadius: 4,
                      boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
                      zIndex: 50,
                      fontFamily: 'inherit',
                    }}
                  >
                    <div
                      style={{
                        padding: '8px 12px',
                        borderBottom: '0.5px solid var(--border)',
                        fontSize: 11,
                        textTransform: 'uppercase',
                        letterSpacing: '0.05em',
                        color: 'var(--text-muted)',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                      }}
                    >
                      <span>Active changes</span>
                      <button
                        type="button"
                        onClick={() => {
                          clearAllMutations();
                          clearAllManualActivities();
                          setMutationsOpen(false);
                        }}
                        style={{
                          background: 'transparent',
                          border: 'none',
                          color: '#dc2626',
                          fontSize: 11,
                          cursor: 'pointer',
                          textTransform: 'uppercase',
                          letterSpacing: '0.05em',
                          fontFamily: 'inherit',
                          padding: 0,
                        }}
                      >
                        Clear all
                      </button>
                    </div>
                    {mutationEntries.map((e) => (
                      <div
                        key={e.key}
                        style={{
                          padding: '8px 12px',
                          borderBottom: '0.5px solid var(--border)',
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'baseline',
                          gap: 8,
                        }}
                      >
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div
                            style={{
                              fontSize: 13,
                              fontWeight: 500,
                              whiteSpace: 'nowrap',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                            }}
                          >
                            {e.productCode}
                          </div>
                          <div
                            style={{
                              fontSize: 11,
                              color: 'var(--text-muted)',
                              marginTop: 2,
                              whiteSpace: 'nowrap',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                            }}
                          >
                            {e.description}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={e.onClear}
                          style={{
                            background: 'transparent',
                            border: 'none',
                            color: '#1e40af',
                            fontSize: 11,
                            cursor: 'pointer',
                            textDecoration: 'underline',
                            fontFamily: 'inherit',
                            padding: 0,
                            flexShrink: 0,
                          }}
                          title="Undo this change"
                        >
                          Clear
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {/* Tools dropdown — consolidates resolve-conflicts strategies
                and clear-* maintenance actions under one affordance. */}
            <div ref={toolsDropdownRef} style={{ position: 'relative' }}>
              <button
                type="button"
                onClick={() => setToolsOpen((o) => !o)}
                style={{
                  padding: '6px 12px',
                  fontSize: 13,
                  background: toolsOpen ? 'var(--bg-page)' : 'var(--bg-surface)',
                  color: 'var(--text-primary)',
                  border: '0.5px solid var(--border)',
                  borderRadius: 4,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  fontWeight: 500,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                }}
                title="Plan tools: resolve conflicts (auto/pull/push), clear reschedules, clear stale"
              >
                Tools {toolsOpen ? '▴' : '▾'}
              </button>
              {toolsOpen && (
                <div
                  style={{
                    position: 'absolute',
                    top: 'calc(100% + 4px)',
                    right: 0,
                    minWidth: 260,
                    background: 'var(--bg-surface)',
                    border: '0.5px solid var(--border)',
                    borderRadius: 4,
                    boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
                    zIndex: 50,
                    padding: 4,
                    fontSize: 13,
                  }}
                >
                  {/* Resolve conflicts group */}
                  <div
                    style={{
                      fontSize: 10,
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                      color: 'var(--text-muted)',
                      padding: '6px 10px 2px',
                    }}
                  >
                    Resolve conflicts
                    {conflicts.length > 0 && (
                      <span style={{ marginLeft: 6, color: '#dc2626' }}>
                        ⚠ {conflicts.length}
                      </span>
                    )}
                  </div>
                  <ToolsMenuItem
                    label="Auto (pull then push)"
                    sublabel="Pull blockers earlier; push leftovers later"
                    disabled={conflicts.length === 0}
                    onClick={() => {
                      resolveAllConflicts('auto');
                      setToolsOpen(false);
                    }}
                  />
                  <ToolsMenuItem
                    label="← Pull only"
                    sublabel="Move blocking ingredient runs earlier"
                    disabled={conflicts.length === 0}
                    onClick={() => {
                      resolveAllConflicts('pull');
                      setToolsOpen(false);
                    }}
                  />
                  <ToolsMenuItem
                    label="Push only →"
                    sublabel="Move conflicted activities later"
                    disabled={conflicts.length === 0}
                    onClick={() => {
                      resolveAllConflicts('push');
                      setToolsOpen(false);
                    }}
                  />
                  <div
                    style={{
                      height: 1,
                      background: 'var(--border)',
                      margin: '4px 0',
                    }}
                  />
                  {/* Maintenance group */}
                  <div
                    style={{
                      fontSize: 10,
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                      color: 'var(--text-muted)',
                      padding: '6px 10px 2px',
                    }}
                  >
                    Maintenance
                  </div>
                  <ToolsMenuItem
                    label="Clear all reschedules"
                    sublabel="Undo every chip move (keeps dismissals + edits)"
                    onClick={() => {
                      clearAllReschedules();
                      setToolsOpen(false);
                    }}
                  />
                  <ToolsMenuItem
                    label="Clear stale entries"
                    sublabel="Remove mutations targeting chips no longer in the plan"
                    onClick={() => {
                      clearStaleMutations();
                      setToolsOpen(false);
                    }}
                  />
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={replan}
              disabled={isReplanning || refreshingSoh}
              style={{
                padding: '6px 14px',
                fontSize: 13,
                background: isReplanning ? 'var(--bg-page)' : 'var(--accent, #1e40af)',
                color: isReplanning ? 'var(--text-muted)' : 'white',
                border: '0.5px solid var(--border)',
                borderRadius: 4,
                cursor: isReplanning ? 'wait' : 'pointer',
                fontFamily: 'inherit',
                fontWeight: 500,
              }}
              title="Re-run the pipeline with the latest spreadsheet + demand.csv"
            >
              {isReplanning ? 'Re-planning…' : 'Re-plan'}
            </button>
          </div>
        </div>

        {sohRefreshError && (
          <div
            style={{
              marginBottom: 16,
              padding: '8px 12px',
              background: '#fef2f2',
              border: '0.5px solid #fecaca',
              borderRadius: 4,
              fontSize: 12,
              color: '#991b1b',
            }}
          >
            ⚠ SOH refresh failed: {sohRefreshError}
          </div>
        )}
        {soRefreshError && (
          <div
            style={{
              marginBottom: 16,
              padding: '8px 12px',
              background: '#fef2f2',
              border: '0.5px solid #fecaca',
              borderRadius: 4,
              fontSize: 12,
              color: '#991b1b',
            }}
          >
            ⚠ Sales-order refresh failed: {soRefreshError}
          </div>
        )}
        {assembliesRefreshError && (
          <div
            style={{
              marginBottom: 16,
              padding: '8px 12px',
              background: '#fef2f2',
              border: '0.5px solid #fecaca',
              borderRadius: 4,
              fontSize: 12,
              color: '#991b1b',
            }}
          >
            ⚠ Kitchen-assemblies refresh failed: {assembliesRefreshError}
          </div>
        )}
        {poRefreshError && (
          <div
            style={{
              marginBottom: 16,
              padding: '8px 12px',
              background: '#fef2f2',
              border: '0.5px solid #fecaca',
              borderRadius: 4,
              fontSize: 12,
              color: '#991b1b',
            }}
          >
            ⚠ Purchase-orders refresh failed: {poRefreshError}
          </div>
        )}

        {conflicts.length > 0 && (
          <div
            style={{
              marginBottom: 16,
              padding: '10px 12px',
              background: '#fef2f2',
              border: '0.5px solid #fecaca',
              borderRadius: 4,
              fontSize: 12,
              color: '#991b1b',
              display: 'flex',
              alignItems: 'center',
              gap: 12,
            }}
          >
            <span style={{ flex: 1 }}>
              ⚠ {conflicts.length} schedule conflict{conflicts.length === 1 ? '' : 's'} —
              {' '}an activity needs an ingredient that won't be ready in time.
              Use the <strong>Tools</strong> menu in the header to resolve them
              (auto / pull / push), or drag the affected chips manually. Click a
              chip with a red border for details.
            </span>
          </div>
        )}

        {/* Phase 4l.12 — "view connected" focus banner. Surfaces the
            current focus + a one-click escape so the user can never
            get stuck with a filtered view they don't know how to
            clear. The drawer's "View connected" button is the other
            way to toggle this state. */}
        {focusedRelationsId && (
          <div
            style={{
              marginBottom: 16,
              padding: '8px 12px',
              background: '#eff6ff',
              border: '0.5px solid #93c5fd',
              borderRadius: 4,
              fontSize: 12,
              color: '#1e3a8a',
              display: 'flex',
              alignItems: 'center',
              gap: 12,
            }}
          >
            <span style={{ flex: 1 }}>
              <strong>Focus mode:</strong> showing only chips connected to{' '}
              <code style={{ fontFamily: 'monospace', fontSize: 11 }}>
                {focusedRelationsId.split('|')[0]}
              </code>
              {' '}({(focusedRelatedSet?.size ?? 1) - 1} connected — suppliers, consumers, and all
              other runs of the same SKU). All other chips are hidden.
            </span>
            <button
              type="button"
              onClick={() => setFocusedRelationsId(null)}
              style={{
                padding: '4px 10px',
                fontSize: 11,
                border: '0.5px solid #1e40af',
                borderRadius: 3,
                background: '#fff',
                color: '#1e3a8a',
                cursor: 'pointer',
                fontFamily: 'inherit',
                fontWeight: 600,
              }}
            >
              Clear filter
            </button>
          </div>
        )}

        {unplaceableIds.length > 0 && (
          <div
            style={{
              marginBottom: 16,
              padding: '10px 12px',
              background: '#fffbeb',
              border: '0.5px solid #fcd34d',
              borderRadius: 4,
              fontSize: 12,
              color: '#78350f',
              display: 'flex',
              alignItems: 'center',
              gap: 12,
            }}
          >
            <span style={{ flex: 1 }}>
              ⚠ {unplaceableIds.length} chip{unplaceableIds.length === 1 ? '' : 's'} couldn't
              be auto-placed — no working day with capacity within the search horizon. Try
              moving them manually, freeing capacity on a downstream day, or dismissing
              the activity.
              {' '}
              <span style={{ color: '#92400e' }}>
                ({unplaceableIds.slice(0, 3).map((id) => id.split('|')[0]).join(', ')}
                {unplaceableIds.length > 3 ? `, +${unplaceableIds.length - 3} more` : ''})
              </span>
            </span>
            <button
              type="button"
              onClick={() => setUnplaceableIds([])}
              title="Clear this notice (the chips remain unmoved)."
              style={{
                padding: '4px 10px',
                fontSize: 11,
                background: '#fef3c7',
                color: '#78350f',
                border: '0.5px solid #fcd34d',
                borderRadius: 3,
                cursor: 'pointer',
                fontFamily: 'inherit',
                fontWeight: 500,
                whiteSpace: 'nowrap',
              }}
            >
              Dismiss
            </button>
          </div>
        )}

        {staleIds.length > 0 && (
          <div
            style={{
              marginBottom: 16,
              padding: '10px 12px',
              background: '#fffbeb',
              border: '0.5px solid #fcd34d',
              borderRadius: 4,
              fontSize: 12,
              color: '#78350f',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
              }}
            >
              <span style={{ flex: 1 }}>
                ⚠ {staleIds.length} stale mutation{staleIds.length === 1 ? '' : 's'} —
                the underlying activities are no longer in the plan (data changed since
                the mutation was made).
              </span>
              <button
                type="button"
                onClick={() => setShowStaleDetails((v) => !v)}
                style={{
                  padding: '4px 10px',
                  fontSize: 11,
                  background: 'transparent',
                  color: '#78350f',
                  border: '0.5px solid #fcd34d',
                  borderRadius: 3,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  fontWeight: 500,
                }}
              >
                {showStaleDetails ? 'Hide' : 'View'}
              </button>
              <button
                type="button"
                onClick={clearStaleMutations}
                style={{
                  padding: '4px 10px',
                  fontSize: 11,
                  background: '#fef3c7',
                  color: '#78350f',
                  border: '0.5px solid #fcd34d',
                  borderRadius: 3,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  fontWeight: 500,
                }}
              >
                Clear stale
              </button>
            </div>
            {showStaleDetails && (
              <div
                style={{
                  marginTop: 10,
                  paddingTop: 10,
                  borderTop: '0.5px dashed #fcd34d',
                  maxHeight: 220,
                  overflowY: 'auto',
                  fontSize: 11,
                  fontFamily: 'monospace',
                }}
              >
                {staleIds.map((id) => {
                  const m = mutations[id];
                  // Derive a human-readable summary of the mutation type(s).
                  const tags: string[] = [];
                  if (m?.dismissed) tags.push('dismissed');
                  if (m?.editedQuantity !== undefined) {
                    tags.push(`qty=${m.editedQuantity}`);
                  }
                  if (m?.rescheduledTo) tags.push(`→ ${m.rescheduledTo}`);
                  if (m?.editedStation) tags.push(`station=${m.editedStation}`);
                  if (m?.editedLeadTimeDays !== undefined) {
                    tags.push(`lead=${m.editedLeadTimeDays}d`);
                  }
                  const when = m?.updatedAt ? m.updatedAt.slice(0, 10) : '?';
                  return (
                    <div
                      key={id}
                      style={{
                        display: 'flex',
                        gap: 8,
                        padding: '3px 0',
                        borderBottom: '0.5px dotted #fde68a',
                      }}
                    >
                      <span style={{ flex: 1, wordBreak: 'break-all' }}>{id}</span>
                      <span style={{ flexShrink: 0, opacity: 0.85 }}>
                        {tags.join(', ') || '(no fields)'}
                      </span>
                      <span style={{ flexShrink: 0, opacity: 0.6, minWidth: 78, textAlign: 'right' }}>
                        {when}
                      </span>
                    </div>
                  );
                })}
                <div
                  style={{
                    marginTop: 6,
                    fontSize: 10,
                    opacity: 0.75,
                    fontFamily: 'inherit',
                  }}
                >
                  stableId · changes · last-modified date
                </div>
              </div>
            )}
          </div>
        )}

        {monthGroups.map((group) => (
          <MonthBlock
            key={group.monthKey}
            label={group.label}
            dates={group.dates}
            activitiesByDate={activitiesByDate}
            peakLoadByDate={peakLoadByDate}
            kitchenLoadByDate={kitchenLoadByDate}
            dehydratorLoadByDate={dehydratorLoadByDate}
            chipAvailabilityByStableId={chipAvailabilityByStableId}
            onSelect={selectChip}
            selectedId={selected?.id ?? null}
            selectedStableId={selected?.stableId ?? null}
            mutations={mutations}
            conflictsByConsumer={conflictsByConsumer}
            unplaceableSet={unplaceableSet}
            supplyStarvedSet={supplyStarvedStableIds}
            hoveredStableId={hoveredStableId}
            onChipHover={onChipHover}
            relatedByStableId={relatedByStableId}
            clusterMembersByStableId={clusterMembersByStableId}
            onDropOnDate={(stableId, date) => {
              // No-op when dropped on the same day the activity is already on.
              const found = mutatedActivities.find((a) => a.stableId === stableId);
              if (!found || found.date === date) return;
              // Phase 4l.8: defensive guard against drops on past dates.
              // MonthBlock's cells also reject these via onDragOver, this
              // catches anything that slips through.
              if (date < clientToday) return;
              reschedule(stableId, date);
            }}
            onManualAdd={(input) => {
              if (input.date < clientToday) return;
              addManualActivity(input);
            }}
            today={clientToday}
          />
        ))}

        {visibleActivities.length === 0 && (
          <div
            style={{
              padding: 40,
              textAlign: 'center',
              color: 'var(--text-muted)',
              border: '0.5px dashed var(--border)',
              borderRadius: 6,
              marginTop: 16,
            }}
          >
            No activities to show. Toggle a layer back on, or check that your demand data is loaded.
          </div>
        )}

        {/* ─── Bottom strip: heatmap + stockout risk ────── */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '2fr 1fr',
            gap: 16,
            marginTop: 24,
          }}
        >
          <CapacityHeatmap data={heatmapByWeek} />
          <StockoutPanel infeasibleProducts={infeasibleProducts} />
        </div>

        {/* ─── Raw-material risks (Phase 4m.1) — collapsible drawer ─ */}
        {(rawMaterialShortages.length > 0 || purchaseRequirements.length > 0) && (
          <div style={{ marginTop: 16 }}>
            <CollapsibleSection
              title="Raw material risks"
              count={`${purchaseRequirements.length} PO${purchaseRequirements.length === 1 ? '' : 's'} needed`}
              badge={
                purchaseRequirements.filter((r) => r.overdue).length > 0 ? (
                  <span style={{ fontSize: 11, color: '#dc2626', fontWeight: 500 }}>
                    ⚠ {purchaseRequirements.filter((r) => r.overdue).length} overdue
                  </span>
                ) : undefined
              }
              storageKey="byron-calendar-raw-risks-open"
              defaultOpen={purchaseRequirements.some((r) => r.overdue)}
            >
              <RawMaterialRiskPanel
                shortages={rawMaterialShortages}
                requirements={purchaseRequirements}
              />
            </CollapsibleSection>
          </div>
        )}

        {/* ─── Finished goods (Phase 4l.13) — collapsible drawer ─── */}
        {finishedGoodsSummary.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <CollapsibleSection
              title="Finished goods in planner"
              count={`${finishedGoodsSummary.length} SKU${finishedGoodsSummary.length === 1 ? '' : 's'}`}
              badge={
                finishedGoodsSummary.filter((r) => r.stockoutIndices.length > 0).length > 0 ? (
                  <span style={{ fontSize: 11, color: '#dc2626', fontWeight: 500 }}>
                    ⚠ {finishedGoodsSummary.filter((r) => r.stockoutIndices.length > 0).length} at risk
                  </span>
                ) : undefined
              }
              storageKey="byron-calendar-fg-summary-open"
              defaultOpen={false}
            >
              <FinishedGoodsPanel
                rows={finishedGoodsSummary}
                selectedCode={selectedFG}
                onSelectFG={selectFG}
              />
            </CollapsibleSection>
          </div>
        )}
      </main>

      {/* ─── Right drawer ──────────────────────────────── */}
      {selected && (
        <ActivityDrawer
          // Look the activity up in `mutatedActivities` by stableId so the
          // drawer always renders against the LATEST mutation-applied
          // chip (= the same data the calendar is showing). If we used
          // the stored `selected` reference directly, edits like the
          // station dropdown wouldn't reflect immediately — the cached
          // ref would still hold the pre-edit values.
          activity={
            mutatedActivities.find((a) => a.stableId === selected.stableId) ??
            selected
          }
          availability={chipAvailabilityByStableId.get(selected.stableId) ?? null}
          original={activitiesWithPo.find((a) => a.stableId === selected.stableId) ?? selected}
          routingRationale={routingDecisions[selected.productCode] ?? null}
          dismissed={isDismissed(mutations, selected.stableId)}
          rescheduledTo={rescheduledTo(mutations, selected.stableId)}
          editedQuantity={editedQuantityOf(mutations, selected.stableId)}
          editedLeadTimeDays={editedLeadTimeDaysOf(
            mutations,
            // Lead-time mutation is keyed on the place-by chip's stableId,
            // regardless of which sister chip the user clicked.
            selected.kind === 'po-receiving' && selected.poInfo
              ? selected.poInfo.sisterStableId
              : selected.stableId,
          )}
          vendor={vendorByCode[selected.productCode] ?? null}
          stationDailyMinutes={selected.station ? stationDailyMinutes[selected.station] ?? 480 : 480}
          kitchenChipMinutes={
            selected.kind === 'kitchen-required' || selected.kind === 'kitchen'
              ? selected.kitchenMinutes ??
                kitchenMinutesByProductCode[selected.productCode] ??
                KITCHEN_DEFAULT_CHIP_MINUTES
              : null
          }
          productOverride={productOverrides[selected.productCode]}
          stationDailyOutput={productStationDailyOutput[selected.productCode] ?? 0}
          globalShelfLifeDays={globalDefaults.shelfLifeDays}
          sohBreakdown={sohByProductCode[selected.productCode] ?? null}
          eligibleWarehouses={
            // Phase 4l.12 — pick the eligibility rule that matches what
            // the planner ACTUALLY uses for this chip kind, so the
            // drawer's "excluded" label is accurate. For finished goods
            // we use the FG fulfilment list (TBC + MF Packaging + MF
            // Operations etc); for intermediates we use the intermediate
            // list (Lundberg + MF Packaging + MF Operations); for PO
            // chips (raw materials) everything counts.
            selected.kind === 'kitchen' || selected.kind === 'kitchen-required'
              ? [...intermediateEligibleWarehouses]
              : selected.kind === 'po-placed' || selected.kind === 'po-receiving'
              ? Array.from(
                  new Set([
                    ...eligibleWarehouses,
                    ...intermediateEligibleWarehouses,
                    ...availableWarehouses,
                  ]),
                )
              : eligibleWarehouses
          }
          plannerInitialInventory={
            selected.kind === 'kitchen' || selected.kind === 'kitchen-required'
              ? intermediateSohByCode[selected.productCode] ?? 0
              : initialInventoryByProduct[selected.productCode] ?? 0
          }
          salesOrders={salesOrdersByProduct[selected.productCode] ?? []}
          totalCommitted={committedByProduct[selected.productCode] ?? 0}
          conflicts={conflictsByConsumer.get(selected.stableId) ?? []}
          onResolveConflicts={(strategy) => resolveAllConflicts(strategy)}
          onDismiss={() => dismiss(selected.stableId)}
          onUndismiss={() => undismiss(selected.stableId)}
          onReschedule={(date) => reschedule(selected.stableId, date)}
          onClearReschedule={() => clearReschedule(selected.stableId)}
          onEditQuantity={(qty) => editQuantity(selected.stableId, qty)}
          onClearEdit={() => clearEdit(selected.stableId)}
          onEditLeadTime={(days) => {
            const placeId =
              selected.kind === 'po-receiving' && selected.poInfo
                ? selected.poInfo.sisterStableId
                : selected.stableId;
            editLeadTime(placeId, days);
          }}
          onClearLeadTime={() => {
            const placeId =
              selected.kind === 'po-receiving' && selected.poInfo
                ? selected.poInfo.sisterStableId
                : selected.stableId;
            clearLeadTime(placeId);
          }}
          onEditStation={(s) => editStation(selected.stableId, s, selected.productCode)}
          onClearStation={() => clearStation(selected.stableId)}
          stationOverridden={editedStationOf(mutations, selected.stableId) !== null}
          originalStation={
            (activitiesWithPo.find((a) => a.stableId === selected.stableId)?.station as Station | null) ?? null
          }
          clusterMembers={clusterMembersByStableId.get(selected.stableId) ?? null}
          onSelectClusterMember={(a) => setSelected(a)}
          relatedChips={(() => {
            // Phase 4l.12 — resolve relatedByStableId entries to actual
            // CalendarActivity objects so the drawer can display each
            // related chip's productCode + date + qty + kind. We look up
            // against the full activity list (incl. mutated qty) so the
            // drawer reflects the current state. Entries that can't be
            // resolved (= chip was filtered out / dismissed) are dropped.
            const rels = relatedByStableId.get(selected.stableId) ?? [];
            if (rels.length === 0) return [];
            const byStableId = new Map<string, CalendarActivity>();
            for (const a of activitiesWithPo) byStableId.set(a.stableId, a);
            // Also overlay mutated qty so the displayed numbers match what
            // the user has edited.
            for (const a of mutatedActivities) byStableId.set(a.stableId, a);
            const out: Array<{
              activity: CalendarActivity;
              direction: 'supplier' | 'consumer';
              phantom: boolean;
            }> = [];
            for (const r of rels) {
              const a = byStableId.get(r.stableId);
              if (!a) continue;
              out.push({
                activity: a,
                direction: r.kind,
                phantom: r.phantom ?? false,
              });
            }
            return out;
          })()}
          onSelectRelatedChip={(a) => {
            // Phase 4l.12 — switch drawer focus AND scroll the calendar
            // so the operator can see the related chip without manually
            // hunting through months. Looks up by `data-chip-id` for
            // singleton chips OR `data-chip-ids` (space-separated) for
            // cluster chips. If the chip isn't currently rendered (e.g.
            // filtered out by a layer toggle), we still switch focus so
            // the drawer shows it; the scroll silently no-ops.
            setSelected(a);
            requestAnimationFrame(() => {
              const sel = `[data-chip-id="${a.stableId}"], [data-chip-ids~="${a.stableId}"]`;
              const el = document.querySelector(sel);
              if (el && 'scrollIntoView' in el) {
                (el as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'center' });
              }
            });
          }}
          onClose={() => setSelected(null)}
          focused={focusedRelationsId === selected.stableId}
          onToggleFocus={() => {
            setFocusedRelationsId((curr) =>
              curr === selected.stableId ? null : selected.stableId,
            );
          }}
        />
      )}

      {/* ─── Finished-good product drawer (Phase 4l.14) ─── */}
      {!selected && selectedFG && (() => {
        const row = finishedGoodsSummary.find((r) => r.code === selectedFG);
        if (!row) return null;
        return (
          <FinishedGoodDrawer
            row={row}
            consumesMap={consumesMap}
            consumesQtyMap={consumesQtyMap}
            intermediateSohByCode={conflictInitialSohByCode}
            intermediateSupplyByCode={intermediateSupplyByCode}
            rawMaterialShortages={rawMaterialShortages}
            supplyStarvedSet={supplyStarvedStableIds}
            conflictedStableIds={conflictedStableIds}
            onSelectChip={(stableId) => {
              const a = mutatedActivities.find((x) => x.stableId === stableId);
              if (a) selectChip(a);
            }}
            onClose={() => setSelectedFG(null)}
          />
        );
      })()}
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <h3
        style={{
          fontSize: 11,
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          color: 'var(--text-muted)',
          marginBottom: 8,
          fontWeight: 500,
        }}
      >
        {title}
      </h3>
      {children}
    </div>
  );
}

/**
 * One row in the Reports section: report name on the left + Print and CSV
 * buttons on the right. Both buttons share the same enabled flag (a report
 * with zero activities still exports an empty CSV / "no items" page; we
 * just disable when there's literally nothing to say).
 */
function ReportRow({
  label,
  enabled,
  onPrint,
  onCsv,
}: {
  label: string;
  enabled: boolean;
  onPrint: () => void;
  onCsv: () => void;
}) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 6,
        alignItems: 'center',
        opacity: enabled ? 1 : 0.5,
      }}
    >
      <div style={{ flex: 1, fontSize: 12, fontWeight: 500 }}>{label}</div>
      <button
        type="button"
        onClick={onPrint}
        disabled={!enabled}
        title="Open a printable version in a new tab and trigger the print dialog."
        style={reportSubButtonStyle(enabled)}
      >
        Print
      </button>
      <button
        type="button"
        onClick={onCsv}
        disabled={!enabled}
        title="Download the report as a CSV file (opens in Excel / Sheets)."
        style={reportSubButtonStyle(enabled)}
      >
        CSV
      </button>
    </div>
  );
}

function reportSubButtonStyle(enabled: boolean): React.CSSProperties {
  return {
    padding: '4px 8px',
    fontSize: 11,
    background: enabled ? 'var(--bg-page)' : 'transparent',
    color: enabled ? 'inherit' : 'var(--text-muted)',
    border: '0.5px solid var(--border)',
    borderRadius: 3,
    cursor: enabled ? 'pointer' : 'default',
    fontFamily: 'inherit',
    fontWeight: 500,
  };
}

function KPIRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'green' | 'amber' | 'red';
}) {
  const toneColor = tone === 'green' ? '#059669' : tone === 'amber' ? '#d97706' : tone === 'red' ? '#dc2626' : 'inherit';
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '3px 0' }}>
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span style={{ fontWeight: 500, color: toneColor }}>{value}</span>
    </div>
  );
}

function MonthBlock({
  label,
  dates,
  activitiesByDate,
  peakLoadByDate,
  kitchenLoadByDate,
  dehydratorLoadByDate,
  chipAvailabilityByStableId,
  onSelect,
  selectedId,
  selectedStableId,
  mutations,
  conflictsByConsumer,
  unplaceableSet,
  supplyStarvedSet,
  hoveredStableId,
  onChipHover,
  relatedByStableId,
  clusterMembersByStableId,
  onDropOnDate,
  onManualAdd,
  today,
}: {
  label: string;
  dates: string[];
  activitiesByDate: Map<string, CalendarActivity[]>;
  peakLoadByDate: Map<string, { utilisation: number; usedMinutes: number; capacityMinutes: number; station: Station }>;
  /** Per-day kitchen-team utilisation (Phase 4l.7). */
  kitchenLoadByDate: Map<string, { usedMinutes: number; capacityMinutes: number; utilisation: number }>;
  /** Per-day dehydrator-tray utilisation (Phase 4l.10). */
  dehydratorLoadByDate: Map<string, { usedTrays: number; capacityTrays: number; utilisation: number }>;
  /** Phase 4l.11 — per-chip per-day availability + shortage ratios driving the inventory sparkline and the inverted shortage sparkline. */
  chipAvailabilityByStableId: ReadonlyMap<
    string,
    {
      ratios: number[];
      shortageRatios: number[] | null;
      floorRatios: number[] | null;
      chipDateIndex: number;
      predictedSoh: number | null;
      availableDays: number | null;
    }
  >;
  onSelect: (a: CalendarActivity) => void;
  /** Activity.id of the currently-selected chip; drives chip "selected" styling. */
  selectedId: string | null;
  /** Activity.stableId of the currently-selected chip; drives persistent arrow drawing. */
  selectedStableId: string | null;
  /** stableId → list of cluster sibling activities (incl. itself). Empty entries omitted (singletons). */
  clusterMembersByStableId: ReadonlyMap<string, CalendarActivity[]>;
  mutations: MutationsMap;
  /** Map of stableId → conflicts (used to highlight chips with red borders). */
  conflictsByConsumer: Map<string, ScheduleConflict[]>;
  /** Set of stableIds left unplaced by the most-recent Resolve-all run. */
  unplaceableSet: ReadonlySet<string>;
  /** Set of stableIds whose ingredients include at least one phantom (= un-supplied) input. */
  supplyStarvedSet: ReadonlySet<string>;
  /** Currently-hovered chip stableId (drives the arrow overlay). */
  hoveredStableId: string | null;
  /** Hover handler — pass id on enter, null on leave. */
  onChipHover: (id: string | null) => void;
  /** stableId → list of related chips with direction. */
  relatedByStableId: ReadonlyMap<string, ReadonlyArray<{ stableId: string; kind: 'supplier' | 'consumer'; phantom?: boolean }>>;
  /** Called when a chip is dropped onto a day cell. Skip same-day drops upstream. */
  onDropOnDate: (stableId: string, date: string) => void;
  /** Phase 4l.8: called when an infeasible-products row is dropped on a day. */
  onManualAdd: (input: {
    productCode: string;
    productName: string;
    quantity: number;
    station: Station;
    date: string;
  }) => void;
  /** Today as YYYY-MM-DD local — used to disable drops on past-date cells (Phase 4l.8). */
  today: string;
}) {
  // Local state: which day is currently drag-over, for visual highlighting.
  // Per-month — the user can only drag one thing at a time, so it's enough to
  // track inside this component without a ref.
  const [hoverDate, setHoverDate] = useState<string | null>(null);

  // Per-month chip ref registry — used by the arrow overlay to resolve DOM
  // positions. Refs live in a Map keyed by stableId; chips register on mount
  // and unregister on unmount via the callback-ref pattern.
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chipRefs = useRef<Map<string, HTMLElement>>(new Map());
  const registerChipRef = useCallback((stableId: string, el: HTMLElement | null) => {
    if (el) chipRefs.current.set(stableId, el);
    else chipRefs.current.delete(stableId);
  }, []);

  // Effective arrow target: hover takes precedence (lets the user peek at
  // other chips' relationships without losing their selection), and falls
  // back to the selected chip so clicking a chip keeps its arrows on screen
  // after the mouse leaves.
  // Note: `selectedId` is the activity's `id` (used for chip selected styling),
  // whereas arrows are keyed by `stableId` — so we use `selectedStableId` here.
  const arrowTargetId = hoveredStableId ?? selectedStableId;

  // Computed arrows for the current target. Coords are relative to containerRef.
  // `flowsInto` colour-codes by the consumer's activity kind:
  //   'into-packaging' (green) — line ends at a packaging chip (the focused
  //     chip or a related one)
  //   'into-kitchen'   (orange) — line ends at a kitchen or kitchen-required
  //     chip
  type FlowKind = 'into-packaging' | 'into-kitchen';
  type Arrow = {
    id: string;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    flowsInto: FlowKind;
    /** Phase 4l.11: phantom = consumer was starved; rendered dashed-red. */
    phantom: boolean;
  };
  const [arrows, setArrows] = useState<Arrow[]>([]);
  // Re-measure on every layout pass while a target is active. Trigger when:
  //   - arrowTargetId changes (hover or selection moved)
  //   - activitiesByDate changes (chips moved → DOM positions changed)
  //   - relatedByStableId changes (relationships updated)
  useLayoutEffect(() => {
    if (!arrowTargetId) {
      if (arrows.length > 0) setArrows([]);
      return;
    }
    const container = containerRef.current;
    const sourceEl = chipRefs.current.get(arrowTargetId);
    if (!container || !sourceEl) {
      // Target chip isn't in this month's grid → no arrows here.
      if (arrows.length > 0) setArrows([]);
      return;
    }
    // Build stableId → kind lookup for chips in this month — needed to
    // decide each arrow's colour based on what kind of chip it ends at.
    const kindByStableId = new Map<string, CalendarActivity['kind']>();
    for (const list of activitiesByDate.values()) {
      for (const a of list) kindByStableId.set(a.stableId, a.kind);
    }
    const flowFor = (consumerKind: CalendarActivity['kind'] | undefined): FlowKind =>
      consumerKind === 'packaging' ? 'into-packaging' : 'into-kitchen';

    const cRect = container.getBoundingClientRect();
    const sRect = sourceEl.getBoundingClientRect();
    const sCx = (sRect.left + sRect.right) / 2 - cRect.left;
    const sCy = (sRect.top + sRect.bottom) / 2 - cRect.top;
    const sourceKind = kindByStableId.get(arrowTargetId);
    const out: Arrow[] = [];
    for (const rel of relatedByStableId.get(arrowTargetId) ?? []) {
      const relEl = chipRefs.current.get(rel.stableId);
      if (!relEl) continue; // related chip not in this month
      const rRect = relEl.getBoundingClientRect();
      const rCx = (rRect.left + rRect.right) / 2 - cRect.left;
      const rCy = (rRect.top + rRect.bottom) / 2 - cRect.top;
      // Direction: arrow always flows supplier → consumer.
      // - rel.kind === 'supplier': rel is the supplier, source is the consumer.
      // - rel.kind === 'consumer': source is the supplier, rel is the consumer.
      // Colour is the destination chip's kind.
      if (rel.kind === 'supplier') {
        out.push({
          id: rel.stableId,
          x1: rCx, y1: rCy, x2: sCx, y2: sCy,
          flowsInto: flowFor(sourceKind),
          phantom: rel.phantom ?? false,
        });
      } else {
        out.push({
          id: rel.stableId,
          x1: sCx, y1: sCy, x2: rCx, y2: rCy,
          flowsInto: flowFor(kindByStableId.get(rel.stableId)),
          phantom: rel.phantom ?? false,
        });
      }
    }
    setArrows(out);
    // We intentionally exclude `arrows` from deps to avoid re-running on our own setState.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arrowTargetId, activitiesByDate, relatedByStableId]);

  // Set of stableIds currently related to the active target — used to highlight
  // related chips with a colored ring. Computed cheaply once per render.
  const relatedHighlight = useMemo(() => {
    const out = new Map<string, 'supplier' | 'consumer'>();
    if (!arrowTargetId) return out;
    for (const rel of relatedByStableId.get(arrowTargetId) ?? []) {
      out.set(rel.stableId, rel.kind);
    }
    return out;
  }, [arrowTargetId, relatedByStableId]);

  // Pad the front of the first week so calendar columns align with day-of-week.
  const first = fromISO(dates[0]);
  const dowOfFirst = (first.getDay() + 6) % 7; // Mon = 0
  const padCount = dowOfFirst;
  const cells: ({ date: string } | { pad: true })[] = [];
  for (let i = 0; i < padCount; i++) cells.push({ pad: true });
  for (const d of dates) cells.push({ date: d });

  return (
    <div style={{ marginBottom: 32 }}>
      <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>{label}</h2>
      <div
        ref={containerRef}
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(7, 1fr)',
          border: '0.5px solid var(--border)',
          borderRadius: 6,
          overflow: 'hidden',
          background: 'var(--bg-surface)',
          position: 'relative',
        }}
      >
        {DAY_NAMES.map((n) => (
          <div
            key={n}
            style={{
              padding: '6px 8px',
              fontSize: 11,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              color: 'var(--text-muted)',
              borderBottom: '0.5px solid var(--border)',
              fontWeight: 500,
            }}
          >
            {n}
          </div>
        ))}
        {cells.map((cell, idx) => {
          if ('pad' in cell) {
            return (
              <div
                key={`pad-${idx}`}
                style={{ minHeight: 110, background: 'var(--bg-page)', borderRight: '0.5px solid var(--border)', borderBottom: '0.5px solid var(--border)' }}
              />
            );
          }
          const dayActivities = activitiesByDate.get(cell.date) ?? [];
          const dow = (fromISO(cell.date).getDay() + 6) % 7;
          const isWeekend = dow >= 5;
          // Phase 4l.8: past-date cells reject drops so users can't (re)create
          // zombie reschedules. Today and future remain valid drop targets.
          const isPastDay = cell.date < today;
          const peakLoad = peakLoadByDate.get(cell.date);
          const kitchenLoad = kitchenLoadByDate.get(cell.date);
          const dehydratorLoad = dehydratorLoadByDate.get(cell.date);
          const overrun = peakLoad ? peakLoad.utilisation > 1 : false;
          const kitchenOverrun = kitchenLoad ? kitchenLoad.utilisation > 1 : false;
          const dehydratorOverrun = dehydratorLoad
            ? dehydratorLoad.utilisation > 1
            : false;
          const isHover = hoverDate === cell.date;
          // We need a deterministic cellKey so the drop-state computation
          // closes over the right date. Captured below.
          const dropDate = cell.date;
          return (
            <div
              key={cell.date}
              onDragOver={(e) => {
                if (isPastDay) {
                  // Skip preventDefault → browser shows the no-drop cursor.
                  e.dataTransfer.dropEffect = 'none';
                  return;
                }
                // preventDefault is what makes the cell a valid drop target;
                // without it the browser rejects the drop with cursor=no-drop.
                e.preventDefault();
                // Phase 4l.12 — match dropEffect to what's being dragged.
                const isManualAdd = e.dataTransfer.types.includes(
                  'application/byron-manual-add',
                );
                e.dataTransfer.dropEffect = isManualAdd ? 'copy' : 'move';
                if (hoverDate !== dropDate) setHoverDate(dropDate);
              }}
              onDragLeave={() => {
                if (hoverDate === dropDate) setHoverDate(null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                setHoverDate(null);
                if (isPastDay) return;
                // Phase 4l.8: drag-from-infeasible-list payload wins over
                // the stableId-reschedule payload when both are set.
                const manualRaw = e.dataTransfer.getData('application/byron-manual-add');
                if (manualRaw) {
                  try {
                    const parsed = JSON.parse(manualRaw);
                    if (
                      parsed &&
                      typeof parsed.productCode === 'string' &&
                      typeof parsed.productName === 'string' &&
                      typeof parsed.quantity === 'number' &&
                      parsed.quantity > 0 &&
                      typeof parsed.station === 'string'
                    ) {
                      onManualAdd({
                        productCode: parsed.productCode,
                        productName: parsed.productName,
                        quantity: parsed.quantity,
                        station: parsed.station as Station,
                        date: dropDate,
                      });
                      return;
                    }
                  } catch {/* ignore malformed */}
                }
                const stableId = e.dataTransfer.getData('text/plain');
                if (stableId) onDropOnDate(stableId, dropDate);
              }}
              style={{
                minHeight: 110,
                padding: 4,
                borderRight: '0.5px solid var(--border)',
                borderBottom: '0.5px solid var(--border)',
                background: isHover
                  ? '#eff6ff'
                  : isPastDay || isWeekend
                  ? 'var(--bg-page)'
                  : 'transparent',
                opacity: isPastDay ? 0.4 : isWeekend && !isHover ? 0.5 : 1,
                position: 'relative',
                outline: isHover
                  ? '1.5px dashed #3b82f6'
                  : overrun
                  ? '1.5px solid #dc2626'
                  : 'none',
                outlineOffset: -1,
                transition: 'background 80ms ease',
              }}
              title={isPastDay ? "Past date — drops not allowed" : undefined}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'baseline',
                  marginBottom: 4,
                }}
              >
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  {fmtDayShort(cell.date)}
                </span>
                <div style={{ display: 'flex', gap: 4, alignItems: 'baseline' }}>
                  {kitchenLoad && (
                    <span
                      style={{
                        fontSize: 9,
                        color: kitchenOverrun
                          ? '#dc2626'
                          : kitchenLoad.utilisation > 0.85
                          ? '#d97706'
                          : 'var(--text-muted)',
                        fontWeight: kitchenOverrun ? 600 : 400,
                      }}
                      title={`Kitchen team: ${Math.round(kitchenLoad.usedMinutes)}/${kitchenLoad.capacityMinutes} min (${Math.round(kitchenLoad.utilisation * 100)}%)`}
                    >
                      K{Math.round(kitchenLoad.utilisation * 100)}%
                    </span>
                  )}
                  {dehydratorLoad && (
                    <span
                      style={{
                        fontSize: 9,
                        color: dehydratorOverrun
                          ? '#dc2626'
                          : dehydratorLoad.utilisation > 0.85
                          ? '#d97706'
                          : 'var(--text-muted)',
                        fontWeight: dehydratorOverrun ? 600 : 400,
                      }}
                      title={`Dehydrator trays: ${dehydratorLoad.usedTrays}/${dehydratorLoad.capacityTrays} (${Math.round(dehydratorLoad.utilisation * 100)}%)`}
                    >
                      D{Math.round(dehydratorLoad.utilisation * 100)}%
                    </span>
                  )}
                  {peakLoad && (
                    <span
                      style={{
                        fontSize: 9,
                        color: overrun ? '#dc2626' : peakLoad.utilisation > 0.85 ? '#d97706' : 'var(--text-muted)',
                        fontWeight: overrun ? 600 : 400,
                      }}
                      title={`Packaging peak: ${peakLoad.station} at ${peakLoad.usedMinutes}/${peakLoad.capacityMinutes} min (${Math.round(peakLoad.utilisation * 100)}%)`}
                    >
                      P{Math.round(peakLoad.utilisation * 100)}%
                    </span>
                  )}
                </div>
              </div>
              {/* Phase 4l.12 — per-station packaging unit totals.
                  H=hand-packing E=elephant D=dust B=bottlo.
                  Lowercase + faint grey to distinguish from the
                  utilisation indicators (especially "D" for Dehydrator).
                  Only stations with any units are shown. */}
              {(() => {
                let handUnits = 0;
                let elephantUnits = 0;
                let dustUnits = 0;
                let bottloUnits = 0;
                for (const a of dayActivities) {
                  if (a.kind !== 'packaging') continue;
                  if (isDismissed(mutations, a.stableId)) continue;
                  const q = Math.round(a.quantity);
                  if (a.station === 'hand-packing') handUnits += q;
                  else if (a.station === 'elephant') elephantUnits += q;
                  else if (a.station === 'dust') dustUnits += q;
                  else if (a.station === 'bottlo') bottloUnits += q;
                }
                const totalPackagingUnits = handUnits + elephantUnits + dustUnits + bottloUnits;
                if (totalPackagingUnits === 0) return null;
                const badge = (letter: string, units: number, label: string) => (
                  units > 0 ? (
                    <span
                      style={{ color: 'var(--text-primary)', fontWeight: 500 }}
                      title={`${label}: ${units.toLocaleString()} units`}
                    >
                      <span style={{ opacity: 0.7, marginRight: 1 }}>{letter}</span>
                      {units.toLocaleString()}
                    </span>
                  ) : null
                );
                return (
                  <div
                    style={{
                      display: 'flex',
                      gap: 6,
                      justifyContent: 'flex-end',
                      alignItems: 'baseline',
                      fontSize: 10,
                      marginBottom: 4,
                      letterSpacing: '0.02em',
                    }}
                  >
                    {badge('h', handUnits, 'Hand-packing')}
                    {badge('e', elephantUnits, 'Elephant')}
                    {badge('d', dustUnits, 'Dust')}
                    {badge('b', bottloUnits, 'Bottlo')}
                    <span
                      style={{
                        color: 'var(--text-primary)',
                        fontWeight: 700,
                        fontSize: 11,
                        marginLeft: 2,
                      }}
                      title={`Total packaging units this day: ${totalPackagingUnits.toLocaleString()}`}
                    >
                      ={totalPackagingUnits.toLocaleString()}
                    </span>
                  </div>
                );
              })()}
              {(() => {
                // Render each (date, kind, productCode) group as either a
                // single ActivityChip (singleton) or a ClusterChip (≥2 members).
                // Tracks seen stableIds so cluster members aren't rendered twice.
                //
                // Phase 4l.11 — also dedupe by cluster key directly so a
                // stale memo state, repeated chip objects in dayActivities,
                // or stableId collisions can't ever produce two ClusterChips
                // with the same React key (which trips a React warning and
                // makes one of them effectively invisible).
                const rendered: React.ReactElement[] = [];
                const seen = new Set<string>();
                const pushedClusterKeys = new Set<string>();
                for (const a of dayActivities) {
                  if (seen.has(a.stableId)) continue;
                  const cluster = clusterMembersByStableId.get(a.stableId);
                  if (cluster && cluster.length >= 2) {
                    const clusterKey = `cluster|${a.date}|${a.kind}|${a.productCode}`;
                    if (pushedClusterKeys.has(clusterKey)) {
                      // Already rendered this group — mark this chip's
                      // stableId to suppress a singleton fallback below.
                      seen.add(a.stableId);
                      continue;
                    }
                    pushedClusterKeys.add(clusterKey);
                    for (const m of cluster) seen.add(m.stableId);
                    rendered.push(
                      <ClusterChip
                        key={clusterKey}
                        members={cluster}
                        selectedId={selectedId}
                        selectedStableId={selectedStableId}
                        mutations={mutations}
                        conflictsByConsumer={conflictsByConsumer}
                        unplaceableSet={unplaceableSet}
                        supplyStarvedSet={supplyStarvedSet}
                        relatedHighlight={relatedHighlight}
                        hoveredStableId={hoveredStableId}
                        registerRef={registerChipRef}
                        onHover={onChipHover}
                        onSelect={onSelect}
                      />
                    );
                    continue;
                  }
                  seen.add(a.stableId);
                  const supplyZeroed =
                    a.kind === 'packaging' &&
                    a.supplyCappedFrom !== undefined &&
                    a.quantity <= 0;
                  rendered.push(
                    <ActivityChip
                      key={a.id}
                      activity={a}
                      // Match by stableId (durable identity) primarily,
                      // with id as fallback — keeps the selection visual
                      // intact across mutations + layer toggles where
                      // `a.id` might shift but `stableId` won't.
                      selected={
                        a.stableId === selectedStableId || a.id === selectedId
                      }
                      dismissed={isDismissed(mutations, a.stableId) || supplyZeroed}
                      conflicted={conflictsByConsumer.has(a.stableId)}
                      unplaceable={unplaceableSet.has(a.stableId)}
                      supplyStarved={supplyStarvedSet.has(a.stableId)}
                      relatedKind={relatedHighlight.get(a.stableId) ?? null}
                      isHoveredSource={hoveredStableId === a.stableId}
                      registerRef={registerChipRef}
                      onHover={onChipHover}
                      onClick={() => onSelect(a)}
                      availability={chipAvailabilityByStableId.get(a.stableId) ?? null}
                    />
                  );
                }
                return rendered;
              })()}
              {(peakLoad || kitchenLoad) && (
                <div
                  style={{
                    position: 'absolute',
                    bottom: 0,
                    left: 0,
                    right: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 1,
                  }}
                >
                  {/* Kitchen-team sub-bar (Phase 4l.7). Positioned ABOVE
                      the packaging bar so packaging stays the canonical
                      "bottom strip" the user is used to. Italic K marker
                      in the corner makes the bar's identity obvious without
                      a legend. */}
                  {kitchenLoad && (
                    <div
                      style={{
                        height: 2,
                        background: 'var(--border)',
                      }}
                    >
                      <div
                        style={{
                          width: `${Math.min(100, kitchenLoad.utilisation * 100)}%`,
                          height: '100%',
                          background: kitchenOverrun
                            ? '#dc2626'
                            : kitchenLoad.utilisation > 0.85
                            ? '#d97706'
                            : '#a78bfa',
                        }}
                      />
                    </div>
                  )}
                  {peakLoad && (
                    <div
                      style={{
                        height: 3,
                        background: 'var(--border)',
                      }}
                    >
                      <div
                        style={{
                          width: `${Math.min(100, peakLoad.utilisation * 100)}%`,
                          height: '100%',
                          background: overrun
                            ? '#dc2626'
                            : peakLoad.utilisation > 0.85
                            ? '#d97706'
                            : '#10b981',
                        }}
                      />
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {/* ─── Hover-arrow overlay (Phase 4l.5) ─────────────────
            Absolutely positioned over the month grid; pointer-events:none
            so day cells/chips remain interactive. Drawn only while a chip
            in this month is hovered AND has visible related chips. */}
        {arrows.length > 0 && (
          <svg
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              pointerEvents: 'none',
              overflow: 'visible',
            }}
            aria-hidden="true"
          >
            <defs>
              <marker
                id={`arrow-into-packaging-${label}`}
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill="#059669" />
              </marker>
              <marker
                id={`arrow-into-kitchen-${label}`}
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill="#d97706" />
              </marker>
            </defs>
            {arrows.map((a) => (
              <line
                key={a.id + a.flowsInto + (a.phantom ? '-phantom' : '')}
                x1={a.x1}
                y1={a.y1}
                x2={a.x2}
                y2={a.y2}
                stroke={
                  a.phantom
                    ? '#dc2626' // red — phantom (starved consumer)
                    : a.flowsInto === 'into-packaging'
                    ? '#059669'
                    : '#d97706'
                }
                strokeWidth={a.phantom ? 1.25 : 1.5}
                strokeOpacity={a.phantom ? 0.55 : 0.8}
                strokeDasharray={a.phantom ? '2 4' : '4 3'}
                markerEnd={
                  a.phantom ? undefined : `url(#arrow-${a.flowsInto}-${label})`
                }
              >
                {a.phantom && (
                  <title>
                    Supply shortage — this consumer was starved at its scheduled
                    date. Would have pulled from this supplier if earlier
                    consumers hadn&apos;t drained the pool.
                  </title>
                )}
              </line>
            ))}
          </svg>
        )}
      </div>
    </div>
  );
}

function ActivityChip({
  activity,
  selected,
  dismissed,
  conflicted,
  unplaceable,
  supplyStarved,
  relatedKind,
  isHoveredSource,
  registerRef,
  onHover,
  onClick,
  availability,
}: {
  activity: CalendarActivity;
  selected: boolean;
  dismissed: boolean;
  conflicted: boolean;
  unplaceable: boolean;
  /** True when at least one ingredient FIFO-allocated to this chip is a phantom — i.e. the chip can't actually run because an input won't be there on time. */
  supplyStarved: boolean;
  /** Highlight as supplier/consumer of the currently-hovered chip, or null. */
  relatedKind: 'supplier' | 'consumer' | null;
  /** True when THIS chip is the one being hovered. Drives the source-glow style. */
  isHoveredSource: boolean;
  /** Callback-ref hook so MonthBlock can resolve this chip's DOM position. */
  registerRef: (stableId: string, el: HTMLElement | null) => void;
  /** Hover handler — id on enter, null on leave. */
  onHover: (id: string | null) => void;
  onClick: () => void;
  /**
   * Phase 4l.11: per-chip per-day inventory ratio samples spanning the
   * full horizon, plus optional shortage ratios (when demand exceeded
   * supply at any point) and the chip's own day-index for the marker.
   * Drives the SVG sparkline overlay — main curve at the bottom for
   * inventory, inverted curve hanging from the top for shortage.
   */
  availability: {
    ratios: number[];
    shortageRatios: number[] | null;
    /** Phase 4l.12: per-day SOH floor target normalised to the same
     *  peak as `ratios`. Null when the product has no demand-derived
     *  floor (= no forecast → no sensible target). */
    floorRatios: number[] | null;
    chipDateIndex: number;
    predictedSoh: number | null;
    availableDays: number | null;
  } | null;
}) {
  const colors = colorOf(activity);
  // Phase 4l.11 — solid chip background plus a tiny SVG inventory
  // sparkline at the bottom. Applies to ALL chip kinds (packaging,
  // kitchen, kitchen-required, po-placed, po-receiving): each shows
  // its product's inventory journey across the horizon. The dashed
  // vertical marker on the sparkline indicates where THIS chip's date
  // falls in that journey.
  const hasInventoryData = availability != null && availability.ratios.length > 1;
  const bgStyle = colors.bg;
  const chipTextColor = colors.text;
  const chipTextShadow: string | undefined = undefined;
  const chipTextWeight = 500;
  const chipLetterSpacing: string | undefined = undefined;
  // Local "is dragging" state controls opacity feedback. Reset on dragend.
  const [isDragging, setIsDragging] = useState(false);
  // PO chips have derived dates (computed from kitchen demand + lead time)
  // and aren't draggable — moving them would mislead the user about what
  // actually changes the timeline.
  const isPo = activity.kind === 'po-placed' || activity.kind === 'po-receiving';
  // Unleashed-resident POs (Phase 4l.5) are view-only — committed in
  // Unleashed, can't be edited in the planner. We render a "U" badge on
  // the chip and a different drawer below.
  const isUnleashedPo = activity.poInfo?.source === 'unleashed_po';
  // Phase 4l.14 — committed Unleashed assemblies are anchors of truth:
  // moving the chip wouldn't move the actual assembly in Unleashed, so
  // they're locked. The sole exception is `Parked` (a draft the operator
  // hasn't committed) which the user IS allowed to drag / date-edit.
  const isCommittedAssembly =
    !!activity.assemblyNumber && activity.assemblyStatus !== 'Parked';
  const isMovable = !isPo && !isCommittedAssembly;
  // Phase 4l.12 — manual user-added chips (dragged from the left-rail
  // lookup or infeasible list). They're easy to lose in a busy day with
  // 20+ chips, especially with q=1 / no profit data. Distinguish them
  // with a dashed border + an "M" badge so the user can always find what
  // they just dropped.
  const isManual = activity.stableId.startsWith('manual|');
  // Compose the box-shadow: conflict (red) + related (green/orange) +
  // hovered-source (blue) + SELECTED (dark + lift) can stack.
  const shadows: string[] = [];
  // Phase 4l.12: conflict border softened from alarming red (#dc2626)
  // to amber (#f59e0b). Conflicts are common enough that a softer
  // warning colour reduces fatigue; phantom arrows still use red.
  if (conflicted) shadows.push('inset 0 0 0 1.5px #f59e0b');
  if (relatedKind === 'supplier') shadows.push('inset 0 0 0 1.5px #059669');
  if (relatedKind === 'consumer') shadows.push('inset 0 0 0 1.5px #d97706');
  if (isHoveredSource) shadows.push('0 0 0 2px #3b82f6');
  if (unplaceable) shadows.push('inset 0 0 0 1.5px #d97706');
  // Phase 4l.12 — supply-starved chips get a distinct red inset ring,
  // strong enough to compete with the amber conflict ring so a chip
  // that is BOTH conflicted and starved reads as starved (the more
  // alarming state — chip cannot physically run).
  if (supplyStarved) shadows.push('inset 0 0 0 2px #dc2626');
  // Phase 4l.12 — selected chip gets a strong drop-shadow + thicker
  // dark outline so it visually "lifts" off the calendar. The previous
  // 1.5px chip-coloured outline blended in with chips that share the
  // border colour (most of the green packaging chips have ~the same
  // dark-green border). The new style is colour-independent.
  if (selected) shadows.push('0 6px 16px rgba(0, 0, 0, 0.35)');
  return (
    <button
      type="button"
      onClick={onClick}
      ref={(el) => registerRef(activity.stableId, el)}
      // data-chip-id lets the drawer find this DOM element via a global
      // selector so clicking a supplier/consumer in the drawer can
      // scroll the calendar to bring the related chip into view. Plain
      // `id` would collide if a chip cluster duplicates a stableId; the
      // data-attribute survives React's commit cycle and is queryable
      // from anywhere in the page.
      data-chip-id={activity.stableId}
      onMouseEnter={() => onHover(activity.stableId)}
      onMouseLeave={() => onHover(null)}
      // Dragging the chip writes its stableId to the dataTransfer; day cells
      // read that to apply a reschedule mutation. PO chips opt out — their
      // dates are derived, not authoritative.
      draggable={isMovable}
      onDragStart={(e) => {
        if (!isMovable) {
          e.preventDefault();
          return;
        }
        e.dataTransfer.setData('text/plain', activity.stableId);
        e.dataTransfer.effectAllowed = 'move';
        setIsDragging(true);
        // Drop hover on drag-start: the user is no longer pointing at it.
        onHover(null);
      }}
      onDragEnd={() => setIsDragging(false)}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        padding: '2px 6px',
        margin: '1px 0',
        fontSize: 11,
        fontWeight: chipTextWeight,
        letterSpacing: chipLetterSpacing,
        background: bgStyle,
        color: chipTextColor,
        textShadow: chipTextShadow,
        borderRadius: 3,
        border: isManual ? '1.5px dashed #1f2937' : 'none',
        // Phase 4l.12 — selected chip lifted by drop shadow + scale
        // only. No outline, no special left bar — the chip's normal
        // coloured border + the lift do the work.
        borderLeft: isManual ? '4px solid #1f2937' : `3px solid ${colors.border}`,
        outline: 'none',
        cursor: !isMovable ? 'pointer' : isDragging ? 'grabbing' : 'grab',
        fontFamily: 'inherit',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        opacity: isDragging ? 0.4 : dismissed ? 0.35 : 1,
        textDecoration: dismissed ? 'line-through' : 'none',
        boxShadow: shadows.length > 0 ? shadows.join(', ') : undefined,
        position: 'relative',
        zIndex: selected ? 3 : isHoveredSource ? 2 : 'auto',
        transform: selected ? 'scale(1.05)' : undefined,
        transformOrigin: 'left center',
        transition: 'transform 100ms ease, box-shadow 100ms ease',
      }}
      title={
        activity.kind === 'po-placed'
          ? `PLACE PO · ${activity.productCode} — ${activity.productName}\nQty ${Math.round(activity.quantity).toLocaleString()}\nPlace by ${activity.poInfo ? fmtDate(activity.poInfo.placeByDate) : '?'}, arrives ${activity.poInfo ? fmtDate(activity.poInfo.arriveByDate) : '?'} (${activity.poInfo?.leadTimeDays}-day lead time)${activity.poInfo?.overdue ? '\n⚠ OVERDUE — placeBy is in the past' : ''}`
          : activity.kind === 'po-receiving' && isUnleashedPo
          ? `UNLEASHED PO · ${activity.productCode} — ${activity.productName}\nQty ${Math.round(activity.quantity).toLocaleString()}\nPO #${activity.poInfo?.purchaseOrderNumber} (${activity.poInfo?.status})\nSupplier: ${activity.poInfo?.supplierName ?? '?'}\nExpected: ${fmtDate(activity.date)}\n(view-only — edit in Unleashed)`
          : activity.kind === 'po-receiving'
          ? `RECEIVE PO · ${activity.productCode} — ${activity.productName}\nQty ${Math.round(activity.quantity).toLocaleString()}\nArrive by ${activity.poInfo ? fmtDate(activity.poInfo.arriveByDate) : '?'}, place by ${activity.poInfo ? fmtDate(activity.poInfo.placeByDate) : '?'} (${activity.poInfo?.leadTimeDays}-day lead time)${activity.poInfo?.overdue ? '\n⚠ Linked PO is OVERDUE' : ''}`
          : activity.kind === 'kitchen-required'
          ? `${activity.productCode} — ${activity.productName} — REQUIRED ${activity.quantity} units · starts ${fmtDate(activity.date)}, finishes ${activity.finishDate ? fmtDate(activity.finishDate) : '?'}, available ${activity.requiredByDate ? fmtDate(activity.requiredByDate) : '?'}`
          : dismissed
          ? `${activity.productCode} — ${activity.productName} — DISMISSED (${activity.quantity} units, ${Math.round(activity.durationMinutes)} min)`
          : unplaceable
          ? `${activity.productCode} — ${activity.productName} — Resolve all couldn't find a feasible date for this chip (no working day with capacity within search horizon)`
          : `${activity.productCode} — ${activity.productName} (${activity.quantity} units, ${Math.round(activity.durationMinutes)} min)`
      }
    >
      {/* Phase 4l.11 — shortage sparkline hangs from the chip's TOP border.
          Absolutely positioned overlay (no reserved height) — passes
          through the chip content if it has to. Only rendered when
          demand exceeded supply at some point in the horizon. */}
      {hasInventoryData && availability && (() => {
        const VIEW_W = 100;
        const VIEW_H = 6;
        const sgeom = buildShortageGeometry(
          availability.shortageRatios,
          VIEW_W,
          VIEW_H,
        );
        if (!sgeom) return null;
        const SHORTAGE_LINE = '#dc2626';
        const SHORTAGE_FILL = 'rgba(220, 38, 38, 0.28)';
        return (
          <svg
            viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
            preserveAspectRatio="none"
            aria-hidden="true"
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              width: '100%',
              height: 6,
              overflow: 'visible',
              pointerEvents: 'none',
            }}
          >
            <path d={sgeom.fillPath} fill={SHORTAGE_FILL} stroke="none" />
            <polyline
              points={sgeom.points}
              fill="none"
              stroke={SHORTAGE_LINE}
              strokeWidth={1}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        );
      })()}
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          minWidth: 0,
          position: 'relative',
          zIndex: 1,
          // Chip-bg-coloured halo punches the text through any sparkline
          // pixels underneath. Crisp 1px outline: zero-blur shadows in
          // 4 cardinal directions — text reads "stencilled" through
          // the sparkline beneath.
          textShadow: `1px 0 0 ${colors.bg}, -1px 0 0 ${colors.bg}, 0 1px 0 ${colors.bg}, 0 -1px 0 ${colors.bg}`,
        }}
      >
        <span
          style={{
            flex: 1,
            minWidth: 0,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
        {conflicted && <span style={{ marginRight: 3 }}>⚠</span>}
        {unplaceable && !conflicted && <span style={{ marginRight: 3 }}>⚠</span>}
        {activity.kind === 'po-placed' && (
          <span style={{ marginRight: 3, fontWeight: 600 }}>
            {activity.poInfo?.overdue ? '⚠ ' : ''}PO→
          </span>
        )}
        {activity.kind === 'po-receiving' && (
          <span style={{ marginRight: 3, fontWeight: 600 }}>
            {activity.poInfo?.overdue ? '⚠ ' : ''}↓PO
            {isUnleashedPo && (
              <span
                title="Unleashed PO (view-only)"
                style={{
                  marginLeft: 2,
                  padding: '0 3px',
                  borderRadius: 2,
                  background: '#1e40af',
                  color: '#fff',
                  fontSize: 9,
                  fontWeight: 700,
                }}
              >
                U
              </span>
            )}
          </span>
        )}
        {isManual && (
          <span
            title="Manual chip — added by drag-and-drop from the lookup / infeasible panel. Not produced by the planner."
            style={{
              marginRight: 4,
              padding: '0 4px',
              borderRadius: 2,
              background: '#1f2937',
              color: '#ffffff',
              fontSize: 9,
              fontWeight: 700,
              letterSpacing: '0.04em',
              verticalAlign: 'baseline',
            }}
          >
            M
          </span>
        )}
        {supplyStarved && (
          <span
            title="Supply-starved — at least one required ingredient has no real supplier finishing in time. This chip will not actually run as scheduled. Open the drawer to see which inputs are phantom; move the chip later, or reschedule the upstream production."
            style={{
              marginRight: 4,
              padding: '0 4px',
              borderRadius: 2,
              background: '#dc2626',
              color: '#ffffff',
              fontSize: 9,
              fontWeight: 700,
              letterSpacing: '0.04em',
              verticalAlign: 'baseline',
            }}
          >
            ⛔
          </span>
        )}
        {activity.productCode} <span style={{ opacity: 0.7 }}>×{Math.round(activity.quantity)}</span>
        {activity.kind === 'packaging' && activity.profitPerItem == null && (
          <span
            title="Profit data missing for this SKU — add it to data/_profit-gaps-todo.tsv (then re-run scripts/build-profit.js). Chip is sorted by a median-profit heuristic until then."
            style={{
              marginLeft: 3,
              opacity: 0.6,
              fontSize: 9,
              fontWeight: 600,
            }}
          >
            ?$
          </span>
        )}
        {activity.orphan && (
          <span
            title="ORPHAN — this Unleashed assembly's intermediate isn't consumed by any current packaging chip. Likely stale; close out in Unleashed."
            style={{
              marginLeft: 4,
              padding: '0 4px',
              borderRadius: 2,
              background: '#92400e',
              color: '#fff',
              fontSize: 9,
              fontWeight: 700,
              letterSpacing: '0.04em',
            }}
          >
            ORPHAN
          </span>
        )}
        {activity.kind === 'kitchen-required' && activity.redundantWithUnleashed && activity.redundantWithUnleashed.length > 0 && (
          <span
            title={`Unleashed has ${activity.redundantWithUnleashed.length} parked assembly(ies) for this intermediate that arrived too late to plug the original shortage — pulling one forward in Unleashed could let you drop this run. ${activity.redundantWithUnleashed.slice(0, 3).map((u) => `${u.assembly} (${u.quantity}kg, ${u.date})`).join(', ')}${activity.redundantWithUnleashed.length > 3 ? ` …+${activity.redundantWithUnleashed.length - 3} more` : ''}`}
            style={{
              marginLeft: 4,
              padding: '0 4px',
              borderRadius: 2,
              background: '#a16207',
              color: '#fff',
              fontSize: 9,
              fontWeight: 700,
              letterSpacing: '0.04em',
            }}
          >
            UNLEASHED↗
          </span>
        )}
        {activity.kind === 'packaging' && activity.supplyCappedFrom !== undefined && (
          <span
            style={{ marginLeft: 4, opacity: 0.7, fontSize: 9 }}
            title={`Capped from ${Math.round(activity.supplyCappedFrom)} by ${activity.supplyCappedBy ?? 'upstream'} supply (Phase 4l.10 supply-cap)`}
          >
            ↓{Math.round(activity.supplyCappedFrom)}
          </span>
        )}
        {activity.kind === 'kitchen-required' && activity.durationDays && activity.durationDays > 1 && (
          <span style={{ opacity: 0.7 }}> · {activity.durationDays}d</span>
        )}
        </span>
        {/* Phase 4l.12 — Unleashed assembly status letter, far-right.
            K=Parked, P=Planned, O=Open, T=Todo, I=Inventory Mgr,
            ! =Priority, U=Unapproved. No outline / no background —
            just the letter in a meaningful colour. */}
        {activity.assemblyStatus && (() => {
          const status = activity.assemblyStatus;
          const map: Record<string, { letter: string; color: string }> = {
            Parked:        { letter: 'K', color: '#6b7280' },  // grey
            Planned:       { letter: 'P', color: '#3b82f6' },  // blue
            Open:          { letter: 'O', color: '#10b981' },  // green
            'To Do':       { letter: 'T', color: '#d97706' },  // amber
            Todo:          { letter: 'T', color: '#d97706' },
            'Inventory Mgr': { letter: 'I', color: '#a855f7' }, // purple
            Priority:      { letter: '!', color: '#dc2626' },  // red
            Unapproved:    { letter: 'U', color: '#92400e' },  // brown
          };
          const entry =
            map[status] ?? { letter: status[0]?.toUpperCase() ?? '?', color: '#6b7280' };
          return (
            <span
              title={`Unleashed status: ${status} (assembly ${activity.assemblyNumber ?? '?'})`}
              style={{
                marginLeft: 'auto',
                paddingLeft: 6,
                color: entry.color,
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: '0.04em',
                flexShrink: 0,
              }}
            >
              {entry.letter}
            </span>
          );
        })()}
      </div>
      {activity.productName && activity.productName !== activity.productCode && (
        <div
          style={{
            fontSize: 9,
            // Phase 4l.12 — increased subtext contrast. Previously 0.65
            // opacity made the product name washed out on pale chips
            // (low-profit / missing-profit). Bumped to 0.9 with explicit
            // font weight so the chip's main label and the subtext
            // both read clearly.
            opacity: 0.9,
            fontWeight: 500,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            marginTop: 1,
            lineHeight: 1.2,
            position: 'relative',
            zIndex: 1,
            // Crisp 1px outline: zero-blur shadows in 4 cardinal
            // directions so the text reads cleanly over any sparkline
            // pixels that may be underneath.
            textShadow: `1px 0 0 ${colors.bg}, -1px 0 0 ${colors.bg}, 0 1px 0 ${colors.bg}, 0 -1px 0 ${colors.bg}`,
          }}
        >
          {activity.productName}
        </div>
      )}
      {/* Phase 4l.12 — projected SOH + available-days, right-aligned.
          For chips in the future this is the PREDICTED stock-on-hand at
          the chip's date (from the inventory timeline) and how many days
          of forward demand it covers. Packaging chips only — kitchen/PO
          chips trace intermediate/raw-material curves where "available
          days" is less meaningful for the operator. */}
      {activity.kind === 'packaging' &&
        availability &&
        availability.predictedSoh != null && (
          <div
            title={`Projected stock-on-hand at ${fmtDate(activity.date)}: ${Math.round(availability.predictedSoh).toLocaleString()} units${availability.availableDays != null ? ` — ${Math.round(availability.availableDays)} days of forward cover at current demand` : ' — no forecast demand (cover not applicable)'}`}
            style={{
              display: 'flex',
              justifyContent: 'flex-end',
              gap: 6,
              fontSize: 9,
              fontWeight: 600,
              opacity: 0.95,
              marginTop: 1,
              lineHeight: 1.2,
              position: 'relative',
              zIndex: 1,
              whiteSpace: 'nowrap',
              textShadow: `1px 0 0 ${colors.bg}, -1px 0 0 ${colors.bg}, 0 1px 0 ${colors.bg}, 0 -1px 0 ${colors.bg}`,
            }}
          >
            <span style={{ opacity: 0.7 }}>SOH</span>
            <span>{Math.round(availability.predictedSoh).toLocaleString()}</span>
            {availability.availableDays != null && (
              <span
                style={{
                  // Amber when cover drops below the 10-day floor target,
                  // so a thin-stock chip flags itself at a glance.
                  color:
                    availability.availableDays < SOH_FLOOR_DAYS
                      ? '#b45309'
                      : 'inherit',
                }}
              >
                {Math.round(availability.availableDays)}d
              </span>
            )}
          </div>
        )}
      {/* Phase 4l.11 — inventory sparkline overlay for packaging chips.
          Absolutely positioned along the chip's BOTTOM edge so it costs
          no vertical space — it passes through the chip text if the
          chip is short. A vertical dashed marker indicates where this
          chip's date lands on the inventory journey. */}
      {hasInventoryData && availability && (() => {
        const VIEW_W = 100;
        const VIEW_H = 14;
        const geom = buildSparklineGeometry(
          availability.ratios,
          availability.chipDateIndex,
          VIEW_W,
          VIEW_H,
        );
        const floorPoints = buildFloorPoints(
          availability.floorRatios,
          VIEW_W,
          VIEW_H,
        );
        const lineColor = colors.border;
        // Phase 4l.12 — area below the inventory curve uses the chip's
        // background colour (was: 20%-alpha border tint, which darkened
        // the bottom strip). The fill now blends seamlessly with the
        // rest of the chip; only the curve + marker remain visually
        // distinct.
        const fillColor = colors.bg;
        return (
          <svg
            viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
            preserveAspectRatio="none"
            aria-hidden="true"
            style={{
              position: 'absolute',
              bottom: 0,
              left: 0,
              right: 0,
              width: '100%',
              height: 14,
              overflow: 'visible',
              pointerEvents: 'none',
            }}
          >
            <path d={geom.fillPath} fill={fillColor} stroke="none" />
            <polyline
              points={geom.points}
              fill="none"
              stroke={lineColor}
              strokeWidth={1}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
            {/* Phase 4l.12 — SOH floor reference line. Dashed amber so it
                reads as a "target, not actual" line. Inventory dropping
                below this line visually flags an unmet floor target. */}
            {floorPoints && (
              <polyline
                points={floorPoints}
                fill="none"
                stroke="#d97706"
                strokeWidth={0.8}
                strokeOpacity={0.7}
                strokeDasharray="2 2"
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            )}
            {geom.markerX != null && (
              <line
                x1={geom.markerX}
                y1={0}
                x2={geom.markerX}
                y2={VIEW_H}
                stroke="rgba(0, 0, 0, 0.5)"
                strokeWidth={1}
                strokeDasharray="2 2"
                vectorEffect="non-scaling-stroke"
              />
            )}
          </svg>
        );
      })()}
    </button>
  );
}

/**
 * Cluster chip (Phase 4l.6) — renders a single chip in place of N chips
 * that share (date, productCode, kind). Click selects the first member;
 * the drawer surfaces the full cluster so the user can drill in.
 *
 * Not draggable (which constituent would move?). Conflict / unplaceable /
 * related-highlight flags are OR'd across members.
 */
function ClusterChip({
  members,
  selectedId,
  selectedStableId,
  mutations,
  conflictsByConsumer,
  unplaceableSet,
  supplyStarvedSet,
  relatedHighlight,
  hoveredStableId,
  registerRef,
  onHover,
  onSelect,
}: {
  members: ReadonlyArray<CalendarActivity>;
  selectedId: string | null;
  selectedStableId: string | null;
  mutations: MutationsMap;
  conflictsByConsumer: Map<string, ScheduleConflict[]>;
  unplaceableSet: ReadonlySet<string>;
  supplyStarvedSet: ReadonlySet<string>;
  relatedHighlight: ReadonlyMap<string, 'supplier' | 'consumer'>;
  hoveredStableId: string | null;
  registerRef: (stableId: string, el: HTMLElement | null) => void;
  onHover: (id: string | null) => void;
  onSelect: (a: CalendarActivity) => void;
}) {
  const first = members[0];
  const colors = colorOf(first);
  const totalQty = members.reduce((s, m) => s + m.quantity, 0);
  const allDismissed = members.every((m) => isDismissed(mutations, m.stableId));
  const anyConflict = members.some((m) => conflictsByConsumer.has(m.stableId));
  const anyUnplaceable = members.some((m) => unplaceableSet.has(m.stableId));
  const anyStarved = members.some((m) => supplyStarvedSet.has(m.stableId));
  const anyRelated = (() => {
    for (const m of members) {
      const k = relatedHighlight.get(m.stableId);
      if (k) return k;
    }
    return null;
  })();
  const anyHovered = members.some((m) => hoveredStableId === m.stableId);
  const anySelected = members.some(
    (m) => m.stableId === selectedStableId || m.id === selectedId,
  );

  // Register the SAME DOM node under every member's stableId so arrows
  // pointing to any constituent resolve to this cluster chip.
  const refSetter = (el: HTMLElement | null) => {
    for (const m of members) registerRef(m.stableId, el);
  };
  // Hover: pick the first member's stableId so the arrow drawer has
  // something to look up. Future: union relationships across members.
  const onMouseEnter = () => onHover(first.stableId);
  const onMouseLeave = () => onHover(null);

  const shadows: string[] = [];
  if (anyConflict) shadows.push('inset 0 0 0 1.5px #f59e0b');
  if (anyStarved) shadows.push('inset 0 0 0 2px #dc2626');
  if (anyRelated === 'supplier') shadows.push('inset 0 0 0 1.5px #059669');
  if (anyRelated === 'consumer') shadows.push('inset 0 0 0 1.5px #d97706');
  if (anyHovered) shadows.push('0 0 0 2px #3b82f6');
  if (anyUnplaceable) shadows.push('inset 0 0 0 1.5px #d97706');
  if (anySelected) shadows.push('0 6px 16px rgba(0, 0, 0, 0.35)');

  const titleLines = [
    `${first.productCode} · ${members.length} chips on ${fmtDate(first.date)}`,
    `Combined qty: ${Math.round(totalQty).toLocaleString()}`,
    '',
    ...members.map((m, i) => `${i + 1}. ${Math.round(m.quantity)} units (id: ${m.stableId})`),
    '',
    'Click to open drawer — switch between cluster members from there.',
  ];

  return (
    <button
      type="button"
      onClick={() => onSelect(first)}
      ref={refSetter}
      // data-chip-ids = space-separated list of every cluster member's
      // stableId. Drawer's scroll-to-chip uses `[data-chip-ids~="X"]`
      // (CSS attribute whitespace selector) so clicking a related
      // supplier/consumer that happens to be inside a cluster still
      // scrolls the parent cluster chip into view.
      data-chip-ids={members.map((m) => m.stableId).join(' ')}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      draggable={false}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        padding: '2px 6px',
        margin: '1px 0',
        fontSize: 11,
        background: colors.bg,
        color: colors.text,
        borderRadius: 3,
        border: 'none',
        borderLeft: `3px solid ${colors.border}`,
        outline: 'none',
        cursor: 'pointer',
        fontFamily: 'inherit',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        opacity: allDismissed ? 0.35 : 1,
        textDecoration: allDismissed ? 'line-through' : 'none',
        boxShadow: shadows.length > 0 ? shadows.join(', ') : undefined,
        position: 'relative',
        zIndex: anySelected ? 3 : anyHovered ? 2 : 'auto',
        transform: anySelected ? 'scale(1.05)' : undefined,
        transformOrigin: 'left center',
        transition: 'transform 100ms ease, box-shadow 100ms ease',
      }}
      title={titleLines.join('\n')}
    >
      <div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {anyConflict && <span style={{ marginRight: 3 }}>⚠</span>}
        {anyStarved && (
          <span
            title="At least one chip in this cluster is supply-starved — an upstream ingredient has no real supplier finishing in time."
            style={{
              marginRight: 4,
              padding: '0 4px',
              borderRadius: 2,
              background: '#dc2626',
              color: '#ffffff',
              fontSize: 9,
              fontWeight: 700,
              letterSpacing: '0.04em',
              verticalAlign: 'baseline',
            }}
          >
            ⛔
          </span>
        )}
        {first.productCode}{' '}
        <span style={{ opacity: 0.7 }}>×{Math.round(totalQty)}</span>{' '}
        <span
          style={{
            marginLeft: 2,
            padding: '0 4px',
            borderRadius: 2,
            background: colors.border,
            color: '#fff',
            fontSize: 9,
            fontWeight: 700,
          }}
        >
          ⊕{members.length}
        </span>
      </div>
      {first.productName && first.productName !== first.productCode && (
        <div
          style={{
            fontSize: 9,
            opacity: 0.65,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            marginTop: 1,
            lineHeight: 1.2,
          }}
        >
          {first.productName}
        </div>
      )}
    </button>
  );
}

function ActivityDrawer({
  activity,
  availability,
  original,
  routingRationale,
  dismissed,
  rescheduledTo: rescheduled,
  editedQuantity,
  editedLeadTimeDays,
  vendor,
  stationDailyMinutes,
  kitchenChipMinutes,
  productOverride,
  stationDailyOutput,
  globalShelfLifeDays,
  sohBreakdown,
  eligibleWarehouses,
  plannerInitialInventory,
  salesOrders,
  totalCommitted,
  conflicts,
  onResolveConflicts,
  onDismiss,
  onUndismiss,
  onReschedule,
  onClearReschedule,
  onEditQuantity,
  onClearEdit,
  onEditLeadTime,
  onClearLeadTime,
  onEditStation,
  onClearStation,
  stationOverridden,
  originalStation,
  clusterMembers,
  onSelectClusterMember,
  relatedChips,
  onSelectRelatedChip,
  onClose,
  focused,
  onToggleFocus,
}: {
  activity: CalendarActivity;
  /**
   * Per-day inventory ratio samples (+ optional shortage/floor ratios) for
   * the selected chip's product. Drives the demand sparkline rendered
   * below the drawer's product-name header. Null when no inventory data
   * is available for this chip — sparkline is skipped.
   */
  availability: {
    ratios: number[];
    shortageRatios: number[] | null;
    floorRatios: number[] | null;
    chipDateIndex: number;
  } | null;
  /** The unmutated activity from the server output — used to display "original" values. */
  original: CalendarActivity;
  routingRationale: string | null;
  dismissed: boolean;
  rescheduledTo: string | null;
  editedQuantity: number | null;
  /** Lead-time override on a PO chip (Phase 4m.4). null = use file default. */
  editedLeadTimeDays: number | null;
  /** Vendor name from the lead-times file, or null when missing. */
  vendor: string | null;
  stationDailyMinutes: number;
  /**
   * Per-recipe kitchen-team minutes consumed on the START day. `null` for
   * non-kitchen-required activities (Phase 4l.8).
   */
  kitchenChipMinutes: number | null;
  productOverride: ProductOverrideShape | undefined;
  stationDailyOutput: number;
  globalShelfLifeDays: number;
  /** Per-warehouse SOH breakdown for this product, or null when cache is empty. */
  sohBreakdown: Record<string, number> | null;
  /** Warehouses whose stock is summed into initialInventory (others displayed muted). */
  eligibleWarehouses: string[];
  /** What the planner used as initialInventory for this product. */
  plannerInitialInventory: number;
  /** Active sales-order lines for this product (sorted ascending by date). */
  salesOrders: Array<{
    orderNumber: string;
    customerName: string;
    orderStatus: string;
    requiredDate: string;
    quantityRemaining: number;
  }>;
  totalCommitted: number;
  conflicts: ScheduleConflict[];
  /** Auto-cascade resolver — push (consumers later) or pull (suppliers earlier). */
  onResolveConflicts: (strategy: ResolveStrategy) => void;
  onDismiss: () => void;
  onUndismiss: () => void;
  onReschedule: (newDate: string) => void;
  onClearReschedule: () => void;
  onEditQuantity: (qty: number) => void;
  onClearEdit: () => void;
  /** Apply a lead-time override (PO chips). */
  onEditLeadTime: (days: number) => void;
  onClearLeadTime: () => void;
  /** Phase 4l.8: change the packaging station for this chip. */
  onEditStation: (station: Station) => void;
  /** Phase 4l.8: revert station to the planner's original assignment. */
  onClearStation: () => void;
  /** Whether the current station is a user override (drawer shows "modified" badge). */
  stationOverridden: boolean;
  /** Planner-original station (shown as "was" tag when overridden). */
  originalStation: Station | null;
  /** Sibling activities sharing (date, productCode, kind), or null when singleton. */
  clusterMembers: ReadonlyArray<CalendarActivity> | null;
  /** Switch the drawer to a different cluster member. */
  onSelectClusterMember: (a: CalendarActivity) => void;
  /**
   * Phase 4l.12 — chips supplying/consuming this chip via the BOM,
   * resolved to their CalendarActivity (so we can display productCode,
   * date, qty, kind). `phantom: true` = starved consumer (red dashed
   * arrow on the canvas). null when the activity isn't in the visible
   * activity list (= it was dismissed or filtered).
   */
  relatedChips: ReadonlyArray<{
    activity: CalendarActivity;
    direction: 'supplier' | 'consumer';
    phantom: boolean;
  }>;
  /** Click handler to jump the drawer to a related chip. */
  onSelectRelatedChip: (a: CalendarActivity) => void;
  onClose: () => void;
  /** True when "view connected" is currently focusing this chip. */
  focused: boolean;
  /** Toggle the "view connected" focus mode — hides every other chip. */
  onToggleFocus: () => void;
}) {
  const colors = colorOf(activity);

  // Edit-quantity input local state — only commits to the mutation store on Apply.
  const [qtyInput, setQtyInput] = useState<string>('');
  useEffect(() => {
    setQtyInput(String(activity.quantity));
  }, [activity.quantity, activity.stableId]);

  const parsedQty = Number(qtyInput);
  const qtyValid = Number.isFinite(parsedQty) && parsedQty > 0;
  const qtyChanged = qtyValid && Math.round(parsedQty) !== Math.round(activity.quantity);

  // Warn if the edited batch would exceed station daily capacity in minutes.
  // Conservative: scale duration proportionally from current.
  const wouldOversize =
    qtyValid &&
    activity.quantity > 0 &&
    (activity.durationMinutes * (parsedQty / activity.quantity)) > stationDailyMinutes;

  // ─── PO chip lead-time editor state (Phase 4m.4) ──────────
  const isPo = activity.kind === 'po-placed' || activity.kind === 'po-receiving';
  // Phase 4l.14 — committed Unleashed assemblies can't be rescheduled in
  // the planner (anchors of truth — edit them in Unleashed). `Parked` is
  // the movable exception. Mirrors the chip's drag gate.
  const isCommittedAssembly =
    !!activity.assemblyNumber && activity.assemblyStatus !== 'Parked';
  const effectiveLeadTime =
    activity.poInfo
      ? editedLeadTimeDays ?? activity.poInfo.leadTimeDays
      : 0;
  const [leadInput, setLeadInput] = useState<string>('');
  useEffect(() => {
    if (isPo) setLeadInput(String(effectiveLeadTime));
  }, [activity.stableId, effectiveLeadTime, isPo]);
  const parsedLead = Number(leadInput);
  const leadValid = Number.isFinite(parsedLead) && parsedLead >= 0;
  const leadChanged = leadValid && Math.round(parsedLead) !== effectiveLeadTime;
  return (
    <aside
      style={{
        width: 320,
        padding: 20,
        borderLeft: '0.5px solid var(--border)',
        background: 'var(--bg-surface)',
        flexShrink: 0,
        position: 'sticky',
        top: 60, // matches the left rail's sticky offset
        maxHeight: 'calc(100vh - 60px)',
        overflowY: 'auto',
        alignSelf: 'flex-start',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12, gap: 8 }}>
        <h3
          style={{
            fontSize: 16,
            fontWeight: 600,
            lineHeight: 1.25,
            margin: 0,
            wordBreak: 'break-word',
          }}
          title={activity.productName}
        >
          {activity.productName}
        </h3>
        <button
          type="button"
          onClick={onClose}
          style={{
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            color: 'var(--text-muted)',
            fontSize: 18,
            padding: 4,
            flexShrink: 0,
            lineHeight: 1,
          }}
          aria-label="Close drawer"
        >
          ×
        </button>
      </div>

      {/* Demand sparkline — replicates the inventory curve drawn on the
          chip itself, just below the product-name header. Same shape and
          colours so the drawer feels like a zoomed-in version of the
          chip. Skipped silently when no availability data is available
          (e.g. PO chips, or products with zero forecast). */}
      {availability && availability.ratios.length > 1 && (() => {
        const VIEW_W = 100;
        const VIEW_H = 28; // taller than the chip's 14px so detail reads
        const geom = buildSparklineGeometry(
          availability.ratios,
          availability.chipDateIndex,
          VIEW_W,
          VIEW_H,
        );
        const floorPoints = buildFloorPoints(
          availability.floorRatios,
          VIEW_W,
          VIEW_H,
        );
        const shortageGeom = buildShortageGeometry(
          availability.shortageRatios,
          VIEW_W,
          6, // shortage strip — small inverted overlay at the top
        );
        return (
          <div
            style={{
              marginBottom: 12,
              padding: '4px 6px',
              background: colors.bg,
              border: `0.5px solid ${colors.border}`,
              borderRadius: 4,
              position: 'relative',
            }}
            title="Demand sparkline — projected inventory ratio across the horizon. Dashed vertical line = this chip's date. Dashed amber line = SOH floor target. Red curve from top = shortage (demand exceeded supply on those days)."
          >
            <svg
              viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
              preserveAspectRatio="none"
              aria-hidden="true"
              style={{
                display: 'block',
                width: '100%',
                height: VIEW_H,
                overflow: 'visible',
              }}
            >
              {/* Main inventory curve (chip-coloured area + border line). */}
              <path d={geom.fillPath} fill={colors.bg} stroke="none" />
              <polyline
                points={geom.points}
                fill="none"
                stroke={colors.border}
                strokeWidth={1.2}
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
              {/* SOH floor reference line (dashed amber). */}
              {floorPoints && (
                <polyline
                  points={floorPoints}
                  fill="none"
                  stroke="#d97706"
                  strokeWidth={1}
                  strokeOpacity={0.75}
                  strokeDasharray="2 2"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                />
              )}
              {/* Shortage overlay — inverted curve hanging from top. */}
              {shortageGeom && (
                <path
                  d={shortageGeom.fillPath}
                  fill="rgba(220, 38, 38, 0.25)"
                  stroke="#dc2626"
                  strokeWidth={1}
                  vectorEffect="non-scaling-stroke"
                />
              )}
              {/* Chip-date marker (dashed dark vertical). */}
              {geom.markerX != null && (
                <line
                  x1={geom.markerX}
                  y1={0}
                  x2={geom.markerX}
                  y2={VIEW_H}
                  stroke="rgba(0, 0, 0, 0.55)"
                  strokeWidth={1}
                  strokeDasharray="2 2"
                  vectorEffect="non-scaling-stroke"
                />
              )}
            </svg>
          </div>
        );
      })()}

      {/* Kind badge — kept only for non-packaging chips. For packaging,
          the station is already explicit in the dropdown below, so the
          badge ("Hand Packing", "Elephant", etc.) would just duplicate
          it. Kitchen and PO chips don't have a station selector, so the
          badge stays to label the chip's role. */}
      {activity.kind !== 'packaging' && (
        <div
          style={{
            display: 'inline-block',
            padding: '2px 8px',
            fontSize: 11,
            background: colors.bg,
            color: colors.text,
            borderRadius: 3,
            marginBottom: 12,
            textTransform: 'capitalize',
          }}
        >
          {activity.kind === 'kitchen'
            ? `Kitchen (scheduled)${activity.assemblyNumber ? ` · ${activity.assemblyNumber}` : ''}`
            : activity.kind === 'kitchen-required'
            ? 'Kitchen (required by plan)'
            : activity.kind === 'po-placed'
            ? 'Purchase order — place by'
            : activity.kind === 'po-receiving'
            ? 'Purchase order — arrive by'
            : '—'}
        </div>
      )}

      {activity.orphan && (
        <div
          style={{
            marginBottom: 12,
            padding: '8px 10px',
            background: '#fef3c7',
            border: '0.5px solid #92400e',
            borderRadius: 4,
            fontSize: 11,
            lineHeight: 1.5,
          }}
        >
          <div style={{ fontWeight: 700, color: '#92400e', marginBottom: 2 }}>
            ORPHAN ASSEMBLY
          </div>
          This Unleashed assembly is producing an intermediate
          (<code style={{ fontFamily: 'monospace' }}>{activity.productCode}</code>)
          that isn't consumed by any current packaging chip in the plan.
          Likely cause: the downstream FG was removed from the family sheet,
          dropped from forecast, or this assembly is stale.
          <br />
          <strong>Action</strong>: close out this assembly in Unleashed
          (or confirm the missing FG should re-enter the plan).
        </div>
      )}
      {activity.kind === 'kitchen-required' && activity.redundantWithUnleashed && activity.redundantWithUnleashed.length > 0 && (
        <div
          style={{
            marginBottom: 12,
            padding: '8px 10px',
            background: '#fef9c3',
            border: '0.5px solid #a16207',
            borderRadius: 4,
            fontSize: 11,
            lineHeight: 1.5,
          }}
        >
          <div style={{ fontWeight: 700, color: '#a16207', marginBottom: 4 }}>
            POSSIBLY REDUNDANT WITH UNLEASHED
          </div>
          Unleashed has the following parked assembly(ies) for{' '}
          <code style={{ fontFamily: 'monospace' }}>{activity.productCode}</code>
          {' '}that arrived too late to plug the original shortage the
          kitchen-gap engine identified. The planner had to schedule its
          own run to cover demand earlier:
          <ul style={{ margin: '6px 0 6px 14px', padding: 0 }}>
            {activity.redundantWithUnleashed.map((u) => (
              <li key={u.assembly}>
                <code style={{ fontFamily: 'monospace' }}>{u.assembly}</code> —{' '}
                {Math.round(u.quantity)} units on {fmtDate(u.date)}
              </li>
            ))}
          </ul>
          Pulling one of these forward in Unleashed would let you drop
          this kitchen run. Otherwise both will produce → carried
          inventory at horizon end.{' '}
          {activity.assemblyNumber && (
            <span>
              (This shard is itself sourced from{' '}
              <code style={{ fontFamily: 'monospace' }}>
                {activity.assemblyNumber}
              </code>
              ; the list above is OTHER assemblies on top of that.)
            </span>
          )}
        </div>
      )}

      <div style={{ marginBottom: 12 }}>
        {/* Product name now lives in the drawer header (above). This
            section keeps the bare SKU code + Unleashed assembly link
            so the operator can copy/paste either without scrolling.
            "View connected" toggles a calendar-wide focus mode that
            hides every chip except this one and its direct
            suppliers/consumers (per current FIFO allocation). */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 12,
            color: 'var(--text-muted)',
          }}
        >
          <span>{activity.productCode}</span>
          <button
            type="button"
            onClick={onToggleFocus}
            title={
              focused
                ? 'Stop focusing — show all calendar chips again.'
                : 'Hide every chip on the calendar except this one, its direct suppliers/consumers (per current FIFO allocation), and any prior or subsequent runs of the same SKU.'
            }
            style={{
              marginLeft: 'auto',
              padding: '2px 8px',
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: '0.03em',
              textTransform: 'uppercase',
              border: focused
                ? '0.5px solid #1e40af'
                : '0.5px solid var(--border)',
              borderRadius: 3,
              background: focused ? '#1e40af' : 'var(--bg-page)',
              color: focused ? '#fff' : 'var(--text-primary)',
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {focused ? 'Showing connected' : 'View connected'}
          </button>
        </div>
        {/* Phase 4l.12 — Unleashed assembly number + status. Surfaced
            for any chip with a source assembly (kitchen-Live or
            packaging from a non-Lundberg warehouse). */}
        {activity.assemblyNumber && (
          <div
            style={{
              fontSize: 11,
              color: 'var(--text-muted)',
              marginTop: 4,
              display: 'flex',
              alignItems: 'baseline',
              gap: 6,
            }}
          >
            <span style={{ textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10 }}>
              Unleashed
            </span>
            <code
              style={{
                fontFamily: 'monospace',
                fontSize: 12,
                color: 'var(--text-primary)',
              }}
            >
              {activity.assemblyNumber}
            </code>
            {activity.assemblyStatus && (
              <span
                title={`Unleashed AssemblyStatus`}
                style={{ fontSize: 10, opacity: 0.8 }}
              >
                · {activity.assemblyStatus}
              </span>
            )}
          </div>
        )}
      </div>

      {/* ─── Priority actions (Phase 4l.12) ────────────────────
          Station / SOH / Reschedule / Edit qty / Dismiss live at
          the top of the drawer so an operator can act without
          scrolling past the related-chips list and other
          informational fields. Everything else stays below. */}

      {/* Station selector (packaging only). */}
      {activity.kind === 'packaging' && (
        <div style={{ marginBottom: 14 }}>
          <div
            style={{
              fontSize: 11,
              color: 'var(--text-muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              marginBottom: 4,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'baseline',
            }}
          >
            <span>
              Station
              {stationOverridden && (
                <span
                  style={{
                    marginLeft: 4,
                    padding: '0 4px',
                    fontSize: 9,
                    background: '#fef3c7',
                    color: '#92400e',
                    borderRadius: 2,
                    fontWeight: 600,
                  }}
                >
                  MODIFIED
                </span>
              )}
            </span>
            {stationOverridden && originalStation && (
              <button
                type="button"
                onClick={onClearStation}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: '#1e40af',
                  fontSize: 10,
                  cursor: 'pointer',
                  textDecoration: 'underline',
                  fontFamily: 'inherit',
                  padding: 0,
                }}
                title={`Reset to planner's original: ${STATION_LABELS[originalStation]}`}
              >
                Reset
              </button>
            )}
          </div>
          <select
            value={activity.station ?? ''}
            onChange={(e) => onEditStation(e.target.value as Station)}
            style={{
              width: '100%',
              padding: '6px 8px',
              fontSize: 13,
              border: '0.5px solid var(--border)',
              borderRadius: 3,
              background: 'var(--bg-page)',
              color: 'inherit',
              fontFamily: 'inherit',
              cursor: 'pointer',
              fontWeight: stationOverridden ? 600 : 400,
            }}
          >
            {STATIONS.map((s) => (
              <option key={s} value={s}>
                {STATION_LABELS[s]}
              </option>
            ))}
          </select>
          {stationOverridden && originalStation && (
            <div
              style={{
                fontSize: 10,
                color: 'var(--text-muted)',
                marginTop: 4,
              }}
            >
              Was: {STATION_LABELS[originalStation]}
            </div>
          )}
        </div>
      )}

      {/* Stock on hand (per-warehouse) */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>
          Stock on hand
        </div>
        {sohBreakdown === null ? (
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            No SOH cache. Click Refresh SOH in the header.
          </div>
        ) : Object.keys(sohBreakdown).length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            No stock recorded for this product.
          </div>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, fontSize: 12 }}>
            {Object.entries(sohBreakdown)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([wh, qty]) => {
                const isEligible = eligibleWarehouses.includes(wh);
                return (
                  <li
                    key={wh}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      padding: '2px 0',
                      color: isEligible ? 'var(--text-primary)' : 'var(--text-muted)',
                      opacity: isEligible ? 1 : 0.7,
                    }}
                  >
                    <span>
                      {wh}
                      {!isEligible && (
                        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                          {' · excluded'}
                        </span>
                      )}
                    </span>
                    <span>{qty.toLocaleString()}</span>
                  </li>
                );
              })}
          </ul>
        )}
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
          Planner used: {plannerInitialInventory.toLocaleString()} units (sum of{' '}
          {activity.kind === 'kitchen' || activity.kind === 'kitchen-required'
            ? 'intermediate-eligible warehouses: Lundberg + MF Packaging + MF Operations'
            : activity.kind === 'po-placed' || activity.kind === 'po-receiving'
            ? 'all warehouses (raw materials)'
            : 'fulfilment-eligible warehouses: TBC + TBC Height + MF Packaging + MF Operations'}
          )
        </div>
      </div>

      {/* Reschedule (any date) — committed Unleashed assemblies are locked
          (anchors of truth); only Parked drafts can be moved here. */}
      {isCommittedAssembly ? (
        <div
          style={{
            marginBottom: 14,
            fontSize: 11,
            lineHeight: 1.45,
            color: 'var(--text-muted)',
            border: '0.5px solid var(--border)',
            borderRadius: 3,
            padding: '8px 10px',
          }}
        >
          Committed in Unleashed ({activity.assemblyStatus}) — reschedule it in
          Unleashed, not here. Only <strong>Parked</strong> assemblies can be
          moved on the planner.
        </div>
      ) : (
      <div style={{ marginBottom: 14 }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            fontSize: 11,
            color: 'var(--text-muted)',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            marginBottom: 6,
          }}
        >
          <span>Reschedule</span>
          {original.date !== activity.date && (
            <span
              style={{
                textTransform: 'none',
                letterSpacing: 0,
                fontSize: 10,
                color: 'var(--text-muted)',
              }}
            >
              original: {original.date}
            </span>
          )}
        </div>
        <input
          type="date"
          value={activity.date}
          onChange={(e) => {
            const v = e.target.value;
            if (v && v !== activity.date) onReschedule(v);
          }}
          style={{
            width: '100%',
            padding: '6px 8px',
            fontSize: 13,
            border: '0.5px solid var(--border)',
            borderRadius: 3,
            background: 'var(--bg-page)',
            color: 'inherit',
            fontFamily: 'inherit',
          }}
        />
        <div
          style={{
            marginTop: 6,
            fontSize: 10,
            color: 'var(--text-muted)',
          }}
        >
          Tip: drag the chip to a day on the calendar to reschedule visually.
        </div>
        {rescheduled && (
          <button
            type="button"
            onClick={onClearReschedule}
            style={{
              marginTop: 6,
              fontSize: 11,
              color: 'var(--text-muted)',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              padding: 0,
              fontFamily: 'inherit',
              textDecoration: 'underline',
            }}
          >
            Reset to original day
          </button>
        )}
      </div>
      )}

      {/* Edit quantity */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
          Edit quantity
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            type="number"
            min={1}
            value={qtyInput}
            onChange={(e) => setQtyInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && qtyValid && qtyChanged) {
                e.preventDefault();
                onEditQuantity(parsedQty);
              }
            }}
            style={{
              flex: 1,
              padding: '6px 8px',
              fontSize: 13,
              border: '0.5px solid var(--border)',
              borderRadius: 3,
              fontFamily: 'inherit',
              background: 'var(--bg-page)',
              color: 'inherit',
            }}
          />
          <button
            type="button"
            onClick={() => qtyValid && onEditQuantity(parsedQty)}
            disabled={!qtyValid || !qtyChanged}
            style={{
              padding: '6px 12px',
              fontSize: 12,
              border: '0.5px solid var(--border)',
              borderRadius: 3,
              background: qtyValid && qtyChanged ? colors.bg : 'var(--bg-page)',
              color: qtyValid && qtyChanged ? colors.text : 'var(--text-muted)',
              cursor: qtyValid && qtyChanged ? 'pointer' : 'default',
              fontFamily: 'inherit',
            }}
          >
            Apply
          </button>
        </div>
        {wouldOversize && qtyChanged && (
          <div style={{ marginTop: 6, fontSize: 11, color: '#d97706' }}>
            ⚠ This quantity would exceed the station's daily capacity ({stationDailyMinutes} min).
          </div>
        )}
        {editedQuantity !== null && (
          <button
            type="button"
            onClick={onClearEdit}
            style={{
              marginTop: 6,
              fontSize: 11,
              color: 'var(--text-muted)',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              padding: 0,
              fontFamily: 'inherit',
              textDecoration: 'underline',
            }}
          >
            Reset to original quantity
          </button>
        )}
      </div>

      {/* Dismiss / Restore */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {dismissed ? (
          <button
            type="button"
            onClick={onUndismiss}
            style={{
              flex: 1,
              padding: '8px 12px',
              fontSize: 13,
              border: '0.5px solid var(--border)',
              borderRadius: 4,
              background: 'var(--bg-page)',
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Restore
          </button>
        ) : (
          <button
            type="button"
            onClick={onDismiss}
            style={{
              flex: 1,
              padding: '8px 12px',
              fontSize: 13,
              border: '0.5px solid #fecaca',
              borderRadius: 4,
              background: '#fef2f2',
              color: '#991b1b',
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Dismiss
          </button>
        )}
      </div>
      {dismissed && (
        <div
          style={{
            marginBottom: 16,
            padding: 8,
            background: '#fef2f2',
            border: '0.5px solid #fecaca',
            borderRadius: 4,
            fontSize: 11,
            color: '#991b1b',
          }}
        >
          Dismissed — won't count toward day load. Click Restore to re-include.
        </div>
      )}

      {/* Divider before the "other fields" section. */}
      <div
        style={{
          height: 1,
          background: 'var(--border)',
          opacity: 0.5,
          margin: '4px 0 16px',
        }}
      />

      {/* Cluster picker (Phase 4l.6): when this activity is part of a
          same-day same-product cluster, list its siblings so the user can
          switch focus. */}
      {clusterMembers && clusterMembers.length >= 2 && (
        <div
          style={{
            marginBottom: 16,
            padding: '8px 10px',
            background: 'var(--bg-page)',
            border: '0.5px dashed var(--border)',
            borderRadius: 4,
          }}
        >
          <div
            style={{
              fontSize: 10,
              color: 'var(--text-muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              marginBottom: 4,
            }}
          >
            Cluster · {clusterMembers.length} chips for {activity.productCode} on {fmtDate(activity.date)}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {clusterMembers.map((m, i) => {
              const isSelf = m.stableId === activity.stableId;
              return (
                <button
                  key={m.stableId}
                  type="button"
                  onClick={() => onSelectClusterMember(m)}
                  disabled={isSelf}
                  style={{
                    padding: '2px 8px',
                    fontSize: 11,
                    border: '0.5px solid var(--border)',
                    borderRadius: 3,
                    background: isSelf ? colors.bg : 'transparent',
                    color: isSelf ? colors.text : 'inherit',
                    cursor: isSelf ? 'default' : 'pointer',
                    fontFamily: 'inherit',
                    fontWeight: isSelf ? 600 : 400,
                  }}
                  title={`Switch drawer to ${m.stableId}`}
                >
                  #{i + 1} · {Math.round(m.quantity)}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Phase 4l.12 — Related chips (suppliers + consumers via BOM). */}
      {relatedChips.length > 0 && (() => {
        const suppliers = relatedChips.filter((r) => r.direction === 'supplier');
        const consumers = relatedChips.filter((r) => r.direction === 'consumer');
        const sortByDate = (
          a: { activity: CalendarActivity },
          b: { activity: CalendarActivity },
        ) => a.activity.date.localeCompare(b.activity.date);
        suppliers.sort(sortByDate);
        consumers.sort(sortByDate);
        // Phase 4l.14 — the inputs that don't arrive in time = the reason
        // this run is supply-starved (⛔). Surface them explicitly so the
        // operator doesn't have to hunt which input is the blocker.
        const phantomSuppliers = suppliers.filter((r) => r.phantom);
        const renderRel = (r: {
          activity: CalendarActivity;
          direction: 'supplier' | 'consumer';
          phantom: boolean;
        }) => (
          <button
            key={r.activity.stableId}
            type="button"
            onClick={() => onSelectRelatedChip(r.activity)}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              width: '100%',
              padding: '4px 8px',
              margin: '2px 0',
              fontSize: 11,
              fontFamily: 'inherit',
              textAlign: 'left',
              background: r.phantom ? 'rgba(220, 38, 38, 0.08)' : 'var(--bg-page)',
              border: r.phantom ? '0.5px dashed #dc2626' : '0.5px solid var(--border)',
              borderRadius: 3,
              cursor: 'pointer',
              color: 'inherit',
            }}
            title={
              r.phantom
                ? `Starved consumer — no upstream supply finishes before ${fmtDate(r.activity.date)}. Phantom arrow on calendar.`
                : `Jump drawer to ${r.activity.stableId}`
            }
          >
            <span style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
              <span style={{ fontWeight: 600 }}>{r.activity.productCode}</span>
              <span style={{ opacity: 0.7 }}>×{Math.round(r.activity.quantity)}</span>
              {r.phantom && (
                <span style={{ fontSize: 9, color: '#dc2626', fontWeight: 600 }}>
                  PHANTOM
                </span>
              )}
            </span>
            <span style={{ opacity: 0.7, fontSize: 10 }}>
              {fmtDate(r.activity.date)}
            </span>
          </button>
        );
        return (
          <div
            style={{
              marginBottom: 16,
              padding: '8px 10px',
              background: 'var(--bg-page)',
              border: '0.5px dashed var(--border)',
              borderRadius: 4,
            }}
          >
            <div
              style={{
                fontSize: 10,
                color: 'var(--text-muted)',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                marginBottom: 6,
              }}
            >
              Related · {suppliers.length} supplier
              {suppliers.length === 1 ? '' : 's'} · {consumers.length} consumer
              {consumers.length === 1 ? '' : 's'}
            </div>
            {/* Phase 4l.14 — supply-starved blocker callout: names the
                inputs that won't arrive before this run's date, so the ⛔
                state is self-explanatory (no log-diving to find the blocker). */}
            {phantomSuppliers.length > 0 && (
              <div
                style={{
                  marginBottom: 8,
                  padding: '6px 8px',
                  borderRadius: 3,
                  background: 'rgba(220, 38, 38, 0.08)',
                  border: '0.5px solid #dc2626',
                  fontSize: 11,
                  lineHeight: 1.45,
                  color: '#991b1b',
                }}
              >
                <strong>⛔ Supply-starved</strong> — this run can&apos;t proceed on{' '}
                {fmtDate(activity.date)}; {phantomSuppliers.length} input
                {phantomSuppliers.length === 1 ? '' : 's'} won&apos;t arrive in time:
                <div style={{ marginTop: 3 }}>
                  {phantomSuppliers.map((s) => {
                    const po = s.activity.poInfo;
                    const detail = po
                      ? po.overdue
                        ? `PO overdue — place by ${po.placeByDate ? fmtDate(po.placeByDate) : '?'}`
                        : `arrives ${fmtDate(po.arriveByDate ?? s.activity.date)}`
                      : `no supply finishing by ${fmtDate(activity.date)}`;
                    return (
                      <div key={s.activity.stableId}>
                        • <strong>{s.activity.productCode}</strong> ({detail})
                      </div>
                    );
                  })}
                </div>
                <div style={{ marginTop: 3, opacity: 0.85 }}>
                  Expedite/pull these forward, or move this run later, to unblock it.
                </div>
              </div>
            )}
            {suppliers.length > 0 && (
              <div style={{ marginBottom: 6 }}>
                <div
                  style={{
                    fontSize: 10,
                    color: 'var(--text-muted)',
                    marginBottom: 2,
                  }}
                >
                  ← Suppliers (feeds this chip)
                </div>
                {suppliers.map(renderRel)}
              </div>
            )}
            {consumers.length > 0 && (
              <div>
                <div
                  style={{
                    fontSize: 10,
                    color: 'var(--text-muted)',
                    marginBottom: 2,
                  }}
                >
                  → Consumers (this chip feeds)
                </div>
                {consumers.map(renderRel)}
              </div>
            )}
          </div>
        );
      })()}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, fontSize: 13, marginBottom: 16 }}>
        <Field
          label={activity.kind === 'kitchen-required' ? 'Start' : 'Date'}
          value={fmtDate(activity.date)}
          modified={rescheduled !== null}
          originalValue={rescheduled ? fmtDate(original.date) : undefined}
        />
        <Field
          label="Quantity"
          value={`${Math.round(activity.quantity)}`}
          modified={editedQuantity !== null}
          originalValue={editedQuantity !== null ? `${Math.round(original.quantity)}` : undefined}
        />
        {activity.kind === 'kitchen-required' && activity.finishDate && (
          <>
            <Field label="Finish" value={fmtDate(activity.finishDate)} />
            <Field label="Duration" value={`${activity.durationDays ?? 1} days`} />
          </>
        )}
        {activity.kind === 'kitchen-required' && activity.requiredByDate && (
          <Field
            label="Available for use"
            value={fmtDate(activity.requiredByDate)}
          />
        )}
        {activity.kind === 'kitchen-required' && kitchenChipMinutes !== null && (
          <Field
            label="Kitchen-team min"
            value={`${kitchenChipMinutes} min on start day`}
          />
        )}
        {/* Unleashed PO (Phase 4l.5) — view-only details. */}
        {(activity.kind === 'po-placed' || activity.kind === 'po-receiving') &&
          activity.poInfo &&
          activity.poInfo.source === 'unleashed_po' && (
            <>
              <Field label="Source" value="Unleashed (view-only)" />
              <Field
                label="PO #"
                value={activity.poInfo.purchaseOrderNumber ?? '—'}
              />
              <Field
                label="Supplier"
                value={activity.poInfo.supplierName ?? '—'}
              />
              <Field label="Status" value={activity.poInfo.status ?? '—'} />
              <Field label="Expected" value={fmtDate(activity.date)} />
            </>
          )}
        {/* Synthetic PO details (Phase 4m.2 + 4m.4). Shows the EFFECTIVE
            dates (computed with any lead-time override) plus the ideal
            file-default values for context. */}
        {(activity.kind === 'po-placed' || activity.kind === 'po-receiving') &&
          activity.poInfo &&
          activity.poInfo.source !== 'unleashed_po' && (
            <>
              <Field
                label="Place by"
                value={fmtDate(activity.date)}
                modified={activity.poInfo.overdue}
                originalValue={
                  activity.poInfo.overdue
                    ? fmtDate(activity.poInfo.placeByDate)
                    : undefined
                }
              />
              <Field
                label="Arrive by"
                value={
                  activity.kind === 'po-receiving'
                    ? fmtDate(activity.date)
                    : fmtDate(
                        // Compute effective arrival from poInfo + this chip's date.
                        addDaysIso(activity.date, effectiveLeadTime),
                      )
                }
                modified={editedLeadTimeDays !== null || activity.poInfo.overdue}
                originalValue={
                  editedLeadTimeDays !== null || activity.poInfo.overdue
                    ? fmtDate(activity.poInfo.arriveByDate)
                    : undefined
                }
              />
              <Field
                label="Lead time"
                value={`${effectiveLeadTime} days`}
                modified={editedLeadTimeDays !== null}
                originalValue={
                  editedLeadTimeDays !== null
                    ? `${activity.poInfo.leadTimeDays} days (default)`
                    : undefined
                }
              />
              <Field
                label="Status"
                value={activity.poInfo.overdue ? 'OVERDUE' : 'On track'}
              />
              {vendor && <Field label="Vendor" value={vendor} />}
            </>
          )}
        {activity.kind === 'packaging' && (
          <>
            <Field label="Production" value={`${Math.round(activity.durationMinutes)} min`} />
            <Field
              label="Changeover"
              value={`${Math.round(activity.changeoverMinutes)} min`}
            />
            {/* Station selector lives in its own block higher in the
                drawer (just below the Unleashed assembly row) so the
                operator can re-route a chip without scrolling past
                everything else. Kept the Production / Changeover
                fields here since they're informational. */}
            {/* Profit (Phase 4l.9) — surfaces the joint profit × demand
                signal the day-assigner uses for overflow ranking. Two
                columns: per-unit profit, batch total. `null` means the
                SKU is missing from `data/_profit-input.tsv` and the
                day-assigner ranks it as $0 (= drop first on overflow). */}
            {activity.profitPerItem !== null && activity.profitPerItem !== undefined ? (
              <>
                <Field
                  label="Profit / unit"
                  value={`$${activity.profitPerItem.toFixed(2)}`}
                />
                <Field
                  label="Batch profit"
                  value={`$${(activity.profitPerItem * activity.quantity).toFixed(0)}`}
                />
              </>
            ) : (
              <div
                style={{
                  gridColumn: 'span 2',
                  fontSize: 11,
                  color: 'var(--text-muted)',
                  padding: '4px 8px',
                  background: '#fef3c7',
                  border: '0.5px dashed #d97706',
                  borderRadius: 3,
                }}
                title="Add this SKU's profit-per-item to data/_profit-input.tsv and re-run scripts/build-profit.js. The day-assigner ranks blank-profit SKUs as $0 → first to be dropped when a week overflows."
              >
                ⚠ No profit data — dropped first on capacity overflow
              </div>
            )}
          </>
        )}
        <Field label="Family" value={activity.family ?? '—'} />
        <Field label="Extended family" value={activity.extendedFamily ?? '—'} />
      </div>

      {/* ─── Supply-capped (Phase 4l.10) ──────────────── */}
      {activity.kind === 'packaging' && activity.supplyCappedFrom !== undefined && (
        <div
          style={{
            marginBottom: 14,
            padding: '8px 10px',
            fontSize: 12,
            background: activity.quantity <= 0 ? '#e5e7eb' : '#fef3c7',
            border: `0.5px solid ${activity.quantity <= 0 ? '#6b7280' : '#d97706'}`,
            borderRadius: 4,
          }}
        >
          <div
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: activity.quantity <= 0 ? '#374151' : '#92400e',
              marginBottom: 4,
            }}
          >
            {activity.quantity <= 0
              ? '⛔ Supply-capped to zero'
              : '⚠ Supply-capped'}
          </div>
          <div style={{ color: activity.quantity <= 0 ? '#4b5563' : '#78350f' }}>
            Optimiser planned <strong>{Math.round(activity.supplyCappedFrom)}</strong>{' '}
            units; cut to <strong>{Math.round(activity.quantity)}</strong> because{' '}
            <code style={{ fontFamily: 'inherit' }}>{activity.supplyCappedBy}</code>{' '}
            output was short. Higher-profit chips on the same intermediate took
            their full demand first.
          </div>
          {activity.quantity <= 0 && (
            <div
              style={{
                marginTop: 4,
                fontSize: 11,
                color: '#374151',
                fontStyle: 'italic',
              }}
            >
              This run isn't scheduled — increase the upstream kitchen run or
              reduce a higher-profit consumer to restore supply.
            </div>
          )}
        </div>
      )}

      {/* ─── Label / printed bag blocked (Phase 4l.10) ──── */}
      {activity.kind === 'packaging' &&
        activity.labelBlocking &&
        activity.labelBlocking.length > 0 && (
          <div
            style={{
              marginBottom: 14,
              padding: '8px 10px',
              fontSize: 12,
              background: '#fef3c7',
              border: '0.5px solid #d97706',
              borderRadius: 4,
            }}
          >
            <div
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: '#92400e',
                marginBottom: 4,
              }}
            >
              ⚠ Packaging material short
            </div>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {activity.labelBlocking.map((lb) => (
                <li key={lb.code} style={{ marginBottom: 4, color: '#78350f' }}>
                  <div style={{ fontWeight: 500 }}>
                    {lb.kind === 'label' ? 'Label' : 'Printed bag'} ·{' '}
                    <code style={{ fontFamily: 'inherit' }}>{lb.code}</code>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {lb.name}
                  </div>
                  <div style={{ fontSize: 11, marginTop: 2 }}>
                    {lb.arriveByDate ? (
                      <>
                        PO arrives <strong>{fmtDate(lb.arriveByDate)}</strong>
                        {lb.arriveByDate > activity.date && (
                          <span style={{ color: '#b91c1c' }}>
                            {' '}
                            — after this run ({fmtDate(activity.date)})
                          </span>
                        )}
                        {lb.placeByOverdue && lb.placeByDate && (
                          <div style={{ color: '#b91c1c' }}>
                            Place-by {fmtDate(lb.placeByDate)} — OVERDUE
                          </div>
                        )}
                      </>
                    ) : (
                      <span style={{ color: '#b91c1c' }}>
                        No PO planned — order this material before the run.
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

      {/* ─── Edit lead time (Phase 4m.4) ──────────────────
          Only on synthetic PO chips. Shifts both place-by and arrive-by
          chips by the difference between the override and the file default.
          Unleashed POs are view-only — dates come from Unleashed. */}
      {isPo && activity.poInfo && activity.poInfo.source !== 'unleashed_po' && (
        <div style={{ marginBottom: 14 }}>
          <div
            style={{
              fontSize: 11,
              color: 'var(--text-muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              marginBottom: 6,
            }}
          >
            Edit lead time
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input
              type="number"
              min={0}
              value={leadInput}
              onChange={(e) => setLeadInput(e.target.value)}
              style={{
                flex: 1,
                padding: '6px 8px',
                fontSize: 13,
                border: '0.5px solid var(--border)',
                borderRadius: 3,
                fontFamily: 'inherit',
                background: 'var(--bg-page)',
                color: 'inherit',
              }}
            />
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>days</span>
            <button
              type="button"
              onClick={() => leadValid && onEditLeadTime(parsedLead)}
              disabled={!leadValid || !leadChanged}
              style={{
                padding: '6px 12px',
                fontSize: 12,
                border: '0.5px solid var(--border)',
                borderRadius: 3,
                background:
                  leadValid && leadChanged ? colors.bg : 'var(--bg-page)',
                color:
                  leadValid && leadChanged ? colors.text : 'var(--text-muted)',
                cursor: leadValid && leadChanged ? 'pointer' : 'default',
                fontFamily: 'inherit',
              }}
            >
              Apply
            </button>
          </div>
          <div
            style={{
              marginTop: 6,
              fontSize: 10,
              color: 'var(--text-muted)',
              lineHeight: 1.4,
            }}
          >
            File default: {activity.poInfo.leadTimeDays} days. Override applies
            to this PO only and is stored in your browser; clear it to re-use
            the default.
          </div>
          {editedLeadTimeDays !== null && (
            <button
              type="button"
              onClick={onClearLeadTime}
              style={{
                marginTop: 6,
                fontSize: 11,
                color: 'var(--text-muted)',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                padding: 0,
                fontFamily: 'inherit',
                textDecoration: 'underline',
              }}
            >
              Reset to file default
            </button>
          )}
        </div>
      )}

      {routingRationale && (
        <div
          style={{
            padding: 10,
            background: '#eff6ff',
            border: '0.5px solid #bfdbfe',
            borderRadius: 4,
            fontSize: 11,
            color: '#1e3a8a',
            marginBottom: 12,
          }}
        >
          <div style={{ fontWeight: 500, marginBottom: 2 }}>Why this station?</div>
          {routingRationale}
        </div>
      )}

      {/* ─── Schedule conflicts (Phase 4l.2) ──────────── */}
      {conflicts.length > 0 && (
        <div
          style={{
            marginBottom: 14,
            padding: 10,
            background: '#fef2f2',
            border: '0.5px solid #fecaca',
            borderRadius: 4,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              marginBottom: 6,
            }}
          >
            <div
              style={{
                fontSize: 11,
                color: '#991b1b',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                fontWeight: 500,
                flex: 1,
              }}
            >
              ⚠ Schedule conflicts ({conflicts.length})
            </div>
            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <button
                type="button"
                onClick={() => onResolveConflicts('auto')}
                title="Try to pull the blocking run earlier; if it can't be pulled (floored or kitchen capacity), push this activity later instead."
                style={{
                  padding: '4px 10px',
                  fontSize: 10,
                  background: '#dc2626',
                  color: '#fff',
                  border: '0.5px solid #b91c1c',
                  borderRadius: 3,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  fontWeight: 600,
                  whiteSpace: 'nowrap',
                }}
              >
                Resolve (auto)
              </button>
              <button
                type="button"
                onClick={() => onResolveConflicts('pull')}
                title="Pull the blocking ingredient run earlier so it finishes in time. Floored at the planning-horizon start and respects kitchen-team capacity."
                style={{
                  padding: '3px 6px',
                  fontSize: 9,
                  background: '#fee2e2',
                  color: '#991b1b',
                  border: '0.5px solid #fecaca',
                  borderRadius: 3,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  fontWeight: 500,
                  whiteSpace: 'nowrap',
                }}
              >
                ←
              </button>
              <button
                type="button"
                onClick={() => onResolveConflicts('push')}
                title="Push this activity later to the earliest feasible date and recompute."
                style={{
                  padding: '3px 6px',
                  fontSize: 9,
                  background: '#fee2e2',
                  color: '#991b1b',
                  border: '0.5px solid #fecaca',
                  borderRadius: 3,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  fontWeight: 500,
                  whiteSpace: 'nowrap',
                }}
              >
                →
              </button>
            </div>
          </div>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, fontSize: 11 }}>
            {conflicts.map((c, i) => (
              <li
                key={i}
                style={{
                  padding: '4px 0',
                  color: '#991b1b',
                  borderBottom: i < conflicts.length - 1 ? '0.5px solid #fecaca' : 'none',
                }}
              >
                Needs <strong>{c.ingredientCode}</strong> ready by{' '}
                <strong>{fmtDate(c.consumerDate)}</strong>; closest run finishes{' '}
                <strong>{fmtDate(c.earliestFinishDate)}</strong>.
              </li>
            ))}
          </ul>
          <div style={{ fontSize: 10, color: '#7f1d1d', marginTop: 6 }}>
            Move this chip later, or move the upstream chip to finish sooner. The 1-day buffer must hold.
            Resolve auto-cascades through dependents.
          </div>
        </div>
      )}

      {/* ─── Committed customer orders (Phase 4h.3) ─────── */}
      {(salesOrders.length > 0 || totalCommitted > 0) && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
            <span>Committed orders</span>
            <span>total {totalCommitted.toLocaleString()} units</span>
          </div>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, fontSize: 11, maxHeight: 140, overflowY: 'auto' }}>
            {salesOrders.map((so) => {
              const statusColor =
                so.orderStatus === 'Backordered' ? '#dc2626'
                : so.orderStatus === 'Placed' ? '#1e40af'
                : 'var(--text-muted)';
              return (
                <li
                  key={so.orderNumber}
                  style={{
                    padding: '3px 0',
                    borderBottom: '0.5px solid var(--border)',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ fontWeight: 500 }}>{so.orderNumber}</span>
                    <span>{so.quantityRemaining.toLocaleString()} units</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-muted)' }}>
                    <span title={so.customerName} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 180 }}>
                      {so.customerName}
                    </span>
                    <span style={{ display: 'flex', gap: 6 }}>
                      <span style={{ color: statusColor }}>{so.orderStatus}</span>
                      <span>by {fmtDate(so.requiredDate)}</span>
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* ─── Per-product overrides (Phase 4f) ──────────── */}
      <ProductOverrideSection
        productCode={activity.productCode}
        override={productOverride}
        stationDailyOutput={stationDailyOutput}
        globalShelfLifeDays={globalShelfLifeDays}
      />

    </aside>
  );
}

// ─── Per-product override editor (Phase 4f) ─────────────────

function ProductOverrideSection({
  productCode,
  override,
  stationDailyOutput,
  globalShelfLifeDays,
}: {
  productCode: string;
  override: ProductOverrideShape | undefined;
  stationDailyOutput: number;
  globalShelfLifeDays: number;
}) {
  // Local form state — committed only when the user clicks Save.
  // Reset the form when the productCode changes (different SKU selected).
  const [shelfLifeInput, setShelfLifeInput] = useState<string>('');
  const [maxBatchInput, setMaxBatchInput] = useState<string>('');
  const [saving, setSaving] = useState<'shelfLife' | 'maxBatch' | null>(null);
  const [saved, setSaved] = useState<'shelfLife' | 'maxBatch' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setShelfLifeInput(
      override?.shelfLifeDays !== undefined ? String(override.shelfLifeDays) : '',
    );
    setMaxBatchInput(
      override?.maxBatchSize !== undefined ? String(override.maxBatchSize) : '',
    );
    setSaved(null);
    setError(null);
  }, [productCode, override]);

  async function postOverride(field: 'shelfLifeDays' | 'maxBatchSize', value: number | null) {
    setSaving(field === 'shelfLifeDays' ? 'shelfLife' : 'maxBatch');
    setError(null);
    try {
      // Empty value = clear via DELETE (only when it's the only override).
      // For partial clear we POST with the field omitted; the server merges
      // the override map. Since our API merges, posting only the OTHER
      // field doesn't clear this one — so we need a different mechanism.
      // For now, post a fresh override and rely on cleanOverride to drop
      // the missing field. But that's a merge — old value persists.
      // Simplest robust approach: for "clear single field", send a special
      // request that overwrites with the remaining fields only.
      // For MVP we just save what's in the form; explicit "clear" buttons
      // call DELETE for the whole product.
      const body = { productCode, override: { [field]: value } };
      const res = await fetch('/api/product-overrides', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSaved(field === 'shelfLifeDays' ? 'shelfLife' : 'maxBatch');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(null);
    }
  }

  async function clearAllOverrides() {
    setSaving('shelfLife');
    setError(null);
    try {
      const res = await fetch(
        `/api/product-overrides?productCode=${encodeURIComponent(productCode)}`,
        { method: 'DELETE' },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setShelfLifeInput('');
      setMaxBatchInput('');
      setSaved('shelfLife');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Clear failed');
    } finally {
      setSaving(null);
    }
  }

  const shelfLifeValue = Number(shelfLifeInput);
  const shelfLifeValid = !shelfLifeInput || (Number.isFinite(shelfLifeValue) && shelfLifeValue > 0);
  const shelfLifeChanged =
    shelfLifeValid &&
    shelfLifeInput !== '' &&
    Math.round(shelfLifeValue) !== (override?.shelfLifeDays ?? -1);
  const maxBatchValue = Number(maxBatchInput);
  const maxBatchValid = !maxBatchInput || (Number.isFinite(maxBatchValue) && maxBatchValue > 0);
  const maxBatchChanged =
    maxBatchValid &&
    maxBatchInput !== '' &&
    Math.round(maxBatchValue) !== (override?.maxBatchSize ?? -1);

  const hasAnyOverride =
    override?.shelfLifeDays !== undefined || override?.maxBatchSize !== undefined;

  return (
    <div
      style={{
        marginBottom: 14,
        padding: 10,
        background: hasAnyOverride ? '#eff6ff' : 'var(--bg-page)',
        border: '0.5px solid var(--border)',
        borderRadius: 4,
      }}
    >
      <div
        style={{
          fontSize: 11,
          color: 'var(--text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          marginBottom: 8,
        }}
      >
        Product overrides
      </div>

      {/* Shelf life */}
      <div style={{ marginBottom: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: 11, marginBottom: 3 }}>
          <span>Shelf life (days)</span>
          <span style={{ color: 'var(--text-muted)' }}>
            default: {globalShelfLifeDays}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            type="number"
            min={1}
            placeholder={`${globalShelfLifeDays}`}
            value={shelfLifeInput}
            onChange={(e) => setShelfLifeInput(e.target.value)}
            style={{
              flex: 1,
              padding: '5px 8px',
              fontSize: 12,
              border: '0.5px solid var(--border)',
              borderRadius: 3,
              fontFamily: 'inherit',
              background: 'var(--bg-page)',
              color: 'inherit',
            }}
          />
          <button
            type="button"
            onClick={() => postOverride('shelfLifeDays', shelfLifeValue)}
            disabled={!shelfLifeValid || !shelfLifeChanged || saving !== null}
            style={{
              padding: '5px 10px',
              fontSize: 11,
              border: '0.5px solid var(--border)',
              borderRadius: 3,
              background: shelfLifeChanged ? '#dbeafe' : 'var(--bg-page)',
              color: shelfLifeChanged ? '#1e40af' : 'var(--text-muted)',
              cursor: shelfLifeChanged && saving === null ? 'pointer' : 'default',
              fontFamily: 'inherit',
            }}
          >
            {saving === 'shelfLife' ? 'Saving…' : saved === 'shelfLife' ? 'Saved ✓' : 'Save'}
          </button>
        </div>
      </div>

      {/* Max batch */}
      <div style={{ marginBottom: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: 11, marginBottom: 3 }}>
          <span>Max batch (units)</span>
          <span style={{ color: 'var(--text-muted)' }}>
            default: {stationDailyOutput || '—'} (1 day station output)
          </span>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            type="number"
            min={1}
            placeholder={stationDailyOutput ? String(stationDailyOutput) : ''}
            value={maxBatchInput}
            onChange={(e) => setMaxBatchInput(e.target.value)}
            style={{
              flex: 1,
              padding: '5px 8px',
              fontSize: 12,
              border: '0.5px solid var(--border)',
              borderRadius: 3,
              fontFamily: 'inherit',
              background: 'var(--bg-page)',
              color: 'inherit',
            }}
          />
          <button
            type="button"
            onClick={() => postOverride('maxBatchSize', maxBatchValue)}
            disabled={!maxBatchValid || !maxBatchChanged || saving !== null}
            style={{
              padding: '5px 10px',
              fontSize: 11,
              border: '0.5px solid var(--border)',
              borderRadius: 3,
              background: maxBatchChanged ? '#dbeafe' : 'var(--bg-page)',
              color: maxBatchChanged ? '#1e40af' : 'var(--text-muted)',
              cursor: maxBatchChanged && saving === null ? 'pointer' : 'default',
              fontFamily: 'inherit',
            }}
          >
            {saving === 'maxBatch' ? 'Saving…' : saved === 'maxBatch' ? 'Saved ✓' : 'Save'}
          </button>
        </div>
      </div>

      {error && (
        <div style={{ fontSize: 11, color: '#dc2626', marginBottom: 6 }}>⚠ {error}</div>
      )}

      {saved && !error && (
        <div style={{ fontSize: 11, color: '#1e40af', marginBottom: 6 }}>
          Saved. Click <strong>Re-plan</strong> in the header to apply.
        </div>
      )}

      {hasAnyOverride && (
        <button
          type="button"
          onClick={clearAllOverrides}
          disabled={saving !== null}
          style={{
            fontSize: 11,
            color: 'var(--text-muted)',
            background: 'transparent',
            border: 'none',
            cursor: saving !== null ? 'default' : 'pointer',
            padding: 0,
            fontFamily: 'inherit',
            textDecoration: 'underline',
          }}
        >
          Clear all overrides for this product
        </button>
      )}
    </div>
  );
}

// ─── Header Tools dropdown menu item ─────────────────────────
// Single visual style for items in the calendar header's "Tools" menu.
// Two-line layout (label + sublabel) lets each action carry a one-glance
// hint without forcing the operator to read titles. Disabled state greys
// the row out but still renders the sublabel so the hint stays visible.
function ToolsMenuItem({
  label,
  sublabel,
  disabled = false,
  onClick,
}: {
  label: string;
  sublabel?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        padding: '6px 10px',
        background: 'transparent',
        border: 'none',
        borderRadius: 3,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        fontFamily: 'inherit',
        color: 'inherit',
      }}
      onMouseEnter={(e) => {
        if (!disabled) e.currentTarget.style.background = 'var(--bg-page)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 500 }}>{label}</div>
      {sublabel && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>
          {sublabel}
        </div>
      )}
    </button>
  );
}

// ─── Bottom-strip panels (Phase 4e) ──────────────────────────

function CapacityHeatmap({
  data,
}: {
  data: {
    weekStarts: string[];
    byWeek: Map<string, Map<Station, { peakUtilisation: number; totalMinutes: number }>>;
    /** Per-week kitchen-team utilisation (Phase 4l.7). */
    kitchenByWeek: Map<string, { peakUtilisation: number; totalMinutes: number }>;
  };
}) {
  function color(util: number): string {
    if (util <= 0) return 'var(--bg-page)';
    if (util > 1) return '#dc2626';
    if (util > 0.85) return '#d97706';
    if (util > 0.5) return '#10b981';
    if (util > 0.2) return '#86efac';
    return '#d1fae5';
  }

  return (
    <section
      style={{
        background: 'var(--bg-surface)',
        border: '0.5px solid var(--border)',
        borderRadius: 6,
        padding: 14,
      }}
    >
      <h3 style={{ fontSize: 12, fontWeight: 500, marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)' }}>
        Capacity heatmap (peak day per week)
      </h3>
      <div style={{ display: 'grid', gridTemplateColumns: `auto repeat(${data.weekStarts.length}, 1fr)`, gap: 1, fontSize: 10 }}>
        {/* Header row: week labels */}
        <div />
        {data.weekStarts.map((ws, i) => (
          <div
            key={ws}
            style={{
              textAlign: 'center',
              padding: '2px 0',
              color: 'var(--text-muted)',
            }}
            title={`Week of ${fmtDate(ws)}`}
          >
            W{i + 1}
          </div>
        ))}
        {STATIONS.map((s) => (
          <Fragment key={s}>
            <div
              style={{
                fontSize: 11,
                paddingRight: 10,
                color: 'var(--text-secondary)',
                whiteSpace: 'nowrap',
              }}
            >
              {STATION_LABELS[s]}
            </div>
            {data.weekStarts.map((ws) => {
              const cell = data.byWeek.get(ws)?.get(s);
              const util = cell?.peakUtilisation ?? 0;
              return (
                <div
                  key={ws + s}
                  style={{
                    height: 18,
                    background: color(util),
                    borderRadius: 1,
                  }}
                  title={`${STATION_LABELS[s]} · week of ${fmtDate(ws)}: peak ${Math.round(util * 100)}%, total ${Math.round(cell?.totalMinutes ?? 0)} min`}
                />
              );
            })}
          </Fragment>
        ))}

        {/* Kitchen-team row (Phase 4l.7). Visually separated from the
            packaging stations by a gap row above the cells. */}
        <Fragment>
          <div
            style={{
              fontSize: 11,
              paddingRight: 10,
              paddingTop: 4,
              color: 'var(--text-secondary)',
              whiteSpace: 'nowrap',
              fontStyle: 'italic',
            }}
          >
            Kitchen team
          </div>
          {data.weekStarts.map((ws) => {
            const cell = data.kitchenByWeek.get(ws);
            const util = cell?.peakUtilisation ?? 0;
            return (
              <div
                key={ws + 'kitchen'}
                style={{
                  height: 18,
                  marginTop: 4,
                  background: color(util),
                  borderRadius: 1,
                }}
                title={`Kitchen team · week of ${fmtDate(ws)}: peak ${Math.round(util * 100)}%, total ${Math.round(cell?.totalMinutes ?? 0)} min (8 hr/day budget)`}
              />
            );
          })}
        </Fragment>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 10, fontSize: 10, color: 'var(--text-muted)', alignItems: 'center' }}>
        <span>Idle</span>
        <span style={{ width: 12, height: 8, background: '#d1fae5', display: 'inline-block', borderRadius: 1 }} />
        <span style={{ width: 12, height: 8, background: '#86efac', display: 'inline-block', borderRadius: 1 }} />
        <span style={{ width: 12, height: 8, background: '#10b981', display: 'inline-block', borderRadius: 1 }} />
        <span style={{ width: 12, height: 8, background: '#d97706', display: 'inline-block', borderRadius: 1 }} />
        <span style={{ width: 12, height: 8, background: '#dc2626', display: 'inline-block', borderRadius: 1 }} />
        <span>Overrun</span>
      </div>
    </section>
  );
}

function StockoutPanel({
  infeasibleProducts,
}: {
  infeasibleProducts: InfeasibleProduct[];
}) {
  const top = infeasibleProducts.slice(0, 8);
  const maxUnmet = top.length > 0 ? Math.max(...top.map((p) => p.unmetUnits)) : 1;
  return (
    <section
      style={{
        background: 'var(--bg-surface)',
        border: '0.5px solid var(--border)',
        borderRadius: 6,
        padding: 14,
      }}
    >
      <h3 style={{ fontSize: 12, fontWeight: 500, marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)' }}>
        Stockout risk
      </h3>
      {top.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          No infeasible products — every SKU has a workable plan.
        </div>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {top.map((p) => {
            const pct = (p.unmetUnits / maxUnmet) * 100;
            return (
              <li
                key={p.productCode}
                style={{
                  marginBottom: 6,
                  fontSize: 11,
                }}
                title={p.reason}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                  <span style={{ fontWeight: 500 }}>{p.productCode}</span>
                  <span style={{ color: '#991b1b' }}>{p.unmetUnits.toLocaleString()} units</span>
                </div>
                <div
                  style={{
                    height: 4,
                    background: 'var(--bg-page)',
                    borderRadius: 1,
                  }}
                >
                  <div
                    style={{
                      width: `${pct}%`,
                      height: '100%',
                      background: '#dc2626',
                      borderRadius: 1,
                    }}
                  />
                </div>
              </li>
            );
          })}
          {infeasibleProducts.length > top.length && (
            <li style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
              + {infeasibleProducts.length - top.length} more in left-rail panel
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

/**
 * Raw-material risks (Phase 4m.1).
 *
 * One row per material that's projected to run short within the planning
 * horizon. Each row shows:
 *   - Material code + name
 *   - Required arrival date (1 day before first shortage)
 *   - PO place-by date (= arriveBy − lead time)
 *   - Quantity short
 *   - Overdue flag when placeBy is already in the past
 *
 * The panel sorts most-urgent first (overdue rows at top, then by placeBy
 * date ascending). Clicking a row could open a per-material drilldown in a
 * future phase; for now the row is informational.
 */
function RawMaterialRiskPanel({
  shortages,
  requirements,
}: {
  shortages: RawMaterialShortage[];
  requirements: PurchaseRequirement[];
}) {
  // Index shortages by code so the requirement row can show the demand
  // context (initial SOH, total demand, drivers).
  const shortageByCode = new Map<string, RawMaterialShortage>();
  for (const s of shortages) shortageByCode.set(s.rawMaterialCode, s);

  // Sort: overdue first, then by placeBy ascending.
  const ordered = [...requirements].sort((a, b) => {
    if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
    return a.placeByDate.localeCompare(b.placeByDate);
  });

  // The outer card + header chrome is supplied by CollapsibleSection; this
  // panel renders just the description + table body so it slots cleanly
  // into the drawer's content area.
  return (
    <>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 8 }}>
        Default lead time 14 days. Place-by dates assume the kitchen needs the
        material 1 day before its first shortage. Per-vendor lead times can be
        wired in later.
      </div>
      <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ color: 'var(--text-muted)', textAlign: 'left' }}>
            <th style={cellStyle}>Material</th>
            <th style={cellStyle}>Place by</th>
            <th style={cellStyle}>Arrive by</th>
            <th style={{ ...cellStyle, textAlign: 'right' }}>Qty</th>
            <th style={{ ...cellStyle, textAlign: 'right' }}>SOH</th>
          </tr>
        </thead>
        <tbody>
          {ordered.map((r) => {
            const s = shortageByCode.get(r.rawMaterialCode);
            return (
              <tr
                key={r.rawMaterialCode}
                title={
                  s
                    ? `Initial SOH ${s.initialSoh.toLocaleString()}, total demand ${Math.round(s.totalDemand).toLocaleString()}, first shortage ${fmtDate(s.shortageDate)}.`
                    : undefined
                }
                style={{
                  borderTop: '0.5px solid var(--border)',
                  background: r.overdue ? '#fef2f2' : 'transparent',
                }}
              >
                <td style={cellStyle}>
                  <div style={{ fontWeight: 500 }}>{r.rawMaterialCode}</div>
                  <div style={{ color: 'var(--text-muted)', fontSize: 10 }}>
                    {r.rawMaterialName}
                  </div>
                </td>
                <td
                  style={{
                    ...cellStyle,
                    color: r.overdue ? '#dc2626' : 'inherit',
                    fontWeight: r.overdue ? 600 : 400,
                  }}
                >
                  {fmtDate(r.placeByDate)}
                  {r.overdue && (
                    <span style={{ marginLeft: 4, fontSize: 10 }}>⚠</span>
                  )}
                </td>
                <td style={cellStyle}>{fmtDate(r.arriveByDate)}</td>
                <td style={{ ...cellStyle, textAlign: 'right' }}>
                  {Math.round(r.quantity).toLocaleString()}
                </td>
                <td
                  style={{
                    ...cellStyle,
                    textAlign: 'right',
                    color: 'var(--text-muted)',
                  }}
                >
                  {s ? Math.round(s.initialSoh).toLocaleString() : '–'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

const cellStyle: React.CSSProperties = {
  padding: '6px 8px',
  verticalAlign: 'top',
  fontWeight: 'normal',
};

// ─── Collapsible section wrapper (Phase 4l.13) ──────────────────
// Shared shell for the bottom-strip drawers. Persists open/closed state
// to localStorage keyed by `storageKey` so the operator's choice survives
// reloads. The header is a button; clicking anywhere on it toggles.
function CollapsibleSection({
  title,
  count,
  badge,
  storageKey,
  defaultOpen = true,
  children,
}: {
  title: string;
  /** Optional count rendered next to the title (e.g. "12 SKUs"). */
  count?: string;
  /** Optional right-side badge (e.g. "⚠ 3 overdue"). */
  badge?: React.ReactNode;
  storageKey: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  // Initialise with `defaultOpen` so the server-rendered HTML and the
  // client's FIRST render agree — reading localStorage in the useState
  // initializer caused a hydration mismatch (server has no localStorage,
  // so it used the default while the client used the persisted value).
  // The persisted open/closed state is restored in the effect below,
  // after mount, where a state change is safe.
  const [open, setOpen] = useState<boolean>(defaultOpen);
  useEffect(() => {
    try {
      const v = localStorage.getItem(storageKey);
      if (v != null) setOpen(v === '1');
    } catch {
      /* ignore */
    }
  }, [storageKey]);
  const toggle = () => {
    setOpen((p) => {
      const next = !p;
      try { localStorage.setItem(storageKey, next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  };
  return (
    <section
      style={{
        background: 'var(--bg-surface)',
        border: '0.5px solid var(--border)',
        borderRadius: 6,
      }}
    >
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          width: '100%',
          padding: '10px 14px',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          textAlign: 'left',
          color: 'inherit',
        }}
      >
        <span style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span aria-hidden style={{
            display: 'inline-block', width: 10, fontSize: 11,
            color: 'var(--text-muted)',
            transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
            transition: 'transform 0.15s',
          }}>
            ▸
          </span>
          <h3 style={{
            fontSize: 12, fontWeight: 500,
            textTransform: 'uppercase', letterSpacing: '0.05em',
            color: 'var(--text-muted)', margin: 0,
          }}>
            {title}
          </h3>
          {count && (
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              · {count}
            </span>
          )}
        </span>
        {badge}
      </button>
      {open && (
        <div style={{ padding: '0 14px 14px 14px' }}>
          {children}
        </div>
      )}
    </section>
  );
}

// ─── Finished-goods panel (Phase 4l.13) ──────────────────────
// All FGs the planner has assessed (active or dismissed packaging chips),
// with current SOH, available days, a mini sparkline tracking projected
// inventory across the horizon, and red dots marking predicted stockouts.

// Size taxonomy on FG product codes (Byron convention):
//   • Trailing digit → BLK (bulk pack)
//   • Ends "XL"     → XLG (extra large)
//   • Ends "LG"     → LG  (large)
//   • Ends "ME"     → MED (medium)
//   • Ends "SM"     → SML (small)
//   • anything else → Other
// Used only by the size dropdown filter — no per-row column.
type FGSize = 'BLK' | 'XLG' | 'LG' | 'MED' | 'SML' | 'Other';
function detectFGSize(code: string): FGSize {
  const upper = code.toUpperCase();
  if (/\d$/.test(upper)) return 'BLK';
  if (upper.endsWith('XL')) return 'XLG';
  if (upper.endsWith('LG')) return 'LG';
  if (upper.endsWith('ME')) return 'MED';
  if (upper.endsWith('SM')) return 'SML';
  return 'Other';
}

type FGSortKey = 'code' | 'soh' | 'days' | 'status' | 'risk';

type FGSummaryRow = {
  code: string;
  name: string;
  currentSoh: number;
  peak: number;
  ratios: number[];
  floorRatios: number[] | null;
  stockoutIndices: number[];
  firstStockoutDate: string | null;
  dailyRate: number;
  availableDays: number | null;
  activeChips: number;
  dismissedChips: number;
  netChange: number;
  activities: {
    stableId: string;
    date: string;
    quantity: number;
    dismissed: boolean;
    station: string | null;
    assemblyNumber: string | null;
  }[];
  isUnplanned: boolean;
};

function FinishedGoodsPanel({
  rows,
  selectedCode,
  onSelectFG,
}: {
  rows: ReadonlyArray<FGSummaryRow>;
  selectedCode: string | null;
  onSelectFG: (code: string) => void;
}) {
  // Default sort matches the parent's pre-sort: risk-first, descending
  // severity. Clicking a header overrides with that key.
  const [sortKey, setSortKey] = useState<FGSortKey>('risk');
  const [sortAsc, setSortAsc] = useState<boolean>(false);
  const [sizeFilter, setSizeFilter] = useState<FGSize | 'all'>('all');
  // Three-way: 'planned' (default) hides unplanned, 'all' shows both,
  // 'unplanned' shows only the SKUs the planner couldn't schedule.
  const [planFilter, setPlanFilter] = useState<'planned' | 'unplanned' | 'all'>('planned');

  // Pre-compute size on each row once.
  const rowsWithSize = useMemo(
    () => rows.map((r) => ({ ...r, size: detectFGSize(r.code) })),
    [rows],
  );

  const unplannedCount = rows.filter((r) => r.isUnplanned).length;

  // Size dropdown options + per-size counts.
  const sizeCounts = useMemo(() => {
    const counts: Record<string, number> = { all: rowsWithSize.length };
    for (const r of rowsWithSize) counts[r.size] = (counts[r.size] ?? 0) + 1;
    return counts;
  }, [rowsWithSize]);

  const filtered = useMemo(() => {
    let out = rowsWithSize;
    if (planFilter === 'planned') out = out.filter((r) => !r.isUnplanned);
    else if (planFilter === 'unplanned') out = out.filter((r) => r.isUnplanned);
    if (sizeFilter !== 'all') out = out.filter((r) => r.size === sizeFilter);
    return out;
  }, [rowsWithSize, sizeFilter, planFilter]);

  const sorted = useMemo(() => {
    const list = [...filtered];
    const dir = sortAsc ? 1 : -1;
    list.sort((a, b) => {
      let c = 0;
      if (sortKey === 'code') {
        c = a.code.localeCompare(b.code);
      } else if (sortKey === 'soh') {
        c = a.currentSoh - b.currentSoh;
      } else if (sortKey === 'days') {
        // Nulls (no demand) sort to the end regardless of direction.
        const aD = a.availableDays ?? Number.POSITIVE_INFINITY;
        const bD = b.availableDays ?? Number.POSITIVE_INFINITY;
        c = aD - bD;
      } else if (sortKey === 'status') {
        // Active count desc as the natural "more activity" signal; then
        // by dismissed count.
        c = a.activeChips - b.activeChips;
        if (c === 0) c = a.dismissedChips - b.dismissedChips;
      } else if (sortKey === 'risk') {
        // Composite risk score: stockouts dominate, then days-of-cover.
        const aRisk = a.stockoutIndices.length;
        const bRisk = b.stockoutIndices.length;
        if (aRisk !== bRisk) c = aRisk - bRisk;
        else {
          const aD = a.availableDays ?? Number.POSITIVE_INFINITY;
          const bD = b.availableDays ?? Number.POSITIVE_INFINITY;
          // Lower days = higher risk → invert so "more risk" sorts higher
          // when descending.
          c = bD - aD;
        }
      }
      return c * dir;
    });
    return list;
  }, [filtered, sortKey, sortAsc]);

  const toggleSort = (k: FGSortKey) => {
    if (sortKey === k) setSortAsc((p) => !p);
    else {
      setSortKey(k);
      // First click defaults to the "most interesting" direction per column.
      setSortAsc(k === 'code');
    }
  };

  const SortIcon = ({ k }: { k: FGSortKey }) => (
    <span style={{ marginLeft: 4, opacity: sortKey === k ? 0.8 : 0.3, fontSize: 9 }}>
      {sortKey === k ? (sortAsc ? '▲' : '▼') : '⇅'}
    </span>
  );

  const headerBtn = (
    label: string,
    k: FGSortKey,
    align: 'left' | 'right' | 'center' = 'left',
  ) => (
    <th style={{ ...cellStyle, textAlign: align }}>
      <button
        type="button"
        onClick={() => toggleSort(k)}
        style={{
          background: 'transparent', border: 'none', padding: 0, cursor: 'pointer',
          font: 'inherit', color: 'inherit',
          display: 'inline-flex', alignItems: 'center',
          textTransform: 'uppercase', letterSpacing: '0.03em',
        }}
      >
        {label}<SortIcon k={k} />
      </button>
    </th>
  );

  const stockoutCount = filtered.filter((r) => r.stockoutIndices.length > 0).length;
  // Sizes present in the data (so we don't show empty dropdown options).
  // Ordered largest → smallest, with Bulk and Other last.
  const sizesInUse = (['XLG', 'LG', 'MED', 'SML', 'BLK', 'Other'] as const)
    .filter((s) => (sizeCounts[s] ?? 0) > 0);

  return (
    <>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 12, marginBottom: 8, flexWrap: 'wrap',
      }}>
        <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
          Inventory projection across the planning horizon. Red dots = predicted
          stockout days. Amber dashed line = SOH-floor target ({SOH_FLOOR_DAYS} days of cover).
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {/* Plan-status filter — planned / unplanned / both */}
          <div style={{ display: 'inline-flex', gap: 0, border: '0.5px solid var(--border)', borderRadius: 4, overflow: 'hidden' }}>
            {(['planned', 'unplanned', 'all'] as const).map((opt) => {
              const active = planFilter === opt;
              const label = opt === 'planned' ? 'Planned'
                : opt === 'unplanned' ? `Unplanned${unplannedCount > 0 ? ` (${unplannedCount})` : ''}`
                : 'All';
              return (
                <button
                  key={opt}
                  type="button"
                  onClick={() => setPlanFilter(opt)}
                  style={{
                    fontSize: 11,
                    padding: '3px 8px',
                    background: active ? 'var(--accent-light)' : 'var(--bg-page)',
                    color: active ? 'var(--accent)' : 'var(--text-muted)',
                    border: 'none',
                    borderLeft: opt === 'unplanned' || opt === 'all' ? '0.5px solid var(--border)' : 'none',
                    cursor: 'pointer',
                    fontWeight: active ? 600 : 400,
                  }}
                  disabled={opt === 'unplanned' && unplannedCount === 0}
                  title={
                    opt === 'unplanned'
                      ? 'Allowlisted FGs the planner could not schedule (no BOM in the family-sheet workbook).'
                      : opt === 'planned'
                        ? 'FGs the planner has assessed (active or dismissed runs).'
                        : 'Both planned and unplanned.'
                  }
                >
                  {label}
                </button>
              );
            })}
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-muted)' }}>
            Size:
          <select
            value={sizeFilter}
            onChange={(e) => setSizeFilter(e.target.value as FGSize | 'all')}
            style={{
              fontSize: 11,
              padding: '3px 6px',
              background: 'var(--bg-page)',
              color: 'var(--text-primary)',
              border: '0.5px solid var(--border)',
              borderRadius: 4,
              cursor: 'pointer',
            }}
          >
            <option value="all">All ({sizeCounts.all ?? 0})</option>
            {sizesInUse.map((s) => (
              <option key={s} value={s}>
                {s} ({sizeCounts[s]})
              </option>
            ))}
          </select>
        </label>
        </div>
      </div>
      <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ color: 'var(--text-muted)', textAlign: 'left' }}>
            {headerBtn('Product', 'code', 'left')}
            {headerBtn('SOH', 'soh', 'right')}
            {headerBtn('Days', 'days', 'right')}
            {headerBtn('Status', 'status', 'center')}
            <th style={{ ...cellStyle, minWidth: 200 }}>Projection</th>
            {headerBtn('Risk', 'risk', 'right')}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => {
            const VIEW_W = 200;
            const VIEW_H = 28;
            const geom = buildSparklineGeometry(r.ratios, null, VIEW_W, VIEW_H);
            const floorPoints = buildFloorPoints(r.floorRatios, VIEW_W, VIEW_H);
            // Place a red dot at every stockout index. y maps to the bottom
            // since inventory has hit zero there.
            const lastIdx = Math.max(0, r.ratios.length - 1);
            const stockoutDots = r.stockoutIndices.map((i) => ({
              x: lastIdx === 0 ? 0 : (i / lastIdx) * VIEW_W,
              y: VIEW_H - 1,
            }));
            const isAllDismissed = r.activeChips === 0 && r.dismissedChips > 0;
            const isAtRisk = r.stockoutIndices.length > 0;
            const isSelected = r.code === selectedCode;
            return (
              <tr
                key={r.code}
                onClick={() => onSelectFG(r.code)}
                style={{
                  borderTop: '0.5px solid var(--border)',
                  cursor: 'pointer',
                  background: isSelected
                    ? 'var(--accent-light)'
                    : r.isUnplanned
                    ? 'var(--bg-page)'
                    : isAtRisk
                      ? '#fef2f2'
                      : 'transparent',
                  boxShadow: isSelected ? 'inset 2px 0 0 var(--accent)' : undefined,
                  opacity: r.isUnplanned ? 0.7 : 1,
                }}
                title={
                  r.isUnplanned
                    ? 'Allowlisted but the planner has no BOM for this SKU — add a recipe row to the BOMS sheet to enable planning. See data/family-sheet-todo.csv.'
                    : isAtRisk
                      ? `First stockout ${r.firstStockoutDate ? fmtDate(r.firstStockoutDate) : '—'} · ${r.stockoutIndices.length} day${r.stockoutIndices.length === 1 ? '' : 's'} short across the horizon.`
                      : r.availableDays != null
                        ? `${Math.round(r.availableDays)} days of forward cover at current daily demand (${r.dailyRate.toFixed(1)} units/day).`
                        : 'No forecast demand on this product across the horizon.'
                }
              >
                <td style={cellStyle}>
                  <div style={{ fontWeight: 500 }}>{r.code}</div>
                  <div style={{ color: 'var(--text-muted)', fontSize: 10 }}>{r.name}</div>
                </td>
                <td style={{ ...cellStyle, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                  {Math.round(r.currentSoh).toLocaleString()}
                </td>
                <td style={{
                  ...cellStyle, textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                  color: r.availableDays != null && r.availableDays < SOH_FLOOR_DAYS ? '#dc2626' : 'inherit',
                  fontWeight: r.availableDays != null && r.availableDays < SOH_FLOOR_DAYS ? 600 : 400,
                }}>
                  {r.availableDays == null ? '—' : Math.round(r.availableDays)}
                </td>
                <td
                  style={{ ...cellStyle, textAlign: 'center', cursor: 'help' }}
                  title={
                    r.activities.length === 0
                      ? 'No packaging runs for this FG.'
                      : [
                          `${r.activeChips} active${r.dismissedChips > 0 ? ` · ${r.dismissedChips} dismissed` : ''}`,
                          '────────────────',
                          ...r.activities.map((act) => {
                            const mark = act.dismissed ? '✗' : '✓';
                            const station = act.station ? ` (${act.station})` : '';
                            const source = act.assemblyNumber ? ` ⇣${act.assemblyNumber}` : ' ⊕planner';
                            const tag = act.dismissed ? ' [dismissed]' : '';
                            return `${mark} ${fmtDate(act.date)} · ${Math.round(act.quantity).toLocaleString()}${station}${source}${tag}`;
                          }),
                        ].join('\n')
                  }
                >
                  <span style={{
                    display: 'inline-block', padding: '1px 6px', borderRadius: 4,
                    fontSize: 10, fontWeight: 500,
                    color: r.isUnplanned ? '#dc2626' : (isAllDismissed ? 'var(--text-muted)' : 'var(--success)'),
                    background: r.isUnplanned ? '#fef2f2' : (isAllDismissed ? 'var(--bg-page)' : 'var(--success-light)'),
                  }}>
                    {r.isUnplanned ? 'Unplanned' : `${r.activeChips}A ${r.dismissedChips > 0 ? `· ${r.dismissedChips}D` : ''}`}
                  </span>
                </td>
                <td style={cellStyle}>
                  {r.isUnplanned ? (
                    <span style={{ fontSize: 10, color: 'var(--text-muted)', fontStyle: 'italic' }}>
                      No BOM — add a recipe row.
                    </span>
                  ) : (
                  <svg
                    viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
                    preserveAspectRatio="none"
                    aria-hidden="true"
                    style={{ width: '100%', height: VIEW_H, overflow: 'visible', display: 'block' }}
                  >
                    <path d={geom.fillPath} fill="var(--bg-page)" stroke="none" />
                    <polyline
                      points={geom.points}
                      fill="none"
                      stroke="var(--border)"
                      strokeWidth={1}
                      strokeLinejoin="round"
                      strokeLinecap="round"
                      vectorEffect="non-scaling-stroke"
                    />
                    {floorPoints && (
                      <polyline
                        points={floorPoints}
                        fill="none"
                        stroke="#d97706"
                        strokeWidth={1}
                        strokeDasharray="2 2"
                        vectorEffect="non-scaling-stroke"
                      />
                    )}
                    {stockoutDots.map((d, i) => (
                      <circle key={i} cx={d.x} cy={d.y} r={2.5} fill="#dc2626" />
                    ))}
                  </svg>
                  )}
                </td>
                <td style={{ ...cellStyle, textAlign: 'right', fontSize: 11 }}>
                  {r.isUnplanned ? (
                    <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>—</span>
                  ) : isAtRisk ? (
                    <span style={{ color: '#dc2626', fontWeight: 500 }}>
                      ⚠ {r.stockoutIndices.length}d
                    </span>
                  ) : r.netChange < 0 ? (
                    <span style={{ color: 'var(--text-muted)' }}>
                      ↓ {Math.round(Math.abs(r.netChange)).toLocaleString()}
                    </span>
                  ) : (
                    <span style={{ color: 'var(--success)' }}>
                      ↑ {Math.round(r.netChange).toLocaleString()}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {sorted.length === 0 && (
        <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 11 }}>
          {rows.length === 0
            ? 'No finished goods assessed by the planner yet.'
            : `No ${sizeFilter} products in the current plan.`}
        </div>
      )}
      {stockoutCount > 0 && (
        <div style={{ marginTop: 8, fontSize: 10, color: 'var(--text-muted)' }}>
          {stockoutCount} of {filtered.length} FG{filtered.length === 1 ? '' : 's'}
          {sizeFilter !== 'all' ? ` (${sizeFilter})` : ''} show predicted stockouts across the horizon.
        </div>
      )}
    </>
  );
}

// ─── Finished-good product drawer (Phase 4l.14) ─────────────────
// Product-level interrogation opened by clicking a row in the "Finished
// goods in planner" panel. Surfaces the planner's planned production for
// the SKU across the horizon plus the limiting factors that constrain it
// (consumed intermediates' supply, raw-material shortages in its BOM
// chain, stockout/SOH-floor risk, and supply-starved / conflicted runs).
function FinishedGoodDrawer({
  row,
  consumesMap,
  consumesQtyMap,
  intermediateSohByCode,
  intermediateSupplyByCode,
  rawMaterialShortages,
  supplyStarvedSet,
  conflictedStableIds,
  onSelectChip,
  onClose,
}: {
  row: FGSummaryRow;
  consumesMap: Record<string, string[]>;
  consumesQtyMap: Record<string, Record<string, number>>;
  intermediateSohByCode: Record<string, number>;
  intermediateSupplyByCode: Map<string, { runs: number; totalQty: number; firstDate: string | null }>;
  rawMaterialShortages: RawMaterialShortage[];
  supplyStarvedSet: ReadonlySet<string>;
  conflictedStableIds: ReadonlySet<string>;
  onSelectChip: (stableId: string) => void;
  onClose: () => void;
}) {
  const size = detectFGSize(row.code);
  const directDeps = consumesMap[row.code] ?? [];
  // A dependency that itself has a BOM (appears as a consumesMap key) is an
  // intermediate the kitchen produces; one without is a raw material.
  const intermediates = directDeps.filter((c) => consumesMap[c] != null);
  const qtyMap = consumesQtyMap[row.code] ?? {};

  // 2-level raw-material chain (FG's direct components + each consumed
  // intermediate's components) → surface any shortages that touch it.
  const chainCodes = new Set<string>(directDeps);
  for (const inter of intermediates) {
    for (const d of consumesMap[inter] ?? []) chainCodes.add(d);
  }
  const chainShortages = rawMaterialShortages
    .filter((s) => chainCodes.has(s.rawMaterialCode))
    .sort((a, b) => a.shortageDate.localeCompare(b.shortageDate));

  const active = row.activities.filter((a) => !a.dismissed);
  const dismissed = row.activities.filter((a) => a.dismissed);
  const starved = active.filter((a) => supplyStarvedSet.has(a.stableId));
  const conflicted = active.filter((a) => conflictedStableIds.has(a.stableId));
  const totalActiveQty = active.reduce((s, a) => s + a.quantity, 0);
  const isAtRisk = row.stockoutIndices.length > 0;

  const VIEW_W = 280;
  const VIEW_H = 48;
  const geom = buildSparklineGeometry(row.ratios, null, VIEW_W, VIEW_H);
  const floorPoints = buildFloorPoints(row.floorRatios, VIEW_W, VIEW_H);
  const lastIdx = Math.max(0, row.ratios.length - 1);
  const stockoutDots = row.stockoutIndices.map((i) => ({
    x: lastIdx === 0 ? 0 : (i / lastIdx) * VIEW_W,
    y: VIEW_H - 2,
  }));

  const sectionLabel: React.CSSProperties = {
    fontSize: 11,
    color: 'var(--text-muted)',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    margin: '16px 0 6px',
  };
  const metric = (label: string, value: React.ReactNode, color?: string) => (
    <div style={{ flex: '1 1 0', minWidth: 70 }}>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        {label}
      </div>
      <div style={{ fontSize: 15, fontWeight: 600, color: color ?? 'inherit', fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </div>
    </div>
  );

  return (
    <aside
      style={{
        width: 320,
        padding: 20,
        borderLeft: '0.5px solid var(--border)',
        background: 'var(--bg-surface)',
        flexShrink: 0,
        position: 'sticky',
        top: 60,
        maxHeight: 'calc(100vh - 60px)',
        overflowY: 'auto',
        alignSelf: 'flex-start',
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <code style={{ fontFamily: 'monospace', fontSize: 14, fontWeight: 600 }}>{row.code}</code>
            <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 3, background: 'var(--bg-page)', color: 'var(--text-muted)', border: '0.5px solid var(--border)' }}>
              {size}
            </span>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{row.name}</div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 18, lineHeight: 1, color: 'var(--text-muted)', padding: 0 }}
        >
          ×
        </button>
      </div>

      {row.isUnplanned ? (
        <div style={{ marginTop: 16, padding: 10, fontSize: 12, lineHeight: 1.5, border: '0.5px solid var(--border)', borderRadius: 4, background: '#fef2f2', color: '#991b1b' }}>
          <strong>Unplanned.</strong> This SKU is allowlisted but the planner
          has no BOM for it, so it can&apos;t schedule production. Add a recipe
          row to the BOMS sheet (see <code>data/family-sheet-todo.csv</code>) to
          bring it into the plan.
        </div>
      ) : (
        <>
          {/* Metrics */}
          <div style={{ display: 'flex', gap: 12, marginTop: 16, flexWrap: 'wrap' }}>
            {metric('SOH', Math.round(row.currentSoh).toLocaleString())}
            {metric(
              'Days cover',
              row.availableDays == null ? '—' : Math.round(row.availableDays),
              row.availableDays != null && row.availableDays < SOH_FLOOR_DAYS ? '#dc2626' : undefined,
            )}
            {metric(
              'Horizon Δ',
              `${row.netChange < 0 ? '↓' : '↑'} ${Math.round(Math.abs(row.netChange)).toLocaleString()}`,
              row.netChange < 0 ? '#dc2626' : 'var(--success)',
            )}
          </div>

          {/* Inventory projection */}
          <div style={sectionLabel}>Inventory projection</div>
          <svg
            viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
            preserveAspectRatio="none"
            aria-hidden="true"
            style={{ width: '100%', height: VIEW_H, overflow: 'visible', display: 'block' }}
          >
            <path d={geom.fillPath} fill="var(--bg-page)" stroke="none" />
            <polyline points={geom.points} fill="none" stroke="var(--border)" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
            {floorPoints && (
              <polyline points={floorPoints} fill="none" stroke="#d97706" strokeWidth={1} strokeDasharray="2 2" vectorEffect="non-scaling-stroke" />
            )}
            {stockoutDots.map((d, i) => (
              <circle key={i} cx={d.x} cy={d.y} r={3} fill="#dc2626" />
            ))}
          </svg>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>
            {isAtRisk
              ? `⚠ First stockout ${row.firstStockoutDate ? fmtDate(row.firstStockoutDate) : '—'} · ${row.stockoutIndices.length} day${row.stockoutIndices.length === 1 ? '' : 's'} short.`
              : `Amber dashed = SOH-floor target (${SOH_FLOOR_DAYS}d cover).`}
          </div>

          {/* Planned production */}
          <div style={sectionLabel}>
            Planned production · {active.length} run{active.length === 1 ? '' : 's'} · {Math.round(totalActiveQty).toLocaleString()} units
          </div>
          {active.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic' }}>
              No active packaging runs for this SKU in the plan.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              {active.map((a) => (
                <button
                  key={a.stableId}
                  type="button"
                  onClick={() => onSelectChip(a.stableId)}
                  title="Open this run's detail"
                  style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8,
                    width: '100%', textAlign: 'left', padding: '4px 8px', borderRadius: 4,
                    border: '0.5px solid var(--border)', background: 'var(--bg-page)', cursor: 'pointer',
                    font: 'inherit', fontSize: 12,
                  }}
                >
                  <span>{fmtDate(a.date)}</span>
                  <span style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                    {(supplyStarvedSet.has(a.stableId) || conflictedStableIds.has(a.stableId)) && (
                      <span style={{ color: '#dc2626', fontSize: 11 }} title={supplyStarvedSet.has(a.stableId) ? 'Supply-starved' : 'Schedule conflict'}>⚠</span>
                    )}
                    <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>{a.assemblyNumber ? a.assemblyNumber : a.station ?? ''}</span>
                    <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{Math.round(a.quantity).toLocaleString()}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
          {dismissed.length > 0 && (
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>
              + {dismissed.length} dismissed run{dismissed.length === 1 ? '' : 's'} (excluded from supply).
            </div>
          )}

          {/* Limiting factors */}
          <div style={sectionLabel}>Limiting factors</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {/* Risk flags */}
            {(isAtRisk || starved.length > 0 || conflicted.length > 0) && (
              <div style={{ fontSize: 12, lineHeight: 1.5, padding: 8, borderRadius: 4, background: '#fef2f2', color: '#991b1b' }}>
                {isAtRisk && <div>⚠ Projected stockout — demand outpaces planned supply.</div>}
                {starved.length > 0 && <div>⚠ {starved.length} run{starved.length === 1 ? '' : 's'} supply-starved (consumed intermediate not available in time).</div>}
                {conflicted.length > 0 && <div>⚠ {conflicted.length} run{conflicted.length === 1 ? '' : 's'} have a schedule conflict.</div>}
              </div>
            )}

            {/* Consumed intermediates */}
            {intermediates.length > 0 && (
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 4 }}>Consumed intermediates</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {intermediates.map((code) => {
                    const sup = intermediateSupplyByCode.get(code);
                    const soh = intermediateSohByCode[code] ?? 0;
                    const perUnit = qtyMap[code];
                    const limiting = soh <= 0 && (!sup || sup.totalQty <= 0);
                    return (
                      <div key={code} style={{ fontSize: 11, padding: '4px 8px', borderRadius: 4, border: '0.5px solid var(--border)', background: limiting ? '#fef2f2' : 'var(--bg-page)' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <code style={{ fontFamily: 'monospace', fontWeight: 600, color: limiting ? '#991b1b' : 'inherit' }}>{code}</code>
                          {perUnit != null && <span style={{ color: 'var(--text-muted)' }}>{perUnit.toFixed(2)} kg/unit</span>}
                        </div>
                        <div style={{ color: 'var(--text-muted)', marginTop: 2 }}>
                          SOH {Math.round(soh).toLocaleString()} ·{' '}
                          {sup && sup.runs > 0
                            ? `${sup.runs} run${sup.runs === 1 ? '' : 's'} planned (${Math.round(sup.totalQty).toLocaleString()}, first ${sup.firstDate ? fmtDate(sup.firstDate) : '—'})`
                            : 'no runs planned'}
                          {limiting && ' — LIMITING'}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Raw-material shortages in the BOM chain */}
            {chainShortages.length > 0 && (
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 4 }}>Raw-material shortages in chain</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {chainShortages.slice(0, 8).map((s) => (
                    <div key={s.rawMaterialCode} style={{ fontSize: 11, padding: '4px 8px', borderRadius: 4, border: '0.5px solid var(--border)', background: '#fffbeb' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <code style={{ fontFamily: 'monospace', fontWeight: 600 }}>{s.rawMaterialCode}</code>
                        <span style={{ color: '#b45309' }}>short {Math.round(s.shortageQuantity).toLocaleString()}</span>
                      </div>
                      <div style={{ color: 'var(--text-muted)', marginTop: 2 }}>{s.rawMaterialName} · first short {fmtDate(s.shortageDate)}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {!isAtRisk && starved.length === 0 && conflicted.length === 0 &&
              !intermediates.some((c) => (intermediateSohByCode[c] ?? 0) <= 0 && !(intermediateSupplyByCode.get(c)?.totalQty)) &&
              chainShortages.length === 0 && (
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                No supply constraints detected for this SKU over the horizon.
              </div>
            )}
          </div>
        </>
      )}
    </aside>
  );
}

function Field({
  label,
  value,
  modified,
  originalValue,
}: {
  label: string;
  value: string;
  modified?: boolean;
  originalValue?: string;
}) {
  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {label}
      </div>
      <div
        style={{
          marginTop: 2,
          color: modified ? '#1e40af' : 'inherit',
          fontWeight: modified ? 500 : 400,
        }}
      >
        {value}
      </div>
      {modified && originalValue && (
        <div style={{ fontSize: 10, color: 'var(--text-muted)', textDecoration: 'line-through' }}>
          {originalValue}
        </div>
      )}
    </div>
  );
}
