/**
 * Business calendar for production planning
 * Australia/Sydney timezone
 * Weekends and configurable public holidays are non-working days
 */

export interface Holiday {
  date: Date;
  name: string;
  recurring?: boolean; // Whether to repeat annually
}

const DEFAULT_HOLIDAYS: Holiday[] = [
  // ── 2024 ──────────────────────────────────────────────
  { date: new Date("2024-01-01"), name: "New Year's Day" },
  { date: new Date("2024-01-26"), name: "Australia Day" },
  { date: new Date("2024-03-29"), name: "Good Friday" },
  { date: new Date("2024-03-30"), name: "Easter Saturday" },
  { date: new Date("2024-04-01"), name: "Easter Monday" },
  { date: new Date("2024-04-25"), name: "ANZAC Day" },
  { date: new Date("2024-06-10"), name: "Queen's Birthday (NSW)" },
  { date: new Date("2024-12-25"), name: "Christmas Day" },
  { date: new Date("2024-12-26"), name: "Boxing Day" },
  // ── 2025 ──────────────────────────────────────────────
  { date: new Date("2025-01-01"), name: "New Year's Day" },
  { date: new Date("2025-01-27"), name: "Australia Day (Observed)" },
  { date: new Date("2025-04-18"), name: "Good Friday" },
  { date: new Date("2025-04-19"), name: "Easter Saturday" },
  { date: new Date("2025-04-21"), name: "Easter Monday" },
  { date: new Date("2025-04-25"), name: "ANZAC Day" },
  { date: new Date("2025-06-09"), name: "Queen's Birthday (NSW)" },
  { date: new Date("2025-12-25"), name: "Christmas Day" },
  { date: new Date("2025-12-26"), name: "Boxing Day" },
  // ── 2026 (NSW) ────────────────────────────────────────
  { date: new Date("2026-01-01"), name: "New Year's Day" },
  { date: new Date("2026-01-26"), name: "Australia Day" },
  { date: new Date("2026-04-03"), name: "Good Friday" },
  { date: new Date("2026-04-04"), name: "Easter Saturday" },
  { date: new Date("2026-04-06"), name: "Easter Monday" },
  // ANZAC Day Apr 25 falls on Saturday — no substitute in NSW
  { date: new Date("2026-06-08"), name: "Queen's Birthday (NSW)" },
  { date: new Date("2026-12-25"), name: "Christmas Day" },
  { date: new Date("2026-12-28"), name: "Boxing Day (Observed)" },
  // ── 2027 (NSW) ────────────────────────────────────────
  { date: new Date("2027-01-01"), name: "New Year's Day" },
  { date: new Date("2027-01-26"), name: "Australia Day" },
  { date: new Date("2027-03-26"), name: "Good Friday" },
  { date: new Date("2027-03-27"), name: "Easter Saturday" },
  { date: new Date("2027-03-29"), name: "Easter Monday" },
  { date: new Date("2027-04-26"), name: "ANZAC Day (Observed)" },
  { date: new Date("2027-06-14"), name: "Queen's Birthday (NSW)" },
  { date: new Date("2027-12-27"), name: "Christmas Day (Observed)" },
  { date: new Date("2027-12-28"), name: "Boxing Day (Observed)" },
];

/**
 * Business calendar for production planning
 * Manages working days, weekends, and public holidays
 */
export class BusinessCalendar {
  private holidays: Set<string> = new Set();
  private holidayMap: Map<string, Holiday> = new Map();

  constructor(holidays: Holiday[] = DEFAULT_HOLIDAYS) {
    for (const holiday of holidays) {
      const dateKey = this.getDateKey(holiday.date);
      this.holidays.add(dateKey);
      this.holidayMap.set(dateKey, holiday);
    }
  }

  /**
   * Add a holiday to the calendar
   */
  addHoliday(date: Date, name: string, recurring: boolean = false): void {
    const dateKey = this.getDateKey(date);
    this.holidays.add(dateKey);
    this.holidayMap.set(dateKey, { date, name, recurring });
  }

  /**
   * Remove a holiday from the calendar
   */
  removeHoliday(date: Date): void {
    const dateKey = this.getDateKey(date);
    this.holidays.delete(dateKey);
    this.holidayMap.delete(dateKey);
  }

  /**
   * Check if a date is a working day
   * Working days are Monday-Friday and not public holidays
   */
  isWorkingDay(date: Date): boolean {
    const dayOfWeek = date.getDay();
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
    const isHoliday = this.holidays.has(this.getDateKey(date));

    return !isWeekend && !isHoliday;
  }

  /**
   * Get the next working day from a given date (exclusive)
   * If the given date is a working day, returns the next working day
   */
  nextWorkingDay(date: Date): Date {
    const next = new Date(date);
    next.setDate(next.getDate() + 1);

    while (!this.isWorkingDay(next)) {
      next.setDate(next.getDate() + 1);
    }

    return next;
  }

  /**
   * Get the previous working day from a given date (exclusive)
   */
  previousWorkingDay(date: Date): Date {
    const prev = new Date(date);
    prev.setDate(prev.getDate() - 1);

    while (!this.isWorkingDay(prev)) {
      prev.setDate(prev.getDate() - 1);
    }

    return prev;
  }

  /**
   * Count working days between two dates (inclusive of start, exclusive of end)
   */
  workingDaysBetween(start: Date, end: Date): number {
    let count = 0;
    const current = new Date(start);

    while (current < end) {
      if (this.isWorkingDay(current)) {
        count++;
      }
      current.setDate(current.getDate() + 1);
    }

    return count;
  }

  /**
   * Get all working days in a date range (inclusive)
   */
  getWorkingDaysInRange(start: Date, end: Date): Date[] {
    const workingDays: Date[] = [];
    const current = new Date(start);

    while (current <= end) {
      if (this.isWorkingDay(current)) {
        workingDays.push(new Date(current));
      }
      current.setDate(current.getDate() + 1);
    }

    return workingDays;
  }

  /**
   * Add working days to a date (exclusive of the input date)
   */
  addWorkingDays(date: Date, days: number): Date {
    let current = new Date(date);
    let count = 0;

    if (days > 0) {
      current.setDate(current.getDate() + 1); // Start from next day
      while (count < days) {
        if (this.isWorkingDay(current)) {
          count++;
          if (count === days) break;
        }
        current.setDate(current.getDate() + 1);
      }
    } else if (days < 0) {
      current.setDate(current.getDate() - 1); // Start from previous day
      while (count < Math.abs(days)) {
        if (this.isWorkingDay(current)) {
          count++;
          if (count === Math.abs(days)) break;
        }
        current.setDate(current.getDate() - 1);
      }
    }

    return current;
  }

  /**
   * Get holiday information for a date
   */
  getHoliday(date: Date): Holiday | undefined {
    return this.holidayMap.get(this.getDateKey(date));
  }

  /**
   * Normalize a date key (YYYY-MM-DD format for consistent comparison)
   */
  private getDateKey(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  /**
   * Check if two dates are on the same calendar day
   */
  isSameDay(date1: Date, date2: Date): boolean {
    return this.getDateKey(date1) === this.getDateKey(date2);
  }

  /**
   * Get the date at midnight for comparison
   */
  toMidnight(date: Date): Date {
    const midnight = new Date(date);
    midnight.setHours(0, 0, 0, 0);
    return midnight;
  }
}

/**
 * Create a default business calendar with Australian public holidays
 */
export function createDefaultBusinessCalendar(): BusinessCalendar {
  return new BusinessCalendar(DEFAULT_HOLIDAYS);
}
