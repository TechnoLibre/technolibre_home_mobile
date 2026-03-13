import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseService } from "../services/databaseService";
import { Application } from "../models/application";
import { Note } from "../models/note";

describe("DatabaseService", () => {
  let db: DatabaseService;

  beforeEach(async () => {
    db = new DatabaseService();
    await db.initialize();
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
});
