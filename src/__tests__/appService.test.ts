import { describe, it, expect, beforeEach, vi } from "vitest";
import { AppService } from "../services/appService";
import { DatabaseService } from "../services/databaseService";
import { Application } from "../models/application";
import { NoAppMatchError } from "../js/errors";

const baseApp = (overrides: Partial<Application> = {}): Application => ({
  url: "https://erp.example.com",
  username: "admin",
  password: "secret",
  database: "",
  odooVersion: "",
  autoSync: false,
  pollIntervalMinutes: 5,
  ntfyUrl: "",
  ntfyTopic: "",
  ntfyToken: "",
  ...overrides,
});

describe("AppService — initialization", () => {
  it("should throw when constructed without a DatabaseService (regression: app.ts called new AppService() before db was initialized)", async () => {
    // Reproduces the bug in app.ts where AppService was instantiated
    // before DatabaseService, leaving this._db as undefined.
    const broken = new AppService(undefined as any);
    await expect(broken.add(baseApp())).rejects.toThrow(
      /Cannot read properties of undefined/
    );
  });

  it("should throw when constructed without a DatabaseService (getApps)", async () => {
    const broken = new AppService(undefined as any);
    await expect(broken.getApps()).rejects.toThrow(
      /Cannot read properties of undefined/
    );
  });
});

describe("AppService with SQLite", () => {
  let appService: AppService;
  let db: DatabaseService;

  beforeEach(async () => {
    db = new DatabaseService();
    await db.initialize();
    appService = new AppService(db);
  });

  describe("getApps", () => {
    it("should return an empty list initially", async () => {
      const apps = await appService.getApps();
      expect(apps).toEqual([]);
    });

    it("should return apps after adding one", async () => {
      const app = baseApp();
      await appService.add(app);
      const apps = await appService.getApps();
      expect(apps).toHaveLength(1);
      expect(apps[0]).toEqual(app);
    });
  });

  describe("add", () => {
    it("should add an app successfully", async () => {
      const result = await appService.add(baseApp());
      expect(result).toBe(true);
    });

    it("should throw if app already exists", async () => {
      const app = baseApp();
      await appService.add(app);
      await expect(appService.add(app)).rejects.toThrow();
    });
  });

  describe("delete", () => {
    it("should delete an existing app", async () => {
      const app = baseApp();
      await appService.add(app);
      const result = await appService.delete({
        url: app.url,
        username: app.username,
      });
      expect(result).toBe(true);
      const apps = await appService.getApps();
      expect(apps).toEqual([]);
    });

    it("should throw NoAppMatchError if no match found", async () => {
      await expect(
        appService.delete({ url: "https://nope.com", username: "nope" })
      ).rejects.toThrow(NoAppMatchError);
    });
  });

  describe("edit", () => {
    it("should edit an existing app", async () => {
      const app = baseApp();
      await appService.add(app);

      const updated = baseApp({ password: "newpass" });
      const result = await appService.edit(
        { url: app.url, username: app.username },
        updated
      );
      expect(result).toBe(true);

      const apps = await appService.getApps();
      expect(apps[0].password).toBe("newpass");
    });

    const linkOf = (configId: string) => ({
      id: "l1", noteId: "n1", configId, model: "project.task", resId: 7,
      kind: "create" as const, remoteState: "ok" as const, createdAt: "2026-01-01T00:00:00.000Z", lastSyncedAt: null,
    });

    it("moves sync links along when only the url's spelling changes", async () => {
      await db.createNoteLinksTable();
      await appService.add(baseApp({ database: "db" }));
      await db.addNoteLink(linkOf("https://erp.example.com|admin|db"));

      await appService.edit(
        { url: "https://erp.example.com", username: "admin" },
        baseApp({ url: "https://ERP.example.com/", database: "db" })
      );
      expect((await db.getNoteLinks("n1"))[0].configId).toBe("https://ERP.example.com/|admin|db");
    });

    it("leaves sync links behind when the database changes", async () => {
      await db.createNoteLinksTable();
      await appService.add(baseApp({ database: "db" }));
      await db.addNoteLink(linkOf("https://erp.example.com|admin|db"));

      await appService.edit(
        { url: "https://erp.example.com", username: "admin" },
        baseApp({ database: "otherdb" })
      );
      expect((await db.getNoteLinks("n1"))[0].configId).toBe("https://erp.example.com|admin|db");
    });

    it("leaves sync links behind when the url names another server", async () => {
      await db.createNoteLinksTable();
      await appService.add(baseApp({ database: "db" }));
      await db.addNoteLink(linkOf("https://erp.example.com|admin|db"));

      await appService.edit(
        { url: "https://erp.example.com", username: "admin" },
        baseApp({ url: "https://other.example.com", database: "db" })
      );
      expect((await db.getNoteLinks("n1"))[0].configId).toBe("https://erp.example.com|admin|db");
    });
  });

  describe("matches", () => {
    it("should find matching apps", async () => {
      const app = baseApp();
      await appService.add(app);

      const result = await appService.matches({
        url: app.url,
        username: app.username,
      });
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(app);
    });

    it("should return empty array if no match", async () => {
      const result = await appService.matches({
        url: "https://nope.com",
        username: "nope",
      });
      expect(result).toEqual([]);
    });
  });

  describe("onChanged", () => {
    it("tells each add, edit and delete with the config id after the change and the one before", async () => {
      const changes: any[] = [];
      appService.onChanged = async (c) => { changes.push(c); };
      const app = baseApp({ database: "db1" });
      await appService.add(app);
      await appService.edit({ url: app.url, username: app.username }, { ...app, database: "db2" });
      await appService.delete({ url: app.url, username: app.username });
      await appService.add(baseApp({ username: "nodb" }));
      expect(changes).toEqual([
        { kind: "add", configId: "https://erp.example.com|admin|db1", realtimeRelevant: true },
        { kind: "edit", configId: "https://erp.example.com|admin|db2", previousConfigId: "https://erp.example.com|admin|db1", realtimeRelevant: true },
        { kind: "delete", configId: "https://erp.example.com|admin|db2", realtimeRelevant: true },
        { kind: "add", configId: null, realtimeRelevant: false },
      ]);
    });

    it("an edit of autoSync, poll interval or ntfy is not relevant to realtime, one of the password is", async () => {
      const changes: any[] = [];
      const app = baseApp({ database: "db1" });
      await appService.add(app);
      appService.onChanged = async (c) => { changes.push(c); };
      const id = { url: app.url, username: app.username };
      await appService.edit(id, { ...app, autoSync: !app.autoSync, pollIntervalMinutes: 99, ntfyUrl: "https://ntfy.example.com", ntfyTopic: "t", ntfyToken: "k" });
      await appService.edit(id, { ...app, password: "other" });
      await appService.edit(id, { ...app, password: "other", odooVersion: "17.0" });
      expect(changes.map((c) => [c.configId, c.realtimeRelevant])).toEqual([
        ["https://erp.example.com|admin|db1", false],
        ["https://erp.example.com|admin|db1", true],
        ["https://erp.example.com|admin|db1", true],
      ]);
      expect(changes.every((c) => c.previousConfigId === undefined)).toBe(true);
    });

    it("beforeRename runs before the sync rows move to the new config id, only when the id changes", async () => {
      const app = baseApp({ database: "db1" });
      await appService.add(app);
      const seen: any[] = [];
      const rename = vi.spyOn(db, "renameSyncConfigId");
      appService.beforeRename = async (from, to) => { seen.push([from, to, rename.mock.calls.length]); };
      const id = { url: app.url, username: app.username };
      await appService.edit(id, { ...app, url: "https://erp.example.com/" });
      await appService.edit({ url: "https://erp.example.com/", username: app.username }, { ...app, url: "https://erp.example.com/", password: "x" });
      expect(seen).toEqual([["https://erp.example.com|admin|db1", "https://erp.example.com/|admin|db1", 0]]);
    });

    it("a failing beforeRename does not stop the rename", async () => {
      const app = baseApp({ database: "db1" });
      await appService.add(app);
      appService.beforeRename = async () => { throw new Error("hook"); };
      const rename = vi.spyOn(db, "renameSyncConfigId");
      await expect(appService.edit({ url: app.url, username: app.username }, { ...app, url: "https://erp.example.com/" })).resolves.toBe(true);
      expect(rename).toHaveBeenCalledTimes(1);
    });

    it("afterRename runs once the sync rows moved, a failed move included, and its failure does not fail the edit", async () => {
      const app = baseApp({ database: "db1" });
      await appService.add(app);
      const seen: any[] = [];
      const rename = vi.spyOn(db, "renameSyncConfigId");
      appService.afterRename = async (from, to) => {
        seen.push([from, to, rename.mock.calls.length]);
        throw new Error("hook");
      };
      await expect(appService.edit({ url: app.url, username: app.username }, { ...app, url: "https://erp.example.com/" })).resolves.toBe(true);
      expect(seen).toEqual([["https://erp.example.com|admin|db1", "https://erp.example.com/|admin|db1", 1]]);
      rename.mockRejectedValueOnce(new Error("disk"));
      await expect(appService.edit({ url: "https://erp.example.com/", username: app.username }, { ...app, url: "https://erp.example.com" })).rejects.toThrow("disk");
      expect(seen).toHaveLength(2);
    });

    it("a failing listener does not fail the change", async () => {
      appService.onChanged = async () => { throw new Error("listener"); };
      await expect(appService.add(baseApp())).resolves.toBe(true);
      expect(await appService.getApps()).toHaveLength(1);
    });
  });

  describe("clear", () => {
    it("should remove all apps", async () => {
      await appService.add(baseApp({ url: "https://erp1.com", username: "u1", password: "p1" }));
      await appService.add(baseApp({ url: "https://erp2.com", username: "u2", password: "p2" }));
      const result = await appService.clear();
      expect(result).toBe(true);
      const apps = await appService.getApps();
      expect(apps).toEqual([]);
    });
  });
});
