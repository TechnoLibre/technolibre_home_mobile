import {
  CapacitorSQLite,
  SQLiteConnection,
} from "@capacitor-community/sqlite";
import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";
import { Application } from "../models/application";
import { Note, NoteEntry } from "../models/note";
import { Reminder } from "../models/reminder";
import { StorageConstants } from "../constants/storage";

export type SyncStatus = "local" | "pending" | "synced" | "conflict" | "error";

export interface NoteSyncInfo {
  odooId: number | null;
  odooUrl: string | null;
  syncStatus: SyncStatus;
  lastSyncedAt: string | null;
  syncConfigId: string | null;
  selectedSyncConfigIds: string[] | null;
}

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

    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS reminders (
        id TEXT PRIMARY KEY NOT NULL,
        message TEXT NOT NULL,
        interval_minutes INTEGER NOT NULL,
        active INTEGER NOT NULL DEFAULT 0,
        scheduled_ids TEXT NOT NULL DEFAULT '[]',
        batch_ends_at TEXT
      )
    `);
  }

  // User Graphic Preferences

  async createUserGraphicPrefsTable(): Promise<void> {
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS user_graphic_prefs (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
  }

  async getUserGraphicPref(key: string): Promise<string | null> {
    const result = await this.db.query(
      "SELECT value FROM user_graphic_prefs WHERE key = ?",
      [key]
    );
    return (result.values?.[0] as any)?.value ?? null;
  }

  async setUserGraphicPref(key: string, value: string): Promise<void> {
    await this.db.run(
      "INSERT OR REPLACE INTO user_graphic_prefs (key, value) VALUES (?, ?)",
      [key, value]
    );
  }

  // Applications

  async addSyncFieldsToApplications(): Promise<void> {
    const existing = await this.db.query("PRAGMA table_info(applications)");
    const existingNames = (existing.values ?? []).map((r: any) => r.name as string);
    const columns: [string, string][] = [
      ["database",              "TEXT NOT NULL DEFAULT ''"],
      ["auto_sync",             "INTEGER NOT NULL DEFAULT 0"],
      ["poll_interval_minutes", "INTEGER NOT NULL DEFAULT 5"],
      ["ntfy_url",              "TEXT NOT NULL DEFAULT ''"],
      ["ntfy_topic",            "TEXT NOT NULL DEFAULT ''"],
    ];
    for (const [col, def] of columns) {
      if (!existingNames.includes(col)) {
        await this.db.execute(`ALTER TABLE applications ADD COLUMN ${col} ${def}`);
      }
    }
  }

  async addOdooVersionToApplications(): Promise<void> {
    const existing = await this.db.query("PRAGMA table_info(applications)");
    const existingNames = (existing.values ?? []).map((r: any) => r.name as string);
    if (!existingNames.includes("odoo_version")) {
      await this.db.execute("ALTER TABLE applications ADD COLUMN odoo_version TEXT NOT NULL DEFAULT ''");
    }
  }

  async getAllApplications(): Promise<Application[]> {
    const result = await this.db.query("SELECT * FROM applications");
    return (result.values ?? []).map((row: any) => this.rowToApplication(row));
  }

  async addApplication(app: Application): Promise<void> {
    await this.db.run(
      `INSERT INTO applications
        (url, username, password, database, odoo_version, auto_sync, poll_interval_minutes, ntfy_url, ntfy_topic)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [app.url, app.username, app.password,
       app.database ?? "", app.odooVersion ?? "",
       app.autoSync ? 1 : 0,
       app.pollIntervalMinutes ?? 5, app.ntfyUrl ?? "", app.ntfyTopic ?? ""]
    );
  }

  async setApplicationOdooVersion(url: string, username: string, version: string): Promise<void> {
    await this.db.run(
      "UPDATE applications SET odoo_version = ? WHERE url = ? AND username = ?",
      [version, url, username]
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
      "UPDATE applications SET url = ?, username = ?, password = ?, database = ?, odoo_version = ?, auto_sync = ?, poll_interval_minutes = ?, ntfy_url = ?, ntfy_topic = ? WHERE url = ? AND username = ?",
      [app.url, app.username, app.password,
       app.database ?? "", app.odooVersion ?? "",
       app.autoSync ? 1 : 0,
       app.pollIntervalMinutes ?? 5, app.ntfyUrl ?? "", app.ntfyTopic ?? "",
       url, username]
    );
  }

  private rowToApplication(row: any): Application {
    return {
      url: row.url,
      username: row.username,
      password: row.password,
      database: row.database ?? "",
      odooVersion: row.odoo_version ?? "",
      autoSync: row.auto_sync === 1 || row.auto_sync === true,
      pollIntervalMinutes: row.poll_interval_minutes ?? 5,
      ntfyUrl: row.ntfy_url ?? "",
      ntfyTopic: row.ntfy_topic ?? "",
    };
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

  // Sync

  async addSyncColumnsToNotes(): Promise<void> {
    const columns = ["odoo_id", "odoo_url", "sync_status", "last_synced_at"];
    const existing = await this.db.query("PRAGMA table_info(notes)");
    const existingNames = (existing.values ?? []).map((r: any) => r.name as string);
    for (const col of columns) {
      if (existingNames.includes(col)) continue;
      if (col === "odoo_id") {
        await this.db.execute(`ALTER TABLE notes ADD COLUMN odoo_id INTEGER`);
      } else if (col === "sync_status") {
        await this.db.execute(`ALTER TABLE notes ADD COLUMN sync_status TEXT NOT NULL DEFAULT 'local'`);
      } else {
        await this.db.execute(`ALTER TABLE notes ADD COLUMN ${col} TEXT`);
      }
    }
  }

  async addSyncConfigIdColumn(): Promise<void> {
    const existing = await this.db.query("PRAGMA table_info(notes)");
    const existingNames = (existing.values ?? []).map((r: any) => r.name as string);
    if (!existingNames.includes("sync_config_id")) {
      await this.db.execute(`ALTER TABLE notes ADD COLUMN sync_config_id TEXT`);
    }
  }

  async addSelectedSyncConfigIdsColumn(): Promise<void> {
    const existing = await this.db.query("PRAGMA table_info(notes)");
    const existingNames = (existing.values ?? []).map((r: any) => r.name as string);
    if (!existingNames.includes("selected_sync_config_ids")) {
      await this.db.execute(`ALTER TABLE notes ADD COLUMN selected_sync_config_ids TEXT`);
    }
  }

  async addCreatedAtToReminders(): Promise<void> {
    const existing = await this.db.query("PRAGMA table_info(reminders)");
    const existingNames = (existing.values ?? []).map((r: any) => r.name as string);
    if (!existingNames.includes("created_at")) {
      await this.db.execute(`ALTER TABLE reminders ADD COLUMN created_at TEXT`);
    }
  }

  async getNoteSyncInfo(noteId: string): Promise<NoteSyncInfo> {
    const result = await this.db.query(
      "SELECT odoo_id, odoo_url, sync_status, last_synced_at, sync_config_id, selected_sync_config_ids FROM notes WHERE id = ?",
      [noteId]
    );
    const row = result.values?.[0];
    if (!row) return { odooId: null, odooUrl: null, syncStatus: "local", lastSyncedAt: null, syncConfigId: null, selectedSyncConfigIds: null };
    let selectedSyncConfigIds: string[] | null = null;
    if (row.selected_sync_config_ids) {
      try { selectedSyncConfigIds = JSON.parse(row.selected_sync_config_ids); } catch { /* ignore */ }
    }
    return {
      odooId: row.odoo_id ?? null,
      odooUrl: row.odoo_url ?? null,
      syncStatus: (row.sync_status as SyncStatus) ?? "local",
      lastSyncedAt: row.last_synced_at ?? null,
      syncConfigId: row.sync_config_id ?? null,
      selectedSyncConfigIds,
    };
  }

  async setNoteSyncInfo(noteId: string, info: Partial<NoteSyncInfo>): Promise<void> {
    const fields: string[] = [];
    const values: any[] = [];
    if (info.odooId !== undefined) { fields.push("odoo_id = ?"); values.push(info.odooId); }
    if (info.odooUrl !== undefined) { fields.push("odoo_url = ?"); values.push(info.odooUrl); }
    if (info.syncStatus !== undefined) { fields.push("sync_status = ?"); values.push(info.syncStatus); }
    if (info.lastSyncedAt !== undefined) { fields.push("last_synced_at = ?"); values.push(info.lastSyncedAt); }
    if (info.syncConfigId !== undefined) { fields.push("sync_config_id = ?"); values.push(info.syncConfigId); }
    if (info.selectedSyncConfigIds !== undefined) {
      fields.push("selected_sync_config_ids = ?");
      values.push(info.selectedSyncConfigIds !== null ? JSON.stringify(info.selectedSyncConfigIds) : null);
    }
    if (fields.length === 0) return;
    values.push(noteId);
    await this.db.run(`UPDATE notes SET ${fields.join(", ")} WHERE id = ?`, values);
  }

  async getNotesBySyncConfigId(syncConfigId: string): Promise<Array<Note & { syncInfo: NoteSyncInfo }>> {
    const result = await this.db.query(
      "SELECT * FROM notes WHERE sync_config_id = ?",
      [syncConfigId]
    );
    return (result.values ?? []).map((row: any) => ({
      ...this.rowToNote(row),
      syncInfo: this.rowToSyncInfo(row),
    }));
  }

  async getNoteById(id: string): Promise<Note | null> {
    const result = await this.db.query("SELECT * FROM notes WHERE id = ?", [id]);
    const row = result.values?.[0];
    return row ? this.rowToNote(row) : null;
  }

  async getNotesByOdooUrl(odooUrl: string): Promise<Array<Note & { syncInfo: NoteSyncInfo }>> {
    const result = await this.db.query(
      "SELECT * FROM notes WHERE odoo_url = ?",
      [odooUrl]
    );
    return (result.values ?? []).map((row: any) => ({
      ...this.rowToNote(row),
      syncInfo: this.rowToSyncInfo(row),
    }));
  }

  private rowToSyncInfo(row: any): NoteSyncInfo {
    return {
      odooId: row.odoo_id ?? null,
      odooUrl: row.odoo_url ?? null,
      syncStatus: (row.sync_status as SyncStatus) ?? "local",
      lastSyncedAt: row.last_synced_at ?? null,
      syncConfigId: row.sync_config_id ?? null,
    };
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

  // Reminders

  async getAllReminders(): Promise<Reminder[]> {
    const result = await this.db.query("SELECT * FROM reminders");
    return (result.values ?? []).map((row: any) => this.rowToReminder(row));
  }

  async upsertReminder(reminder: Reminder): Promise<void> {
    await this.db.run(
      `INSERT OR REPLACE INTO reminders
        (id, message, interval_minutes, active, scheduled_ids, batch_ends_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        reminder.id,
        reminder.message,
        reminder.intervalMinutes,
        reminder.active ? 1 : 0,
        JSON.stringify(reminder.scheduledIds),
        reminder.batchEndsAt ?? null,
        reminder.createdAt,
      ]
    );
  }

  async deleteReminder(id: string): Promise<void> {
    await this.db.run("DELETE FROM reminders WHERE id = ?", [id]);
  }

  private rowToReminder(row: any): Reminder {
    return {
      id: row.id,
      message: row.message,
      intervalMinutes: row.interval_minutes,
      active: row.active === 1 || row.active === true,
      scheduledIds:
        typeof row.scheduled_ids === "string"
          ? JSON.parse(row.scheduled_ids)
          : (row.scheduled_ids ?? []),
      batchEndsAt: row.batch_ends_at ?? null,
      createdAt: row.created_at ?? new Date().toISOString(),
    };
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
