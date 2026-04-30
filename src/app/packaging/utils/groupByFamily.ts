import type { PackagingSKU, ProductFamily } from '../hooks/usePackagingData';

/**
 * Group SKUs by their food component code (family).
 * Sort families by urgency (lowest min-daysAvailable first).
 * Within each family, sort SKUs by daysAvailable ascending.
 */
export function groupByFamily(
  skus: PackagingSKU[]
): ProductFamily[] {
  const familyMap = new Map<
    string,
    {
      code: string;
      name: string;
      topGroup: string;
      componentSOH: number;
      skus: PackagingSKU[];
    }
  >();

  for (const sku of skus) {
    const existing = familyMap.get(sku.familyCode);
    if (existing) {
      existing.skus.push(sku);
    } else {
      familyMap.set(sku.familyCode, {
        code: sku.familyCode,
        name: sku.familyName,
        topGroup: sku.topGroup,
        // Pin componentSOH to the first SKU's food component — variants
        // within a sub-family are expected to share one intermediate.
        componentSOH: sku.foodComponentSOH,
        skus: [sku],
      });
    }
  }

  const families: ProductFamily[] = [];

  for (const [, group] of familyMap) {
    // Sort SKUs by daysAvailable ascending (most urgent first)
    group.skus.sort((a, b) => a.daysAvailable - b.daysAvailable);

    const urgency = group.skus.length > 0
      ? Math.min(...group.skus.map(s => s.daysAvailable))
      : Infinity;

    const totalSuggestedKg = group.skus.reduce(
      (sum, sku) => sum + sku.suggestedQty * sku.kgPerUnit,
      0
    );

    families.push({
      familyCode: group.code,
      familyName: group.name,
      topGroup: group.topGroup,
      componentSOH: group.componentSOH,
      urgency,
      totalSuggestedKg,
      feasible: totalSuggestedKg <= group.componentSOH,
      skus: group.skus,
    });
  }

  // Sort families by urgency ascending
  families.sort((a, b) => a.urgency - b.urgency);

  return families;
}
