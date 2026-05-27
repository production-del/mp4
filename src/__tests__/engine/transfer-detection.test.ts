import {
  extractPackagingDemands,
  detectTransferGaps,
  type PackagingDemandItem,
} from '@/lib/engine/transfer-detection';
import { WarehouseSOH } from '@/lib/planning/warehouse-soh';
import { WAREHOUSES } from '@/lib/planning/warehouse-assignments';
import type { Assembly, AssemblyLine, StockOnHandItem } from '@/lib/unleashed/types';

// ─── builders ────────────────────────────────────────────────

function line(partial: Partial<AssemblyLine> & { productCode: string; componentQuantity: number }): AssemblyLine {
  return {
    lineNumber: 1,
    productDescription: partial.productCode,
    quantityPerParent: 1,
    warehouseCode: 'WH',
    ...partial,
  };
}

function assembly(partial: Partial<Assembly> & { productCode: string; warehouseName: string; assemblyLines: AssemblyLine[] }): Assembly {
  return {
    assemblyId: `asm-${partial.productCode}`,
    assemblyNumber: `AS-${partial.productCode}`,
    productId: 'p',
    productName: partial.productCode,
    productDescription: partial.productCode,
    quantity: 100,
    status: 'Parked',
    warehouseId: 'w',
    createdOn: '2026-05-01T00:00:00Z',
    ...partial,
  };
}

function soh(partial: Partial<StockOnHandItem> & { productCode: string; warehouseName: string; quantity: number }): StockOnHandItem {
  return {
    productId: 'p',
    productName: partial.productCode,
    warehouseId: 'w',
    allocatedQty: 0,
    availableQty: partial.quantity,
    reorderPoint: 0,
    reorderQuantity: 0,
    ...partial,
  };
}

// MFRMIXNB11 is a packaged FG; IRM/IAA are intermediates.
const isIntermediate = (code: string) => code === 'IRM' || code === 'IAA';

describe('extractPackagingDemands', () => {
  test('emits one demand per assembly line at the assembly warehouse', () => {
    const out = extractPackagingDemands(
      [
        assembly({
          productCode: 'MFRMIXNB11',
          warehouseName: WAREHOUSES.MF_PACKAGING,
          assembleBy: '2026-06-10T00:00:00Z',
          assemblyLines: [
            line({ productCode: 'IRM', componentQuantity: 14.5 }),
            line({ productCode: 'BOX1KG', componentQuantity: 1 }),
            line({ productCode: 'LMFRMIXNB11', componentQuantity: 1 }),
          ],
        }),
      ],
      isIntermediate,
      WAREHOUSES.MF_PACKAGING,
    );
    expect(out).toHaveLength(3);
    expect(out.map((d) => d.productCode).sort()).toEqual(['BOX1KG', 'IRM', 'LMFRMIXNB11']);
    for (const d of out) {
      expect(d.destinationWarehouse).toBe(WAREHOUSES.MF_PACKAGING);
      // assembleBy wins for the scheduled date
      expect(d.scheduledDate.toISOString().slice(0, 10)).toBe('2026-06-10');
    }
  });

  test('skips intermediate (kitchen) assemblies entirely', () => {
    const out = extractPackagingDemands(
      [
        assembly({
          productCode: 'IRM',
          warehouseName: WAREHOUSES.LUNDBERG,
          assemblyLines: [line({ productCode: 'ABARNPO', componentQuantity: 100 })],
        }),
      ],
      isIntermediate,
      WAREHOUSES.MF_PACKAGING,
    );
    expect(out).toEqual([]);
  });

  test('Bottlo run carries its MF Operations warehouse as the destination', () => {
    const out = extractPackagingDemands(
      [
        assembly({
          productCode: 'MFYUMMBME', // bottlo-station FG
          warehouseName: WAREHOUSES.MF_OPERATIONS,
          assemblyLines: [line({ productCode: 'IYB', componentQuantity: 26 })],
        }),
      ],
      isIntermediate,
      WAREHOUSES.MF_PACKAGING,
    );
    expect(out).toHaveLength(1);
    expect(out[0].destinationWarehouse).toBe(WAREHOUSES.MF_OPERATIONS);
  });

  test('drops empty/zero lines', () => {
    const out = extractPackagingDemands(
      [
        assembly({
          productCode: 'MFX',
          warehouseName: WAREHOUSES.MF_PACKAGING,
          assemblyLines: [
            line({ productCode: '', componentQuantity: 5 }),
            line({ productCode: 'JAR555', componentQuantity: 0 }),
            line({ productCode: 'LID82', componentQuantity: 2 }),
          ],
        }),
      ],
      isIntermediate,
      WAREHOUSES.MF_PACKAGING,
    );
    expect(out.map((d) => d.productCode)).toEqual(['LID82']);
  });
});

describe('detectTransferGaps — packaging at run-specific warehouse', () => {
  test('Bottlo run: input short at MF Operations but available at MF Packaging → gap to MF Operations', () => {
    // IYB needed at MF Operations (Bottlo), but it's sitting at MF Packaging.
    const sohView = new WarehouseSOH([
      soh({ productCode: 'IYB', warehouseName: WAREHOUSES.MF_PACKAGING, quantity: 50 }),
      // none at MF Operations
    ]);
    const packagingDemands: PackagingDemandItem[] = [
      {
        runId: 'r1',
        runName: 'MFYUMMBME run',
        productCode: 'IYB',
        productName: 'Yummy Beans Intermediate',
        quantityNeeded: 26,
        scheduledDate: new Date('2026-06-10'),
        destinationWarehouse: WAREHOUSES.MF_OPERATIONS,
      },
    ];
    const gaps = detectTransferGaps({ soh: sohView, kitchenDemands: [], packagingDemands });
    expect(gaps).toHaveLength(1);
    expect(gaps[0].productCode).toBe('IYB');
    expect(gaps[0].destinationWarehouse).toBe(WAREHOUSES.MF_OPERATIONS);
    expect(gaps[0].quantityNeeded).toBe(26);
    expect(gaps[0].sourceOptions[0].warehouse).toBe(WAREHOUSES.MF_PACKAGING);
  });

  test('no gap when the input is already at the run warehouse', () => {
    const sohView = new WarehouseSOH([
      soh({ productCode: 'IRM', warehouseName: WAREHOUSES.MF_PACKAGING, quantity: 100 }),
    ]);
    const packagingDemands: PackagingDemandItem[] = [
      {
        runId: 'r2',
        runName: 'MFRMIXNB11 run',
        productCode: 'IRM',
        productName: 'RAW Mixed Nuts Intermediate',
        quantityNeeded: 14.5,
        scheduledDate: new Date('2026-06-10'),
        destinationWarehouse: WAREHOUSES.MF_PACKAGING,
      },
    ];
    const gaps = detectTransferGaps({ soh: sohView, kitchenDemands: [], packagingDemands });
    expect(gaps).toEqual([]);
  });

  test('no gap when the input is nowhere (nothing to transfer) — flagged elsewhere as shortage', () => {
    const sohView = new WarehouseSOH([]);
    const packagingDemands: PackagingDemandItem[] = [
      {
        runId: 'r3',
        runName: 'run',
        productCode: 'LMFRMIXNB11',
        productName: 'Label',
        quantityNeeded: 100,
        scheduledDate: new Date('2026-06-10'),
        destinationWarehouse: WAREHOUSES.MF_PACKAGING,
      },
    ];
    const gaps = detectTransferGaps({ soh: sohView, kitchenDemands: [], packagingDemands });
    expect(gaps).toEqual([]);
  });
});
