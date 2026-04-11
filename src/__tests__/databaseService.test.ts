import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseService } from "../services/databaseService";
import { Application } from "../models/application";
import { Note } from "../models/note";
import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";
import { StorageConstants } from "../constants/storage";

describe("DatabaseService", () => {
  let db: DatabaseService;

  beforeEach(async () => {
    SecureStoragePlugin._store.clear();
    db = new DatabaseService();
    await db.initialize();
  });

  // ── Encryption ──

  describe("encryption", () => {
    it("should generate and store a 64-char hex encryption key on first initialize", async () => {
      const stored = await SecureStoragePlugin.get({
        key: StorageConstants.DB_ENCRYPTION_KEY,
      });
      expect(stored.value).toMatch(/^[0-9a-f]{64}$/);
    });

    it("should reuse the same encryption key on subsequent initializes", async () => {
      const key1 = await SecureStoragePlugin.get({
        key: StorageConstants.DB_ENCRYPTION_KEY,
      });

      const db2 = new DatabaseService();
      await db2.initialize();

      const key2 = await SecureStoragePlugin.get({
        key: StorageConstants.DB_ENCRYPTION_KEY,
      });

      expect(key1.value).toBe(key2.value);
    });

    it("should generate a different key for each fresh install", async () => {
      const key1 = await SecureStoragePlugin.get({
        key: StorageConstants.DB_ENCRYPTION_KEY,
      });

      SecureStoragePlugin._store.clear();
      const db2 = new DatabaseService();
      await db2.initialize();

      const key2 = await SecureStoragePlugin.get({
        key: StorageConstants.DB_ENCRYPTION_KEY,
      });

      expect(key1.value).not.toBe(key2.value);
    });
  });

  // ── Initialization ──

  describe("initialize", () => {
    it("should initialize without errors", async () => {
      const db = new DatabaseService();
      await expect(db.initialize()).resolves.not.toThrow();
    });
  });

  // ── Applications ──

  describe("applications", () => {
    const app: Application = {
      url: "https://erp.example.com",
      username: "admin",
      password: "secret",
      database: "",
      odooVersion: "",
      autoSync: false,
      pollIntervalMinutes: 5,
      ntfyUrl: "",
      ntfyTopic: "",
    };

    it("should return an empty list initially", async () => {
      const apps = await db.getAllApplications();
      expect(apps).toEqual([]);
    });

    it("should add an application", async () => {
      await db.addApplication(app);
      const apps = await db.getAllApplications();
      expect(apps).toHaveLength(1);
      expect(apps[0]).toEqual(app);
    });

    it("should add multiple applications", async () => {
      const app2: Application = {
        url: "https://erp2.example.com",
        username: "user",
        password: "pass",
        database: "",
        odooVersion: "",
        autoSync: false,
        pollIntervalMinutes: 5,
        ntfyUrl: "",
        ntfyTopic: "",
      };
      await db.addApplication(app);
      await db.addApplication(app2);
      const apps = await db.getAllApplications();
      expect(apps).toHaveLength(2);
    });

    it("should delete an application", async () => {
      await db.addApplication(app);
      await db.deleteApplication(app.url, app.username);
      const apps = await db.getAllApplications();
      expect(apps).toEqual([]);
    });

    it("should only delete the matching application", async () => {
      const app2: Application = {
        url: "https://erp2.example.com",
        username: "user",
        password: "pass",
        database: "",
        odooVersion: "",
        autoSync: false,
        pollIntervalMinutes: 5,
        ntfyUrl: "",
        ntfyTopic: "",
      };
      await db.addApplication(app);
      await db.addApplication(app2);
      await db.deleteApplication(app.url, app.username);
      const apps = await db.getAllApplications();
      expect(apps).toHaveLength(1);
      expect(apps[0]).toEqual(app2);
    });

    it("should update an application", async () => {
      await db.addApplication(app);
      const updated: Application = {
        url: app.url,
        username: app.username,
        password: "newpassword",
        database: "",
        odooVersion: "",
        autoSync: false,
        pollIntervalMinutes: 5,
        ntfyUrl: "",
        ntfyTopic: "",
      };
      await db.updateApplication(app.url, app.username, updated);
      const apps = await db.getAllApplications();
      expect(apps).toHaveLength(1);
      expect(apps[0].password).toBe("newpassword");
    });
  });

  // ── Notes ──

  describe("notes", () => {
    const note: Note = {
      id: "note-1",
      title: "My Note",
      date: "2025-01-01T00:00:00.000Z",
      done: false,
      archived: false,
      pinned: false,
      tags: ["work", "urgent"],
      entries: [],
    };

    it("should return an empty list initially", async () => {
      const notes = await db.getAllNotes();
      expect(notes).toEqual([]);
    });

    it("should add a note", async () => {
      await db.addNote(note);
      const notes = await db.getAllNotes();
      expect(notes).toHaveLength(1);
      expect(notes[0].id).toBe("note-1");
      expect(notes[0].title).toBe("My Note");
      expect(notes[0].tags).toEqual(["work", "urgent"]);
      expect(notes[0].entries).toEqual([]);
    });

    it("should delete a note", async () => {
      await db.addNote(note);
      await db.deleteNote("note-1");
      const notes = await db.getAllNotes();
      expect(notes).toEqual([]);
    });

    it("should update a note", async () => {
      await db.addNote(note);
      const updated: Note = {
        ...note,
        title: "Updated Note",
        done: true,
        tags: ["done"],
      };
      await db.updateNote("note-1", updated);
      const notes = await db.getAllNotes();
      expect(notes).toHaveLength(1);
      expect(notes[0].title).toBe("Updated Note");
      expect(notes[0].done).toBe(true);
      expect(notes[0].tags).toEqual(["done"]);
    });

    it("should preserve note entries through serialization", async () => {
      const noteWithEntries: Note = {
        ...note,
        entries: [
          {
            id: "entry-1",
            type: "text",
            params: { text: "Hello", readonly: false },
          },
          {
            id: "entry-2",
            type: "photo",
            params: { path: "/img/photo.jpg" },
          },
        ],
      };
      await db.addNote(noteWithEntries);
      const notes = await db.getAllNotes();
      expect(notes[0].entries).toHaveLength(2);
      expect(notes[0].entries[0].type).toBe("text");
      expect(notes[0].entries[1].type).toBe("photo");
    });

    it("should handle notes without optional date", async () => {
      const noteNoDate: Note = {
        id: "note-no-date",
        title: "No date",
        done: false,
        archived: false,
        pinned: false,
        tags: [],
        entries: [],
      };
      await db.addNote(noteNoDate);
      const notes = await db.getAllNotes();
      expect(notes[0].date).toBeUndefined();
    });
  });

  // ── Sync columns ──

  describe("sync columns", () => {
    beforeEach(async () => {
      await db.addSyncColumnsToNotes();
    });

    it("addSyncColumnsToNotes is idempotent — calling twice does not throw", async () => {
      await expect(db.addSyncColumnsToNotes()).resolves.not.toThrow();
    });

    it("getNoteSyncInfo returns defaults for a fresh note", async () => {
      await db.addNote({ id: "n1", title: "T", done: false, archived: false, pinned: false, tags: [], entries: [] });
      const info = await db.getNoteSyncInfo("n1");
      expect(info.odooId).toBeNull();
      expect(info.odooUrl).toBeNull();
      expect(info.syncStatus).toBe("local");
      expect(info.lastSyncedAt).toBeNull();
    });

    it("getNoteSyncInfo returns defaults for unknown note id", async () => {
      const info = await db.getNoteSyncInfo("ghost");
      expect(info.odooId).toBeNull();
      expect(info.syncStatus).toBe("local");
    });

    it("setNoteSyncInfo persists odooId and odooUrl", async () => {
      await db.addNote({ id: "n2", title: "T", done: false, archived: false, pinned: false, tags: [], entries: [] });
      await db.setNoteSyncInfo("n2", { odooId: 55, odooUrl: "https://erp.example.com" });
      const info = await db.getNoteSyncInfo("n2");
      expect(info.odooId).toBe(55);
      expect(info.odooUrl).toBe("https://erp.example.com");
    });

    it("setNoteSyncInfo persists syncStatus", async () => {
      await db.addNote({ id: "n3", title: "T", done: false, archived: false, pinned: false, tags: [], entries: [] });
      await db.setNoteSyncInfo("n3", { syncStatus: "synced" });
      const info = await db.getNoteSyncInfo("n3");
      expect(info.syncStatus).toBe("synced");
    });

    it("setNoteSyncInfo does a partial update — untouched fields are preserved", async () => {
      await db.addNote({ id: "n4", title: "T", done: false, archived: false, pinned: false, tags: [], entries: [] });
      await db.setNoteSyncInfo("n4", { odooId: 7, odooUrl: "https://erp.example.com", syncStatus: "synced" });
      await db.setNoteSyncInfo("n4", { syncStatus: "error" });
      const info = await db.getNoteSyncInfo("n4");
      expect(info.odooId).toBe(7);
      expect(info.syncStatus).toBe("error");
    });

    it("getNoteById returns the note", async () => {
      await db.addNote({ id: "n5", title: "Find me", done: true, archived: false, pinned: false, tags: [], entries: [] });
      const note = await db.getNoteById("n5");
      expect(note).not.toBeNull();
      expect(note!.title).toBe("Find me");
      expect(note!.done).toBe(true);
    });

    it("getNoteById returns null for unknown id", async () => {
      const note = await db.getNoteById("nonexistent");
      expect(note).toBeNull();
    });

    it("getNotesByOdooUrl returns notes matching the odoo url", async () => {
      const url = "https://erp.example.com";
      await db.addNote({ id: "na", title: "A", done: false, archived: false, pinned: false, tags: [], entries: [] });
      await db.addNote({ id: "nb", title: "B", done: false, archived: false, pinned: false, tags: [], entries: [] });
      await db.setNoteSyncInfo("na", { odooId: 1, odooUrl: url, syncStatus: "synced" });
      // nb has no odooUrl — should not appear
      const notes = await db.getNotesByOdooUrl(url);
      expect(notes).toHaveLength(1);
      expect(notes[0].id).toBe("na");
      expect(notes[0].syncInfo.odooId).toBe(1);
    });
  });

  // ── user graphic preferences ──

  describe("user graphic preferences", () => {
    beforeEach(async () => {
      await db.createUserGraphicPrefsTable();
    });

    it("createUserGraphicPrefsTable is idempotent", async () => {
      await expect(db.createUserGraphicPrefsTable()).resolves.not.toThrow();
    });

    it("getUserGraphicPref returns null for a missing key", async () => {
      const val = await db.getUserGraphicPref("fontFamily");
      expect(val).toBeNull();
    });

    it("setUserGraphicPref and getUserGraphicPref round-trip correctly", async () => {
      await db.setUserGraphicPref("fontFamily", "mono");
      const val = await db.getUserGraphicPref("fontFamily");
      expect(val).toBe("mono");
    });

    it("setUserGraphicPref overwrites an existing value", async () => {
      await db.setUserGraphicPref("fontSizeScale", "1");
      await db.setUserGraphicPref("fontSizeScale", "1.3");
      const val = await db.getUserGraphicPref("fontSizeScale");
      expect(val).toBe("1.3");
    });

    it("stores multiple independent keys", async () => {
      await db.setUserGraphicPref("fontFamily", "serif");
      await db.setUserGraphicPref("fontSizeScale", "0.9");
      expect(await db.getUserGraphicPref("fontFamily")).toBe("serif");
      expect(await db.getUserGraphicPref("fontSizeScale")).toBe("0.9");
    });
  });

  // ── syncConfigId and selectedSyncConfigIds ──

  describe("syncConfigId and selectedSyncConfigIds", () => {
    beforeEach(async () => {
      await db.addSyncColumnsToNotes();
      await db.addSyncConfigIdColumn();
      await db.addSelectedSyncConfigIdsColumn();
    });

    it("addSyncConfigIdColumn is idempotent", async () => {
      await expect(db.addSyncConfigIdColumn()).resolves.not.toThrow();
    });

    it("addSelectedSyncConfigIdsColumn is idempotent", async () => {
      await expect(db.addSelectedSyncConfigIdsColumn()).resolves.not.toThrow();
    });

    it("setNoteSyncInfo persists syncConfigId", async () => {
      await db.addNote({ id: "nc1", title: "T", done: false, archived: false, pinned: false, tags: [], entries: [] });
      await db.setNoteSyncInfo("nc1", { syncConfigId: "https://erp.example.com|admin" });
      const info = await db.getNoteSyncInfo("nc1");
      expect(info.syncConfigId).toBe("https://erp.example.com|admin");
    });

    it("setNoteSyncInfo persists and retrieves selectedSyncConfigIds", async () => {
      await db.addNote({ id: "nc2", title: "T", done: false, archived: false, pinned: false, tags: [], entries: [] });
      await db.setNoteSyncInfo("nc2", { selectedSyncConfigIds: ["cfg1", "cfg2"] });
      const info = await db.getNoteSyncInfo("nc2");
      expect(info.selectedSyncConfigIds).toEqual(["cfg1", "cfg2"]);
    });

    it("getNoteSyncInfo returns null selectedSyncConfigIds when unset", async () => {
      await db.addNote({ id: "nc3", title: "T", done: false, archived: false, pinned: false, tags: [], entries: [] });
      const info = await db.getNoteSyncInfo("nc3");
      expect(info.selectedSyncConfigIds).toBeNull();
    });

    it("getNotesBySyncConfigId returns notes matching the config id", async () => {
      const configId = "https://erp.example.com|admin";
      await db.addNote({ id: "ncc1", title: "Synced note", done: false, archived: false, pinned: false, tags: [], entries: [] });
      await db.addNote({ id: "ncc2", title: "Other note", done: false, archived: false, pinned: false, tags: [], entries: [] });
      await db.setNoteSyncInfo("ncc1", { syncConfigId: configId });
      const notes = await db.getNotesBySyncConfigId(configId);
      expect(notes).toHaveLength(1);
      expect(notes[0].id).toBe("ncc1");
    });
  });

  // ── Per-server sync status ──

  describe("per-server sync status", () => {
    beforeEach(async () => {
      await db.addSyncColumnsToNotes();
      await db.addSyncPerServerStatusColumn();
    });

    it("addSyncPerServerStatusColumn is idempotent", async () => {
      await expect(db.addSyncPerServerStatusColumn()).resolves.not.toThrow();
    });

    it("setNotePerServerStatus stores status for a server", async () => {
      await db.addNote({ id: "ps1", title: "T", done: false, archived: false, pinned: false, tags: [], entries: [] });
      await db.setNotePerServerStatus("ps1", "https://erp.example.com|admin", "synced");
      const counts = await db.getNoteSyncCounts();
      expect(counts["ps1"]).toEqual({ synced: 1, error: 0 });
    });

    it("setNotePerServerStatus merges multiple servers", async () => {
      await db.addNote({ id: "ps2", title: "T", done: false, archived: false, pinned: false, tags: [], entries: [] });
      await db.setNotePerServerStatus("ps2", "https://erp1.example.com|admin", "synced");
      await db.setNotePerServerStatus("ps2", "https://erp2.example.com|admin", "error");
      const counts = await db.getNoteSyncCounts();
      expect(counts["ps2"]).toEqual({ synced: 1, error: 1 });
    });

    it("setNotePerServerStatus overwrites existing status for same server", async () => {
      await db.addNote({ id: "ps3", title: "T", done: false, archived: false, pinned: false, tags: [], entries: [] });
      await db.setNotePerServerStatus("ps3", "https://erp.example.com|admin", "error");
      await db.setNotePerServerStatus("ps3", "https://erp.example.com|admin", "synced");
      const counts = await db.getNoteSyncCounts();
      expect(counts["ps3"]).toEqual({ synced: 1, error: 0 });
    });

    it("getNoteSyncCounts returns empty object when no per-server status is set", async () => {
      await db.addNote({ id: "ps4", title: "T", done: false, archived: false, pinned: false, tags: [], entries: [] });
      const counts = await db.getNoteSyncCounts();
      expect(counts["ps4"]).toBeUndefined();
    });

    it("getNoteSyncCounts aggregates across multiple notes", async () => {
      await db.addNote({ id: "ps5", title: "A", done: false, archived: false, pinned: false, tags: [], entries: [] });
      await db.addNote({ id: "ps6", title: "B", done: false, archived: false, pinned: false, tags: [], entries: [] });
      await db.setNotePerServerStatus("ps5", "https://erp.example.com|admin", "synced");
      await db.setNotePerServerStatus("ps6", "https://erp.example.com|admin", "error");
      const counts = await db.getNoteSyncCounts();
      expect(counts["ps5"]).toEqual({ synced: 1, error: 0 });
      expect(counts["ps6"]).toEqual({ synced: 0, error: 1 });
    });
  });

  // ── Odoo version on applications ──

  describe("odoo version on applications", () => {
    const app: Application = {
      url: "https://erp.example.com",
      username: "admin",
      password: "secret",
      database: "mydb",
      odooVersion: "",
      autoSync: false,
      pollIntervalMinutes: 5,
      ntfyUrl: "",
      ntfyTopic: "",
    };

    it("addOdooVersionToApplications is idempotent", async () => {
      await expect(db.addOdooVersionToApplications()).resolves.not.toThrow();
      await expect(db.addOdooVersionToApplications()).resolves.not.toThrow();
    });

    it("setApplicationOdooVersion persists the version string", async () => {
      await db.addOdooVersionToApplications();
      await db.addApplication(app);
      await db.setApplicationOdooVersion(app.url, app.username, "17.0+e");
      const apps = await db.getAllApplications();
      expect(apps[0].odooVersion).toBe("17.0+e");
    });

    it("addApplication stores initial odooVersion", async () => {
      await db.addApplication({ ...app, odooVersion: "18.0" });
      const apps = await db.getAllApplications();
      expect(apps[0].odooVersion).toBe("18.0");
    });
  });
});
