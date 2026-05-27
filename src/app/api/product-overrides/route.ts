/**
 * Per-product override API — Phase 4f.
 *
 * Endpoints:
 *   GET    /api/product-overrides
 *     → { overrides: { [productCode]: ProductOverride } }
 *
 *   POST   /api/product-overrides
 *     body: { productCode: string, override: { shelfLifeDays?, maxBatchSize? } }
 *     Sets / merges the override for `productCode`. Empty fields fall
 *     back to defaults at planning time.
 *
 *   DELETE /api/product-overrides?productCode=X
 *     Clears the override for `productCode`.
 *
 * Single-user assumption: writes read-modify-write the JSON file at
 * `data/product-overrides.json`. Concurrent writes from different
 * operators could race; not a concern for the planner's audience.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  readProductOverrides,
  writeProductOverrides,
  setOverride,
  clearOverride,
  type ProductOverride,
} from '@/lib/planning/product-overrides';

export async function GET() {
  const overrides = readProductOverrides();
  return NextResponse.json({ overrides });
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'Body must be valid JSON' },
      { status: 400 },
    );
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json(
      { error: 'Body must be an object' },
      { status: 400 },
    );
  }
  const { productCode, override } = body as {
    productCode?: unknown;
    override?: unknown;
  };
  if (typeof productCode !== 'string' || productCode.length === 0) {
    return NextResponse.json(
      { error: 'productCode (non-empty string) required' },
      { status: 400 },
    );
  }
  if (!override || typeof override !== 'object' || Array.isArray(override)) {
    return NextResponse.json(
      { error: 'override (object) required' },
      { status: 400 },
    );
  }
  const o = override as Record<string, unknown>;
  const partial: ProductOverride = {
    shelfLifeDays:
      typeof o.shelfLifeDays === 'number' ? o.shelfLifeDays : undefined,
    maxBatchSize:
      typeof o.maxBatchSize === 'number' ? o.maxBatchSize : undefined,
    sohFloorDays:
      typeof o.sohFloorDays === 'number' ? o.sohFloorDays : undefined,
    skipKitchenRun: o.skipKitchenRun === true ? true : undefined,
    defaultStation:
      o.defaultStation === 'hand-packing' ||
      o.defaultStation === 'elephant' ||
      o.defaultStation === 'dust' ||
      o.defaultStation === 'bottlo'
        ? (o.defaultStation as ProductOverride['defaultStation'])
        : undefined,
  };
  const current = readProductOverrides();
  const next = setOverride(current, productCode, partial);
  writeProductOverrides(next);
  return NextResponse.json({ overrides: next });
}

export async function DELETE(request: NextRequest) {
  const productCode = request.nextUrl.searchParams.get('productCode');
  if (!productCode) {
    return NextResponse.json(
      { error: 'productCode query param required' },
      { status: 400 },
    );
  }
  const current = readProductOverrides();
  const next = clearOverride(current, productCode);
  writeProductOverrides(next);
  return NextResponse.json({ overrides: next });
}
