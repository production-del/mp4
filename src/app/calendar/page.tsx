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
import { CalendarApp } from './CalendarApp';

export const dynamic = 'force-dynamic'; // Always re-run; calendar reflects latest data

const SPREADSHEET = join(process.cwd(), 'data', 'kitchen capacity and family plans.xlsx');
const DEFAULT_SHELF_LIFE_DAYS = 90; // Conservative default; per-product overrides come later
const DEFAULT_MIN_BATCH = 50;
const DEFAULT_MAX_BATCH = 5000;
const STEP = 10;

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

  const products: ProductPlan[] = Object.keys(monthlyRates).map((code) => {
    const meta = capacity.productMetaBySku[code];
    const weeklyDemand = forecast
      .filter((r) => r.productCode === code)
      .map((r) => ({ weekStart: r.weekStart, quantity: r.quantity }));
    return {
      meta,
      weeklyDemand,
      initialInventory: 0,
      shelfLifeDays: DEFAULT_SHELF_LIFE_DAYS,
      minBatchSize: DEFAULT_MIN_BATCH,
      maxBatchSize: DEFAULT_MAX_BATCH,
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

  // Build summary banner data.
  const productCount = products.length;
  const feasibleCount = Array.from(orchestratorOutput.perProduct.values()).filter(
    (r) => r.feasible,
  ).length;
  const infeasibleCount = productCount - feasibleCount;
  const totalChangeoverMin = orchestratorOutput.totalChangeoverMinutes;
  const dataAge = demandData?.sourceMtime ?? null;

  return {
    horizon,
    activities: projection.activities,
    dayLoads: projection.dayLoads,
    summary: {
      productCount,
      feasibleCount,
      infeasibleCount,
      totalChangeoverMinutes: totalChangeoverMin,
      orchestratorWarningCount: orchestratorOutput.warnings.length,
      dayAssignerWarningCount: dayOutput.warnings.length,
      capacityWarningCount: capacity.warnings.length,
      demandSourceMtime: dataAge,
    },
  };
}
