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

  // Phase 4p: Unleashed-derived caches (SOH, sales orders, assemblies)
  // moved off the local filesystem and into Postgres so the Refresh
  // buttons work on Vercel (whose serverless filesystem is read-only).
  // Three rows, one per kind. Single-document-per-kind is plenty here —
  // operators refresh "all SOH" or "all sales orders" at once, not slices.
  await sql`
    CREATE TABLE IF NOT EXISTS unleashed_cache (
      kind        TEXT PRIMARY KEY,
      fetched_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      payload     JSONB NOT NULL
    )
  `;

  initialized = true;
}
