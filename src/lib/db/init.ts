import { sql } from './client';

let initialized = false;

export async function ensureSchema(): Promise<void> {
  if (initialized) return;

  await sql`
    CREATE TABLE IF NOT EXISTS plan_items (
      id          TEXT PRIMARY KEY,
      kind        TEXT NOT NULL,
      data        JSONB NOT NULL,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by  TEXT
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS plan_items_kind_idx ON plan_items (kind)`;

  await sql`
    CREATE TABLE IF NOT EXISTS dismissed_kitchen_keys (
      key         TEXT PRIMARY KEY,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_by  TEXT
    )
  `;

  initialized = true;
}
