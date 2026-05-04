/**
 * Kitchen run planner — Phase 4k.2.
 *
 * Builds on `kitchen-gap.ts` with two additions:
 *
 *   1. **Lead-time backoff.** Each required kitchen run has a calendar-day
 *      duration (per `productionDaysFor`). The chip's date represents
 *      when the run STARTS, not when it's needed — work backwards from
 *      `requiredByDate` minus production days minus a 1-day buffer.
 *
 *   2. **Cascading derivation.** Once a required run for ICC is generated,
 *      ICC's own BOM (which references ICCC, the sub-intermediate) becomes
 *      new demand at `iccStartDate - 1`. Recurse until we hit components
 *      that aren't themselves intermediates (raw materials).
 *
 * Failure modes / caveats:
 *   - Calendar-day arithmetic; weekends/holidays not subtracted. Phase
 *     4k.3 would add working-day awareness.
 *   - Each gap → one run. No coalescing across multiple gaps for the same
 *     intermediate (kitchen-side optimiser equivalent of Phase 3 would
 *     do that). Conservative; real operations may batch them.
 *   - Cycle detection: BOM cycles are caught by `explodeBom` which throws.
 *     The planner re-throws unmodified.
 *   - Recursion is bounded by `maxLevels` (default 5) — finished good →
 *     intermediate → sub-intermediate → … 5 deep is much more than the
 *     real BOM allows. Mostly there to prevent runaway loops if the BOM
 *     is malformed.
 */

import {
  computeKitchenGaps,
  type KitchenSupplyEvent,
} from './kitchen-gap';
import {
  deriveIntermediateDemand,
  type IntermediateDemandEvent,
  type PackagingActivityForDemand,
} from './intermediate-demand';
import {
  productionDaysFor,
  shiftDateBackwards,
  type KitchenIntermediate,
} from '@/lib/planning/capacity-data';
import type { BOMComponent } from '@/lib/planning/engine-io';
import type { FamilyMeta } from './bom-explode';

// ─── Public types ────────────────────────────────────────────

export interface KitchenRun {
  intermediateCode: string;
  intermediateName: string;
  /** Units to produce. */
  quantity: number;
  /** YYYY-MM-DD when the run starts (chip date). */
  startDate: string;
  /** YYYY-MM-DD when the run finishes (last day of production). */
  finishDate: string;
  /** YYYY-MM-DD when the output is available for downstream use. = finishDate + 1. */
  availableDate: string;
  /** Calendar-day production duration. */
  durationDays: number;
  /** Recursion depth: 0 = directly driven by packaging, 1 = sub-intermediate, … */
  level: number;
  /** What drove the demand. */
  drivers: Array<{
    productCode: string;
    productName: string;
    quantity: number;
  }>;
}

export interface KitchenRunPlannerInput {
  packagingActivities: ReadonlyArray<PackagingActivityForDemand>;
  bom: ReadonlyArray<BOMComponent>;
  intermediates: ReadonlyMap<string, KitchenIntermediate>;
  intermediateCodes: ReadonlySet<string>;
  familyMap?: Record<string, FamilyMeta>;
  /** Lundberg SOH per intermediate code. */
  lundbergSohByCode: Record<string, number>;
  /** Already-scheduled kitchen runs (Lundberg assemblies). */
  scheduledSupply: ReadonlyArray<KitchenSupplyEvent>;
  /** Buffer days between kitchen run finish and downstream consumption. Default 1. */
  bufferDays?: number;
  /** Cap on recursion depth (defensive). Default 5. */
  maxLevels?: number;
}

// ─── Public API ──────────────────────────────────────────────

export function planKitchenRuns(input: KitchenRunPlannerInput): KitchenRun[] {
  const buffer = input.bufferDays ?? 1;
  const maxLevels = input.maxLevels ?? 5;
  const allRuns: KitchenRun[] = [];

  // Working balance per intermediate. Start with Lundberg SOH; supplies and
  // emitted runs will adjust it as we walk forward.
  const balance: Record<string, number> = { ...input.lundbergSohByCode };
  // Working scheduled supply. We pass it to computeKitchenGaps unchanged at
  // each level (gaps consume against it via the simulation; we don't
  // mutate the input).
  let supply: ReadonlyArray<KitchenSupplyEvent> = input.scheduledSupply;

  // Level 0: demand from packaging plan.
  let currentDemand = deriveIntermediateDemand({
    packagingActivities: input.packagingActivities,
    bom: input.bom as BOMComponent[],
    intermediateCodes: input.intermediateCodes,
    familyMap: input.familyMap,
  });

  for (let level = 0; level < maxLevels; level++) {
    if (currentDemand.length === 0) break;

    const gaps = computeKitchenGaps({
      demand: currentDemand,
      scheduledSupply: supply,
      lundbergSohByCode: balance,
    });
    if (gaps.length === 0) break;

    const nextLevelDemand: IntermediateDemandEvent[] = [];

    for (const gap of gaps) {
      const intermediate = input.intermediates.get(gap.intermediateCode);
      const productionDays = intermediate ? productionDaysFor(intermediate) : 1;
      // Date semantics:
      //   requiredByDate  = when downstream needs the output (parent's startDate
      //                     for cascading children, or original packaging date).
      //   finishDate      = last day of production. Must be ≥ buffer days before
      //                     downstream consumption: finish = requiredByDate - buffer.
      //   startDate       = finish - (productionDays - 1). A 2-day run starts the
      //                     day before it finishes.
      //   availableDate   = first day output is usable = finish + 1.
      const finishDate = shiftDateBackwards(gap.requiredByDate, buffer);
      const startDate = shiftDateBackwards(finishDate, productionDays - 1);
      const availableDate = shiftDateBackwards(finishDate, -1);

      const run: KitchenRun = {
        intermediateCode: gap.intermediateCode,
        intermediateName: intermediate?.productName ?? gap.intermediateName,
        quantity: gap.shortfallQuantity,
        startDate,
        finishDate,
        availableDate,
        durationDays: productionDays,
        level,
        drivers: gap.drivers,
      };
      allRuns.push(run);

      // Cascade: this run's BOM may consume sub-intermediates. Their
      // requiredByDate equals the parent's startDate — that's when this
      // run begins consuming them. The recursion will then back off by
      // their own buffer + production days when producing them.
      const childRequiredBy = startDate;
      const childExploded = deriveIntermediateDemand({
        packagingActivities: [
          {
            productCode: gap.intermediateCode,
            productName: run.intermediateName,
            quantity: gap.shortfallQuantity,
            date: childRequiredBy,
          },
        ],
        bom: input.bom as BOMComponent[],
        intermediateCodes: input.intermediateCodes,
        familyMap: input.familyMap,
      });
      // Filter out self-references (an intermediate whose BOM references
      // itself — shouldn't happen but defensive).
      for (const ce of childExploded) {
        if (ce.intermediateCode !== gap.intermediateCode) {
          nextLevelDemand.push(ce);
        }
      }
    }

    currentDemand = nextLevelDemand;
  }

  // Stable order for downstream rendering.
  allRuns.sort((a, b) => {
    if (a.startDate !== b.startDate) return a.startDate.localeCompare(b.startDate);
    return a.intermediateCode.localeCompare(b.intermediateCode);
  });

  return allRuns;
}
