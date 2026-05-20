/**
 * Refresh purchase orders cache — Phase 4l.5.
 *
 * POST /api/refresh-purchase-orders
 *   body: ignored.
 *
 * Pulls Unleashed POs in Open + PartiallyReceived statuses via
 * `serverFetchPurchaseOrdersByStatus`, projects to the cache shape
 * (one entry per outstanding line item), writes to
 * `data/purchase-orders-cache.json` (or the DB cache when configured).
 */

import { NextResponse } from 'next/server';
import { serverFetchPurchaseOrdersByStatus } from '@/lib/unleashed/server';
import {
  buildPurchaseOrdersCache,
  writePurchaseOrdersCache,
  type RawPurchaseOrder,
} from '@/lib/planning/purchase-orders-cache';

export async function POST() {
  let open;
  let partial;
  try {
    [open, partial] = await Promise.all([
      serverFetchPurchaseOrdersByStatus('Open'),
      serverFetchPurchaseOrdersByStatus('PartiallyReceived'),
    ]);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error fetching purchase orders';
    const isAuth = /credentials|api[_ ]id|api[_ ]key/i.test(msg);
    return NextResponse.json(
      {
        error: 'Failed to fetch purchase orders from Unleashed',
        detail: msg,
        hint: isAuth
          ? 'Check UNLEASHED_API_ID and UNLEASHED_API_KEY in .env.local.'
          : undefined,
      },
      { status: isAuth ? 500 : 502 },
    );
  }

  const raw: RawPurchaseOrder[] = [
    ...open.map((po) => ({
      purchaseOrderNumber: po.purchaseOrderNumber,
      supplierName: po.supplierName,
      status: 'Open' as const,
      expectedDeliveryDate: po.expectedDeliveryDate ?? null,
      requiredDate: po.requiredDate ?? null,
      orderedDate: po.orderedDate ?? null,
      lines: po.purchaseOrderLines.map((ln) => ({
        lineNumber: ln.lineNumber,
        productCode: ln.productCode,
        productDescription: ln.productDescription,
        quantityOrdered: ln.quantityOrdered,
        quantityReceived: ln.quantityReceived,
        expectedDeliveryDate: ln.expectedDeliveryDate ?? null,
      })),
    })),
    ...partial.map((po) => ({
      purchaseOrderNumber: po.purchaseOrderNumber,
      supplierName: po.supplierName,
      status: 'PartiallyReceived' as const,
      expectedDeliveryDate: po.expectedDeliveryDate ?? null,
      requiredDate: po.requiredDate ?? null,
      orderedDate: po.orderedDate ?? null,
      lines: po.purchaseOrderLines.map((ln) => ({
        lineNumber: ln.lineNumber,
        productCode: ln.productCode,
        productDescription: ln.productDescription,
        quantityOrdered: ln.quantityOrdered,
        quantityReceived: ln.quantityReceived,
        expectedDeliveryDate: ln.expectedDeliveryDate ?? null,
      })),
    })),
  ];

  const cache = buildPurchaseOrdersCache(raw);
  await writePurchaseOrdersCache(cache);

  return NextResponse.json({
    cache,
    sourcePoCount: open.length + partial.length,
  });
}

export async function GET() {
  return NextResponse.json(
    { error: 'Method not allowed — use POST to refresh.' },
    { status: 405 },
  );
}
