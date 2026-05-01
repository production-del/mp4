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
import { loadCapacityDataFromPath } from '@/lib/planning/capacity-data';
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
import { CalendarApp } from './CalendarApp';

export const dynamic = 'force-dynamic'; // Always re-run; calendar reflects latest data

/** Horizon options surfaced in the UI picker. 26 weeks ≈ 6 months — the cap. */
const HORIZON_WEEK_OPTIONS = [12, 16, 20, 26] as const;
const DEFAULT_HORIZON_WEEKS = 12;
/**
 * Default warehouse the calendar treats as "where finished-good packaging
 * stock lives." MF Packaging is where SKUs ship from; counting Lundberg or
 * other warehouses' stock would inflate initialInventory and produce wrong
 * plans. Operator can override via the warehouse picker.
 */
const DEFAULT_PLANNING_WAREHOUSE = 'MF Packaging';

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
  searchParams: Promise<{ horizonWeeks?: string; warehouse?: string }>;
}) {
  // Picker state is URL-driven so the choice survives reloads.
  const params = await searchParams;
  const requested = Number(params.horizonWeeks);
  const horizonWeeks = HORIZON_WEEK_OPTIONS.find((n) => n === requested)
    ?? DEFAULT_HORIZON_WEEKS;
  const planningWarehouse =
    typeof params.warehouse === 'string' && params.warehouse.length > 0
      ? params.warehouse
      : DEFAULT_PLANNING_WAREHOUSE;

  let pageError: string | null = null;
  let payload: Awaited<ReturnType<typeof buildPayload>> | null = null;

  try {
    payload = buildPayload(horizonWeeks, planningWarehouse);
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

function buildPayload(horizonWeeks: number, planningWarehouse: string) {
  const capacity = loadCapacityDataFromPath(SPREADSHEET);
  const demandData = loadMonthlyDemand();
  const horizon = defaultHorizon(horizonWeeks, new Date());

  // Limit to SKUs that have BOTH a demand rate AND a productMeta we can route
  // to a station. Avoids cluttering the calendar with SKUs we can't actually
  // schedule (e.g. discontinued products without a packing station).
  const allRates = demandData?.rates ?? {};
  const monthlyRates: Record<string, number> = {};
  for (const [code, rate] of Object.entries(allRates)) {
    if (rate > 0 && capacity.productMetaBySku[code]) {
      monthlyRates[code] = rate;
    }
  }

  const forecast = forecastWeeklyDemand({
    monthlyRates,
    events: [],
    horizon,
  });

  // ─── Pass 1: per-product cost-efficient routing ──────────
  // For each SKU, pick the lowest-cost station from its candidate set
  // (primary + alternate, per the spreadsheet's Kitchen processes sheet).
  // The router is per-product independent — the load balancer (pass 2)
  // refines based on cross-product station load.
  const initialRoutings: ProductRouting[] = [];
  const initialRationales = new Map<string, string>();
  const weeklyDemandByProduct = new Map<string, { weekStart: string; quantity: number }[]>();

  for (const code of Object.keys(monthlyRates)) {
    const baseMeta = capacity.productMetaBySku[code];
    const weeklyDemand = forecast
      .filter((r) => r.productCode === code)
      .map((r) => ({ weekStart: r.weekStart, quantity: r.quantity }));
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

  // Stock-on-hand cache — produced by /api/refresh-soh from Unleashed.
  // Read on each render; null when the cache file is missing (planner falls
  // back to 0 for every product, matching pre-4g behaviour).
  const sohCache = readSohCache();

  // Build the ProductPlan list using the balanced routing decisions.
  const products: ProductPlan[] = balanced.routings.map((r) => {
    const baseMeta = capacity.productMetaBySku[r.productCode];
    const weeklyDemand = weeklyDemandByProduct.get(r.productCode) ?? [];
    const chosenMeta = {
      ...baseMeta,
      station: r.currentStation,
      rateUnitsPerHour:
        capacity.stations[r.currentStation]?.unitsPerHour ?? baseMeta.rateUnitsPerHour,
    };
    const station = capacity.stations[r.currentStation];
    const stationMaxBatch = station
      ? dailyStationOutput(station.unitsPerHour, station.hoursPerDay)
      : 1500;
    const resolved = resolveOverride(productOverrides, r.productCode, {
      shelfLifeDays: DEFAULT_SHELF_LIFE_DAYS,
      maxBatchSize: stationMaxBatch,
    });
    return {
      meta: chosenMeta,
      weeklyDemand,
      initialInventory: sohOf(sohCache, r.productCode, planningWarehouse),
      shelfLifeDays: resolved.shelfLifeDays,
      minBatchSize: DEFAULT_MIN_BATCH,
      maxBatchSize: resolved.maxBatchSize,
      step: STEP,
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

  // Per-product station daily output (for drawer's max-batch default helper).
  const productStationDailyOutput: Record<string, number> = {};
  for (const r of balanced.routings) {
    const s = capacity.stations[r.currentStation];
    if (s) productStationDailyOutput[r.productCode] = dailyStationOutput(s.unitsPerHour, s.hoursPerDay);
  }

  // Pass per-warehouse SOH to the client. The drawer renders the breakdown
  // (and the planning warehouse's number specifically); the warehouse picker
  // uses `availableWarehouses` to populate options.
  const sohByProductCode: Record<string, Record<string, number>> = sohCache
    ? sohCache.byProductCode
    : {};
  const sohFetchedAt: string | null = sohCache?.fetchedAt ?? null;
  const availableWarehouses: string[] = sohCache?.warehouses ?? [];
  // Per-product effective initial inventory — what the planner actually used.
  const initialInventoryByProduct: Record<string, number> = {};
  for (const r of balanced.routings) {
    initialInventoryByProduct[r.productCode] = sohOf(
      sohCache,
      r.productCode,
      planningWarehouse,
    );
  }
  // Avoid TS unused warning while leaving the helper imported for tests.
  void sohBreakdownOf;

  return {
    horizon,
    activities: projection.activities,
    dayLoads: projection.dayLoads,
    stationDailyMinutes,
    infeasibleProducts,
    routingDecisions,
    productOverrides,
    productStationDailyOutput,
    sohByProductCode,
    sohFetchedAt,
    availableWarehouses,
    planningWarehouse,
    initialInventoryByProduct,
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
