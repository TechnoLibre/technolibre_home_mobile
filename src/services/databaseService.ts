import {
  CapacitorSQLite,
  SQLiteConnection,
} from "@capacitor-community/sqlite";
import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";
import { Application } from "../models/application";
import { Note, NoteEntry } from "../models/note";
import { Tag } from "../models/tag";
import { Reminder } from "../models/reminder";
import { Server } from "../models/server";
import { Workspace } from "../models/workspace";
import type { ProcessRecord, ProcessType, ProcessStatus } from "../models/process";
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

  // Servers

  async createServersTable(): Promise<void> {
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS servers (
        host         TEXT NOT NULL,
        port         INTEGER NOT NULL DEFAULT 22,
        username     TEXT NOT NULL,
        auth_type    TEXT NOT NULL DEFAULT 'password',
        password     TEXT NOT NULL DEFAULT '',
        private_key  TEXT NOT NULL DEFAULT '',
        passphrase   TEXT NOT NULL DEFAULT '',
        label        TEXT NOT NULL DEFAULT '',
        deploy_path  TEXT NOT NULL DEFAULT '~/erplibre',
        PRIMARY KEY (host, username)
      )
    `);
  }

  async getAllServers(): Promise<Server[]> {
    const result = await this.db.query("SELECT * FROM servers");
    return (result.values ?? []).map((row: any) => this.rowToServer(row));
  }

  async addServer(server: Server): Promise<void> {
    await this.db.run(
      `INSERT INTO servers
        (host, port, username, auth_type, password, private_key, passphrase, label, deploy_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        server.host,
        server.port ?? 22,
        server.username,
        server.authType ?? "password",
        server.password ?? "",
        server.privateKey ?? "",
        server.passphrase ?? "",
        server.label ?? "",
        server.deployPath ?? "~/erplibre",
      ]
    );
  }

  async deleteServer(host: string, username: string): Promise<void> {
    await this.db.run(
      "DELETE FROM servers WHERE host = ? AND username = ?",
      [host, username]
    );
  }

  async updateServer(host: string, username: string, server: Server): Promise<void> {
    await this.db.run(
      `UPDATE servers SET
        host = ?, port = ?, username = ?, auth_type = ?,
        password = ?, private_key = ?, passphrase = ?, label = ?, deploy_path = ?
       WHERE host = ? AND username = ?`,
      [
        server.host,
        server.port ?? 22,
        server.username,
        server.authType ?? "password",
        server.password ?? "",
        server.privateKey ?? "",
        server.passphrase ?? "",
        server.label ?? "",
        server.deployPath ?? "~/erplibre",
        host,
        username,
      ]
    );
  }

  private rowToServer(row: any): Server {
    return {
      host: row.host,
      port: row.port ?? 22,
      username: row.username,
      authType: row.auth_type === "key" ? "key" : "password",
      password: row.password ?? "",
      privateKey: row.private_key ?? "",
      passphrase: row.passphrase ?? "",
      label: row.label ?? "",
      deployPath: row.deploy_path ?? "~/erplibre",
    };
  }

  // Workspaces

  async createServerWorkspacesTable(): Promise<void> {
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS server_workspaces (
        host     TEXT NOT NULL,
        username TEXT NOT NULL,
        path     TEXT NOT NULL,
        PRIMARY KEY (host, username, path)
      )
    `);
  }

  async getWorkspacesForServer(host: string, username: string): Promise<Workspace[]> {
    const result = await this.db.query(
      "SELECT * FROM server_workspaces WHERE host = ? AND username = ? ORDER BY path",
      [host, username]
    );
    return (result.values ?? []).map((row: any) => ({
      host: row.host,
      username: row.username,
      path: row.path,
    }));
  }

  async addWorkspace(workspace: Workspace): Promise<void> {
    await this.db.run(
      "INSERT OR IGNORE INTO server_workspaces (host, username, path) VALUES (?, ?, ?)",
      [workspace.host, workspace.username, workspace.path]
    );
  }

  async deleteWorkspace(workspace: Workspace): Promise<void> {
    await this.db.run(
      "DELETE FROM server_workspaces WHERE host = ? AND username = ? AND path = ?",
      [workspace.host, workspace.username, workspace.path]
    );
  }

  async workspaceExists(workspace: Workspace): Promise<boolean> {
    const result = await this.db.query(
      "SELECT 1 FROM server_workspaces WHERE host = ? AND username = ? AND path = ?",
      [workspace.host, workspace.username, workspace.path]
    );
    return (result.values ?? []).length > 0;
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
      "INSERT INTO notes (id, title, date, done, archived, pinned, tags, entries, priority) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        note.id,
        note.title,
        note.date ?? null,
        note.done ? 1 : 0,
        note.archived ? 1 : 0,
        note.pinned ? 1 : 0,
        JSON.stringify(note.tags),
        JSON.stringify(note.entries),
        note.priority ?? null,
      ]
    );
  }

  async deleteNote(id: string): Promise<void> {
    await this.db.run("DELETE FROM notes WHERE id = ?", [id]);
  }

  async updateNote(id: string, note: Note): Promise<void> {
    await this.db.run(
      "UPDATE notes SET title = ?, date = ?, done = ?, archived = ?, pinned = ?, tags = ?, entries = ?, priority = ? WHERE id = ?",
      [
        note.title,
        note.date ?? null,
        note.done ? 1 : 0,
        note.archived ? 1 : 0,
        note.pinned ? 1 : 0,
        JSON.stringify(note.tags),
        JSON.stringify(note.entries),
        note.priority ?? null,
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

  async addSyncPerServerStatusColumn(): Promise<void> {
    const existing = await this.db.query("PRAGMA table_info(notes)");
    const existingNames = (existing.values ?? []).map((r: any) => r.name as string);
    if (!existingNames.includes("sync_per_server_status")) {
      await this.db.execute(`ALTER TABLE notes ADD COLUMN sync_per_server_status TEXT`);
    }
  }

  async addCreatedAtToReminders(): Promise<void> {
    const existing = await this.db.query("PRAGMA table_info(reminders)");
    const existingNames = (existing.values ?? []).map((r: any) => r.name as string);
    if (!existingNames.includes("created_at")) {
      await this.db.execute(`ALTER TABLE reminders ADD COLUMN created_at TEXT`);
    }
  }

  async addPriorityToNotes(): Promise<void> {
    const existing = await this.db.query("PRAGMA table_info(notes)");
    const existingNames = (existing.values ?? []).map((r: any) => r.name as string);
    if (!existingNames.includes("priority")) {
      await this.db.execute(`ALTER TABLE notes ADD COLUMN priority INTEGER`);
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

  async getNoteSyncCounts(): Promise<Record<string, { synced: number; error: number }>> {
    const result = await this.db.query(
      "SELECT id, sync_per_server_status FROM notes WHERE sync_per_server_status IS NOT NULL"
    );
    const counts: Record<string, { synced: number; error: number }> = {};
    for (const row of result.values ?? []) {
      if (!row.sync_per_server_status) continue;
      try {
        const perServer: Record<string, string> = JSON.parse(row.sync_per_server_status);
        let synced = 0, error = 0;
        for (const status of Object.values(perServer)) {
          if (status === "synced") synced++;
          else if (status === "error") error++;
        }
        if (synced > 0 || error > 0) counts[row.id] = { synced, error };
      } catch { /* ignore */ }
    }
    return counts;
  }

  async setNotePerServerStatus(
    noteId: string,
    syncConfigId: string,
    status: "synced" | "error"
  ): Promise<void> {
    const result = await this.db.query(
      "SELECT sync_per_server_status FROM notes WHERE id = ?",
      [noteId]
    );
    const row = result.values?.[0];
    let perServer: Record<string, string> = {};
    if (row?.sync_per_server_status) {
      try { perServer = JSON.parse(row.sync_per_server_status); } catch { /* ignore */ }
    }
    perServer[syncConfigId] = status;
    await this.db.run(
      "UPDATE notes SET sync_per_server_status = ? WHERE id = ?",
      [JSON.stringify(perServer), noteId]
    );
  }

  async getNoteRawData(noteId: string): Promise<Record<string, any> | null> {
    const result = await this.db.query("SELECT * FROM notes WHERE id = ?", [noteId]);
    return result.values?.[0] ?? null;
  }

  async getTableColumns(tableName: string): Promise<{ cid: number; name: string; type: string; notnull: number; dflt_value: any; pk: number }[]> {
    const result = await this.db.query(`PRAGMA table_info("${tableName}")`);
    return result.values ?? [];
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

  // Processes

  async createProcessesTable(): Promise<void> {
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS processes (
        id            TEXT PRIMARY KEY,
        type          TEXT NOT NULL,
        status        TEXT NOT NULL DEFAULT 'running',
        label         TEXT NOT NULL DEFAULT '',
        started_at    INTEGER NOT NULL,
        completed_at  INTEGER,
        error_message TEXT,
        note_id       TEXT,
        model         TEXT,
        result        TEXT,
        debug_log     TEXT
      )
    `);
  }

  async addResultColumnToProcesses(): Promise<void> {
    const existing = await this.db.query("PRAGMA table_info(processes)");
    const existingNames = (existing.values ?? []).map((r: any) => r.name as string);
    if (!existingNames.includes("result")) {
      await this.db.execute("ALTER TABLE processes ADD COLUMN result TEXT");
    }
  }

  async addDebugLogColumnToProcesses(): Promise<void> {
    const existing = await this.db.query("PRAGMA table_info(processes)");
    const existingNames = (existing.values ?? []).map((r: any) => r.name as string);
    if (!existingNames.includes("debug_log")) {
      await this.db.execute("ALTER TABLE processes ADD COLUMN debug_log TEXT");
    }
  }

  async deleteAllProcesses(): Promise<void> {
    await this.db.run("DELETE FROM processes");
  }

  async getAllProcesses(): Promise<ProcessRecord[]> {
    const result = await this.db.query(
      "SELECT * FROM processes ORDER BY started_at ASC"
    );
    return (result.values ?? []).map((row: any) => this.rowToProcess(row));
  }

  async insertProcess(record: ProcessRecord): Promise<void> {
    await this.db.run(
      `INSERT INTO processes
         (id, type, status, label, started_at, completed_at, error_message, note_id, model, result)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.type,
        record.status,
        record.label,
        record.startedAt.getTime(),
        record.completedAt ? record.completedAt.getTime() : null,
        record.errorMessage ?? null,
        record.noteId ?? null,
        record.model ?? null,
        record.result ?? null,
      ]
    );
  }

  async updateProcessStatus(
    id: string,
    status: ProcessStatus,
    completedAt: Date | null,
    errorMessage: string | null,
    result?: string,
    debugLog?: string[]
  ): Promise<void> {
    const debugLogJson = debugLog && debugLog.length > 0
      ? JSON.stringify(debugLog)
      : null;
    await this.db.run(
      `UPDATE processes
         SET status = ?, completed_at = ?, error_message = ?, result = ?, debug_log = ?
       WHERE id = ?`,
      [status, completedAt ? completedAt.getTime() : null, errorMessage ?? null, result ?? null, debugLogJson, id]
    );
  }

  /** Mark every process still flagged "running" as interrupted (app restarted). */
  async markInterruptedProcesses(): Promise<void> {
    await this.db.run(
      `UPDATE processes
         SET status = 'error',
             error_message = 'Interrompu (redémarrage)',
             completed_at = ?
       WHERE status = 'running'`,
      [Date.now()]
    );
  }

  private rowToProcess(row: any): ProcessRecord {
    let debugLog: string[] | undefined;
    if (row.debug_log) {
      try { debugLog = JSON.parse(row.debug_log); } catch { debugLog = undefined; }
    }
    return {
      id:           row.id,
      type:         row.type as ProcessType,
      status:       row.status as ProcessStatus,
      label:        row.label,
      startedAt:    new Date(Number(row.started_at)),
      completedAt:  row.completed_at != null ? new Date(Number(row.completed_at)) : null,
      errorMessage: row.error_message ?? null,
      noteId:       row.note_id ?? undefined,
      model:        row.model ?? undefined,
      result:       row.result ?? undefined,
      debugLog,
    };
  }

  // Tags

  async createTagsTable(): Promise<void> {
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS tags (
        id        TEXT PRIMARY KEY NOT NULL,
        name      TEXT NOT NULL,
        color     TEXT NOT NULL DEFAULT '#6b7280',
        parent_id TEXT
      )
    `);
  }

  async getAllTags(): Promise<Tag[]> {
    const result = await this.db.query("SELECT * FROM tags ORDER BY name");
    return (result.values ?? []).map((row: any) => this.rowToTag(row));
  }

  async getTagById(id: string): Promise<Tag | null> {
    const result = await this.db.query("SELECT * FROM tags WHERE id = ?", [id]);
    const row = result.values?.[0];
    return row ? this.rowToTag(row) : null;
  }

  async addTag(tag: Tag): Promise<void> {
    await this.db.run(
      "INSERT INTO tags (id, name, color, parent_id) VALUES (?, ?, ?, ?)",
      [tag.id, tag.name, tag.color, tag.parentId ?? null]
    );
  }

  async updateTag(id: string, tag: Tag): Promise<void> {
    await this.db.run(
      "UPDATE tags SET name = ?, color = ?, parent_id = ? WHERE id = ?",
      [tag.name, tag.color, tag.parentId ?? null, id]
    );
  }

  async deleteTag(id: string): Promise<void> {
    await this.db.run("DELETE FROM tags WHERE id = ?", [id]);
  }

  private rowToTag(row: any): Tag {
    return {
      id: row.id,
      name: row.name,
      color: row.color ?? "#6b7280",
      parentId: row.parent_id ?? undefined,
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
      priority: row.priority != null ? (row.priority as 1 | 2 | 3 | 4) : undefined,
      tags: typeof row.tags === "string" ? JSON.parse(row.tags) : row.tags,
      entries:
        typeof row.entries === "string"
          ? JSON.parse(row.entries)
          : row.entries,
    };
  }
}
