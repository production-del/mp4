import type { SupplierId } from './join-keys';

export interface SupplierContact {
  email?: string;
  phone?: string;
  website?: string;
  address?: string;
  primaryName?: string;
}

/**
 * A supplier. `supplierId` is the Unleashed Guid; the tracker owns the
 * metadata beyond name/contact (payment terms, preferred currency, notes).
 */
export interface Supplier {
  supplierId: SupplierId;
  supplierName: string;
  supplierCode?: string;
  contact?: SupplierContact;
  /** Free-text payment terms, e.g. `"Net 30"`, `"COD"`, `"Prepay"`. */
  paymentTerms?: string;
  /** ISO 4217 currency code, `"AUD"` default. */
  currency: string;
  notes?: string;
  active: boolean;
}
