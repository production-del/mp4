/**
 * Join keys — the identifiers that let two apps talk about the same entity.
 *
 * Branded strings catch "passed ProductCode where SupplierId was expected"
 * at compile time without needing runtime validation. Construct with the
 * factory functions; consume as plain strings.
 *
 * These brand tags match Unleashed's identity model: Unleashed is the source
 * of truth for Products and Suppliers. Both Byron apps (planner, tracker)
 * join on these IDs.
 */

declare const ProductCodeBrand: unique symbol;
declare const SupplierIdBrand: unique symbol;
declare const WarehouseIdBrand: unique symbol;

/** The `productCode` string from Unleashed, branded so it can't be confused
 *  with other string IDs. */
export type ProductCode = string & { readonly [ProductCodeBrand]: void };

/** The Unleashed Supplier `Guid`, branded. */
export type SupplierId = string & { readonly [SupplierIdBrand]: void };

/** The Unleashed Warehouse `Guid`, branded. */
export type WarehouseId = string & { readonly [WarehouseIdBrand]: void };

// Factory functions (the only way to mint a branded value).

export const ProductCode = (s: string): ProductCode => s as ProductCode;
export const SupplierId = (s: string): SupplierId => s as SupplierId;
export const WarehouseId = (s: string): WarehouseId => s as WarehouseId;
