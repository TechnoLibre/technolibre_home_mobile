import { describe, it, expect, beforeEach } from "vitest";
import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";
import { DatabaseService } from "../services/databaseService";
import { migrateFromSecureStorage } from "../services/dataMigration";
import { Application } from "../models/application";
import { Note } from "../models/note";

describe("Data migration from SecureStorage to SQLite", () => {
  let db: DatabaseService;

  beforeEach(async () => {
    SecureStoragePlugin._store.clear();
    db = new DatabaseService();
    await db.initialize();
  });

  it("should migrate applications from SecureStorage to SQLite", async () => {
    const apps: Application[] = [
      { url: "https://erp1.com", username: "admin", password: "pass1" },
      { url: "https://erp2.com", username: "user", password: "pass2" },
    ];
    await SecureStoragePlugin.set({
      key: "applications",
      value: JSON.stringify(apps),
    });

    await migrateFromSecureStorage(db);

    const dbApps = await db.getAllApplications();
    expect(dbApps).toHaveLength(2);
    expect(dbApps[0].url).toBe("https://erp1.com");
    expect(dbApps[1].url).toBe("https://erp2.com");
  });

  it("should migrate notes from SecureStorage to SQLite", async () => {
    const notes: Note[] = [
      {
        id: "note-1",
        title: "My Note",
        date: "2025-01-01T00:00:00.000Z",
        done: false,
        archived: false,
        pinned: true,
        tags: ["work"],
        entries: [
          { id: "e1", type: "text", params: { text: "Hello", readonly: false } },
        ],
      },
    ];
    await SecureStoragePlugin.set({
      key: "notes",
      value: JSON.stringify(notes),
    });

    await migrateFromSecureStorage(db);

    const dbNotes = await db.getAllNotes();
    expect(dbNotes).toHaveLength(1);
    expect(dbNotes[0].id).toBe("note-1");
    expect(dbNotes[0].title).toBe("My Note");
    expect(dbNotes[0].pinned).toBe(true);
    expect(dbNotes[0].tags).toEqual(["work"]);
    expect(dbNotes[0].entries).toHaveLength(1);
    expect(dbNotes[0].entries[0].type).toBe("text");
  });

  it("should do nothing if SecureStorage is empty", async () => {
    await migrateFromSecureStorage(db);

    const dbApps = await db.getAllApplications();
    const dbNotes = await db.getAllNotes();
    expect(dbApps).toEqual([]);
    expect(dbNotes).toEqual([]);
  });

  it("should not duplicate data if migration runs twice", async () => {
    const apps: Application[] = [
      { url: "https://erp1.com", username: "admin", password: "pass1" },
    ];
    await SecureStoragePlugin.set({
      key: "applications",
      value: JSON.stringify(apps),
    });

    await migrateFromSecureStorage(db);
    await migrateFromSecureStorage(db);

    const dbApps = await db.getAllApplications();
    expect(dbApps).toHaveLength(1);
  });

  it("should remove data from SecureStorage after migration", async () => {
    const apps: Application[] = [
      { url: "https://erp1.com", username: "admin", password: "pass1" },
    ];
    await SecureStoragePlugin.set({
      key: "applications",
      value: JSON.stringify(apps),
    });

    await migrateFromSecureStorage(db);

    // SecureStorage should no longer have the key
    await expect(
      SecureStoragePlugin.get({ key: "applications" })
    ).rejects.toThrow();
  });
});
