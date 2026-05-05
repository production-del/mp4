import type { ProductCode } from './join-keys';

/** How Unleashed categorises us + what the planner expects. */
export type IngredientCategory =
  | 'raw_material'
  | 'intermediate'
  | 'finished_good'
  | 'packaging'
  | 'label';

export type UnitOfMeasure = 'kg' | 'L' | 'unit' | 'roll' | 'sheet' | string;

export interface Certification {
  /** Short code — `organic`, `kosher`, `halal`, `fairtrade`, `bcorp`, custom. */
  kind: string;
  issuedBy?: string;
  /** Local-ISO date. */
  expiresAt?: string;
  documentUrl?: string;
  notes?: string;
}

/**
 * An ingredient/product. `productCode` is the join key to Unleashed and to
 * every other app in the Byron ecosystem. Everything else is tracker-owned
 * metadata.
 */
export interface Ingredient {
  productCode: ProductCode;
  productName: string;
  category: IngredientCategory;
  unitOfMeasure: UnitOfMeasure;
  certifications?: Certification[];
  allergens?: string[];
  notes?: string;
}
