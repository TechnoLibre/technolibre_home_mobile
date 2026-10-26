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
import { encryptCredential, decryptCredential } from "../utils/cryptoUtils";
import { sameServerUrl, syncConfigIdFor } from "../models/syncConfig";

export type SyncStatus = "local" | "pending" | "synced" | "conflict" | "error";

/** Status of a note on ONE server, stored in notes.sync_per_server_status. */
/**
 * A note's state on one server: synced; pending (something to send);
 * error (the last push failed); conflict (a record of it changed in the
 * app and on the server, the user must choose; nothing is sent meanwhile).
 */
export type PerServerSyncStatus = "synced" | "error" | "pending" | "conflict";

/**
 * How a note is bound to a remote record. "create": the note created the
 * record and is mirrored by it (push writes, pull reads back). "activity":
 * a mail.activity the note scheduled on another record; "message": a
 * mail.message the note posted in another record's chatter. A note can
 * have several of these two on one server, each with its own link.
 */
export type NoteLinkKind = "create" | "activity" | "message";

/**
 * One remote record a note is bound to. A remote id is only meaningful in
 * the database it came from, so a link is scoped to a sync config id
 * ("url|username|database", see syncConfigIdFor).
 */
export interface NoteLink {
  id: string;
  noteId: string;
  configId: string;
  model: string;
  resId: number;
  kind: NoteLinkKind;
  /**
   * ok: the record exists; deleted: deleted on the server, the user not
   * asked yet or declined; dismissed: deleted, and the user stopped sending
   * the note there as that kind (kept as history, never pushed); done: an
   * activity the app marked done (the server removed or archived it).
   * Only ok links are written; the others stay as a trace.
   */
  remoteState: NoteLinkRemoteState;
  createdAt: string;
  lastSyncedAt: string | null;
  /**
   * Key written in the remote record as "erplibre-mobile:<uuid>" when the
   * app created it; null for records linked before the key existed.
   */
  clientUuid?: string | null;
  /**
   * What the link stands for beyond its record, stored as JSON: for an
   * activity, the record it is scheduled on and its type, deadline and
   * user (see ActivityTarget); for a message, its record and the hash of
   * the body last sent (bodyHash). Empty for a "create" link.
   */
  params?: Record<string, any>;
}

/**
 * One activity of a server shown by the activity calendar, as last read
 * (see ActivityCalendarService): the record it is on, its type, summary,
 * deadline ("YYYY-MM-DD") and user; done (archived on Odoo 17+, with
 * dateDone) or open. pending: a change made in the app (done, new
 * deadline) still waiting in the outbox for the server.
 */
export interface CalendarActivity {
  configId: string;
  resId: number;
  resModel: string;
  recordId: number;
  recordName: string;
  typeId: number | null;
  typeName: string | null;
  summary: string;
  deadline: string;
  userId: number | null;
  userName: string | null;
  done: boolean;
  dateDone: string | null;
  pending: boolean;
  /** Why the server refused the last change made in the app, undone since. */
  lastError?: string | null;
  fetchedAt: string;
}

export type NoteLinkRemoteState = "ok" | "deleted" | "dismissed" | "done";

const NOTE_LINK_REMOTE_STATES: NoteLinkRemoteState[] = ["ok", "deleted", "dismissed", "done"];

/**
 * State of an outbox operation:
 * - queued: waits for its first run;
 * - running: a run is in progress, or was cut short (app killed), in
 *   which case the server may have applied it: attempts > 0 tells the
 *   handler to look for its client_uuid before acting again;
 * - failed: the last run failed, retried once next_attempt_at is past;
 * - blocked: the server refused it for a reason a retry does not fix
 *   (model gone, access, ambiguous match), waits for the user;
 * - incomplete: saved before every choice was made (record not picked
 *   offline), waits for the user.
 */
export type OutboxStatus = "queued" | "running" | "failed" | "blocked" | "incomplete";

/**
 * One operation of a note waiting to reach one server: a creation, or a
 * one-shot action. client_uuid is generated once and kept across retries;
 * the remote record carries it, so a run whose answer was lost can find
 * what it already did.
 */
export interface OutboxOp {
  id: string;
  clientUuid: string;
  noteId: string;
  configId: string;
  kind: string;
  params: Record<string, any>;
  status: OutboxStatus;
  attempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  /** Id of an operation that must be gone (done) before this one runs. */
  dependsOn: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * What one server allows on one model, as probed by CapabilityService.
 * Access flags are null when the server answered none of the probes.
 */
export interface ServerCapability {
  configId: string;
  model: string;
  exists: boolean;
  canRead: boolean | null;
  canCreate: boolean | null;
  canWrite: boolean | null;
  hasActivities: boolean;
  hasChatter: boolean;
  fields: Record<string, any>;
  odooVersion: number;
  probedAt: string;
  error: string | null;
}

/**
 * A record of a server kept for offline choices (projects, later the
 * records an activity or a message is attached to): its id and name as
 * the server last returned them.
 */
export interface RemoteRecord {
  configId: string;
  model: string;
  resId: number;
  displayName: string;
  extra: Record<string, any>;
  fetchedAt: string;
}

/**
 * The last choice made for one kind of target on one server (the project
 * of a new task, …), offered first the next time.
 */
export interface SyncTargetPref {
  configId: string;
  kind: string;
  params: Record<string, any>;
  updatedAt: string;
}

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
  /**
   * Tail of the read-modify-write chain on each note's
   * sync_per_server_status JSON. Writers queue here, so two writers
   * interleaving across awaits never drop each other's entry.
   */
  private _perServerChain = new Map<string, Promise<unknown>>();

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
    return Promise.all((result.values ?? []).map((row: any) => this.rowToServer(row)));
  }

  async addServer(server: Server): Promise<void> {
    const [encPass, encKey, encPhrase] = await Promise.all([
      encryptCredential(server.password ?? ""),
      encryptCredential(server.privateKey ?? ""),
      encryptCredential(server.passphrase ?? ""),
    ]);
    await this.db.run(
      `INSERT INTO servers
        (host, port, username, auth_type, password, private_key, passphrase, label, deploy_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        server.host,
        server.port ?? 22,
        server.username,
        server.authType ?? "password",
        encPass,
        encKey,
        encPhrase,
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
    const [encPass, encKey, encPhrase] = await Promise.all([
      encryptCredential(server.password ?? ""),
      encryptCredential(server.privateKey ?? ""),
      encryptCredential(server.passphrase ?? ""),
    ]);
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
        encPass,
        encKey,
        encPhrase,
        server.label ?? "",
        server.deployPath ?? "~/erplibre",
        host,
        username,
      ]
    );
  }

  private async rowToServer(row: any): Promise<Server> {
    const [password, privateKey, passphrase] = await Promise.all([
      decryptCredential(row.password ?? ""),
      decryptCredential(row.private_key ?? ""),
      decryptCredential(row.passphrase ?? ""),
    ]);
    return {
      host: row.host,
      port: row.port ?? 22,
      username: row.username,
      authType: row.auth_type === "key" ? "key" : "password",
      password,
      privateKey,
      passphrase,
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

  /** Direct query access for migrations. Returns raw row objects. */
  async rawQuery(sql: string, values?: any[]): Promise<any[]> {
    const result = values
      ? await this.db.query(sql, values)
      : await this.db.query(sql);
    return result.values ?? [];
  }

  /** Direct write access for migrations. */
  async rawRun(sql: string, values: any[] = []): Promise<void> {
    await this.db.run(sql, values);
  }

  async addNtfyTokenColumn(): Promise<void> {
    const existing = await this.db.query("PRAGMA table_info(applications)");
    const existingNames = (existing.values ?? []).map((r: any) => r.name as string);
    if (!existingNames.includes("ntfy_token")) {
      await this.db.execute("ALTER TABLE applications ADD COLUMN ntfy_token TEXT NOT NULL DEFAULT ''");
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
    return Promise.all((result.values ?? []).map((row: any) => this.rowToApplication(row)));
  }

  async addApplication(app: Application): Promise<void> {
    const [encPassword, encToken] = await Promise.all([
      encryptCredential(app.password),
      encryptCredential(app.ntfyToken ?? ""),
    ]);
    await this.db.run(
      `INSERT INTO applications
        (url, username, password, database, odoo_version, auto_sync, poll_interval_minutes, ntfy_url, ntfy_topic, ntfy_token)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [app.url, app.username, encPassword,
       app.database ?? "", app.odooVersion ?? "",
       app.autoSync ? 1 : 0,
       app.pollIntervalMinutes ?? 5, app.ntfyUrl ?? "", app.ntfyTopic ?? "",
       encToken]
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
    const [encPassword, encToken] = await Promise.all([
      encryptCredential(app.password),
      encryptCredential(app.ntfyToken ?? ""),
    ]);
    await this.db.run(
      "UPDATE applications SET url = ?, username = ?, password = ?, database = ?, odoo_version = ?, auto_sync = ?, poll_interval_minutes = ?, ntfy_url = ?, ntfy_topic = ?, ntfy_token = ? WHERE url = ? AND username = ?",
      [app.url, app.username, encPassword,
       app.database ?? "", app.odooVersion ?? "",
       app.autoSync ? 1 : 0,
       app.pollIntervalMinutes ?? 5, app.ntfyUrl ?? "", app.ntfyTopic ?? "",
       encToken,
       url, username]
    );
  }

  private async rowToApplication(row: any): Promise<Application> {
    const [password, ntfyToken] = await Promise.all([
      decryptCredential(row.password ?? ""),
      decryptCredential(row.ntfy_token ?? ""),
    ]);
    return {
      url: row.url,
      username: row.username,
      password,
      database: row.database ?? "",
      odooVersion: row.odoo_version ?? "",
      autoSync: row.auto_sync === 1 || row.auto_sync === true,
      pollIntervalMinutes: row.poll_interval_minutes ?? 5,
      ntfyUrl: row.ntfy_url ?? "",
      ntfyTopic: row.ntfy_topic ?? "",
      ntfyToken,
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
    // Under the note's sync lock: a push settling meanwhile then finds no
    // note and writes no link. Its queued operations go with it; the remote
    // records are left untouched.
    await this.withPerServerLock(id, async () => {
      await this.db.run("DELETE FROM notes WHERE id = ?", [id]);
      await this.deleteNoteLinks(id);
      await this.deleteOutboxOpsForNote(id);
    });
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

  /** Per note, how many live servers are "synced" and how many in "error". */
  async getNoteSyncCounts(): Promise<Record<string, { synced: number; error: number }>> {
    const live = await this.getLiveSyncConfigIds();
    const result = await this.db.query(
      "SELECT id, sync_per_server_status FROM notes WHERE sync_per_server_status IS NOT NULL"
    );
    const counts: Record<string, { synced: number; error: number }> = {};
    for (const row of result.values ?? []) {
      let synced = 0, error = 0;
      for (const [configId, status] of Object.entries(this.parsePerServerStatus(row.sync_per_server_status))) {
        if (!live.has(configId)) continue;
        if (status === "synced") synced++;
        else if (status === "error") error++;
      }
      if (synced > 0 || error > 0) counts[row.id] = { synced, error };
    }
    return counts;
  }

  /** Runs fn after every earlier per-server writer of this note. */
  private withPerServerLock<T>(noteId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this._perServerChain.get(noteId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(fn);
    this._perServerChain.set(noteId, current);
    current.finally(() => {
      if (this._perServerChain.get(noteId) === current) this._perServerChain.delete(noteId);
    }).catch(() => {});
    return current;
  }

  /**
   * Rewrites the per-server statuses of a note under its lock: update
   * receives the current map and edits it in place. Every writer of the
   * note's sync state — edit, push settle, pull — runs its read-decide-
   * write inside one such call, so none acts on a state another changed
   * meanwhile. update must not call another method that takes this lock
   * for the same note (setNotePerServerStatus, markNotePendingForConfigs…):
   * it would wait on itself.
   */
  async updateNotePerServerStatus(
    noteId: string,
    update: (perServer: Record<string, PerServerSyncStatus>) => void | Promise<void>
  ): Promise<void> {
    await this.withPerServerLock(noteId, async () => {
      const perServer = await this.getNotePerServerStatus(noteId);
      await update(perServer);
      await this.db.run(
        "UPDATE notes SET sync_per_server_status = ? WHERE id = ?",
        [JSON.stringify(perServer), noteId]
      );
    });
  }

  async setNotePerServerStatus(
    noteId: string,
    syncConfigId: string,
    status: PerServerSyncStatus
  ): Promise<void> {
    await this.updateNotePerServerStatus(noteId, (perServer) => { perServer[syncConfigId] = status; });
  }

  /** Drops one server from the note's statuses: nothing is queued for it. */
  async clearNotePerServerStatus(noteId: string, syncConfigId: string): Promise<void> {
    await this.updateNotePerServerStatus(noteId, (perServer) => { delete perServer[syncConfigId]; });
  }

  async getNotePerServerStatus(noteId: string): Promise<Record<string, PerServerSyncStatus>> {
    const result = await this.db.query(
      "SELECT sync_per_server_status FROM notes WHERE id = ?",
      [noteId]
    );
    return this.parsePerServerStatus(result.values?.[0]?.sync_per_server_status);
  }

  private parsePerServerStatus(raw: string | null | undefined): Record<string, PerServerSyncStatus> {
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  /**
   * Marks the note as waiting to be pushed to each of the given servers,
   * then re-derives its global status. syncAll(config) later pushes exactly
   * the notes pending (or in error) for that config.
   */
  async markNotePendingForConfigs(noteId: string, configIds: string[]): Promise<void> {
    if (configIds.length === 0) return;
    await this.updateNotePerServerStatus(noteId, (perServer) => {
      for (const id of configIds) perServer[id] = "pending";
    });
    await this.refreshNoteSyncStatus(noteId);
  }

  /**
   * Ids of the applications that can sync — those with a database, the set
   * loadSyncConfigs builds.
   */
  async getLiveSyncConfigIds(): Promise<Set<string>> {
    const result = await this.db.query("SELECT url, username, database FROM applications");
    return new Set(
      (result.values ?? [])
        .filter((a: any) => a.database)
        .map((a: any) => syncConfigIdFor(a.url, a.username, a.database))
    );
  }

  /**
   * Config ids of the note's live links: links whose remote record still
   * exists and whose application can still sync, under that same id.
   */
  async getLiveLinkConfigIds(noteId: string, except?: string): Promise<string[]> {
    const live = await this.getLiveSyncConfigIds();
    const ids = (await this.getNoteLinks(noteId))
      .filter((l) => l.remoteState === "ok" && live.has(l.configId) && l.configId !== except)
      .map((l) => l.configId);
    return [...new Set(ids)];
  }

  /**
   * Derives the note's global sync_status from its per-server statuses:
   * any "conflict", or a live link holding one (params.conflict) →
   * conflict (the user must act), else any "error" →
   * error, else any "pending" → pending, else any "synced" → synced. Entries of ids no live application has (deleted, renamed, or
   * switched to another database) are ignored: nothing would ever clear
   * them. With no live entry left, the note is "synced" if it still has a
   * live link, "local" otherwise. A note "synced" or "local" with a
   * creation still in the outbox for a live server is "pending".
   */
  async refreshNoteSyncStatus(noteId: string): Promise<SyncStatus> {
    const live = await this.getLiveSyncConfigIds();
    const statuses = Object.entries(await this.getNotePerServerStatus(noteId))
      .filter(([configId]) => live.has(configId))
      .map(([, status]) => status);
    // A link holding a conflict keeps the note in conflict, whatever wrote its server's status last
    const conflicted = (await this.getNoteLinks(noteId))
      .some((l) => l.remoteState === "ok" && live.has(l.configId) && !!l.params?.conflict);
    let status: SyncStatus;
    if (conflicted || statuses.includes("conflict")) status = "conflict";
    else if (statuses.includes("error")) status = "error";
    else if (statuses.includes("pending")) status = "pending";
    else if (statuses.includes("synced")) status = "synced";
    else status = (await this.getLiveLinkConfigIds(noteId)).length > 0 ? "synced" : "local";
    // A creation still in the outbox for a live server (waiting for a choice,
    // blocked, retrying) is not sent: the note is not synced there yet
    if (status !== "error" && status !== "pending" && status !== "conflict"
      && (await this.outboxOpsOrNone(noteId)).some((op) => live.has(op.configId))) {
      status = "pending";
    }
    await this.setNoteSyncInfo(noteId, { syncStatus: status });
    return status;
  }

  /**
   * The note's outbox operations, or none while sync_outbox does not exist
   * yet: migration 2026102201 derives statuses before 2026102202 creates it.
   */
  private async outboxOpsOrNone(noteId: string): Promise<OutboxOp[]> {
    try {
      return await this.getOutboxOpsForNote(noteId);
    } catch {
      return [];
    }
  }

  /** How many notes have each sync status. */
  async countNotesBySyncStatus(): Promise<Partial<Record<SyncStatus, number>>> {
    const result = await this.db.query("SELECT sync_status FROM notes");
    const counts: Partial<Record<SyncStatus, number>> = {};
    for (const row of result.values ?? []) {
      const status = (row.sync_status ?? "local") as SyncStatus;
      counts[status] = (counts[status] ?? 0) + 1;
    }
    return counts;
  }

  /** refreshNoteSyncStatus for every note: after an application changed. */
  async refreshAllNoteSyncStatuses(): Promise<void> {
    const result = await this.db.query("SELECT id FROM notes");
    for (const row of result.values ?? []) await this.refreshNoteSyncStatus(row.id);
  }

  /**
   * Returns the ids of the notes to push to one server: those whose
   * per-server status for configId is "pending" or "error". An error stays
   * queued, so a push that failed (server unreachable right after the
   * network came back, 5xx…) is retried by the next syncAll.
   */
  async getNoteIdsPendingForConfig(configId: string): Promise<string[]> {
    const result = await this.db.query("SELECT id, sync_per_server_status FROM notes");
    return (result.values ?? [])
      .filter((row: any) => {
        const status = this.parsePerServerStatus(row.sync_per_server_status)[configId];
        return status === "pending" || status === "error";
      })
      .map((row: any) => row.id as string);
  }

  /**
   * Rewrites the "url|username" ids older versions stored (last-used
   * config, remembered selection, per-server status keys) as the current
   * id of the application with that user on the same server — url
   * compared with sameServerUrl, since older versions kept the old
   * spelling when an application's url was edited. An id no application
   * matches is left as is, and stays non-live. Returns the notes rewritten.
   */
  async addDatabaseToLegacySyncConfigIds(): Promise<number> {
    const apps = (await this.db.query("SELECT url, username, database FROM applications")).values ?? [];
    const upgraded = new Map<string, string>();
    const upgrade = (id: string): string | undefined => {
      if (upgraded.has(id)) return upgraded.get(id);
      const sep = id.lastIndexOf("|");
      const [url, username] = [id.slice(0, sep), id.slice(sep + 1)];
      const app = sep > 0 && id.split("|").length === 2
        ? apps.find((a: any) => a.username === username && sameServerUrl(a.url, url))
        : undefined;
      const result = app ? syncConfigIdFor(app.url, app.username, app.database ?? "") : undefined;
      if (result) upgraded.set(id, result);
      return result;
    };
    const up = (id: string) => upgrade(id) ?? id;
    const result = await this.db.query(
      "SELECT id, sync_config_id, selected_sync_config_ids, sync_per_server_status FROM notes"
    );
    let rewritten = 0;
    for (const row of result.values ?? []) {
      const perServer = this.parsePerServerStatus(row.sync_per_server_status);
      let selected: string[] | null = null;
      try { selected = row.selected_sync_config_ids ? JSON.parse(row.selected_sync_config_ids) : null; } catch { /* ignore */ }
      const touched = (row.sync_config_id && upgrade(row.sync_config_id))
        || (selected ?? []).some((id) => upgrade(id))
        || Object.keys(perServer).some((id) => upgrade(id));
      if (!touched) continue;
      const newPerServer: Record<string, PerServerSyncStatus> = {};
      for (const [id, status] of Object.entries(perServer)) newPerServer[up(id)] = status;
      await this.db.run(
        "UPDATE notes SET sync_config_id = ?, selected_sync_config_ids = ?, sync_per_server_status = ? WHERE id = ?",
        [row.sync_config_id ? up(row.sync_config_id) : null,
         selected ? JSON.stringify([...new Set(selected.map(up))]) : null,
         JSON.stringify(newPerServer), row.id]
      );
      rewritten++;
    }
    return rewritten;
  }

  /**
   * Notes left "pending" by the global flag of older versions: sync_status
   * "pending" with no per-server "pending" entry. Read before any step
   * that writes per-server entries.
   */
  async getLegacyPendingNoteIds(): Promise<string[]> {
    const result = await this.db.query("SELECT id, sync_status, sync_per_server_status FROM notes");
    return (result.values ?? [])
      .filter((row: any) => row.sync_status === "pending"
        && !Object.values(this.parsePerServerStatus(row.sync_per_server_status)).includes("pending"))
      .map((row: any) => row.id as string);
  }

  /**
   * Turns the global "pending" flag of the given notes (see
   * getLegacyPendingNoteIds) into a per-server "pending" for every server
   * each targets: its per-server entries, live links, remembered selection
   * and last-used config. Without it, the first server to sync would clear
   * the global flag and the others would never receive the note. Returns
   * the notes converted.
   */
  async convertLegacyPendingToPerServer(noteIds: string[]): Promise<number> {
    const live = await this.getLiveSyncConfigIds();
    const wanted = new Set(noteIds);
    const result = await this.db.query(
      "SELECT id, sync_status, sync_per_server_status, selected_sync_config_ids, sync_config_id FROM notes"
    );
    let converted = 0;
    for (const row of result.values ?? []) {
      if (!wanted.has(row.id)) continue;
      const perServer = this.parsePerServerStatus(row.sync_per_server_status);
      const targets = new Set([...Object.keys(perServer), ...await this.getLiveLinkConfigIds(row.id)]);
      try {
        for (const id of JSON.parse(row.selected_sync_config_ids ?? "[]")) targets.add(id);
      } catch { /* ignore */ }
      if (row.sync_config_id) targets.add(row.sync_config_id);
      const liveTargets = [...targets].filter((id) => live.has(id));
      if (liveTargets.length === 0) continue;
      await this.markNotePendingForConfigs(row.id, liveTargets);
      converted++;
    }
    return converted;
  }

  /**
   * Re-keys every sync record of one target after its application's url
   * was respelled: links, queued operations, pull cursor, last-used
   * config, remembered selections, per-server statuses, remembered
   * targets (sync_target_prefs) and the calendar's activities; its probes
   * and cached records are dropped and fetched again. Without it the next push finds no
   * link under the new id and creates a duplicate remote record.
   */
  async renameSyncConfigId(oldId: string, newId: string): Promise<void> {
    if (oldId === newId) return;
    await this.db.run("UPDATE note_links SET config_id = ? WHERE config_id = ?", [newId, oldId]);
    await this.db.run("UPDATE sync_outbox SET config_id = ? WHERE config_id = ?", [newId, oldId]);
    await this.deleteServerCapabilities(oldId);
    await this.db.run("DELETE FROM remote_records_cache WHERE config_id = ?", [oldId]);
    // The calendar's activities move with their changes still waiting in the outbox
    for (const a of await this.getCalendarActivities(oldId)) await this.putCalendarActivity({ ...a, configId: newId });
    await this.db.run("DELETE FROM activities_cache WHERE config_id = ?", [oldId]).catch(() => {});
    const pref = await this.db.query("SELECT * FROM sync_target_prefs WHERE config_id = ?", [oldId]);
    for (const row of pref.values ?? []) {
      await this.db.run("DELETE FROM sync_target_prefs WHERE id = ?", [row.id]);
      await this.db.run(
        "INSERT OR REPLACE INTO sync_target_prefs (id, config_id, kind, params_json, updated_at) VALUES (?, ?, ?, ?, ?)",
        [`${newId}#${row.kind}`, newId, row.kind, row.params_json, row.updated_at]
      );
    }
    await this.renameChatRows(oldId, newId);
    const cursor = await this.getSyncPullCursor(oldId);
    if (cursor) {
      await this.setSyncPullCursor(newId, cursor);
      await this.db.run("DELETE FROM sync_pull_cursors WHERE scope = ?", [oldId]);
    }
    const result = await this.db.query("SELECT id, sync_config_id, selected_sync_config_ids FROM notes");
    for (const row of result.values ?? []) {
      let selected: string[] | null = null;
      try { selected = row.selected_sync_config_ids ? JSON.parse(row.selected_sync_config_ids) : null; } catch { /* ignore */ }
      const info: Partial<NoteSyncInfo> = {};
      if (row.sync_config_id === oldId) info.syncConfigId = newId;
      if (selected?.includes(oldId)) {
        info.selectedSyncConfigIds = [...new Set(selected.map((id) => (id === oldId ? newId : id)))];
      }
      if (Object.keys(info).length > 0) await this.setNoteSyncInfo(row.id, info);
      await this.updateNotePerServerStatus(row.id, (perServer) => {
        if (!(oldId in perServer)) return;
        perServer[newId] = perServer[oldId];
        delete perServer[oldId];
      });
    }
  }

  // Chat cache

  /**
   * Chat cache: one row per channel, message, member and partner, keyed
   * `configId#<id>` so two accounts on one server never share a row (a
   * message not yet known to the server is `configId#u<clientUuid>`), plus one
   * sync-state row per source. The text key is the first column of each table.
   */
  async createChatTables(): Promise<void> {
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS chat_channels (
        id                        TEXT PRIMARY KEY NOT NULL,
        config_id                 TEXT NOT NULL,
        channel_id                INTEGER NOT NULL,
        channel_type              TEXT NOT NULL,
        name                      TEXT NOT NULL,
        description               TEXT NOT NULL,
        last_interest_dt          TEXT,
        unread_counter            INTEGER NOT NULL,
        needaction_counter        INTEGER NOT NULL,
        new_message_separator     INTEGER NOT NULL,
        seen_message_id           INTEGER,
        mute_until_dt             TEXT,
        custom_notifications      TEXT,
        is_member                 INTEGER NOT NULL,
        local_pinned              INTEGER NOT NULL,
        last_message_id           INTEGER,
        oldest_loaded_id          INTEGER,
        history_complete          INTEGER NOT NULL,
        correspondent_partner_id  INTEGER,
        updated_at                TEXT NOT NULL,
        unread_counter_bus_id     INTEGER NOT NULL DEFAULT 0,
        needaction_counter_bus_id INTEGER NOT NULL DEFAULT 0,
        is_pinned                 INTEGER NOT NULL DEFAULT 1,
        is_editable               INTEGER,
        custom_channel_name       TEXT,
        member_count              INTEGER,
        group_public_id           INTEGER,
        authorized_group_full_name TEXT,
        create_uid                INTEGER,
        group_based_subscription  INTEGER NOT NULL DEFAULT 0,
        parent_channel_id         INTEGER,
        create_op_id              TEXT,
        create_failed             INTEGER NOT NULL DEFAULT 0,
        left_unsent               INTEGER NOT NULL DEFAULT 0
      )
    `);
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id                TEXT PRIMARY KEY NOT NULL,
        config_id         TEXT NOT NULL,
        channel_id        INTEGER NOT NULL,
        message_id        INTEGER,
        client_uuid       TEXT,
        author_partner_id INTEGER,
        body              TEXT NOT NULL,
        date              TEXT NOT NULL,
        message_type      TEXT NOT NULL,
        status            TEXT NOT NULL,
        outbox_op_id      TEXT,
        write_date        TEXT
      )
    `);
    await this.db.execute(
      "CREATE INDEX IF NOT EXISTS chat_messages_channel ON chat_messages (config_id, channel_id)",
    );
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS chat_members (
        id                 TEXT PRIMARY KEY NOT NULL,
        config_id          TEXT NOT NULL,
        channel_id         INTEGER NOT NULL,
        member_id          INTEGER NOT NULL,
        partner_id         INTEGER NOT NULL,
        seen_message_id    INTEGER,
        fetched_message_id INTEGER,
        is_typing          INTEGER NOT NULL,
        typing_at          TEXT,
        create_date        TEXT
      )
    `);
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS chat_partners (
        id         TEXT PRIMARY KEY NOT NULL,
        config_id  TEXT NOT NULL,
        partner_id INTEGER NOT NULL,
        name       TEXT NOT NULL,
        im_status  TEXT
      )
    `);
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS chat_sources (
        config_id       TEXT PRIMARY KEY NOT NULL,
        self_partner_id INTEGER,
        last_bus_id     INTEGER NOT NULL,
        bus_seen_at     TEXT,
        ws_version      TEXT,
        is_system       INTEGER NOT NULL,
        module_state    TEXT NOT NULL,
        inbox_counter   INTEGER NOT NULL,
        loaded_at       TEXT,
        counter_bus_id  INTEGER NOT NULL DEFAULT 0,
        internal_user_group_id INTEGER,
        global_mute_until      TEXT,
        global_mute_at         TEXT,
        is_internal_user       INTEGER NOT NULL DEFAULT 0
      )
    `);
    await this.createChatTempIdsTable();
    for (const [table, col] of [
      ["chat_channels", "config_id"],
      ["chat_messages", "config_id, channel_id"],
      ["chat_members", "config_id, channel_id"],
      ["chat_partners", "config_id"],
    ]) {
      await this.db.execute(`CREATE INDEX IF NOT EXISTS idx_${table}_cfg ON ${table}(${col})`);
    }
  }

  /**
   * Adds the conversation management columns (pin, edit right, naming,
   * access group, membership, a create still running or refused, the
   * session's group and global mute) to the chat tables of migration
   * 2026102501, and the table of temporary ids. Each column is added only
   * when PRAGMA table_info does not list it, so a fresh install
   * (createChatTables already has them) and a second run change nothing.
   */
  async addChatLot2Columns(): Promise<void> {
    const columns: Record<string, [string, string][]> = {
      chat_channels: [
        ["is_pinned", "INTEGER NOT NULL DEFAULT 1"],
        ["is_editable", "INTEGER"],
        ["custom_channel_name", "TEXT"],
        ["member_count", "INTEGER"],
        ["group_public_id", "INTEGER"],
        ["authorized_group_full_name", "TEXT"],
        ["create_uid", "INTEGER"],
        ["group_based_subscription", "INTEGER NOT NULL DEFAULT 0"],
        ["parent_channel_id", "INTEGER"],
        ["create_op_id", "TEXT"],
        ["create_failed", "INTEGER NOT NULL DEFAULT 0"],
      ],
      chat_members: [["create_date", "TEXT"]],
      chat_sources: [
        ["internal_user_group_id", "INTEGER"],
        ["global_mute_until", "TEXT"],
        ["global_mute_at", "TEXT"],
        ["is_internal_user", "INTEGER NOT NULL DEFAULT 0"],
      ],
    };
    for (const [table, wanted] of Object.entries(columns)) {
      const existing = await this.db.query(`PRAGMA table_info(${table})`);
      const names = (existing.values ?? []).map((r: any) => r.name as string);
      for (const [col, def] of wanted) {
        if (!names.includes(col)) await this.db.execute(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
      }
    }
    await this.createChatTempIdsTable();
  }

  /**
   * Adds the flag of a conversation left with texts still queued
   * (chat_channels.left_unsent) to tables created before it, when PRAGMA
   * table_info does not list it; a fresh install (createChatTables already
   * has it) and a second run change nothing.
   */
  async addChatLeftUnsent(): Promise<void> {
    const existing = await this.db.query("PRAGMA table_info(chat_channels)");
    const names = (existing.values ?? []).map((r: any) => r.name as string);
    if (!names.includes("left_unsent")) {
      await this.db.execute("ALTER TABLE chat_channels ADD COLUMN left_unsent INTEGER NOT NULL DEFAULT 0");
    }
  }

  /**
   * The server id each conversation created on the phone was given, by its
   * temporary id (row key `configId#<tempId>`): a screen or a route still
   * naming the temporary id finds the conversation, and a fingerprint
   * search never adopts a conversation another create already took.
   */
  private async createChatTempIdsTable(): Promise<void> {
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS chat_temp_ids (
        id        TEXT PRIMARY KEY NOT NULL,
        config_id TEXT NOT NULL,
        temp_id   INTEGER NOT NULL,
        real_id   INTEGER NOT NULL
      )
    `);
  }

  /**
   * Moves the chat rows of one config id under another: both the `config_id`
   * column and the `configId#` prefix of the key. A table not created yet is skipped.
   */
  private async renameChatRows(oldId: string, newId: string): Promise<void> {
    for (const table of ["chat_channels", "chat_messages", "chat_members", "chat_partners", "chat_temp_ids", "chat_sources"]) {
      try {
        const keyed = table !== "chat_sources";
        const key = keyed ? "id" : "config_id";
        const result = await this.db.query(`SELECT * FROM ${table} WHERE config_id = ?`, [oldId]);
        for (const row of result.values ?? []) {
          const next: Record<string, any> = { ...row, config_id: newId };
          if (keyed) next.id = newId + String(row.id).slice(oldId.length);
          await this.db.run(`DELETE FROM ${table} WHERE ${key} = ?`, [row[key]]);
          const cols = Object.keys(next);
          await this.db.run(
            `INSERT OR REPLACE INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
            cols.map((c) => next[c])
          );
        }
      } catch { /* table absent on a database not migrated yet */ }
    }
  }

  // Pull cursors

  /**
   * Highest task write_date already pulled, per sync config id: the next
   * pull starts there instead of re-reading every task since the oldest
   * link.
   */
  async createSyncPullCursorsTable(): Promise<void> {
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS sync_pull_cursors (
        scope      TEXT PRIMARY KEY NOT NULL,
        write_date TEXT NOT NULL
      )
    `);
  }

  async getSyncPullCursor(scope: string): Promise<string | null> {
    const result = await this.db.query("SELECT write_date FROM sync_pull_cursors WHERE scope = ?", [scope]);
    return result.values?.[0]?.write_date ?? null;
  }

  async setSyncPullCursor(scope: string, writeDate: string): Promise<void> {
    await this.db.run(
      "INSERT OR REPLACE INTO sync_pull_cursors (scope, write_date) VALUES (?, ?)",
      [scope, writeDate]
    );
  }

  // Note links

  async createNoteLinksTable(): Promise<void> {
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS note_links (
        id             TEXT PRIMARY KEY NOT NULL,
        note_id        TEXT NOT NULL,
        config_id      TEXT NOT NULL,
        model          TEXT NOT NULL,
        res_id         INTEGER NOT NULL,
        kind           TEXT NOT NULL,
        remote_state   TEXT NOT NULL,
        created_at     TEXT NOT NULL,
        last_synced_at TEXT,
        client_uuid    TEXT,
        params_json    TEXT
      )
    `);
    await this.db.execute(
      "CREATE INDEX IF NOT EXISTS idx_note_links_note ON note_links(note_id)"
    );
    await this.db.execute(
      "CREATE INDEX IF NOT EXISTS idx_note_links_config ON note_links(config_id)"
    );
  }

  async addNoteLink(link: NoteLink): Promise<void> {
    await this.db.run(
      "INSERT INTO note_links (id, note_id, config_id, model, res_id, kind, remote_state, created_at, last_synced_at, client_uuid, params_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [link.id, link.noteId, link.configId, link.model, link.resId, link.kind,
       link.remoteState, link.createdAt, link.lastSyncedAt, link.clientUuid ?? null,
       JSON.stringify(link.params ?? {})]
    );
  }

  async getNoteLinks(noteId: string): Promise<NoteLink[]> {
    const result = await this.db.query("SELECT * FROM note_links WHERE note_id = ?", [noteId]);
    return (result.values ?? []).map((row: any) => this.rowToNoteLink(row));
  }

  async getNoteLinksForConfig(configId: string): Promise<NoteLink[]> {
    const result = await this.db.query("SELECT * FROM note_links WHERE config_id = ?", [configId]);
    return (result.values ?? []).map((row: any) => this.rowToNoteLink(row));
  }

  /**
   * The note's link to (config, model, kind) whose remote record still
   * exists; with includeDeleted, the most recently created deleted one
   * when no live one exists (a record recreated, then deleted again,
   * leaves several). Dismissed links are never returned.
   */
  async findNoteLink(
    noteId: string,
    configId: string,
    model: string,
    kind: NoteLinkKind,
    includeDeleted = false
  ): Promise<NoteLink | null> {
    const matching = (await this.getNoteLinks(noteId))
      .filter((l) => l.configId === configId && l.model === model && l.kind === kind && l.remoteState !== "dismissed");
    const latest = [...matching].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))[0];
    return matching.find((l) => l.remoteState === "ok")
      ?? (includeDeleted ? latest ?? null : null);
  }

  /** Marks a deleted link dismissed: see NoteLink.remoteState. */
  async setNoteLinkDismissed(linkId: string): Promise<void> {
    await this.db.run("UPDATE note_links SET remote_state = ? WHERE id = ?", ["dismissed", linkId]);
  }

  async setNoteLinkRemoteDeleted(linkId: string): Promise<void> {
    await this.db.run("UPDATE note_links SET remote_state = ? WHERE id = ?", ["deleted", linkId]);
  }

  /** Replaces a link's params (see NoteLink.params). */
  async setNoteLinkParams(linkId: string, params: Record<string, any>): Promise<void> {
    await this.db.run("UPDATE note_links SET params_json = ? WHERE id = ?", [JSON.stringify(params), linkId]);
  }

  /** Marks an activity link done: see NoteLink.remoteState. */
  async setNoteLinkDone(linkId: string): Promise<void> {
    await this.db.run("UPDATE note_links SET remote_state = ? WHERE id = ?", ["done", linkId]);
  }

  async setNoteLinkSyncedAt(linkId: string, lastSyncedAt: string): Promise<void> {
    await this.db.run("UPDATE note_links SET last_synced_at = ? WHERE id = ?", [lastSyncedAt, linkId]);
  }

  async deleteNoteLinks(noteId: string): Promise<void> {
    await this.db.run("DELETE FROM note_links WHERE note_id = ?", [noteId]);
  }

  private rowToNoteLink(row: any): NoteLink {
    let params: Record<string, any> = {};
    try { params = JSON.parse(row.params_json ?? "{}") ?? {}; } catch { /* keep {} */ }
    return {
      id: row.id,
      noteId: row.note_id,
      configId: row.config_id,
      model: row.model,
      resId: Number(row.res_id),
      kind: row.kind === "activity" || row.kind === "message" ? row.kind : "create",
      remoteState: NOTE_LINK_REMOTE_STATES.includes(row.remote_state) ? row.remote_state : "ok",
      createdAt: row.created_at,
      lastSyncedAt: row.last_synced_at ?? null,
      clientUuid: row.client_uuid ?? null,
      params,
    };
  }

  /** For a note_links table created before the params_json column existed. */
  async addParamsToNoteLinks(): Promise<void> {
    const existing = await this.db.query("PRAGMA table_info(note_links)");
    if (!(existing.values ?? []).some((r: any) => r.name === "params_json")) {
      await this.db.execute("ALTER TABLE note_links ADD COLUMN params_json TEXT");
    }
  }

  /** For a note_links table created before the column existed. */
  async addClientUuidToNoteLinks(): Promise<void> {
    const existing = await this.db.query("PRAGMA table_info(note_links)");
    if (!(existing.values ?? []).some((r: any) => r.name === "client_uuid")) {
      await this.db.execute("ALTER TABLE note_links ADD COLUMN client_uuid TEXT");
    }
  }

  // Activity calendar

  async createActivitiesCacheTable(): Promise<void> {
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS activities_cache (
        id         TEXT PRIMARY KEY NOT NULL,
        config_id  TEXT NOT NULL,
        res_id     INTEGER NOT NULL,
        deadline   TEXT NOT NULL,
        data_json  TEXT NOT NULL,
        fetched_at TEXT NOT NULL
      )
    `);
    await this.db.execute(
      "CREATE INDEX IF NOT EXISTS idx_activities_cache_config ON activities_cache(config_id)"
    );
  }

  /** Replaces the cached activities of one server with those just read. */
  async replaceCalendarActivities(configId: string, activities: CalendarActivity[]): Promise<void> {
    await this.db.run("DELETE FROM activities_cache WHERE config_id = ?", [configId]);
    for (const a of activities) await this.putCalendarActivity(a);
  }

  /** Adds or replaces one cached activity. */
  async putCalendarActivity(a: CalendarActivity): Promise<void> {
    await this.db.run(
      "INSERT OR REPLACE INTO activities_cache (id, config_id, res_id, deadline, data_json, fetched_at) VALUES (?, ?, ?, ?, ?, ?)",
      [`${a.configId}#${a.resId}`, a.configId, a.resId, a.deadline, JSON.stringify(a), a.fetchedAt]
    );
  }

  async deleteCalendarActivity(configId: string, resId: number): Promise<void> {
    await this.db.run("DELETE FROM activities_cache WHERE id = ?", [`${configId}#${resId}`]);
  }

  /** The cached activities of one server; none for a table not created yet. */
  async getCalendarActivities(configId: string): Promise<CalendarActivity[]> {
    try {
      const result = await this.db.query("SELECT * FROM activities_cache WHERE config_id = ?", [configId]);
      const rows: CalendarActivity[] = [];
      for (const row of result.values ?? []) {
        try { rows.push(JSON.parse(row.data_json)); } catch { /* skip a damaged row */ }
      }
      return rows;
    } catch {
      return [];
    }
  }

  // Outbox

  async createSyncOutboxTable(): Promise<void> {
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS sync_outbox (
        id              TEXT PRIMARY KEY NOT NULL,
        client_uuid     TEXT NOT NULL,
        note_id         TEXT NOT NULL,
        config_id       TEXT NOT NULL,
        kind            TEXT NOT NULL,
        params_json     TEXT NOT NULL,
        status          TEXT NOT NULL,
        attempts        INTEGER NOT NULL,
        next_attempt_at TEXT,
        last_error      TEXT,
        depends_on      TEXT,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      )
    `);
    await this.db.execute(
      "CREATE INDEX IF NOT EXISTS idx_sync_outbox_config ON sync_outbox(config_id)"
    );
    await this.db.execute(
      "CREATE INDEX IF NOT EXISTS idx_sync_outbox_note ON sync_outbox(note_id)"
    );
  }

  async addOutboxOp(op: OutboxOp): Promise<void> {
    await this.db.run(
      "INSERT INTO sync_outbox (id, client_uuid, note_id, config_id, kind, params_json, status, attempts, next_attempt_at, last_error, depends_on, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [op.id, op.clientUuid, op.noteId, op.configId, op.kind, JSON.stringify(op.params),
       op.status, op.attempts, op.nextAttemptAt, op.lastError, op.dependsOn, op.createdAt, op.updatedAt]
    );
  }

  async getOutboxOp(id: string): Promise<OutboxOp | null> {
    const result = await this.db.query("SELECT * FROM sync_outbox WHERE id = ?", [id]);
    const row = result.values?.[0];
    return row ? this.rowToOutboxOp(row) : null;
  }

  /** Operations of one server, oldest first. */
  async getOutboxOpsForConfig(configId: string): Promise<OutboxOp[]> {
    const result = await this.db.query("SELECT * FROM sync_outbox WHERE config_id = ?", [configId]);
    return this.sortOutboxOps(result.values ?? []);
  }

  /** Operations of one note, oldest first. */
  async getOutboxOpsForNote(noteId: string): Promise<OutboxOp[]> {
    const result = await this.db.query("SELECT * FROM sync_outbox WHERE note_id = ?", [noteId]);
    return this.sortOutboxOps(result.values ?? []);
  }

  /** Writes the given fields of one operation; updatedAt is always set. */
  async updateOutboxOp(
    id: string,
    update: Partial<Pick<OutboxOp, "params" | "status" | "attempts" | "nextAttemptAt" | "lastError" | "dependsOn">>
      & { updatedAt: string }
  ): Promise<void> {
    const columns: Record<string, string> = {
      params: "params_json", status: "status", attempts: "attempts",
      nextAttemptAt: "next_attempt_at", lastError: "last_error",
      dependsOn: "depends_on", updatedAt: "updated_at",
    };
    const sets: string[] = [];
    const values: any[] = [];
    for (const [key, column] of Object.entries(columns)) {
      if (!(key in update)) continue;
      const value = (update as any)[key];
      sets.push(`${column} = ?`);
      values.push(key === "params" ? JSON.stringify(value) : value);
    }
    await this.db.run(`UPDATE sync_outbox SET ${sets.join(", ")} WHERE id = ?`, [...values, id]);
  }

  async deleteOutboxOp(id: string): Promise<void> {
    await this.db.run("DELETE FROM sync_outbox WHERE id = ?", [id]);
  }

  async deleteOutboxOpsForNote(noteId: string): Promise<void> {
    await this.db.run("DELETE FROM sync_outbox WHERE note_id = ?", [noteId]);
  }

  /**
   * Turns the operations left "running" by an interrupted app into
   * "failed", due now. Their attempts count stays, so the next run looks
   * for what the cut-short run may already have done. Returns how many.
   */
  async failInterruptedOutboxOps(now: string): Promise<number> {
    const result = await this.db.query("SELECT id FROM sync_outbox WHERE status = ?", ["running"]);
    const ids = (result.values ?? []).map((r: any) => r.id as string);
    for (const id of ids) {
      await this.updateOutboxOp(id, {
        status: "failed", nextAttemptAt: now, lastError: "interrupted", updatedAt: now,
      });
    }
    return ids.length;
  }

  private sortOutboxOps(rows: any[]): OutboxOp[] {
    return rows
      .map((row) => this.rowToOutboxOp(row))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  private rowToOutboxOp(row: any): OutboxOp {
    let params: Record<string, any> = {};
    try { params = JSON.parse(row.params_json ?? "{}") ?? {}; } catch { /* keep {} */ }
    return {
      id: row.id,
      clientUuid: row.client_uuid,
      noteId: row.note_id,
      configId: row.config_id,
      kind: row.kind,
      params,
      status: row.status as OutboxStatus,
      attempts: Number(row.attempts ?? 0),
      nextAttemptAt: row.next_attempt_at ?? null,
      lastError: row.last_error ?? null,
      dependsOn: row.depends_on ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // Server capabilities

  async createServerCapabilitiesTable(): Promise<void> {
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS server_capabilities (
        id             TEXT PRIMARY KEY NOT NULL,
        config_id      TEXT NOT NULL,
        model          TEXT NOT NULL,
        exists_flag    INTEGER NOT NULL,
        can_read       INTEGER,
        can_create     INTEGER,
        can_write      INTEGER,
        has_activities INTEGER NOT NULL,
        has_chatter    INTEGER NOT NULL,
        fields_json    TEXT NOT NULL,
        odoo_version   INTEGER NOT NULL,
        probed_at      TEXT NOT NULL,
        error          TEXT
      )
    `);
    await this.db.execute(
      "CREATE INDEX IF NOT EXISTS idx_server_capabilities_config ON server_capabilities(config_id)"
    );
  }

  async setServerCapability(cap: ServerCapability): Promise<void> {
    const flag = (v: boolean | null) => (v === null ? null : v ? 1 : 0);
    await this.db.run(
      "INSERT OR REPLACE INTO server_capabilities (id, config_id, model, exists_flag, can_read, can_create, can_write, has_activities, has_chatter, fields_json, odoo_version, probed_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [this.capabilityId(cap.configId, cap.model), cap.configId, cap.model, cap.exists ? 1 : 0,
       flag(cap.canRead), flag(cap.canCreate), flag(cap.canWrite),
       cap.hasActivities ? 1 : 0, cap.hasChatter ? 1 : 0, JSON.stringify(cap.fields),
       cap.odooVersion, cap.probedAt, cap.error]
    );
  }

  async getServerCapability(configId: string, model: string): Promise<ServerCapability | null> {
    const result = await this.db.query(
      "SELECT * FROM server_capabilities WHERE id = ?",
      [this.capabilityId(configId, model)]
    );
    const row = result.values?.[0];
    if (!row) return null;
    const flag = (v: any) => (v === null || v === undefined ? null : Number(v) === 1);
    let fields: Record<string, any> = {};
    try { fields = JSON.parse(row.fields_json ?? "{}") ?? {}; } catch { /* keep {} */ }
    return {
      configId: row.config_id,
      model: row.model,
      exists: Number(row.exists_flag) === 1,
      canRead: flag(row.can_read),
      canCreate: flag(row.can_create),
      canWrite: flag(row.can_write),
      hasActivities: Number(row.has_activities) === 1,
      hasChatter: Number(row.has_chatter) === 1,
      fields,
      odooVersion: Number(row.odoo_version),
      probedAt: row.probed_at,
      error: row.error ?? null,
    };
  }

  /** Forgets every probe of one server: they are redone on next use. */
  async deleteServerCapabilities(configId: string): Promise<void> {
    await this.db.run("DELETE FROM server_capabilities WHERE config_id = ?", [configId]);
  }

  /** Primary key of a capability row: one per server and model. */
  private capabilityId(configId: string, model: string): string {
    return `${configId}#${model}`;
  }

  // Remote records cache

  async createRemoteRecordsCacheTable(): Promise<void> {
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS remote_records_cache (
        id           TEXT PRIMARY KEY NOT NULL,
        config_id    TEXT NOT NULL,
        model        TEXT NOT NULL,
        res_id       INTEGER NOT NULL,
        display_name TEXT NOT NULL,
        extra_json   TEXT NOT NULL,
        fetched_at   TEXT NOT NULL
      )
    `);
    await this.db.execute(
      "CREATE INDEX IF NOT EXISTS idx_remote_records_cache_config_model ON remote_records_cache(config_id, model)"
    );
  }

  /**
   * Replaces the cached records of one model on one server with records:
   * a record the server no longer returned is dropped from the cache.
   */
  async replaceRemoteRecords(configId: string, model: string, records: RemoteRecord[]): Promise<void> {
    await this.db.run("DELETE FROM remote_records_cache WHERE config_id = ? AND model = ?", [configId, model]);
    for (const r of records) {
      await this.db.run(
        "INSERT OR REPLACE INTO remote_records_cache (id, config_id, model, res_id, display_name, extra_json, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [`${configId}#${model}#${r.resId}`, configId, model, r.resId, r.displayName,
         JSON.stringify(r.extra ?? {}), r.fetchedAt]
      );
    }
  }

  /**
   * Adds or refreshes cached records of one model on one server, then
   * keeps only the keep most recently fetched ones of that model there.
   */
  async upsertRemoteRecords(configId: string, model: string, records: RemoteRecord[], keep: number): Promise<void> {
    for (const r of records) {
      await this.db.run(
        "INSERT OR REPLACE INTO remote_records_cache (id, config_id, model, res_id, display_name, extra_json, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [`${configId}#${model}#${r.resId}`, configId, model, r.resId, r.displayName,
         JSON.stringify(r.extra ?? {}), r.fetchedAt]
      );
    }
    const all = await this.getRemoteRecords(configId, model);
    const stale = [...all].sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt)).slice(keep);
    for (const r of stale) {
      await this.db.run("DELETE FROM remote_records_cache WHERE id = ?", [`${configId}#${model}#${r.resId}`]);
    }
  }

  /** Cached records of one model on one server, by display name. */
  async getRemoteRecords(configId: string, model: string): Promise<RemoteRecord[]> {
    const result = await this.db.query(
      "SELECT * FROM remote_records_cache WHERE config_id = ? AND model = ?",
      [configId, model]
    );
    return (result.values ?? [])
      .map((row: any) => {
        let extra: Record<string, any> = {};
        try { extra = JSON.parse(row.extra_json ?? "{}") ?? {}; } catch { /* keep {} */ }
        return {
          configId: row.config_id,
          model: row.model,
          resId: Number(row.res_id),
          displayName: row.display_name,
          extra,
          fetchedAt: row.fetched_at,
        };
      })
      .sort((a: RemoteRecord, b: RemoteRecord) => a.displayName.localeCompare(b.displayName));
  }

  // Sync target preferences

  async createSyncTargetPrefsTable(): Promise<void> {
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS sync_target_prefs (
        id          TEXT PRIMARY KEY NOT NULL,
        config_id   TEXT NOT NULL,
        kind        TEXT NOT NULL,
        params_json TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      )
    `);
  }

  async setSyncTargetPref(pref: SyncTargetPref): Promise<void> {
    await this.db.run(
      "INSERT OR REPLACE INTO sync_target_prefs (id, config_id, kind, params_json, updated_at) VALUES (?, ?, ?, ?, ?)",
      [`${pref.configId}#${pref.kind}`, pref.configId, pref.kind, JSON.stringify(pref.params), pref.updatedAt]
    );
  }

  async getSyncTargetPref(configId: string, kind: string): Promise<SyncTargetPref | null> {
    const result = await this.db.query("SELECT * FROM sync_target_prefs WHERE id = ?", [`${configId}#${kind}`]);
    const row = result.values?.[0];
    if (!row) return null;
    let params: Record<string, any> = {};
    try { params = JSON.parse(row.params_json ?? "{}") ?? {}; } catch { /* keep {} */ }
    return { configId: row.config_id, kind: row.kind, params, updatedAt: row.updated_at };
  }

  /**
   * Copies the single binding of older versions (notes.odoo_id + odoo_url,
   * a project.task) into note_links. Expects the ids already upgraded by
   * addDatabaseToLegacySyncConfigIds.
   *
   * The id was issued by one database at odoo_url, and nothing recorded
   * which one; older versions also write()-ed it to every server a note was
   * pushed to. So a link is written only where the id is unambiguous: all
   * applications at odoo_url point at one database. It goes to the configs
   * the note recorded there (sync_config_id, "synced" per-server keys), or,
   * when it recorded none, to the one application at that url. Every other
   * live target of the note (selection, per-server keys) is queued
   * "pending", so it gets a record of its own rather than a foreign one.
   * Re-running writes no duplicate. Returns the links written.
   */
  async backfillNoteLinksFromLegacyColumns(newId: () => string): Promise<number> {
    const notes = await this.db.query(
      "SELECT id, odoo_id, odoo_url, sync_config_id, selected_sync_config_ids, sync_per_server_status, last_synced_at FROM notes"
    );
    const apps = (await this.db.query("SELECT url, username, database FROM applications")).values ?? [];
    const live = await this.getLiveSyncConfigIds();
    let written = 0;
    for (const row of notes.values ?? []) {
      if (row.odoo_id === null || row.odoo_id === undefined || !row.odoo_url) continue;
      const perServer = this.parsePerServerStatus(row.sync_per_server_status);
      // Applications without a database cannot sync and say nothing here
      const atUrl = apps.filter((a: any) => a.database && sameServerUrl(a.url, row.odoo_url));
      const idsAtUrl = new Set<string>(atUrl.map((a: any) => syncConfigIdFor(a.url, a.username, a.database ?? "")));
      const unambiguous = new Set(atUrl.map((a: any) => a.database ?? "")).size === 1;

      const linked = new Set<string>();
      if (unambiguous) {
        if (row.sync_config_id && idsAtUrl.has(row.sync_config_id)) linked.add(row.sync_config_id);
        for (const [configId, status] of Object.entries(perServer)) {
          if (status === "synced" && idsAtUrl.has(configId)) linked.add(configId);
        }
        if (linked.size === 0 && atUrl.length === 1) linked.add([...idsAtUrl][0]);
      }
      for (const configId of linked) {
        if (await this.findNoteLink(row.id, configId, "project.task", "create")) continue;
        await this.addNoteLink({
          id: newId(),
          noteId: row.id,
          configId,
          model: "project.task",
          resId: Number(row.odoo_id),
          kind: "create",
          remoteState: "ok",
          createdAt: row.last_synced_at ?? new Date().toISOString(),
          lastSyncedAt: row.last_synced_at ?? null,
        });
        written++;
      }

      const targets = new Set<string>(Object.keys(perServer));
      try {
        for (const id of JSON.parse(row.selected_sync_config_ids ?? "[]")) targets.add(id);
      } catch { /* ignore */ }
      if (row.sync_config_id) targets.add(row.sync_config_id);
      const unlinked = [...targets].filter((id) => live.has(id) && !linked.has(id)
        && perServer[id] !== "pending");
      if (unlinked.length > 0) await this.markNotePendingForConfigs(row.id, unlinked);
    }
    return written;
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

  async createEditableReposTable(): Promise<void> {
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS editable_repos (
        slug          TEXT PRIMARY KEY,
        baseline_sha  TEXT NOT NULL,
        build_id      TEXT NOT NULL,
        promoted_at   INTEGER NOT NULL,
        head_sha      TEXT
      )
    `);
    await this.db.execute(`
      CREATE INDEX IF NOT EXISTS idx_editable_repos_promoted_at
        ON editable_repos(promoted_at)
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
