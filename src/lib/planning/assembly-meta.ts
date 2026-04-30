/**
 * Machine-readable metadata piggybacked on an assembly's `comments` field.
 *
 * Unleashed doesn't model packaging-team assignment, priority-origin, or
 * sales-order attribution on Assembly records. Rather than bolt on a sidecar
 * store (another localStorage key that drifts out of sync, another JSON blob
 * to migrate), we encode these as tags inside the free-form `comments`
 * string the ERP already stores. Humans can still read and write prose
 * around our tags; we just parse them out when we load.
 *
 * Supported tags:
 *
 *     [TEAM:<slug>]        one per comments, last wins       e.g. [TEAM:elephant]
 *     [SOURCE:<slug>]      one per comments, last wins       e.g. [SOURCE:priority]
 *     [SO:<order-number>]  any number per comments           e.g. [SO:TBC-00027681]
 *
 * Rules:
 *
 * - Tags may appear anywhere in the comments string, in any order.
 * - Keys are case-insensitive; values preserve the casing seen in Unleashed.
 * - Stripping tags normalises whitespace, so a round-trip UI pass keeps
 *   human-written prose intact.
 * - When writing, tags are emitted in a stable order (TEAM, SOURCE, SO…) so
 *   diffs between writes are minimal and readable.
 */

import type { PackingTeam } from '@/app/packaging/hooks/usePackagingPlanner';

const TEAM_TAG_PATTERN = /\[TEAM:([a-zA-Z][\w-]*)\]/gi;
const SOURCE_TAG_PATTERN = /\[SOURCE:([a-zA-Z][\w-]*)\]/gi;
// Sales-order numbers in Unleashed use formats like `TBC-00027681`, `MF#19406`
// and ad-hoc alphanumerics. Allow letters, digits, and a conservative set of
// separators; the closing bracket is the boundary.
const SO_TAG_PATTERN = /\[SO:([^\]\s]+)\]/gi;

/** Planning sources that produce an assembly. More values may be added. */
export type AssemblySource = 'priority';

/** The machine-readable pieces extracted from a comments string. */
export interface AssemblyMeta {
  team?: PackingTeam;
  source?: AssemblySource;
  /** Order numbers verbatim (e.g. `TBC-00027681`, `MF#19406`). */
  salesOrders?: string[];
}

/** Parse `comments` string → structured meta. Unknown tags are ignored. */
export function parseAssemblyMeta(comments: string | undefined | null): AssemblyMeta {
  if (!comments) return {};

  const teamMatches = [...comments.matchAll(TEAM_TAG_PATTERN)];
  const team = teamMatches.at(-1)?.[1]?.toLowerCase() as PackingTeam | undefined;

  const sourceMatches = [...comments.matchAll(SOURCE_TAG_PATTERN)];
  const sourceRaw = sourceMatches.at(-1)?.[1]?.toLowerCase();
  const source = sourceRaw === 'priority' ? ('priority' as const) : undefined;

  const soMatches = [...comments.matchAll(SO_TAG_PATTERN)];
  const soSet = new Set(soMatches.map(m => m[1]));
  const salesOrders = soSet.size > 0 ? [...soSet] : undefined;

  const out: AssemblyMeta = {};
  if (team) out.team = team;
  if (source) out.source = source;
  if (salesOrders) out.salesOrders = salesOrders;
  return out;
}

/** Strip all known tags from a comments string so humans see only their notes. */
export function stripAssemblyMeta(comments: string | undefined | null): string {
  if (!comments) return '';
  return comments
    .replace(TEAM_TAG_PATTERN, '')
    .replace(SOURCE_TAG_PATTERN, '')
    .replace(SO_TAG_PATTERN, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Produce a new `comments` string with the given meta applied.
 *
 * - Preserves any human-written prose around the tags.
 * - Clears tags whose fields are `undefined`/empty (so a round-trip that
 *   removes a team clears the tag rather than leaving a stale copy).
 * - Emits tags in a stable order: TEAM, SOURCE, SO… (alphabetical within).
 */
export function writeAssemblyMeta(
  existingComments: string | undefined | null,
  meta: AssemblyMeta,
): string {
  const human = stripAssemblyMeta(existingComments);
  const parts: string[] = [];
  if (meta.team) parts.push(`[TEAM:${meta.team}]`);
  if (meta.source) parts.push(`[SOURCE:${meta.source}]`);
  if (meta.salesOrders && meta.salesOrders.length > 0) {
    const sorted = [...new Set(meta.salesOrders)].sort();
    for (const so of sorted) parts.push(`[SO:${so}]`);
  }
  const tagBlock = parts.join(' ');
  if (!tagBlock) return human;
  return human ? `${human} ${tagBlock}` : tagBlock;
}
