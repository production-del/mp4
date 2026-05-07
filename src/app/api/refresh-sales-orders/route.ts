/**
 * Refresh sales-orders cache — Phase 4h.3.
 *
 * POST /api/refresh-sales-orders
 *   body: ignored.
 *
 * Pulls active customer sales orders (Placed + Backordered) from
 * Unleashed via the existing `serverFetchActiveSalesOrders` helper,
 * flattens to per-line records, builds the cache shape with only the
 * fields the calendar needs, writes to `data/sales-orders-cache.json`.
 *
 * Errors mirror /api/refresh-soh: 500 on auth, 502 on upstream failures.
 */

import { NextResponse } from 'next/server';
import { serverFetchActiveSalesOrders } from '@/lib/unleashed/server';
import {
  buildSalesOrdersCache,
  writeSalesOrdersCache,
  type RawSalesOrderLine,
} from '@/lib/planning/sales-orders-cache';

export async function POST() {
  let orders;
  try {
    orders = await serverFetchActiveSalesOrders();
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error fetching sales orders';
    const isAuth = /credentials|api[_ ]id|api[_ ]key/i.test(msg);
    return NextResponse.json(
      {
        error: 'Failed to fetch sales orders from Unleashed',
        detail: msg,
        hint: isAuth
          ? 'Check UNLEASHED_API_ID and UNLEASHED_API_KEY in .env.local.'
          : undefined,
      },
      { status: isAuth ? 500 : 502 },
    );
  }

  // Flatten orders → lines, attaching the parent order's metadata.
  const rawLines: RawSalesOrderLine[] = [];
  for (const order of orders) {
    for (const line of order.salesOrderLines) {
      rawLines.push({
        productCode: line.productCode,
        quantityOrdered: line.quantityOrdered,
        quantityAllocated: line.quantityAllocated,
        requiredDate: order.requiredDate ?? null,
        orderNumber: order.orderNumber,
        customerName: order.customerName,
        orderStatus: order.orderStatus,
      });
    }
  }

  const cache = buildSalesOrdersCache(rawLines);
  await writeSalesOrdersCache(cache);

  return NextResponse.json({
    cache,
    sourceOrderCount: orders.length,
    sourceLineCount: rawLines.length,
  });
}

export async function GET() {
  return NextResponse.json(
    { error: 'Method not allowed — use POST to refresh.' },
    { status: 405 },
  );
}
