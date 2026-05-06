import { describe, test, expect } from 'vitest';
import {
  dayIntToDate,
  dateToDayInt,
  toLocalISODate,
  fromLocalISODate,
  dayIntToISO,
  dayIntToReadable,
} from '../src/working-day';

describe('working-day', () => {
  // Anchor to a known Monday so tests are deterministic regardless of "today".
  const monday = new Date(2026, 3, 13); // Mon 13 Apr 2026 (local midnight)

  test('dayInt 1 resolves to the reference week Monday', () => {
    const d = dayIntToDate(1, monday);
    expect(d.getDay()).toBe(1); // Monday
    expect(toLocalISODate(d)).toBe('2026-04-13');
  });

  test('dayInt 5 resolves to the same week Friday', () => {
    expect(toLocalISODate(dayIntToDate(5, monday))).toBe('2026-04-17');
  });

  test('dayInt 6 resolves to the following Monday', () => {
    expect(toLocalISODate(dayIntToDate(6, monday))).toBe('2026-04-20');
  });

  test('round-trip: date → dayInt → date produces same working-day date', () => {
    const target = new Date(2026, 3, 22); // Wed 22 Apr 2026 (dayInt 8)
    const int = dateToDayInt(target, monday);
    expect(int).toBe(8);
    expect(toLocalISODate(dayIntToDate(int, monday))).toBe('2026-04-22');
  });

  test('dateToDayInt clamps weekend to Friday of same week (default weekend=down)', () => {
    const saturday = new Date(2026, 3, 18); // Sat 18 Apr
    const sunday = new Date(2026, 3, 19); // Sun 19 Apr
    expect(dateToDayInt(saturday, monday)).toBe(5);
    expect(dateToDayInt(sunday, monday)).toBe(5);
  });

  test('dateToDayInt with weekend:"up" rolls Sat/Sun to next Monday', () => {
    const saturday = new Date(2026, 3, 18); // Sat 18 Apr
    const sunday = new Date(2026, 3, 19); // Sun 19 Apr
    const nextSunday = new Date(2026, 3, 26); // Sun 26 Apr
    expect(dateToDayInt(saturday, monday, { weekend: 'up' })).toBe(6);
    expect(dateToDayInt(sunday, monday, { weekend: 'up' })).toBe(6);
    // Sun 26 Apr is 13 days after Mon 13 Apr → Mon 27 Apr (day 11)
    expect(dateToDayInt(nextSunday, monday, { weekend: 'up' })).toBe(11);
  });

  test('dateToDayInt clamps past dates to 1', () => {
    const past = new Date(2026, 3, 6); // Mon 6 Apr (last week)
    expect(dateToDayInt(past, monday)).toBe(1);
  });

  test('weekend reference dates resolve to the upcoming Monday', () => {
    // If the user runs the app on a weekend, "day 1" should be the upcoming
    // Monday (the next working day), not the previous Monday six days ago.
    const saturday = new Date(2026, 3, 18); // Sat 18 Apr
    const sunday = new Date(2026, 3, 19); // Sun 19 Apr

    // Reference = Sat/Sun → Monday of week is Mon 20 Apr.
    expect(toLocalISODate(dayIntToDate(1, saturday))).toBe('2026-04-20');
    expect(toLocalISODate(dayIntToDate(1, sunday))).toBe('2026-04-20');

    // An "Assemble By" of Sun 26 Apr, interpreted from a Sunday reference,
    // should round up to Mon 27 Apr = day 6.
    const assembleBy = new Date(2026, 3, 26); // Sun 26 Apr
    expect(dateToDayInt(assembleBy, sunday, { weekend: 'up' })).toBe(6);
  });

  test('toLocalISODate does not UTC-shift Australian dates', () => {
    // A date that in UTC would roll back to the previous day.
    const d = new Date(2026, 3, 13, 1, 0, 0); // 13 Apr 01:00 local
    // toISOString() on this in Sydney would emit "2026-04-12T15:00:00Z" —
    // but toLocalISODate must preserve the local calendar day.
    expect(toLocalISODate(d)).toBe('2026-04-13');
  });

  test('fromLocalISODate parses to local midnight', () => {
    const d = fromLocalISODate('2026-04-13');
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(3);
    expect(d.getDate()).toBe(13);
    expect(d.getHours()).toBe(0);
  });

  test('dayIntToISO combines helpers correctly', () => {
    expect(dayIntToISO(1, monday)).toBe('2026-04-13');
    expect(dayIntToISO(10, monday)).toBe('2026-04-24'); // Fri next week
  });

  test('dayIntToReadable produces relative-week labels', () => {
    expect(dayIntToReadable(1)).toBe('Mon, This wk');
    expect(dayIntToReadable(5)).toBe('Fri, This wk');
    expect(dayIntToReadable(6)).toBe('Mon, Next wk');
    expect(dayIntToReadable(10)).toBe('Fri, Next wk');
    expect(dayIntToReadable(11)).toBe('Mon, Wk 3');
    expect(dayIntToReadable(0)).toBe('—');
  });
});
