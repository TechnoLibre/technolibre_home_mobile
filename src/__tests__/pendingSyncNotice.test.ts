import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => true },
  registerPlugin: () => ({ publish: vi.fn() }),
}));

import { DatabaseService } from "../services/databaseService";
import { noticeTexts, pendingCounts, publishPending } from "../services/pendingSyncNotice";
import { CALENDAR_NOTE } from "../services/activityCalendarService";

describe("pending sync notice", () => {
  let db: DatabaseService;

  beforeEach(async () => {
    db = new DatabaseService();
    await db.initialize();
    await db.addSyncColumnsToNotes();
    await db.createSyncOutboxTable();
    await db.addSyncFieldsToApplications();
    await db.addNtfyTokenColumn();
    await db.addApplication({
      url: "https://odoo.example.com", username: "u", password: "p", database: "db",
      odooVersion: "", autoSync: false, pollIntervalMinutes: 5, ntfyUrl: "", ntfyTopic: "", ntfyToken: "",
    } as any);
  });

  const op = (id: string, configId: string, status = "queued") => db.addOutboxOp({
    id, clientUuid: id, noteId: CALENDAR_NOTE, configId, kind: "calendar.done", params: {},
    status: status as any, attempts: 0, nextAttemptAt: null, lastError: null, dependsOn: null, createdAt: "t", updatedAt: "t",
  });

  const note = (id: string, syncStatus: string) => db.addNote({
    id, title: id, done: false, archived: false, pinned: false, tags: [], entries: [],
  } as any).then(() => db.setNoteSyncInfo(id, { syncStatus: syncStatus as any }));

  it("counts the notes to send, the calendar's changes and the conflicts apart", async () => {
    await note("a", "pending");
    await note("b", "error");
    await note("c", "conflict");
    await note("d", "synced");
    await op("live", "https://odoo.example.com|u|db");
    // A server removed since, and a blocked change, are no work a sync can do
    await op("gone", "https://gone.example.com|u|db");
    await op("blocked", "https://odoo.example.com|u|db", "blocked");
    expect(await pendingCounts(db)).toEqual({ pending: 3, conflicts: 1 });
  });

  it("words the notice, nothing when nothing waits", () => {
    expect(noticeTexts({ pending: 0, conflicts: 0 })).toBeNull();
    const texts = noticeTexts({ pending: 2, conflicts: 1 })!;
    expect(texts.body).toContain("2");
    expect(texts.body).toContain("1");
  });

  it("publishes the counts and whether the app is in front, and survives a failing plugin", async () => {
    await note("a", "pending");
    const plugin = { publish: vi.fn(async () => {}) };
    await publishPending(db, false, plugin as any);
    expect(plugin.publish).toHaveBeenCalledWith(expect.objectContaining({ pending: 1, conflicts: 0, foreground: false, title: expect.any(String) }));
    const broken = { publish: vi.fn(async () => { throw new Error("no plugin"); }) };
    await expect(publishPending(db, true, broken as any)).resolves.toBeUndefined();
  });
});
