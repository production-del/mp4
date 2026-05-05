/**
 * Planning run infrastructure
 * Manages planning cycles with UUID tracking and status management
 */

import { randomUUID } from "crypto";
import type {
  PlanningRun,
  PlanningRunStatus,
  AuditEvent,
  AuditEventType,
  ExternalReference,
  PlanRef,
} from "./types";

/**
 * Create a new planning run
 * @param createdBy - User or system identifier
 * @param notes - Optional notes about the planning run
 * @returns New planning run with generated UUID and external ID
 */
export function createPlanningRun(
  createdBy: string,
  notes?: string
): PlanningRun {
  const id = randomUUID();
  const now = new Date();

  return {
    id,
    externalId: generateExternalId(id),
    createdAt: now,
    createdBy,
    status: "not_started",
    planTypes: {
      kitchen: {
        planId: randomUUID(),
        externalId: generatePlanExternalId(id, "kitchen", 1),
        status: "not_started",
        batches: 0,
        lastModified: now,
      },
      purchasing: {
        planId: randomUUID(),
        externalId: generatePlanExternalId(id, "purchasing", 1),
        status: "not_started",
        batches: 0,
        lastModified: now,
      },
    },
    notes,
    auditTrail: [
      {
        timestamp: now,
        eventType: "created",
        actor: createdBy,
        message: "Planning run created",
      },
    ],
  };
}

/**
 * Generate human-readable external ID for a planning run
 * Format: {runId} (short UUID)
 */
function generateExternalId(runId: string): string {
  return runId.slice(0, 8).toUpperCase();
}

/**
 * Generate external ID for a plan within a planning run
 * Format: {runId}-{type}-{sequence}
 * Example: 550e8400-kitchen-001
 */
function generatePlanExternalId(
  runId: string,
  type: "kitchen" | "purchasing",
  sequence: number
): string {
  const shortId = runId.slice(0, 8).toUpperCase();
  return `${shortId}-${type}-${String(sequence).padStart(3, "0")}`;
}

/**
 * Update planning run status
 */
export function updatePlanningRunStatus(
  run: PlanningRun,
  status: PlanningRunStatus,
  actor: string,
  message: string
): PlanningRun {
  const now = new Date();

  return {
    ...run,
    status,
    auditTrail: [
      ...run.auditTrail,
      {
        timestamp: now,
        eventType: "reviewed",
        actor,
        message,
      },
    ],
  };
}

/**
 * Update plan status within a planning run
 */
export function updatePlanStatus(
  run: PlanningRun,
  planType: "kitchen" | "purchasing",
  status: PlanningRunStatus,
  actor: string,
  message: string,
  batches?: number
): PlanningRun {
  const now = new Date();
  const plan = run.planTypes[planType];

  return {
    ...run,
    planTypes: {
      ...run.planTypes,
      [planType]: {
        ...plan,
        status,
        batches: batches || plan.batches,
        lastModified: now,
      },
    },
    auditTrail: [
      ...run.auditTrail,
      {
        timestamp: now,
        eventType: "analyzed",
        actor,
        message,
        metadata: {
          planType,
          batchCount: batches || plan.batches,
        },
      },
    ],
  };
}

/**
 * Add audit event to planning run
 */
export function addAuditEvent(
  run: PlanningRun,
  eventType: AuditEventType,
  actor: string,
  message: string,
  metadata?: Record<string, unknown>
): PlanningRun {
  return {
    ...run,
    auditTrail: [
      ...run.auditTrail,
      {
        timestamp: new Date(),
        eventType,
        actor,
        message,
        metadata,
      },
    ],
  };
}

/**
 * Mark planning run as fully pushed to Unleashed
 */
export function markAsFullyPushed(
  run: PlanningRun,
  actor: string
): PlanningRun {
  return updatePlanningRunStatus(
    run,
    "fully_pushed",
    actor,
    "All plans successfully pushed to Unleashed"
  );
}

/**
 * Mark planning run as requiring reconciliation
 */
export function markReconcileRequired(
  run: PlanningRun,
  actor: string,
  reason: string
): PlanningRun {
  return updatePlanningRunStatus(run, "reconcile_required", actor, reason);
}

/**
 * Get planning run summary for display
 */
export function getPlanningRunSummary(run: PlanningRun): {
  id: string;
  externalId: string;
  createdAt: Date;
  createdBy: string;
  status: PlanningRunStatus;
  totalBatches: number;
  kitchenBatches: number;
  purchasingBatches: number;
  eventCount: number;
} {
  return {
    id: run.id,
    externalId: run.externalId,
    createdAt: run.createdAt,
    createdBy: run.createdBy,
    status: run.status,
    totalBatches:
      run.planTypes.kitchen.batches + run.planTypes.purchasing.batches,
    kitchenBatches: run.planTypes.kitchen.batches,
    purchasingBatches: run.planTypes.purchasing.batches,
    eventCount: run.auditTrail.length,
  };
}

/**
 * Get external reference for a plan
 */
export function getExternalReference(
  run: PlanningRun,
  planType: "kitchen" | "purchasing"
): ExternalReference {
  const plan = run.planTypes[planType];
  const parts = plan.externalId.split("-");

  return {
    runId: parts[0],
    type: planType,
    sequence: parseInt(parts[2], 10),
    full: plan.externalId,
  };
}

/**
 * Parse external reference string
 */
export function parseExternalReference(
  externalId: string
): ExternalReference | null {
  const match = externalId.match(
    /^([A-F0-9]+)-(kitchen|purchasing)-(\d{3})$/i
  );
  if (!match) {
    return null;
  }

  return {
    runId: match[1],
    type: match[2] as "kitchen" | "purchasing",
    sequence: parseInt(match[3], 10),
    full: externalId,
  };
}

/**
 * Get audit events filtered by type
 */
export function getAuditEventsByType(
  run: PlanningRun,
  eventType: AuditEventType
): AuditEvent[] {
  return run.auditTrail.filter((event) => event.eventType === eventType);
}

/**
 * Get audit events for a date range
 */
export function getAuditEventsByDateRange(
  run: PlanningRun,
  startDate: Date,
  endDate: Date
): AuditEvent[] {
  return run.auditTrail.filter(
    (event) =>
      event.timestamp >= startDate && event.timestamp <= endDate
  );
}

/**
 * Get the last audit event
 */
export function getLastAuditEvent(run: PlanningRun): AuditEvent | null {
  return run.auditTrail.length > 0
    ? run.auditTrail[run.auditTrail.length - 1]
    : null;
}

/**
 * Check if planning run is ready to push
 */
export function isReadyToPush(run: PlanningRun): boolean {
  return (
    run.status === "not_started" ||
    run.status === "partially_pushed"
  );
}

/**
 * Check if planning run is complete
 */
export function isComplete(run: PlanningRun): boolean {
  return run.status === "fully_pushed";
}

/**
 * Validate planning run data
 */
export function validatePlanningRun(run: PlanningRun): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!run.id || typeof run.id !== "string") {
    errors.push("Planning run must have a valid UUID");
  }

  if (!run.createdBy || typeof run.createdBy !== "string") {
    errors.push("Planning run must have a createdBy identifier");
  }

  if (run.auditTrail.length === 0) {
    errors.push("Planning run must have at least one audit event");
  }

  if (
    !run.planTypes.kitchen ||
    !run.planTypes.kitchen.planId
  ) {
    errors.push("Kitchen plan reference is missing");
  }

  if (
    !run.planTypes.purchasing ||
    !run.planTypes.purchasing.planId
  ) {
    errors.push("Purchasing plan reference is missing");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
