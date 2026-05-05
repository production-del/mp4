/**
 * Parse CSV/TSV of monthly usage data.
 *
 * Expected format (one per line):
 *   SKU,usage
 *   SKU\tusage
 *
 * Tolerates headers, empty lines, and whitespace.
 * Returns a map of productCode → monthlyUsage.
 */
export function parseUsageCSV(
  text: string
): { data: Record<string, number>; errors: string[] } {
  const lines = text.trim().split('\n');
  const data: Record<string, number> = {};
  const errors: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Split by comma or tab
    const parts = line.includes('\t') ? line.split('\t') : line.split(',');
    if (parts.length < 2) {
      errors.push(`Line ${i + 1}: expected "SKU,usage" but got "${line}"`);
      continue;
    }

    const sku = parts[0].trim().toUpperCase();
    const usage = parseFloat(parts[1].trim());

    // Skip header rows
    if (isNaN(usage) && i === 0) continue;
    if (isNaN(usage)) {
      errors.push(`Line ${i + 1}: invalid usage "${parts[1].trim()}" for SKU "${sku}"`);
      continue;
    }

    if (sku && usage >= 0) {
      data[sku] = usage;
    }
  }

  return { data, errors };
}
