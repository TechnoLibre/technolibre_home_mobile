import { describe, it, expect, vi, beforeEach } from "vitest";
import { AppService } from "../services/appService";
import { DatabaseService } from "../services/databaseService";
import { AppAlreadyExistsError, NoAppMatchError } from "../js/errors";
import { Application } from "../models/application";

// Reset DatabaseService singleton and mock its methods
function setupMockDb() {
	(DatabaseService as any)._instance = undefined;
	const db = DatabaseService.getInstance();
	(db as any)._db = {}; // Prevent "not initialized" error
	(db as any)._initialized = true;
	return db;
}

describe("AppService", () => {
	let appService: AppService;
	let mockDb: DatabaseService;

	beforeEach(() => {
		mockDb = setupMockDb();
		appService = new AppService();
	});

	describe("getApps", () => {
		it("should fetch apps from database on first call", async () => {
			const apps: Application[] = [
				{ url: "https://erp.example.com", username: "admin", password: "pass" },
			];
			vi.spyOn(mockDb, "getAllApplications").mockResolvedValue(apps);

			const result = await appService.getApps();
			expect(result).toEqual(apps);
			expect(mockDb.getAllApplications).toHaveBeenCalledOnce();
		});

		it("should use cache on subsequent calls", async () => {
			const apps: Application[] = [
				{ url: "https://erp.example.com", username: "admin", password: "pass" },
			];
			vi.spyOn(mockDb, "getAllApplications").mockResolvedValue(apps);

			await appService.getApps();
			await appService.getApps();
			expect(mockDb.getAllApplications).toHaveBeenCalledOnce();
		});
	});

	describe("add", () => {
		it("should add a new application", async () => {
			const app: Application = { url: "https://new.com", username: "user", password: "pass" };
			vi.spyOn(mockDb, "findApplications").mockResolvedValue([]);
			vi.spyOn(mockDb, "addApplication").mockResolvedValue();

			const result = await appService.add(app);
			expect(result).toBe(true);
			expect(mockDb.addApplication).toHaveBeenCalledWith(app);
		});

		it("should throw AppAlreadyExistsError if app exists", async () => {
			const app: Application = { url: "https://existing.com", username: "admin", password: "pass" };
			vi.spyOn(mockDb, "findApplications").mockResolvedValue([app]);

			await expect(appService.add(app)).rejects.toThrow(AppAlreadyExistsError);
		});

		it("should return false if database insert fails", async () => {
			const app: Application = { url: "https://new.com", username: "user", password: "pass" };
			vi.spyOn(mockDb, "findApplications").mockResolvedValue([]);
			vi.spyOn(mockDb, "addApplication").mockRejectedValue(new Error("DB error"));

			const result = await appService.add(app);
			expect(result).toBe(false);
		});
	});

	describe("delete", () => {
		it("should delete an existing application", async () => {
			const app: Application = { url: "https://erp.example.com", username: "admin", password: "pass" };
			vi.spyOn(mockDb, "findApplications").mockResolvedValue([app]);
			vi.spyOn(mockDb, "deleteApplication").mockResolvedValue();

			const result = await appService.delete({ url: app.url, username: app.username });
			expect(result).toBe(true);
			expect(mockDb.deleteApplication).toHaveBeenCalledWith({ url: app.url, username: app.username });
		});

		it("should throw NoAppMatchError if app not found", async () => {
			vi.spyOn(mockDb, "findApplications").mockResolvedValue([]);

			await expect(
				appService.delete({ url: "https://missing.com", username: "nobody" })
			).rejects.toThrow(NoAppMatchError);
		});
	});

	describe("edit", () => {
		it("should update an existing application", async () => {
			const existing: Application = { url: "https://erp.example.com", username: "admin", password: "oldpass" };
			const updated: Application = { url: "https://erp.example.com", username: "admin", password: "newpass" };

			vi.spyOn(mockDb, "findApplications").mockResolvedValue([existing]);
			vi.spyOn(mockDb, "updateApplication").mockResolvedValue();

			const result = await appService.edit(
				{ url: existing.url, username: existing.username },
				updated
			);
			expect(result).toBe(true);
			expect(mockDb.updateApplication).toHaveBeenCalledWith(
				{ url: existing.url, username: existing.username },
				updated
			);
		});

		it("should keep existing password when ignorePassword is true", async () => {
			const existing: Application = { url: "https://erp.example.com", username: "admin", password: "oldpass" };
			const updated: Application = { url: "https://erp.example.com", username: "admin", password: "ignored" };

			vi.spyOn(mockDb, "findApplications").mockResolvedValue([existing]);
			vi.spyOn(mockDb, "updateApplication").mockResolvedValue();

			await appService.edit(
				{ url: existing.url, username: existing.username },
				updated,
				{ ignorePassword: true }
			);

			expect(mockDb.updateApplication).toHaveBeenCalledWith(
				{ url: existing.url, username: existing.username },
				expect.objectContaining({ password: "oldpass" })
			);
		});

		it("should throw NoAppMatchError if app not found", async () => {
			vi.spyOn(mockDb, "findApplications").mockResolvedValue([]);

			await expect(
				appService.edit(
					{ url: "https://missing.com", username: "nobody" },
					{ url: "https://missing.com", username: "nobody", password: "x" }
				)
			).rejects.toThrow(NoAppMatchError);
		});
	});

	describe("clear", () => {
		it("should clear all applications", async () => {
			vi.spyOn(mockDb, "clearApplications").mockResolvedValue();

			const result = await appService.clear();
			expect(result).toBe(true);
			expect(mockDb.clearApplications).toHaveBeenCalledOnce();
		});
	});

	describe("getMatch", () => {
		it("should return matching application", async () => {
			const app: Application = { url: "https://erp.example.com", username: "admin", password: "pass" };
			vi.spyOn(mockDb, "findApplications").mockResolvedValue([app]);

			const result = await appService.getMatch({ url: app.url, username: app.username });
			expect(result).toEqual(app);
		});

		it("should throw NoAppMatchError if no match", async () => {
			vi.spyOn(mockDb, "findApplications").mockResolvedValue([]);

			await expect(
				appService.getMatch({ url: "https://missing.com", username: "nobody" })
			).rejects.toThrow(NoAppMatchError);
		});
	});

	describe("appIDFrom", () => {
		it("should create ApplicationID from Application", () => {
			const app: Application = { url: "https://erp.example.com", username: "admin", password: "pass" };
			const id = appService.appIDFrom(app);
			expect(id).toEqual({ url: "https://erp.example.com", username: "admin" });
			expect(id).not.toHaveProperty("password");
		});
	});
});
