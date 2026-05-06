/**
 * Draft Transfer persistence — thin facade over `PlanDraftStore`.
 *
 * Historically transfers had their own localStorage key + (de)serializer. They
 * now live in the unified PlanItem store; this module adapts between
 * `DraftTransfer` (the shape consumers expect, with `Date` objects) and
 * `TransferItem` (the canonical persisted shape, with ISO strings).
 *
 * Keeping the `DraftTransfer` type lets UI code and the transfer-detection
 * engine stay unchanged across the refactor. Phase 6 will collapse the two
 * once the engine speaks `PlanItem` directly.
 */

import type { DraftTransfer } from './transfer-types';
import type { TransferItem } from './plan-item';
import { listByKind, replaceByKind } from './plan-draft-store';
import { fromLocalISODate, toLocalISODate } from './working-day';

function toDraftTransfer(item: TransferItem): DraftTransfer {
  return {
    id: item.id,
    productCode: item.productCode,
    productName: item.productName,
    quantity: item.quantity,
    fromWarehouse: item.fromWarehouse,
    toWarehouse: item.toWarehouse,
    transferDate: fromLocalISODate(item.transferDate),
    needByDate: fromLocalISODate(item.needByDate),
    status: item.status,
    reason: item.reason,
    linkedBatchId: item.linkedBatchId,
  };
}

function toTransferItem(t: DraftTransfer): TransferItem {
  return {
    kind: 'transfer',
    id: t.id,
    productCode: t.productCode,
    productName: t.productName,
    quantity: t.quantity,
    lifecycle: t.status === 'pushed' ? 'pushed' : 'draft',
    transferDate: toLocalISODate(t.transferDate),
    needByDate: toLocalISODate(t.needByDate),
    fromWarehouse: t.fromWarehouse,
    toWarehouse: t.toWarehouse,
    status: t.status,
    reason: t.reason,
    linkedBatchId: t.linkedBatchId,
  };
}

export function loadDraftTransfers(): DraftTransfer[] {
  return listByKind('transfer').map(toDraftTransfer);
}

export function saveDraftTransfers(transfers: DraftTransfer[]): void {
  replaceByKind('transfer', transfers.map(toTransferItem));
}
