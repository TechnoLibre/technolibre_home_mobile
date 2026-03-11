import { describe, it, expect, vi, beforeEach } from "vitest";
import { DatabaseService } from "../services/databaseService";

// Reset singleton between tests
function resetSingleton() {
	(DatabaseService as any)._instance = undefined;
}

describe("DatabaseService", () => {
	beforeEach(() => {
		resetSingleton();
	});

	it("should return the same instance (singleton)", () => {
		const a = DatabaseService.getInstance();
		const b = DatabaseService.getInstance();
		expect(a).toBe(b);
	});

	it("should throw if getDb is called before initialize", async () => {
		const db = DatabaseService.getInstance();
		await expect(db.getAllApplications()).rejects.toThrow(
			"Database not initialized"
		);
	});

	it("should initialize without error", async () => {
		const db = DatabaseService.getInstance();
		await expect(db.initialize()).resolves.toBeUndefined();
	});

	it("should not re-initialize if already initialized", async () => {
		const db = DatabaseService.getInstance();
		await db.initialize();

		const spy = vi.spyOn((db as any)._sqlite, "createConnection");
		await db.initialize();
		expect(spy).not.toHaveBeenCalled();
	});

	describe("Applications CRUD", () => {
		let db: DatabaseService;
		let mockDbConn: any;

		beforeEach(async () => {
			db = DatabaseService.getInstance();
			await db.initialize();
			mockDbConn = (db as any)._db;
		});

		it("getAllApplications should return empty array when no data", async () => {
			mockDbConn.query = vi.fn().mockResolvedValue({ values: [] });
			const result = await db.getAllApplications();
			expect(result).toEqual([]);
			expect(mockDbConn.query).toHaveBeenCalledWith(
				"SELECT url, username, password FROM applications;"
			);
		});

		it("getAllApplications should return applications", async () => {
			const apps = [
				{ url: "https://erp.example.com", username: "admin", password: "pass" },
			];
			mockDbConn.query = vi.fn().mockResolvedValue({ values: apps });
			const result = await db.getAllApplications();
			expect(result).toEqual(apps);
		});

		it("addApplication should execute INSERT", async () => {
			mockDbConn.run = vi.fn().mockResolvedValue({});
			const app = { url: "https://erp.example.com", username: "admin", password: "secret" };
			await db.addApplication(app);
			expect(mockDbConn.run).toHaveBeenCalledWith(
				"INSERT INTO applications (url, username, password) VALUES (?, ?, ?);",
				["https://erp.example.com", "admin", "secret"]
			);
		});

		it("deleteApplication should execute DELETE with correct params", async () => {
			mockDbConn.run = vi.fn().mockResolvedValue({});
			await db.deleteApplication({ url: "https://erp.example.com", username: "admin" });
			expect(mockDbConn.run).toHaveBeenCalledWith(
				"DELETE FROM applications WHERE url = ? AND username = ?;",
				["https://erp.example.com", "admin"]
			);
		});

		it("updateApplication should execute UPDATE with old and new values", async () => {
			mockDbConn.run = vi.fn().mockResolvedValue({});
			const oldID = { url: "https://old.com", username: "admin" };
			const newApp = { url: "https://new.com", username: "admin", password: "newpass" };
			await db.updateApplication(oldID, newApp);
			expect(mockDbConn.run).toHaveBeenCalledWith(
				"UPDATE applications SET url = ?, username = ?, password = ? WHERE url = ? AND username = ?;",
				["https://new.com", "admin", "newpass", "https://old.com", "admin"]
			);
		});

		it("findApplications should query with url and username", async () => {
			mockDbConn.query = vi.fn().mockResolvedValue({ values: [] });
			await db.findApplications({ url: "https://erp.example.com", username: "admin" });
			expect(mockDbConn.query).toHaveBeenCalledWith(
				"SELECT url, username, password FROM applications WHERE url = ? AND username = ?;",
				["https://erp.example.com", "admin"]
			);
		});

		it("clearApplications should delete all", async () => {
			mockDbConn.run = vi.fn().mockResolvedValue({});
			await db.clearApplications();
			expect(mockDbConn.run).toHaveBeenCalledWith("DELETE FROM applications;");
		});
	});

	describe("Notes CRUD", () => {
		let db: DatabaseService;
		let mockDbConn: any;

		beforeEach(async () => {
			db = DatabaseService.getInstance();
			await db.initialize();
			mockDbConn = (db as any)._db;
		});

		it("getAllNotes should return empty array when no notes", async () => {
			mockDbConn.query = vi.fn().mockResolvedValue({ values: [] });
			const result = await db.getAllNotes();
			expect(result).toEqual([]);
		});

		it("getAllNotes should assemble notes with tags and entries", async () => {
			mockDbConn.query = vi
				.fn()
				.mockResolvedValueOnce({
					values: [{ id: "n1", title: "Test", date: null, done: 0, archived: 0, pinned: 1 }],
				})
				.mockResolvedValueOnce({
					values: [{ note_id: "n1", tag: "urgent" }],
				})
				.mockResolvedValueOnce({
					values: [
						{
							id: "e1",
							note_id: "n1",
							type: "text",
							params: JSON.stringify({ text: "hello", readonly: false }),
							sort_order: 0,
						},
					],
				});

			const notes = await db.getAllNotes();
			expect(notes).toHaveLength(1);
			expect(notes[0]).toEqual({
				id: "n1",
				title: "Test",
				date: undefined,
				done: false,
				archived: false,
				pinned: true,
				tags: ["urgent"],
				entries: [{ id: "e1", type: "text", params: { text: "hello", readonly: false } }],
			});
		});

		it("getNoteById should return null when not found", async () => {
			mockDbConn.query = vi.fn().mockResolvedValue({ values: [] });
			const result = await db.getNoteById("nonexistent");
			expect(result).toBeNull();
		});

		it("getNoteById should return the note with tags and entries", async () => {
			mockDbConn.query = vi
				.fn()
				.mockResolvedValueOnce({
					values: [{ id: "n1", title: "My Note", date: "2026-01-01", done: 1, archived: 0, pinned: 0 }],
				})
				.mockResolvedValueOnce({ values: [{ tag: "work" }] })
				.mockResolvedValueOnce({ values: [] });

			const note = await db.getNoteById("n1");
			expect(note).toEqual({
				id: "n1",
				title: "My Note",
				date: "2026-01-01",
				done: true,
				archived: false,
				pinned: false,
				tags: ["work"],
				entries: [],
			});
		});

		it("addNote should use a transaction with tags and entries", async () => {
			mockDbConn.beginTransaction = vi.fn();
			mockDbConn.commitTransaction = vi.fn();
			mockDbConn.rollbackTransaction = vi.fn();
			mockDbConn.run = vi.fn().mockResolvedValue({});

			const note = {
				id: "n1",
				title: "Test",
				date: undefined,
				done: false,
				archived: false,
				pinned: false,
				tags: ["tag1", "tag2"],
				entries: [
					{ id: "e1", type: "text" as const, params: { text: "hello", readonly: false } },
				],
			};

			await db.addNote(note);

			expect(mockDbConn.beginTransaction).toHaveBeenCalledOnce();
			expect(mockDbConn.commitTransaction).toHaveBeenCalledOnce();
			expect(mockDbConn.rollbackTransaction).not.toHaveBeenCalled();
			// 1 note INSERT + 2 tag INSERTs + 1 entry INSERT = 4 runs
			expect(mockDbConn.run).toHaveBeenCalledTimes(4);
		});

		it("addNote should rollback on error", async () => {
			mockDbConn.beginTransaction = vi.fn();
			mockDbConn.commitTransaction = vi.fn();
			mockDbConn.rollbackTransaction = vi.fn();
			mockDbConn.run = vi.fn().mockRejectedValue(new Error("INSERT failed"));

			const note = {
				id: "n1",
				title: "Test",
				done: false,
				archived: false,
				pinned: false,
				tags: [],
				entries: [],
			};

			await expect(db.addNote(note)).rejects.toThrow("INSERT failed");
			expect(mockDbConn.rollbackTransaction).toHaveBeenCalledOnce();
			expect(mockDbConn.commitTransaction).not.toHaveBeenCalled();
		});

		it("updateNote should replace tags and entries in a transaction", async () => {
			mockDbConn.beginTransaction = vi.fn();
			mockDbConn.commitTransaction = vi.fn();
			mockDbConn.rollbackTransaction = vi.fn();
			mockDbConn.run = vi.fn().mockResolvedValue({});

			const note = {
				id: "n1",
				title: "Updated",
				done: true,
				archived: false,
				pinned: true,
				tags: ["newtag"],
				entries: [],
			};

			await db.updateNote(note);

			expect(mockDbConn.beginTransaction).toHaveBeenCalledOnce();
			expect(mockDbConn.commitTransaction).toHaveBeenCalledOnce();
			// 1 UPDATE + 1 DELETE tags + 1 INSERT tag + 1 DELETE entries = 4 runs
			expect(mockDbConn.run).toHaveBeenCalledTimes(4);
		});

		it("deleteNote should execute DELETE by id", async () => {
			mockDbConn.run = vi.fn().mockResolvedValue({});
			await db.deleteNote("n1");
			expect(mockDbConn.run).toHaveBeenCalledWith(
				"DELETE FROM notes WHERE id = ?;",
				["n1"]
			);
		});

		it("clearNotes should delete all notes", async () => {
			mockDbConn.run = vi.fn().mockResolvedValue({});
			await db.clearNotes();
			expect(mockDbConn.run).toHaveBeenCalledWith("DELETE FROM notes;");
		});
	});
});
