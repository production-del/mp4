/**
 * Phase 4l.12 — FIFO supply allocator.
 *
 * Walks consumer activities in date order and matches each one to
 * supplier activities (whose `finishDate` strictly precedes the consumer's
 * `date`) in finish-date order. Each consumer-supplier match becomes an
 * allocation tagged with the quantity drawn and a `phantom` flag for
 * consumers that ended up starved (= no real supplier finished in time
 * to feed them; we still record a phantom supplier so the calendar
 * arrow renderer has something to point at).
 *
 * Originally lived inside CalendarApp.tsx's `relatedByStableId` useMemo.
 * Extracted in Phase 4l.12 so the server can also run the allocator
 * (Option 2 post-FIFO batch redating). Pure, deterministic, no React
 * dependencies.
 */

// ─── Public types ────────────────────────────────────────────

/**
 * Activity shape the allocator needs. Wider CalendarActivity types
 * narrow to this for the call. `kind` is just the rough class; the
 * caller decides whether each activity is consumer / supplier / both.
 */
export interface AllocatorActivity {
  stableId: string;
  productCode: string;
  /**
   * Activity class — used by the default `isConsumer` / `isSupplier`
   * helpers (when the caller doesn't override). Passing this in saves
   * the caller from having to do an O(N) lookup per predicate call.
   */
  kind: 'packaging' | 'kitchen' | 'kitchen-required' | 'po-placed' | 'po-receiving';
  /** YYYY-MM-DD. For consumers = when they need the input. */
  date: string;
  /** YYYY-MM-DD finish date for suppliers; defaults to `date` when null. */
  finishDate?: string | null;
  /** Activity output quantity (for suppliers) or batch size (for consumers). */
  quantity: number;
  /** Profit per unit — used as a tiebreaker for same-date consumers. */
  profitPerItem?: number | null;
}

export interface AllocationInput {
  /** All activities in scope. Caller categorises via `isConsumer` / `isSupplier`. */
  activities: ReadonlyArray<AllocatorActivity>;
  /**
   * stableIds explicitly excluded from being a consumer OR supplier
   * (typically: dismissed chips).
   */
  excludedStableIds?: ReadonlySet<string>;
  /** Predicate: is this activity a candidate CONSUMER of intermediates? */
  isConsumer: (a: AllocatorActivity) => boolean;
  /** Predicate: is this activity a candidate SUPPLIER of intermediates? */
  isSupplier: (a: AllocatorActivity) => boolean;
  /**
   * productCode → list of ingredient codes consumed by it.
   * Used to determine which suppliers a given consumer can draw from.
   */
  consumesMap: Record<string, ReadonlyArray<string>>;
  /**
   * productCode → ingredient code → kg-of-ingredient-per-unit-of-product.
   * Drives the per-consumer consumption qty for each ingredient.
   */
  consumesQtyMap: Record<string, Record<string, number>>;
  /** Initial SOH per ingredient code (FIFO draws from this first). */
  initialSohByCode: Record<string, number>;
  /**
   * Override the supplier's available qty. Set when supply-cap or
   * yield-uplift modifies effective output. Falls back to
   * `activity.quantity`.
   */
  supplyQtyByActivity?: Record<string, number>;
}

export interface Allocation {
  supplierStableId: string;
  consumerStableId: string;
  /** Ingredient code this allocation is for (informational). */
  ingredient: string;
  /** Quantity drawn (in ingredient units). */
  quantity: number;
  /**
   * `true` when the consumer was starved (no real supplier finished
   * in time). The allocator emits one phantom allocation per starved
   * consumer pointing at the latest-finishing eligible supplier, so
   * the UI can draw a dashed-red arrow. Phantom allocations are NOT
   * counted as real supply (their `quantity` is informational).
   */
  phantom: boolean;
}

export interface AllocationResult {
  allocations: ReadonlyArray<Allocation>;
}

// ─── Public API ──────────────────────────────────────────────

export function allocateSupplyFifo(input: AllocationInput): AllocationResult {
  const finishOf = (a: AllocatorActivity) => a.finishDate ?? a.date;
  const qtyPerUnit = (consumerCode: string, ingredient: string) =>
    input.consumesQtyMap[consumerCode]?.[ingredient] ?? 1;
  const supplyQty = (a: AllocatorActivity) =>
    input.supplyQtyByActivity?.[a.stableId] ?? a.quantity ?? 0;
  const excluded = input.excludedStableIds ?? new Set<string>();

  // Set of ingredients that appear on the right-hand side of consumesMap.
  const ingredients = new Set<string>();
  for (const codes of Object.values(input.consumesMap)) {
    for (const c of codes) ingredients.add(c);
  }

  const allocations: Allocation[] = [];

  for (const ing of ingredients) {
    const consumers: AllocatorActivity[] = [];
    const suppliers: AllocatorActivity[] = [];
    for (const a of input.activities) {
      if (excluded.has(a.stableId)) continue;
      if (
        input.isConsumer(a) &&
        (input.consumesMap[a.productCode] ?? []).includes(ing)
      ) {
        consumers.push(a);
      }
      if (input.isSupplier(a) && a.productCode === ing) {
        suppliers.push(a);
      }
    }
    if (consumers.length === 0) continue;

    // Profit-first tiebreaker on same-date consumers. Higher per-unit
    // profit wins ties so the most valuable chip is supplied first.
    consumers.sort((a, b) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      const pa = a.profitPerItem ?? 0;
      const pb = b.profitPerItem ?? 0;
      return pb - pa;
    });
    // Suppliers walked in finish-date order — FIFO from the production
    // line's perspective.
    suppliers.sort((a, b) => finishOf(a).localeCompare(finishOf(b)));

    const supplierRemaining = new Map<string, number>();
    for (const s of suppliers) supplierRemaining.set(s.stableId, supplyQty(s));
    let sohRemaining = input.initialSohByCode[ing] ?? 0;

    for (const c of consumers) {
      let need = qtyPerUnit(c.productCode, ing) * c.quantity;
      if (need <= 0) continue;
      const initialNeed = need;
      // Pull from initial SOH first — no allocation row (SOH isn't a chip).
      if (sohRemaining > 0) {
        const drawn = Math.min(need, sohRemaining);
        sohRemaining -= drawn;
        need -= drawn;
      }
      let realAllocations = 0;
      if (need > 0) {
        // Pull from scheduled suppliers in FIFO order; only those whose
        // finish strictly precedes this consumer's date.
        for (const s of suppliers) {
          if (need <= 0) break;
          if (finishOf(s) >= c.date) break;
          const rem = supplierRemaining.get(s.stableId) ?? 0;
          if (rem <= 0) continue;
          const drawn = Math.min(need, rem);
          supplierRemaining.set(s.stableId, rem - drawn);
          need -= drawn;
          allocations.push({
            supplierStableId: s.stableId,
            consumerStableId: c.stableId,
            ingredient: ing,
            quantity: drawn,
            phantom: false,
          });
          realAllocations += 1;
        }
      }
      // Phantom allocation: consumer received NO real supply but
      // initial demand exceeded SOH alone → flag with the latest-
      // finishing eligible supplier so the UI can draw a dashed-red
      // arrow rather than leaving the chip arrowless.
      if (
        realAllocations === 0 &&
        initialNeed > sohRemaining &&
        need > 0
      ) {
        let phantomSupplier: AllocatorActivity | null = null;
        for (const s of suppliers) {
          if (finishOf(s) < c.date) phantomSupplier = s;
          else break;
        }
        if (phantomSupplier) {
          allocations.push({
            supplierStableId: phantomSupplier.stableId,
            consumerStableId: c.stableId,
            ingredient: ing,
            quantity: need, // unmet demand magnitude, informational
            phantom: true,
          });
        }
      }
    }
  }

  return { allocations };
}
