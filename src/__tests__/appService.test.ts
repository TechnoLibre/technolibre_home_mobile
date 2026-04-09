import { describe, it, expect, beforeEach } from "vitest";
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
