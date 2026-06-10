/**
 * Resource-allocation spec builder.
 *
 * Turns the planner's on-disk caches into a linear-program spec that the
 * companion solver (`scripts/allocate-solve.py`) maximises: which finished
 * goods to make, and how many, when one or more shared raw-material inputs
 * are in short supply.
 *
 * It reuses the REAL planner engine — `loadCapacityDataFromPath` (BOMs,
 * family map, intermediates) and `explodeBom` — so the per-unit raw-material
 * consumption it computes is identical to what the planner schedules
 * against. No bespoke BOM parsing, no drift.
 *
 * Data sources (all under ../data, relative to this file):
 *   • kitchen capacity and family plans.xlsx → BOMs + family + intermediates
 *   • finished-goods-allowlist.json          → which SKUs we're allowed to make
 *   • product-profit.json                    → contribution margin per unit
 *   • demand.csv                             → monthly demand cap per SKU (AVE)
 *   • soh-cache.json                         → raw-material stock on hand
 *   • purchase-orders-cache.json             → incoming supply (optional)
 *
 * Output: a spec JSON consumed by allocate-solve.py. The spec carries a
 * `_meta` block (ignored by the solver) describing what was excluded and why,
 * so the skill can surface gaps honestly rather than silently dropping SKUs.
 *
 * Usage:
 *   npx tsx scripts/allocate-resources.ts [options]
 *
 * Options:
 *   --out <path>            Where to write the spec (default: data/.allocation-spec.json)
 *   --scarce <codes>        Comma-separated raw-material codes to treat as THE
 *                           limited inputs. Others are left unconstrained.
 *                           Append =<qty> to override available quantity,
 *                           e.g. --scarce RAWWALNUT=500,ABBNR. When omitted,
 *                           EVERY raw material is constrained by its current
 *                           on-hand quantity ("what can we make right now").
 *   --warehouse <name>      Only count SOH in this warehouse (substring match,
 *                           case-insensitive). Default: sum across all.
 *   --include-incoming      Add Open purchase-order quantities to supply.
 *   --incoming-by <date>    With --include-incoming, only count POs arriving on
 *                           or before this YYYY-MM-DD.
 *   --demand-scale <n>      Multiply every demand cap by n (e.g. 2 = two months).
 *   --verbose               Print a human summary to stderr.
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { loadCapacityDataFromPath } from '@/lib/planning/capacity-data';
import { loadFromFile } from '@/lib/planning/demand-data-loader';
import { explodeBom } from '@/lib/engine/bom-explode';

// ─── Paths ───────────────────────────────────────────────────

const ROOT = resolve(__dirname, '..');
const DATA = join(ROOT, 'data');
const XLSX_PATH = join(DATA, 'kitchen capacity and family plans.xlsx');

// ─── Arg parsing ─────────────────────────────────────────────

interface Options {
  out: string;
  scarce: Map<string, number | null> | null; // code → optional qty override
  warehouse: string | null;
  includeIncoming: boolean;
  incomingBy: string | null;
  demandScale: number;
  verbose: boolean;
}

function parseArgs(argv: string[]): Options {
  const o: Options = {
    out: join(DATA, '.allocation-spec.json'),
    scarce: null,
    warehouse: null,
    includeIncoming: false,
    incomingBy: null,
    demandScale: 1,
    verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--out':
        o.out = resolve(next());
        break;
      case '--scarce': {
        o.scarce = new Map();
        for (const tok of next().split(',')) {
          const t = tok.trim();
          if (!t) continue;
          const eq = t.indexOf('=');
          if (eq >= 0) {
            o.scarce.set(t.slice(0, eq).trim(), Number(t.slice(eq + 1)));
          } else {
            o.scarce.set(t, null);
          }
        }
        break;
      }
      case '--warehouse':
        o.warehouse = next();
        break;
      case '--include-incoming':
        o.includeIncoming = true;
        break;
      case '--incoming-by':
        o.incomingBy = next();
        break;
      case '--demand-scale':
        o.demandScale = Number(next());
        break;
      case '--verbose':
        o.verbose = true;
        break;
      default:
        if (a.startsWith('--')) {
          throw new Error(`Unknown option: ${a}`);
        }
    }
  }
  return o;
}

// ─── Cache readers ───────────────────────────────────────────

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf-8')) as T;
}

interface ProfitFile {
  byCode: Record<string, { profitPerItem: number | null }>;
}
interface SohFile {
  fetchedAt: string;
  byProductCode: Record<string, Record<string, number>>;
}
interface PoFile {
  fetchedAt: string;
  lines: Array<{
    productCode: string;
    quantity: number;
    expectedDeliveryDate?: string;
    status: string;
  }>;
}

/** Sum SOH for a code across warehouses, optionally filtered by name. */
function sohFor(
  soh: SohFile,
  code: string,
  warehouse: string | null,
): number {
  const byWh = soh.byProductCode[code];
  if (!byWh) return 0;
  let total = 0;
  for (const [wh, qty] of Object.entries(byWh)) {
    if (warehouse && !wh.toLowerCase().includes(warehouse.toLowerCase())) continue;
    total += qty || 0;
  }
  return total;
}

/** Sum Open incoming PO quantity for a code, optionally within a horizon. */
function incomingFor(po: PoFile, code: string, by: string | null): number {
  let total = 0;
  for (const line of po.lines) {
    if (line.productCode !== code) continue;
    if (line.status !== 'Open') continue;
    if (by && line.expectedDeliveryDate && line.expectedDeliveryDate > by) continue;
    total += line.quantity || 0;
  }
  return total;
}

// ─── Main ────────────────────────────────────────────────────

function main() {
  const opts = parseArgs(process.argv.slice(2));

  const capacity = loadCapacityDataFromPath(XLSX_PATH);
  const { bom, familyMap, intermediates } = capacity;

  const allowlist = readJson<{ codes: string[] }>(
    join(DATA, 'finished-goods-allowlist.json'),
  );
  const profit = readJson<ProfitFile>(join(DATA, 'product-profit.json'));
  const soh = readJson<SohFile>(join(DATA, 'soh-cache.json'));
  const po = opts.includeIncoming
    ? readJson<PoFile>(join(DATA, 'purchase-orders-cache.json'))
    : null;
  const demand = loadFromFile(ROOT);
  const rates: Record<string, number> = demand?.rates ?? {};

  // A "leaf" raw material is any component code that never appears as the
  // parent of a BOM row — i.e. it's purchased, not manufactured. Intermediates
  // (which have their own BOM rows) are parents, so they're excluded
  // automatically. Packaging materials (bags, boxes, labels) are leaves too,
  // and are exactly the kind of shared input that runs short.
  const parentCodes = new Set(bom.map((b) => b.parentProductCode));
  const isLeaf = (code: string) => !parentCodes.has(code);

  const products: Array<{
    name: string;
    margin: number;
    demand_max: number;
    integer: boolean;
  }> = [];
  const recipe: Record<string, Record<string, number>> = {};
  const ingredientNames = new Set<string>();
  const ingredientLabels: Record<string, string> = {};

  const excludedNoMargin: string[] = [];
  const excludedNoBom: string[] = [];
  const noDemand: string[] = [];

  for (const code of allowlist.codes) {
    const margin = profit.byCode[code]?.profitPerItem;
    if (margin == null) {
      excludedNoMargin.push(code);
      continue;
    }

    const exploded = explodeBom({
      rootProductCode: code,
      rootQuantity: 1,
      bom,
      familyMap,
    });
    const noBom = exploded.warnings.some((w) => w.kind === 'no_bom_for_root');
    if (noBom || exploded.components.length === 0) {
      excludedNoBom.push(code);
      continue;
    }

    // Sum fully-exploded consumption of every leaf raw material for one unit.
    const perUnit: Record<string, number> = {};
    for (const c of exploded.components) {
      if (!isLeaf(c.productCode)) continue;
      if (c.totalQuantity <= 0) continue;
      perUnit[c.productCode] = (perUnit[c.productCode] ?? 0) + c.totalQuantity;
      ingredientNames.add(c.productCode);
      if (!ingredientLabels[c.productCode]) {
        ingredientLabels[c.productCode] = c.productName || c.productCode;
      }
    }
    if (Object.keys(perUnit).length === 0) {
      // Has a BOM but no leaf raw materials (everything resolved to
      // intermediates with no further BOM, or zero quantities) — can't model.
      excludedNoBom.push(code);
      continue;
    }

    const demandCap = Math.round((rates[code] ?? 0) * opts.demandScale);
    if (demandCap <= 0) noDemand.push(code);

    products.push({
      name: code,
      margin,
      demand_max: demandCap,
      integer: true,
    });
    recipe[code] = perUnit;
  }

  // Build the ingredient (constraint) list. Default: every raw material is
  // capped by its on-hand supply. With --scarce: only the named materials are
  // capped; everything else gets effectively-infinite supply so it's modelled
  // as truly unconstrained (the solver still needs the constraint row to exist
  // because the recipe references it).
  const UNCONSTRAINED = 1e12;
  const ingredients: Array<{ name: string; label: string; supply: number; onHand: number; incoming: number; scarce: boolean }> = [];
  for (const code of [...ingredientNames].sort()) {
    const onHand = sohFor(soh, code, opts.warehouse);
    const incoming = po ? incomingFor(po, code, opts.incomingBy) : 0;
    let supply: number;
    let scarce: boolean;
    if (opts.scarce) {
      if (opts.scarce.has(code)) {
        const override = opts.scarce.get(code);
        supply = override != null ? override : onHand + incoming;
        scarce = true;
      } else {
        supply = UNCONSTRAINED;
        scarce = false;
      }
    } else {
      supply = onHand + incoming;
      scarce = true;
    }
    ingredients.push({
      name: code,
      label: ingredientLabels[code] ?? code,
      supply,
      onHand,
      incoming,
      scarce,
    });
  }

  // Warn if a --scarce code wasn't actually used by any included recipe.
  const unusedScarce: string[] = [];
  if (opts.scarce) {
    for (const code of opts.scarce.keys()) {
      if (!ingredientNames.has(code)) unusedScarce.push(code);
    }
  }

  const spec = {
    products,
    ingredients: ingredients.map((i) => ({ name: i.name, supply: i.supply })),
    recipe,
    _meta: {
      generatedAt: new Date().toISOString(),
      sohFetchedAt: soh.fetchedAt,
      poFetchedAt: po?.fetchedAt ?? null,
      warehouse: opts.warehouse,
      includeIncoming: opts.includeIncoming,
      incomingBy: opts.incomingBy,
      demandScale: opts.demandScale,
      scarceMode: opts.scarce ? 'targeted' : 'all-on-hand',
      productCount: products.length,
      ingredientDetail: ingredients,
      excludedNoMargin,
      excludedNoBom,
      noDemand,
      unusedScarce,
    },
  };

  writeFileSync(opts.out, JSON.stringify(spec, null, 2));

  if (opts.verbose) {
    const e = console.error;
    e(`Spec written to ${opts.out}`);
    e(`  products modelled:   ${products.length}`);
    e(`  raw materials:       ${ingredients.length} (${ingredients.filter((i) => i.scarce).length} constrained)`);
    e(`  excluded (no margin): ${excludedNoMargin.length}`);
    e(`  excluded (no BOM):    ${excludedNoBom.length}`);
    e(`  zero-demand:          ${noDemand.length}`);
    if (unusedScarce.length) e(`  WARNING: --scarce codes not used by any recipe: ${unusedScarce.join(', ')}`);
    e(`  SOH cache fetched:    ${soh.fetchedAt}`);
  }
}

main();
