import { NextResponse } from 'next/server';
import { sql } from '@/lib/db/client';
import { ensureSchema } from '@/lib/db/init';
import { auth } from '@/auth';
import type { PlanItem, PlanItemKind } from '@/lib/planning/plan-item';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export type MutateOp =
  | { op: 'upsert'; items: PlanItem[] }
  | { op: 'remove'; ids: string[] }
  | { op: 'replaceByKind'; kind: PlanItemKind; items: PlanItem[] }
  | { op: 'markPushed'; ids: string[] }
  | { op: 'addDismissed'; key: string }
  | { op: 'removeDismissed'; key: string }
  | { op: 'clearDismissed' };

interface MutateRequest {
  ops: MutateOp[];
}

export async function POST(request: Request): Promise<NextResponse> {
  await ensureSchema();

  const session = await auth();
  const actor = session?.user?.email ?? null;

  let body: MutateRequest;
  try {
    body = await request.json() as MutateRequest;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  if (!body || !Array.isArray(body.ops)) {
    return NextResponse.json({ error: 'ops_required' }, { status: 400 });
  }

  for (const op of body.ops) {
    switch (op.op) {
      case 'upsert': {
        for (const item of op.items) {
          await sql`
            INSERT INTO plan_items (id, kind, data, updated_at, updated_by)
            VALUES (${item.id}, ${item.kind}, ${JSON.stringify(item)}::jsonb, NOW(), ${actor})
            ON CONFLICT (id) DO UPDATE
              SET kind = EXCLUDED.kind,
                  data = EXCLUDED.data,
                  updated_at = NOW(),
                  updated_by = EXCLUDED.updated_by
          `;
        }
        break;
      }
      case 'remove': {
        if (op.ids.length > 0) {
          await sql`DELETE FROM plan_items WHERE id = ANY(${op.ids})`;
        }
        break;
      }
      case 'replaceByKind': {
        await sql`DELETE FROM plan_items WHERE kind = ${op.kind}`;
        for (const item of op.items) {
          await sql`
            INSERT INTO plan_items (id, kind, data, updated_at, updated_by)
            VALUES (${item.id}, ${item.kind}, ${JSON.stringify(item)}::jsonb, NOW(), ${actor})
            ON CONFLICT (id) DO UPDATE
              SET kind = EXCLUDED.kind,
                  data = EXCLUDED.data,
                  updated_at = NOW(),
                  updated_by = EXCLUDED.updated_by
          `;
        }
        break;
      }
      case 'markPushed': {
        if (op.ids.length > 0) {
          await sql`
            UPDATE plan_items
            SET data = jsonb_set(data, '{lifecycle}', '"pushed"'::jsonb),
                updated_at = NOW(),
                updated_by = ${actor}
            WHERE id = ANY(${op.ids})
          `;
        }
        break;
      }
      case 'addDismissed': {
        await sql`
          INSERT INTO dismissed_kitchen_keys (key, created_by)
          VALUES (${op.key}, ${actor})
          ON CONFLICT (key) DO NOTHING
        `;
        break;
      }
      case 'removeDismissed': {
        await sql`DELETE FROM dismissed_kitchen_keys WHERE key = ${op.key}`;
        break;
      }
      case 'clearDismissed': {
        await sql`DELETE FROM dismissed_kitchen_keys`;
        break;
      }
    }
  }

  return NextResponse.json({ ok: true, serverTime: new Date().toISOString() });
}
