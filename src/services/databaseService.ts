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

    if (encryptionKey.isNew) {
      step("setEncryptionSecret…");
      await this.sqlite.setEncryptionSecret(encryptionKey.key);
    } else {
      step("setEncryptionSecret ignoré (clé existante)…");
    }

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

  private async getOrCreateEncryptionKey(): Promise<{ key: string; isNew: boolean }> {
    try {
      const result = await SecureStoragePlugin.get({
        key: StorageConstants.DB_ENCRYPTION_KEY,
      });
      return { key: result.value, isNew: false };
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
      return { key, isNew: true };
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

  async getDbSize(): Promise<{ pageCount: number; pageSize: number; totalBytes: number; diagnostics: string[] }> {
    const diagnostics: string[] = [];
    let pageCount = 0;
    let pageSize = 0;
    let totalBytes = 0;

    // Try dbstat virtual table first (most accurate, per-table breakdown)
    try {
      const result = await this.db.query(
        "SELECT name, SUM(pgsize) as bytes FROM dbstat GROUP BY name ORDER BY bytes DESC"
      );
      const rows: { name: string; bytes: number }[] = result.values ?? [];
      if (rows.length > 0) {
        const dbstatTotal = rows.reduce((sum, r) => sum + Number(r.bytes), 0);
        totalBytes = dbstatTotal;
        diagnostics.push(`dbstat total : ${dbstatTotal} octets`);
        for (const row of rows) {
          diagnostics.push(`  ${row.name} : ${Number(row.bytes)} octets`);
        }
      } else {
        diagnostics.push(`dbstat : 0 lignes (table vide ou indisponible)`);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      diagnostics.push(`✗ dbstat : ${msg}`);
    }

    // PRAGMA page_count * page_size as cross-check
    try {
      const [pcResult, psResult] = await Promise.all([
        this.db.query("PRAGMA page_count"),
        this.db.query("PRAGMA page_size"),
      ]);
      // Column name varies across SQLCipher builds — check both forms
      const pcRow = pcResult.values?.[0] ?? {};
      const psRow = psResult.values?.[0] ?? {};
      pageCount = pcRow.page_count ?? pcRow["page_count"] ?? Number(Object.values(pcRow)[0]) ?? 0;
      pageSize = psRow.page_size ?? psRow["page_size"] ?? Number(Object.values(psRow)[0]) ?? 0;
      const pragmaBytes = pageCount * pageSize;
      if (totalBytes === 0 && pragmaBytes > 0) totalBytes = pragmaBytes;
      diagnostics.push(`PRAGMA page_count=${pageCount}, page_size=${pageSize} → ${pragmaBytes} octets`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      diagnostics.push(`✗ PRAGMA : ${msg}`);
    }

    return { pageCount, pageSize, totalBytes, diagnostics };
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
