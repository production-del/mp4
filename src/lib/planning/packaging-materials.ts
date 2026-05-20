/**
 * Packaging-material code classifier — Phase 4l.10.
 *
 * Stickers / labels and printed bags are first-class raw materials but they
 * have a distinctive code-naming convention in the BOMS sheet:
 *
 *   • `L<productCode>`   — sticker / label for that finished good.
 *     Example: `LMFMATCHSM` is the label for `MFMATCHSM`.
 *     Exception: codes starting with `LI` (Lundberg ingredients) are NOT
 *     labels — they're intermediates. The classifier respects that.
 *
 *   • `PB<productCode>`  — printed bag (e.g. PBMFCHAGAB for bulk Chaga).
 *
 * Used by the calendar projection to flag packaging chips whose required
 * sticker / bag is short on stock — the PO-placed chip already appears on
 * the calendar (driven by `analyzeRawMaterials`); this classifier exists
 * so the packaging chip itself can warn "this run is label-blocked".
 *
 * No data fetching here — pure string classification so it stays unit-
 * testable and side-effect-free.
 */

export type PackagingMaterialKind = 'label' | 'printed_bag';

/** True iff the given product code names a sticker/label or printed bag. */
export function isPackagingMaterial(code: string): boolean {
  return classifyPackagingMaterial(code) !== null;
}

/**
 * Returns the kind of packaging material, or `null` for any other code
 * (intermediates, raw ingredients, finished goods).
 */
export function classifyPackagingMaterial(
  code: string,
): PackagingMaterialKind | null {
  if (!code) return null;
  if (code.startsWith('PB') && code.length > 2) return 'printed_bag';
  if (code.startsWith('L') && !code.startsWith('LI') && code.length > 1) {
    return 'label';
  }
  return null;
}

/** Human-readable name for surface UI strings. */
export function packagingMaterialKindLabel(kind: PackagingMaterialKind): string {
  switch (kind) {
    case 'label':
      return 'Label';
    case 'printed_bag':
      return 'Printed bag';
  }
}
