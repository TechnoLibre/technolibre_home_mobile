import { describe, it, expect } from "vitest";
import {
  activitiesOn, dayOfActivity, monthCells, overdueActivities, shiftMonth, visibleActivities,
} from "../services/calendarView";
import { addDays, calendarWindow } from "../services/activityCalendarService";
import type { CalendarActivity } from "../services/databaseService";

const act = (over: Partial<CalendarActivity> = {}): CalendarActivity => ({
  configId: "a", resId: 1, resModel: "res.partner", recordId: 5, recordName: "Acme", typeId: 1, typeName: "Call",
  summary: "", deadline: "2026-10-23", userId: 2, userName: "Me", done: false, dateDone: null, pending: false,
  fetchedAt: "t", ...over,
});

describe("calendar days", () => {
  it("moves across months and years", () => {
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
  });

  it("reads 30 days back and 90 ahead", () => {
    expect(calendarWindow(new Date(2026, 9, 23, 15))).toEqual({ from: "2026-09-23", to: "2027-01-21" });
  });

  it("lays a month out in full weeks from Monday, counting open, overdue and done activities", () => {
    const cells = monthCells("2026-10", [
      act({ resId: 1, deadline: "2026-10-20" }),
      act({ resId: 2, deadline: "2026-10-23" }),
      act({ resId: 3, deadline: "2026-10-01", done: true, dateDone: "2026-10-22 09:00:00" }),
    ], "2026-10-23");
    expect(cells[0].day).toBe("2026-09-28");
    expect(cells.at(-1)!.day).toBe("2026-11-01");
    expect(cells.length % 7).toBe(0);
    const day = (d: string) => cells.find((c) => c.day === d)!;
    expect(day("2026-10-20")).toMatchObject({ overdue: 1, open: 0, inMonth: true });
    expect(day("2026-10-23")).toMatchObject({ open: 1, isToday: true });
    expect(day("2026-10-22")).toMatchObject({ done: 1 });
    expect(day("2026-10-01").done).toBe(0);
    expect(day("2026-09-28").inMonth).toBe(false);
  });

  it("puts a done activity on the day it was done", () => {
    expect(dayOfActivity(act({ done: true, dateDone: "2026-10-22 09:00:00", deadline: "2026-10-01" }))).toBe("2026-10-22");
    expect(dayOfActivity(act({ done: true, dateDone: null, deadline: "2026-10-01" }))).toBe("2026-10-01");
  });

  it("lists a day's activities open first, and the overdue ones oldest first", () => {
    const list = [
      act({ resId: 1, done: true, dateDone: "2026-10-23", typeName: "A" }),
      act({ resId: 2, typeName: "B" }),
      act({ resId: 3, deadline: "2026-10-10" }),
      act({ resId: 4, deadline: "2026-09-01" }),
    ];
    expect(activitiesOn(list, "2026-10-23").map((a) => a.resId)).toEqual([2, 1]);
    expect(overdueActivities(list, "2026-10-23").map((a) => a.resId)).toEqual([4, 3]);
  });

  it("shows mine and the others' apart, per server", () => {
    const list = [act({ resId: 1, userId: 2 }), act({ resId: 2, userId: 9 }), act({ resId: 3, configId: "b", userId: 2 })];
    const uids = { a: 2, b: 7 };
    expect(visibleActivities(list, { mine: true, others: false }, uids).map((a) => a.resId)).toEqual([1]);
    expect(visibleActivities(list, { mine: false, others: true }, uids).map((a) => a.resId)).toEqual([2, 3]);
  });
});
