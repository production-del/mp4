'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import type { PackagingSettings } from './usePackagingConfig';
import { groupByFamily } from '../utils/groupByFamily';
import { WarehouseSOH } from '@/lib/planning/warehouse-soh';
import { WAREHOUSES } from '@/lib/planning/warehouse-assignments';
import { parseAssemblyMeta, stripAssemblyMeta } from '@/lib/planning/assembly-meta';
import type { StockOnHandItem } from '@/lib/unleashed/types';
import {
  normalizeTopGroup,
  stripSizeSuffixFromCode,
  stripSizeSuffixFromName,
} from '../utils/familyGrouping';
import type { SupplierRef } from '@/app/api/packaging-data/route';
export type { SupplierRef };

// ─── Exported types ─────────────────────────────────────────

export interface PackagingSKU {
  productCode: string;
  productName: string;
  productGroup: string;
  sizeVariant: string;
  familyCode: string;
  familyName: string;

  fgSOH: number;
  availableStock: number; // global SOH across all warehouses
  monthlyUsage: number | null;
  dailyUsage: number;
  daysAvailable: number;

  foodComponentCode: string;
  /**
   * Top-level family navigation group. Consolidated view of
   * Unleashed's productGroup — bulk variants merge into their parent
   * group, and mushroom pantry items promote into "Fungi".
   */
  topGroup: string;
  /**
   * Intermediate SOH at Lundberg Storeroom (the production warehouse).
   * Historically "the" intermediate SOH — still used for `canAssemble` and
   * the family-level feasibility footer.
   */
  foodComponentSOH: number;
  /** Intermediate SOH at MF Packaging (already moved for packing). */
  foodComponentSOHAtPackaging: number;
  /** Intermediate SOH summed across every warehouse. */
  foodComponentSOHGlobal: number;
  kgPerUnit: number;
  canAssemble: number;

  labelSKU: string;
  /** Labels at MF Packaging (the packing warehouse). */
  labelsOnHand: number;
  /** Labels summed across every warehouse. */
  labelsOnHandGlobal: number;
  labelETA: string | null;

  suggestedQty: number;

  existingAssemblyId?: string;
  existingAssemblyNumber?: string;
  existingAssemblyQty?: number;
  existingAssemblyDate?: string;
  /** Team parsed from the existing Unleashed assembly's `comments` field, if any. */
  existingAssemblyTeam?: 'elephant' | 'dust' | 'hand' | 'bottling' | 'bulk';
  /** Free-form human notes on the existing assembly, tags stripped. */
  existingAssemblyNotes?: string;
}

export interface ProductFamily {
  familyCode: string;
  familyName: string;
  /**
   * Consolidated top group (e.g. "MF - Nuts", "Fungi"). Multiple families
   * can share the same topGroup — the table view uses it as the outer
   * navigation level.
   */
  topGroup: string;
  componentSOH: number;
  urgency: number;
  totalSuggestedKg: number;
  feasible: boolean;
  skus: PackagingSKU[];
}

// ─── Size variant extraction ────────────────────────────────

const SIZE_PATTERNS: [RegExp, string][] = [
  [/\bXLRG\b|\bXLG\b|\bXL\b/i, 'XLG'],
  [/\bLRG\b|\bLG\b/i, 'LRG'],
  [/\bMED\b|\bME\b/i, 'MED'],
  [/\bSML\b|\bSM\b/i, 'SML'],
  [/\bBULK\b|\bBLK\b/i, 'BLK'],
  [/\bBAG\b/i, 'BAG'],
];

function extractSize(productName: string): string {
  for (const [pattern, label] of SIZE_PATTERNS) {
    if (pattern.test(productName)) return label;
  }
  return '';
}

// ─── Raw API response type ──────────────────────────────────

interface RawSOHItem {
  productCode: string;
  productName: string;
  quantity: number;
}

interface RawAssembly {
  assemblyId: string;
  assemblyNumber: string;
  productCode: string;
  productName: string;
  quantity: number;
  status: string;
  createdOn: string;
  /**
   * Unleashed's `AssembleBy` field — when the assembly is SCHEDULED to
   * happen. Preferred for dayInt conversion; `createdOn` is the fallback
   * for legacy records that pre-date this field.
   */
  assembleBy?: string;
  assemblyLines: {
    productCode: string;
    productDescription: string;
    componentQuantity: number;
  }[];
  /** Free-form notes. May contain `[TEAM:<slug>]` machine tags. */
  comments?: string;
}

interface RawBOMEntry {
  productCode: string;          // component code (e.g. IAW)
  productDescription: string;
  quantityPerParent: number;    // kg per unit of parent FG
  parentProductCode: string;    // the FG SKU code
}

interface PackagingDataPayload {
  sohItems: RawSOHItem[];
  assemblies: RawAssembly[];
  openPOs: { purchaseOrderLines: { productCode: string; expectedDeliveryDate?: string }[] }[];
  bomEntries: RawBOMEntry[];
  productGroups: Record<string, string>;
  supplierByCode?: Record<string, SupplierRef>;
}

// ─── Intermediate registry (for family names) ───────────────

const INTERMEDIATE_NAMES: Record<string, string> = {
  IAW: 'Walnuts Activated',
  IABR: 'Brazil Nuts Activated',
  IAA: 'Almonds Activated',
  IAM: 'Mixed Nuts Activated',
  IGC: 'Cacao Granola',
  IGE: 'Eros Granola',
  IMM: 'Maple Munchies',
  ICC: 'Choc Clusters',
  IAB: 'Buckwheat Activated',
  IAH: 'Hazelnuts Activated',
  IAP: 'Pepitas Activated',
  IGG: 'Golden Granola',
  IGB: 'Birchia Granola',
};

// ─── Hook ───────────────────────────────────────────────────

export function usePackagingData(
  settings: PackagingSettings,
  monthlyUsage: Record<string, number>,
  familyTargetDays: Record<string, number> = {}
) {
  const [rawData, setRawData] = useState<PackagingDataPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async (refresh = false) => {
    try {
      setLoading(true);
      const url = `/api/packaging-data${refresh ? '?refresh=true' : ''}`;
      const res = await fetch(url);
      const json = await res.json();
      if (json.success) {
        setRawData(json.data);
        setError(null);
      } else {
        setError(json.error || 'Failed to fetch data');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial fetch
  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Auto-refresh on interval
  useEffect(() => {
    const intervalMs = Math.min(
      settings.fetchIntervals.soh,
      settings.fetchIntervals.assemblies
    ) * 60 * 1000;
    if (intervalMs <= 0) return;
    const id = setInterval(() => fetchData(), intervalMs);
    return () => clearInterval(id);
  }, [settings.fetchIntervals.soh, settings.fetchIntervals.assemblies, fetchData]);

  // Build SKUs and families from raw data
  const { skus, families, sohMap, globalSOH, soh } = useMemo(() => {
    if (!rawData) return { skus: [], families: [], sohMap: {} as Record<string, number>, globalSOH: {} as Record<string, number>, soh: null as WarehouseSOH | null };

    // 1. Build warehouse-aware SOH view.
    //
    //    FG + labels → GLOBAL total across every warehouse. The packaging
    //    plan answers "how many of this SKU do we have to fulfill orders?"
    //    — not "how many are physically at the packaging bench?" Most
    //    finished-goods stock lives at TBC (the dispatch warehouse); only
    //    a small amount sits at MF Packaging mid-cycle. Scoping to MF
    //    Packaging hid ~80% of FG stock and made days-of-cover unusable.
    //
    //    Food components → Lundberg Storeroom (with global fallback) —
    //    production happens there and intermediates rarely move.
    const soh = new WarehouseSOH(rawData.sohItems as StockOnHandItem[]);
    const globalSOH = soh.globalOnHandMap();
    const sohMap = globalSOH;                        // FG+labels: global
    const availMap = soh.globalAvailableMap();       // FG+labels: global available
    const componentSOHMap = soh.byWarehouseOrGlobalMap(WAREHOUSES.LUNDBERG);
    // For per-card feasibility colouring we need three warehouse slices:
    //   • intermediate at MF Packaging → "green" (already where we pack)
    //   • intermediate globally        → "amber vs red" split for transferable stock
    //   • labels at MF Packaging       → labels live with the packing bench
    const componentSOHAtPackagingMap = soh.byWarehouseMap(WAREHOUSES.MF_PACKAGING);
    const labelSOHAtPackagingMap = componentSOHAtPackagingMap; // same underlying map
    const globalAnyMap = globalSOH;

    // 2. Build BOM map: FG productCode → { componentCode, kgPerUnit }
    // Skip intermediate-to-intermediate entries (e.g., IAW as component of IAM)
    // All FG packaging SKUs start with "MF"; intermediates start with "I"
    const INTERMEDIATE_PREFIXES = ['IA', 'IG', 'IM', 'IC', 'IS', 'IY'];
    const isIntermediateCode = (code: string) =>
      INTERMEDIATE_PREFIXES.some(p => code.startsWith(p)) ||
      Object.keys(INTERMEDIATE_NAMES).includes(code);

    const bomMap = new Map<string, { componentCode: string; kgPerUnit: number }>();
    for (const entry of rawData.bomEntries) {
      if (!entry.parentProductCode || entry.quantityPerParent <= 0) continue;
      // Skip if the parent is itself an intermediate (by group or code pattern)
      const parentGroup = rawData.productGroups[entry.parentProductCode];
      if (parentGroup === 'MF - Intermediate') continue;
      if (isIntermediateCode(entry.parentProductCode)) continue;
      bomMap.set(entry.parentProductCode, {
        componentCode: entry.productCode,
        kgPerUnit: entry.quantityPerParent,
      });
    }

    // 3. Also extract BOM info from assembly lines (for SKUs not in BOM cache)

    for (const assembly of rawData.assemblies) {
      if (bomMap.has(assembly.productCode)) continue;
      // Find the food component line — an intermediate (I-prefix), not packaging materials
      let foodComponent: { code: string; qty: number } | null = null;
      for (const line of assembly.assemblyLines) {
        if (isIntermediateCode(line.productCode)) {
          // Prefer the intermediate with the highest quantity (primary food input)
          if (!foodComponent || line.componentQuantity > foodComponent.qty) {
            foodComponent = { code: line.productCode, qty: line.componentQuantity };
          }
        }
      }
      if (foodComponent && assembly.quantity > 0) {
        bomMap.set(assembly.productCode, {
          componentCode: foodComponent.code,
          kgPerUnit: foodComponent.qty / assembly.quantity,
        });
      }
    }

    // 4. Build label ETA map from open POs
    const labelETAMap = new Map<string, string>();
    for (const po of rawData.openPOs) {
      for (const line of (po.purchaseOrderLines || [])) {
        if (line.productCode?.startsWith('L') && line.expectedDeliveryDate) {
          const existing = labelETAMap.get(line.productCode);
          // Keep the earliest ETA
          if (!existing || line.expectedDeliveryDate < existing) {
            labelETAMap.set(line.productCode, line.expectedDeliveryDate);
          }
        }
      }
    }

    // 5. Build existing assembly map + product name map from SOH/assemblies
    const assemblyMap = new Map<string, RawAssembly>();
    const nameMap = new Map<string, string>();
    for (const assembly of rawData.assemblies) {
      if (!assemblyMap.has(assembly.productCode)) {
        assemblyMap.set(assembly.productCode, assembly);
      }
      nameMap.set(assembly.productCode, assembly.productName);
    }
    for (const item of rawData.sohItems) {
      if (!nameMap.has(item.productCode) && item.productName) {
        nameMap.set(item.productCode, item.productName);
      }
    }

    // 6. Build SKU list — start with products that have BOM data
    const skuSet = new Set<string>();
    const skus: PackagingSKU[] = [];

    /**
     * Product groups that are excluded from the packaging planner table
     * view. These codes are still valid BOM components (the export and card
     * modal walk `bomEntries` independently and will surface them), but an
     * operator planning packaging runs doesn't want printed bags / pouches
     * / jars cluttering the "what to pack" list.
     */
    const EXCLUDED_GROUPS = new Set<string>([
      'MF - Packaging',
      'MF - Packaging (Printed Bags)',
    ]);

    /** Helper: classify FG product code as "sellable" (not intermediate, label, or packaging) */
    const isSellableFG = (code: string) => {
      if (isIntermediateCode(code)) return false;
      if (code.startsWith('L') && !code.startsWith('LI')) return false; // labels
      if (code.startsWith('[')) return false; // packaging materials
      if (EXCLUDED_GROUPS.has(rawData.productGroups[code] || '')) return false;
      // MF = Mullumbimby Foods, SD = Stardust, BF = Byron Foods
      return code.startsWith('MF') || code.startsWith('SD') || code.startsWith('BF');
    };

    /** Helper: build a SKU from product code, optional BOM data */
    const buildSKU = (
      fgCode: string,
      bom: { componentCode: string; kgPerUnit: number } | null
    ): PackagingSKU | null => {
      const assembly = assemblyMap.get(fgCode);
      const productName = nameMap.get(fgCode) || fgCode;
      const productGroup = rawData.productGroups[fgCode] || '';

      if (productGroup === 'MF - Intermediate') return null;
      if (EXCLUDED_GROUPS.has(productGroup)) return null;
      if (isIntermediateCode(fgCode)) return null;

      const fgSOH = sohMap[fgCode] || 0;
      const fgAvail = availMap[fgCode] || 0;
      const availableStock = fgAvail;
      const usage = monthlyUsage[fgCode] ?? null;
      const dailyUsage = usage !== null ? usage / settings.workingDaysPerMonth : 0;
      const daysAvailable = dailyUsage > 0 ? fgAvail / dailyUsage : Infinity;

      const componentCode = bom?.componentCode || '';
      const kgPerUnit = bom?.kgPerUnit || 0;
      const foodComponentSOH = componentCode ? (componentSOHMap[componentCode] || 0) : 0;
      const foodComponentSOHAtPackaging = componentCode
        ? (componentSOHAtPackagingMap[componentCode] || 0)
        : 0;
      const foodComponentSOHGlobal = componentCode ? (globalAnyMap[componentCode] || 0) : 0;
      const canAssemble = kgPerUnit > 0 ? foodComponentSOH / kgPerUnit : 0;

      const labelSKU = 'L' + fgCode;
      const labelsOnHand = labelSOHAtPackagingMap[labelSKU] || 0;
      const labelsOnHandGlobal = globalAnyMap[labelSKU] || 0;
      const labelETA = labelETAMap.get(labelSKU) || null;

      // New family model:
      //   - topGroup = consolidated Unleashed product group (navigation)
      //   - familyCode = base product code with sizes + known variant
      //     qualifiers stripped, so sibling sizes collapse together
      //   - familyName is decided post-hoc in a second pass because it
      //     wants the shortest productName among the family's members.
      //     We seed it with a placeholder here and refine below.
      const topGroup = normalizeTopGroup(productGroup, productName);
      const familyCode = stripSizeSuffixFromCode(fgCode);
      const familyName = stripSizeSuffixFromName(productName);

      const targetDays = familyTargetDays[familyCode] ?? settings.targetDays;
      // Suggested = demand for target period minus what we already have
      // targetDays is calendar days: 60 days = 2 months
      const suggestedQty = usage !== null && usage > 0
        ? Math.max(0, Math.round(usage * (targetDays / 30) - availableStock))
        : 0;

      return {
        productCode: fgCode,
        productName,
        productGroup,
        sizeVariant: extractSize(productName),
        familyCode,
        familyName,
        topGroup,

        fgSOH,
        availableStock,
        monthlyUsage: usage,
        dailyUsage,
        daysAvailable,

        foodComponentCode: componentCode,
        foodComponentSOH,
        foodComponentSOHAtPackaging,
        foodComponentSOHGlobal,
        kgPerUnit,
        canAssemble,

        labelSKU,
        labelsOnHand,
        labelsOnHandGlobal,
        labelETA,

        suggestedQty,

        existingAssemblyId: assembly?.assemblyId,
        existingAssemblyNumber: assembly?.assemblyNumber,
        existingAssemblyQty: assembly?.quantity,
        // Prefer the Unleashed `Assemble By` schedule date; fall back to
        // `createdOn` only when Unleashed hasn't been given one. The calendar
        // and table both convert this to a dayInt with weekend rounding up
        // (Sat/Sun → following Monday) — see `dateToDayInt(..., {weekend:'up'})`
        // call sites.
        existingAssemblyDate: assembly?.assembleBy || assembly?.createdOn,
        existingAssemblyTeam: assembly ? parseAssemblyMeta(assembly.comments).team : undefined,
        existingAssemblyNotes: assembly ? stripAssemblyMeta(assembly.comments) : undefined,
      };
    };

    // 6a. Products with BOM data (have intermediate component info)
    for (const [fgCode, bom] of bomMap) {
      if (skuSet.has(fgCode)) continue;
      const sku = buildSKU(fgCode, bom);
      if (sku) {
        skuSet.add(fgCode);
        skus.push(sku);
      }
    }

    // 6b. ALL remaining sellable FGs from SOH (no BOM data)
    for (const item of rawData.sohItems) {
      if (skuSet.has(item.productCode)) continue;
      if (!isSellableFG(item.productCode)) continue;
      const sku = buildSKU(item.productCode, null);
      if (sku) {
        skuSet.add(item.productCode);
        skus.push(sku);
      }
    }

    // 6c. Also include sellable FGs from assemblies not yet covered
    for (const assembly of rawData.assemblies) {
      if (skuSet.has(assembly.productCode)) continue;
      if (!isSellableFG(assembly.productCode)) continue;
      const sku = buildSKU(assembly.productCode, null);
      if (sku) {
        skuSet.add(assembly.productCode);
        skus.push(sku);
      }
    }

    // 7. Second pass: replace each SKU's provisional `familyName` with the
    // SHORTEST stripped-productName found across its sub-family. This is
    // what gives us a clean heading like "Mixed Nuts" instead of the long
    // variant phrase "I'm Nuts For You - Mixed Nuts - Organic & Activated".
    const shortestNameByFamily = new Map<string, string>();
    for (const sku of skus) {
      const existing = shortestNameByFamily.get(sku.familyCode);
      if (!existing || sku.familyName.length < existing.length) {
        shortestNameByFamily.set(sku.familyCode, sku.familyName);
      }
    }
    for (const sku of skus) {
      const best = shortestNameByFamily.get(sku.familyCode);
      if (best) sku.familyName = best;
    }

    // 8. Group into families (sub-family level). The group-by-family util
    // sees the new familyCode (base product key), so each sub-family holds
    // only its size/variant siblings.
    const families = groupByFamily(skus);

    return { skus, families, sohMap, globalSOH, soh };
  }, [rawData, monthlyUsage, settings.workingDaysPerMonth, settings.targetDays, familyTargetDays]);

  return {
    skus,
    families,
    sohMap,       // MF Packaging warehouse SOH (FG + labels)
    globalSOH,    // All warehouses (for reference / amber detection)
    soh,          // Full WarehouseSOH view — null until the first fetch completes
    rawData,      // Raw payload — exposed for the export flow (BOM, openPOs, etc.)
    loading,
    error,
    refetch: () => fetchData(true),
  };
}
