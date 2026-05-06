import type { ProductCode, SupplierId } from './join-keys';

/**
 * The many-to-many relationship between ingredients and suppliers — where the
 * tracker adds the value the planner currently lacks.
 *
 * One `SupplyRelationship` per (ingredient, supplier) pair. If prices change,
 * *update* the existing record (keeping `lastVerifiedAt` honest) rather than
 * creating a new one — price history can be a separate append-only log.
 */
export interface SupplyRelationship {
  /** Stable ID the tracker mints; use `<productCode>::<supplierId>` if you want it derivable. */
  id: string;

  ingredientCode: ProductCode;
  supplierId: SupplierId;

  unitPrice: number;
  priceCurrency: string; // usually matches Supplier.currency

  /** Minimum order quantity, in Ingredient.unitOfMeasure units. */
  moq: number;
  /** Lead time in working days. Planner multiplies through BusinessCalendar. */
  leadTimeDays: number;

  /** Is this the primary source for this ingredient? */
  preferred: boolean;
  /** Is this relationship still live (can we order from this supplier today)? */
  active: boolean;

  /** Local-ISO date of last verification (quote confirmed, contract reviewed). */
  lastVerifiedAt: string;

  notes?: string;
}

/**
 * Optional: append-only price history for audit / trend analysis. The tracker
 * decides whether to maintain this; the planner never reads it.
 */
export interface PriceHistoryEntry {
  id: string;
  relationshipId: string;
  unitPrice: number;
  priceCurrency: string;
  observedAt: string; // local-ISO
  source: 'manual' | 'invoice' | 'quote' | 'contract';
  notes?: string;
}
