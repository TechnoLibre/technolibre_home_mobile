import {
  CapacitorSQLite,
  SQLiteConnection,
} from "@capacitor-community/sqlite";
import { Application } from "../models/application";
import { Note, NoteEntry } from "../models/note";

const DB_NAME = "erplibre_mobile";

export class DatabaseService {
  private sqlite: SQLiteConnection;
  private db: any;

  constructor() {
    this.sqlite = new SQLiteConnection(CapacitorSQLite);
  }

  async initialize(): Promise<void> {
    this.db = await this.sqlite.createConnection(
      DB_NAME,
      false,
      "no-encryption",
      1,
      false
    );
    await this.db.open();
    await this.createTables();
  }

  private async createTables(): Promise<void> {
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS applications (
        url TEXT NOT NULL,
        username TEXT NOT NULL,
        password TEXT NOT NULL,
        PRIMARY KEY (url, username)
      )
    `);

    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL,
        date TEXT,
        done INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        pinned INTEGER NOT NULL DEFAULT 0,
        tags TEXT NOT NULL DEFAULT '[]',
        entries TEXT NOT NULL DEFAULT '[]'
      )
    `);
  }

  // Applications

  async getAllApplications(): Promise<Application[]> {
    const result = await this.db.query("SELECT * FROM applications");
    return result.values || [];
  }

  async addApplication(app: Application): Promise<void> {
    await this.db.run(
      "INSERT INTO applications (url, username, password) VALUES (?, ?, ?)",
      [app.url, app.username, app.password]
    );
  }

  async deleteApplication(url: string, username: string): Promise<void> {
    await this.db.run(
      "DELETE FROM applications WHERE url = ? AND username = ?",
      [url, username]
    );
  }

  async updateApplication(
    url: string,
    username: string,
    app: Application
  ): Promise<void> {
    await this.db.run(
      "UPDATE applications SET url = ?, username = ?, password = ? WHERE url = ? AND username = ?",
      [app.url, app.username, app.password, url, username]
    );
  }

  // Notes

  async getAllNotes(): Promise<Note[]> {
    const result = await this.db.query("SELECT * FROM notes");
    const rows = result.values || [];
    return rows.map((row: any) => this.rowToNote(row));
  }

  async addNote(note: Note): Promise<void> {
    await this.db.run(
      "INSERT INTO notes (id, title, date, done, archived, pinned, tags, entries) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        note.id,
        note.title,
        note.date ?? null,
        note.done ? 1 : 0,
        note.archived ? 1 : 0,
        note.pinned ? 1 : 0,
        JSON.stringify(note.tags),
        JSON.stringify(note.entries),
      ]
    );
  }

  async deleteNote(id: string): Promise<void> {
    await this.db.run("DELETE FROM notes WHERE id = ?", [id]);
  }

  async updateNote(id: string, note: Note): Promise<void> {
    await this.db.run(
      "UPDATE notes SET title = ?, date = ?, done = ?, archived = ?, pinned = ?, tags = ?, entries = ? WHERE id = ?",
      [
        note.title,
        note.date ?? null,
        note.done ? 1 : 0,
        note.archived ? 1 : 0,
        note.pinned ? 1 : 0,
        JSON.stringify(note.tags),
        JSON.stringify(note.entries),
        id,
      ]
    );
  }

  private rowToNote(row: any): Note {
    return {
      id: row.id,
      title: row.title,
      date: row.date ?? undefined,
      done: row.done === 1 || row.done === true,
      archived: row.archived === 1 || row.archived === true,
      pinned: row.pinned === 1 || row.pinned === true,
      tags: typeof row.tags === "string" ? JSON.parse(row.tags) : row.tags,
      entries:
        typeof row.entries === "string"
          ? JSON.parse(row.entries)
          : row.entries,
    };
  }
}
