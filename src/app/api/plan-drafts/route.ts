import { NextResponse } from 'next/server';
import { sql } from '@/lib/db/client';
import { ensureSchema } from '@/lib/db/init';
import type { PlanItem } from '@/lib/planning/plan-item';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface PlanDraftsResponse {
  items: PlanItem[];
  dismissedKitchenKeys: string[];
  serverTime: string;
}

export async function GET(): Promise<NextResponse<PlanDraftsResponse>> {
  await ensureSchema();

  const itemRows = await sql`
    SELECT data FROM plan_items ORDER BY updated_at ASC
  ` as Array<{ data: PlanItem }>;

  const dismissedRows = await sql`
    SELECT key FROM dismissed_kitchen_keys ORDER BY created_at ASC
  ` as Array<{ key: string }>;

  return NextResponse.json({
    items: itemRows.map(r => r.data),
    dismissedKitchenKeys: dismissedRows.map(r => r.key),
    serverTime: new Date().toISOString(),
  });
}
