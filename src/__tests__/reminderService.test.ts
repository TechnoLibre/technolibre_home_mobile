import { describe, it, expect, beforeEach } from "vitest";
import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";
import { LocalNotifications } from "@capacitor/local-notifications";
import { DatabaseService } from "../services/databaseService";
import { ReminderService } from "../services/reminderService";

// ─── Setup ────────────────────────────────────────────────────────────────────

async function makeServices() {
  SecureStoragePlugin._store.clear();
  (LocalNotifications as any)._reset();
  const db = new DatabaseService();
  await db.initialize();
  const svc = new ReminderService(db);
  return { db, svc };
}

// ─── ReminderService ──────────────────────────────────────────────────────────

describe("ReminderService", () => {
  let svc: ReminderService;
  let db: DatabaseService;

  beforeEach(async () => {
    ({ db, svc } = await makeServices());
  });

  // ─── loadAll / saveAll ────────────────────────────────────────────────────

  it("loadAll returns [] when nothing saved", async () => {
    expect(await svc.loadAll()).toEqual([]);
  });

  it("saveAll then loadAll round-trips correctly", async () => {
    const r = svc.create("Boire de l'eau", 30);
    await svc.saveAll([r]);
    const loaded = await svc.loadAll();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].message).toBe("Boire de l'eau");
    expect(loaded[0].intervalMinutes).toBe(30);
    expect(loaded[0].active).toBe(false);
  });

  it("saveAll removes deleted reminders from SQLite", async () => {
    const r1 = svc.create("A", 15);
    const r2 = svc.create("B", 60);
    await svc.saveAll([r1, r2]);
    await svc.saveAll([r2]); // remove r1
    const loaded = await svc.loadAll();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].message).toBe("B");
  });

  // ─── create ───────────────────────────────────────────────────────────────

  it("create returns an inactive reminder with a UUID id", () => {
    const r = svc.create("Test", 60);
    expect(r.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.active).toBe(false);
    expect(r.scheduledIds).toEqual([]);
    expect(r.batchEndsAt).toBeNull();
  });

  // ─── activate ─────────────────────────────────────────────────────────────

  it("activate schedules notifications, marks active, and persists", async () => {
    const r = svc.create("Pause", 60);
    const activated = await svc.activate(r);
    expect(activated.active).toBe(true);
    expect(activated.scheduledIds.length).toBeGreaterThan(0);
    expect(activated.batchEndsAt).not.toBeNull();
    // Persisted in DB
    const all = await svc.loadAll();
    expect(all).toHaveLength(1);
    expect(all[0].active).toBe(true);
    expect((LocalNotifications as any)._scheduled.length).toBeGreaterThan(0);
  });

  it("activate schedules at most 50 notifications for short intervals", async () => {
    const activated = await svc.activate(svc.create("Fréquent", 5));
    expect(activated.scheduledIds.length).toBeLessThanOrEqual(50);
  });

  it("activate for 30-min interval schedules 48 notifications (24h)", async () => {
    const activated = await svc.activate(svc.create("30min", 30));
    expect(activated.scheduledIds.length).toBe(48);
  });

  it("activate cancels the previous batch before scheduling a new one", async () => {
    let r = await svc.activate(svc.create("Rappel", 60));
    const firstIds = [...r.scheduledIds];
    await svc.activate(r);
    firstIds.forEach((id) =>
      expect((LocalNotifications as any)._cancelled).toContain(id)
    );
  });

  it("each activated reminder uses unique notification IDs", async () => {
    // Small delay ensures different timestamp base
    const r1 = await svc.activate(svc.create("A", 60));
    await new Promise((res) => setTimeout(res, 10));
    const r2 = await svc.activate(svc.create("B", 60));
    const allIds = [...r1.scheduledIds, ...r2.scheduledIds];
    expect(new Set(allIds).size).toBe(allIds.length);
  });

  // ─── deactivate ───────────────────────────────────────────────────────────

  it("deactivate cancels notifications, marks inactive, and persists", async () => {
    let r = await svc.activate(svc.create("Stop me", 60));
    const ids = [...r.scheduledIds];
    const deactivated = await svc.deactivate(r);
    expect(deactivated.active).toBe(false);
    expect(deactivated.scheduledIds).toEqual([]);
    expect(deactivated.batchEndsAt).toBeNull();
    ids.forEach((id) =>
      expect((LocalNotifications as any)._cancelled).toContain(id)
    );
    // Persisted in DB
    const all = await svc.loadAll();
    expect(all[0].active).toBe(false);
  });

  it("deactivate on inactive reminder does not throw", async () => {
    await expect(svc.deactivate(svc.create("Nothing", 30))).resolves.not.toThrow();
  });

  // ─── rebatchExpiring ──────────────────────────────────────────────────────

  it("rebatchExpiring reschedules reminders whose batch expired", async () => {
    let r = await svc.activate(svc.create("Expired", 60));
    // Force batchEndsAt to the past via direct DB update
    r = { ...r, batchEndsAt: new Date(Date.now() - 1000).toISOString() };
    await db.upsertReminder(r);

    await svc.rebatchExpiring();

    const all = await svc.loadAll();
    expect(new Date(all[0].batchEndsAt!).getTime()).toBeGreaterThan(Date.now());
  });

  it("rebatchExpiring does not touch reminders whose batch is far ahead", async () => {
    const r = await svc.activate(svc.create("Fresh", 60));
    const originalBatch = r.batchEndsAt;
    const beforeCount = (LocalNotifications as any)._scheduled.length;

    await svc.rebatchExpiring();

    const all = await svc.loadAll();
    expect(all[0].batchEndsAt).toBe(originalBatch);
    expect((LocalNotifications as any)._scheduled.length).toBe(beforeCount);
  });

  it("rebatchExpiring skips inactive reminders", async () => {
    await db.upsertReminder(svc.create("Inactive", 60));
    await svc.rebatchExpiring();
    expect((LocalNotifications as any)._scheduled.length).toBe(0);
  });
});
