/**
 * Supply-cap pass — Phase 4l.10.
 *
 * Reconciles user-edited kitchen run quantities against downstream
 * packaging demand. Without this pass, the calendar can show:
 *   • a kitchen run for 250kg of IABKBR (= one batch, user-edited down from
 *     two batches the planner chose)
 *   • plus 3 packaging chips claiming to consume 800kg of IABKBR's output
 *
 * That's an invisible over-commitment — the FIFO arrows would overdraw,
 * raw-material analysis would size POs against the inflated packaging
 * quantity, and the conflict detector would either miss it or flag it
 * after-the-fact. This pass surfaces it explicitly: each intermediate
 * gets its available output computed (planned + edited kitchen runs ×
 * yield, plus SOH, plus Unleashed assemblies), and packaging consumers
 * are allocated against that supply in **profit-per-unit descending
 * order**. Chips that don't fit get capped or zeroed.
 *
 * Output is a map of `stableId → { cappedQuantity, capFrom, capCode }`.
 * The caller (`page.tsx`) applies these caps to packaging activities
 * before the raw-material analyzer / conflict detector see them, so all
 * downstream calculations operate on supply-aware quantities.
 *
 * Profit-first allocation rule (decision):
 *   • Sort by `profitPerItem` desc; null profit ranks at 0 (= last).
 *   • Tiebreak by date asc, then by quantity desc — keep deterministic.
 *   • Walk in order, allocate each chip's FULL demand until supply runs
 *     out. The first chip that can't get its full demand gets the
 *     remainder (so we don't waste supply); subsequent chips cap to 0.
 *
 * No I/O. No mutation of inputs.
 */

export interface SupplyCapPackagingChip {
  stableId: string;
  productCode: string;
  /** Optimiser-planned units (pre-cap). */
  quantity: number;
  /** Local-ISO date the chip is scheduled for. Used as tiebreaker. */
  date: string;
  /** AUD profit per unit; `null`/missing ranks as 0 = lowest priority. */
  profitPerItem: number | null | undefined;
}

export interface SupplyCapInput {
  /**
   * All packaging chips to consider. The pass only caps chips whose
   * `productCode` BOM-references a short intermediate; others pass through.
   */
  packagingChips: ReadonlyArray<SupplyCapPackagingChip>;
  /**
   * `consumesQtyMap[parentCode][childCode] = qty of child per unit of
   * parent`. Same shape as `page.tsx` builds for the conflict detector.
   * Only children that are also keys in `intermediateOutputSupply` are
   * considered as cap candidates.
   */
  consumesQtyMap: Record<string, Record<string, number>>;
  /**
   * Total OUTPUT supply per intermediate code: SOH + sum(Unleashed
   * assemblies, output kg) + sum((planner or user-edited) kitchen input ×
   * yieldRate). Caller computes this so the cap pass stays unit-agnostic.
   */
  intermediateOutputSupply: Record<string, number>;
}

export interface SupplyCapResult {
  /** Per-stableId cap details. Chips not present in the map are uncapped. */
  caps: Map<
    string,
    {
      /** Quantity AFTER cap is applied. May be 0. */
      cappedQuantity: number;
      /** Original (pre-cap) quantity. Always > cappedQuantity. */
      capFrom: number;
      /** Intermediate code whose supply was the binding constraint. */
      capCode: string;
    }
  >;
  /** Per-intermediate diagnostic — useful for the drawer's detail row. */
  diagnostics: Map<
    string,
    {
      totalSupply: number;
      totalDemand: number;
      shortBy: number;
      cappedChipCount: number;
    }
  >;
}

/**
 * Apply supply caps to packaging chips.
 *
 * If an intermediate has enough supply to cover all its consumers,
 * nothing changes. If it's short, consumers are allocated by profit
 * descending; the first one that doesn't fit fully gets the remaining
 * supply; subsequent ones cap to 0.
 *
 * A chip can be capped by MULTIPLE intermediates. We take the MIN cap
 * across all binding intermediates so the final quantity is feasible
 * for every input.
 */
export function applySupplyCaps(input: SupplyCapInput): SupplyCapResult {
  const caps = new Map<
    string,
    { cappedQuantity: number; capFrom: number; capCode: string }
  >();
  const diagnostics = new Map<
    string,
    {
      totalSupply: number;
      totalDemand: number;
      shortBy: number;
      cappedChipCount: number;
    }
  >();

  // For each intermediate code with finite supply, find its consumers and
  // run the FIFO-by-profit allocation.
  for (const [intermediateCode, supply] of Object.entries(
    input.intermediateOutputSupply,
  )) {
    // Gather consumers: every packaging chip whose product BOM has this
    // intermediate as a depth-1 child with a positive qty/unit.
    const consumers: Array<{
      chip: SupplyCapPackagingChip;
      qtyPerUnit: number;
      demand: number;
    }> = [];
    for (const chip of input.packagingChips) {
      const ratio = input.consumesQtyMap[chip.productCode]?.[intermediateCode];
      if (!ratio || ratio <= 0) continue;
      const demand = chip.quantity * ratio;
      if (demand <= 0) continue;
      consumers.push({ chip, qtyPerUnit: ratio, demand });
    }
    if (consumers.length === 0) continue;

    const totalDemand = consumers.reduce((s, c) => s + c.demand, 0);
    if (totalDemand <= supply) {
      diagnostics.set(intermediateCode, {
        totalSupply: supply,
        totalDemand,
        shortBy: 0,
        cappedChipCount: 0,
      });
      continue;
    }

    // Profit-first allocation. Sort consumers by profit desc, then date
    // asc, then qty desc. Stable across ties.
    consumers.sort((a, b) => {
      const pa = a.chip.profitPerItem ?? 0;
      const pb = b.chip.profitPerItem ?? 0;
      if (pa !== pb) return pb - pa;
      if (a.chip.date !== b.chip.date) {
        return a.chip.date.localeCompare(b.chip.date);
      }
      return b.chip.quantity - a.chip.quantity;
    });

    let remaining = supply;
    let cappedCount = 0;
    for (const c of consumers) {
      if (remaining >= c.demand) {
        // Full allocation; this chip isn't capped by THIS intermediate.
        remaining -= c.demand;
        continue;
      }
      // Partial or zero. The chip can support `remaining / qtyPerUnit`
      // units of FG before running out.
      const allowedUnits = Math.max(
        0,
        Math.floor(remaining / c.qtyPerUnit),
      );
      remaining -= allowedUnits * c.qtyPerUnit;
      if (allowedUnits >= c.chip.quantity) continue; // edge — shouldn't happen
      // Combine with existing cap (a chip can be capped by multiple
      // intermediates; take the minimum).
      const existing = caps.get(c.chip.stableId);
      const newCap = existing
        ? Math.min(existing.cappedQuantity, allowedUnits)
        : allowedUnits;
      caps.set(c.chip.stableId, {
        cappedQuantity: newCap,
        capFrom: c.chip.quantity,
        // Record the intermediate that's currently the binding one for
        // this chip (smallest allowed → most binding).
        capCode:
          existing && existing.cappedQuantity <= newCap
            ? existing.capCode
            : intermediateCode,
      });
      cappedCount += 1;
    }

    diagnostics.set(intermediateCode, {
      totalSupply: supply,
      totalDemand,
      shortBy: totalDemand - supply,
      cappedChipCount: cappedCount,
    });
  }

  return { caps, diagnostics };
}
