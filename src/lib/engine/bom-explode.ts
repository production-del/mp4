/**
 * BOM exploder — Phase 2 of the 3-month planner.
 *
 * Recursively expands a finished good's bill of materials through every
 * intermediate level until raw materials are reached. Annotates each
 * component with family / extended-family metadata for the Phase 3 batch
 * optimiser, and splits the spreadsheet's combined `Quantity + Wastage`
 * figure into a clean quantity and wastage quantity (per decision #3 in
 * `docs/CAPACITY-DATA.md`).
 *
 * Pure: no I/O, no `Date.now()`, no localStorage. Output is fully derivable
 * from input.
 *
 * Failure semantics
 * ─────────────────
 * - **Cycle detected** → throws with the full cycle path. A cyclic BOM is a
 *   data-integrity violation; silently returning a wrong plan would be worse
 *   than failing loudly. The thrown error names every node in the cycle so
 *   the user can fix the offending row.
 * - **Depth limit exceeded** → throws. Defensive guard for malformed BOMs
 *   that cycle-detect somehow misses; should be unreachable in practice.
 * - **Root has no BOM** → returns empty components + a `no_bom_for_root`
 *   warning. Common case: caller asked for a raw-material code; not an error.
 *
 * Wastage model (decision #3)
 * ──────────────────────────
 * Spreadsheet's `Quantity + Wastage` is the COMBINED figure. Wastage rate `r`
 * (per component) means: `combined = clean × (1 + r)`. So:
 *   `cleanQuantity   = totalQuantity / (1 + r)`
 *   `wastageQuantity = totalQuantity − cleanQuantity`
 *
 * If no rate is supplied for a component, we can't infer the split; we set
 * `cleanQuantity = totalQuantity` and `wastageQuantity = null`. This is
 * better than guessing — the optimiser still has the right total, and
 * downstream cost reporting can show "wastage unknown" rather than fabricate
 * a number.
 */

import type { BOMComponent } from '@/lib/planning/engine-io';

// ─── Public types ────────────────────────────────────────────

/**
 * Family / extended-family metadata for a single product code. Source: the
 * `family` sheet in `data/kitchen capacity and family plans.xlsx`. When a
 * code is absent from the map, `family` and `extendedFamily` come back as
 * `null` — Phase 3's `costToSwitch` treats null extended family as
 * full-clean territory (decision #1).
 */
export interface FamilyMeta {
  family: string;
  extendedFamily: string | null;
}

/** A single component appearance in the explosion. One row per path. */
export interface ExplodedComponent {
  productCode: string;
  productName: string;
  /** Total quantity needed for the requested `rootQuantity`, including wastage. */
  totalQuantity: number;
  /** Theoretical clean quantity, before wastage. Equal to `totalQuantity` when no wastage rate is known. */
  cleanQuantity: number;
  /** `totalQuantity − cleanQuantity`. `null` when no wastage rate was supplied for this code. */
  wastageQuantity: number | null;
  /** 1 = direct child of root, 2 = grandchild, etc. */
  depth: number;
  /** Full path from root to this component, inclusive of both endpoints. */
  path: string[];
  family: string | null;
  extendedFamily: string | null;
}

export interface ExplodeWarning {
  kind: 'no_bom_for_root';
  productCode: string;
  message: string;
}

export interface BomExplodeInput {
  rootProductCode: string;
  rootQuantity: number;
  bom: BOMComponent[];
  familyMap?: Record<string, FamilyMeta>;
  /**
   * Wastage rate per component code, additive multiplier on clean.
   * `0.08` means combined = clean × 1.08. Components without an entry get
   * `cleanQuantity = totalQuantity` and `wastageQuantity = null`.
   */
  wastageRates?: Record<string, number>;
  /** Defensive guard against unbounded recursion. Default 10. */
  maxDepth?: number;
}

export interface BomExplodeResult {
  rootProductCode: string;
  rootQuantity: number;
  /** One row per path from root to a component. Same productCode may appear multiple times if reachable via multiple paths (diamond BOMs). */
  components: ExplodedComponent[];
  warnings: ExplodeWarning[];
}

const DEFAULT_MAX_DEPTH = 10;

// ─── Public API ──────────────────────────────────────────────

export function explodeBom(input: BomExplodeInput): BomExplodeResult {
  const {
    rootProductCode,
    rootQuantity,
    bom,
    familyMap = {},
    wastageRates = {},
    maxDepth = DEFAULT_MAX_DEPTH,
  } = input;

  // Build parent → children index. Single pass over the BOM.
  const childrenByParent = new Map<string, BOMComponent[]>();
  for (const row of bom) {
    let arr = childrenByParent.get(row.parentProductCode);
    if (!arr) {
      arr = [];
      childrenByParent.set(row.parentProductCode, arr);
    }
    arr.push(row);
  }

  const components: ExplodedComponent[] = [];
  const warnings: ExplodeWarning[] = [];

  if (!childrenByParent.has(rootProductCode)) {
    warnings.push({
      kind: 'no_bom_for_root',
      productCode: rootProductCode,
      message: `No BOM rows found with parent ${rootProductCode}; treating as raw material (no components to explode).`,
    });
    return { rootProductCode, rootQuantity, components, warnings };
  }

  // Iterative-style recursion via a closure. The ancestorPath array contains
  // every node from root to the current parent — used for cycle detection
  // and to populate each ExplodedComponent.path.
  function recurse(
    parentCode: string,
    parentTotalQuantity: number,
    ancestorPath: readonly string[],
  ): void {
    if (ancestorPath.length > maxDepth) {
      throw new Error(
        `BOM depth exceeded ${maxDepth} levels at path ${ancestorPath.join(' → ')}. ` +
          `Suspected cycle or malformed BOM.`,
      );
    }
    const children = childrenByParent.get(parentCode);
    if (!children) return; // leaf raw material — recursion ends here

    for (const child of children) {
      // Cycle check: if we'd revisit a node already on the current path, it's
      // a cycle. Throw with the full path so the caller can locate the bad row.
      if (ancestorPath.includes(child.productCode)) {
        const cyclePath = [...ancestorPath, child.productCode];
        throw new Error(`BOM cycle detected: ${cyclePath.join(' → ')}`);
      }

      const childTotal = parentTotalQuantity * child.quantityPerParent;
      // Two sources of wastage info, in priority order:
      //   1. Per-edge split on the BOMComponent itself (from the loader's
      //      `wastage rates` tab). Carries absolute clean + wastage values
      //      for THIS edge, so we scale them by the parent quantity.
      //   2. Per-component multiplicative rate via the `wastageRates`
      //      parameter. Older API; useful when the per-edge data is
      //      unavailable.
      // If neither, wastage stays null and cleanQuantity = childTotal.
      let cleanQuantity: number;
      let wastageQuantity: number | null;
      if (
        typeof child.cleanQuantityPerParent === 'number' &&
        typeof child.wastageQuantityPerParent === 'number'
      ) {
        cleanQuantity = parentTotalQuantity * child.cleanQuantityPerParent;
        wastageQuantity = parentTotalQuantity * child.wastageQuantityPerParent;
      } else {
        const wastageRate = wastageRates[child.productCode];
        const hasRate = typeof wastageRate === 'number' && wastageRate >= 0;
        cleanQuantity = hasRate ? childTotal / (1 + wastageRate) : childTotal;
        wastageQuantity = hasRate ? childTotal - cleanQuantity : null;
      }

      const fam = familyMap[child.productCode];
      const childPath = [...ancestorPath, child.productCode];

      components.push({
        productCode: child.productCode,
        productName: child.productName,
        totalQuantity: childTotal,
        cleanQuantity,
        wastageQuantity,
        depth: ancestorPath.length, // ancestorPath includes the root, so direct children land at depth 1
        path: childPath,
        family: fam?.family ?? null,
        extendedFamily: fam?.extendedFamily ?? null,
      });

      // Recurse only if this child is itself a parent in the BOM. Leaf
      // components (raw materials) terminate the path naturally.
      if (childrenByParent.has(child.productCode)) {
        recurse(child.productCode, childTotal, childPath);
      }
    }
  }

  recurse(rootProductCode, rootQuantity, [rootProductCode]);

  return { rootProductCode, rootQuantity, components, warnings };
}

// ─── Aggregation helper ──────────────────────────────────────

export interface AggregatedComponent {
  productCode: string;
  productName: string;
  totalQuantity: number;
  cleanQuantity: number;
  /** Sum of wastage where known. `null` if any contributor had unknown wastage AND total > 0. */
  wastageQuantity: number | null;
  family: string | null;
  extendedFamily: string | null;
  /** Number of paths that reached this component (1 in flat BOMs, ≥2 in diamond BOMs). */
  pathCount: number;
}

/**
 * Sum exploded rows by `productCode`. Useful for purchasing — "how many kg
 * of walnut raw do I need across all paths?" — where the per-path detail
 * isn't relevant.
 *
 * Wastage aggregation rule: if every contributor has a known wastage value,
 * the result has the sum. If any contributor's wastage was `null` (rate
 * unknown), the result is `null` — we'd rather report unknown than fabricate.
 */
export function aggregateExplodedComponents(
  components: ExplodedComponent[],
): AggregatedComponent[] {
  const map = new Map<string, AggregatedComponent>();
  // Track per-code whether we've seen any null wastage; if so, final result is null.
  const sawNullWastage = new Map<string, boolean>();

  for (const c of components) {
    let agg = map.get(c.productCode);
    if (!agg) {
      agg = {
        productCode: c.productCode,
        productName: c.productName,
        totalQuantity: 0,
        cleanQuantity: 0,
        wastageQuantity: 0,
        family: c.family,
        extendedFamily: c.extendedFamily,
        pathCount: 0,
      };
      map.set(c.productCode, agg);
      sawNullWastage.set(c.productCode, false);
    }
    agg.totalQuantity += c.totalQuantity;
    agg.cleanQuantity += c.cleanQuantity;
    agg.pathCount += 1;
    if (c.wastageQuantity === null) {
      sawNullWastage.set(c.productCode, true);
    } else {
      agg.wastageQuantity = (agg.wastageQuantity ?? 0) + c.wastageQuantity;
    }
  }

  // Apply the null-propagation rule: any null contributor → null aggregate.
  for (const [code, hadNull] of sawNullWastage.entries()) {
    if (hadNull) map.get(code)!.wastageQuantity = null;
  }

  // Stable, deterministic output ordering — alphabetical by productCode.
  return Array.from(map.values()).sort((a, b) => a.productCode.localeCompare(b.productCode));
}
