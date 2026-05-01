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
import { CalendarApp } from './CalendarApp';

export const dynamic = 'force-dynamic'; // Always re-run; calendar reflects latest data

const SPREADSHEET = join(process.cwd(), 'data', 'kitchen capacity and family plans.xlsx');
const DEFAULT_SHELF_LIFE_DAYS = 90; // Conservative default; per-product overrides come later
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

export default function CalendarPage() {
  let pageError: string | null = null;
  let payload: Awaited<ReturnType<typeof buildPayload>> | null = null;

  try {
    payload = buildPayload();
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

  return <CalendarApp {...payload} />;
}

function buildPayload() {
  const capacity = loadCapacityDataFromPath(SPREADSHEET);
  const demandData = loadMonthlyDemand();
  const horizon = defaultHorizon(12, new Date());

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

  // Per-product routing decisions, keyed by productCode → routed-station + rationale.
  // Surfaced in the activity drawer so the user can see WHY each product
  // landed where it did.
  const routingByProduct = new Map<string, { station: string; rationale: string }>();

  const products: ProductPlan[] = Object.keys(monthlyRates).map((code) => {
    const baseMeta = capacity.productMetaBySku[code];
    const weeklyDemand = forecast
      .filter((r) => r.productCode === code)
      .map((r) => ({ weekStart: r.weekStart, quantity: r.quantity }));
    const totalDemand = weeklyDemand.reduce((s, w) => s + w.quantity, 0);

    // Build candidate set from spreadsheet's primary + alternate. The
    // station-router picks the cost-efficient choice — so a product with
    // bottlo as alternate may land on bottlo if its volume × throughput
    // beats the primary's slower-but-cheaper-to-switch option.
    const intermediate = capacity.intermediates.get(baseMeta.family ?? '');
    const candidates: string[] = [];
    if (intermediate?.packingStation) candidates.push(intermediate.packingStation);
    if (intermediate?.alternateStation && intermediate.alternateStation !== intermediate.packingStation) {
      candidates.push(intermediate.alternateStation);
    }
    if (candidates.length === 0) candidates.push(baseMeta.station); // fallback
    const decision = chooseEfficientStation({
      productCode: code,
      candidateStations: candidates as Parameters<typeof chooseEfficientStation>[0]['candidateStations'],
      totalHorizonDemand: totalDemand,
      extendedFamily: baseMeta.extendedFamily,
      stationDefaults: capacity.stations,
      changeoverMatrix: capacity.changeoverMatrix,
    });
    routingByProduct.set(code, { station: decision.station, rationale: decision.rationale });

    // Re-derive station defaults from the chosen station (may differ from primary).
    const chosenMeta = {
      ...baseMeta,
      station: decision.station,
      rateUnitsPerHour:
        capacity.stations[decision.station]?.unitsPerHour ?? baseMeta.rateUnitsPerHour,
    };
    const station = capacity.stations[decision.station];
    const maxBatch = station
      ? dailyStationOutput(station.unitsPerHour, station.hoursPerDay)
      : 1500;
    return {
      meta: chosenMeta,
      weeklyDemand,
      initialInventory: 0,
      shelfLifeDays: DEFAULT_SHELF_LIFE_DAYS,
      minBatchSize: DEFAULT_MIN_BATCH,
      maxBatchSize: maxBatch,
      step: STEP,
    };
  });

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

  return {
    horizon,
    activities: projection.activities,
    dayLoads: projection.dayLoads,
    stationDailyMinutes,
    infeasibleProducts,
    routingDecisions,
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
