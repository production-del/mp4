/**
 * Generic Postgres-backed key/value store for Unleashed-derived caches —
 * Phase 4p.
 *
 * The three Unleashed caches (SOH, sales orders, kitchen assemblies)
 * previously lived in `data/*-cache.json` and were written via
 * `fs.writeFileSync` from the API refresh routes. That works locally but
 * breaks on Vercel, whose serverless filesystem is read-only at runtime.
 * The Refresh buttons returned HTTP 500 because the writeFile call threw
 * after a successful Unleashed fetch.
 *
 * This module gives each cache a dedicated row in the `unleashed_cache`
 * table, keyed by `kind`. Each cache module wraps the generic helpers
 * here with type-safe validators of its own document shape.
 *
 * Why one shared table rather than three: the schema is identical (a
 * single JSONB document + a fetchedAt timestamp), the volume is tiny (~3
 * rows, hundreds of KB each), and "list all caches" / "wipe all caches"
 * become trivial. If a cache outgrows JSONB it can graduate to its own
 * table later.
 *
 * Behaviour:
 *   • DATABASE_URL set → reads/writes go to Postgres.
 *   • DATABASE_URL absent → readers return null, writers throw. The
 *     calling cache modules catch this and fall back to file storage.
 *
 * Pure server-only: imports `@neondatabase/serverless`.
 */

import { sql } from './client';
import { ensureSchema } from './init';

// ─── Public API ──────────────────────────────────────────────

export type CacheKind = 'soh' | 'sales-orders' | 'assemblies';

export interface CacheRow<T> {
  kind: CacheKind;
  /** Cache document body — opaque to this layer; validated by callers. */
  payload: T;
  /** ISO timestamp of the last successful refresh. */
  fetchedAt: string;
}

/** True when the env vars are set so DB calls are even attempted. */
export function isDatabaseConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL ?? process.env.POSTGRES_URL);
}

/**
 * Read a cache row. Returns null when the row doesn't exist (first run)
 * or when the database connection fails (caller falls back to file).
 */
export async function dbReadCache<T>(
  kind: CacheKind,
): Promise<CacheRow<T> | null> {
  if (!isDatabaseConfigured()) return null;
  try {
    await ensureSchema();
    const rows = (await sql`
      SELECT payload, fetched_at FROM unleashed_cache WHERE kind = ${kind}
    `) as Array<{ payload: unknown; fetched_at: string | Date }>;
    if (rows.length === 0) return null;
    const row = rows[0];
    const fetchedAt =
      row.fetched_at instanceof Date ? row.fetched_at.toISOString() : row.fetched_at;
    return {
      kind,
      payload: row.payload as T,
      fetchedAt,
    };
  } catch (err) {
    console.warn(
      `[unleashed-cache-store] DB read failed for kind=${kind}; caller will fall back:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * Upsert a cache row. Throws on write failure so the caller can fall
 * back / report the error properly. We intentionally don't swallow here
 * the way reads do — a failed write means the operator's refresh didn't
 * land and they need to know.
 */
export async function dbWriteCache<T>(
  kind: CacheKind,
  payload: T,
  fetchedAt: string,
): Promise<void> {
  if (!isDatabaseConfigured()) {
    throw new Error('DATABASE_URL not set; cannot write cache to Postgres');
  }
  await ensureSchema();
  await sql`
    INSERT INTO unleashed_cache (kind, payload, fetched_at)
    VALUES (${kind}, ${JSON.stringify(payload)}::jsonb, ${fetchedAt})
    ON CONFLICT (kind)
    DO UPDATE SET
      payload = EXCLUDED.payload,
      fetched_at = EXCLUDED.fetched_at
  `;
}
