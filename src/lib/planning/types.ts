/**
 * Planning run types and interfaces
 */

export type PlanningRunStatus =
  | "not_started"
  | "partially_pushed"
  | "fully_pushed"
  | "reconcile_required";

export type AuditEventType =
  | "created"
  | "analyzed"
  | "reviewed"
  | "pushed_to_unleashed"
  | "reconciled"
  | "cancelled"
  | "error";

/**
 * Planning run tracks a complete planning cycle
 * Includes multiple plan types (kitchen, purchasing) and their status
 */
export interface PlanningRun {
  id: string;
  externalId: string; // For human reference and external system integration
  createdAt: Date;
  createdBy: string; // User or system identifier
  status: PlanningRunStatus;
  planTypes: {
    kitchen: PlanRef;
    purchasing: PlanRef;
  };
  notes?: string;
  auditTrail: AuditEvent[];
}

/**
 * Reference to a specific plan within a planning run
 */
export interface PlanRef {
  planId: string;
  externalId: string; // e.g., "run-123-kitchen-001"
  status: PlanningRunStatus;
  batches: number; // Number of items in this plan
  lastModified: Date;
}

/**
 * Audit event for planning run history
 */
export interface AuditEvent {
  timestamp: Date;
  eventType: AuditEventType;
  actor: string; // User or system
  message: string;
  metadata?: Record<string, unknown>;
}

/**
 * External reference format
 * Format: {runId}-{type}-{sequence}
 * Example: 550e8400-e29b-41d4-a716-446655440000-kitchen-001
 */
export interface ExternalReference {
  runId: string;
  type: "kitchen" | "purchasing";
  sequence: number;
  full: string;
}
