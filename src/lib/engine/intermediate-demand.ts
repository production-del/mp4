/**
 * Intermediate-demand derivation — Phase 4k.
 *
 * Walks each packaging activity (output of the optimiser) and uses the BOM
 * exploder to compute which intermediates are consumed and when. The
 * per-(intermediate, date) demand is the input to the kitchen-gap engine
 * (`kitchen-gap.ts`), which compares against Lundberg supply to identify
 * required kitchen production runs.
 *
 * Pure: no I/O. Output is a flat list of demand events the caller can sort
 * / aggregate / project as needed.
 *
 * Why this needs to exist
 * ───────────────────────
 * The optimiser plans packaging batches; it doesn't plan kitchen
 * production. But every packaging batch consumes intermediates (the
 * `family` code in productMeta is the intermediate productCode in
 * Unleashed). The kitchen needs to have those intermediates ready by the
 * packaging date. This module surfaces that latent demand so the kitchen
 * planner can see what the packaging plan is asking of it.
 */

import { explodeBom, type FamilyMeta } from './bom-explode';
import type { BOMComponent } from '@/lib/planning/engine-io';

// ─── Public types ────────────────────────────────────────────

export interface PackagingActivityForDemand {
  productCode: string;
  productName: string;
  quantity: number;
  /** YYYY-MM-DD when the packaging batch consumes this intermediate. */
  date: string;
}

export interface IntermediateDemandEvent {
  intermediateCode: string;
  intermediateName: string;
  /** Total quantity of the intermediate consumed by this packaging batch (clean + wastage). */
  quantity: number;
  /** YYYY-MM-DD — the intermediate must be available at the planning warehouse by this date. */
  requiredByDate: string;
  /** Provenance: which packaging batch drove this demand. */
  drivenBy: {
    productCode: string;
    productName: string;
    packagingQuantity: number;
    packagingDate: string;
  };
}

// ─── Public API ──────────────────────────────────────────────

/**
 * For each packaging activity, expand its BOM and collect DIRECT-CHILD
 * intermediates as demand events.
 *
 * "Direct child" = depth 1 from the root product. We deliberately ignore
 * deeper transitive intermediates because the cascading kitchen-run
 * planner walks the BOM level-by-level with proper lead-time backoff at
 * each step. If we accumulated all depths here, the planner would
 * double-count when it cascades.
 *
 * Multiple direct-child paths to the same intermediate (rare diamond
 * BOMs) sum into one event per (packaging-batch × intermediate).
 */
export function deriveIntermediateDemand(input: {
  packagingActivities: ReadonlyArray<PackagingActivityForDemand>;
  bom: ReadonlyArray<BOMComponent>;
  intermediateCodes: ReadonlySet<string>;
  familyMap?: Record<string, FamilyMeta>;
}): IntermediateDemandEvent[] {
  const out: IntermediateDemandEvent[] = [];
  for (const activity of input.packagingActivities) {
    const r = explodeBom({
      rootProductCode: activity.productCode,
      rootQuantity: activity.quantity,
      bom: input.bom as BOMComponent[],
      familyMap: input.familyMap ?? {},
    });
    // Sum direct-child paths per intermediate code.
    const directQty = new Map<string, { name: string; qty: number }>();
    for (const c of r.components) {
      if (c.depth !== 1) continue; // skip transitive intermediates
      if (!input.intermediateCodes.has(c.productCode)) continue;
      if (c.totalQuantity <= 0) continue;
      const existing = directQty.get(c.productCode);
      if (existing) {
        existing.qty += c.totalQuantity;
      } else {
        directQty.set(c.productCode, {
          name: c.productName || c.productCode,
          qty: c.totalQuantity,
        });
      }
    }
    for (const [code, { name, qty }] of directQty.entries()) {
      out.push({
        intermediateCode: code,
        intermediateName: name,
        quantity: qty,
        requiredByDate: activity.date,
        drivenBy: {
          productCode: activity.productCode,
          productName: activity.productName,
          packagingQuantity: activity.quantity,
          packagingDate: activity.date,
        },
      });
    }
  }
  return out;
}

/**
 * Aggregate demand events by (intermediate, date). Useful for callers that
 * want a single row per intermediate per day. Preserves drivenBy as a list
 * of contributing packaging batches.
 */
export interface AggregatedIntermediateDemand {
  intermediateCode: string;
  intermediateName: string;
  date: string;
  totalQuantity: number;
  drivers: Array<{
    productCode: string;
    productName: string;
    quantity: number;
  }>;
}

export function aggregateIntermediateDemand(
  events: ReadonlyArray<IntermediateDemandEvent>,
): AggregatedIntermediateDemand[] {
  const map = new Map<string, AggregatedIntermediateDemand>();
  for (const e of events) {
    const key = `${e.intermediateCode}|${e.requiredByDate}`;
    let agg = map.get(key);
    if (!agg) {
      agg = {
        intermediateCode: e.intermediateCode,
        intermediateName: e.intermediateName,
        date: e.requiredByDate,
        totalQuantity: 0,
        drivers: [],
      };
      map.set(key, agg);
    }
    agg.totalQuantity += e.quantity;
    agg.drivers.push({
      productCode: e.drivenBy.productCode,
      productName: e.drivenBy.productName,
      quantity: e.quantity,
    });
  }
  // Sort by (date, intermediate) for deterministic output.
  return Array.from(map.values()).sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return a.intermediateCode.localeCompare(b.intermediateCode);
  });
}
