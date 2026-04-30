/**
 * Engine serialization — JSON-safe wire types and round-trip helpers.
 *
 * The in-memory engine types in `lib/planning/engine-io.ts` carry `Date`
 * objects for ergonomic arithmetic. `Date` is not JSON-safe (it serializes
 * to a UTC ISO string but deserializes back as a string, not a Date). If the
 * engine ever moves to a separate service — Python FastAPI being the most
 * plausible candidate — every cross-process call has to be JSON.
 *
 * This module defines:
 *   1. Wire-shape types: every `Date` replaced with a local ISO string
 *      (`YYYY-MM-DD`). Structurally identical otherwise.
 *   2. Round-trip converters: `toWire*` / `fromWire*` pairs that move between
 *      in-memory and wire shapes.
 *   3. "Run-as-a-service" wrappers: functions that accept a wire request and
 *      return a wire response, mimicking exactly what a Python endpoint
 *      would expose. Use these in tests to prove the contract is clean; use
 *      them at integration points when a remote engine is introduced.
 *
 * Nothing in this file touches the DOM, React, or localStorage. It's pure
 * data transformation so it can move into a Node worker, a Cloudflare
 * Worker, or a Python service without any refactor.
 */

import type {
  KitchenBatch,
  SOHItem,
  BOMComponent,
  KitchenProjectionInput,
  KitchenProjectionResult,
  BatchFeasibility,
  BatchTimeline,
  PurchaseOrderSchedule,
  PurchasingProjectionInput,
  PurchasingProjectionResult,
  DailySOHProjection,
  StockRisk,
} from '@/lib/planning/engine-io';
import { toLocalISODate, fromLocalISODate } from '@/lib/planning/working-day';
import { BusinessCalendar, type Holiday } from './business-calendar';
import { analyzeKitchenBatches } from './kitchen-projection';
import { projectComponentSOH } from './purchasing-projection';

// ─── Wire types (JSON-safe) ──────────────────────────────────

/** Same as `KitchenBatch` but with `scheduledDate` as local-ISO. */
export interface KitchenBatchWire {
  id: string;
  productCode: string;
  productName: string;
  quantity: number;
  scheduledDate: string;
  status: KitchenBatch['status'];
  dependencies: string[];
}

export interface PurchaseOrderScheduleWire {
  poId: string;
  deliveryDate: string;
  quantity: number;
  received: boolean;
}

/**
 * Holidays are the only thing `BusinessCalendar` carries across the boundary
 * that has `Date` fields. Wire form carries them as ISO strings plus the
 * calendar's class isn't serializable at all — instead callers send a list
 * of holiday dates and the service rebuilds a fresh `BusinessCalendar`.
 */
export interface BusinessCalendarWire {
  holidays: Array<{ date: string; name: string; recurring?: boolean }>;
}

export interface KitchenProjectionRequest {
  batches: KitchenBatchWire[];
  boms: BOMComponent[];
  soh: SOHItem[];
  globalSOH?: SOHItem[];
  calendar: BusinessCalendarWire;
}

export interface BatchFeasibilityWire extends Omit<BatchFeasibility, never> {
  // BatchFeasibility is already JSON-safe — no Date fields.
}

export interface BatchTimelineWire {
  batchId: string;
  productCode: string;
  date: string;
  event: BatchTimeline['event'];
  notes: string;
}

export interface KitchenProjectionResponse {
  batches: BatchFeasibilityWire[];
  aggregated: KitchenProjectionResult['aggregated'];
  timeline: BatchTimelineWire[];
}

export interface PurchasingProjectionRequest {
  componentCode: string;
  batches: KitchenBatchWire[];
  soh: number;
  dailyConsumption: number[];
  existingPOs: PurchaseOrderScheduleWire[];
  calendar: BusinessCalendarWire;
}

export interface DailySOHProjectionWire {
  date: string;
  openingSOH: number;
  consumedQuantity: number;
  incomingPOs: number;
  closingSOH: number;
  daysOfStock: number;
}

export interface StockRiskWire {
  date: string;
  riskType: StockRisk['riskType'];
  message: string;
  projectedSOH: number;
}

export interface PurchasingProjectionResponse {
  componentCode: string;
  projections: DailySOHProjectionWire[];
  risks: StockRiskWire[];
  recommendedPODate: string | null;
  recommendedQuantity: number;
}

// ─── Converters: in-memory ↔ wire ────────────────────────────

export function toWireBatch(b: KitchenBatch): KitchenBatchWire {
  return { ...b, scheduledDate: toLocalISODate(b.scheduledDate) };
}

export function fromWireBatch(w: KitchenBatchWire): KitchenBatch {
  return { ...w, scheduledDate: fromLocalISODate(w.scheduledDate) };
}

export function toWirePOSchedule(p: PurchaseOrderSchedule): PurchaseOrderScheduleWire {
  return { ...p, deliveryDate: toLocalISODate(p.deliveryDate) };
}

export function fromWirePOSchedule(w: PurchaseOrderScheduleWire): PurchaseOrderSchedule {
  return { ...w, deliveryDate: fromLocalISODate(w.deliveryDate) };
}

export function toWireCalendar(cal: BusinessCalendar): BusinessCalendarWire {
  // BusinessCalendar stores internal Holiday objects in a private map. We
  // export whatever the calendar currently considers a holiday as a list of
  // ISO dates. The wire form is consumed by `fromWireCalendar`, which
  // constructs a fresh `BusinessCalendar` — no internal-state exposure.
  const holidays: Array<{ date: string; name: string; recurring?: boolean }> = [];
  // Private access via casting — acceptable for serialization boundary.
  const internal = cal as unknown as { holidayMap: Map<string, Holiday> };
  for (const h of internal.holidayMap.values()) {
    holidays.push({
      date: toLocalISODate(h.date),
      name: h.name,
      recurring: h.recurring,
    });
  }
  return { holidays };
}

export function fromWireCalendar(w: BusinessCalendarWire): BusinessCalendar {
  const holidays: Holiday[] = w.holidays.map((h) => ({
    date: fromLocalISODate(h.date),
    name: h.name,
    recurring: h.recurring,
  }));
  return new BusinessCalendar(holidays);
}

export function toWireKitchenRequest(input: KitchenProjectionInput): KitchenProjectionRequest {
  return {
    batches: input.batches.map(toWireBatch),
    boms: input.boms,
    soh: input.soh,
    globalSOH: input.globalSOH,
    calendar: toWireCalendar(input.businessCalendar),
  };
}

export function fromWireKitchenRequest(req: KitchenProjectionRequest): KitchenProjectionInput {
  return {
    batches: req.batches.map(fromWireBatch),
    boms: req.boms,
    soh: req.soh,
    globalSOH: req.globalSOH,
    businessCalendar: fromWireCalendar(req.calendar),
  };
}

export function toWireKitchenResponse(result: KitchenProjectionResult): KitchenProjectionResponse {
  return {
    batches: result.batches,
    aggregated: result.aggregated,
    timeline: result.timeline.map((t) => ({
      batchId: t.batchId,
      productCode: t.productCode,
      date: toLocalISODate(t.date),
      event: t.event,
      notes: t.notes,
    })),
  };
}

export function fromWireKitchenResponse(res: KitchenProjectionResponse): KitchenProjectionResult {
  return {
    batches: res.batches,
    aggregated: res.aggregated,
    timeline: res.timeline.map((t) => ({
      batchId: t.batchId,
      productCode: t.productCode,
      date: fromLocalISODate(t.date),
      event: t.event,
      notes: t.notes,
    })),
  };
}

export function toWirePurchasingRequest(
  input: PurchasingProjectionInput,
): PurchasingProjectionRequest {
  return {
    componentCode: input.componentCode,
    batches: input.batches.map(toWireBatch),
    soh: input.soh,
    dailyConsumption: input.dailyConsumption,
    existingPOs: input.existingPOs.map(toWirePOSchedule),
    calendar: toWireCalendar(input.businessCalendar),
  };
}

export function fromWirePurchasingRequest(
  req: PurchasingProjectionRequest,
): PurchasingProjectionInput {
  return {
    componentCode: req.componentCode,
    batches: req.batches.map(fromWireBatch),
    soh: req.soh,
    dailyConsumption: req.dailyConsumption,
    existingPOs: req.existingPOs.map(fromWirePOSchedule),
    businessCalendar: fromWireCalendar(req.calendar),
  };
}

export function toWirePurchasingResponse(
  result: PurchasingProjectionResult,
): PurchasingProjectionResponse {
  return {
    componentCode: result.componentCode,
    projections: result.projections.map((p) => ({
      date: toLocalISODate(p.date),
      openingSOH: p.openingSOH,
      consumedQuantity: p.consumedQuantity,
      incomingPOs: p.incomingPOs,
      closingSOH: p.closingSOH,
      daysOfStock: p.daysOfStock,
    })),
    risks: result.risks.map((r) => ({
      date: toLocalISODate(r.date),
      riskType: r.riskType,
      message: r.message,
      projectedSOH: r.projectedSOH,
    })),
    recommendedPODate: result.recommendedPODate ? toLocalISODate(result.recommendedPODate) : null,
    recommendedQuantity: result.recommendedQuantity,
  };
}

export function fromWirePurchasingResponse(
  res: PurchasingProjectionResponse,
): PurchasingProjectionResult {
  return {
    componentCode: res.componentCode,
    projections: res.projections.map((p) => ({
      date: fromLocalISODate(p.date),
      openingSOH: p.openingSOH,
      consumedQuantity: p.consumedQuantity,
      incomingPOs: p.incomingPOs,
      closingSOH: p.closingSOH,
      daysOfStock: p.daysOfStock,
    })),
    risks: res.risks.map((r) => ({
      date: fromLocalISODate(r.date),
      riskType: r.riskType,
      message: r.message,
      projectedSOH: r.projectedSOH,
    })),
    recommendedPODate: res.recommendedPODate ? fromLocalISODate(res.recommendedPODate) : null,
    recommendedQuantity: res.recommendedQuantity,
  };
}

// ─── Run-as-a-service wrappers ────────────────────────────────

/**
 * Run the kitchen projection as a Python FastAPI endpoint would:
 * accept a JSON wire request, return a JSON wire response. The in-memory
 * engine functions don't change; this wrapper rehydrates/dehydrates at the
 * boundary.
 *
 * A future swap to a remote service replaces this function's body with a
 * `fetch('/engine/kitchen-projection', { body: JSON.stringify(req) })` call;
 * the contract stays identical.
 */
export function runKitchenProjectionFromJSON(
  req: KitchenProjectionRequest,
): KitchenProjectionResponse {
  const input = fromWireKitchenRequest(req);
  const result = analyzeKitchenBatches(input);
  return toWireKitchenResponse(result);
}

/**
 * Same contract as `runKitchenProjectionFromJSON` but for a single-component
 * purchasing projection.
 */
export function runPurchasingProjectionFromJSON(
  req: PurchasingProjectionRequest,
): PurchasingProjectionResponse {
  const input = fromWirePurchasingRequest(req);
  // Signature requires blockStart/blockEnd as Dates — derive from first
  // batch/earliest consumption day so the wrapper stays a pure function of
  // the wire input. Callers that want explicit block dates should pass a
  // daily-consumption vector that already covers the target window.
  const firstDate = input.batches.length > 0 ? input.batches[0].scheduledDate : new Date();
  const lastDate = input.batches.length > 0
    ? input.batches[input.batches.length - 1].scheduledDate
    : new Date(firstDate.getTime() + 30 * 24 * 60 * 60 * 1000);
  const result = projectComponentSOH(
    input.componentCode,
    input.soh,
    firstDate,
    lastDate,
    input.batches,
    input.existingPOs,
    input.dailyConsumption,
    input.businessCalendar,
  );
  return toWirePurchasingResponse(result);
}
