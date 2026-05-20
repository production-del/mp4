import { NextResponse } from 'next/server';
import { sql } from '@/lib/db/client';
import { ensureSchema } from '@/lib/db/init';
import { isDatabaseConfigured } from '@/lib/db/unleashed-cache-store';
import type { PlanItem } from '@/lib/planning/plan-item';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface PlanDraftsResponse {
  items: PlanItem[];
  dismissedKitchenKeys: string[];
  serverTime: string;
}

export async function GET(): Promise<NextResponse<PlanDraftsResponse>> {
  // Graceful local-dev fallback: when DATABASE_URL / POSTGRES_URL isn't
  // set (typical for a fresh `npm run dev` without Postgres), return an
  // empty payload instead of 500-spamming the console. Plan drafts then
  // operate from client-side localStorage only — same behaviour as
  // pre-Phase-4p.
  if (!isDatabaseConfigured()) {
    return NextResponse.json({
      items: [],
      dismissedKitchenKeys: [],
      serverTime: new Date().toISOString(),
    });
  }

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
