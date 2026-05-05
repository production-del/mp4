/**
 * Working-day time module — the single source of truth for planning time.
 *
 * Ported verbatim from `byron-planner/src/lib/planning/working-day.ts`. Keep
 * the two files in lockstep until the planner consumes this package directly.
 *
 * Planning uses a compact working-day integer instead of explicit dates:
 *   1-5   = Mon-Fri of current week
 *   6-10  = Mon-Fri of next week
 *   11-15 = week after, etc.
 *
 * The integer-to-date mapping is always relative to the current week's Monday,
 * so the schedule auto-advances: on Monday morning, what was "day 6" (next Mon)
 * becomes "day 1" (this Mon) with no cron job required.
 *
 * Dates are handled in the LOCAL timezone (Australia by convention). Never
 * call `toISOString()` on business dates — it shifts to UTC and can return
 * the previous calendar day.
 */

// ─── Core conversions ────────────────────────────────────────

/**
 * Get Monday 00:00 of the working week that contains `date` (local time).
 * Weekday inputs → Monday of the same calendar week.
 * Weekend inputs (Sat/Sun) → the **upcoming** Monday.
 */
function getMondayOfWeek(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const dayOfWeek = d.getDay(); // 0=Sun, 1=Mon, ...
  const diff =
    dayOfWeek === 0 ? 1 : dayOfWeek === 6 ? 2 : 1 - dayOfWeek;
  d.setDate(d.getDate() + diff);
  return d;
}

/** Convert a working-day integer to a Date (local midnight). */
export function dayIntToDate(dayInt: number, referenceDate?: Date): Date {
  const monday = getMondayOfWeek(referenceDate ?? new Date());
  const zeroIndexed = dayInt - 1;
  const weeksOffset = Math.floor(zeroIndexed / 5);
  const dayInWeek = zeroIndexed % 5; // 0=Mon ... 4=Fri
  const result = new Date(monday);
  result.setDate(result.getDate() + weeksOffset * 7 + dayInWeek);
  return result;
}

/**
 * Options for `dateToDayInt`.
 *
 * - `weekend: 'down'` (default) — Sat/Sun clamp to the **preceding Friday**
 *   of the same week. Use when the date is a historical or "work actually
 *   happened" marker.
 *
 * - `weekend: 'up'` — Sat/Sun clamp to the **following Monday**. Use when
 *   the date is a deadline or "Assemble By" target — a weekend date there
 *   means "work hits the floor next Monday".
 */
export interface DateToDayIntOptions {
  weekend?: 'up' | 'down';
}

/**
 * Convert a Date to a working-day integer (relative to current week's Monday).
 * Past dates clamp to 1. Weekend handling is configurable — see the options.
 */
export function dateToDayInt(
  date: Date,
  referenceDate?: Date,
  options: DateToDayIntOptions = {},
): number {
  const { weekend = 'down' } = options;
  const monday = getMondayOfWeek(referenceDate ?? new Date());
  const target = new Date(date);
  target.setHours(0, 0, 0, 0);

  const diffMs = target.getTime() - monday.getTime();
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays < 0) return 1;

  const weeksOffset = Math.floor(diffDays / 7);
  const dayInWeek = diffDays % 7;

  // Sat=5, Sun=6 → resolve per `weekend` option.
  if (dayInWeek >= 5) {
    if (weekend === 'up') {
      return (weeksOffset + 1) * 5 + 1;
    }
    return weeksOffset * 5 + 4 + 1;
  }

  return weeksOffset * 5 + dayInWeek + 1;
}

// ─── ISO (YYYY-MM-DD) helpers ────────────────────────────────

/**
 * Format a Date as YYYY-MM-DD using LOCAL timezone.
 * Never call `toISOString()` on Australian wall-clock dates — it shifts to UTC
 * and can return the previous day.
 */
export function toLocalISODate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Parse a YYYY-MM-DD string as a local-midnight Date. */
export function fromLocalISODate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

/** Get the local ISO date string (YYYY-MM-DD) for a day integer. */
export function dayIntToISO(dayInt: number, referenceDate?: Date): string {
  return toLocalISODate(dayIntToDate(dayInt, referenceDate));
}

// ─── Display formatters ──────────────────────────────────────

/** Format a day integer as a short date label, e.g. "Tue 15 Apr". */
export function formatDayInt(dayInt: number, referenceDate?: Date): string {
  return dayIntToDate(dayInt, referenceDate).toLocaleDateString('en-AU', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

/**
 * Format a day integer as a relative-week label, e.g. "Tue, This wk" or
 * "Mon, Next wk" or "Wed, Wk 3".
 */
export function dayIntToReadable(dayInt: number): string {
  if (dayInt <= 0) return '—';
  const weekNum = Math.ceil(dayInt / 5);
  const dayOfWeek = (dayInt - 1) % 5;
  const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
  const label = weekNum === 1 ? 'This wk' : weekNum === 2 ? 'Next wk' : `Wk ${weekNum}`;
  return `${dayNames[dayOfWeek]}, ${label}`;
}

/** Format an ISO date string as "Thu, 15 Apr". */
export function formatISOFull(iso: string): string {
  const d = fromLocalISODate(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-AU', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

/** Format an ISO date string as "15 Apr" (short form). */
export function formatISOShort(iso: string): string {
  const d = fromLocalISODate(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
}
