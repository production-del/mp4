/**
 * End-to-end smoke test — exercises the full pipeline against the real
 * spreadsheet to catch contract drift between modules that unit tests miss.
 *
 * Pipeline:
 *   loadCapacityDataFromPath → forecastWeeklyDemand → orchestrateBatchPlan
 *
 * Doesn't make production-quality assertions about the output's optimality
 * — that's the job of unit tests on each module. This test is about
 * "everything fits together and produces sensible-shaped output for real data."
 */

import { join } from 'path';
import { loadCapacityDataFromPath } from '@/lib/planning/capacity-data';
import {
  forecastWeeklyDemand,
  defaultHorizon,
} from '@/lib/planning/forecast-demand';
import {
  orchestrateBatchPlan,
  type ProductPlan,
} from '@/lib/engine/optimiser-orchestrator';
import { explodeBom } from '@/lib/engine/bom-explode';

const SPREADSHEET = join(
  process.cwd(),
  'data',
  'kitchen capacity and family plans.xlsx',
);

describe('end-to-end: spreadsheet → forecast → orchestrate', () => {
  // One-shot loads — these tests don't mutate state.
  const capacity = loadCapacityDataFromPath(SPREADSHEET);
  const horizon = defaultHorizon(12, new Date('2026-05-04T00:00:00')); // anchored Monday

  // Pretend monthly demand for a representative slice. In production this
  // comes from /api/demand-data → demand.csv. Hand-picked SKUs that exercise
  // both family-clustering (FAM Fungi) and unmapped (null extFam) paths.
  const monthlyRates: Record<string, number> = {
    FCHAGALG: 200,    // FAM Fungi, station from XHBC intermediate
    FCHAGASM: 300,    // FAM Fungi, same family
    FCORDYLG: 150,    // FAM Fungi, different family
    MFWALNUME: 1000,  // FAM MF - Nuts
    MFGINGGSM: 50,    // unmapped extFam → fullClean
  };

  test('loader produces a non-empty CapacityData with all stations', () => {
    expect(capacity.stations).toHaveProperty('bottlo');
    expect(capacity.stations).toHaveProperty('hand-packing');
    expect(capacity.bom.length).toBeGreaterThan(2000);
    expect(Object.keys(capacity.familyMap).length).toBe(206);
  });

  test('forecaster bins rates into 12 weekly rows per product', () => {
    const forecast = forecastWeeklyDemand({
      monthlyRates,
      events: [],
      horizon,
    });
    const productCodes = new Set(forecast.map((r) => r.productCode));
    expect(productCodes.size).toBe(Object.keys(monthlyRates).length);
    // Each product gets exactly horizon.weeks rows
    for (const code of productCodes) {
      const rows = forecast.filter((r) => r.productCode === code);
      expect(rows).toHaveLength(horizon.weeks);
      // Weekly qty = monthlyRate × 12 / 52
      const expected = (monthlyRates[code] * 12) / 52;
      for (const r of rows) {
        expect(r.quantity).toBeCloseTo(expected, 4);
      }
    }
  });

  test('orchestrator produces a feasible schedule for the slice', () => {
    const forecast = forecastWeeklyDemand({
      monthlyRates,
      events: [],
      horizon,
    });

    const products: ProductPlan[] = Object.keys(monthlyRates).map((code) => {
      const meta = capacity.productMetaBySku[code];
      if (!meta) throw new Error(`No meta for ${code}`);
      const weeklyDemand = forecast
        .filter((r) => r.productCode === code)
        .map((r) => ({ weekStart: r.weekStart, quantity: r.quantity }));
      return {
        meta,
        weeklyDemand,
        initialInventory: 0,
        shelfLifeDays: 90,
        minBatchSize: 50,
        maxBatchSize: 5000,
        step: 10,
      };
    });

    const result = orchestrateBatchPlan({
      products,
      changeoverMatrix: capacity.changeoverMatrix,
    });

    // Every product feasible
    for (const code of Object.keys(monthlyRates)) {
      const r = result.perProduct.get(code);
      expect(r).toBeDefined();
      expect(r!.feasible).toBe(true);
    }

    // Some batches actually scheduled
    const totalBatches = Array.from(result.perProduct.values()).reduce(
      (s, r) => s + r.batches.length,
      0,
    );
    expect(totalBatches).toBeGreaterThan(0);

    // Total changeover minutes is finite and non-negative
    expect(Number.isFinite(result.totalChangeoverMinutes)).toBe(true);
    expect(result.totalChangeoverMinutes).toBeGreaterThanOrEqual(0);

    // No infeasibility warnings for our slice
    const infeasWarnings = result.warnings.filter((w) => w.kind === 'product_infeasible');
    expect(infeasWarnings).toEqual([]);
  });

  test('BOM exploder runs against real BOMs without throwing', () => {
    // FCHAGALG is one of the simpler finished goods — direct components only.
    const r = explodeBom({
      rootProductCode: 'FCHAGALG',
      rootQuantity: 100,
      bom: capacity.bom,
      familyMap: capacity.familyMap,
    });
    expect(r.warnings).toEqual([]);
    // FCHAGALG includes XHBC, JAR1000, LID82, STRIPSD, label, box-large
    expect(r.components.length).toBeGreaterThanOrEqual(5);
    const xhbc = r.components.find((c) => c.productCode === 'XHBC');
    expect(xhbc).toBeDefined();
    // 100 units × 0.45 BOM ratio
    expect(xhbc!.totalQuantity).toBeCloseTo(45, 6);
  });

  test('exploder propagates per-edge wastage from the loader for known parents', () => {
    // MFBLCUMSM/BLCUM has clean 0.12 / wastage 0.02 in the wastage tab.
    // Asking for 100 units should produce clean 12, wastage 2 of BLCUM.
    const r = explodeBom({
      rootProductCode: 'MFBLCUMSM',
      rootQuantity: 100,
      bom: capacity.bom,
      familyMap: capacity.familyMap,
    });
    const blcum = r.components.find((c) => c.productCode === 'BLCUM');
    if (blcum) {
      expect(blcum.cleanQuantity).toBeCloseTo(12, 6);
      expect(blcum.wastageQuantity).toBeCloseTo(2, 6);
    }
  });

  test('family-clustering emerges on bottlo for the FAM Fungi slice', () => {
    // Three FAM Fungi products on bottlo (FCHAGALG, FCHAGASM, FCORDYLG)
    // should incur lower per-changeover cost than the matrix's fullClean (120).
    const forecast = forecastWeeklyDemand({
      monthlyRates: {
        FCHAGALG: 200,
        FCHAGASM: 300,
        FCORDYLG: 150,
      },
      events: [],
      horizon,
    });
    const products: ProductPlan[] = ['FCHAGALG', 'FCHAGASM', 'FCORDYLG'].map((code) => {
      const meta = capacity.productMetaBySku[code];
      const weeklyDemand = forecast
        .filter((r) => r.productCode === code)
        .map((r) => ({ weekStart: r.weekStart, quantity: r.quantity }));
      return {
        meta,
        weeklyDemand,
        initialInventory: 0,
        shelfLifeDays: 14, // forces multiple runs
        minBatchSize: 50,
        maxBatchSize: 5000,
        step: 10,
      };
    });
    const result = orchestrateBatchPlan({
      products,
      changeoverMatrix: capacity.changeoverMatrix,
    });
    // All three are FAM Fungi → no fullClean (120) should ever appear on bottlo
    // when these are scheduled adjacent.
    const bottlo = result.perStation.get('bottlo')!;
    if (bottlo.batches.length >= 2) {
      const fullCleans = bottlo.changeovers.filter((c) => c.costMinutes === 120);
      expect(fullCleans).toHaveLength(0);
    }
  });
});
