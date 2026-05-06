/**
 * Transfer Planning Types
 *
 * Inter-warehouse transfers move stock from where it is to where it's needed.
 * Kitchen batches need ingredients at Lundberg Storeroom.
 * Packaging runs need intermediates at MF Packaging.
 * Stock is often in the wrong warehouse — these types model the gap detection
 * and draft transfer planning workflow.
 */

export interface DraftTransfer {
  id: string;
  productCode: string;
  productName: string;
  quantity: number;
  fromWarehouse: string;
  toWarehouse: string;
  transferDate: Date;       // when the transfer should happen
  needByDate: Date;         // when the stock is needed at destination
  status: 'draft' | 'confirmed' | 'pushed';
  reason: string;
  linkedBatchId?: string;
}

export interface TransferGap {
  productCode: string;
  productName: string;
  destinationWarehouse: string;
  needByDate: Date;
  quantityNeeded: number;
  sourceOptions: { warehouse: string; available: number }[];
  demandSource: { type: 'kitchen_batch' | 'packaging_run'; id: string; name: string; date: Date };
}
