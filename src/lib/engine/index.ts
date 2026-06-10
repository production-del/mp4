/**
 * Engine public API.
 *
 * Consumers import from `@/lib/engine` and never reach into individual
 * files. This barrel draws the boundary between the engine's
 * implementation and its contract.
 *
 * Two flavours of API are exported:
 *
 * 1. In-memory functions (`analyzeKitchenBatches`, `projectComponentSOH`,
 *    …). These take and return Date-bearing objects and are what the UI
 *    currently uses.
 *
 * 2. JSON/wire functions (`runKitchenProjectionFromJSON`, …). These take
 *    and return JSON-safe wire types with ISO date strings. They are the
 *    exact contract a Python FastAPI service would expose. Use them in
 *    tests to prove the wire format round-trips, or at integration points
 *    when the engine moves out of process.
 *
 * Types are re-exported from `@/lib/planning/engine-io`: the engine's
 * cross-boundary contract lives with the rest of the planning types.
 */

// ─── In-memory engine functions ──────────────────────────────

export {
  analyzeKitchenBatches,
  canChainBatches,
  getProductionTimeline,
  calculateCriticalPath,
} from './kitchen-projection';

export {
  projectComponentSOH,
  projectMultipleComponents,
  calculateSafetyStock,
} from './purchasing-projection';

export {
  detectTransferGaps,
  extractKitchenDemands,
  extractKitchenDemandsFromSchedule,
  type KitchenDemandItem,
  type PackagingDemandItem,
} from './transfer-detection';

export {
  diffFeasibility,
  buildFeasibilitySnapshot,
  type FeasibilitySnapshot,
} from './feasibility-diff';

export {
  BusinessCalendar,
  createDefaultBusinessCalendar,
  type Holiday,
} from './business-calendar';

// ─── Priority scoring (the unified contention ranking key) ───

export {
  scoreAssembly,
  criticalRatioUrgency,
  stockoutRisk,
  DEFAULT_WEIGHTS,
  DEFAULT_ABILITY_FLOORS,
  RECOMMENDED_ABILITY_FLOORS,
} from './priority-score';

export type {
  ScoreWeights,
  AbilityFloors,
  ScoreAssemblyInput,
  ScoreBreakdown,
  ScoreFactor,
  DominantFactor,
  AbilityBinding,
} from './priority-score';

// ─── Engine I/O types ────────────────────────────────────────

export type {
  KitchenBatch,
  BOMComponent,
  SOHItem,
  PurchaseOrderSchedule,
  BatchFeasibility,
  FeasibilityState,
  ComponentShortfall,
  KitchenProjectionInput,
  KitchenProjectionResult,
  BatchTimeline,
  PurchasingProjectionInput,
  DailySOHProjection,
  PurchasingProjectionResult,
  StockRisk,
  IntermediateComponent,
  ProjectionConfig,
} from '@/lib/planning/engine-io';

// ─── Wire (JSON) types + round-trip helpers ──────────────────

export type {
  KitchenBatchWire,
  PurchaseOrderScheduleWire,
  BusinessCalendarWire,
  KitchenProjectionRequest,
  KitchenProjectionResponse,
  BatchFeasibilityWire,
  BatchTimelineWire,
  PurchasingProjectionRequest,
  PurchasingProjectionResponse,
  DailySOHProjectionWire,
  StockRiskWire,
} from './serialization';

export {
  toWireBatch,
  fromWireBatch,
  toWirePOSchedule,
  fromWirePOSchedule,
  toWireCalendar,
  fromWireCalendar,
  toWireKitchenRequest,
  fromWireKitchenRequest,
  toWireKitchenResponse,
  fromWireKitchenResponse,
  toWirePurchasingRequest,
  fromWirePurchasingRequest,
  toWirePurchasingResponse,
  fromWirePurchasingResponse,
  // "As if a Python service ran it" wrappers:
  runKitchenProjectionFromJSON,
  runPurchasingProjectionFromJSON,
} from './serialization';
