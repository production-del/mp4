/**
 * Refresh SOH cache — Phase 4g (per-warehouse in 4h.2).
 *
 * POST  /api/refresh-soh
 *   body: ignored. Cache always preserves the full per-warehouse
 *   breakdown; warehouse selection is a UI concern, not a fetch concern.
 *
 * Pulls fresh stock-on-hand from Unleashed via `fetchSOHWithFallback`,
 * aggregates into the per-warehouse SohCache shape, writes to
 * `data/soh-cache.json`, returns the new cache.
 *
 * `availableQty` (qty on hand minus committed-to-orders) is what the
 * planner cares about — those committed units already have a destination
 * and can't be re-planned. Falls back to `quantity` if availableQty is
 * undefined.
 *
 * Errors:
 *   - Unleashed creds missing → 500 with a hint to check .env.local
 *   - API call fails           → 502 with the upstream error
 */

import { NextResponse } from 'next/server';
import { fetchSOHWithFallback } from '@/lib/unleashed/fetch-soh';
import { buildSohCache, writeSohCache } from '@/lib/planning/soh-cache';

export async function POST() {
  let result;
  try {
    result = await fetchSOHWithFallback();
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error fetching SOH';
    const isAuth = /credentials|api[_ ]id|api[_ ]key/i.test(msg);
    return NextResponse.json(
      {
        error: 'Failed to fetch SOH from Unleashed',
        detail: msg,
        hint: isAuth
          ? 'Check UNLEASHED_API_ID and UNLEASHED_API_KEY in .env.local.'
          : undefined,
      },
      { status: isAuth ? 500 : 502 },
    );
  }

  const records = result.sohItems.map((item) => ({
    productCode: item.productCode,
    warehouseName: item.warehouseName,
    qtyOnHand:
      typeof item.availableQty === 'number' ? item.availableQty : item.quantity,
  }));

  const cache = buildSohCache(records);
  writeSohCache(cache);

  return NextResponse.json({
    cache,
    sourceRecordCount: result.sohItems.length,
  });
}

export async function GET() {
  return NextResponse.json(
    { error: 'Method not allowed — use POST to refresh.' },
    { status: 405 },
  );
}
