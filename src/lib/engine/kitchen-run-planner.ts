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
import { isWorkday, nextWorkday, previousWorkday } from '@/lib/planning/working-day';
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
  /**
   * True when the ideal startDate (back-off from requiredByDate) fell before
   * `input.today` and was clamped forward. The run won't finish in time for
   * the original consumer; the conflict detector will surface that downstream.
   */
  overdue: boolean;
  /**
   * Ideal start date BEFORE today-clamping. Equal to `startDate` when not
   * overdue. Useful for the drawer to show the planning chain.
   */
  idealStartDate: string;
  /** What drove the demand. */
  drivers: Array<{
    productCode: string;
    productName: string;
    quantity: number;
  }>;
  /**
   * Phase 4l.12 — Unleashed assemblies for this intermediate that land
   * AFTER this run's required-by date. If you reschedule one of these
   * earlier in Unleashed, this run becomes redundant.
   */
  redundantWithUnleashed?: ReadonlyArray<{
    assembly: string;
    date: string;
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
  /**
   * Today as YYYY-MM-DD. When set, any run whose ideal startDate would fall
   * before today is clamped to today and flagged `overdue: true`. The
   * downstream cascade still uses the clamped (forward) start as the
   * required-by date for sub-intermediates — so children clamp too, and
   * the conflict detector picks up the resulting buffer violations.
   * Omit (tests) to disable clamping.
   */
  today?: string;
  /**
   * Phase 4l.12 — sliding-window size (in days) for kitchen-gap emission.
   * Each emitted gap covers ~this much forward demand instead of the
   * whole-horizon coalesce that Phase 4l.8 used. Default 5 ≈ "make for
   * use within 5 days, ideally consumed the day after production
   * finishes". Set 0 to revert to the legacy single-gap behaviour.
   */
  consumptionWindowDays?: number;
}

// ─── Public API ──────────────────────────────────────────────

export function planKitchenRuns(input: KitchenRunPlannerInput): KitchenRun[] {
  const buffer = input.bufferDays ?? 1;
  const maxLevels = input.maxLevels ?? 5;
  const allRuns: KitchenRun[] = [];

  // Phase 4l.12 — pre-compute the (batch, yield) map for every
  // intermediate so the gap engine can credit full post-rounding
  // production back to its running balance. Without this, the
  // multi-gap walk over-emits when preferredBatchSize > deficit.
  const preferredBatchByIntermediate: Record<string, { batch: number; yield: number }> = {};
  for (const [code, intermediate] of input.intermediates.entries()) {
    if (intermediate.preferredBatchSize && intermediate.preferredBatchSize > 0) {
      const y =
        intermediate.yieldRate && intermediate.yieldRate > 0 && intermediate.yieldRate <= 1
          ? intermediate.yieldRate
          : 1;
      preferredBatchByIntermediate[code] = {
        batch: intermediate.preferredBatchSize,
        yield: y,
      };
    }
  }

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
      consumptionWindowDays: input.consumptionWindowDays,
      preferredBatchByIntermediate,
    });
    if (gaps.length === 0) break;

    const nextLevelDemand: IntermediateDemandEvent[] = [];

    for (const gap of gaps) {
      const intermediate = input.intermediates.get(gap.intermediateCode);
      const productionDays = intermediate ? productionDaysFor(intermediate) : 1;
      // Phase 4l.10: convert OUTPUT shortfall → INPUT kg the kitchen team
      // actually weighs out, in two steps:
      //
      //   1. Yield-uplift. The kitchen-gap engine reports
      //      `shortfallQuantity` in OUTPUT kg (= what packaging is short
      //      by). Processing losses mean `output = input × yieldRate`, so
      //      `rawInput = outputShortfall / yieldRate`. Fallback yield is
      //      1.0 when missing or out of range (no loss assumed).
      //
      //   2. Recipe batch rounding. Recipes have a standard batch size
      //      (kg of INPUT per run — e.g. one IBC = 250kg for IABKBR,
      //      Kitchen processes column P). The team always runs full
      //      batches rather than partials, so we round `rawInput` UP to
      //      the next whole multiple of `preferredBatchSize`. When the
      //      column is empty, no rounding is applied — the run is sized
      //      purely by yield-uplifted demand.
      //
      // Worked example: MFBKBRYBG demands 205kg OUTPUT of IABKBR.
      // yieldRate = 0.948, preferredBatchSize = 250.
      //   rawInput  = ceil(205 / 0.948) = 217
      //   batches   = ceil(217 / 250)   = 1
      //   inputKg   = 1 × 250           = 250  ✓ matches kitchen recipe
      const yieldRate =
        intermediate?.yieldRate && intermediate.yieldRate > 0 && intermediate.yieldRate <= 1
          ? intermediate.yieldRate
          : 1.0;
      const outputShortfall = gap.shortfallQuantity;
      const rawInput = Math.ceil(outputShortfall / yieldRate);
      const preferredBatchSize = intermediate?.preferredBatchSize ?? null;
      const inputQuantity =
        preferredBatchSize && preferredBatchSize > 0
          ? Math.ceil(rawInput / preferredBatchSize) * preferredBatchSize
          : rawInput;
      // Date semantics:
      //   requiredByDate  = when downstream needs the output (parent's startDate
      //                     for cascading children, or original packaging date).
      //   finishDate      = last day of production. Must be ≥ buffer days before
      //                     downstream consumption: finish = requiredByDate - buffer.
      //   startDate       = finish - (productionDays - 1). A 2-day run starts the
      //                     day before it finishes.
      //   availableDate   = first day output is usable = finish + 1.
      const idealFinishDate = shiftDateBackwards(gap.requiredByDate, buffer);
      // Workday-aware start (Phase 4l.8): the kitchen team can only START
      // a run on a working day. Passive steps (soak / dehydrate) may still
      // run over weekends — we only constrain `startDate`. If the ideal
      // (lead-time-backed-off) start would fall on Sat/Sun, pull it back
      // to the prior Friday. Finish is re-derived from the clamped start
      // so the run's calendar span stays consistent with `productionDays`
      // (so a mix-only recipe starting Fri also finishes Fri, rather than
      // pretending to "span" into the weekend with no work happening).
      const idealStartDate = previousWorkday(
        shiftDateBackwards(idealFinishDate, productionDays - 1),
      );
      const idealFinishAdjusted = shiftDateBackwards(
        idealStartDate,
        -(productionDays - 1),
      );

      // Today-floor (Phase 4l.4): if the ideal start is before today, clamp
      // forward and recompute finish/availableDate so dates remain ordered.
      // The run is then flagged overdue; the conflict detector picks up the
      // 1-day buffer violation against the original consumer downstream.
      // Post-clamp, push forward if today lands on a weekend.
      let startDate = idealStartDate;
      let finishDate = idealFinishAdjusted;
      let overdue = false;
      if (input.today && idealStartDate < input.today) {
        startDate = isWorkday(input.today) ? input.today : nextWorkday(input.today);
        finishDate = shiftDateBackwards(startDate, -(productionDays - 1));
        overdue = true;
      }
      const availableDate = shiftDateBackwards(finishDate, -1);

      const run: KitchenRun = {
        intermediateCode: gap.intermediateCode,
        intermediateName: intermediate?.productName ?? gap.intermediateName,
        quantity: inputQuantity, // INPUT kg the kitchen team weighs out
        startDate,
        finishDate,
        availableDate,
        durationDays: productionDays,
        level,
        overdue,
        idealStartDate,
        drivers: gap.drivers,
        redundantWithUnleashed: gap.redundantWithUnleashed,
      };
      allRuns.push(run);

      // Cascade: this run's BOM may consume sub-intermediates. Their
      // requiredByDate equals the parent's startDate — that's when this
      // run begins consuming them. The recursion will then back off by
      // their own buffer + production days when producing them.
      //
      // Phase 4l.10: cascade uses INPUT kg (the actual amount of batch
      // material the recipe processes) so child demand reflects the real
      // consumption. The wasted (output-loss) fraction of an intermediate
      // still consumed its share of sub-ingredients during processing —
      // using OUTPUT (= shortfallQuantity) would under-count those.
      const childRequiredBy = startDate;
      const childExploded = deriveIntermediateDemand({
        packagingActivities: [
          {
            productCode: gap.intermediateCode,
            productName: run.intermediateName,
            quantity: inputQuantity,
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
