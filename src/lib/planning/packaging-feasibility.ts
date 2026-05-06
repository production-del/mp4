/**
 * Packaging feasibility — green/amber/red for a proposed packaging run.
 *
 *   • `green`  — intermediate + labels already at MF Packaging in sufficient qty
 *   • `amber`  — sufficient globally, but requires a warehouse transfer
 *   • `red`    — insufficient globally (requires fresh production or PO)
 *
 * Pure function. Callers: the packaging-calendar cards, the priority
 * proposals selector, and (in future) anywhere else that needs to explain
 * whether a proposed packaging quantity is reachable.
 *
 * Note: this is per-card / per-proposal. It does NOT simulate forward
 * consumption across multiple items competing for the same intermediate.
 * The family feasibility footer on the Packaging Plan catches that case
 * at aggregate level.
 */

export type PackagingFeasibilityState = 'green' | 'amber' | 'red';

export interface PackagingFeasibilityInput {
  /** Whether the run has a food-component dependency. `MF-POS-…` items don't. */
  foodComponentCode: string;
  kgPerUnit: number;
  /** Intermediate SOH at MF Packaging (the packing warehouse). */
  foodComponentSOHAtPackaging: number;
  /** Intermediate SOH across every warehouse. */
  foodComponentSOHGlobal: number;
  /** Label SOH at MF Packaging. */
  labelsOnHand: number;
  /** Label SOH across every warehouse. */
  labelsOnHandGlobal: number;
}

export interface PackagingFeasibilityResult {
  state: PackagingFeasibilityState;
  /** Human-readable explanation for amber/red, empty for green. */
  reason?: string;
}

export function computePackagingFeasibility(
  input: PackagingFeasibilityInput,
  quantity: number,
): PackagingFeasibilityResult {
  if (quantity <= 0) return { state: 'green' };

  const requiredKg = quantity * (input.kgPerUnit || 0);
  const requiredLabels = quantity;
  const hasKgRequirement = input.kgPerUnit > 0 && !!input.foodComponentCode;

  const kgLocal = input.foodComponentSOHAtPackaging;
  const kgGlobal = input.foodComponentSOHGlobal;
  const labelsLocal = input.labelsOnHand;
  const labelsGlobal = input.labelsOnHandGlobal;

  const kgLocalOK = !hasKgRequirement || kgLocal >= requiredKg;
  const kgGlobalOK = !hasKgRequirement || kgGlobal >= requiredKg;
  const labelsLocalOK = labelsLocal >= requiredLabels;
  const labelsGlobalOK = labelsGlobal >= requiredLabels;

  if (kgLocalOK && labelsLocalOK) return { state: 'green' };

  if (kgGlobalOK && labelsGlobalOK) {
    const reasons: string[] = [];
    if (!kgLocalOK) {
      reasons.push(
        `${Math.round(requiredKg - kgLocal)}kg of ${input.foodComponentCode} needs transfer to MF Packaging`,
      );
    }
    if (!labelsLocalOK) {
      reasons.push(`${requiredLabels - labelsLocal} labels needed at MF Packaging`);
    }
    return { state: 'amber', reason: reasons.join(' · ') };
  }

  const reasons: string[] = [];
  if (!kgGlobalOK) {
    reasons.push(
      `${Math.round(requiredKg - kgGlobal)}kg of ${input.foodComponentCode || 'intermediate'} short globally`,
    );
  }
  if (!labelsGlobalOK) {
    reasons.push(`${requiredLabels - labelsGlobal} labels short globally`);
  }
  return { state: 'red', reason: reasons.join(' · ') };
}
