import { describe, it, expect, beforeEach } from "vitest";
import { EventBus } from "@odoo/owl";
import { NoteService } from "../services/note/noteService";
import { DatabaseService } from "../services/databaseService";
import { Note } from "../models/note";
import { NoNoteMatchError } from "../js/errors";
import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";

describe("NoteService with SQLite", () => {
  let noteService: NoteService;
  let db: DatabaseService;
  let eventBus: EventBus;

  const makeNote = (overrides?: Partial<Note>): Note => ({
    id: "note-1",
    title: "Test Note",
    date: "2025-01-01T00:00:00.000Z",
    done: false,
    archived: false,
    pinned: false,
    tags: [],
    entries: [],
    ...overrides,
  });

  beforeEach(async () => {
    // Clear SecureStorage mock to avoid data leaking between tests
    SecureStoragePlugin._store.clear();
    db = new DatabaseService();
    await db.initialize();
    eventBus = new EventBus();
    noteService = new NoteService(eventBus, db);
  });

  // NoteService

  describe("getNotes", () => {
    it("should return an empty list initially", async () => {
      const notes = await noteService.getNotes();
      expect(notes).toEqual([]);
    });
  });

  describe("matches", () => {
    it("should find a note by id", async () => {
      const note = makeNote();
      await db.addNote(note);
      const result = await noteService.matches("note-1");
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("note-1");
    });

    it("should return empty array if no match", async () => {
      const result = await noteService.matches("nonexistent");
      expect(result).toEqual([]);
    });
  });

  describe("getMatch", () => {
    it("should return the matching note", async () => {
      const note = makeNote();
      await db.addNote(note);
      const result = await noteService.getMatch("note-1");
      expect(result.id).toBe("note-1");
    });

    it("should throw NoNoteMatchError if no match", async () => {
      await expect(
        noteService.getMatch("nonexistent")
      ).rejects.toThrow(NoNoteMatchError);
    });
  });

  describe("getTags", () => {
    it("should return all unique tags sorted", async () => {
      await db.addNote(makeNote({ id: "n1", tags: ["work", "urgent"] }));
      await db.addNote(makeNote({ id: "n2", tags: ["personal", "work"] }));
      const tags = await noteService.getTags();
      expect(tags).toEqual(["personal", "urgent", "work"]);
    });

    it("should return empty array if no notes", async () => {
      const tags = await noteService.getTags();
      expect(tags).toEqual([]);
    });
  });

  describe("setNotes", () => {
    it("should replace all notes", async () => {
      await db.addNote(makeNote({ id: "old" }));
      const newNotes = [
        makeNote({ id: "new-1", title: "New 1" }),
        makeNote({ id: "new-2", title: "New 2" }),
      ];
      const result = await noteService.setNotes(newNotes);
      expect(result).toBe(true);
      const notes = await noteService.getNotes();
      expect(notes).toHaveLength(2);
      expect(notes[0].id).toBe("new-1");
      expect(notes[1].id).toBe("new-2");
      // Verify old note is gone
      const allNotes = await db.getAllNotes();
      expect(allNotes.find((n) => n.id === "old")).toBeUndefined();
    });
  });

  // NoteCrudSubservice

  describe("crud.add", () => {
    it("should add a note", async () => {
      const note = makeNote();
      const result = await noteService.crud.add(note);
      expect(result).toBe(true);
      const notes = await noteService.getNotes();
      expect(notes).toHaveLength(1);
      expect(notes[0].id).toBe("note-1");
    });
  });

  describe("crud.delete", () => {
    it("should delete a note by id", async () => {
      await noteService.crud.add(makeNote());
      const result = await noteService.crud.delete("note-1");
      expect(result).toBe(true);
      const notes = await noteService.getNotes();
      expect(notes).toEqual([]);
    });

    it("should throw NoNoteMatchError if not found", async () => {
      try {
        await noteService.crud.delete("nonexistent");
        expect.unreachable("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(NoNoteMatchError);
      }
    });
  });

  describe("crud.editSince", () => {
    it("keeps what a pull wrote since the editor read the note, and the editor's own changes", async () => {
      const text = (value: string) => ({ id: "e", type: "text", params: { text: value, readonly: false } } as any);
      const since = makeNote({ entries: [text("Typed")] });
      await noteService.crud.add(since);
      // A pull renames the note while the editor holds the copy it read
      await db.updateNote("note-1", { ...since, title: "Pulled title" });
      const mine = makeNote({ entries: [text("Typed more")] });
      const { mine: asMerged, saved } = await noteService.crud.editSince("note-1", mine, since);
      expect(saved.title).toBe("Pulled title");
      expect((saved.entries[0].params as any).text).toBe("Typed more");
      const stored = (await noteService.getNotes())[0];
      expect(stored.title).toBe("Pulled title");
      expect((stored.entries[0].params as any).text).toBe("Typed more");
      // Copies taken as it wrote: later edits of mine do not reach them
      (mine.entries[0].params as any).text = "Typed even more";
      expect((asMerged.entries[0].params as any).text).toBe("Typed more");
      expect((saved.entries[0].params as any).text).toBe("Typed more");
    });

    it("throws NoNoteMatchError for a note not stored", async () => {
      await expect(noteService.crud.editSince("nonexistent", makeNote(), makeNote())).rejects.toBeInstanceOf(NoNoteMatchError);
    });
  });

  describe("crud.edit", () => {
    it("should edit an existing note", async () => {
      await noteService.crud.add(makeNote());
      const updated = makeNote({ title: "Updated" });
      const result = await noteService.crud.edit("note-1", updated);
      expect(result).toBe(true);
      const notes = await noteService.getNotes();
      expect(notes[0].title).toBe("Updated");
    });

    it("should throw NoNoteMatchError if not found", async () => {
      try {
        await noteService.crud.edit("nonexistent", makeNote());
        expect.unreachable("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(NoNoteMatchError);
      }
    });

    it("marks a linked note pending for each server it is linked on", async () => {
      await db.addSyncColumnsToNotes();
      await db.addSyncPerServerStatusColumn();
      await db.createNoteLinksTable();
      await noteService.crud.add(makeNote());
      for (const url of ["https://a.example.com", "https://b.example.com"]) {
        await db.addApplication({
          url, username: "u", password: "p", database: "db",
          odooVersion: "", autoSync: false, pollIntervalMinutes: 5, ntfyUrl: "", ntfyTopic: "", ntfyToken: "",
        } as any);
      }
      for (const configId of ["https://a.example.com|u|db", "https://b.example.com|u|db"]) {
        await db.addNoteLink({
          id: `l-${configId}`, noteId: "note-1", configId, model: "project.task", resId: 1,
          kind: "create", remoteState: "ok", createdAt: "2026-01-01T00:00:00.000Z", lastSyncedAt: null,
        });
      }

      await noteService.crud.edit("note-1", makeNote({ title: "Updated" }));

      expect(await db.getNotePerServerStatus("note-1")).toEqual({
        "https://a.example.com|u|db": "pending",
        "https://b.example.com|u|db": "pending",
      });
      expect((await db.getNoteSyncInfo("note-1")).syncStatus).toBe("pending");
    });

    it("leaves a never-synced note local", async () => {
      await db.addSyncColumnsToNotes();
      await db.createNoteLinksTable();
      await noteService.crud.add(makeNote());
      await noteService.crud.edit("note-1", makeNote({ title: "Updated" }));
      expect((await db.getNoteSyncInfo("note-1")).syncStatus).toBe("local");
    });
  });

  describe("crud.clear", () => {
    it("should remove all notes", async () => {
      await noteService.crud.add(makeNote({ id: "n1" }));
      await noteService.crud.add(makeNote({ id: "n2" }));
      const result = await noteService.crud.clear();
      expect(result).toBe(true);
      const notes = await noteService.getNotes();
      expect(notes).toEqual([]);
      // Verify via DB directly
      const dbNotes = await db.getAllNotes();
      expect(dbNotes).toEqual([]);
    });
  });

  // NoteIntentSubservice

  describe("intent.newNoteWithText", () => {
    it("should create a note with a text entry", async () => {
      await noteService.intent.newNoteWithText({ text: "Hello world" });
      const notes = await noteService.getNotes();
      expect(notes).toHaveLength(1);
      expect(notes[0].entries).toHaveLength(1);
      expect(notes[0].entries[0].type).toBe("text");
    });
  });

  describe("entry.getNewPhotoEntry source", () => {
    it("defaults source to 'camera' when none given", () => {
      const entry = noteService.entry.getNewPhotoEntry();
      expect(entry.type).toBe("photo");
      expect((entry.params as { source?: string }).source).toBe("camera");
    });

    it("tags the entry with source='gallery' when requested", () => {
      const entry = noteService.entry.getNewPhotoEntry("gallery");
      expect(entry.type).toBe("photo");
      expect((entry.params as { source?: string }).source).toBe("gallery");
    });
  });

  describe("intent.newNoteWithImage", () => {
    it("should create a note with a photo entry", async () => {
      await noteService.intent.newNoteWithImage({ url: "/path/to/img.jpg" });
      const notes = await noteService.getNotes();
      expect(notes).toHaveLength(1);
      expect(notes[0].entries).toHaveLength(1);
      expect(notes[0].entries[0].type).toBe("photo");
    });
  });

  describe("intent.newNoteWithVideo", () => {
    it("should create a note with a video entry", async () => {
      await noteService.intent.newNoteWithVideo({ url: "/path/to/vid.mp4" });
      const notes = await noteService.getNotes();
      expect(notes).toHaveLength(1);
      expect(notes[0].entries).toHaveLength(1);
      expect(notes[0].entries[0].type).toBe("video");
    });
  });

  // ── Eisenhower Matrix priority ─────────────────────────────────────────────

  describe("Eisenhower Matrix priority (Note.priority field)", () => {
    it("getNewNote returns note without priority set", () => {
      const note = noteService.getNewNote("test-id");
      expect(note.priority).toBeUndefined();
    });

    it("persists priority when adding a note", async () => {
      await noteService.crud.add(makeNote({ priority: 1 }));
      const notes = await noteService.getNotes();
      expect(notes[0].priority).toBe(1);
    });

    it("persists all four quadrant values (1–4)", async () => {
      for (const p of [1, 2, 3, 4] as const) {
        await noteService.crud.add(makeNote({ id: `note-${p}`, priority: p }));
      }
      const notes = await noteService.getNotes();
      const priorities = notes.map((n) => n.priority).sort();
      expect(priorities).toEqual([1, 2, 3, 4]);
    });

    it("updates priority via crud.edit", async () => {
      await noteService.crud.add(makeNote({ priority: 1 }));
      await noteService.crud.edit("note-1", makeNote({ priority: 3 }));
      const notes = await noteService.getNotes();
      expect(notes[0].priority).toBe(3);
    });

    it("clears priority by editing to undefined", async () => {
      await noteService.crud.add(makeNote({ priority: 2 }));
      const updated = makeNote();
      delete updated.priority;
      await noteService.crud.edit("note-1", updated);
      const notes = await noteService.getNotes();
      expect(notes[0].priority).toBeUndefined();
    });

    it("notes without priority coexist with prioritised notes", async () => {
      await noteService.crud.add(makeNote({ id: "n1", priority: 1 }));
      await noteService.crud.add(makeNote({ id: "n2" }));
      const notes = await noteService.getNotes();
      expect(notes.find((n) => n.id === "n1")!.priority).toBe(1);
      expect(notes.find((n) => n.id === "n2")!.priority).toBeUndefined();
    });
  });
});
