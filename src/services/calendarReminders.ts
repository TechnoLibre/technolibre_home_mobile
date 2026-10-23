import { LocalNotifications } from "@capacitor/local-notifications";
import type { CalendarActivity } from "./databaseService";

/** localStorage keys of the reminder settings, and of the notification ids last scheduled. */
const SETTINGS_KEY = "options.calendar.reminders";
const IDS_KEY = "calendar.reminders.ids";

/** Notifications scheduled at most, the soonest first. */
export const REMINDER_LIMIT = 50;

/**
 * Local reminders of the user's open activities: one notification at hour
 * o'clock, daysBefore days before each deadline.
 */
export interface ReminderSettings {
  enabled: boolean;
  hour: number;
  daysBefore: number;
}

export const DEFAULT_REMINDERS: ReminderSettings = { enabled: false, hour: 8, daysBefore: 0 };

/** The settings stored, or the defaults; unreadable storage counts as the defaults. */
export function reminderSettings(): ReminderSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null");
    if (!raw) return DEFAULT_REMINDERS;
    const hour = Number(raw.hour);
    const daysBefore = Number(raw.daysBefore);
    return {
      enabled: raw.enabled === true,
      hour: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : DEFAULT_REMINDERS.hour,
      daysBefore: Number.isInteger(daysBefore) && daysBefore >= 0 && daysBefore <= 30 ? daysBefore : DEFAULT_REMINDERS.daysBefore,
    };
  } catch {
    return DEFAULT_REMINDERS;
  }
}

export function setReminderSettings(settings: ReminderSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Not kept: the defaults apply next time
  }
}

/**
 * The notification id of one activity: stable across schedules, so a
 * reschedule replaces it, and kept in [1e9, 2e9), clear of the reminder
 * ids the app's other reminders use (time-based, below 1e9).
 */
export function reminderId(configId: string, activityId: number): number {
  let h = 0x811c9dc5;
  const text = `${configId}#${activityId}`;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return 1_000_000_000 + ((h >>> 0) % 1_000_000_000);
}

export interface PlannedReminder {
  id: number;
  at: Date;
  title: string;
  body: string;
}

/**
 * The reminders of the open activities of uidByConfig's user on each
 * server, due at settings.hour, settings.daysBefore days before their
 * deadline, still ahead of now; the REMINDER_LIMIT soonest. None when the
 * reminders are off.
 */
export function plannedReminders(
  activities: CalendarActivity[],
  uidByConfig: Record<string, number | null>,
  settings: ReminderSettings,
  now: Date
): PlannedReminder[] {
  if (!settings.enabled) return [];
  return activities
    .filter((a) => !a.done && a.userId !== null && a.userId === uidByConfig[a.configId])
    .map((a) => {
      const at = new Date(`${a.deadline}T00:00:00`);
      at.setDate(at.getDate() - settings.daysBefore);
      at.setHours(settings.hour, 0, 0, 0);
      return {
        id: reminderId(a.configId, a.resId),
        at,
        title: a.summary || a.typeName || "Activité",
        body: `${a.recordName} — ${a.deadline}`,
      };
    })
    .filter((r) => !Number.isNaN(r.at.getTime()) && r.at.getTime() > now.getTime())
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .slice(0, REMINDER_LIMIT);
}

/**
 * Replaces the scheduled activity reminders with planned: cancels those
 * scheduled last time (ids kept in localStorage), then schedules the new
 * ones. Notification permission is asked when there is something to
 * schedule; refused, nothing is scheduled.
 */
export async function scheduleReminders(planned: PlannedReminder[]): Promise<number> {
  let previous: number[] = [];
  try { previous = JSON.parse(localStorage.getItem(IDS_KEY) ?? "[]"); } catch { /* none known */ }
  if (previous.length > 0) {
    await LocalNotifications.cancel({ notifications: previous.map((id) => ({ id })) });
  }
  let scheduled: number[] = [];
  if (planned.length > 0) {
    const { display } = await LocalNotifications.requestPermissions();
    if (display === "granted") {
      await LocalNotifications.schedule({
        notifications: planned.map((r) => ({ id: r.id, title: r.title, body: r.body, schedule: { at: r.at } })),
      });
      scheduled = planned.map((r) => r.id);
    }
  }
  try { localStorage.setItem(IDS_KEY, JSON.stringify(scheduled)); } catch { /* cancelled next time by id anyway */ }
  return scheduled.length;
}
