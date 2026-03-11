import { describe, it, expect, vi, beforeEach } from "vitest";
import { NoteService } from "../services/note/noteService";
import { DatabaseService } from "../services/databaseService";
import { NoNoteMatchError } from "../js/errors";
import { Note } from "../models/note";
import { EventBus } from "@odoo/owl";

function setupMockDb() {
	(DatabaseService as any)._instance = undefined;
	const db = DatabaseService.getInstance();
	(db as any)._db = {};
	(db as any)._initialized = true;
	return db;
}

function createNote(overrides: Partial<Note> = {}): Note {
	return {
		id: "test-id-1",
		title: "Test Note",
		done: false,
		archived: false,
		pinned: false,
		tags: [],
		entries: [],
		...overrides,
	};
}

describe("NoteService", () => {
	let noteService: NoteService;
	let mockDb: DatabaseService;
	let eventBus: EventBus;

	beforeEach(() => {
		mockDb = setupMockDb();
		eventBus = new EventBus();
		noteService = new NoteService(eventBus);
	});

	describe("getNotes", () => {
		it("should fetch notes from database on first call", async () => {
			const notes = [createNote()];
			vi.spyOn(mockDb, "getAllNotes").mockResolvedValue(notes);

			const result = await noteService.getNotes();
			expect(result).toEqual(notes);
			expect(mockDb.getAllNotes).toHaveBeenCalledOnce();
		});

		it("should use cache on subsequent calls", async () => {
			vi.spyOn(mockDb, "getAllNotes").mockResolvedValue([createNote()]);

			await noteService.getNotes();
			await noteService.getNotes();
			expect(mockDb.getAllNotes).toHaveBeenCalledOnce();
		});

		it("should refresh from db after invalidateCache", async () => {
			vi.spyOn(mockDb, "getAllNotes").mockResolvedValue([createNote()]);

			await noteService.getNotes();
			noteService.invalidateCache();
			await noteService.getNotes();
			expect(mockDb.getAllNotes).toHaveBeenCalledTimes(2);
		});
	});

	describe("getMatch", () => {
		it("should return the note by id", async () => {
			const note = createNote({ id: "abc-123" });
			vi.spyOn(mockDb, "getNoteById").mockResolvedValue(note);

			const result = await noteService.getMatch("abc-123");
			expect(result).toEqual(note);
		});

		it("should throw NoNoteMatchError if not found", async () => {
			vi.spyOn(mockDb, "getNoteById").mockResolvedValue(null);

			await expect(noteService.getMatch("nonexistent")).rejects.toThrow(
				NoNoteMatchError
			);
		});
	});

	describe("matches", () => {
		it("should return notes matching the id", async () => {
			const notes = [
				createNote({ id: "a" }),
				createNote({ id: "b" }),
				createNote({ id: "a" }),
			];
			vi.spyOn(mockDb, "getAllNotes").mockResolvedValue(notes);

			const result = await noteService.matches("a");
			expect(result).toHaveLength(2);
			expect(result.every((n) => n.id === "a")).toBe(true);
		});
	});

	describe("setNotes", () => {
		it("should clear and re-insert all notes", async () => {
			const notes = [createNote({ id: "1" }), createNote({ id: "2" })];
			vi.spyOn(mockDb, "clearNotes").mockResolvedValue();
			vi.spyOn(mockDb, "addNote").mockResolvedValue();
			vi.spyOn(mockDb, "getAllNotes").mockResolvedValue(notes);

			const result = await noteService.setNotes(notes);
			expect(result).toBe(true);
			expect(mockDb.clearNotes).toHaveBeenCalledOnce();
			expect(mockDb.addNote).toHaveBeenCalledTimes(2);
		});

		it("should return false on error", async () => {
			vi.spyOn(mockDb, "clearNotes").mockRejectedValue(new Error("fail"));

			const result = await noteService.setNotes([]);
			expect(result).toBe(false);
		});
	});

	describe("getTags", () => {
		it("should return unique sorted tags from all notes", async () => {
			const notes = [
				createNote({ tags: ["zebra", "apple"] }),
				createNote({ tags: ["apple", "mango"] }),
			];
			vi.spyOn(mockDb, "getAllNotes").mockResolvedValue(notes);

			const tags = await noteService.getTags();
			expect(tags).toEqual(["apple", "mango", "zebra"]);
		});

		it("should return empty array when no notes", async () => {
			vi.spyOn(mockDb, "getAllNotes").mockResolvedValue([]);
			const tags = await noteService.getTags();
			expect(tags).toEqual([]);
		});
	});

	describe("getNewNote", () => {
		it("should return a blank note with the given id", () => {
			const note = noteService.getNewNote("my-id");
			expect(note.id).toBe("my-id");
			expect(note.title).toBe("");
			expect(note.done).toBe(false);
			expect(note.archived).toBe(false);
			expect(note.pinned).toBe(false);
			expect(note.tags).toEqual([]);
			expect(note.entries).toEqual([]);
		});

		it("should use empty string id when none provided", () => {
			const note = noteService.getNewNote();
			expect(note.id).toBe("");
		});
	});

	describe("getNewId", () => {
		it("should return a valid UUID v4", () => {
			const id = noteService.getNewId();
			expect(noteService.isValidId(id)).toBe(true);
		});
	});

	describe("isValidId", () => {
		it("should accept valid UUID v4", () => {
			expect(noteService.isValidId("f47ac10b-58cc-4372-a567-0e02b2c3d479")).toBe(true);
		});

		it("should reject invalid strings", () => {
			expect(noteService.isValidId("not-a-uuid")).toBe(false);
			expect(noteService.isValidId("")).toBe(false);
		});
	});
});

describe("NoteCrudSubservice", () => {
	let noteService: NoteService;
	let mockDb: DatabaseService;

	beforeEach(() => {
		mockDb = setupMockDb();
		noteService = new NoteService(new EventBus());
	});

	describe("add", () => {
		it("should add a note and invalidate cache", async () => {
			vi.spyOn(mockDb, "addNote").mockResolvedValue();
			const note = createNote();

			const result = await noteService.crud.add(note);
			expect(result).toBe(true);
			expect(mockDb.addNote).toHaveBeenCalledWith(note);
		});

		it("should return false on error", async () => {
			vi.spyOn(mockDb, "addNote").mockRejectedValue(new Error("fail"));

			const result = await noteService.crud.add(createNote());
			expect(result).toBe(false);
		});
	});

	describe("delete", () => {
		it("should delete an existing note", async () => {
			const note = createNote({ id: "to-delete" });
			vi.spyOn(mockDb, "getNoteById").mockResolvedValue(note);
			vi.spyOn(mockDb, "deleteNote").mockResolvedValue();

			const result = await noteService.crud.delete("to-delete");
			expect(result).toBe(true);
			expect(mockDb.deleteNote).toHaveBeenCalledWith("to-delete");
		});

		it("should throw NoNoteMatchError if note not found", async () => {
			vi.spyOn(mockDb, "getNoteById").mockResolvedValue(null);

			await expect(noteService.crud.delete("missing")).rejects.toThrow(
				NoNoteMatchError
			);
		});
	});

	describe("edit", () => {
		it("should update an existing note", async () => {
			const existing = createNote({ id: "n1", title: "Old" });
			const updated = createNote({ id: "n1", title: "New" });
			vi.spyOn(mockDb, "getNoteById").mockResolvedValue(existing);
			vi.spyOn(mockDb, "updateNote").mockResolvedValue();

			const result = await noteService.crud.edit("n1", updated);
			expect(result).toBe(true);
			expect(mockDb.updateNote).toHaveBeenCalledWith(updated);
		});

		it("should throw NoNoteMatchError if note not found", async () => {
			vi.spyOn(mockDb, "getNoteById").mockResolvedValue(null);

			await expect(
				noteService.crud.edit("missing", createNote())
			).rejects.toThrow(NoNoteMatchError);
		});
	});

	describe("clear", () => {
		it("should clear all notes", async () => {
			vi.spyOn(mockDb, "clearNotes").mockResolvedValue();

			const result = await noteService.crud.clear();
			expect(result).toBe(true);
			expect(mockDb.clearNotes).toHaveBeenCalledOnce();
		});
	});
});
