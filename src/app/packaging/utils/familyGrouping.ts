/**
 * Helpers that turn raw Unleashed productGroup + productCode/productName
 * into the two-level family hierarchy the packaging plan table uses:
 *
 *   Top group    (navigation level)                 e.g. "MF - Nuts"
 *     └ Sub-family (SKUs sharing a base product)    e.g. "Mixed Nuts"
 *         └ SKU variants (different sizes)          e.g. SML / MED / LRG / BULK
 *
 * The derivations here are pure and regex-based so they can be swapped out
 * or overridden per-SKU later without pulling in heavy NLP. The rules were
 * calibrated to real Unleashed catalogue patterns:
 *
 *   - Bulk variants of Pantry items (MFCACAPB3.2) fold into the same
 *     top group as their standard counterparts — "MF - Pantry (Bulk)"
 *     and "Bulk Products" remap to "MF - Pantry".
 *   - Mushroom-ish products sitting in MF - Pantry (Oyster Mushrooms,
 *     Reishi Slices) promote to "Fungi" via a keyword override.
 *   - Product codes strip trailing size tokens AND the `INFY` variant
 *     qualifier so "I'm Nuts For You" sizes collapse into Mixed Nuts.
 *     RAW variants use a different base prefix (MFRMIXN vs MFMIXEN) and
 *     stay as a separate family by construction.
 */

/**
 * Productgroup → canonical top group. Anything not in the map falls
 * through as-is. Empty productGroup gets "Other".
 */
const TOP_GROUP_MAP: Record<string, string> = {
  'MF - Pantry (Bulk)': 'MF - Pantry',
  'Bulk Products': 'MF - Pantry',
};

/**
 * Keyword override: any productName matching this promotes the SKU to
 * the "Fungi" top group regardless of its underlying productGroup. Used
 * to catch mushroom pantry items that Unleashed doesn't already classify
 * as Fungi.
 */
const FUNGI_NAME_PATTERN = /\b(mushroom|mushrooms|reishi|lion'?s?\s*mane|cordyceps|chaga)\b/i;

export function normalizeTopGroup(productGroup: string, productName: string): string {
  if (FUNGI_NAME_PATTERN.test(productName)) return 'Fungi';
  return TOP_GROUP_MAP[productGroup] ?? (productGroup || 'Other');
}

/**
 * Tokens we'll strip from the END of a product code to get the base
 * product key. Ordered so the regex's alternation tries the longer
 * tokens first (e.g. XLRG before XL, SML before SM) — JS alternation
 * is leftmost-first, so ordering here matters.
 *
 * `B\d+(\.\d+)?` matches bulk size suffixes like B5, B11, B3.2.
 * `INFY` is a known variant qualifier that should collapse into its
 * base family ("I'm Nuts For You" → Mixed Nuts).
 */
const SIZE_OR_QUALIFIER_SUFFIX = /(B\d+(\.\d+)?|INFY|XLRG|XLG|XL|LRG|LG|MED|ME|SML|SM|BLK|BG)$/;

/**
 * Strip trailing size tokens (and known variant qualifiers) from a
 * product code so sibling variants collapse to the same base key. Loops
 * up to 3 times so codes with both a qualifier and a size (e.g.
 * `MFMIXENINFYSM` = [base][qualifier][size]) reduce fully.
 *
 * Refuses to strip the code down to 2 characters or fewer — keeps us
 * safe against degenerate inputs.
 */
export function stripSizeSuffixFromCode(productCode: string): string {
  let base = productCode;
  for (let i = 0; i < 3; i++) {
    const m = SIZE_OR_QUALIFIER_SUFFIX.exec(base);
    if (!m) break;
    const next = base.slice(0, -m[0].length);
    if (next.length < 3) break;
    base = next;
  }
  return base;
}

/**
 * Strip size/quantity annotations from a product name so we can pick
 * the shortest "pure" name in a sub-family as its display name.
 *
 * Covers the common Unleashed naming patterns we see:
 *   - trailing parenthesised qty:      " (120g)"  " (1.2kg)"
 *   - trailing hyphen-qty:             " - 350g"  " - 1kg"
 *   - trailing size keyword:           " SML"     " BULK"  " XLRG"
 * Iterates so combinations like "SML (120g)" peel off cleanly.
 */
export function stripSizeSuffixFromName(name: string): string {
  let out = name;
  for (let i = 0; i < 4; i++) {
    const before = out;
    out = out
      .replace(/\s*\(\d+(?:\.\d+)?\s*(?:k?g|ml|l)\)\s*$/i, '')
      .replace(/\s*-\s*\d+(?:\.\d+)?\s*(?:k?g|ml|l)\b\s*$/i, '')
      .replace(/\s*\b(SML|SM|MED|ME|LRG|LG|XLRG|XLG|XL|BULK|BLK)\b\s*$/i, '')
      .trim();
    if (out === before) break;
  }
  return out || name;
}
