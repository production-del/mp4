import { neon, neonConfig, type NeonQueryFunction } from '@neondatabase/serverless';

neonConfig.fetchConnectionCache = true;

let cached: NeonQueryFunction<false, false> | null = null;

function getClient(): NeonQueryFunction<false, false> {
  if (cached) return cached;
  const connectionString = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL or POSTGRES_URL must be set for the Neon client');
  }
  cached = neon(connectionString);
  return cached;
}

type Tag = TemplateStringsArray;

/**
 * Tagged-template SQL — call as `sql\`SELECT 1\``. Lazily instantiates the
 * Neon client on first use so module-import-time evaluation (build, tests
 * without env) doesn't crash.
 */
export const sql = ((strings: Tag, ...values: unknown[]) => {
  return getClient()(strings, ...values);
}) as NeonQueryFunction<false, false>;
