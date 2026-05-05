/**
 * Kitchen-gap engine — Phase 4k.
 *
 * Forward-simulates per-intermediate inventory at Lundberg through time:
 *   start: SOH at Lundberg (today)
 *   add: scheduled-assembly deliveries on/before each date
 *   subtract: packaging-driven demand events
 *
 * When the running balance dips below zero, a `KitchenGap` is emitted —
 * a required new kitchen run for that intermediate, of the missing
 * quantity, by the demand date. The simulation continues with balance
 * reset to zero (i.e. the gap is assumed to be filled by the run we just
 * emitted), so multiple gaps appear when demand outpaces supply more
 * than once.
 *
 * Pure: no I/O. Deterministic given sorted inputs.
 *
 * Caveat: dates are treated as instantaneous events with no kitchen
 * production lead time. A gap on day 14 means "must have produced this
 * by day 14" — it doesn't account for the soak/dehydrate/mix lead time
 * that intermediate production actually takes. Phase 4k.3 (kitchen
 * capacity scheduling) will model that. For now, the operator should
 * read each gap as "kitchen needs this quantity ready by `requiredByDate`
 * — start production some working days earlier."
 */

import type { IntermediateDemandEvent } from './intermediate-demand';

// ─── Public types ────────────────────────────────────────────

export interface KitchenSupplyEvent {
  intermediateCode: string;
  /** YYYY-MM-DD when the supply lands at Lundberg. */
  date: string;
  quantity: number;
  /** Provenance — usually an Unleashed assembly number. */
  source: string;
}

export interface KitchenGap {
  intermediateCode: string;
  intermediateName: string;
  /** Units short. Always > 0. */
  shortfallQuantity: number;
  /** YYYY-MM-DD by which the new kitchen run must be ready. */
  requiredByDate: string;
  /** Provenance: which packaging batches the demand came from (around this gap). */
  drivers: Array<{
    productCode: string;
    productName: string;
    quantity: number;
  }>;
}

export interface KitchenGapInput {
  /** All intermediate-demand events from the packaging plan. */
  demand: ReadonlyArray<IntermediateDemandEvent>;
  /** Existing scheduled supply (Unleashed assemblies at Lundberg). */
  scheduledSupply: ReadonlyArray<KitchenSupplyEvent>;
  /** Current Lundberg SOH per intermediate code. */
  lundbergSohByCode: Record<string, number>;
}

// ─── Public API ──────────────────────────────────────────────

export function computeKitchenGaps(input: KitchenGapInput): KitchenGap[] {
  // Group events by intermediate code so each can be simulated independently.
  const byCode = new Map<
    string,
    {
      name: string;
      events: Array<
        | { kind: 'demand'; date: string; quantity: number; driver: IntermediateDemandEvent['drivenBy'] }
        | { kind: 'supply'; date: string; quantity: number }
      >;
    }
  >();

  for (const d of input.demand) {
    let bucket = byCode.get(d.intermediateCode);
    if (!bucket) {
      bucket = { name: d.intermediateName, events: [] };
      byCode.set(d.intermediateCode, bucket);
    }
    bucket.events.push({
      kind: 'demand',
      date: d.requiredByDate,
      quantity: d.quantity,
      driver: d.drivenBy,
    });
  }
  for (const s of input.scheduledSupply) {
    let bucket = byCode.get(s.intermediateCode);
    if (!bucket) {
      // Supply for a code that has no demand — irrelevant; skip. We only
      // care about gaps, not surpluses.
      continue;
    }
    bucket.events.push({ kind: 'supply', date: s.date, quantity: s.quantity });
  }

  const gaps: KitchenGap[] = [];

  for (const [code, bucket] of byCode.entries()) {
    // Simulate this intermediate's running balance.
    // Sort events by date; supply on the SAME date is applied BEFORE demand
    // (a delivery scheduled for today is available for today's consumption).
    const events = bucket.events.slice().sort((a, b) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      if (a.kind !== b.kind) return a.kind === 'supply' ? -1 : 1;
      return 0;
    });

    let balance = input.lundbergSohByCode[code] ?? 0;
    // Buffer of demand drivers since the last gap, so the next gap can list
    // them as causes.
    let pendingDrivers: IntermediateDemandEvent['drivenBy'][] = [];

    for (const e of events) {
      if (e.kind === 'supply') {
        balance += e.quantity;
      } else {
        balance -= e.quantity;
        pendingDrivers.push(e.driver);
        if (balance < 0) {
          gaps.push({
            intermediateCode: code,
            intermediateName: bucket.name,
            shortfallQuantity: -balance,
            requiredByDate: e.date,
            drivers: pendingDrivers.map((d) => ({
              productCode: d.productCode,
              productName: d.productName,
              quantity: d.packagingQuantity,
            })),
          });
          balance = 0; // assume the gap is filled by the implied new run
          pendingDrivers = [];
        }
      }
    }
  }

  // Stable order for downstream rendering.
  gaps.sort((a, b) => {
    if (a.requiredByDate !== b.requiredByDate) {
      return a.requiredByDate.localeCompare(b.requiredByDate);
    }
    return a.intermediateCode.localeCompare(b.intermediateCode);
  });

  return gaps;
}
