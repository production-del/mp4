/**
 * Refresh assemblies cache — Phase 4j.
 *
 * POST /api/refresh-assemblies
 *   body: ignored.
 *
 * Pulls active Unleashed assemblies (kitchen + packaging production runs)
 * via the existing `serverFetchOpenAssemblies` helper, projects to the
 * cache shape with the calendar's needed fields, writes to
 * `data/assemblies-cache.json`. Errors mirror the SOH/SO refresh routes.
 */

import { NextResponse } from 'next/server';
import { serverFetchOpenAssemblies } from '@/lib/unleashed/server';
import {
  buildAssembliesCache,
  writeAssembliesCache,
  type RawAssembly,
} from '@/lib/planning/assemblies-cache';

export async function POST() {
  let assemblies;
  try {
    assemblies = await serverFetchOpenAssemblies();
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error fetching assemblies';
    const isAuth = /credentials|api[_ ]id|api[_ ]key/i.test(msg);
    return NextResponse.json(
      {
        error: 'Failed to fetch assemblies from Unleashed',
        detail: msg,
        hint: isAuth
          ? 'Check UNLEASHED_API_ID and UNLEASHED_API_KEY in .env.local.'
          : undefined,
      },
      { status: isAuth ? 500 : 502 },
    );
  }

  const raw: RawAssembly[] = assemblies.map((a) => ({
    assemblyNumber: a.assemblyNumber,
    productCode: a.productCode,
    productName: a.productName,
    quantity: a.quantity,
    warehouseName: a.warehouseName,
    status: a.status,
    lastModifiedOn: a.lastModifiedOn ?? null,
    createdOn: a.createdOn ?? null,
  }));

  const cache = buildAssembliesCache(raw);
  await writeAssembliesCache(cache);

  return NextResponse.json({
    cache,
    sourceAssemblyCount: assemblies.length,
  });
}

export async function GET() {
  return NextResponse.json(
    { error: 'Method not allowed — use POST to refresh.' },
    { status: 405 },
  );
}
