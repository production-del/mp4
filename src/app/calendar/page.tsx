/**
 * Calendar route — Phase 4a of the 3-month planner.
 *
 * Server component. Loads the spreadsheet and demand CSV from disk, runs
 * the full optimisation pipeline (forecaster → orchestrator → day-assigner
 * → calendar projection), and passes the JSON-serialisable projection to
 * the client `CalendarApp` for interactive rendering.
 *
 * Data source resilience: each load step is wrapped — if the spreadsheet
 * or demand.csv is missing, we render an explanatory error rather than a
 * stack trace. This is a planning surface, not a critical-path system.
 */

import { join } from 'path';
import { cookies } from 'next/headers';
import {
  loadCapacityDataFromPath,
  kitchenTeamMinutesFor,
  KITCHEN_DEFAULT_MINUTES,
} from '@/lib/planning/capacity-data';
import {
  analyzeRawMaterials,
  type ActivityForRawMaterials,
  type RawMaterialShortage,
  type PurchaseRequirement,
} from '@/lib/engine/raw-material-demand';
import {
  readLeadTimes,
  leadTimeDaysByCode as leadTimeDaysByCodeOf,
  vendorByCode as vendorByCodeOf,
} from '@/lib/planning/raw-material-lead-times';
import { loadMonthlyDemand } from '@/lib/planning/demand-data-loader';
import {
  defaultHorizon,
  forecastWeeklyDemand,
} from '@/lib/planning/forecast-demand';
import {
  orchestrateBatchPlan,
  type ProductPlan,
} from '@/lib/engine/optimiser-orchestrator';
import { assignBatchesToDays } from '@/lib/engine/day-assigner';
import { projectToCalendar } from '@/lib/planning/calendar-projection';
import { chooseEfficientStation } from '@/lib/engine/station-router';
import {
  balanceStationLoads,
  type ProductRouting,
} from '@/lib/engine/load-balancer';
import {
  readProductOverrides,
  resolveOverride,
} from '@/lib/planning/product-overrides';
import { readSohCache, sohOf, sohBreakdownOf } from '@/lib/planning/soh-cache';
import {
  readSalesOrdersCache,
  salesOrdersForProduct,
  totalCommittedFor,
} from '@/lib/planning/sales-orders-cache';
import {
  readAssembliesCache,
  assembliesAtWarehouse,
} from '@/lib/planning/assemblies-cache';
import { readPurchaseOrdersCache } from '@/lib/planning/purchase-orders-cache';
import { readFinishedGoodsAllowlist } from '@/lib/planning/finished-goods-allowlist';
import { readProductProfit } from '@/lib/planning/product-profit';
import { classifyPackagingMaterial } from '@/lib/planning/packaging-materials';
import { applySupplyCaps } from '@/lib/engine/supply-cap';
import { allocateSupplyFifo } from '@/lib/engine/supply-allocator';
import type { Station } from '@/lib/planning/engine-io';
import { nextWorkday, previousWorkday, isWorkday, fromLocalISODate, toLocalISODate } from '@/lib/planning/working-day';
import { parseManualActivitiesCookie, type ManualActivity } from '@/lib/planning/manual-activities';
import type { RawMaterialSupplyEvent } from '@/lib/engine/raw-material-demand';
import {
  type PackagingActivityForDemand,
} from '@/lib/engine/intermediate-demand';
import { type KitchenSupplyEvent } from '@/lib/engine/kitchen-gap';
import { planKitchenRuns } from '@/lib/engine/kitchen-run-planner';
import type { Demand } from '@/lib/planning/demand';
import { WAREHOUSES } from '@/lib/planning/warehouse-assignments';
import type { CalendarActivity } from '@/lib/planning/calendar-projection';
import { stableIdOf } from '@/lib/planning/calendar-projection';
import { CalendarApp } from './CalendarApp';

export const dynamic = 'force-dynamic'; // Always re-run; calendar reflects latest data

/** Horizon options surfaced in the UI picker. 26 weeks ≈ 6 months — the cap. */
const HORIZON_WEEK_OPTIONS = [12, 16, 20, 26] as const;
const DEFAULT_HORIZON_WEEKS = 12;

/**
 * Warehouses whose finished-goods stock is fulfilment-eligible — i.e. can
 * cover customer demand directly or after a transfer. Sales drain from TBC
 * (and TBC Height, the second sales-fulfilment site); MF Packaging holds
 * finished goods from Hand / Elephant / Dust packaging stations; MF
 * Operations holds finished goods from the Bottlo packaging line.
 *
 * Lundberg Storeroom is deliberately excluded — it holds intermediates
 * and bulk material that haven't been packaged yet. Including it would
 * inflate apparent finished-goods stock and produce under-production.
 *
 * Edit this list when warehouse roles change. UI doesn't expose this yet.
 */
const FULFILMENT_ELIGIBLE_WAREHOUSES: ReadonlyArray<string> = [
  'TBC',
  'TBC Height',
  'MF Packaging',
  'MF Operations',
];

const SPREADSHEET = join(process.cwd(), 'data', 'kitchen capacity and family plans.xlsx');
/**
 * 18 months — matches typical shelf life for the dry-goods catalogue. This
 * is still a single global default; per-product overrides are Phase 4f.
 */
const DEFAULT_SHELF_LIFE_DAYS = 540;
const DEFAULT_MIN_BATCH = 50;
const STEP = 10;
/**
 * Hard cap on batch size = one day of the assigned station's throughput.
 * Without this, the optimiser can collapse a long-shelf-life product's full
 * 12-week demand into a single batch that takes 25+ hours on the station —
 * which the day-assigner then has to absorb as an oversize_batch warning.
 * Capping per-product to one working day's output keeps the optimiser
 * producing batches that physically fit in a day.
 */
function dailyStationOutput(unitsPerHour: number, hoursPerDay: number): number {
  return Math.floor(unitsPerHour * hoursPerDay);
}

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ horizonWeeks?: string; from?: string }>;
}) {
  // Picker state is URL-driven so the choice survives reloads.
  const params = await searchParams;
  const requested = Number(params.horizonWeeks);
  const horizonWeeks = HORIZON_WEEK_OPTIONS.find((n) => n === requested)
    ?? DEFAULT_HORIZON_WEEKS;

  // Phase 4l.8: optional "plan from" anchor date. When set, the planner
  // treats this as today — horizon starts here, today-floors clamp here,
  // PO overdue checks reference here. Validates as YYYY-MM-DD; anything
  // malformed falls back to real today.
  const planFromDate =
    typeof params.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(params.from)
      ? params.from
      : null;

  let pageError: string | null = null;
  let payload: Awaited<ReturnType<typeof buildPayload>> | null = null;

  try {
    payload = await buildPayload(horizonWeeks, planFromDate);
  } catch (e) {
    pageError = e instanceof Error ? e.message : 'Unknown error loading calendar data.';
  }

  if (pageError || !payload) {
    return (
      <div className="p-8 max-w-3xl mx-auto">
        <h1 className="text-xl font-semibold mb-3">Calendar — Setup Required</h1>
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          Could not load planning data:
        </p>
        <pre
          className="mt-3 p-3 text-xs rounded overflow-x-auto"
          style={{ background: 'var(--bg-surface)', border: '0.5px solid var(--border)' }}
        >
          {pageError ?? 'Unknown error.'}
        </pre>
        <p className="text-sm mt-4" style={{ color: 'var(--text-muted)' }}>
          Expected files: <code>data/demand.csv</code> and{' '}
          <code>data/kitchen capacity and family plans.xlsx</code>.
        </p>
      </div>
    );
  }

  return <CalendarApp {...payload} horizonOptions={[...HORIZON_WEEK_OPTIONS]} />;
}

/** Sum SOH for a product across only the fulfilment-eligible warehouses. */
function eligibleSohOf(
  cache: Awaited<ReturnType<typeof readSohCache>>,
  productCode: string,
): number {
  if (!cache) return 0;
  const byWh = cache.byProductCode[productCode];
  if (!byWh) return 0;
  let sum = 0;
  for (const wh of FULFILMENT_ELIGIBLE_WAREHOUSES) {
    sum += byWh[wh] ?? 0;
  }
  return sum;
}

/**
 * Read the demand-affecting mutations cookie set by the client (Phase 4l.7).
 * Empty map when cookie absent / malformed. Carries:
 *   - `dismissed: true` → drop this activity from analyzer + planner walks
 *   - `editedQuantity: number` → override activity.quantity in those walks
 *
 * Reschedule + lead-time overrides are intentionally NOT in this cookie —
 * they're client-only display tweaks (the reschedule mutation is applied
 * via `applyMutationsToActivities` in the client; the chip's stableId
 * stays anchored on its original date).
 */
interface ServerMutation {
  dismissed?: boolean;
  editedQuantity?: number;
  /** YYYY-MM-DD — overrides the activity's planner-assigned date for demand walks. */
  rescheduledTo?: string;
}
async function readServerMutations(): Promise<ReadonlyMap<string, ServerMutation>> {
  try {
    const cookieStore = await cookies();
    const raw = cookieStore.get('byron-mutations-v1')?.value;
    if (!raw) return new Map();
    const parsed = JSON.parse(decodeURIComponent(raw));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return new Map();
    const out = new Map<string, ServerMutation>();
    for (const [id, v] of Object.entries(parsed)) {
      if (typeof id !== 'string' || !v || typeof v !== 'object') continue;
      const entry: ServerMutation = {};
      const rec = v as Record<string, unknown>;
      if (rec.d === true) entry.dismissed = true;
      if (typeof rec.q === 'number' && Number.isFinite(rec.q) && rec.q > 0) {
        entry.editedQuantity = rec.q;
      }
      if (typeof rec.r === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rec.r)) {
        entry.rescheduledTo = rec.r;
      }
      if (entry.dismissed || entry.editedQuantity !== undefined || entry.rescheduledTo !== undefined) {
        out.set(id, entry);
      }
    }
    return out;
  } catch {
    return new Map();
  }
}

async function buildPayload(horizonWeeks: number, planFromDate: string | null) {
  const capacity = loadCapacityDataFromPath(SPREADSHEET);
  const serverMutations = await readServerMutations();
  // Today as YYYY-MM-DD local. When `planFromDate` (URL `?from=...`) is set
  // the planner treats THAT as today — horizon anchor, today-floor clamps,
  // PO overdue flag, etc. Defaults to real today otherwise.
  const todayLocal = planFromDate ?? (() => {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  })();
  // Parsed Date for `defaultHorizon` — anchors the horizon's first week
  // on the Monday of `todayLocal` instead of always real-today.
  const todayAsDate = (() => {
    const [y, m, d] = todayLocal.split('-').map(Number);
    return new Date(y, m - 1, d);
  })();
  // Derived view: just the dismissed-set (used in many filter spots).
  const dismissedStableIds: ReadonlySet<string> = new Set(
    Array.from(serverMutations.entries())
      .filter(([, m]) => m.dismissed)
      .map(([id]) => id),
  );
  /**
   * Resolve an activity's effective quantity by overlaying any qty-edit
   * mutation. Returns null when the activity is dismissed (caller should
   * filter it out entirely).
   */
  const resolveQty = (stableId: string, defaultQty: number): number | null => {
    const m = serverMutations.get(stableId);
    if (!m) return defaultQty;
    if (m.dismissed) return null;
    if (typeof m.editedQuantity === 'number') return m.editedQuantity;
    return defaultQty;
  };
  /**
   * Resolve an activity's effective date by overlaying any rescheduledTo
   * mutation. Phase 4l.7 — lets reschedules flow into kitchen-run lead-time
   * backoff + raw-material analyzer. Past-dated reschedules are clamped
   * forward to today (same today-floor that applies to planner output;
   * demand events in the past don't make sense for the analyzer).
   */
  const resolveDate = (stableId: string, defaultDate: string): string => {
    const m = serverMutations.get(stableId);
    const target = m?.rescheduledTo ?? defaultDate;
    return target < todayLocal ? todayLocal : target;
  };
  // Phase 4o: prefers Google Sheets when GOOGLE_SHEETS_ID is set,
  // falls back to data/demand.csv. Network fetch on every render is
  // ~150 KB/<200ms — fine for a daily-replan cadence.
  const demandData = await loadMonthlyDemand();
  const horizon = defaultHorizon(horizonWeeks, todayAsDate);

  // Phase 4l.8: plan every product with non-zero demand that's producible
  // by us (i.e. appears as a BOM parent and isn't itself an intermediate),
  // regardless of whether it has a `family` sheet entry. Family-sheet
  // entries still drive proper changeover-cost clustering; products
  // missing from it get a default productMeta routed to hand-packing
  // (lowest-changeover station) with no family clustering. The user can
  // promote any orphan to the family sheet for better routing later.
  const allRates = demandData?.rates ?? {};
  const bomParentCodes = new Set<string>();
  for (const row of capacity.bom) {
    bomParentCodes.add(row.parentProductCode);
  }
  const handPackingDefaultRate =
    capacity.stations['hand-packing']?.unitsPerHour ?? 200;
  // Phase 4l.8: planning is gated by an authoritative allowlist
  // (`data/finished-goods-allowlist.json`). Codes in the allowlist:
  //   • with a family-sheet entry → use the explicit routing
  //   • without one but with a BOM → auto-route to hand-packing
  //   • without a BOM → skipped (logged so the team can add a recipe)
  // Codes NOT in the allowlist are silently excluded regardless of demand,
  // family-sheet entry, or BOM. This replaces the older TBC/label/group
  // filters — the allowlist is the single source of truth.
  const allowlist = readFinishedGoodsAllowlist();
  // Phase 4l.9: use `data/product-profit.json`'s "currently packaged on"
  // station letter as the auto-route default for allowlisted SKUs lacking
  // a family-sheet entry. Falls back to hand-packing when the SKU has no
  // entry in product-profit either.
  const productProfit = readProductProfit();
  const autoRoutedSkus: string[] = [];
  const allowlistMissingBom: string[] = [];
  const monthlyRates: Record<string, number> = {};
  if (allowlist) {
    for (const code of allowlist) {
      const rate = allRates[code] ?? 0;
      if (!(rate > 0)) continue; // no demand → can't plan
      if (capacity.productMetaBySku[code]) {
        monthlyRates[code] = rate;
        continue;
      }
      if (!bomParentCodes.has(code)) {
        allowlistMissingBom.push(code);
        continue;
      }
      // Pick station from product-profit data if present; fall back to
      // hand-packing. Rate is the actual station's default unitsPerHour.
      const profitEntry = productProfit?.byCode[code] ?? null;
      const station: Station = profitEntry?.plannerStation ?? 'hand-packing';
      const stationDefaults = capacity.stations[station];
      const rateUnitsPerHour = stationDefaults?.unitsPerHour ?? handPackingDefaultRate;
      capacity.productMetaBySku[code] = {
        productCode: code,
        productName: code,
        family: null,
        extendedFamily: null,
        packageSize: 'OTHER',
        station,
        rateUnitsPerHour,
        profitPerItem: profitEntry?.profitPerItem ?? null,
      };
      autoRoutedSkus.push(code);
      monthlyRates[code] = rate;
    }
  } else {
    // No allowlist file → legacy permissive behaviour: plan anything with
    // family-sheet routing. Kept as a safety net so a deleted allowlist
    // doesn't immediately stop everything.
    for (const [code, rate] of Object.entries(allRates)) {
      if (rate > 0 && capacity.productMetaBySku[code]) {
        monthlyRates[code] = rate;
      }
    }
  }
  if (autoRoutedSkus.length > 0) {
    autoRoutedSkus.sort();
    console.warn(
      `[planner] Auto-routed ${autoRoutedSkus.length} allowlisted SKU(s) missing from family sheet → hand-packing: ${autoRoutedSkus.slice(0, 10).join(', ')}${autoRoutedSkus.length > 10 ? `, …+${autoRoutedSkus.length - 10} more` : ''}`,
    );
  }
  if (allowlistMissingBom.length > 0) {
    console.warn(
      `[planner] Allowlisted SKU(s) missing a BOM (can't plan until recipe added): ${allowlistMissingBom.join(', ')}`,
    );
  }

  // Convert active customer sales orders into dated Demand events for the
  // forecaster. Each line becomes a single event at its requiredDate. The
  // forecaster buckets these into the week containing the date and adds
  // them to the rate-derived baseline. Out-of-horizon lines are silently
  // dropped by the forecaster — committed demand far in the future doesn't
  // belong in this horizon.
  const salesCache = await readSalesOrdersCache();
  // Phase 4l.12 — read assemblies cache EARLY so we can subtract
  // committed Unleashed packaging quantities from forecast demand
  // BEFORE the optimiser runs. (Used downstream too — same cache.)
  const assembliesCache = await readAssembliesCache();
  const salesEvents: Demand[] = (salesCache?.lines ?? []).map((line) => ({
    productCode: line.productCode,
    quantityNeeded: line.quantityRemaining,
    needByDate: line.requiredDate,
    destinationWarehouse: WAREHOUSES.MF_PACKAGING,
    source: {
      type: 'packaging_run',
      runId: line.orderNumber,
      runName: `${line.orderStatus}: ${line.customerName}`,
    },
  }));

  const rawForecast = forecastWeeklyDemand({
    monthlyRates,
    events: salesEvents,
    horizon,
  });

  // ─── Phase 4l.12 — subtract committed Unleashed packaging ────
  // Per-(SKU, week) bucket every committed Unleashed assembly whose
  // PRODUCT is a finished good (= NOT an intermediate), then deduct
  // from the forecast with surplus carry-forward. Without this the
  // planner double-plans whatever Unleashed already has committed.
  //
  // Product-type-based rather than warehouse-based: a Lundberg
  // assembly for MFRMIXNB11 is just as much committed FG production
  // as one in MF Packaging, so it should also reduce the forecast.
  // Intermediate assemblies (XHBC, IRM, etc.) are excluded — they
  // don't reduce FG forecast on their own; the FG draws them through
  // the BOM cascade.
  function mondayIsoOf(iso: string): string {
    const d = fromLocalISODate(iso);
    const dow = d.getDay();
    const mondayOffset = dow === 0 ? -6 : 1 - dow;
    d.setDate(d.getDate() + mondayOffset);
    return toLocalISODate(d);
  }
  const unleashedCommittedByCodeWeek = new Map<string, Map<string, number>>();
  let unleashedCommittedTotal = 0;
  for (const a of assembliesCache?.lines ?? []) {
    if (capacity.intermediates.has(a.productCode)) continue;
    // Dismissed Unleashed-packaging chips don't drive any state; skip.
    const stableId = `unleashed-assembly|${a.assemblyNumber}`;
    if (dismissedStableIds.has(stableId)) continue;
    const monday = mondayIsoOf(a.scheduledDate);
    let m = unleashedCommittedByCodeWeek.get(a.productCode);
    if (!m) {
      m = new Map();
      unleashedCommittedByCodeWeek.set(a.productCode, m);
    }
    m.set(monday, (m.get(monday) ?? 0) + a.quantity);
    unleashedCommittedTotal += a.quantity;
  }
  // Apply subtraction per code with surplus carry-forward.
  const forecast: typeof rawForecast = [];
  const codesInForecast = new Set(rawForecast.map((r) => r.productCode));
  let totalSubtracted = 0;
  for (const code of codesInForecast) {
    const weeksForCode = rawForecast
      .filter((r) => r.productCode === code)
      .sort((a, b) => a.weekStart.localeCompare(b.weekStart));
    const committedByWeek = unleashedCommittedByCodeWeek.get(code);
    if (!committedByWeek || committedByWeek.size === 0) {
      forecast.push(...weeksForCode);
      continue;
    }
    let surplus = 0;
    for (const row of weeksForCode) {
      const committedThisWeek = committedByWeek.get(row.weekStart) ?? 0;
      const availableSupply = committedThisWeek + surplus;
      if (availableSupply >= row.quantity) {
        // Unleashed fully covers this week's forecast.
        surplus = availableSupply - row.quantity;
        totalSubtracted += row.quantity;
      } else {
        const net = row.quantity - availableSupply;
        forecast.push({ ...row, quantity: net });
        totalSubtracted += row.quantity - net;
        surplus = 0;
      }
    }
  }
  if (unleashedCommittedTotal > 0) {
    console.log(
      `[planner] Subtracted ${Math.round(totalSubtracted).toLocaleString()} units from forecast (Unleashed packaging committed: ${Math.round(unleashedCommittedTotal).toLocaleString()} units across ${unleashedCommittedByCodeWeek.size} SKU(s)).`,
    );
  }

  // ─── Pass 1: per-product cost-efficient routing ──────────
  // For each SKU, pick the lowest-cost station from its candidate set
  // (primary + alternate, per the spreadsheet's Kitchen processes sheet).
  // The router is per-product independent — the load balancer (pass 2)
  // refines based on cross-product station load.
  const initialRoutings: ProductRouting[] = [];
  const initialRationales = new Map<string, string>();
  const weeklyDemandByProduct = new Map<string, { weekStart: string; quantity: number }[]>();
  // Phase 4l.12 — FULL (pre-subtraction) forecast, for the client's
  // inventory sparkline ONLY. The planner uses the REDUCED `forecast`
  // (committed Unleashed packaging netted out) so it doesn't double-
  // plan; but the sparkline ALSO renders committed assemblies as
  // supply chips. Feeding the sparkline the reduced forecast AND the
  // assembly-as-supply double-counts the committed quantity (curve
  // looks ~2× healthier). Per the operator's preference, committed
  // assemblies are modelled as SUPPLY (a +qty spike on their date),
  // so the sparkline's DEMAND side must use the full forecast.
  const weeklyDemandFullByProduct = new Map<string, { weekStart: string; quantity: number }[]>();
  for (const r of rawForecast) {
    let arr = weeklyDemandFullByProduct.get(r.productCode);
    if (!arr) {
      arr = [];
      weeklyDemandFullByProduct.set(r.productCode, arr);
    }
    arr.push({ weekStart: r.weekStart, quantity: Math.ceil(r.quantity) });
  }

  for (const code of Object.keys(monthlyRates)) {
    const baseMeta = capacity.productMetaBySku[code];
    // Phase 4l.10: round weekly demand UP to integer units. Fractional
    // demand (from monthly-rate-divided-into-weeks averaging) interacts
    // badly with the DP's discrete inventory state — `round((state −
    // 1.86) / step)` accumulates a 0.14 error per week which surfaces as
    // false infeasibility at end of horizon. Rounding up by ≤1 unit/week
    // (≤12 units/horizon, typically 1-2% over-plan) is acceptable.
    const weeklyDemand = forecast
      .filter((r) => r.productCode === code)
      .map((r) => ({
        weekStart: r.weekStart,
        quantity: Math.ceil(r.quantity),
      }));
    weeklyDemandByProduct.set(code, weeklyDemand);
    const totalDemand = weeklyDemand.reduce((s, w) => s + w.quantity, 0);

    const intermediate = capacity.intermediates.get(baseMeta.family ?? '');
    const candidates: string[] = [];
    if (intermediate?.packingStation) candidates.push(intermediate.packingStation);
    if (intermediate?.alternateStation && intermediate.alternateStation !== intermediate.packingStation) {
      candidates.push(intermediate.alternateStation);
    }
    if (candidates.length === 0) candidates.push(baseMeta.station);

    const decision = chooseEfficientStation({
      productCode: code,
      candidateStations: candidates as Parameters<typeof chooseEfficientStation>[0]['candidateStations'],
      totalHorizonDemand: totalDemand,
      extendedFamily: baseMeta.extendedFamily,
      stationDefaults: capacity.stations,
      changeoverMatrix: capacity.changeoverMatrix,
    });
    initialRationales.set(code, decision.rationale);
    initialRoutings.push({
      productCode: code,
      currentStation: decision.station,
      evaluations: decision.evaluations,
    });
  }

  // ─── Pass 2: cross-product load balancing ────────────────
  // Detect stations whose horizon-total minutes exceed 85% of capacity
  // and move marginal products to their alternates. Single pass — no
  // iterative convergence yet (Phase 4c.3 if needed).
  const balanced = balanceStationLoads({
    routings: initialRoutings,
    stationDefaults: capacity.stations,
    horizonWeeks: horizon.weeks,
    threshold: 0.85,
  });

  // Combine per-product routing rationale: initial + balancer redistribution note.
  const routingByProduct = new Map<string, { station: string; rationale: string }>();
  const redistributedSet = new Set(balanced.redistributions.map((r) => r.productCode));
  for (const r of balanced.routings) {
    const initial = initialRationales.get(r.productCode) ?? '';
    const redist = balanced.redistributions.find((x) => x.productCode === r.productCode);
    const rationale = redist
      ? `${initial} Re-routed to ${redist.toStation} after load balancing — ${redist.reason}`
      : initial;
    routingByProduct.set(r.productCode, { station: r.currentStation, rationale });
  }

  // Per-product overrides — read from data/product-overrides.json on every
  // render. Operators set these via the drawer's Product overrides section
  // (Phase 4f); the next Re-plan picks them up.
  const productOverrides = readProductOverrides();

  // Phase 4l.12 — apply per-SKU `defaultStation` overrides to
  // productMetaBySku BEFORE the optimiser routes. When the user edits
  // a chip's station in the drawer, the override is persisted to
  // product-overrides.json and picked up here so subsequent runs of
  // that SKU default to the new station.
  for (const [code, ovr] of Object.entries(productOverrides)) {
    if (!ovr.defaultStation) continue;
    const meta = capacity.productMetaBySku[code];
    if (!meta) continue;
    if (meta.station === ovr.defaultStation) continue;
    const stationDefaults = capacity.stations[ovr.defaultStation];
    capacity.productMetaBySku[code] = {
      ...meta,
      station: ovr.defaultStation,
      rateUnitsPerHour: stationDefaults?.unitsPerHour ?? meta.rateUnitsPerHour,
    };
  }

  // Stock-on-hand cache — produced by /api/refresh-soh from Unleashed.
  // Read on each render; null when the cache file is missing (planner falls
  // back to 0 for every product, matching pre-4g behaviour).
  const sohCache = await readSohCache();

  // Build the ProductPlan list using the balanced routing decisions.
  const products: ProductPlan[] = balanced.routings.map((r) => {
    const baseMeta = capacity.productMetaBySku[r.productCode];
    const weeklyDemand = weeklyDemandByProduct.get(r.productCode) ?? [];
    // Phase 4l.9: attach profitPerItem from product-profit data so the
    // day-assigner can rank batches by joint demand × profit value when
    // packaging capacity overflows in a week. Auto-routed metas already
    // carry this; family-sheet metas pick it up here.
    const profitForCode = productProfit?.byCode[r.productCode]?.profitPerItem ?? null;
    const chosenMeta = {
      ...baseMeta,
      station: r.currentStation,
      rateUnitsPerHour:
        capacity.stations[r.currentStation]?.unitsPerHour ?? baseMeta.rateUnitsPerHour,
      profitPerItem: baseMeta.profitPerItem ?? profitForCode,
    };
    const station = capacity.stations[r.currentStation];
    const stationMaxBatch = station
      ? dailyStationOutput(station.unitsPerHour, station.hoursPerDay)
      : 1500;
    const resolved = resolveOverride(productOverrides, r.productCode, {
      shelfLifeDays: DEFAULT_SHELF_LIFE_DAYS,
      maxBatchSize: stationMaxBatch,
    });
    // Phase 4l.8 / 4l.10: scale minBatchSize AND step down for low-volume
    // SKUs.
    //
    // minBatchSize: a fixed minBatch of 50 makes any SKU with total demand
    // < 50 infeasible (the cap rejects every non-zero batch). Use
    // min(default, ceil(total demand)) so a single batch can satisfy the
    // whole horizon.
    //
    // step (Phase 4l.10): the DP's inventory state is discretised in `step`
    // units. If the per-week demand is smaller than step/2, `Math.round`
    // never advances the state — the discrete inventory stays "stuck" at
    // its starting level even though real-world inventory is depleting.
    // Eventually the natural-carry cap rejects the stuck state and the
    // product reports infeasible (e.g. MFROSHBSM with 19 units demand
    // over 12 weeks = 1.58/week vs step=10). Pick `step ≤ floor(avg
    // weekly demand)` so each week's transition moves the state by ≥1
    // unit. Performance is bounded by `maxBatchSize / step` per product;
    // step=1 over 12 weeks × 1500 states × 1500 batch choices ≈ 30M ops
    // — acceptable for the ~30–40 low-demand SKUs that need it.
    const totalHorizonDemand = weeklyDemand.reduce((s, w) => s + w.quantity, 0);
    const avgWeeklyDemand = totalHorizonDemand / Math.max(1, weeklyDemand.length);
    const effectiveStep = Math.max(
      1,
      Math.min(STEP, Math.floor(avgWeeklyDemand)),
    );
    const effectiveMinBatch = Math.max(
      effectiveStep,
      Math.min(DEFAULT_MIN_BATCH, Math.ceil(totalHorizonDemand)),
    );
    return {
      meta: chosenMeta,
      weeklyDemand,
      // Global eligible SOH: sum across TBC + TBC Height + MF Packaging +
      // MF Operations. Lundberg Storeroom (intermediates) excluded. Stock
      // at non-target warehouses will be transferred in (Phase 4i.2 will
      // surface the transfer requirements derived from this plan).
      initialInventory: eligibleSohOf(sohCache, r.productCode),
      shelfLifeDays: resolved.shelfLifeDays,
      minBatchSize: effectiveMinBatch,
      maxBatchSize: resolved.maxBatchSize,
      step: effectiveStep,
      // Phase 4l.12: per-SKU SOH floor override (days of forward demand).
      // Undefined → DP uses its global default (DEFAULT_SOH_FLOOR_DAYS=10).
      sohFloorDays: resolved.sohFloorDays,
    };
  });
  // Suppress unused-variable warning on redistributedSet — used implicitly via
  // routingByProduct above. Kept here for future "Re-routed" badge in the UI.
  void redistributedSet;

  const orchestratorOutput = orchestrateBatchPlan({
    products,
    changeoverMatrix: capacity.changeoverMatrix,
  });

  const dayOutput = assignBatchesToDays({
    perStation: orchestratorOutput.perStation,
  });

  const projection = projectToCalendar(dayOutput);

  // ─── Day-assigner overflow recovery (Phase 4l.8) ──────────
  // When `planFromDate` lands mid-week, the orchestrator schedules a full
  // week of batches but the day-assigner only has the remaining workdays
  // available — overflowing batches got silently dropped as
  // `week_overflow` warnings. Re-emit them as packaging chips dated at
  // their original weekStart; the downstream packaging today-floor (which
  // also respects intermediate finishes) will then clamp them forward to
  // a day with capacity.
  //
  // Phase 4l.10: mark these with `packagingInfo.overdue = true` so the
  // today-floor walk picks them up even when weekStart equals today
  // (= first horizon Monday). Without this they'd pile up on the first
  // workday as a single capacity spike (the 976% column the user saw).
  //
  // Phase 4l.11: seed a per-(productCode, weekStart) counter from the
  // existing projection.activities so the overflow chips we mint here
  // don't collide with main packaging chips that may already occupy
  // `orderInWeek=0` (or 1, 2, ...) for the same SKU/week.
  const packagingOrderCounter = new Map<string, number>();
  for (const existing of projection.activities) {
    if (existing.kind !== 'packaging') continue;
    const key = `${existing.productCode}|${existing.weekStart}`;
    const next = Math.max(
      packagingOrderCounter.get(key) ?? 0,
      existing.orderInWeek + 1,
    );
    packagingOrderCounter.set(key, next);
  }
  for (const w of dayOutput.warnings) {
    if (w.kind !== 'week_overflow') continue;
    const meta = capacity.productMetaBySku[w.productCode];
    if (!meta) continue; // shouldn't happen — orchestrator emitted it
    const packagingOrderKey = `${w.productCode}|${w.weekStart}`;
    const overflowOrderInWeek =
      packagingOrderCounter.get(packagingOrderKey) ?? 0;
    packagingOrderCounter.set(packagingOrderKey, overflowOrderInWeek + 1);
    const stableId = stableIdOf(w.productCode, w.weekStart, overflowOrderInWeek);
    projection.activities.push({
      id: stableId,
      stableId,
      kind: 'packaging',
      date: w.weekStart, // Monday of the original week — pre today-floor
      weekStart: w.weekStart,
      orderInWeek: overflowOrderInWeek,
      station: w.station,
      productCode: w.productCode,
      productName: w.productName || meta.productName || w.productCode,
      quantity: w.quantity,
      durationMinutes: w.durationMinutes,
      changeoverMinutes: 0,
      family: meta.family,
      extendedFamily: meta.extendedFamily,
      packageSize: meta.packageSize,
      profitPerItem: meta.profitPerItem ?? null,
      packagingInfo: {
        overdue: true,
        originalDate: w.weekStart,
      },
    });
  }

  // ─── Manual activities (Phase 4l.8) ───────────────────────
  // User-created packaging chips dragged onto the calendar (typically
  // from the "Infeasible products" panel). Injected here so they flow
  // through the rest of the pipeline identically to planner-emitted
  // packaging chips — kitchen-run cascade, raw-material analyzer,
  // conflict detection, etc.
  async function readManualActivitiesFromCookie(): Promise<ManualActivity[]> {
    const cookieStore = await cookies();
    return parseManualActivitiesCookie(cookieStore.get('byron-manual-activities-v1')?.value);
  }
  const manualActivities = await readManualActivitiesFromCookie();
  for (const m of manualActivities) {
    const d = new Date(m.date + 'T00:00:00');
    const dow = d.getDay();
    const mondayOffset = dow === 0 ? -6 : 1 - dow;
    const monday = new Date(d);
    monday.setDate(d.getDate() + mondayOffset);
    const weekStart = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`;
    const stableId = `manual|${m.id}`;
    const meta = capacity.productMetaBySku[m.productCode];
    const stationDefaults = capacity.stations[m.station];
    const durationMinutes = stationDefaults
      ? (m.quantity / stationDefaults.unitsPerHour) * 60
      : 0;
    projection.activities.push({
      id: stableId,
      stableId,
      kind: 'packaging',
      date: m.date,
      weekStart,
      orderInWeek: 999, // sort to end of week
      station: m.station,
      productCode: m.productCode,
      productName: m.productName || meta?.productName || m.productCode,
      quantity: m.quantity,
      durationMinutes,
      changeoverMinutes: 0,
      family: meta?.family ?? null,
      extendedFamily: meta?.extendedFamily ?? null,
      packageSize: meta?.packageSize ?? null,
      profitPerItem: meta?.profitPerItem ?? null,
    });
  }

  // Kitchen + packaging activities from Unleashed assemblies. Routing
  // is PRODUCT-TYPE based, not warehouse based (Phase 4l.12):
  //
  //   • productCode ∈ capacity.intermediates → kitchen layer
  //     (kind='kitchen', station=null, with kitchen-minutes + dehydrator
  //     occupancy). Source: Lundberg Storeroom assemblies (kitchen-side
  //     production lives there).
  //
  //   • everything else → packaging layer (kind='packaging') on the
  //     right station. The station is resolved by:
  //         (1) capacity.productMetaBySku[code].station — planner's
  //             authoritative routing (allowlist + family sheet)
  //         (2) productProfit.byCode[code].plannerStation — operational
  //             "currently packaged on" letter from product-profit.json
  //         (3) 'hand-packing' as the safe default
  //     Sources: MF Packaging, MF Operations, TBC, PLUS any Lundberg
  //     assembly whose product is a packaged good (not an intermediate).
  //
  // The user was hitting this with finished-good SKUs (e.g. MFRMIXNB11)
  // appearing as kitchen chips because they came out of Lundberg, when
  // they should be packaging chips on hand-packing. Conversely if an
  // intermediate assembly ever lands at a packaging warehouse, it'd be
  // treated as kitchen so dehydrator + kitchen-team load is tracked
  // correctly.
  const resolvePackagingStation = (code: string): Station => {
    const meta = capacity.productMetaBySku[code];
    if (meta?.station) return meta.station;
    const profitEntry = productProfit?.byCode[code];
    if (profitEntry?.plannerStation) return profitEntry.plannerStation;
    return 'hand-packing';
  };

  const purchaseOrdersCache = await readPurchaseOrdersCache();
  const kitchenActivities: CalendarActivity[] = [];
  // Phase 4l.11 — per-(productCode, weekStart) counter so multiple live
  // kitchen assemblies for the same intermediate in the same week don't
  // collide on `orderInWeek=0`. We also keep an assemblyNumber→stableId
  // map so the dismissed-set lookup below (when building
  // scheduledKitchenSupply) can pick up the same id rather than minting
  // its own with a different orderInWeek.
  const kitchenOrderCounter = new Map<string, number>();
  const kitchenStableIdByAssembly = new Map<string, string>();
  const unleashedPackagingActivities: CalendarActivity[] = [];

  // Unified routing pass: iterate Lundberg + packaging warehouses,
  // route each assembly to the kitchen OR packaging layer based on
  // whether its productCode is an intermediate. A packaged good in
  // Lundberg (e.g. MFRMIXNB11) now lands on the packaging layer
  // (hand-packing), and an intermediate hidden in a packaging
  // warehouse would correctly land on the kitchen layer with kitchen-
  // team + dehydrator load tracked.
  const ASSEMBLY_SOURCE_WAREHOUSES = [
    WAREHOUSES.LUNDBERG,
    WAREHOUSES.MF_PACKAGING,
    WAREHOUSES.MF_OPERATIONS,
    'TBC',
  ];
  const seenAssemblyNumbers = new Set<string>();
  for (const wh of ASSEMBLY_SOURCE_WAREHOUSES) {
    for (const a of assembliesAtWarehouse(assembliesCache, wh)) {
      if (seenAssemblyNumbers.has(a.assemblyNumber)) continue;
      seenAssemblyNumbers.add(a.assemblyNumber);
      const intermediateMeta = capacity.intermediates.get(a.productCode);
      const isIntermediate = !!intermediateMeta;

      // Compute weekStart Monday once — both branches need it.
      const d = new Date(a.scheduledDate + 'T00:00:00');
      const dow = d.getDay();
      const mondayOffset = dow === 0 ? -6 : 1 - dow;
      const monday = new Date(d);
      monday.setDate(d.getDate() + mondayOffset);
      const weekStart = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`;

      if (isIntermediate) {
        // ─── Kitchen layer ──────────────────────────────────────
        const chipKitchenMinutes = kitchenTeamMinutesFor(intermediateMeta, a.quantity);
        let dehydratorTrays: number | null = null;
        let dehydratorOccupiesFrom: string | null = null;
        let dehydratorOccupiesTo: string | null = null;
        if (
          intermediateMeta.dehydHours &&
          intermediateMeta.dehydHours > 0 &&
          intermediateMeta.kgPerTray &&
          intermediateMeta.kgPerTray > 0
        ) {
          dehydratorTrays = Math.ceil(a.quantity / intermediateMeta.kgPerTray);
          const dehydDays = Math.max(1, Math.ceil(intermediateMeta.dehydHours / 24));
          const hasSoak = intermediateMeta.processSteps.some(
            (s) => s === 'soak' || s.toLowerCase().includes('soak'),
          );
          const soakOffsetDays = hasSoak ? 1 : 0;
          const fromDate = new Date(a.scheduledDate + 'T00:00:00');
          fromDate.setDate(fromDate.getDate() + soakOffsetDays);
          const toDate = new Date(fromDate);
          toDate.setDate(toDate.getDate() + dehydDays - 1);
          const isoOf = (dd: Date) =>
            `${dd.getFullYear()}-${String(dd.getMonth() + 1).padStart(2, '0')}-${String(dd.getDate()).padStart(2, '0')}`;
          dehydratorOccupiesFrom = isoOf(fromDate);
          dehydratorOccupiesTo = isoOf(toDate);
        }
        const kitchenOrderKey = `${a.productCode}|${weekStart}`;
        const kitchenOrderInWeek = kitchenOrderCounter.get(kitchenOrderKey) ?? 0;
        kitchenOrderCounter.set(kitchenOrderKey, kitchenOrderInWeek + 1);
        const kitchenStableId = stableIdOf(a.productCode, weekStart, kitchenOrderInWeek);
        kitchenStableIdByAssembly.set(a.assemblyNumber, kitchenStableId);
        kitchenActivities.push({
          id: `kitchen-${a.assemblyNumber}`,
          stableId: kitchenStableId,
          kind: 'kitchen',
          date: a.scheduledDate,
          weekStart,
          orderInWeek: kitchenOrderInWeek,
          station: null,
          productCode: a.productCode,
          productName: a.productName,
          quantity: a.quantity,
          durationMinutes: 0, // not estimated for kitchen yet
          changeoverMinutes: 0,
          family: null,
          extendedFamily: null,
          assemblyNumber: a.assemblyNumber,
          assemblyStatus: a.status,
          kitchenMinutes: chipKitchenMinutes,
          dehydratorTrays,
          dehydratorOccupiesFrom,
          dehydratorOccupiesTo,
        });
        continue;
      }

      // ─── Packaging layer ────────────────────────────────────
      // Packaged good (incl. ones from Lundberg). Resolve the station
      // via the helper above so it lands on the right equipment.
      const meta = capacity.productMetaBySku[a.productCode];
      const station = resolvePackagingStation(a.productCode);
      const stationDefaults = capacity.stations[station];
      const rateUnitsPerHour = stationDefaults?.unitsPerHour ?? 200;
      const durationMinutes =
        rateUnitsPerHour > 0 ? (a.quantity / rateUnitsPerHour) * 60 : 0;
      // Anchor stableId on the assembly number — these chips are
      // committed and won't be split into batches, so a simple ID is
      // fine. Prefix avoids collision with planner-emitted IDs.
      const stableId = `unleashed-assembly|${a.assemblyNumber}`;
      unleashedPackagingActivities.push({
        id: `unleashed-pkg-${a.assemblyNumber}`,
        stableId,
        kind: 'packaging',
        date: a.scheduledDate,
        weekStart: a.scheduledDate, // placeholder — not used for these
        orderInWeek: 0,
        station,
        productCode: a.productCode,
        productName: a.productName,
        quantity: a.quantity,
        durationMinutes,
        changeoverMinutes: 0,
        family: meta?.family ?? null,
        extendedFamily: meta?.extendedFamily ?? null,
        packageSize: meta?.packageSize ?? null,
        profitPerItem: meta?.profitPerItem ?? null,
        assemblyNumber: a.assemblyNumber,
        assemblyStatus: a.status,
      });
    }
  }
  if (unleashedPackagingActivities.length > 0 || kitchenActivities.length > 0) {
    // Group routing diagnostics by where each chip landed so it's
    // obvious when a Lundberg assembly was routed to packaging or
    // vice-versa.
    const byStation = new Map<string, number>();
    for (const a of unleashedPackagingActivities) {
      byStation.set(a.station ?? '?', (byStation.get(a.station ?? '?') ?? 0) + 1);
    }
    const stationSummary = Array.from(byStation.entries())
      .map(([s, n]) => `${s}=${n}`)
      .join(', ');
    console.log(
      `[planner] Unleashed assemblies routed: ${kitchenActivities.length} kitchen, ${unleashedPackagingActivities.length} packaging (${stationSummary || '—'}).`,
    );
  }

  // ─── Cascading kitchen-run planner (Phase 4k.2) ──────────
  // Walk packaging plan, derive intermediate demand via BOM, compare to
  // Lundberg SOH + scheduled assemblies, surface gaps as required runs
  // with proper lead-time backoff (chip date = start, finish day before
  // downstream consumption). Recurses through sub-intermediates.
  //
  // Phase 4l.7: drop dismissed packaging chips from the demand walk AND
  // apply any per-chip qty-edit override. Cancelling a packaging chip
  // shrinks/removes the intermediate kitchen-required chip; editing its
  // qty resizes downstream demand. Dismissed live kitchen assemblies are
  // also dropped from `scheduledKitchenSupply` further down.
  const intermediateCodes = new Set(capacity.intermediates.keys());
  const packagingForDemand: PackagingActivityForDemand[] = projection.activities
    .flatMap((a) => {
      const q = resolveQty(a.stableId, a.quantity);
      if (q === null) return [];
      const date = resolveDate(a.stableId, a.date);
      return [{ ...a, quantity: q, date }];
    })
    .map(
    (a) => ({
      productCode: a.productCode,
      productName: a.productName,
      quantity: a.quantity,
      date: a.date,
    }),
  );

  // Phase 4l.12 — Unleashed-committed packaging assemblies drive
  // upstream demand for components/intermediates so they can be
  // fulfilled. Statuses in this set are treated as "not yet drawn
  // upstream" — the planner needs to project the cascade. Statuses
  // NOT in the set (Planned, Open) are assumed to have already
  // committed their components in Unleashed → no fresh cascade.
  const PACKAGING_TRIGGERS_UPSTREAM = new Set<string>([
    'Parked',
    'To Do',
    'Todo',
    'Priority',
    'Unapproved',
    'Inventory Mgr',
    'InventoryMgr',
    'Inventory Manager',
  ]);
  for (const a of unleashedPackagingActivities) {
    if (dismissedStableIds.has(a.stableId)) continue;
    const status = a.assemblyStatus ?? '';
    if (!PACKAGING_TRIGGERS_UPSTREAM.has(status)) continue;
    packagingForDemand.push({
      productCode: a.productCode,
      productName: a.productName,
      quantity: a.quantity,
      date: a.date,
    });
  }
  // Diagnostic: count how many Unleashed packaging assemblies
  // contributed demand vs how many were skipped (Planned / Open / other).
  {
    const triggered: string[] = [];
    const skipped: string[] = [];
    for (const a of unleashedPackagingActivities) {
      if (PACKAGING_TRIGGERS_UPSTREAM.has(a.assemblyStatus ?? '')) {
        triggered.push(`${a.assemblyNumber}:${a.assemblyStatus}`);
      } else {
        skipped.push(`${a.assemblyNumber}:${a.assemblyStatus}`);
      }
    }
    if (triggered.length > 0) {
      console.log(
        `[planner] ${triggered.length} Unleashed packaging assembly(ies) triggering upstream cascade (Parked / To Do / Priority / Unapproved / Inventory Mgr); ${skipped.length} skipped (Planned / Open / other — components assumed committed).`,
      );
    }
  }
  // Intermediate SOH lookup (Phase 4l.8). Intermediates can sit at any of:
  //   • Lundberg — just produced by the kitchen
  //   • MF Packaging — staged for hand-pack / elephant / dust runs
  //   • MF Operations — staged for bottlo line
  // Summing across all three avoids the false-orphan pattern where the
  // kitchen-gap engine thought Lundberg = 0 → emitted a run → but the
  // downstream packaging chips were already covered by MF Packaging /
  // Operations stock so FIFO never allocated the new run.
  const lundbergSohByCode: Record<string, number> = {};
  if (sohCache) {
    const intermediateWarehouses = [
      WAREHOUSES.LUNDBERG,
      WAREHOUSES.MF_PACKAGING,
      WAREHOUSES.MF_OPERATIONS,
    ];
    for (const [code, byWh] of Object.entries(sohCache.byProductCode)) {
      if (!intermediateCodes.has(code)) continue;
      let total = 0;
      for (const wh of intermediateWarehouses) {
        total += byWh[wh] ?? 0;
      }
      if (total > 0) lundbergSohByCode[code] = total;
    }
  }
  const scheduledKitchenSupply: KitchenSupplyEvent[] = (
    assembliesCache?.lines ?? []
  )
    .filter((a) => {
      if (a.warehouseName !== WAREHOUSES.LUNDBERG) return false;
      if (!intermediateCodes.has(a.productCode)) return false;
      // Phase 4l.7: a dismissed live-kitchen assembly no longer credits supply.
      // Phase 4l.11: look up the actual minted stableId for this assembly
      // rather than re-deriving with `orderInWeek=0`, which would collide
      // when multiple assemblies share (productCode, weekStart).
      const sid = kitchenStableIdByAssembly.get(a.assemblyNumber);
      if (sid && dismissedStableIds.has(sid)) return false;
      return true;
    })
    .map((a) => ({
      intermediateCode: a.productCode,
      date: a.scheduledDate,
      quantity: a.quantity,
      source: a.assemblyNumber,
    }));

  // ─── Consumes map (Phase 4l.2 + 4m.3) ─────────────────────
  // For each productCode with BOM entries, list its depth-1 dependencies —
  // BOTH intermediates (handled by kitchen-required chips) AND raw materials
  // (handled by PO chips). The client uses this with the current mutated
  // activity dates to detect schedule conflicts: kitchen run dragged too
  // late breaks the 1-day buffer for packaging, OR a raw material's PO
  // arrives after its consuming kitchen/packaging activity.
  const consumesMap: Record<string, string[]> = {};
  for (const row of capacity.bom) {
    let arr = consumesMap[row.parentProductCode];
    if (!arr) {
      arr = [];
      consumesMap[row.parentProductCode] = arr;
    }
    if (!arr.includes(row.productCode)) arr.push(row.productCode);
  }

  // ─── Reachable-from-packaging set (Phase 4l.8) ────────────
  // Walk the BOM downwards from every (non-dismissed) packaging chip's
  // productCode. The closure of this walk is "every intermediate / raw
  // material that could legitimately be needed for the current plan". We
  // use it to filter orphan kitchen-required runs whose cascade chain
  // doesn't terminate in a real packaging chip — e.g. a level-2 run that
  // bubbled up from a BOM that includes a code we silently dropped earlier
  // because it was missing from the `family` sheet.
  const reachableFromPackaging = new Set<string>();
  for (const a of packagingForDemand) {
    reachableFromPackaging.add(a.productCode);
  }
  {
    let frontier = [...reachableFromPackaging];
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const parent of frontier) {
        for (const child of consumesMap[parent] ?? []) {
          if (!reachableFromPackaging.has(child)) {
            reachableFromPackaging.add(child);
            next.push(child);
          }
        }
      }
      frontier = next;
    }
  }

  // Phase 4l.12 — set of intermediates the user has flagged as
  // pass-through (skip kitchen-required chip). Plumbed in from
  // data/product-overrides.json. Cascade still walks their components
  // so component POs get projected normally.
  const skipKitchenIntermediates = new Set<string>();
  for (const [code, ovr] of Object.entries(productOverrides)) {
    if (ovr.skipKitchenRun === true) skipKitchenIntermediates.add(code);
  }
  if (skipKitchenIntermediates.size > 0) {
    console.log(
      `[planner] Skipping kitchen-required chip emission for ${skipKitchenIntermediates.size} intermediate(s) (pass-through cascade only): ${[...skipKitchenIntermediates].sort().join(', ')}`,
    );
  }

  const kitchenRuns = planKitchenRuns({
    packagingActivities: packagingForDemand,
    bom: capacity.bom,
    intermediates: capacity.intermediates,
    intermediateCodes,
    familyMap: capacity.familyMap,
    lundbergSohByCode,
    scheduledSupply: scheduledKitchenSupply,
    bufferDays: 1,
    today: todayLocal,
    skipIntermediates: skipKitchenIntermediates,
  });

  // Phase 4l.8: drop kitchen runs whose intermediate isn't reachable
  // downstream to a packaging chip. These appear when a missing-meta FG
  // (silently filtered by the optimiser) leaves an orphan in the BOM walk
  // and `planKitchenRuns` cascades into it. Without this filter the user
  // sees kitchen-required chips that have no consumer to draw an arrow to.
  const reachableKitchenRuns = kitchenRuns.filter((run) =>
    reachableFromPackaging.has(run.intermediateCode),
  );

  // Phase 4l.12 — tag live Unleashed kitchen assemblies whose product
  // isn't reachable from any visible packaging chip. Unlike planner-
  // derived runs (which we just filtered above), live assemblies stay
  // visible — the user needs to close them out in Unleashed, not
  // pretend they don't exist. The `orphan: true` flag drives a visual
  // tag on the chip + drawer explainer + server-side warning so they
  // can sweep these as a batch.
  let orphanKitchenCount = 0;
  for (let i = 0; i < kitchenActivities.length; i++) {
    if (!reachableFromPackaging.has(kitchenActivities[i].productCode)) {
      kitchenActivities[i] = { ...kitchenActivities[i], orphan: true };
      orphanKitchenCount += 1;
    }
  }
  if (orphanKitchenCount > 0) {
    console.warn(
      `[planner] ${orphanKitchenCount} live kitchen assembly(ies) flagged ORPHAN — their intermediate isn't consumed by any current packaging chip. Likely stale Unleashed assemblies; close out in Unleashed.`,
      kitchenActivities
        .filter((a) => a.orphan)
        .slice(0, 10)
        .map((a) => `${a.productCode}@${a.date}(${a.assemblyNumber})`)
        .join(', '),
    );
  }

  // Convert kitchen runs to CalendarActivity[] anchored on the START date.
  //
  // Phase 4l.10 — batch splitting. Each kitchen run carries an aggregate
  // input quantity already rounded up to a multiple of preferredBatchSize
  // (e.g. IABKCH 3600 kg = 12 batches × 300). Previously we emitted ONE
  // chip per run; downstream the dehydrator-capacity check then saw a
  // single 1668-tray block that physically can't fit on any day's pool
  // (~605 trays). Now we emit ONE chip per preferred batch — 12 chips
  // of 300 kg each, with sequential `orderInWeek`. The kitchen walk
  // then redistributes them across days so daily dehydrator load stays
  // within the 605-tray pool. Recipes with no preferredBatchSize stay
  // as one chip (= the entire input quantity).
  const kitchenRequiredActivities: CalendarActivity[] = [];
  // Phase 4l.11 — global per-(productCode, weekStart) counter so that
  // multiple kitchen runs of the same intermediate landing in the same
  // week don't collide on `orderInWeek=0`. Previously each run reset
  // batchIdx to 0, which produced duplicate stableIds (e.g. two distinct
  // IAB runs both minting `IAB|2026-05-18|0`) — the calendar's chipRefs
  // map then resolved the stableId to whichever chip rendered last, so
  // arrows targeting the legitimate supplier visually landed on an
  // unrelated chip.
  const orderCounterByKey = new Map<string, number>();
  // Per-run capture of the first batch's stableId, so the supply-cap
  // pre-pass can resolveQty against the same id the chip mint produced
  // (without it the cap would use a different scheme and miss user
  // edits — see Phase 4l.11 alignment).
  const runFirstChipStableId = new Map<number, string>();
  // Number of chips actually emitted per run (= numBatches after the
  // remainder skip), so the supply-cap pass can sum batch-level edits
  // when present.
  const runChipStableIds = new Map<number, string[]>();
  for (let runIdx = 0; runIdx < reachableKitchenRuns.length; runIdx++) {
    const run = reachableKitchenRuns[runIdx];
    const d = new Date(run.startDate + 'T00:00:00');
    const dow = d.getDay();
    const mondayOffset = dow === 0 ? -6 : 1 - dow;
    const monday = new Date(d);
    monday.setDate(d.getDate() + mondayOffset);
    const weekStart = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`;
    const orderKey = `${run.intermediateCode}|${weekStart}`;
    const requiredByDate = run.availableDate;
    const intermediateMeta = capacity.intermediates.get(run.intermediateCode);
    const preferredBatch = intermediateMeta?.preferredBatchSize ?? 0;
    // Split into preferred batches when meaningful (smaller than aggregate).
    let numBatches = 1;
    let perBatchQty = run.quantity;
    if (preferredBatch > 0 && preferredBatch < run.quantity) {
      numBatches = Math.max(1, Math.ceil(run.quantity / preferredBatch));
      perBatchQty = preferredBatch;
    }
    for (let batchIdx = 0; batchIdx < numBatches; batchIdx++) {
      // Last batch absorbs any remainder so total exactly equals run.quantity
      // (relevant when preferredBatch * numBatches > run.quantity due to ceil).
      const remaining = run.quantity - batchIdx * perBatchQty;
      const thisBatchQty = Math.min(perBatchQty, remaining);
      if (thisBatchQty <= 0) continue;
      // Phase 4l.10: compute kitchen-team minutes per batch quantity.
      const chipKitchenMinutes = intermediateMeta
        ? kitchenTeamMinutesFor(intermediateMeta, thisBatchQty)
        : KITCHEN_DEFAULT_MINUTES;
      // Dehydrator occupancy for this batch (= per-batch trays + the
      // recipe's dehyd window starting after soak).
      let dehydratorTrays: number | null = null;
      let dehydratorOccupiesFrom: string | null = null;
      let dehydratorOccupiesTo: string | null = null;
      if (
        intermediateMeta?.dehydHours &&
        intermediateMeta.dehydHours > 0 &&
        intermediateMeta.kgPerTray &&
        intermediateMeta.kgPerTray > 0
      ) {
        dehydratorTrays = Math.ceil(thisBatchQty / intermediateMeta.kgPerTray);
        const dehydDays = Math.max(
          1,
          Math.ceil(intermediateMeta.dehydHours / 24),
        );
        const hasSoak = intermediateMeta.processSteps.some(
          (s) => s === 'soak' || s.toLowerCase().includes('soak'),
        );
        const soakOffsetDays = hasSoak ? 1 : 0;
        const fromDate = new Date(run.startDate + 'T00:00:00');
        fromDate.setDate(fromDate.getDate() + soakOffsetDays);
        const toDate = new Date(fromDate);
        toDate.setDate(toDate.getDate() + dehydDays - 1);
        const isoOf = (dd: Date) =>
          `${dd.getFullYear()}-${String(dd.getMonth() + 1).padStart(2, '0')}-${String(dd.getDate()).padStart(2, '0')}`;
        dehydratorOccupiesFrom = isoOf(fromDate);
        dehydratorOccupiesTo = isoOf(toDate);
      }
      const orderInWeek = orderCounterByKey.get(orderKey) ?? 0;
      orderCounterByKey.set(orderKey, orderInWeek + 1);
      const chipStableId = stableIdOf(run.intermediateCode, weekStart, orderInWeek);
      if (!runFirstChipStableId.has(runIdx)) {
        runFirstChipStableId.set(runIdx, chipStableId);
      }
      const ids = runChipStableIds.get(runIdx);
      if (ids) ids.push(chipStableId);
      else runChipStableIds.set(runIdx, [chipStableId]);
      kitchenRequiredActivities.push({
        id: `kitchen-required-${run.intermediateCode}-${run.startDate}-${runIdx}-${batchIdx}`,
        stableId: chipStableId,
        kind: 'kitchen-required',
        date: run.startDate,
        weekStart,
        orderInWeek,
        station: null,
        productCode: run.intermediateCode,
        productName:
          numBatches > 1
            ? `${run.intermediateName} (batch ${batchIdx + 1}/${numBatches})`
            : run.intermediateName,
        quantity: Math.round(thisBatchQty),
        durationMinutes: 0,
        changeoverMinutes: 0,
        durationDays: run.durationDays,
        finishDate: run.finishDate,
        requiredByDate,
        family: run.intermediateCode,
        extendedFamily: null,
        kitchenMinutes: chipKitchenMinutes,
        dehydratorTrays,
        dehydratorOccupiesFrom,
        dehydratorOccupiesTo,
        kitchenRunInfo: {
          overdue: run.overdue,
          idealStartDate: run.idealStartDate,
        },
        redundantWithUnleashed: run.redundantWithUnleashed,
      });
    }
  }

  // ─── Phase 4l.12 — Parked Unleashed kitchen assemblies are movable ───
  // Move Parked Lundberg-warehouse Unleashed assemblies from the
  // committed `kitchenActivities` array into the planner-walkable
  // `kitchenRequiredActivities` array. This lets the kitchen-team
  // walker reschedule them just like cascade-derived runs (the user
  // hasn't committed Parked yet — it's still a draft).
  //
  // They keep `kind: 'kitchen'` so they render as live (cyan) and
  // retain their assemblyNumber / assemblyStatus for drawer + badge.
  // They were already counted in scheduledKitchenSupply when the
  // cascade ran, so no double-supply emission.
  const parkedLundbergIndexes: number[] = [];
  for (let i = 0; i < kitchenActivities.length; i++) {
    if (kitchenActivities[i].assemblyStatus === 'Parked') {
      parkedLundbergIndexes.push(i);
    }
  }
  if (parkedLundbergIndexes.length > 0) {
    // Move (splice from kitchenActivities, push to kitchenRequiredActivities)
    // — iterate in reverse so splice indexes stay valid.
    const moved: CalendarActivity[] = [];
    for (let i = parkedLundbergIndexes.length - 1; i >= 0; i--) {
      const idx = parkedLundbergIndexes[i];
      moved.unshift(kitchenActivities[idx]);
      kitchenActivities.splice(idx, 1);
    }
    for (const chip of moved) {
      kitchenRequiredActivities.push({
        ...chip,
        // Mark as walkable: synthesise a kitchenRunInfo so the walker
        // has an idealStartDate (= the Unleashed-committed date). The
        // walker uses idealStartDate for sort ordering + JIT target.
        kitchenRunInfo: {
          overdue: false,
          idealStartDate: chip.date,
        },
      });
    }
    console.log(
      `[planner] Moved ${moved.length} Parked Lundberg assembly(ies) into the kitchen-team walker (will be repositioned to fit capacity).`,
    );
  }

  // ─── Kitchen-team today-floor walk (Phase 4l.10) ──────────
  // The kitchen-run-planner clamps overdue starts to today, stacking many
  // chips on the first horizon Monday and producing K200%+ spikes. Walk
  // those overdue chips forward through workdays, respecting the daily
  // kitchen-team budget (3 people × 7-hour shift = 1260 min/day), so the
  // load distributes naturally. Only operates on chips marked
  // `kitchenRunInfo.overdue === true`; non-overdue chips keep their
  // planner-chosen dates.
  //
  // NOTE: keep this constant in sync with the `KITCHEN_DAILY_MINUTES`
  // declared in `CalendarApp.tsx`. Two declarations because the server
  // doesn't import client code, but they MUST match or the heatmap will
  // mis-render the walk's distribution.
  const KITCHEN_DAILY_MIN = 1260;
  const KITCHEN_MAX_WALK_DAYS = horizon.weeks * 7 + 14;
  function shiftIsoByDays(iso: string, days: number): string {
    const d = fromLocalISODate(iso);
    d.setDate(d.getDate() + days);
    return toLocalISODate(d);
  }
  function daysBetween(fromIso: string, toIso: string): number {
    const a = fromLocalISODate(fromIso);
    const b = fromLocalISODate(toIso);
    return Math.round((b.getTime() - a.getTime()) / 86_400_000);
  }
  // Pre-seed running kitchen load with non-walkable chips (live Unleashed
  // assemblies + non-overdue required runs).
  const kitchenLoadByDay = new Map<string, number>();
  // Phase 4l.10 — also seed a dehydrator-tray load map. Each chip that
  // has a dehyd window contributes `dehydratorTrays` to every calendar
  // day in [from, to]. Used to enforce the physical 605-tray pool
  // shared across all 3 dehydrators (Mamma / Pappa / Midgy).
  const DEHYDRATOR_TOTAL_TRAYS = capacity.dehydratorCapacity.totalEffectiveTrays;
  const dehydratorLoadByDay = new Map<string, number>();
  function addDehydratorLoad(
    map: Map<string, number>,
    from: string | null | undefined,
    to: string | null | undefined,
    trays: number | null | undefined,
  ): void {
    if (!from || !to || !trays || trays <= 0) return;
    const fromDate = fromLocalISODate(from);
    const toDate = fromLocalISODate(to);
    const cursor = new Date(fromDate);
    while (cursor.getTime() <= toDate.getTime()) {
      const iso = toLocalISODate(cursor);
      map.set(iso, (map.get(iso) ?? 0) + trays);
      cursor.setDate(cursor.getDate() + 1);
    }
  }
  function shiftIsoOrNull(iso: string | null | undefined, days: number): string | null {
    if (!iso) return iso ?? null;
    return shiftIsoByDays(iso, days);
  }
  // Pre-seed only with live Unleashed assemblies — their dates are fixed
  // in Unleashed and we don't move them. ALL kitchen-required chips are
  // walked below (Phase 4l.10), so don't pre-seed them or their load
  // would be double-counted.
  for (const a of kitchenActivities) {
    const mins = a.kitchenMinutes;
    if (mins !== undefined && mins > 0) {
      kitchenLoadByDay.set(a.date, (kitchenLoadByDay.get(a.date) ?? 0) + mins);
    }
    addDehydratorLoad(
      dehydratorLoadByDay,
      a.dehydratorOccupiesFrom,
      a.dehydratorOccupiesTo,
      a.dehydratorTrays,
    );
  }
  // Helper: does the chip's dehyd window starting on `proposedStart` fit
  // alongside existing dehydrator load? Walks the shifted [from, to]
  // window day-by-day, summing trays. Returns true if every day in the
  // window has at least `trays` slack OR the pool itself is zero
  // (= no dehydrator data → constraint disabled).
  function fitsDehydratorWindow(
    chip: CalendarActivity,
    proposedStart: string,
  ): boolean {
    if (DEHYDRATOR_TOTAL_TRAYS <= 0) return true;
    const trays = chip.dehydratorTrays;
    const from = chip.dehydratorOccupiesFrom;
    const to = chip.dehydratorOccupiesTo;
    if (!trays || !from || !to) return true; // non-dehyd chip
    const shift = daysBetween(chip.date, proposedStart);
    const shiftedFrom = shiftIsoByDays(from, shift);
    const shiftedTo = shiftIsoByDays(to, shift);
    const fromDate = fromLocalISODate(shiftedFrom);
    const toDate = fromLocalISODate(shiftedTo);
    const cursor = new Date(fromDate);
    while (cursor.getTime() <= toDate.getTime()) {
      const iso = toLocalISODate(cursor);
      const used = dehydratorLoadByDay.get(iso) ?? 0;
      if (used + trays > DEHYDRATOR_TOTAL_TRAYS) return false;
      cursor.setDate(cursor.getDate() + 1);
    }
    return true;
  }
  // Phase 4l.10 — walk ALL kitchen-required chips (was: only overdue).
  // Reason: splitting kitchen runs into preferred-batch-sized chips
  // means a single intermediate's demand becomes N chips that all
  // initially share the same start date. Without walking ALL of them,
  // they pile up on that date and the dehydrator-trays constraint can
  // never bind. Walking each chip lets the algorithm distribute them
  // across days respecting both the kitchen-team budget (1260 min/day)
  // and the shared dehydrator pool.
  //
  // Each chip's walk starts at its CURRENT date (max(today, planner's
  // start)). Overdue chips have date == today (clamped by the kitchen-
  // run-planner); non-overdue start where the planner placed them. So
  // we don't unnecessarily push non-overdue chips earlier than needed.
  const kitchenOverdueIdxs: number[] = [];
  for (let i = 0; i < kitchenRequiredActivities.length; i++) {
    kitchenOverdueIdxs.push(i); // walk all chips
  }
  kitchenOverdueIdxs.sort((ai, bi) => {
    const a = kitchenRequiredActivities[ai];
    const b = kitchenRequiredActivities[bi];
    // Sort by ideal-start asc so urgent runs claim earlier slots; tiebreak
    // by orderInWeek so batches of the same recipe stay in batch order.
    const aIdeal = a.kitchenRunInfo?.idealStartDate ?? a.date;
    const bIdeal = b.kitchenRunInfo?.idealStartDate ?? b.date;
    if (aIdeal !== bIdeal) return aIdeal.localeCompare(bIdeal);
    if (a.productCode !== b.productCode) {
      return a.productCode.localeCompare(b.productCode);
    }
    return a.orderInWeek - b.orderInWeek;
  });
  for (const idx of kitchenOverdueIdxs) {
    const a = kitchenRequiredActivities[idx];
    const chipMin = a.kitchenMinutes ?? 0;
    // Phase 4l.12 — JUST-IN-TIME scheduling. We prefer to schedule each
    // kitchen-required chip AS LATE AS POSSIBLE (close to its consumer
    // date) rather than as early as possible. Previously the walker did
    // a forward walk from the planner-chosen start date and took the
    // first day with capacity — that piled cascade-derived chips onto
    // today, even when consumers were a week out.
    //
    // New strategy:
    //   1. preferredDate = max(today, a.date) — the just-in-time ideal
    //      from the planner (last workday before consumer's date,
    //      already clamped to today by the upstream today-floor logic).
    //   2. Try preferredDate FIRST. If full, walk BACKWARD one workday
    //      at a time until either a slot fits or we hit today.
    //   3. If no backward slot fits (today through preferred all full),
    //      walk FORWARD from preferredDate as a fallback (chip will be
    //      late for its consumer; conflict detector picks it up).
    //
    // Net effect: chips with future required-by dates land just before
    // consumer; chips clamped to today stay today; chips whose entire
    // back-window is full get pushed forward (= late) only as last
    // resort.
    const preferredDate = a.date < todayLocal ? todayLocal : a.date;
    const preferredWorkday = isWorkday(preferredDate)
      ? preferredDate
      : nextWorkday(preferredDate);
    let placed = false;
    // ─── Backward walk: preferred → today ──────────────────
    let cursor = preferredWorkday;
    for (let step = 0; step < KITCHEN_MAX_WALK_DAYS; step++) {
      if (cursor < todayLocal) break;
      const used = kitchenLoadByDay.get(cursor) ?? 0;
      const teamFits = used + chipMin <= KITCHEN_DAILY_MIN || used === 0;
      const dehydFits = teamFits ? fitsDehydratorWindow(a, cursor) : false;
      if (teamFits && dehydFits) {
        kitchenLoadByDay.set(cursor, used + chipMin);
        const shift = daysBetween(a.date, cursor);
        addDehydratorLoad(
          dehydratorLoadByDay,
          shiftIsoOrNull(a.dehydratorOccupiesFrom, shift),
          shiftIsoOrNull(a.dehydratorOccupiesTo, shift),
          a.dehydratorTrays,
        );
        kitchenRequiredActivities[idx] = {
          ...a,
          date: cursor,
          finishDate: a.finishDate ? shiftIsoByDays(a.finishDate, shift) : a.finishDate,
          requiredByDate: a.requiredByDate
            ? shiftIsoByDays(a.requiredByDate, shift)
            : a.requiredByDate,
          dehydratorOccupiesFrom: shiftIsoOrNull(a.dehydratorOccupiesFrom, shift),
          dehydratorOccupiesTo: shiftIsoOrNull(a.dehydratorOccupiesTo, shift),
        };
        placed = true;
        break;
      }
      // Step backward one workday (skipping weekends).
      const prev = previousWorkday(shiftIsoByDays(cursor, -1));
      if (prev >= cursor) break; // safety: no progress
      cursor = prev;
    }
    // ─── Forward walk fallback: preferred + 1 → … ──────────
    if (!placed) {
      cursor = nextWorkday(addOneDay(preferredWorkday));
      for (let step = 0; step < KITCHEN_MAX_WALK_DAYS; step++) {
        const used = kitchenLoadByDay.get(cursor) ?? 0;
        const teamFits = used + chipMin <= KITCHEN_DAILY_MIN || used === 0;
        const dehydFits = teamFits ? fitsDehydratorWindow(a, cursor) : false;
        if (teamFits && dehydFits) {
          kitchenLoadByDay.set(cursor, used + chipMin);
          const shift = daysBetween(a.date, cursor);
          addDehydratorLoad(
            dehydratorLoadByDay,
            shiftIsoOrNull(a.dehydratorOccupiesFrom, shift),
            shiftIsoOrNull(a.dehydratorOccupiesTo, shift),
            a.dehydratorTrays,
          );
          kitchenRequiredActivities[idx] = {
            ...a,
            date: cursor,
            finishDate: a.finishDate ? shiftIsoByDays(a.finishDate, shift) : a.finishDate,
            requiredByDate: a.requiredByDate
              ? shiftIsoByDays(a.requiredByDate, shift)
              : a.requiredByDate,
            dehydratorOccupiesFrom: shiftIsoOrNull(a.dehydratorOccupiesFrom, shift),
            dehydratorOccupiesTo: shiftIsoOrNull(a.dehydratorOccupiesTo, shift),
          };
          placed = true;
          break;
        }
        cursor = nextWorkday(addOneDay(cursor));
      }
    }
    if (!placed) {
      // Fallback: prefer a day that genuinely fits both team-min AND
      // dehydrator-tray budgets even if it's far in the future. Only
      // if NO day fits do we fall back to least-loaded (which can
      // overflow). This keeps capacity badges accurate — if it shows
      // 229%, the chip really had nowhere else to go.
      //
      // Phase 4l.12: previously the fallback scored every day by combined
      // load and picked the least-loaded — but that would happily pile a
      // chip onto an already-200% day if every other day was 220%.
      const dehydScale =
        DEHYDRATOR_TOTAL_TRAYS > 0 ? KITCHEN_DAILY_MIN / DEHYDRATOR_TOTAL_TRAYS : 0;
      // FALLBACK PASS 1: find the EARLIEST day that fits both budgets,
      // extending the walk to twice the normal window.
      let bestDay: string | null = null;
      const extendedWalk = KITCHEN_MAX_WALK_DAYS * 2;
      let walkCursor = nextWorkday(todayLocal);
      for (let step = 0; step < extendedWalk; step++) {
        const used = kitchenLoadByDay.get(walkCursor) ?? 0;
        const teamFits = used + chipMin <= KITCHEN_DAILY_MIN || used === 0;
        const dehydFits = teamFits ? fitsDehydratorWindow(a, walkCursor) : false;
        if (teamFits && dehydFits) {
          bestDay = walkCursor;
          break;
        }
        walkCursor = nextWorkday(addOneDay(walkCursor));
      }
      // FALLBACK PASS 2: if NO day in the extended window fits, pick the
      // least-loaded (existing behaviour). This may overflow; the
      // heatmap will show it and the user can intervene.
      if (bestDay === null) {
        bestDay = nextWorkday(todayLocal);
        let bestScore = Number.POSITIVE_INFINITY;
        walkCursor = bestDay;
        for (let step = 0; step < KITCHEN_MAX_WALK_DAYS; step++) {
          const teamUsed = kitchenLoadByDay.get(walkCursor) ?? 0;
          const dehydUsed = dehydratorLoadByDay.get(walkCursor) ?? 0;
          const score = teamUsed + dehydUsed * dehydScale;
          if (score < bestScore) {
            bestScore = score;
            bestDay = walkCursor;
          }
          walkCursor = nextWorkday(addOneDay(walkCursor));
        }
      }
      kitchenLoadByDay.set(bestDay, (kitchenLoadByDay.get(bestDay) ?? 0) + chipMin);
      const shift = daysBetween(a.date, bestDay);
      addDehydratorLoad(
        dehydratorLoadByDay,
        shiftIsoOrNull(a.dehydratorOccupiesFrom, shift),
        shiftIsoOrNull(a.dehydratorOccupiesTo, shift),
        a.dehydratorTrays,
      );
      kitchenRequiredActivities[idx] = {
        ...a,
        date: bestDay,
        finishDate: a.finishDate ? shiftIsoByDays(a.finishDate, shift) : a.finishDate,
        requiredByDate: a.requiredByDate
          ? shiftIsoByDays(a.requiredByDate, shift)
          : a.requiredByDate,
        dehydratorOccupiesFrom: shiftIsoOrNull(a.dehydratorOccupiesFrom, shift),
        dehydratorOccupiesTo: shiftIsoOrNull(a.dehydratorOccupiesTo, shift),
      };
      console.warn(
        `[planner] Overdue kitchen run ${a.productCode} (${chipMin} min, ${a.dehydratorTrays ?? 0} trays) couldn't fit within ${KITCHEN_MAX_WALK_DAYS} days; placed on least-loaded day ${bestDay} — kitchen and/or dehydrator demand exceeds horizon capacity.`,
      );
    }
  }

  // ─── Phase 4l.12 — defensive today-floor clamp ─────────────
  // Belt-and-braces: scan all kitchen-required chips after the walk and
  // hard-clamp any whose date is still < todayLocal. The walk above
  // SHOULD have moved them; this catches edge cases (corrupted input
  // dates, walk-bypass paths, timezone surprises). Each clamped chip is
  // logged so we can find the root cause if it ever fires.
  const todayClampWorkday = isWorkday(todayLocal)
    ? todayLocal
    : nextWorkday(todayLocal);
  let clampedCount = 0;
  for (let i = 0; i < kitchenRequiredActivities.length; i++) {
    const a = kitchenRequiredActivities[i];
    if (a.date < todayLocal) {
      const shift = daysBetween(a.date, todayClampWorkday);
      // Reverse out this chip's contribution to load maps under its OLD
      // date so the new date's heatmap is accurate (best-effort: we
      // don't know which days the chip was previously counted on for
      // dehydrator, so we just recompute as if it lands on the clamped
      // day with no prior counting).
      const chipMin = a.kitchenMinutes ?? 0;
      if (chipMin > 0) {
        const oldUsed = kitchenLoadByDay.get(a.date) ?? 0;
        kitchenLoadByDay.set(a.date, Math.max(0, oldUsed - chipMin));
        kitchenLoadByDay.set(
          todayClampWorkday,
          (kitchenLoadByDay.get(todayClampWorkday) ?? 0) + chipMin,
        );
      }
      kitchenRequiredActivities[i] = {
        ...a,
        date: todayClampWorkday,
        finishDate: a.finishDate ? shiftIsoByDays(a.finishDate, shift) : a.finishDate,
        requiredByDate: a.requiredByDate
          ? shiftIsoByDays(a.requiredByDate, shift)
          : a.requiredByDate,
        dehydratorOccupiesFrom: shiftIsoOrNull(a.dehydratorOccupiesFrom, shift),
        dehydratorOccupiesTo: shiftIsoOrNull(a.dehydratorOccupiesTo, shift),
      };
      clampedCount += 1;
    }
  }
  if (clampedCount > 0) {
    console.warn(
      `[planner] Defensive today-floor: clamped ${clampedCount} kitchen-required chip(s) from past dates to ${todayClampWorkday}. Walk should have caught these — investigate if this recurs.`,
    );
  }

  // ─── Phase 4l.12 — past-dated live-kitchen assembly diagnostic ───
  // Live Unleashed kitchen assemblies are NOT walked (their dates are
  // committed in Unleashed). If any are dated before today they're
  // probably stale — either already produced and not closed out, or a
  // genuinely overdue assembly. Report them so the user can review.
  const stalePastKitchen = kitchenActivities.filter((a) => a.date < todayLocal);
  if (stalePastKitchen.length > 0) {
    console.warn(
      `[planner] ${stalePastKitchen.length} live kitchen assembly(ies) scheduled before today (${todayLocal}):`,
      stalePastKitchen.slice(0, 10).map((a) => `${a.productCode}@${a.date}`).join(', '),
    );
  }
  console.log(
    `[planner] todayLocal=${todayLocal}, kitchen-required count=${kitchenRequiredActivities.length}, live kitchen count=${kitchenActivities.length}`,
  );

  // ─── Packaging today-floor with capacity walk (Phase 4l.10) ──
  // Overdue packaging chips (date < today) get pushed forward to the first
  // workday where the chip's station has minutes available. This replaces
  // the prior "stamp every overdue chip onto today" behaviour which made
  // today columns hit 1000%+ utilisation when planFromDate landed mid-week
  // or when allowlist-driven SKUs piled up.
  //
  // Algorithm
  // ─────────
  // 1. Pre-seed a running per-station per-day minutes ledger with all
  //    non-overdue packaging chips (planner output, overflow-recovery,
  //    manual). These hold their dates; their load is fixed.
  // 2. Sort overdue chips by profit-per-minute descending (highest-value
  //    chips claim the earliest slots first), with originalDate ascending
  //    as the tiebreaker so equally-profitable older overdues land first.
  //    Missing-profit SKUs rank last (= placed last, get the later slots).
  // 3. For each overdue chip:
  //    a. Compute `earliest` = max(today, intermediate finish + 1 buffer
  //       day). Same intermediate-aware logic as before.
  //    b. Walk forward workday-by-workday from `earliest`. If the station
  //       has room (`load + chipMin ≤ capacity`), place there; otherwise
  //       advance. Cap the walk at HORIZON_DAYS so we don't search
  //       unboundedly past the planning horizon.
  //    c. If no day fits within the cap, fall back to placing on the
  //       earliest workday with overrun reported via the heatmap. The
  //       packagingInfo.overdue flag still surfaces the displacement.
  // Phase 4l.12 — switched from LATEST → EARLIEST finish per intermediate.
  // With split-and-redate, an intermediate can have multiple kitchen
  // batches across the horizon (one per consumer week). The walker only
  // needs the EARLIEST finish to know "can my chip be served by any
  // batch?". Using the LATEST finish bumped every consumer forward to
  // the last batch's finish — even a manual chip dropped today would
  // be walked weeks ahead just because some unrelated later consumer
  // had a batch finishing in mid-June. FIFO sorts out the actual
  // batch→consumer allocation in a later pass; optimistic placement
  // here is correct.
  const earliestIntermediateFinishByCode = new Map<string, string>();
  for (const k of kitchenRequiredActivities) {
    const finish = k.finishDate ?? k.date;
    const existing = earliestIntermediateFinishByCode.get(k.productCode);
    if (!existing || finish < existing) {
      earliestIntermediateFinishByCode.set(k.productCode, finish);
    }
  }
  function dayAfter(iso: string): string {
    const d = fromLocalISODate(iso);
    d.setDate(d.getDate() + 1);
    return toLocalISODate(d);
  }
  function addOneDay(iso: string): string {
    const d = fromLocalISODate(iso);
    d.setDate(d.getDate() + 1);
    return toLocalISODate(d);
  }
  const STATION_CAP_MIN: Record<Station, number> = {
    'hand-packing':
      (capacity.stations['hand-packing']?.hoursPerDay ?? 8) * 60,
    elephant: (capacity.stations.elephant?.hoursPerDay ?? 8) * 60,
    dust: (capacity.stations.dust?.hoursPerDay ?? 8) * 60,
    bottlo: (capacity.stations.bottlo?.hoursPerDay ?? 8) * 60,
  };
  // Per-station per-day used minutes. Seeded with non-overdue chips so
  // the walk respects pre-existing load.
  const runningLoad: Record<Station, Map<string, number>> = {
    'hand-packing': new Map(),
    elephant: new Map(),
    dust: new Map(),
    bottlo: new Map(),
  };
  // Helper: do ALL of this chip's required intermediates have NO batch
  // finishing before its date? Uses the EARLIEST finish per intermediate —
  // a chip is only buffer-violated when even the earliest batch hasn't
  // finished by then. If at least one batch finishes in time, the chip
  // can run (FIFO will allocate the right batch downstream).
  function bufferViolated(a: CalendarActivity): boolean {
    for (const ing of consumesMap[a.productCode] ?? []) {
      const finish = earliestIntermediateFinishByCode.get(ing);
      if (!finish) continue;
      const earliestStart = dayAfter(finish);
      if (a.date < earliestStart) return true;
    }
    return false;
  }
  for (const a of projection.activities) {
    if (a.kind !== 'packaging' || !a.station) continue;
    // Skip chips that the walk will (re)place: anything date < today, or
    // anything already marked overdue by an earlier pass (e.g. week-
    // overflow recovery chips), or buffer-violated by a later-finishing
    // intermediate. These don't pre-load the day; their contribution is
    // added when the walk places them.
    if (a.date < todayLocal) continue;
    if (a.packagingInfo?.overdue) continue;
    if (bufferViolated(a)) continue;
    const m = runningLoad[a.station];
    const total = (a.durationMinutes ?? 0) + (a.changeoverMinutes ?? 0);
    m.set(a.date, (m.get(a.date) ?? 0) + total);
  }
  // Partition walk-eligible chips out, then sort by profit-per-minute desc.
  // Walk includes (a) chips before today, (b) chips already flagged overdue
  // by upstream (week-overflow recovery), and (c) chips whose required
  // intermediate hasn't finished by their scheduled date — without (c)
  // packaging-before-kitchen happens whenever a kitchen run was overdue.
  const overdueIdxs: number[] = [];
  for (let i = 0; i < projection.activities.length; i++) {
    const a = projection.activities[i];
    if (a.kind !== 'packaging' || !a.station) continue;
    const isOverdue =
      a.date < todayLocal ||
      a.packagingInfo?.overdue === true ||
      bufferViolated(a);
    if (isOverdue) overdueIdxs.push(i);
  }
  overdueIdxs.sort((ai, bi) => {
    const a = projection.activities[ai];
    const b = projection.activities[bi];
    const minsA = Math.max(1, (a.durationMinutes ?? 0) + (a.changeoverMinutes ?? 0));
    const minsB = Math.max(1, (b.durationMinutes ?? 0) + (b.changeoverMinutes ?? 0));
    const ppmA = ((a.profitPerItem ?? 0) * a.quantity) / minsA;
    const ppmB = ((b.profitPerItem ?? 0) * b.quantity) / minsB;
    if (ppmA !== ppmB) return ppmB - ppmA; // higher profit/min first
    return a.date.localeCompare(b.date); // older overdue first
  });
  const MAX_WALK_DAYS = horizon.weeks * 7 + 14; // a bit past the horizon
  const clampedActivities = projection.activities.slice();
  for (const idx of overdueIdxs) {
    const a = clampedActivities[idx];
    const station = a.station as Station;
    // Earliest = today, bumped past the EARLIEST intermediate finish + 1d.
    // (Not the latest — one early batch is enough to feed this chip;
    // FIFO decides which batch supplies which consumer downstream.)
    let earliest = todayLocal;
    for (const ing of consumesMap[a.productCode] ?? []) {
      const finish = earliestIntermediateFinishByCode.get(ing);
      if (!finish) continue;
      const after = dayAfter(finish);
      if (after > earliest) earliest = after;
    }
    earliest = nextWorkday(earliest);
    const chipMin = (a.durationMinutes ?? 0) + (a.changeoverMinutes ?? 0);
    const cap = STATION_CAP_MIN[station];
    let cursor = earliest;
    let placed = false;
    for (let step = 0; step < MAX_WALK_DAYS; step++) {
      const used = runningLoad[station].get(cursor) ?? 0;
      if (used + chipMin <= cap || used === 0) {
        // Fits, OR the day is empty and the chip is oversized (still better
        // than dumping it on a day that already has load).
        runningLoad[station].set(cursor, used + chipMin);
        clampedActivities[idx] = {
          ...a,
          date: cursor,
          packagingInfo: { overdue: true, originalDate: a.date },
        };
        placed = true;
        break;
      }
      cursor = nextWorkday(addOneDay(cursor));
    }
    if (!placed) {
      // Walk fell off horizon — total demand exceeds horizon capacity for
      // this station. Rather than dumping every such chip on `earliest`
      // (today), which stacks an obvious 900%+ load spike on a single
      // column, place the chip on the LEAST-LOADED day within the search
      // window. Spreads the overrun proportionally — every day above
      // capacity still reads as overcapacity, but the spike is shared
      // instead of concentrated. The user can still see the overload
      // pattern; it's just more honest about distribution.
      let bestDay = earliest;
      let bestUsed = runningLoad[station].get(bestDay) ?? 0;
      let walkCursor = earliest;
      for (let step = 0; step < MAX_WALK_DAYS; step++) {
        const used = runningLoad[station].get(walkCursor) ?? 0;
        if (used < bestUsed) {
          bestUsed = used;
          bestDay = walkCursor;
        }
        walkCursor = nextWorkday(addOneDay(walkCursor));
      }
      runningLoad[station].set(bestDay, bestUsed + chipMin);
      clampedActivities[idx] = {
        ...a,
        date: bestDay,
        packagingInfo: { overdue: true, originalDate: a.date },
      };
      console.warn(
        `[planner] Overdue chip ${a.productCode} (${chipMin.toFixed(0)} min, ${station}) couldn't fit within ${MAX_WALK_DAYS} days; placed on least-loaded day ${bestDay} (existing load ${bestUsed.toFixed(0)} min) — overrun is real, total horizon demand exceeds capacity.`,
      );
    }
  }
  const packagingActivitiesClamped = clampedActivities;

  // ─── Phase 4l.12 — Post-FIFO batch SPLIT-AND-REDATE (Option 2+) ──
  // The pass walks every kitchen-required chip, looks up its real FIFO
  // allocations, and:
  //
  //   1. SPLITS the chip into shards whose qty matches each consumer
  //      cluster's actual demand (one shard per consumer-week). This
  //      breaks up the "one big batch dated to first consumer" pattern
  //      where downstream consumers in week +3 were carried from
  //      inventory rather than produced just-in-time.
  //
  //   2. REDATES each shard to land just before its consumer cluster's
  //      earliest required date (FIFO buffer = 1 workday lead in).
  //
  // Shards inherit the parent chip's identity (productCode, family,
  // intermediateMeta, etc.) and get a fresh per-shard stableId so the
  // calendar's chipRefs map can address each one. Kitchen-team minutes
  // + dehydrator trays are recomputed per-shard from the smaller qty.
  //
  // Constraint: a shard never lands EARLIER than where the kitchen-run
  // walker placed the parent chip (the walker already today-clamped
  // and respected kitchen-team capacity). If FIFO says "consume on day
  // X" but X < walker.startDate, that shard collapses back to
  // walker.startDate (still better than the original "all-aggregated"
  // date, since later shards in the same chip still get spread out).
  //
  // Splits only fire when meaningful — single-consumer chips and
  // chips whose post-split shards would all collapse to the same
  // week stay as one chip.
  {
    // Build a local consumesQtyMap (parent → ingredient → qty/unit) for
    // the FIFO. Same shape the supply-cap pass uses; cheaper to rebuild
    // here than to thread through.
    const redateConsumesQtyMap: Record<string, Record<string, number>> = {};
    for (const row of capacity.bom) {
      let inner = redateConsumesQtyMap[row.parentProductCode];
      if (!inner) {
        inner = {};
        redateConsumesQtyMap[row.parentProductCode] = inner;
      }
      inner[row.productCode] =
        (inner[row.productCode] ?? 0) + row.quantityPerParent;
    }
    // Supplier output override: kitchen-required chip's `quantity` is
    // INPUT kg; FIFO needs OUTPUT kg (= input × yield).
    const redateSupplyQty: Record<string, number> = {};
    for (const a of kitchenRequiredActivities) {
      const y =
        capacity.intermediates.get(a.productCode)?.yieldRate ?? 1;
      const eff = y > 0 && y <= 1 ? y : 1;
      redateSupplyQty[a.stableId] = a.quantity * eff;
    }
    // Live Unleashed kitchen assemblies supply their stated quantity
    // (already output kg).
    for (const a of kitchenActivities) {
      redateSupplyQty[a.stableId] = a.quantity;
    }
    // Run FIFO. We pass packaging chips as consumers, plus kitchen
    // chips (which can be both consumer of sub-intermediates and
    // supplier of intermediates).
    const fifoResult = allocateSupplyFifo({
      activities: [
        ...packagingActivitiesClamped,
        ...kitchenActivities,
        ...kitchenRequiredActivities,
      ].map((a) => ({
        stableId: a.stableId,
        productCode: a.productCode,
        kind: a.kind,
        date: a.date,
        finishDate: a.finishDate ?? null,
        quantity: a.quantity,
        profitPerItem: a.profitPerItem ?? null,
      })),
      excludedStableIds: dismissedStableIds,
      isConsumer: (a) =>
        a.kind === 'packaging' ||
        a.kind === 'kitchen-required' ||
        a.kind === 'kitchen',
      isSupplier: (a) => a.kind !== 'po-placed',
      consumesMap,
      consumesQtyMap: redateConsumesQtyMap,
      initialSohByCode: lundbergSohByCode,
      supplyQtyByActivity: redateSupplyQty,
    });
    // Map each supplier (kitchen-required chip) → list of allocated
    // consumer dates. Only REAL allocations drive redating; phantoms
    // don't represent actual demand commitments.
    // Per-chip allocations keyed by consumer-week (Monday ISO). The
    // weekly bucket size is a compromise: tighter than per-consumer
    // (avoids minute fragments) and looser than full-chip aggregation
    // (avoids dating the whole batch to its first consumer).
    function mondayOf(iso: string): string {
      const d = fromLocalISODate(iso);
      const dow = d.getDay();
      const mondayOffset = dow === 0 ? -6 : 1 - dow;
      d.setDate(d.getDate() + mondayOffset);
      return toLocalISODate(d);
    }
    type Bucket = { earliestConsumerDate: string; outputQty: number };
    // supplierStableId → consumerWeekMonday → bucket (qty + earliest)
    const bucketsBySupplier = new Map<string, Map<string, Bucket>>();
    const allById = new Map<string, CalendarActivity>();
    for (const a of packagingActivitiesClamped) allById.set(a.stableId, a);
    for (const a of kitchenActivities) allById.set(a.stableId, a);
    for (const a of kitchenRequiredActivities) allById.set(a.stableId, a);
    for (const alloc of fifoResult.allocations) {
      if (alloc.phantom) continue;
      const supplier = allById.get(alloc.supplierStableId);
      if (!supplier || supplier.kind !== 'kitchen-required') continue;
      const consumer = allById.get(alloc.consumerStableId);
      if (!consumer) continue;
      const wk = mondayOf(consumer.date);
      let weekMap = bucketsBySupplier.get(alloc.supplierStableId);
      if (!weekMap) {
        weekMap = new Map();
        bucketsBySupplier.set(alloc.supplierStableId, weekMap);
      }
      const existing = weekMap.get(wk);
      if (!existing) {
        weekMap.set(wk, {
          earliestConsumerDate: consumer.date,
          outputQty: alloc.quantity,
        });
      } else {
        existing.outputQty += alloc.quantity;
        if (consumer.date < existing.earliestConsumerDate) {
          existing.earliestConsumerDate = consumer.date;
        }
      }
    }

    // Apply split-and-redate. Each shard:
    //   • inputQty = ceil(bucketOutputQty / yieldRate)
    //   • date     = earliestConsumer − buffer − (prodDays − 1)
    //               clamped to ≥ walker.startDate (chip.date today-floored)
    //   • stableId = fresh per-shard so calendar arrows resolve uniquely
    //
    // Single-bucket suppliers fall through to the simple redate path
    // (preserving the original stableId so user mutations on the chip
    // survive). Multi-bucket suppliers get replaced wholesale: shard 0
    // inherits the original stableId, shards 1..N get fresh ones.
    const shardOrderByKey = new Map<string, number>();
    function nextOrder(productCode: string, weekStart: string): number {
      const k = `${productCode}|${weekStart}`;
      const n = shardOrderByKey.get(k) ?? 0;
      shardOrderByKey.set(k, n + 1);
      return n;
    }
    // Seed the shard counter from existing batches so we don't collide
    // with stableIds the kitchen-run planner already minted in
    // `orderCounterByKey`.
    for (const [k, v] of orderCounterByKey.entries()) shardOrderByKey.set(k, v);

    const splitChips: CalendarActivity[] = [];
    let splitCount = 0;
    let shardedFromCount = 0;
    let movedCount = 0;
    let cumulativeShiftDays = 0;
    let droppedNoConsumerCount = 0;
    const droppedSummaries: string[] = [];

    for (const chip of kitchenRequiredActivities) {
      const weekMap = bucketsBySupplier.get(chip.stableId);
      // No FIFO allocations = nothing downstream actually needs this
      // chip's output (SOH + Unleashed assemblies + earlier-finishing
      // batches together cover every real consumer). Don't emit it —
      // a kitchen-required chip with no consumer is just clutter,
      // confuses the operator ("why is this run scheduled?"), and
      // misleads the kitchen-team / dehydrator load badges.
      //
      // Subtract its load contributions so the day's badges reflect
      // reality after the drop. The cascade originally added these
      // minutes / trays based on the demand it computed before SOH +
      // assemblies were folded in via the FIFO; we're catching the
      // over-production here.
      if (!weekMap || weekMap.size === 0) {
        const chipMinDrop = chip.kitchenMinutes ?? 0;
        if (chipMinDrop > 0) {
          kitchenLoadByDay.set(
            chip.date,
            Math.max(0, (kitchenLoadByDay.get(chip.date) ?? 0) - chipMinDrop),
          );
        }
        if (chip.dehydratorTrays && chip.dehydratorOccupiesFrom && chip.dehydratorOccupiesTo) {
          const oldFrom = fromLocalISODate(chip.dehydratorOccupiesFrom);
          const oldTo = fromLocalISODate(chip.dehydratorOccupiesTo);
          for (let d = new Date(oldFrom); d.getTime() <= oldTo.getTime(); d.setDate(d.getDate() + 1)) {
            const iso = toLocalISODate(d);
            const cur = dehydratorLoadByDay.get(iso) ?? 0;
            dehydratorLoadByDay.set(iso, Math.max(0, cur - chip.dehydratorTrays));
          }
        }
        droppedNoConsumerCount += 1;
        if (droppedSummaries.length < 8) {
          droppedSummaries.push(`${chip.productCode}@${chip.date} q${chip.quantity}`);
        }
        continue;
      }
      // Buckets sorted by earliest-consumer-date.
      const buckets = Array.from(weekMap.values()).sort((a, b) =>
        a.earliestConsumerDate.localeCompare(b.earliestConsumerDate),
      );
      const yieldRate =
        capacity.intermediates.get(chip.productCode)?.yieldRate ?? 1;
      const eff = yieldRate > 0 && yieldRate <= 1 ? yieldRate : 1;
      const bufferDays = 1;
      const productionDays = chip.durationDays ?? 1;
      const intermediateMeta = capacity.intermediates.get(chip.productCode);

      // Subtract the original chip's load from the calendar — we'll add
      // each shard's load back below.
      const originalKitchenMin = chip.kitchenMinutes ?? 0;
      if (originalKitchenMin > 0) {
        kitchenLoadByDay.set(
          chip.date,
          Math.max(0, (kitchenLoadByDay.get(chip.date) ?? 0) - originalKitchenMin),
        );
      }
      if (chip.dehydratorTrays && chip.dehydratorOccupiesFrom && chip.dehydratorOccupiesTo) {
        const oldFrom = fromLocalISODate(chip.dehydratorOccupiesFrom);
        const oldTo = fromLocalISODate(chip.dehydratorOccupiesTo);
        for (let d = new Date(oldFrom); d.getTime() <= oldTo.getTime(); d.setDate(d.getDate() + 1)) {
          const iso = toLocalISODate(d);
          const cur = dehydratorLoadByDay.get(iso) ?? 0;
          dehydratorLoadByDay.set(iso, Math.max(0, cur - chip.dehydratorTrays));
        }
      }

      const shardCountForChip = buckets.length;
      // Phase 4l.12 — distribute the ORIGINAL chip's input across shards
      // in proportion to each bucket's output demand. Earlier code did
      // `ceil(bucketOutputQty / yield)` per shard, which added rounding
      // surplus to every shard (sum of shard outputs > original output).
      // Downstream client FIFO then used the earlier shards' surplus to
      // serve later buckets, leaving the last shard with 0 allocations
      // ("0 CONSUMERS" in the drawer). Preserving total input matches
      // the original chip's output exactly; last shard absorbs any
      // rounding residual.
      const originalInputQty = chip.quantity;
      const totalBucketOutput = buckets.reduce((s, x) => s + x.outputQty, 0);
      const inputByShard: number[] = [];
      let assignedInput = 0;
      for (let i = 0; i < buckets.length; i++) {
        if (i === buckets.length - 1) {
          inputByShard.push(Math.max(1, originalInputQty - assignedInput));
        } else {
          const share =
            totalBucketOutput > 0
              ? buckets[i].outputQty / totalBucketOutput
              : 1 / buckets.length;
          const inp = Math.max(1, Math.round(originalInputQty * share));
          inputByShard.push(inp);
          assignedInput += inp;
        }
      }
      for (let s = 0; s < buckets.length; s++) {
        const b = buckets[s];
        // Compute target start date for this shard.
        let newFinish = shiftIsoByDays(b.earliestConsumerDate, -bufferDays);
        if (!isWorkday(newFinish)) newFinish = previousWorkday(newFinish);
        let newStart = shiftIsoByDays(newFinish, -(productionDays - 1));
        if (!isWorkday(newStart)) newStart = previousWorkday(newStart);
        // Never EARLIER than where the walker placed the parent
        // (capacity-respecting today-floor). Shards that want to land
        // before that collapse back to the walker date — still better
        // than the original aggregate behaviour because LATER shards
        // get their own dates.
        if (newStart < chip.date) newStart = chip.date;

        const inputQty = inputByShard[s];
        const kitchenMinutes = intermediateMeta
          ? kitchenTeamMinutesFor(intermediateMeta, inputQty)
          : KITCHEN_DEFAULT_MINUTES;

        // Per-shard dehydrator occupancy (same shape as parent, just
        // scaled by qty + anchored on newStart).
        let dehydratorTrays: number | null = null;
        let dehydratorOccupiesFrom: string | null = null;
        let dehydratorOccupiesTo: string | null = null;
        if (
          intermediateMeta?.dehydHours &&
          intermediateMeta.dehydHours > 0 &&
          intermediateMeta.kgPerTray &&
          intermediateMeta.kgPerTray > 0
        ) {
          dehydratorTrays = Math.ceil(inputQty / intermediateMeta.kgPerTray);
          const dehydDays = Math.max(1, Math.ceil(intermediateMeta.dehydHours / 24));
          const hasSoak = intermediateMeta.processSteps.some(
            (st) => st === 'soak' || st.toLowerCase().includes('soak'),
          );
          const soakOffsetDays = hasSoak ? 1 : 0;
          const fromDate = new Date(newStart + 'T00:00:00');
          fromDate.setDate(fromDate.getDate() + soakOffsetDays);
          const toDate = new Date(fromDate);
          toDate.setDate(toDate.getDate() + dehydDays - 1);
          dehydratorOccupiesFrom = toLocalISODate(fromDate);
          dehydratorOccupiesTo = toLocalISODate(toDate);
        }

        // Weekly anchor for the new stableId.
        const shardWeekStart = mondayOf(newStart);
        const shardStableId =
          s === 0 && shardCountForChip > 1
            ? chip.stableId // shard 0 keeps the original id so server-known mutations survive
            : s === 0
              ? chip.stableId
              : stableIdOf(
                  chip.productCode,
                  shardWeekStart,
                  nextOrder(chip.productCode, shardWeekStart),
                );

        // Calendar load: add each shard's contribution to the (now-zeroed)
        // load maps.
        if (kitchenMinutes > 0) {
          kitchenLoadByDay.set(
            newStart,
            (kitchenLoadByDay.get(newStart) ?? 0) + kitchenMinutes,
          );
        }
        if (dehydratorTrays && dehydratorOccupiesFrom && dehydratorOccupiesTo) {
          addDehydratorLoad(
            dehydratorLoadByDay,
            dehydratorOccupiesFrom,
            dehydratorOccupiesTo,
            dehydratorTrays,
          );
        }

        const baseName = intermediateMeta?.productName ?? chip.productName;
        const productNameForShard =
          shardCountForChip > 1
            ? `${baseName} (shard ${s + 1}/${shardCountForChip})`
            : chip.productName;

        // requiredByDate moves with the shard so the drawer reads correctly.
        const finishDateShifted = newFinish;
        const requiredByDateShifted = b.earliestConsumerDate;

        splitChips.push({
          ...chip,
          id: `kitchen-required-${chip.productCode}-${newStart}-${shardStableId}`,
          stableId: shardStableId,
          date: newStart,
          finishDate: finishDateShifted,
          requiredByDate: requiredByDateShifted,
          quantity: inputQty,
          productName: productNameForShard,
          kitchenMinutes,
          dehydratorTrays,
          dehydratorOccupiesFrom,
          dehydratorOccupiesTo,
        });

        if (newStart !== chip.date) {
          movedCount += 1;
          cumulativeShiftDays += daysBetween(chip.date, newStart);
        }
        // Per-shard placement diagnostic — emitted only for split chips
        // (single-shard chips already keep their walker date by design).
      }
      if (shardCountForChip > 1) {
        splitCount += shardCountForChip;
        shardedFromCount += 1;
      }
    }
    // Replace the original list contents with the (potentially split)
    // shards. Mutating in place so all the downstream references to
    // kitchenRequiredActivities pick up the new shape automatically.
    kitchenRequiredActivities.length = 0;
    kitchenRequiredActivities.push(...splitChips);

    // ─── Phase 4l.12 — Iterative redating pass ─────────────────
    // The bucket-based split-and-redate above is computed off the FIRST
    // FIFO (run on the ORIGINAL unsplit chips). Once chips are split,
    // a second FIFO might allocate consumers differently because each
    // shard is now an individual supplier — earlier-finishing shards
    // get drained by chronologically-earlier consumers, leaving later
    // shards to feed later consumers.
    //
    // Concrete failure mode this fixes: IABL chip dated 28/05 showing
    // IMT@26/06 + IMK@01/07 as its consumers (drawer reflects client
    // FIFO). The server bucket put both consumers in the early bucket;
    // client FIFO reassigned them to the later shard. Without this
    // pass the shard stays on 28/05 (server bucket date) instead of
    // moving to ~25/06 just-in-time for IMT.
    //
    // Approach: re-FIFO over the now-split shards, then for each chip,
    // find its earliest REAL (non-phantom) allocated consumer. If that
    // consumer is significantly later than the chip's current date,
    // shift the chip forward to land 1 workday before it. Bounded by
    // an iteration cap to prevent runaway oscillation.
    const MAX_REDATE_ITERATIONS = 3;
    const REDATE_TOLERANCE_DAYS = 3; // ignore tiny shifts to keep stable
    let iteration = 0;
    let secondPassMoved = 0;
    let secondPassShiftDays = 0;
    while (iteration < MAX_REDATE_ITERATIONS) {
      iteration += 1;
      const fifo2 = allocateSupplyFifo({
        activities: [
          ...packagingActivitiesClamped,
          ...kitchenActivities,
          ...kitchenRequiredActivities,
        ].map((a) => ({
          stableId: a.stableId,
          productCode: a.productCode,
          kind: a.kind,
          date: a.date,
          finishDate: a.finishDate ?? null,
          quantity: a.quantity,
          profitPerItem: a.profitPerItem ?? null,
        })),
        excludedStableIds: dismissedStableIds,
        isConsumer: (a) =>
          a.kind === 'packaging' ||
          a.kind === 'kitchen-required' ||
          a.kind === 'kitchen',
        isSupplier: (a) => a.kind !== 'po-placed',
        consumesMap,
        consumesQtyMap: redateConsumesQtyMap,
        initialSohByCode: lundbergSohByCode,
        supplyQtyByActivity: (() => {
          const m: Record<string, number> = {};
          for (const a of kitchenRequiredActivities) {
            const y = capacity.intermediates.get(a.productCode)?.yieldRate ?? 1;
            const eff = y > 0 && y <= 1 ? y : 1;
            m[a.stableId] = a.quantity * eff;
          }
          for (const a of kitchenActivities) m[a.stableId] = a.quantity;
          return m;
        })(),
      });
      // Earliest REAL consumer date per supplier stableId.
      const earliestRealConsumerBySupplier = new Map<string, string>();
      const allById2 = new Map<string, CalendarActivity>();
      for (const a of packagingActivitiesClamped) allById2.set(a.stableId, a);
      for (const a of kitchenActivities) allById2.set(a.stableId, a);
      for (const a of kitchenRequiredActivities) allById2.set(a.stableId, a);
      for (const alloc of fifo2.allocations) {
        if (alloc.phantom) continue;
        const supplier = allById2.get(alloc.supplierStableId);
        if (!supplier || supplier.kind !== 'kitchen-required') continue;
        const consumer = allById2.get(alloc.consumerStableId);
        if (!consumer) continue;
        const cur = earliestRealConsumerBySupplier.get(alloc.supplierStableId);
        if (!cur || consumer.date < cur) {
          earliestRealConsumerBySupplier.set(alloc.supplierStableId, consumer.date);
        }
      }
      // Apply shifts.
      let anyMovedThisIter = 0;
      for (let i = 0; i < kitchenRequiredActivities.length; i++) {
        const chip = kitchenRequiredActivities[i];
        const earliestConsumer = earliestRealConsumerBySupplier.get(chip.stableId);
        if (!earliestConsumer) continue;
        const productionDays = chip.durationDays ?? 1;
        let newFinish = shiftIsoByDays(earliestConsumer, -1);
        if (!isWorkday(newFinish)) newFinish = previousWorkday(newFinish);
        let newStart = shiftIsoByDays(newFinish, -(productionDays - 1));
        if (!isWorkday(newStart)) newStart = previousWorkday(newStart);
        if (newStart <= chip.date) continue; // never earlier
        const shift = daysBetween(chip.date, newStart);
        if (shift < REDATE_TOLERANCE_DAYS) continue;
        const chipMin = chip.kitchenMinutes ?? 0;
        if (chipMin > 0) {
          kitchenLoadByDay.set(
            chip.date,
            Math.max(0, (kitchenLoadByDay.get(chip.date) ?? 0) - chipMin),
          );
          kitchenLoadByDay.set(
            newStart,
            (kitchenLoadByDay.get(newStart) ?? 0) + chipMin,
          );
        }
        if (chip.dehydratorTrays && chip.dehydratorOccupiesFrom && chip.dehydratorOccupiesTo) {
          const oldFrom = fromLocalISODate(chip.dehydratorOccupiesFrom);
          const oldTo = fromLocalISODate(chip.dehydratorOccupiesTo);
          for (let d = new Date(oldFrom); d.getTime() <= oldTo.getTime(); d.setDate(d.getDate() + 1)) {
            const iso = toLocalISODate(d);
            const cur = dehydratorLoadByDay.get(iso) ?? 0;
            dehydratorLoadByDay.set(iso, Math.max(0, cur - chip.dehydratorTrays));
          }
          addDehydratorLoad(
            dehydratorLoadByDay,
            shiftIsoOrNull(chip.dehydratorOccupiesFrom, shift),
            shiftIsoOrNull(chip.dehydratorOccupiesTo, shift),
            chip.dehydratorTrays,
          );
        }
        kitchenRequiredActivities[i] = {
          ...chip,
          date: newStart,
          finishDate: chip.finishDate
            ? shiftIsoByDays(chip.finishDate, shift)
            : chip.finishDate,
          requiredByDate: chip.requiredByDate
            ? shiftIsoByDays(chip.requiredByDate, shift)
            : chip.requiredByDate,
          dehydratorOccupiesFrom: shiftIsoOrNull(chip.dehydratorOccupiesFrom, shift),
          dehydratorOccupiesTo: shiftIsoOrNull(chip.dehydratorOccupiesTo, shift),
        };
        anyMovedThisIter += 1;
        secondPassMoved += 1;
        secondPassShiftDays += shift;
      }
      if (anyMovedThisIter === 0) break; // stable
    }

    if (shardedFromCount > 0 || movedCount > 0 || droppedNoConsumerCount > 0 || secondPassMoved > 0) {
      const dropTail =
        droppedNoConsumerCount > 0
          ? ` Dropped ${droppedNoConsumerCount} chip(s) with no FIFO-allocated consumer (covered by SOH + assemblies + earlier batches): ${droppedSummaries.join(', ')}${droppedNoConsumerCount > droppedSummaries.length ? `, …+${droppedNoConsumerCount - droppedSummaries.length} more` : ''}.`
          : '';
      const secondTail =
        secondPassMoved > 0
          ? ` Iterative post-split FIFO redate: ${secondPassMoved} chip-move(s) over ${iteration} iteration(s) (cumulative ${secondPassShiftDays} chip-days shifted further toward consumers).`
          : '';
      console.log(
        `[planner] FIFO split-and-redate: ${shardedFromCount} chip(s) split into ${splitCount} shard(s); ${movedCount} shard(s) moved later (cumulative ${cumulativeShiftDays} chip-days shifted toward consumers).${secondTail}${dropTail}`,
      );
    }
  }

  // ─── Supply cap pass (Phase 4l.10) ───────────────────────────
  // Reconcile user-edited kitchen runs against packaging demand. The DP
  // sized packaging assuming the planner-chosen kitchen quantities; if
  // the user reduced a kitchen run, downstream packaging chips would
  // overdraw. The cap pass walks each intermediate, computes available
  // output (SOH + Unleashed assemblies + (planned-or-edited kitchen
  // input × yield)), and caps packaging consumers in profit-per-unit
  // descending order. Chips capped to 0 stay on the calendar but are
  // treated as supply-dismissed (shown only when the "Show dismissed"
  // toggle is on, greyed out when shown).
  const intermediateOutputSupply: Record<string, number> = {};
  // SOH contribution (already summed across intermediate warehouses)
  for (const [code, soh] of Object.entries(lundbergSohByCode)) {
    intermediateOutputSupply[code] = (intermediateOutputSupply[code] ?? 0) + soh;
  }
  // Unleashed assembly contribution (output kg, already in output units)
  for (const ev of scheduledKitchenSupply) {
    intermediateOutputSupply[ev.intermediateCode] =
      (intermediateOutputSupply[ev.intermediateCode] ?? 0) + ev.quantity;
  }
  // Planner-emitted kitchen runs: input × yield = effective output.
  // Apply user mutations to the input qty (resolveQty) before yield.
  // Diagnostic: track per-run resolution so the dev console shows
  // exactly which run was found, its planned vs effective qty, and
  // whether a user edit was matched.
  const kitchenRunDiagnostic: Array<{
    code: string;
    stableId: string;
    plannedInput: number;
    effectiveInput: number | null;
    editApplied: boolean;
    contributedOutput: number;
  }> = [];
  for (let runIdx = 0; runIdx < reachableKitchenRuns.length; runIdx++) {
    const run = reachableKitchenRuns[runIdx];
    // Phase 4l.11 — look up edits against the same stableIds the chip
    // mint emits (per-(code, week) counter, not raw runIdx). For
    // multi-batch runs, sum the resolved qty across all batch chips so
    // edits to any batch flow through to the supply cap.
    const chipIds = runChipStableIds.get(runIdx) ?? [];
    const stableId = runFirstChipStableId.get(runIdx) ?? '';
    const perChipPlanned = chipIds.length > 0 ? run.quantity / chipIds.length : run.quantity;
    let effectiveInput: number | null = 0;
    let editApplied = false;
    for (const cid of chipIds) {
      const resolved = resolveQty(cid, perChipPlanned);
      if (resolved === null) {
        effectiveInput = null;
        break;
      }
      if (serverMutations.has(cid)) editApplied = true;
      effectiveInput += resolved;
    }
    // Fallback for runs that emitted no chips (shouldn't happen).
    if (chipIds.length === 0) {
      effectiveInput = resolveQty(stableId, run.quantity);
      editApplied = serverMutations.has(stableId);
    }
    if (effectiveInput === null) {
      kitchenRunDiagnostic.push({
        code: run.intermediateCode,
        stableId,
        plannedInput: run.quantity,
        effectiveInput: null,
        editApplied,
        contributedOutput: 0,
      });
      continue;
    }
    const yieldRate =
      capacity.intermediates.get(run.intermediateCode)?.yieldRate ?? 1.0;
    const effectiveYield =
      yieldRate > 0 && yieldRate <= 1 ? yieldRate : 1.0;
    const contributedOutput = effectiveInput * effectiveYield;
    intermediateOutputSupply[run.intermediateCode] =
      (intermediateOutputSupply[run.intermediateCode] ?? 0) + contributedOutput;
    kitchenRunDiagnostic.push({
      code: run.intermediateCode,
      stableId,
      plannedInput: run.quantity,
      effectiveInput,
      editApplied,
      contributedOutput,
    });
  }
  // Run the cap pass against current packaging chips (post today-floor).
  // User edits to packaging quantities flow through via resolveQty in
  // the chip projector; here we use the chip's current `quantity` field
  // which is the planner-emitted value. The pass takes the MIN with any
  // subsequent user edit downstream.
  //
  // Build a local consumesQtyMap (parent → child → qty-per-unit) just
  // for the cap pass. A canonical one is built further down for the
  // client-side conflict detector; we don't want to depend on that
  // declaration order, and the cost is negligible.
  const capConsumesQtyMap: Record<string, Record<string, number>> = {};
  for (const row of capacity.bom) {
    let inner = capConsumesQtyMap[row.parentProductCode];
    if (!inner) {
      inner = {};
      capConsumesQtyMap[row.parentProductCode] = inner;
    }
    inner[row.productCode] =
      (inner[row.productCode] ?? 0) + row.quantityPerParent;
  }
  const supplyCapResult = applySupplyCaps({
    packagingChips: packagingActivitiesClamped
      .filter((a) => a.kind === 'packaging' && !dismissedStableIds.has(a.stableId))
      .map((a) => ({
        stableId: a.stableId,
        productCode: a.productCode,
        quantity: a.quantity,
        date: a.date,
        profitPerItem: a.profitPerItem ?? null,
      })),
    consumesQtyMap: capConsumesQtyMap,
    intermediateOutputSupply,
  });
  // Apply caps to the activity list. Chips capped to 0 stay on the
  // calendar (rendered greyed-out behind the "Show dismissed" toggle).
  const cappedActivities = packagingActivitiesClamped.map((a) => {
    const cap = supplyCapResult.caps.get(a.stableId);
    if (!cap) return a;
    return {
      ...a,
      quantity: cap.cappedQuantity,
      supplyCappedFrom: cap.capFrom,
      supplyCappedBy: cap.capCode,
    };
  });
  if (supplyCapResult.caps.size > 0) {
    console.warn(
      `[planner] Supply-cap pass capped ${supplyCapResult.caps.size} packaging chip(s) across ${supplyCapResult.diagnostics.size} short intermediate(s).`,
    );
  }
  // Phase 4l.10 — shortage audit. Many intermediates show shortages even
  // without user edits — the diagnostic below lists each with its supply
  // breakdown (SOH / assemblies / kitchen runs) and demand summary, so
  // the patterns are visible at a glance. Most likely causes are
  // (a) missing yield uplift on cascading kitchen runs, (b) Unleashed
  // assemblies not credited to the right intermediate code, or
  // (c) genuine shortage requiring extra kitchen production.
  const shortages = Array.from(supplyCapResult.diagnostics.entries())
    .filter(([, d]) => d.shortBy > 0)
    .sort((a, b) => b[1].shortBy - a[1].shortBy);
  if (shortages.length > 0) {
    console.warn(
      `[shortage-audit] ${shortages.length} intermediate(s) short on supply vs demand:`,
    );
    // For each shortage, log a single-line breakdown so terminal scroll
    // stays readable. Top 20 only to avoid drowning the log.
    for (const [code, diag] of shortages.slice(0, 20)) {
      const sohContrib = lundbergSohByCode[code] ?? 0;
      const assemblyContrib = scheduledKitchenSupply
        .filter((ev) => ev.intermediateCode === code)
        .reduce((s, ev) => s + ev.quantity, 0);
      const runContrib = diag.totalSupply - sohContrib - assemblyContrib;
      // Find consumers and the number of kitchen runs planned for this code.
      const runCount = reachableKitchenRuns.filter((r) => r.intermediateCode === code).length;
      const consumerCount = packagingActivitiesClamped.filter(
        (a) =>
          a.kind === 'packaging' &&
          capConsumesQtyMap[a.productCode]?.[code] &&
          !dismissedStableIds.has(a.stableId),
      ).length;
      // Yield rate for sanity-checking yield-uplift correctness.
      const yieldRate = capacity.intermediates.get(code)?.yieldRate ?? null;
      console.warn(
        `  ${code}: supply=${diag.totalSupply.toFixed(0)} (SOH ${sohContrib.toFixed(0)} + asm ${assemblyContrib.toFixed(0)} + runs ${runContrib.toFixed(0)} from ${runCount} batches) vs demand=${diag.totalDemand.toFixed(0)} from ${consumerCount} consumer(s); SHORT BY ${diag.shortBy.toFixed(0)}; yield=${yieldRate ?? 'n/a'}`,
      );
    }
    if (shortages.length > 20) {
      console.warn(`  …and ${shortages.length - 20} more.`);
    }
  }
  // Always log a one-line cap-pass summary so we can confirm the pass ran
  // even when no edits were detected. Includes:
  //   • how many kitchen runs were considered
  //   • how many cookie mutations exist in total
  //   • how many of those reference a kitchen-required chip
  console.log(
    `[supply-cap] pass ran: ${reachableKitchenRuns.length} kitchen run(s), ${serverMutations.size} cookie mutation(s), ${kitchenRunDiagnostic.filter((d) => d.editApplied).length} edit(s) matched a run.`,
  );
  // List every kitchen run's stableId so we can cross-check against the
  // cookie. If the user's edit isn't matching, this is where we'll spot
  // the discrepancy.
  console.log(
    '[supply-cap] kitchen-run stableIds:',
    kitchenRunDiagnostic.map((d) => `${d.stableId} (planned ${d.plannedInput})`),
  );
  // Dump every cookie mutation so we can see what the user actually edited
  // (vs what the cap pass expected). Compact form: stableId → {q, d, r}.
  const cookieEntries: string[] = [];
  for (const [sid, m] of serverMutations.entries()) {
    const parts: string[] = [];
    if (m.dismissed) parts.push('d');
    if (typeof m.editedQuantity === 'number') parts.push(`q=${m.editedQuantity}`);
    if (m.rescheduledTo) parts.push(`r=${m.rescheduledTo}`);
    cookieEntries.push(`${sid} → {${parts.join(', ')}}`);
  }
  if (cookieEntries.length > 0) {
    console.log('[supply-cap] all cookie mutations:', cookieEntries);
  }
  // Always log kitchen-run diagnostic so the user can see WHY caps did or
  // didn't fire after a kitchen-quantity edit. Each line:
  //   • the resolved input qty (user-edited or planned)
  //   • the contributed output (input × yield)
  //   • whether a user edit was actually matched to a stableId
  // Plus per-intermediate aggregate so SOH / assemblies are visible.
  if (kitchenRunDiagnostic.length > 0) {
    const editedRuns = kitchenRunDiagnostic.filter((d) => d.editApplied);
    if (editedRuns.length > 0) {
      console.log(
        `[supply-cap] User-edited kitchen runs (${editedRuns.length}):`,
        editedRuns.map(
          (d) =>
            `${d.code}: planned=${d.plannedInput} → effective=${d.effectiveInput} → output=${d.contributedOutput?.toFixed(0)} (stableId=${d.stableId})`,
        ),
      );
      // Show the intermediate-level aggregate for each edited code so the
      // user can see the full supply picture (SOH + assemblies + run).
      const editedCodes = new Set(editedRuns.map((d) => d.code));
      for (const code of editedCodes) {
        const sohContrib = lundbergSohByCode[code] ?? 0;
        const assemblyContrib = scheduledKitchenSupply
          .filter((ev) => ev.intermediateCode === code)
          .reduce((s, ev) => s + ev.quantity, 0);
        const runContrib =
          (intermediateOutputSupply[code] ?? 0) - sohContrib - assemblyContrib;
        console.log(
          `[supply-cap] ${code} total output supply = ${intermediateOutputSupply[code]?.toFixed(0)} (SOH ${sohContrib.toFixed(0)} + assemblies ${assemblyContrib.toFixed(0)} + planned runs ${runContrib.toFixed(0)})`,
        );
        // Demand side: list every consumer.
        const consumers = packagingActivitiesClamped
          .filter(
            (a) =>
              a.kind === 'packaging' &&
              capConsumesQtyMap[a.productCode]?.[code] &&
              !dismissedStableIds.has(a.stableId),
          )
          .map((a) => ({
            code: a.productCode,
            qty: a.quantity,
            ratio: capConsumesQtyMap[a.productCode][code],
            demandOutput: a.quantity * capConsumesQtyMap[a.productCode][code],
            profitPerItem: a.profitPerItem ?? null,
            date: a.date,
          }));
        const totalDemand = consumers.reduce((s, c) => s + c.demandOutput, 0);
        console.log(
          `[supply-cap] ${code} total demand = ${totalDemand.toFixed(0)} from ${consumers.length} consumer(s):`,
          consumers.map(
            (c) =>
              `${c.code}×${c.qty} on ${c.date} (ratio ${c.ratio}, ${c.demandOutput.toFixed(0)} output kg, profit $${c.profitPerItem ?? 'n/a'})`,
          ),
        );
      }
    }
  }

  // Combine packaging activities (planner output) with kitchen-related
  // activities (live + required). Sort by date.
  // Note: PO chips are appended to this list later (after the
  // raw-material analyzer runs). Sort happens once at the end so PO
  // chips slot into the correct chronological position.
  const allActivities: CalendarActivity[] = [
    ...cappedActivities,
    ...kitchenActivities,
    ...unleashedPackagingActivities,
    ...kitchenRequiredActivities,
  ];

  // Build infeasible products list (with per-product unmet demand totals)
  // for surfacing in the UI's left rail.
  const infeasibleProducts: Array<{
    productCode: string;
    productName: string;
    station: string;
    unmetUnits: number;
    reason: string;
  }> = [];
  for (const plan of products) {
    const r = orchestratorOutput.perProduct.get(plan.meta.productCode);
    if (!r || r.feasible) continue;
    const unmet = r.unmetDemand.reduce((s, u) => s + u.quantity, 0);
    infeasibleProducts.push({
      productCode: plan.meta.productCode,
      productName: plan.meta.productName || plan.meta.productCode,
      station: plan.meta.station,
      unmetUnits: Math.round(unmet),
      reason: r.rationale[0] ?? 'No feasible plan.',
    });
  }
  infeasibleProducts.sort((a, b) => b.unmetUnits - a.unmetUnits);

  // Phase 4l.10 — infeasibility audit. The orchestrator's generic
  // "No feasible plan: total demand exceeds available production capacity
  // within shelf-life and storage constraints." isn't actionable on its
  // own. This log breaks each infeasible product into the four levers
  // (demand, SOH, shelf-life window, batch size) and tries to classify
  // the binding constraint so the user can choose the right fix:
  //   • demand > maxBatch × horizonWeeks + SOH → genuinely not enough
  //     production capacity, either grow maxBatch or reduce demand
  //   • peak-window demand > maxBatch → shelf-life forces ≥2 batches per
  //     window but only one fits; raise maxBatch or extend shelf-life
  //   • minBatchSize too high vs peak window → discretisation bug, the
  //     adaptive minBatch (Phase 4l.8) should have caught this — flag
  //   • net demand ≤ 0 → covered by SOH, should NOT be infeasible (bug)
  if (infeasibleProducts.length > 0) {
    console.warn(
      `[infeasibility-audit] ${infeasibleProducts.length} infeasible product(s):`,
    );
    for (const plan of products) {
      const r = orchestratorOutput.perProduct.get(plan.meta.productCode);
      if (!r || r.feasible) continue;
      const totalDemand = plan.weeklyDemand.reduce((s, w) => s + w.quantity, 0);
      const horizonWeeks = plan.weeklyDemand.length;
      const shelfLifeWeeks = Math.max(1, Math.floor(plan.shelfLifeDays / 7));
      // Peak forward-window demand: the most demand any consecutive
      // `shelfLifeWeeks`-week window contains. The DP can't hold more
      // than this in inventory at once, so a single batch needs to fit
      // here, or you need multiple batches in the window.
      let peakWindow = 0;
      for (let w = 0; w < plan.weeklyDemand.length; w++) {
        let sum = 0;
        for (
          let k = w;
          k < Math.min(plan.weeklyDemand.length, w + shelfLifeWeeks);
          k++
        ) {
          sum += plan.weeklyDemand[k].quantity;
        }
        if (sum > peakWindow) peakWindow = sum;
      }
      const maxPossibleProduction =
        plan.maxBatchSize * horizonWeeks + plan.initialInventory;
      const netDemand = totalDemand - plan.initialInventory;
      let likely = 'unknown';
      if (netDemand <= 0) {
        likely = 'BUG? netDemand≤0 (SOH covers all demand)';
      } else if (totalDemand > maxPossibleProduction) {
        likely = `demand > capacity (need ${totalDemand}, max ${maxPossibleProduction})`;
      } else if (peakWindow > plan.maxBatchSize) {
        likely = `peak-window demand ${peakWindow.toFixed(0)} > maxBatch ${plan.maxBatchSize} (shelf-life ${shelfLifeWeeks}w too tight)`;
      } else if (plan.minBatchSize > peakWindow) {
        likely = `minBatch ${plan.minBatchSize} > peak-window ${peakWindow.toFixed(0)} (discretisation)`;
      }
      console.warn(
        `  ${plan.meta.productCode} (${plan.meta.station}): demand=${totalDemand.toFixed(0)}, SOH=${plan.initialInventory}, shelfLife=${plan.shelfLifeDays}d (${shelfLifeWeeks}w), batch=${plan.minBatchSize}-${plan.maxBatchSize}, peakWindow=${peakWindow.toFixed(0)}, horizon=${horizonWeeks}w; LIKELY: ${likely}`,
      );
    }
  }

  // Build summary banner data.
  const productCount = products.length;
  const feasibleCount = productCount - infeasibleProducts.length;
  const totalChangeoverMin = orchestratorOutput.totalChangeoverMinutes;
  const dataAge = demandData?.sourceMtime ?? null;

  // Convert Map → plain object for the server-client boundary.
  const routingDecisions: Record<string, string> = {};
  for (const [code, dec] of routingByProduct.entries()) {
    routingDecisions[code] = dec.rationale;
  }

  // Per-station daily capacity in minutes. Client uses this to recompute
  // load when activities are mutated (dismissed, eventually rescheduled).
  const stationDailyMinutes: Record<string, number> = {};
  for (const [station, defaults] of Object.entries(capacity.stations)) {
    stationDailyMinutes[station] = defaults.hoursPerDay * 60;
  }

  // Per-recipe kitchen-team minutes (Phase 4l.8). Derived from process steps
  // (soak setup + dehyd init + cook). Activities not in this map use the
  // client-side default. Only intermediates the kitchen actually produces
  // need entries — packaging codes are ignored by the resolver.
  const kitchenMinutesByProductCode: Record<string, number> = {};
  for (const [code, intermediate] of capacity.intermediates.entries()) {
    kitchenMinutesByProductCode[code] = kitchenTeamMinutesFor(intermediate);
  }

  // Phase 4l.10 — dehydrator capacity: total daily tray pool from the
  // "Kitchen capacities" sheet's 3 dehydrators (Mamma + Pappa + Midgy ~=
  // 605 trays at typical max-fill). Passed to the client so the day-
  // header heatmap can render D% (dehydrator utilisation) alongside K%
  // and packaging %.
  const dehydratorTotalTrays = capacity.dehydratorCapacity.totalEffectiveTrays;

  // Per-product station daily output (for drawer's max-batch default helper).
  const productStationDailyOutput: Record<string, number> = {};
  for (const r of balanced.routings) {
    const s = capacity.stations[r.currentStation];
    if (s) productStationDailyOutput[r.productCode] = dailyStationOutput(s.unitsPerHour, s.hoursPerDay);
  }

  // Pass per-warehouse SOH to the client. The drawer renders the full
  // breakdown with eligible warehouses highlighted; the planner has already
  // summed across eligible warehouses for initialInventory.
  const sohByProductCode: Record<string, Record<string, number>> = sohCache
    ? sohCache.byProductCode
    : {};
  const sohFetchedAt: string | null = sohCache?.fetchedAt ?? null;
  const availableWarehouses: string[] = sohCache?.warehouses ?? [];
  const eligibleWarehouses: ReadonlyArray<string> = FULFILMENT_ELIGIBLE_WAREHOUSES;
  // Per-product effective initial inventory — what the planner actually used.
  const initialInventoryByProduct: Record<string, number> = {};
  for (const r of balanced.routings) {
    initialInventoryByProduct[r.productCode] = eligibleSohOf(sohCache, r.productCode);
  }
  // Avoid TS unused warnings on imports kept for the future transfer
  // detection wiring (Phase 4i.2).
  void sohOf;
  void sohBreakdownOf;

  // Sales-orders summary for the client: per-product committed total + the
  // line-level details for the drawer.
  const salesOrdersByProduct: Record<
    string,
    Array<{
      orderNumber: string;
      customerName: string;
      orderStatus: string;
      requiredDate: string;
      quantityRemaining: number;
    }>
  > = {};
  const committedByProduct: Record<string, number> = {};
  if (salesCache) {
    for (const r of balanced.routings) {
      const lines = salesOrdersForProduct(salesCache, r.productCode);
      if (lines.length > 0) {
        salesOrdersByProduct[r.productCode] = lines.map((l) => ({
          orderNumber: l.orderNumber,
          customerName: l.customerName,
          orderStatus: l.orderStatus,
          requiredDate: l.requiredDate,
          quantityRemaining: l.quantityRemaining,
        }));
      }
      const committed = totalCommittedFor(salesCache, r.productCode);
      if (committed > 0) committedByProduct[r.productCode] = committed;
    }
  }
  const salesOrdersFetchedAt: string | null = salesCache?.fetchedAt ?? null;
  const totalSalesOrderLines = salesCache?.totalLines ?? 0;

  const assembliesFetchedAt: string | null = assembliesCache?.fetchedAt ?? null;
  const kitchenActivityCount = kitchenActivities.length;
  const kitchenRequiredCount = kitchenRequiredActivities.length;

  // ─── Raw-material projection (Phase 4m.1, Phase 4l.4) ───────
  // Walk every consumer of raw materials to derive depth-1 non-intermediate
  // component demand, simulate SOH, and compute PO place-by dates.
  // Consumers are:
  //   • packaging activities — planner output for FG runs
  //   • kitchen-required activities — system-planned intermediate runs
  //   • kitchen activities — Unleashed-resident assemblies (Parked/Planned/
  //     Open) at Lundberg. These have NOT yet consumed their raw materials
  //     (Completed assemblies are explicitly filtered out of the cache by
  //     `serverFetchOpenAssemblies`), so they drive demand the same way
  //     system-planned kitchen-required runs do. Treated as kind
  //     'kitchen-required' for the analyzer's purposes.
  // Phase 4l.7: dismissed activities no longer drive raw-material demand,
  // and qty-edited ones drive demand at their edited quantity. Applies
  // uniformly across packaging, kitchen-required, and live kitchen chips.
  const withMutation = <T extends { stableId: string; quantity: number; date: string }>(
    arr: ReadonlyArray<T>,
  ): T[] => {
    const out: T[] = [];
    for (const a of arr) {
      const q = resolveQty(a.stableId, a.quantity);
      if (q === null) continue;
      const date = resolveDate(a.stableId, a.date);
      const qtyChanged = q !== a.quantity;
      const dateChanged = date !== a.date;
      out.push(
        qtyChanged || dateChanged
          ? { ...a, quantity: q, date }
          : a,
      );
    }
    return out;
  };
  const rawMaterialActivities: ActivityForRawMaterials[] = [
    ...withMutation(packagingActivitiesClamped).map((a) => ({
      stableId: a.stableId,
      productCode: a.productCode,
      productName: a.productName,
      quantity: a.quantity,
      date: a.date,
      kind: 'packaging' as const,
    })),
    ...withMutation(kitchenRequiredActivities).map((a) => ({
      stableId: a.stableId,
      productCode: a.productCode,
      productName: a.productName,
      quantity: a.quantity,
      date: a.date,
      kind: 'kitchen-required' as const,
    })),
    ...withMutation(kitchenActivities).map((a) => ({
      stableId: a.stableId,
      productCode: a.productCode,
      productName: a.productName,
      quantity: a.quantity,
      date: a.date,
      kind: 'kitchen-required' as const,
    })),
  ];
  // Sum raw-material SOH across ALL warehouses — raw materials are stored
  // where they're used; the eligible-warehouse filter (used for finished
  // goods sales) doesn't apply.
  const rawMaterialSohByCode: Record<string, number> = {};
  if (sohCache) {
    for (const [code, byWarehouse] of Object.entries(sohCache.byProductCode)) {
      let total = 0;
      for (const qty of Object.values(byWarehouse)) total += qty;
      rawMaterialSohByCode[code] = total;
    }
  }
  // `todayLocal` is already declared above (shared with kitchen-run today-floor).
  // Per-vendor lead times from data/raw-material-lead-times.json. Codes
  // not in the file fall back to defaultLeadTimeDays (14 days). The user
  // can override per-PO in the drawer for transient shipping delays —
  // those overrides are localStorage-backed and applied client-side.
  const leadTimesFile = readLeadTimes();
  const leadTimeDaysByCode = leadTimeDaysByCodeOf(leadTimesFile);
  const vendorByCode = vendorByCodeOf(leadTimesFile);

  // ─── Unleashed PO supply events (Phase 4l.5) ───────────────
  // Outstanding line items on Open + PartiallyReceived POs credit
  // raw-material SOH on their expectedDeliveryDate, reducing synthetic PO
  // sizes. They also render as view-only po-receiving chips below.
  const poSupplyEvents: RawMaterialSupplyEvent[] = (purchaseOrdersCache?.lines ?? []).map((ln) => ({
    rawMaterialCode: ln.productCode,
    rawMaterialName: ln.productName,
    quantity: ln.quantity,
    availableDate: ln.expectedDeliveryDate,
    source: {
      kind: 'unleashed_po' as const,
      purchaseOrderNumber: ln.purchaseOrderNumber,
      lineNumber: ln.lineNumber,
      supplierName: ln.supplierName,
    },
  }));

  const rawMaterialAnalysis = analyzeRawMaterials({
    activities: rawMaterialActivities,
    bom: capacity.bom,
    intermediateCodes,
    initialSohByCode: rawMaterialSohByCode,
    supplyEvents: poSupplyEvents,
    defaultLeadTimeDays: 14,
    leadTimeDaysByCode,
    today: todayLocal,
  });

  // Project Unleashed POs as view-only po-receiving chips so the operator
  // sees committed deliveries on the calendar. Distinguished from
  // synthetic POs via `poInfo.source === 'unleashed_po'` (Phase 4l.5).
  //
  // Phase 4l.8: only project Unleashed POs whose productCode is consumed
  // by at least one scheduled (non-dismissed) packaging or kitchen
  // activity. POs for unrelated codes (one-off purchases, products no
  // longer in any BOM, etc.) are hidden so the calendar isn't cluttered.
  // The supply credit to the analyzer still applies for ALL Unleashed POs
  // (harmless for codes that have no demand — they just sit in SOH).
  const consumedCodes = new Set<string>();
  for (const a of allActivities) {
    if (a.kind !== 'packaging' && a.kind !== 'kitchen-required' && a.kind !== 'kitchen') continue;
    if (dismissedStableIds.has(a.stableId)) continue;
    for (const ing of consumesMap[a.productCode] ?? []) {
      consumedCodes.add(ing);
    }
  }
  const unleashedPoChips: CalendarActivity[] = (purchaseOrdersCache?.lines ?? [])
    .filter((ln) => consumedCodes.has(ln.productCode))
    .map((ln) => {
    const d = new Date(ln.expectedDeliveryDate + 'T00:00:00');
    const dow = d.getDay();
    const mondayOffset = dow === 0 ? -6 : 1 - dow;
    const monday = new Date(d);
    monday.setDate(d.getDate() + mondayOffset);
    const weekStart = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`;
    const stableId = `unleashed-po|${ln.purchaseOrderNumber}|${ln.lineNumber}`;
    return {
      id: stableId,
      stableId,
      kind: 'po-receiving' as const,
      date: ln.expectedDeliveryDate,
      weekStart,
      orderInWeek: 0,
      station: null,
      productCode: ln.productCode,
      productName: ln.productName,
      quantity: ln.quantity,
      durationMinutes: 0,
      changeoverMinutes: 0,
      family: null,
      extendedFamily: null,
      poInfo: {
        placeByDate: ln.expectedDeliveryDate, // unknown; show arrive date
        arriveByDate: ln.expectedDeliveryDate,
        leadTimeDays: 0,
        overdue: false,
        sisterStableId: stableId, // self-reference; no place-side chip for Unleashed POs
        drivenBy: [],
        source: 'unleashed_po',
        purchaseOrderNumber: ln.purchaseOrderNumber,
        supplierName: ln.supplierName,
        status: ln.status,
      },
    };
  });
  const rawMaterialShortages: RawMaterialShortage[] = rawMaterialAnalysis.shortages;
  const purchaseRequirements: PurchaseRequirement[] = rawMaterialAnalysis.requirements;

  // ─── Label/printed-bag block warnings (Phase 4l.10) ────────
  // Stickers (`L<code>`) and printed bags (`PB<code>`) are raw materials
  // already; the analyzer above generates PO chips for them when SOH falls
  // short. This adds visibility on the consuming side: a packaging chip
  // whose required sticker won't arrive before the chip's date gets a
  // `labelBlocking` flag that surfaces in the drawer as a yellow warning.
  // Drives the user to expedite the PO or reschedule the run — not yet a
  // hard constraint that forces the planner to push the chip forward.
  const purchaseRequirementByCode = new Map<string, PurchaseRequirement>();
  for (const r of purchaseRequirements) {
    purchaseRequirementByCode.set(r.rawMaterialCode, r);
  }
  const shortageCodes = new Set(rawMaterialShortages.map((s) => s.rawMaterialCode));
  // Find which depth-1 BOM children of each packaging chip are packaging
  // materials and currently in shortage.
  const labelBlockingByStableId = new Map<
    string,
    Array<{
      code: string;
      name: string;
      kind: 'label' | 'printed_bag';
      arriveByDate: string | null;
      placeByDate: string | null;
      placeByOverdue: boolean;
    }>
  >();
  for (const a of allActivities) {
    if (a.kind !== 'packaging') continue;
    if (dismissedStableIds.has(a.stableId)) continue;
    const children = consumesMap[a.productCode] ?? [];
    for (const childCode of children) {
      const matKind = classifyPackagingMaterial(childCode);
      if (matKind === null) continue;
      if (!shortageCodes.has(childCode)) continue;
      const req = purchaseRequirementByCode.get(childCode) ?? null;
      // Only flag when the PO either doesn't exist or won't arrive before
      // this chip's date — otherwise the dependency is on schedule and
      // doesn't need to alarm the user.
      if (req && req.arriveByDate <= a.date) continue;
      const list = labelBlockingByStableId.get(a.stableId) ?? [];
      // Look up a human-readable name from the BOM (first matching row).
      let name = childCode;
      for (const row of capacity.bom) {
        if (row.productCode === childCode) {
          name = row.productName || childCode;
          break;
        }
      }
      list.push({
        code: childCode,
        name,
        kind: matKind,
        arriveByDate: req?.arriveByDate ?? null,
        placeByDate: req?.placeByDate ?? null,
        placeByOverdue: req?.overdue ?? false,
      });
      labelBlockingByStableId.set(a.stableId, list);
    }
  }
  // Attach the flag onto the activity objects so it flows through to the
  // client without needing a separate prop. CalendarActivity already
  // accepts arbitrary optional fields under structural typing.
  for (let i = 0; i < allActivities.length; i++) {
    const a = allActivities[i];
    const list = labelBlockingByStableId.get(a.stableId);
    if (!list || list.length === 0) continue;
    allActivities[i] = { ...a, labelBlocking: list };
  }
  if (labelBlockingByStableId.size > 0) {
    console.warn(
      `[planner] ${labelBlockingByStableId.size} packaging chip(s) flagged label-blocked: ${Array.from(
        labelBlockingByStableId.keys(),
      )
        .slice(0, 6)
        .join(', ')}${labelBlockingByStableId.size > 6 ? `, …+${labelBlockingByStableId.size - 6} more` : ''}`,
    );
  }

  // ─── SOH-aware conflict-detection inputs (Phase 4l.3) ──────
  // The conflict detector now walks a per-ingredient SOH+supply timeline
  // instead of just checking whether any supplier finishes in time. To do
  // that it needs:
  //   • initial SOH per ingredient (re-uses rawMaterialSohByCode — sums
  //     across all warehouses, applies to both raw materials and
  //     intermediates since they're stored where used);
  //   • per-unit consumption (ingredient qty per unit of parent), built
  //     directly from the BOM rows;
  //   • per-recipe yield rate, applied to kitchen-run supply qty so a
  //     run scheduled for 100kg of ICC at 0.93 yield only credits 93kg.
  // PO supply qtys default to activity.quantity (set client-side at
  // chip-projection time), so we only need to ship yield rates and
  // consumption rates to the client.
  const consumesQtyMap: Record<string, Record<string, number>> = {};
  for (const row of capacity.bom) {
    let inner = consumesQtyMap[row.parentProductCode];
    if (!inner) {
      inner = {};
      consumesQtyMap[row.parentProductCode] = inner;
    }
    // Combined clean+wastage figure — matches what each consumer of the
    // parent actually consumes per unit produced.
    inner[row.productCode] = (inner[row.productCode] ?? 0) + row.quantityPerParent;
  }
  const yieldRateByCode: Record<string, number> = {};
  for (const [code, intermediate] of capacity.intermediates.entries()) {
    if (typeof intermediate.yieldRate === 'number' && intermediate.yieldRate > 0) {
      yieldRateByCode[code] = intermediate.yieldRate;
    }
  }

  // Synthetic PO chips are projected on the CLIENT (Phase 4m.4) so that
  // user-set transient lead-time overrides (shipping-delay edits in the
  // drawer) flow through naturally via the mutations layer. The server
  // ships the requirements + today + vendor map; the client projects the
  // chips and merges them into the activities list.
  //
  // Unleashed-resident PO chips (Phase 4l.5) are NOT user-editable — their
  // dates come straight from Unleashed — so we project them server-side
  // and ship them ready to render.
  allActivities.push(...unleashedPoChips);
  allActivities.sort((a, b) => a.date.localeCompare(b.date));

  // ─── Phase 4l.12 — consolidated planning audit ────────────
  // One block summarising every silent-failure mode so the user can
  // sweep them as a batch instead of hunting through scattered
  // [planner] warnings. Items here are NOT errors — they're things
  // worth investigating or housekeeping in upstream systems.
  {
    const auditLines: string[] = [];
    // (a) Allowlist SKUs missing a BOM (can't plan).
    if (allowlistMissingBom.length > 0) {
      auditLines.push(
        `  ${allowlistMissingBom.length} allowlisted SKU(s) missing a BOM (can't be planned): ${allowlistMissingBom.slice(0, 5).join(', ')}${allowlistMissingBom.length > 5 ? ` …+${allowlistMissingBom.length - 5} more` : ''}`,
      );
    }
    // (b) Allowlisted SKUs auto-routed (missing family-sheet entry).
    if (autoRoutedSkus.length > 0) {
      auditLines.push(
        `  ${autoRoutedSkus.length} allowlisted SKU(s) auto-routed to hand-packing (no family-sheet entry).`,
      );
    }
    // (c) BOM components referenced by active chips that aren't in
    // "Kitchen processes" (= treated as raw materials, no kitchen run).
    // This is the sneaky failure mode discussed in the family-gap Q&A.
    const intermediateLookalikes = new Set<string>();
    for (const row of capacity.bom) {
      // Heuristic: a BOM component whose code starts with 'I' (matching
      // the IXXX intermediate naming convention) but isn't in
      // intermediateCodes is probably a missing kitchen-processes row.
      if (
        /^I[A-Z]/.test(row.productCode) &&
        !intermediateCodes.has(row.productCode) &&
        reachableFromPackaging.has(row.productCode)
      ) {
        intermediateLookalikes.add(row.productCode);
      }
    }
    if (intermediateLookalikes.size > 0) {
      auditLines.push(
        `  ${intermediateLookalikes.size} I-prefixed BOM component(s) reachable from packaging but NOT in "Kitchen processes" sheet — treated as raw materials. May need recipe rows: ${[...intermediateLookalikes].slice(0, 8).join(', ')}${intermediateLookalikes.size > 8 ? ` …+${intermediateLookalikes.size - 8} more` : ''}`,
      );
    }
    // (d) Family rows whose `family` value isn't a real intermediate.
    const familyDanglingRefs = new Set<string>();
    for (const [code, fam] of Object.entries(capacity.familyMap)) {
      if (fam.family && !intermediateCodes.has(fam.family)) {
        familyDanglingRefs.add(`${code}→${fam.family}`);
      }
    }
    if (familyDanglingRefs.size > 0) {
      auditLines.push(
        `  ${familyDanglingRefs.size} family-sheet row(s) reference a missing intermediate: ${[...familyDanglingRefs].slice(0, 5).join(', ')}${familyDanglingRefs.size > 5 ? ` …+${familyDanglingRefs.size - 5} more` : ''}`,
      );
    }
    // (e) Past-dated live kitchen assemblies (stale Unleashed).
    if (stalePastKitchen.length > 0) {
      auditLines.push(
        `  ${stalePastKitchen.length} live kitchen assembly(ies) scheduled before today — likely already produced; close out in Unleashed.`,
      );
    }
    // (f) Orphan live kitchen assemblies (no downstream consumer).
    if (orphanKitchenCount > 0) {
      auditLines.push(
        `  ${orphanKitchenCount} live kitchen assembly(ies) tagged ORPHAN (no current packaging consumer).`,
      );
    }
    // (g) Packaging SKUs missing profit data — they sort by a median-
    // profit heuristic and render as neutral grey-green on the calendar.
    const missingProfitSkus: string[] = [];
    for (const a of cappedActivities) {
      if (a.kind === 'packaging' && a.profitPerItem == null) {
        if (!missingProfitSkus.includes(a.productCode)) {
          missingProfitSkus.push(a.productCode);
        }
      }
    }
    if (missingProfitSkus.length > 0) {
      auditLines.push(
        `  ${missingProfitSkus.length} packaging SKU(s) missing profit data — see data/_profit-gaps-todo.tsv.`,
      );
    }
    // (h) Kitchen-required chips redundant with later Unleashed assemblies.
    const redundantWithUnleashedChips = kitchenRequiredActivities.filter(
      (a) => a.redundantWithUnleashed && a.redundantWithUnleashed.length > 0,
    );
    if (redundantWithUnleashedChips.length > 0) {
      auditLines.push(
        `  ${redundantWithUnleashedChips.length} kitchen-required chip(s) possibly REDUNDANT with later Unleashed assemblies — consider rescheduling in Unleashed instead of double-producing. First few: ${redundantWithUnleashedChips
          .slice(0, 5)
          .map((a) => {
            const first = a.redundantWithUnleashed![0];
            return `${a.productCode}@${a.date} (vs ${first.assembly}@${first.date})`;
          })
          .join(', ')}`,
      );
    }
    // (i) Kitchen-required chips scheduled more than 7 days ahead of
    // their `requiredByDate` — = unnecessary Lundberg storage. The new
    // gap engine should produce these only when capacity forces an
    // early walk-back; flagging them lets the user spot opportunities
    // to redistribute (e.g. raise minBatch, change preferredBatchSize,
    // or accept the storage cost).
    const tooEarlyChips = kitchenRequiredActivities.filter((a) => {
      if (!a.requiredByDate) return false;
      const lead = daysBetween(a.date, a.requiredByDate);
      return lead > 7;
    });
    if (tooEarlyChips.length > 0) {
      auditLines.push(
        `  ${tooEarlyChips.length} kitchen-required chip(s) scheduled >7d ahead of consumer (storage cost). First few: ${tooEarlyChips
          .slice(0, 5)
          .map(
            (a) =>
              `${a.productCode}@${a.date}→${a.requiredByDate} (${daysBetween(a.date, a.requiredByDate ?? a.date)}d lead)`,
          )
          .join(', ')}`,
      );
    }
    // (j) Packaging chips whose run size exceeds the SKU's 3-month
    // expected demand. The current maxBatchSize = station-daily-output
    // can let the DP pick a 1,600-unit run for an SKU whose 3-month
    // total is 300 — that's 13 months of carry. Flag the worst
    // offenders so we know which SKUs would benefit from a tighter
    // demand-aware cap. (Sized check uses weeklyDemandByProduct × 13
    // weeks ≈ 3 months.)
    const overproductionChips: Array<{
      code: string;
      date: string;
      qty: number;
      threeMonthDemand: number;
      ratio: number;
    }> = [];
    for (const a of cappedActivities) {
      if (a.kind !== 'packaging') continue;
      if (dismissedStableIds.has(a.stableId)) continue;
      const weekly = weeklyDemandByProduct.get(a.productCode);
      if (!weekly || weekly.length === 0) continue;
      const avgWeekly =
        weekly.reduce((s, w) => s + w.quantity, 0) / weekly.length;
      const threeMonthDemand = Math.round(avgWeekly * 13);
      if (threeMonthDemand <= 0) continue;
      if (a.quantity > threeMonthDemand) {
        overproductionChips.push({
          code: a.productCode,
          date: a.date,
          qty: a.quantity,
          threeMonthDemand,
          ratio: a.quantity / threeMonthDemand,
        });
      }
    }
    // Sort worst-offender first (highest ratio).
    overproductionChips.sort((x, y) => y.ratio - x.ratio);
    if (overproductionChips.length > 0) {
      auditLines.push(
        `  ${overproductionChips.length} packaging chip(s) sized > 3-month demand (potential overproduction; BOOKMARK: max-batch-vs-demand review). Worst offenders: ${overproductionChips
          .slice(0, 8)
          .map(
            (c) =>
              `${c.code}@${c.date} qty=${Math.round(c.qty)} vs ${c.threeMonthDemand}/3mo (${c.ratio.toFixed(1)}×)`,
          )
          .join(', ')}`,
      );
    }

    if (auditLines.length > 0) {
      console.warn(
        `\n[planner audit] data-quality issues this render:\n${auditLines.join('\n')}\n`,
      );
    }
  }

  return {
    horizon,
    activities: allActivities,
    dayLoads: projection.dayLoads,
    assembliesFetchedAt,
    kitchenActivityCount,
    kitchenRequiredCount,
    consumesMap,
    stationDailyMinutes,
    kitchenMinutesByProductCode,
    dehydratorTotalTrays,
    // Phase 4l.11: per-product weekly demand for the client-side
    // inventory-timeline computation that drives chip availability heat.
    // Map → plain object for the server-client boundary.
    // Phase 4l.12 — ship the FULL (pre-subtraction) forecast so the
    // sparkline doesn't double-count committed assemblies (which it
    // also renders as supply). See weeklyDemandFullByProduct above.
    weeklyDemandByProduct: Object.fromEntries(weeklyDemandFullByProduct),
    infeasibleProducts,
    routingDecisions,
    productOverrides,
    productStationDailyOutput,
    // Phase 4l.12 — product catalogue for the left-rail "Add to plan"
    // lookup. Two-tier construction:
    //
    //   Tier A (plannable): SKUs in `productMetaBySku` — the planner is
    //   allowed to schedule these. Driven by the finished-goods
    //   allowlist + family-sheet routing.
    //
    //   Tier B (draggable-only): SKUs the planner WON'T touch but the
    //   operator can still drop manually — anything with demand, a BOM,
    //   or a profit-data entry. Lets the user override the allowlist for
    //   one-off runs (e.g. MFRMIXNB11 has a BOM + demand but isn't on
    //   the allowlist; before this fix it was unsearchable). Station is
    //   derived the same way the allowlist auto-route does it:
    //   product-profit's plannerStation, else hand-packing.
    //
    // Tier A wins on duplicates so the planner's authoritative meta is
    // preserved when present.
    productCatalog: (() => {
      const out = new Map<
        string,
        {
          productCode: string;
          productName: string;
          station: 'hand-packing' | 'elephant' | 'dust' | 'bottlo';
          plannable: boolean;
        }
      >();
      // Tier A first — wins on duplicate keys.
      for (const [code, meta] of Object.entries(capacity.productMetaBySku)) {
        if (meta.station == null) continue;
        out.set(code, {
          productCode: code,
          productName: meta.productName || code,
          station: meta.station as 'hand-packing' | 'elephant' | 'dust' | 'bottlo',
          plannable: true,
        });
      }
      // Tier B — every code we have data for that isn't already in A.
      const draggableCandidates = new Set<string>();
      for (const code of Object.keys(allRates)) draggableCandidates.add(code);
      for (const code of bomParentCodes) draggableCandidates.add(code);
      if (productProfit) {
        for (const code of Object.keys(productProfit.byCode)) {
          draggableCandidates.add(code);
        }
      }
      // Best-effort productName lookup: BOM rows carry a `productName`
      // for the CHILD code. A SKU that's a BOM PARENT (e.g. MFRMIXNB11)
      // won't have its own name in any BOM row, only its children's
      // names. So we harvest child names and fall back to the bare code
      // for parent-only SKUs. The operator can edit the chip's name via
      // the drawer if it matters.
      const bomNameByCode = new Map<string, string>();
      for (const row of capacity.bom) {
        if (row.productName && !bomNameByCode.has(row.productCode)) {
          bomNameByCode.set(row.productCode, row.productName);
        }
      }
      for (const code of draggableCandidates) {
        if (out.has(code)) continue;
        const profitEntry = productProfit?.byCode[code] ?? null;
        const station: 'hand-packing' | 'elephant' | 'dust' | 'bottlo' =
          profitEntry?.plannerStation ?? 'hand-packing';
        out.set(code, {
          productCode: code,
          productName: bomNameByCode.get(code) || code,
          station,
          plannable: false,
        });
      }
      return Array.from(out.values());
    })(),
    sohByProductCode,
    sohFetchedAt,
    availableWarehouses,
    eligibleWarehouses: [...eligibleWarehouses],
    // Phase 4l.12 — intermediate-eligible warehouses, surfaced for the
    // drawer so an IGE/IAB chip shows "Lundberg ✓" rather than the
    // FG-fulfilment "Lundberg · excluded" label. These are the
    // warehouses the planner DOES sum for intermediate SOH (used in
    // `lundbergSohByCode` despite the name).
    intermediateEligibleWarehouses: [
      WAREHOUSES.LUNDBERG,
      WAREHOUSES.MF_PACKAGING,
      WAREHOUSES.MF_OPERATIONS,
    ] as const,
    // Per-intermediate effective initial SOH (= sum across the three
    // intermediate-eligible warehouses) — the number the kitchen-run
    // planner actually subtracted from cascaded demand when deciding
    // whether to schedule a run.
    intermediateSohByCode: lundbergSohByCode,
    initialInventoryByProduct,
    salesOrdersByProduct,
    committedByProduct,
    salesOrdersFetchedAt,
    totalSalesOrderLines,
    rawMaterialShortages,
    purchaseRequirements,
    vendorByCode,
    todayLocal,
    conflictInitialSohByCode: rawMaterialSohByCode,
    consumesQtyMap,
    yieldRateByCode,
    changeoverMatrix: capacity.changeoverMatrix,
    // Phase 4l.8: null when no override; non-null when ?from=... was set.
    // Drives the date-picker default in the header and signals the user
    // they're planning from a non-today anchor.
    planFromDate,
    globalDefaults: {
      shelfLifeDays: DEFAULT_SHELF_LIFE_DAYS,
    },
    summary: {
      productCount,
      feasibleCount,
      infeasibleCount: infeasibleProducts.length,
      totalChangeoverMinutes: totalChangeoverMin,
      orchestratorWarningCount: orchestratorOutput.warnings.length,
      dayAssignerWarningCount: dayOutput.warnings.length,
      capacityWarningCount: capacity.warnings.length,
      demandSourceMtime: dataAge,
    },
  };
}
