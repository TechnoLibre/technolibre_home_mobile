import { LocalNotifications } from "@capacitor/local-notifications";
import { DatabaseService } from "./databaseService";
import type { Reminder } from "../models/reminder";
import { INTERVAL_OPTIONS } from "../models/reminder";

export type { Reminder };
export { INTERVAL_OPTIONS };

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Maximum number of notifications to pre-schedule per reminder.
 * Covers ≥ 24 h for intervals ≥ 30 min; ~4 h for 5-min intervals.
 * The batch is refreshed when rebatchExpiring() is called on app resume.
 */
const MAX_BATCH = 50;

// ─── ReminderService ──────────────────────────────────────────────────────────

export class ReminderService {
  constructor(private db: DatabaseService) {}

  /** Loads all reminders from SQLite. */
  async loadAll(): Promise<Reminder[]> {
    return this.db.getAllReminders();
  }

  /**
   * Persists the full reminder list to SQLite.
   * Deletes reminders that are no longer in the list, upserts the rest.
   */
  async saveAll(reminders: Reminder[]): Promise<void> {
    const existing = await this.db.getAllReminders();
    const newIds = new Set(reminders.map((r) => r.id));
    for (const r of existing) {
      if (!newIds.has(r.id)) await this.db.deleteReminder(r.id);
    }
    for (const r of reminders) {
      await this.db.upsertReminder(r);
    }
  }

  /** Requests notification permission. Returns true if granted. */
  async requestPermission(): Promise<boolean> {
    const { display } = await LocalNotifications.requestPermissions();
    return display === "granted";
  }

  /** Creates a new inactive reminder with a generated UUID. */
  create(message: string, intervalMinutes: number): Reminder {
    return {
      id: crypto.randomUUID(),
      message,
      intervalMinutes,
      active: false,
      scheduledIds: [],
      batchEndsAt: null,
    };
  }

  /**
   * Schedules the next batch of local notifications for a reminder.
   * Cancels any existing batch first. Persists the updated reminder.
   */
  async activate(reminder: Reminder): Promise<Reminder> {
    if (reminder.scheduledIds.length) {
      await LocalNotifications.cancel({
        notifications: reminder.scheduledIds.map((id) => ({ id })),
      });
    }

    const count = Math.min(
      MAX_BATCH,
      Math.ceil((24 * 60) / reminder.intervalMinutes)
    );
    const now = Date.now();
    const ids = this.generateNotifIds(now, count);
    const notifications = ids.map((id, i) => ({
      id,
      title: "Rappel personnel",
      body: reminder.message,
      schedule: { at: new Date(now + (i + 1) * reminder.intervalMinutes * 60_000) },
    }));

    await LocalNotifications.schedule({ notifications });

    const updated: Reminder = {
      ...reminder,
      active: true,
      scheduledIds: ids,
      batchEndsAt: notifications.at(-1)!.schedule.at.toISOString(),
    };
    await this.db.upsertReminder(updated);
    return updated;
  }

  /**
   * Cancels all scheduled notifications and marks the reminder inactive.
   */
  async deactivate(reminder: Reminder): Promise<Reminder> {
    if (reminder.scheduledIds.length) {
      await LocalNotifications.cancel({
        notifications: reminder.scheduledIds.map((id) => ({ id })),
      });
    }
    const updated: Reminder = {
      ...reminder,
      active: false,
      scheduledIds: [],
      batchEndsAt: null,
    };
    await this.db.upsertReminder(updated);
    return updated;
  }

  /**
   * Re-schedules any active reminders whose current batch is expiring
   * within 5 minutes. Call on app resume.
   */
  async rebatchExpiring(): Promise<void> {
    const reminders = await this.db.getAllReminders();
    const threshold = Date.now() + 5 * 60_000;
    for (const r of reminders) {
      if (!r.active || !r.batchEndsAt) continue;
      if (new Date(r.batchEndsAt).getTime() < threshold) {
        await this.activate(r);
      }
    }
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  /**
   * Generates `count` unique notification IDs based on the current timestamp.
   * Uses millisecond precision so two successive calls (≥1 ms apart) never
   * collide. IDs are in the range [1, 99_999_999], safe for 32-bit Android int.
   */
  private generateNotifIds(now: number, count: number): number[] {
    const base = now % 1_000_000; // 0–999999, unique per millisecond
    return Array.from({ length: count }, (_, i) => base * 100 + i + 1);
  }
}
