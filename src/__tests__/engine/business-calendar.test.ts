import { BusinessCalendar, createDefaultBusinessCalendar } from "@/lib/engine/business-calendar";

describe("BusinessCalendar", () => {
  let calendar: BusinessCalendar;

  beforeEach(() => {
    calendar = createDefaultBusinessCalendar();
  });

  describe("isWorkingDay", () => {
    test("should return true for weekday", () => {
      // Monday, March 17, 2025
      const weekday = new Date("2025-03-17");
      expect(calendar.isWorkingDay(weekday)).toBe(true);
    });

    test("should return false for Saturday", () => {
      // Saturday, March 22, 2025
      const saturday = new Date("2025-03-22");
      expect(calendar.isWorkingDay(saturday)).toBe(false);
    });

    test("should return false for Sunday", () => {
      // Sunday, March 23, 2025
      const sunday = new Date("2025-03-23");
      expect(calendar.isWorkingDay(sunday)).toBe(false);
    });

    test("should return false for public holiday", () => {
      // Easter Monday 2025
      const easterMonday = new Date("2025-04-21");
      expect(calendar.isWorkingDay(easterMonday)).toBe(false);
    });
  });

  describe("nextWorkingDay", () => {
    test("should return next day if it is a working day", () => {
      // Monday -> Tuesday
      const monday = new Date("2025-03-17");
      const nextDay = calendar.nextWorkingDay(monday);
      expect(nextDay.getDate()).toBe(18); // Tuesday
    });

    test("should skip weekend", () => {
      // Friday -> Monday (skip Saturday, Sunday)
      const friday = new Date("2025-03-21");
      const nextDay = calendar.nextWorkingDay(friday);
      expect(nextDay.getDate()).toBe(24); // Monday
    });

    test("should skip public holiday", () => {
      // Friday before Easter -> Wednesday after Easter
      const friday = new Date("2025-04-18");
      const nextDay = calendar.nextWorkingDay(friday);
      // Should skip: Good Friday (18), Saturday (19), Sunday (20), Easter Monday (21), Tuesday (22)
      // Next working day is Tuesday April 22
      expect(nextDay.getDate()).toBe(22);
      expect(nextDay.getMonth()).toBe(3); // April
    });
  });

  describe("previousWorkingDay", () => {
    test("should return previous day if it is a working day", () => {
      // Tuesday -> Monday
      const tuesday = new Date("2025-03-18");
      const prevDay = calendar.previousWorkingDay(tuesday);
      expect(prevDay.getDate()).toBe(17); // Monday
    });

    test("should skip weekend backwards", () => {
      // Monday -> Friday (skip Saturday, Sunday going back)
      const monday = new Date("2025-03-24");
      const prevDay = calendar.previousWorkingDay(monday);
      expect(prevDay.getDate()).toBe(21); // Friday
    });
  });

  describe("workingDaysBetween", () => {
    test("should count working days between two dates", () => {
      // Monday March 17 - Friday March 21 (5 working days)
      const start = new Date("2025-03-17");
      const end = new Date("2025-03-22"); // Saturday (exclusive)
      const days = calendar.workingDaysBetween(start, end);
      expect(days).toBe(5);
    });

    test("should exclude weekends", () => {
      // Friday March 21 - Monday March 24 (1 working day on Friday)
      const start = new Date("2025-03-21");
      const end = new Date("2025-03-25"); // Tuesday (exclusive)
      const days = calendar.workingDaysBetween(start, end);
      expect(days).toBe(2); // Friday 21, Monday 24
    });

    test("should return 0 for same day", () => {
      const start = new Date("2025-03-17");
      const end = new Date("2025-03-17");
      const days = calendar.workingDaysBetween(start, end);
      expect(days).toBe(0);
    });
  });

  describe("addWorkingDays", () => {
    test("should add working days forward", () => {
      // Monday + 5 working days = Monday of next week (Mon, Tue, Wed, Thu, Fri = 5 days)
      const monday = new Date("2025-03-17");
      const result = calendar.addWorkingDays(monday, 5);
      expect(result.getDate()).toBe(24); // Monday
    });

    test("should skip weekends when adding", () => {
      // Friday + 3 days = Wednesday (skip weekend, Sat, Sun, Mon, Tue, Wed)
      const friday = new Date("2025-03-21");
      const result = calendar.addWorkingDays(friday, 3);
      expect(result.getDate()).toBe(26); // Wednesday
    });

    test("should subtract working days backward", () => {
      // Tuesday - 5 days = Tuesday of previous week
      const tuesday = new Date("2025-03-18");
      const result = calendar.addWorkingDays(tuesday, -5);
      expect(result.getDate()).toBe(11); // Tuesday
    });

    test("should return same date for 0 days", () => {
      const monday = new Date("2025-03-17");
      const result = calendar.addWorkingDays(monday, 0);
      expect(result.getDate()).toBe(17);
    });
  });

  describe("getWorkingDaysInRange", () => {
    test("should return all working days in range", () => {
      const start = new Date("2025-03-17"); // Monday
      const end = new Date("2025-03-21"); // Friday
      const days = calendar.getWorkingDaysInRange(start, end);

      expect(days).toHaveLength(5);
      expect(days[0].getDate()).toBe(17);
      expect(days[4].getDate()).toBe(21);
    });

    test("should exclude weekends and holidays", () => {
      const start = new Date("2025-04-18"); // Good Friday
      const end = new Date("2025-04-22"); // Tuesday
      const days = calendar.getWorkingDaysInRange(start, end);

      // Exclude Good Friday (18), Saturday (19), Sunday (20), Easter Monday (21)
      expect(days).toHaveLength(1); // Only Tuesday (22)
    });
  });

  describe("custom holidays", () => {
    test("should add custom holiday", () => {
      const customCalendar = new BusinessCalendar([]);
      const customDate = new Date("2025-05-15");

      customCalendar.addHoliday(customDate, "Custom Holiday");
      expect(customCalendar.isWorkingDay(customDate)).toBe(false);
    });

    test("should remove custom holiday", () => {
      const customDate = new Date("2025-05-15");
      const customCalendar = new BusinessCalendar([
        { date: customDate, name: "Custom Holiday" },
      ]);

      expect(customCalendar.isWorkingDay(customDate)).toBe(false);

      customCalendar.removeHoliday(customDate);
      expect(customCalendar.isWorkingDay(customDate)).toBe(true);
    });

    test("should retrieve holiday information", () => {
      const date = new Date("2025-04-21"); // Easter Monday
      const holiday = calendar.getHoliday(date);

      expect(holiday).toBeDefined();
      expect(holiday?.name).toBe("Easter Monday");
    });
  });

  describe("utility functions", () => {
    test("should check if two dates are the same day", () => {
      const date1 = new Date("2025-03-17");
      const date2 = new Date("2025-03-17");
      const date3 = new Date("2025-03-18");

      expect(calendar.isSameDay(date1, date2)).toBe(true);
      expect(calendar.isSameDay(date1, date3)).toBe(false);
    });

    test("should convert date to midnight", () => {
      const date = new Date("2025-03-17T14:30:00");
      const midnight = calendar.toMidnight(date);

      expect(midnight.getHours()).toBe(0);
      expect(midnight.getMinutes()).toBe(0);
      expect(midnight.getSeconds()).toBe(0);
    });
  });

  describe("complex scenarios", () => {
    test("should handle long weekend with public holiday", () => {
      // Good Friday to Easter Monday (long weekend with holiday)
      const goodFriday = new Date("2025-04-18");
      const afterEaster = calendar.nextWorkingDay(goodFriday);

      // Should skip Good Friday, Saturday, Sunday, Easter Monday
      expect(afterEaster.getDate()).toBe(22); // Tuesday
    });

    test("should calculate project timeline spanning holidays", () => {
      const start = new Date("2025-04-17"); // Thursday
      const end = new Date("2025-04-25"); // Friday after Easter
      const days = calendar.workingDaysBetween(start, end);

      // Thursday 17 + Friday 18 (Good Fri - no) + Mon 21 (no) + Tue 22 + Wed 23 + Thu 24 (end is exclusive)
      // = Thu = 1 day  (only Thursday 17, then Friday 18 is Good Friday, skip to Tue 22, Wed 23, Thu 24)
      // Actually: start (17=Thu) to end (25=Fri, exclusive) = 17(Thu), skip 18-21, 22(Tue), 23(Wed), 24(Thu)
      expect(days).toBe(4);
    });
  });
});
