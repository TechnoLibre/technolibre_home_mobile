import {
  CapacitorSQLite,
  SQLiteConnection,
} from "@capacitor-community/sqlite";
import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";
import { Application } from "../models/application";
import { Note, NoteEntry } from "../models/note";
import { StorageConstants } from "../constants/storage";

const DB_NAME = "erplibre_mobile";

export class DatabaseService {
  private sqlite: SQLiteConnection;
  private db: any;

  constructor() {
    this.sqlite = new SQLiteConnection(CapacitorSQLite);
  }

  async initialize(onStep?: (msg: string) => void): Promise<void> {
    const step = (msg: string) => {
      console.log(`[db] ${msg}`);
      onStep?.(msg);
    };

    step("Lecture clé SecureStorage…");
    const encryptionKey = await this.getOrCreateEncryptionKey();

    step("setEncryptionSecret…");
    await this.sqlite.setEncryptionSecret(encryptionKey);

    step("checkConnectionsConsistency…");
    await this.sqlite.checkConnectionsConsistency();

    step("isConnection…");
    const isConn = (await this.sqlite.isConnection(DB_NAME, false)).result;
    step(`isConn = ${isConn}`);

    if (isConn) {
      step("retrieveConnection…");
      this.db = await this.sqlite.retrieveConnection(DB_NAME, false);
    } else {
      step("createConnection…");
      this.db = await this.sqlite.createConnection(
        DB_NAME,
        true,
        "secret",
        1,
        false
      );
    }

    step("db.open…");
    await this.db.open();

    step("createTables…");
    await this.createTables();

    step("initialize() terminé ✓");
  }

  private async getOrCreateEncryptionKey(): Promise<string> {
    try {
      const result = await SecureStoragePlugin.get({
        key: StorageConstants.DB_ENCRYPTION_KEY,
      });
      return result.value;
    } catch {
      const bytes = new Uint8Array(32);
      globalThis.crypto.getRandomValues(bytes);
      const key = Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      await SecureStoragePlugin.set({
        key: StorageConstants.DB_ENCRYPTION_KEY,
        value: key,
      });
      return key;
    }
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

  async getDbSize(): Promise<{ pageCount: number; pageSize: number; totalBytes: number }> {
    const [pcResult, psResult] = await Promise.all([
      this.db.query("PRAGMA page_count"),
      this.db.query("PRAGMA page_size"),
    ]);
    const pageCount: number = pcResult.values?.[0]?.page_count ?? 0;
    const pageSize: number = psResult.values?.[0]?.page_size ?? 0;
    return { pageCount, pageSize, totalBytes: pageCount * pageSize };
  }

  async getTablesInfo(): Promise<{ name: string; count: number }[]> {
    const result = await this.db.query(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    );
    const tables: string[] = (result.values || []).map((row: any) => row.name);

    return Promise.all(
      tables.map(async (name) => {
        const countResult = await this.db.query(
          `SELECT COUNT(*) as count FROM "${name}"`
        );
        const count = countResult.values?.[0]?.count ?? 0;
        return { name, count };
      })
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
