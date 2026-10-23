import { describe, it, expect, beforeEach, vi } from "vitest";
import { LocalNotifications } from "@capacitor/local-notifications";
import {
  DEFAULT_REMINDERS, plannedReminders, reminderId, reminderSettings, REMINDER_LIMIT, scheduleReminders, setReminderSettings,
} from "../services/calendarReminders";
import type { CalendarActivity } from "../services/databaseService";

const act = (over: Partial<CalendarActivity> = {}): CalendarActivity => ({
  configId: "a", resId: 1, resModel: "res.partner", recordId: 5, recordName: "Acme", typeId: 1, typeName: "Call",
  summary: "Call back", deadline: "2026-10-25", userId: 2, userName: "Me", done: false, dateDone: null, pending: false,
  fetchedAt: "t", ...over,
});

/** In-memory localStorage for the node test environment. */
function memoryStorage() {
  const items = new Map<string, string>();
  return {
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => { items.set(k, String(v)); },
    removeItem: (k: string) => { items.delete(k); },
  };
}

describe("calendar reminders", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", memoryStorage());
    (LocalNotifications.schedule as any).mockClear();
    (LocalNotifications.cancel as any).mockClear();
  });

  it("keeps the settings, with the defaults for anything unreadable", () => {
    expect(reminderSettings()).toEqual(DEFAULT_REMINDERS);
    setReminderSettings({ enabled: true, hour: 7, daysBefore: 1 });
    expect(reminderSettings()).toEqual({ enabled: true, hour: 7, daysBefore: 1 });
    localStorage.setItem("options.calendar.reminders", JSON.stringify({ enabled: true, hour: 40, daysBefore: -2 }));
    expect(reminderSettings()).toEqual({ enabled: true, hour: 8, daysBefore: 0 });
  });

  it("plans my open activities at the hour, days before, still ahead, soonest first", () => {
    const now = new Date(2026, 9, 23, 10, 0);
    const settings = { enabled: true, hour: 8, daysBefore: 1 };
    const planned = plannedReminders([
      act({ resId: 1, deadline: "2026-10-25" }),
      act({ resId: 2, deadline: "2026-10-24" }),
      act({ resId: 3, deadline: "2026-10-26", userId: 9 }),
      act({ resId: 4, deadline: "2026-10-26", done: true }),
      act({ resId: 5, deadline: "2026-10-27", configId: "b" }),
    ], { a: 2, b: null }, settings, now);
    expect(planned.map((r) => r.id)).toEqual([reminderId("a", 1)]);
    expect(planned[0].at).toEqual(new Date(2026, 9, 24, 8, 0));
    expect(planned[0]).toMatchObject({ title: "Call back", body: "Acme — 2026-10-25" });
    expect(plannedReminders([act()], { a: 2 }, { ...settings, enabled: false }, now)).toEqual([]);
  });

  it("caps the reminders and keeps their ids apart from the other reminders", () => {
    const many = Array.from({ length: REMINDER_LIMIT + 5 }, (_, i) => act({ resId: i + 1, deadline: "2026-12-01" }));
    expect(plannedReminders(many, { a: 2 }, { enabled: true, hour: 8, daysBefore: 0 }, new Date(2026, 9, 23))).toHaveLength(REMINDER_LIMIT);
    const id = reminderId("a", 1);
    expect(id).toBeGreaterThanOrEqual(1_000_000_000);
    expect(id).toBeLessThan(2_000_000_000);
    expect(reminderId("a", 1)).toBe(id);
  });

  it("replaces the reminders scheduled last time", async () => {
    const at = new Date(2030, 0, 1, 8);
    expect(await scheduleReminders([{ id: 1_000_000_001, at, title: "a", body: "b" }])).toBe(1);
    await scheduleReminders([]);
    expect(LocalNotifications.cancel).toHaveBeenLastCalledWith({ notifications: [{ id: 1_000_000_001 }] });
    expect(LocalNotifications.schedule).toHaveBeenCalledTimes(1);
  });
});
