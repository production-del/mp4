/**
 * Refresh SOH cache — Phase 4g.
 *
 * POST  /api/refresh-soh
 *   body (optional): { warehouseFilter?: string }
 *
 * Pulls fresh stock-on-hand from Unleashed via the existing
 * `fetchSOHWithFallback` helper, aggregates into the SohCache shape,
 * writes to `data/soh-cache.json`, and returns the new cache.
 *
 * `availableQty` (qty on hand minus committed-to-orders) is what the
 * planner cares about — those committed units already have a destination
 * and can't be re-planned. Falls back to `quantity` if availableQty is
 * undefined (older Unleashed responses).
 *
 * Errors:
 *   - Unleashed creds missing → 500 with a useful message; the operator
 *     should check `.env.local`.
 *   - API call fails → 502 with the upstream error.
 */

import { NextRequest, NextResponse } from 'next/server';
import { fetchSOHWithFallback } from '@/lib/unleashed/fetch-soh';
import { buildSohCache, writeSohCache } from '@/lib/planning/soh-cache';

export async function POST(request: NextRequest) {
  let warehouseFilter = '';
  try {
    const body = await request.json().catch(() => null);
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      const wf = (body as { warehouseFilter?: unknown }).warehouseFilter;
      if (typeof wf === 'string') warehouseFilter = wf;
    }
  } catch {
    /* body is optional — ignore parse errors */
  }

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

  // Map Unleashed records to the buildSohCache shape. Use availableQty
  // (post-allocation) so the planner sees what it can actually re-deploy.
  const records = result.sohItems.map((item) => ({
    productCode: item.productCode,
    warehouseName: item.warehouseName,
    qtyOnHand: typeof item.availableQty === 'number'
      ? item.availableQty
      : item.quantity,
  }));

  const cache = buildSohCache(records, warehouseFilter);
  writeSohCache(cache);

  return NextResponse.json({
    cache,
    sourceRecordCount: result.sohItems.length,
  });
}

export async function GET() {
  // Convenience: lets the operator hit /api/refresh-soh in a browser.
  return NextResponse.json({
    error: 'Method not allowed — use POST to refresh.',
  }, { status: 405 });
}
