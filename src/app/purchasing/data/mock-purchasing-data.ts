/**
 * Mock data for purchasing calendar development and fallback.
 * Creates a realistic scenario with varying stock risk levels.
 */

import type { PurchaseOrder } from '@/lib/unleashed/types';
import type { KitchenBatch } from '@/lib/planning/engine-io';

// --- Suppliers ---

export interface SupplierInfo {
  supplierId: string;
  supplierName: string;
}

export const MOCK_SUPPLIERS: Record<string, SupplierInfo> = {
  'sup-nuts': { supplierId: 'sup-nuts', supplierName: 'Byron Nut Supply' },
  'sup-sweet': { supplierId: 'sup-sweet', supplierName: 'Sweeteners Direct' },
  'sup-organic': { supplierId: 'sup-organic', supplierName: 'Organic Ingredients Co' },
};

// --- Component → Supplier mapping ---

export const MOCK_COMPONENT_SUPPLIERS: Record<string, string> = {
  ABARNPO: 'sup-nuts',
  RAWWALNUT: 'sup-nuts',
  ABBNR: 'sup-nuts',
  RAWCASH: 'sup-nuts',
  BOBKGF: 'sup-organic',
  CACPOW: 'sup-sweet',
  COCOSUG: 'sup-sweet',
  ABCTCO: 'sup-organic',
};

// --- Component names ---

export const MOCK_COMPONENT_NAMES: Record<string, string> = {
  ABARNPO: 'Almonds (Raw)',
  RAWWALNUT: 'Walnuts (Raw)',
  ABBNR: 'Brazil Nuts (Raw)',
  RAWCASH: 'Cashews (Raw)',
  BOBKGF: 'Buckwheat (Whole)',
  CACPOW: 'Cacao Powder',
  COCOSUG: 'Coconut Sugar',
  ABCTCO: 'Almond Butter',
};

// --- Current SOH ---

export const MOCK_PURCHASING_SOH: Record<string, number> = {
  ABARNPO: 501,
  RAWWALNUT: 2200,
  ABBNR: 2921,
  RAWCASH: 2601,
  BOBKGF: 410,
  CACPOW: 199,   // Low — will trigger stockout risk
  COCOSUG: 258,  // Low — will trigger stockout risk
  ABCTCO: 856,
};

// --- Consumption schedule (derived from kitchen batch BOMs) ---
// Each entry is a "batch" that consumes a component on a specific date.

function makeBatch(
  id: string,
  code: string,
  name: string,
  qty: number,
  date: string
): KitchenBatch {
  return {
    id,
    productCode: code,
    productName: name,
    quantity: qty,
    scheduledDate: new Date(date),
    status: 'planned',
    dependencies: [],
  };
}

export const MOCK_CONSUMPTION_SCHEDULE: Record<string, KitchenBatch[]> = {
  // Almonds Raw — consumed by IAA (activated almonds) and IAM (mixed nuts)
  ABARNPO: [
    makeBatch('c-abarnpo-1', 'ABARNPO', 'Almonds (Raw)', 525, '2026-04-07'),
    makeBatch('c-abarnpo-2', 'ABARNPO', 'Almonds (Raw)', 525, '2026-04-09'),
    makeBatch('c-abarnpo-3', 'ABARNPO', 'Almonds (Raw)', 125, '2026-04-14'),
  ],
  // Walnuts Raw — consumed by IAW and IAM
  RAWWALNUT: [
    makeBatch('c-rawwal-1', 'RAWWALNUT', 'Walnuts (Raw)', 473, '2026-04-08'),
    makeBatch('c-rawwal-2', 'RAWWALNUT', 'Walnuts (Raw)', 473, '2026-04-10'),
    makeBatch('c-rawwal-3', 'RAWWALNUT', 'Walnuts (Raw)', 125, '2026-04-14'),
  ],
  // Brazil Nuts Raw — consumed by IABR and IAM
  ABBNR: [
    makeBatch('c-abbnr-1', 'ABBNR', 'Brazil Nuts (Raw)', 420, '2026-04-08'),
    makeBatch('c-abbnr-2', 'ABBNR', 'Brazil Nuts (Raw)', 420, '2026-04-10'),
    makeBatch('c-abbnr-3', 'ABBNR', 'Brazil Nuts (Raw)', 125, '2026-04-14'),
  ],
  // Cashews Raw — consumed by IMM and IAM
  RAWCASH: [
    makeBatch('c-rawcash-1', 'RAWCASH', 'Cashews (Raw)', 75, '2026-04-09'),
    makeBatch('c-rawcash-2', 'RAWCASH', 'Cashews (Raw)', 75, '2026-04-11'),
    makeBatch('c-rawcash-3', 'RAWCASH', 'Cashews (Raw)', 125, '2026-04-14'),
  ],
  // Buckwheat — consumed by IAB
  BOBKGF: [
    makeBatch('c-bobkgf-1', 'BOBKGF', 'Buckwheat (Whole)', 55, '2026-04-07'),
    makeBatch('c-bobkgf-2', 'BOBKGF', 'Buckwheat (Whole)', 55, '2026-04-09'),
    makeBatch('c-bobkgf-3', 'BOBKGF', 'Buckwheat (Whole)', 55, '2026-04-11'),
    makeBatch('c-bobkgf-4', 'BOBKGF', 'Buckwheat (Whole)', 55, '2026-04-14'),
    makeBatch('c-bobkgf-5', 'BOBKGF', 'Buckwheat (Whole)', 100, '2026-04-16'),
  ],
  // Cacao Powder — consumed by IGC and ICC (LOW SOH — stockout risk)
  CACPOW: [
    makeBatch('c-cacpow-1', 'CACPOW', 'Cacao Powder', 86, '2026-04-10'),
    makeBatch('c-cacpow-2', 'CACPOW', 'Cacao Powder', 86, '2026-04-14'),
    makeBatch('c-cacpow-3', 'CACPOW', 'Cacao Powder', 45, '2026-04-17'),
  ],
  // Coconut Sugar — consumed by IGC and ICC (LOW SOH — stockout risk)
  COCOSUG: [
    makeBatch('c-cocosug-1', 'COCOSUG', 'Coconut Sugar', 130, '2026-04-10'),
    makeBatch('c-cocosug-2', 'COCOSUG', 'Coconut Sugar', 130, '2026-04-14'),
    makeBatch('c-cocosug-3', 'COCOSUG', 'Coconut Sugar', 60, '2026-04-17'),
  ],
  // Almond Butter — consumed by IGC and IGE
  ABCTCO: [
    makeBatch('c-abctco-1', 'ABCTCO', 'Almond Butter', 27, '2026-04-10'),
    makeBatch('c-abctco-2', 'ABCTCO', 'Almond Butter', 27, '2026-04-14'),
    makeBatch('c-abctco-3', 'ABCTCO', 'Almond Butter', 18, '2026-04-17'),
  ],
};

// --- Existing POs ---

export const MOCK_EXISTING_POS: PurchaseOrder[] = [
  {
    purchaseOrderId: 'po-mock-1',
    purchaseOrderNumber: 'PO-2026-042',
    supplierId: 'sup-nuts',
    supplierName: 'Byron Nut Supply',
    supplierCode: 'BNS',
    orderedDate: '2026-04-01',
    requiredDate: '2026-04-14',
    expectedDeliveryDate: '2026-04-14',
    status: 'Open',
    orderTotal: 3200,
    purchaseOrderLines: [
      {
        lineNumber: 1,
        productCode: 'ABARNPO',
        productDescription: 'Almonds (Raw)',
        quantityOrdered: 500,
        quantityReceived: 0,
        unitAmount: 4.5,
        lineTotal: 2250,
        expectedDeliveryDate: '2026-04-14',
      },
      {
        lineNumber: 2,
        productCode: 'RAWCASH',
        productDescription: 'Cashews (Raw)',
        quantityOrdered: 200,
        quantityReceived: 0,
        unitAmount: 4.75,
        lineTotal: 950,
        expectedDeliveryDate: '2026-04-14',
      },
    ],
  },
  {
    purchaseOrderId: 'po-mock-2',
    purchaseOrderNumber: 'PO-2026-043',
    supplierId: 'sup-sweet',
    supplierName: 'Sweeteners Direct',
    supplierCode: 'SD',
    orderedDate: '2026-04-03',
    requiredDate: '2026-04-18',
    expectedDeliveryDate: '2026-04-18',
    status: 'Open',
    orderTotal: 800,
    purchaseOrderLines: [
      {
        lineNumber: 1,
        productCode: 'COCOSUG',
        productDescription: 'Coconut Sugar',
        quantityOrdered: 500,
        quantityReceived: 0,
        unitAmount: 1.6,
        lineTotal: 800,
        expectedDeliveryDate: '2026-04-18',
      },
    ],
  },
];
