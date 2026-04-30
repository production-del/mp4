/**
 * Purchasing projection engine
 * Pure functional implementation for SOH projections
 *
 * Projects stock levels based on:
 * - Current stock on hand
 * - Consumption events (from production batches)
 * - Incoming purchase orders
 * - Lead times and supplier constraints
 */

import { BusinessCalendar } from "./business-calendar";
import type {
  DailySOHProjection,
  StockRisk,
  PurchasingProjectionResult,
  PurchaseOrderSchedule,
  KitchenBatch,
  ProjectionConfig,
} from "@/lib/planning/engine-io";

const DEFAULT_CONFIG: ProjectionConfig = {
  minStockThreshold: 10,
  lowStockDays: 7,
  leadTimeDays: 7,
  safetyStockDays: 3,
};

/**
 * Project stock on hand for a component over a date range
 *
 * @param componentCode - Product code to project
 * @param startSOH - Opening stock on hand
 * @param startDate - First projection date
 * @param endDate - Last projection date
 * @param batches - Kitchen batches that consume this component
 * @param incomingPOs - Scheduled purchase order deliveries
 * @param dailyConsumption - Daily consumption rates (optional, for forecasting)
 * @param calendar - Business calendar
 * @param config - Projection configuration
 * @returns Daily SOH projections
 */
export function projectComponentSOH(
  componentCode: string,
  startSOH: number,
  startDate: Date,
  endDate: Date,
  batches: KitchenBatch[],
  incomingPOs: PurchaseOrderSchedule[],
  dailyConsumption: number[] = [],
  calendar: BusinessCalendar,
  config: ProjectionConfig = DEFAULT_CONFIG,
  /** Monthly demand rate from CSV — when provided, overrides batch-derived consumption */
  demandRate?: number
): PurchasingProjectionResult {
  const projections: DailySOHProjection[] = [];
  const risks: StockRisk[] = [];

  // Daily consumption: prefer CSV demand rate over batch-derived events
  const dailyRate = demandRate && demandRate > 0 ? demandRate / 22 : 0;
  const useDemandRate = dailyRate > 0;

  // Build consumption map from batches (used only when no demand rate)
  const consumptionMap = new Map<string, number>();
  if (!useDemandRate) {
    for (const batch of batches) {
      const dateKey = getDateKey(batch.scheduledDate);
      const current = consumptionMap.get(dateKey) || 0;
      consumptionMap.set(dateKey, current + batch.quantity);
    }
  }

  // Build PO map: date -> quantity
  const poMap = new Map<string, number>();
  for (const po of incomingPOs) {
    const dateKey = getDateKey(po.deliveryDate);
    const current = poMap.get(dateKey) || 0;
    poMap.set(dateKey, current + po.quantity);
  }

  const avgDailyConsumption = useDemandRate
    ? dailyRate
    : dailyConsumption.length > 0
      ? dailyConsumption.reduce((a, b) => a + b, 0) / dailyConsumption.length
      : 0;

  let currentSOH = startSOH;
  const current = new Date(startDate);

  while (current <= endDate) {
    const dateKey = getDateKey(current);
    const isWorkday = calendar.isWorkingDay(current);

    // Consumption: demand rate on working days, or batch events
    const consumedQuantity = useDemandRate
      ? (isWorkday ? dailyRate : 0)
      : (consumptionMap.get(dateKey) || 0);

    const incomingQty = poMap.get(dateKey) || 0;

    const openingSOH = currentSOH;
    const closingSOH = openingSOH + incomingQty - consumedQuantity;
    const daysOfStock =
      avgDailyConsumption > 0
        ? Math.floor(closingSOH / avgDailyConsumption)
        : 0;

    // Only record for working days or days with activity
    if (isWorkday || consumedQuantity > 0 || incomingQty > 0) {
      projections.push({
        date: new Date(current),
        openingSOH,
        consumedQuantity,
        incomingPOs: incomingQty,
        closingSOH,
        daysOfStock,
      });
    }

    // Assess risks
    if (closingSOH <= 0) {
      risks.push({
        date: new Date(current),
        riskType: "stockout",
        message: `Projected stockout: -${Math.abs(Math.round(closingSOH))} units`,
        projectedSOH: closingSOH,
      });
    } else if (
      closingSOH > 0 &&
      closingSOH < config.minStockThreshold
    ) {
      risks.push({
        date: new Date(current),
        riskType: "low_stock",
        message: `Low stock: ${Math.round(closingSOH)} units (threshold: ${config.minStockThreshold})`,
        projectedSOH: closingSOH,
      });
    }

    currentSOH = closingSOH;
    current.setDate(current.getDate() + 1);
  }

  // Recommend purchase order
  const recommendedPO = calculateRecommendedPO(
    projections,
    risks,
    config,
    calendar
  );

  return {
    componentCode,
    projections,
    risks,
    recommendedPODate: recommendedPO.date,
    recommendedQuantity: recommendedPO.quantity,
  };
}

/**
 * Calculate recommended purchase order timing and quantity
 * @internal
 */
function calculateRecommendedPO(
  projections: DailySOHProjection[],
  risks: StockRisk[],
  config: ProjectionConfig,
  calendar: BusinessCalendar
): {
  date: Date | null;
  quantity: number;
} {
  // Find the first risk date
  const firstRisk = risks[0];
  if (!firstRisk) {
    return { date: null, quantity: 0 };
  }

  // Calculate PO date by subtracting lead time
  const poDate = calendar.addWorkingDays(
    firstRisk.date,
    -config.leadTimeDays
  );

  // Find the lowest SOH projection to calculate safety stock
  let minSOH = Infinity;
  for (const proj of projections) {
    minSOH = Math.min(minSOH, proj.closingSOH);
  }

  // Calculate quantity to bring us back to safe levels
  const safetyBuffer =
    projections.length > 0
      ? projections[0].openingSOH * config.safetyStockDays
      : 0;
  const quantity = Math.max(
    config.minStockThreshold,
    Math.ceil(safetyBuffer - minSOH)
  );

  return {
    date: poDate,
    quantity,
  };
}

/**
 * Calculate daysOfStock based on average consumption
 * @internal
 */
function calculateDaysOfStock(
  soh: number,
  projections: DailySOHProjection[]
): number {
  if (projections.length === 0) {
    return 0;
  }

  const totalConsumption = projections.reduce(
    (sum, p) => sum + p.consumedQuantity,
    0
  );
  const avgDaily = totalConsumption / projections.length;

  if (avgDaily === 0) {
    return Infinity;
  }

  return Math.floor(soh / avgDaily);
}

/**
 * Identify stockout risks in projections
 * @internal
 */
function identifyStockoutRisks(
  projections: DailySOHProjection[],
  config: ProjectionConfig
): StockRisk[] {
  const risks: StockRisk[] = [];

  for (const proj of projections) {
    if (proj.closingSOH < 0) {
      risks.push({
        date: proj.date,
        riskType: "stockout",
        message: `Stockout expected: ${Math.abs(proj.closingSOH)} units short`,
        projectedSOH: proj.closingSOH,
      });
    } else if (
      proj.closingSOH > 0 &&
      proj.closingSOH < config.minStockThreshold
    ) {
      risks.push({
        date: proj.date,
        riskType: "low_stock",
        message: `Low stock alert: ${proj.closingSOH} units (min: ${config.minStockThreshold})`,
        projectedSOH: proj.closingSOH,
      });
    }
  }

  return risks;
}

/**
 * Get date key in YYYY-MM-DD format
 * @internal
 */
function getDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Project multiple components simultaneously
 * Useful for understanding interactions between components
 */
export function projectMultipleComponents(
  components: Array<{
    code: string;
    soh: number;
  }>,
  startDate: Date,
  endDate: Date,
  batches: KitchenBatch[],
  posByComponent: Map<string, PurchaseOrderSchedule[]>,
  calendar: BusinessCalendar,
  /** Monthly demand rates from CSV — keyed by component code */
  demandRates?: Record<string, number>
): Map<string, PurchasingProjectionResult> {
  const results = new Map<string, PurchasingProjectionResult>();

  for (const component of components) {
    const pos = posByComponent.get(component.code) || [];
    const componentBatches = demandRates?.[component.code]
      ? [] // demand rate replaces batch-derived consumption
      : batches.filter(b => b.productCode === component.code);
    const result = projectComponentSOH(
      component.code,
      component.soh,
      startDate,
      endDate,
      componentBatches,
      pos,
      [],
      calendar,
      undefined,
      demandRates?.[component.code]
    );
    results.set(component.code, result);
  }

  return results;
}

/**
 * Calculate safety stock level based on consumption variability
 */
export function calculateSafetyStock(
  dailyConsumption: number[],
  leadTimeDays: number,
  serviceLevel: number = 0.95 // 95% service level
): number {
  if (dailyConsumption.length === 0) {
    return 0;
  }

  // Calculate mean
  const mean =
    dailyConsumption.reduce((a, b) => a + b, 0) / dailyConsumption.length;

  // Calculate standard deviation
  const variance =
    dailyConsumption.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) /
    dailyConsumption.length;
  const stdDev = Math.sqrt(variance);

  // Z-score for 95% service level
  const zScore = 1.65;

  // Safety stock = Z * StdDev * sqrt(lead time days)
  return Math.ceil(zScore * stdDev * Math.sqrt(leadTimeDays));
}
