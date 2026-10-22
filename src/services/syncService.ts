import { Capacitor, CapacitorCookies } from "@capacitor/core";
import { RawHttp } from "../plugins/rawHttpPlugin";
import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";
import { DatabaseService } from "./databaseService";
import { Application } from "../models/application";
import {
  Note,
  NoteEntry,
  NoteEntryGeolocationParams,
  NoteEntryTextParams,
  NoteEntryDateParams,
} from "../models/note";
import { StorageConstants } from "../constants/storage";
import { syncConfigIdFor } from "../models/syncConfig";
import { v4 as uuidv4 } from "uuid";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SyncCredentials {
  odooUrl: string;
  username: string;
  password: string;
  database: string;
}

export interface SyncResult {
  pushed: number;
  pulled: number;
  errors: string[];
}

interface StoredSession {
  sessionId: string;
  odooMajorVersion: number;
  /** ISO timestamp when the session was created — for local expiry enforcement. */
  createdAt?: string;
}

/** Maximum session age in milliseconds (default: 24 hours). */
const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Remote model a note is mirrored to by pushNote / pullNotes. */
const TASK_MODEL = "project.task";

/** project.task.state of a closed task (Odoo 17+). */
const TASK_STATE_DONE = "1_done";

/** Tasks per pull page, and pages per pull (bounds one pull to 5000 tasks). */
const PULL_PAGE_SIZE = 100;
const PULL_MAX_PAGES = 50;

/**
 * search_read context of pull and poll: archived tasks are returned too,
 * otherwise archiving a task on the server never reaches the note.
 */
const WITH_ARCHIVED = { active_test: false };

/**
 * Raised when Odoo reports the session as no longer valid: JSON-RPC error
 * code 100, which Odoo sends only for SessionExpiredException. callWithAuth
 * re-authenticates on this error and on HTTP 401, never on message text.
 */
export class SessionExpiredError extends Error {}

/** A JSON-RPC error, with the Odoo exception class name when sent. */
export class OdooRpcError extends Error {
  constructor(message: string, readonly odooName: string | null) {
    super(message);
  }
}

/**
 * The task a note is linked to on this server was deleted there. Raised by
 * pushNote instead of creating a new task: a record deleted on the server
 * is recreated only on explicit request (pushNote's recreateDeleted).
 */
export class RemoteRecordDeletedError extends Error {}

/**
 * First pull of a config (no cursor yet) starts this long before the
 * oldest link's last sync: that time comes from the device clock, task
 * write_dates from the server clock. Re-reading a task is harmless.
 */
const FIRST_PULL_CLOCK_MARGIN_MS = 24 * 60 * 60 * 1000;

/** Fields of a note a push sends: a change here during a push re-queues it. */
function pushedFingerprint(note: Note): string {
  return JSON.stringify([note.title, note.done, note.archived, note.pinned, note.tags, note.entries]);
}

/** Sync config id of a set of credentials, as built by appToSyncConfig. */
export function syncConfigIdOf(creds: SyncCredentials): string {
  return syncConfigIdFor(creds.odooUrl, creds.username, creds.database);
}

/**
 * SecureStorage key of the session for one url, user AND database: two
 * databases on the same url never share a session. Base64 of the UTF-8
 * bytes, since btoa() rejects characters above U+00FF.
 */
export function syncSessionKey(creds: SyncCredentials): string {
  const bytes = new TextEncoder().encode(`${creds.odooUrl}|${creds.username}|${creds.database}`);
  return StorageConstants.SYNC_SESSION_PREFIX + btoa(String.fromCharCode(...bytes));
}

// ─── SyncService ──────────────────────────────────────────────────────────────

export class SyncService {
  private db: DatabaseService;
  /** Diagnostic trail of the last authenticate() call — shown in retry errors. */
  private _lastAuthDiag: string = "";
  /**
   * Whether project.task has geo_task_point, per "url|database". The field
   * comes from an optional server module; sending it where it is missing
   * makes create/write fail. Probed once per server for the app's lifetime.
   */
  private _taskGeoField = new Map<string, boolean>();
  /**
   * In-flight pushNote per "note|config id". A second push of the
   * same note to the same server waits for the first, so a note never yet
   * linked is created once, not once per concurrent caller (reconnect
   * syncAll racing a tap on the sync button).
   */
  private _pushInFlight = new Map<string, Promise<void>>();
  /**
   * Called with the id of each note a pull changed, so a screen showing
   * that note reloads it instead of saving its older copy over it.
   */
  onNotePulled: ((noteId: string) => void) | null = null;

  constructor(db: DatabaseService) {
    this.db = db;
  }

  // ─── Authentication ───────────────────────────────────────────────────────

  /**
   * Authenticates with an Odoo instance and stores the session ID in
   * SecureStorage. Returns the session ID.
   */
  async authenticate(creds: SyncCredentials): Promise<StoredSession> {
    const baseUrl = this.normalizeUrl(creds.odooUrl);
    const endpoint = `${baseUrl}/web/session/authenticate`;
    const diag: string[] = [`→ POST ${endpoint}`];

    const resp = await this.rawPost(endpoint, { "Content-Type": "application/json" }, {
      jsonrpc: "2.0", method: "call", id: 1,
      params: { db: creds.database, login: creds.username, password: creds.password },
    });

    diag.push(`← HTTP ${resp.status}`);
    const headerKeys = Object.keys(resp.headers as object);
    diag.push(`  En-têtes: [${headerKeys.join(", ") || "aucun"}]`);

    const json = this.parseNativeResponse(resp, endpoint);
    if (json.error) throw new Error(`Odoo auth error: ${json.error.data?.message ?? json.error.message}`);

    const uid = json.result?.uid;
    if (!uid) throw new Error("Authentication failed — invalid credentials");
    diag.push(`  uid: ${uid}`);

    // Try 1: Set-Cookie header — Odoo 17+ rotates the session after login and
    // sends TWO Set-Cookie directives: first the old session with Max-Age=0
    // (deletion), then the new session. We must process each directive
    // separately and skip any that are being deleted (Max-Age=0 or past Expires).
    // Joining all directives with "; " and taking the first match would give the
    // OLD (already deleted) session_id.
    let sessionId: string = "";
    const headers = resp.headers as Record<string, string | string[]>;
    for (const [key, val] of Object.entries(headers)) {
      if (key.toLowerCase() === "set-cookie") {
        const directives = Array.isArray(val) ? val : [String(val)];
        diag.push(`  [1] Set-Cookie directives (${directives.length}):`);
        for (const directive of directives) {
          const match = directive.match(/session_id=([^;,\s]+)/i);
          if (!match) continue;
          const candidate = match[1];
          const isDeleting =
            /Max-Age\s*=\s*0/i.test(directive) ||
            /Expires\s*=\s*Thu,\s*01\s*Jan\s*1970/i.test(directive);
          if (isDeleting) {
            diag.push(`    - ${candidate.slice(0, 8)}… (Max-Age=0, ignoré)`);
          } else {
            sessionId = candidate;
            diag.push(`    - ${candidate.slice(0, 8)}… ✓ (valide)`);
          }
        }
        break;
      }
    }
    if (!sessionId) diag.push(`  [1] Set-Cookie: absent ou aucun session_id valide`);

    // Try 2: Android CookieManager store — for plain HTTP requests Android may
    // consume the Set-Cookie header internally, making it invisible in resp.headers.
    // CapacitorCookies.getCookies() reads directly from the WebView cookie store.
    if (!sessionId) {
      try {
        const cookies = await CapacitorCookies.getCookies({ url: baseUrl });
        const cookieKeys = Object.keys(cookies as object);
        diag.push(`  [2] CapacitorCookies: [${cookieKeys.join(", ") || "aucun"}]`);
        const fromCookies = (cookies as Record<string, string>)["session_id"] || "";
        if (fromCookies) {
          sessionId = fromCookies;
          diag.push(`  [2] session_id via CookieStore: ${sessionId.slice(0, 8)}…`);
        }
      } catch (e) {
        diag.push(`  [2] CapacitorCookies erreur: ${e}`);
      }
    }

    // Try 3: session_id in JSON body (Odoo 16, or when neither header path worked)
    if (!sessionId) {
      const fromJson = json.result?.session_id || "";
      diag.push(`  [3] JSON result.session_id: ${fromJson ? fromJson.slice(0, 8) + "…" : "absent"}`);
      sessionId = fromJson;
    }

    if (!sessionId) {
      const resultKeys = Object.keys(json.result || {}).slice(0, 20).join(", ");
      diag.push(`  Champs result: [${resultKeys}]`);
      const msg = diag.join("\n");
      console.warn("[sync] authenticate failed:\n" + msg);
      throw new Error(`session_id introuvable\n${msg}`);
    }

    // Persist in WebKit store (port-stripped URL — WebKit ignores port for cookies).
    const cookieUrl = this.cookieUrl(baseUrl);
    try {
      await CapacitorCookies.setCookie({ url: cookieUrl, key: "session_id", value: sessionId });
      const verify = await CapacitorCookies.getCookies({ url: cookieUrl });
      const stored2 = (verify as Record<string, string>)["session_id"] || "";
      diag.push(`  [cookie-store] cookieUrl=${cookieUrl} stored=${stored2 ? stored2.slice(0, 8) + "…" : "(vide)"}`);
    } catch (e) {
      diag.push(`  [cookie-store] err: ${e}`);
    }

    // Verify the session is immediately usable by Odoo via a lightweight call.
    // This tells us whether the Cookie header we send reaches Odoo correctly.
    try {
      const infoResp = await this.rawPost(
        `${baseUrl}/web/session/get_session_info`,
        { "Content-Type": "application/json", Cookie: `session_id=${sessionId}` },
        { jsonrpc: "2.0", method: "call", id: 99, params: {} }
      );
      const infoJson = this.parseNativeResponse(infoResp, "/web/session/get_session_info");
      if (infoJson.error) {
        diag.push(`  [verify] get_session_info ÉCHEC: code=${infoJson.error.code} msg=${infoJson.error.data?.message ?? infoJson.error.message}`);
      } else {
        diag.push(`  [verify] get_session_info OK: uid=${infoJson.result?.uid} session=${String(infoJson.result?.session_id ?? "").slice(0, 8)}…`);
      }
    } catch (e) {
      diag.push(`  [verify] get_session_info ERREUR: ${e}`);
    }

    this._lastAuthDiag = diag.join("\n");
    const odooMajorVersion: number = json.result?.server_version_info?.[0] ?? 18;
    const stored: StoredSession = { sessionId, odooMajorVersion, createdAt: new Date().toISOString() };
    await SecureStoragePlugin.set({ key: syncSessionKey(creds), value: JSON.stringify(stored) });
    const legacyKey = this.legacySessionKey(creds);
    if (legacyKey) await SecureStoragePlugin.remove({ key: legacyKey }).catch(() => {});
    return stored;
  }

  /**
   * Returns the stored session. If missing or in the old plain-string format,
   * re-authenticates so the Odoo version is also captured.
   */
  private async getSession(creds: SyncCredentials): Promise<StoredSession> {
    try {
      const result = await SecureStoragePlugin.get({ key: syncSessionKey(creds) });
      const parsed = JSON.parse(result.value);
      if (!parsed?.sessionId || !parsed?.odooMajorVersion) throw new Error("stale format");

      // Enforce local session expiry
      if (parsed.createdAt) {
        const age = Date.now() - new Date(parsed.createdAt).getTime();
        if (age > SESSION_MAX_AGE_MS) {
          await SecureStoragePlugin.remove({ key: syncSessionKey(creds) }).catch(() => {});
          throw new Error("session expired locally");
        }
      }

      return parsed as StoredSession;
    } catch {
      return this.authenticate(creds);
    }
  }

  /**
   * Wraps a JSON-RPC call with automatic re-auth on session expiry.
   * Passes both the session ID and the detected Odoo major version to fn.
   * Retries once after re-authenticating.
   */
  private async callWithAuth<T>(
    creds: SyncCredentials,
    fn: (sessionId: string, odooVersion: number) => Promise<T>
  ): Promise<T> {
    const session = await this.getSession(creds);
    const sid = session.sessionId.slice(0, 8);
    try {
      return await fn(session.sessionId, session.odooMajorVersion);
    } catch (e: unknown) {
      if (e instanceof RemoteRecordDeletedError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      if (e instanceof SessionExpiredError || /^HTTP 401\b/.test(msg)) {
        // Invalidate stale cached session before re-authenticating
        await SecureStoragePlugin.remove({ key: syncSessionKey(creds) }).catch(() => {});
        let renewed: StoredSession;
        try {
          renewed = await this.authenticate(creds);
        } catch (authErr: unknown) {
          const authMsg = authErr instanceof Error ? authErr.message : String(authErr);
          throw new Error(`session expirée (${sid}…) puis re-auth échouée:\n${authMsg}`);
        }
        try {
          return await fn(renewed.sessionId, renewed.odooMajorVersion);
        } catch (retryErr: unknown) {
          if (retryErr instanceof RemoteRecordDeletedError) throw retryErr;
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          throw new Error(
            `re-auth OK (${renewed.sessionId.slice(0, 8)}…) mais appel échoué:\n${retryMsg}\n\n` +
            `Diag auth:\n${this._lastAuthDiag}`
          );
        }
      }
      throw new Error(`erreur (session ${sid}…): ${msg}`);
    }
  }

  // ─── JSON-RPC helper ──────────────────────────────────────────────────────

  private async jsonRpc(
    odooUrl: string,
    sessionId: string,
    model: string,
    method: string,
    args: any[],
    kwargs: Record<string, any> = {}
  ): Promise<any> {
    const baseUrl = this.normalizeUrl(odooUrl);
    const endpoint = `${baseUrl}/web/dataset/call_kw`;

    // RawHttp bypasses Android's CookieHandler so the Cookie header reaches Odoo.
    const resp = await this.rawPost(
      endpoint,
      { "Content-Type": "application/json", Cookie: `session_id=${sessionId}` },
      { jsonrpc: "2.0", method: "call", id: Date.now(), params: { model, method, args, kwargs } }
    );

    const json = this.parseNativeResponse(resp, endpoint);
    if (json.error) {
      const errMsg = json.error.data?.message ?? json.error.message ?? "Unknown RPC error";
      const errCode = json.error.code ?? "?";
      if (json.error.code === 100) throw new SessionExpiredError(`session_expired (code ${errCode}): ${errMsg}`);
      throw new OdooRpcError(
        `RPC ${model}.${method} (HTTP ${resp.status}, code ${errCode}): ${errMsg}`,
        json.error.data?.name ?? null
      );
    }
    return json.result;
  }

  // ─── Tag resolution ───────────────────────────────────────────────────────

  /**
   * Finds or creates project.tags by name and returns their Odoo integer IDs.
   */
  private async resolveTags(
    creds: SyncCredentials,
    sessionId: string,
    tagNames: string[]
  ): Promise<number[]> {
    if (tagNames.length === 0) return [];

    const existing: { id: number; name: string }[] = await this.jsonRpc(
      creds.odooUrl, sessionId, "project.tags", "search_read",
      [],
      { domain: [["name", "in", tagNames]], fields: ["id", "name"] }
    );

    const existingByName = new Map(existing.map((t) => [t.name, t.id]));
    const ids: number[] = [];

    for (const name of tagNames) {
      if (existingByName.has(name)) {
        ids.push(existingByName.get(name)!);
      } else {
        const newId: number = await this.jsonRpc(
          creds.odooUrl, sessionId, "project.tags", "create",
          [{ name }]
        );
        ids.push(newId);
      }
    }
    return ids;
  }

  // ─── HTML builder ─────────────────────────────────────────────────────────

  /**
   * Converts note entries to an HTML description for Odoo.
   * Each entry becomes one or more <p> tags.
   */
  buildHtml(entries: NoteEntry[]): string {
    const parts: string[] = [];
    for (const entry of entries) {
      switch (entry.type) {
        case "text": {
          const p = entry.params as NoteEntryTextParams;
          if (p.text.trim()) parts.push(`<p>${this.escapeHtml(p.text)}</p>`);
          break;
        }
        case "date": {
          const p = entry.params as NoteEntryDateParams;
          parts.push(`<p>📅 Date : ${p.date}</p>`);
          break;
        }
        case "geolocation": {
          const p = entry.params as NoteEntryGeolocationParams;
          const ts = new Date(p.timestamp).toISOString();
          parts.push(`<p>📍 Géolocalisation : ${p.latitude}, ${p.longitude} — ${this.escapeHtml(p.text)} — ${ts}</p>`);
          break;
        }
        case "audio":
          parts.push(`<p>🎙️ Enregistrement audio — ${new Date().toISOString()}</p>`);
          break;
        case "photo":
          parts.push(`<p>📷 Photo — ${new Date().toISOString()}</p>`);
          break;
        case "video":
          parts.push(`<p>🎥 Vidéo — ${new Date().toISOString()}</p>`);
          break;
      }
    }
    return parts.join("\n");
  }

  /**
   * Builds a GeoJSON MultiPoint string from all geolocation entries.
   * Returns null if there are no geolocation entries.
   * Coordinates are [longitude, latitude] per GeoJSON spec.
   */
  buildGeoMultiPoint(entries: NoteEntry[]): string | null {
    const geoEntries = entries.filter((e) => e.type === "geolocation");
    if (geoEntries.length === 0) return null;

    const coordinates = geoEntries.map((e) => {
      const p = e.params as NoteEntryGeolocationParams;
      return [p.longitude, p.latitude];
    });

    return JSON.stringify({ type: "MultiPoint", coordinates });
  }

  /**
   * Returns the first date entry's ISO string, or null.
   */
  private getFirstDate(entries: NoteEntry[]): string | null {
    const dateEntry = entries.find((e) => e.type === "date");
    if (!dateEntry) return null;
    return (dateEntry.params as NoteEntryDateParams).date;
  }

  // ─── Push ─────────────────────────────────────────────────────────────────

  /**
   * Pushes a single note to one server as a project.task: write() on the
   * task this note is linked to on that target, create() and
   * link otherwise. The server is then "synced" — or "pending" again when
   * the note changed while the push ran, since the server got the older
   * content — and the global status is re-derived.
   *
   * A link whose task was deleted on the server is never recreated
   * silently: write() answering MissingError marks the link deleted, drops
   * the server from the note's queue and raises RemoteRecordDeletedError;
   * so does a later push while only that deleted link exists, unless
   * options.recreateDeleted asks for a new task.
   */
  async pushNote(
    creds: SyncCredentials,
    noteId: string,
    options: { recreateDeleted?: boolean } = {}
  ): Promise<void> {
    const key = `${noteId}|${syncConfigIdOf(creds)}`;
    const previous = this._pushInFlight.get(key) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(() => this.pushNoteNow(creds, noteId, options));
    this._pushInFlight.set(key, current);
    try {
      await current;
    } finally {
      if (this._pushInFlight.get(key) === current) this._pushInFlight.delete(key);
    }
  }

  private async pushNoteNow(
    creds: SyncCredentials,
    noteId: string,
    options: { recreateDeleted?: boolean }
  ): Promise<void> {
    const note = await this.db.getNoteById(noteId);
    if (!note) throw new Error(`Note ${noteId} not found`);
    const fingerprint = pushedFingerprint(note);

    const configId = syncConfigIdOf(creds);
    const known = await this.db.findNoteLink(noteId, configId, TASK_MODEL, "create", true);
    if (known?.remoteState === "deleted" && !options.recreateDeleted) {
      await this.db.clearNotePerServerStatus(noteId, configId);
      await this.db.refreshNoteSyncStatus(noteId);
      throw new RemoteRecordDeletedError(`La tâche #${known.resId} a été supprimée sur ${creds.odooUrl}.`);
    }
    const link = known?.remoteState === "ok" ? known : null;

    await this.callWithAuth(creds, async (sessionId, odooVersion) => {
      const tagIds = await this.resolveTags(creds, sessionId, note.tags);
      const geoPoint = this.buildGeoMultiPoint(note.entries);
      const withGeo = geoPoint !== null && await this.hasTaskGeoField(creds, sessionId);
      const payload = this.buildTaskPayload(note, tagIds, odooVersion, withGeo ? geoPoint : null);
      const now = new Date().toISOString();

      if (link) {
        try {
          await this.jsonRpc(creds.odooUrl, sessionId, TASK_MODEL, "write", [
            [link.resId],
            payload,
          ]);
        } catch (e: unknown) {
          if (!(e instanceof OdooRpcError) || e.odooName !== "odoo.exceptions.MissingError") throw e;
          await this.db.setNoteLinkRemoteDeleted(link.id);
          await this.db.clearNotePerServerStatus(noteId, configId);
          await this.db.refreshNoteSyncStatus(noteId);
          throw new RemoteRecordDeletedError(`La tâche #${link.resId} a été supprimée sur ${creds.odooUrl}.`);
        }
        await this.db.setNoteLinkSyncedAt(link.id, now);
      }
      const createdId: number | null = link ? null : await this.jsonRpc(
        creds.odooUrl, sessionId, TASK_MODEL, "create",
        [payload]
      );

      // Settled under the note's lock: a note deleted meanwhile gets no link
      let noteGone = false;
      await this.db.updateNotePerServerStatus(noteId, async (perServer) => {
        const current = await this.db.getNoteById(noteId);
        if (!current) { noteGone = true; return; }
        if (createdId !== null) {
          await this.db.addNoteLink({
            id: uuidv4(),
            noteId,
            configId,
            model: TASK_MODEL,
            resId: createdId,
            kind: "create",
            remoteState: "ok",
            createdAt: now,
            lastSyncedAt: now,
          });
        }
        perServer[configId] = pushedFingerprint(current) === fingerprint ? "synced" : "pending";
      });
      if (noteGone) return;
      await this.db.setNoteSyncInfo(noteId, { lastSyncedAt: now });
      await this.db.refreshNoteSyncStatus(noteId);
    });
  }

  /** Whether project.task has geo_task_point on this server (cached). */
  private async hasTaskGeoField(creds: SyncCredentials, sessionId: string): Promise<boolean> {
    const key = `${creds.odooUrl}|${creds.database}`;
    const known = this._taskGeoField.get(key);
    if (known !== undefined) return known;
    const fields = await this.jsonRpc(
      creds.odooUrl, sessionId, TASK_MODEL, "fields_get",
      [["geo_task_point"]],
      { attributes: ["type"] }
    );
    const present = !!fields && typeof fields === "object" && "geo_task_point" in fields;
    this._taskGeoField.set(key, present);
    return present;
  }

  // ─── Poll ────────────────────────────────────────────────────────────────

  /**
   * Lightweight poll — fetches only IDs and write_date modified since lastSync.
   * Returns Odoo IDs of changed tasks.
   */
  async pollForChanges(creds: SyncCredentials, lastSync: Date): Promise<number[]> {
    return this.callWithAuth(creds, async (sessionId, _odooVersion) => {
      const results: { id: number; write_date: string }[] = await this.jsonRpc(
        creds.odooUrl, sessionId, "project.task", "search_read",
        [],
        {
          domain: [
            ["project_id", "=", false],
            ["write_date", ">", lastSync.toISOString()],
          ],
          fields: ["id", "write_date"],
          limit: 200,
          context: WITH_ARCHIVED,
        }
      );
      return results.map((r) => r.id);
    });
  }

  // ─── Pull ────────────────────────────────────────────────────────────────

  /**
   * Pulls tasks modified since lastSync from Odoo.
   * Updates metadata for the notes linked to those tasks on this server.
   * Returns the count of updated notes.
   *
   * Note: text entries are not re-parsed from HTML in v1 —
   * mobile is the primary author of content.
   */
  async pullNotes(creds: SyncCredentials, lastSync: Date): Promise<number> {
    return (await this.pullTasks(creds, lastSync.toISOString())).updated;
  }

  /**
   * Reads, page by page, the project-less tasks with write_date >= since
   * (archived ones included) and copies title, pinned, archived and — on
   * Odoo 17+ — done onto the notes linked to them on this target. A note
   * still "pending" or in "error" for this server is left
   * untouched: its local edits have not reached the server yet, and
   * overwriting them would lose them. A note the pull changes becomes
   * pending for its other servers. Returns the notes changed and the
   * highest write_date read (null when no task came back).
   */
  private async pullTasks(
    creds: SyncCredentials,
    since: string
  ): Promise<{ updated: number; maxWriteDate: string | null }> {
    return this.callWithAuth(creds, async (sessionId, odooVersion) => {
      const fields = [
        "id", "name", "priority", "active",
        "tag_ids", "date_deadline", "write_date",
        ...(odooVersion >= 17 ? ["state"] : []),
      ];

      const configId = syncConfigIdOf(creds);
      const links = await this.db.getNoteLinksForConfig(configId);
      const linkByResId = new Map(
        links
          .filter((l) => l.model === TASK_MODEL && l.kind === "create" && l.remoteState === "ok")
          .map((l) => [l.resId, l])
      );

      let updated = 0;
      let maxWriteDate: string | null = null;
      // Keyset paging. search_read returns write_date truncated to the
      // second while the server compares the stored value with its
      // microseconds, so "= T" matches nothing: the next page asks for
      // ">= T" minus the ids already read at T. A task rewritten during the
      // pull moves to the end without shifting the rows not read yet.
      let lastWriteDate = since;
      let seenAtLast: number[] = [];
      for (let page = 0; page < PULL_MAX_PAGES; page++) {
        const domain: any[] = [
          ["project_id", "=", false],
          ["write_date", ">=", lastWriteDate],
          ...(seenAtLast.length > 0 ? [["id", "not in", seenAtLast]] : []),
        ];
        const tasks: any[] = await this.jsonRpc(
          creds.odooUrl, sessionId, TASK_MODEL, "search_read",
          [],
          {
            domain,
            fields,
            limit: PULL_PAGE_SIZE,
            order: "write_date asc, id asc",
            context: WITH_ARCHIVED,
          }
        );

        for (const task of tasks) {
          if (task.write_date && (!maxWriteDate || task.write_date > maxWriteDate)) {
            maxWriteDate = task.write_date;
          }
          const link = linkByResId.get(task.id);
          if (!link) continue;
          if (await this.applyPulledTask(link.noteId, configId, task, odooVersion)) updated++;
        }
        if (tasks.length < PULL_PAGE_SIZE) break;
        const pageLast = tasks[tasks.length - 1].write_date;
        const atPageLast = tasks.filter((t) => t.write_date === pageLast).map((t) => t.id);
        seenAtLast = pageLast === lastWriteDate ? [...seenAtLast, ...atPageLast] : atPageLast;
        lastWriteDate = pageLast;
      }
      return { updated, maxWriteDate };
    });
  }

  /**
   * Copies one pulled task onto its note, under the note's sync lock so a
   * concurrent edit is either seen (the note is then pending and left
   * alone) or applied after. Returns whether the note changed; a changed
   * note becomes pending for its other servers.
   */
  private async applyPulledTask(
    noteId: string,
    configId: string,
    task: any,
    odooVersion: number
  ): Promise<boolean> {
    let changed = false;
    let applied = false;
    await this.db.updateNotePerServerStatus(noteId, async (perServer) => {
      const status = perServer[configId];
      if (status === "pending" || status === "error") return;
      const local = await this.db.getNoteById(noteId);
      if (!local) return;
      const updatedNote = {
        ...local,
        title: task.name,
        pinned: task.priority === "1",
        archived: !task.active,
        ...(odooVersion >= 17 ? { done: task.state === TASK_STATE_DONE } : {}),
      };
      changed = updatedNote.title !== local.title || updatedNote.pinned !== local.pinned
        || updatedNote.archived !== local.archived || updatedNote.done !== local.done;
      if (changed) await this.db.updateNote(noteId, updatedNote);
      perServer[configId] = "synced";
      applied = true;
    });
    if (!applied) return false;
    const now = new Date().toISOString();
    const link = await this.db.findNoteLink(noteId, configId, TASK_MODEL, "create");
    if (link) await this.db.setNoteLinkSyncedAt(link.id, now);
    if (changed) {
      await this.db.setNoteSyncInfo(noteId, { lastSyncedAt: now });
      // The note's other servers still hold the previous values
      await this.db.markNotePendingForConfigs(noteId, await this.db.getLiveLinkConfigIds(noteId, configId));
      this.onNotePulled?.(noteId);
    }
    await this.db.refreshNoteSyncStatus(noteId);
    return changed;
  }

  // ─── Sync all ────────────────────────────────────────────────────────────

  /** Notes syncAll would push to this config: pending or in error. */
  async pendingNoteIds(configId: string): Promise<string[]> {
    return this.db.getNoteIdsPendingForConfig(configId);
  }

  /**
   * Full bidirectional sync for one server:
   * 1. Push every note pending (or in error) for this config — syncConfigId,
   *    or the id derived from creds
   * 2. Pull the tasks written since the pull cursor of this config (first
   *    pull: a day before the oldest link synced, else everything), then
   *    move the cursor to the highest write_date read
   */
  async syncAll(creds: SyncCredentials, syncConfigId?: string): Promise<SyncResult> {
    const result: SyncResult = { pushed: 0, pulled: 0, errors: [] };
    const configId = syncConfigId ?? syncConfigIdOf(creds);

    for (const noteId of await this.db.getNoteIdsPendingForConfig(configId)) {
      try {
        await this.pushNote(creds, noteId);
        result.pushed++;
      } catch (e: unknown) {
        result.errors.push(`Push ${noteId}: ${e instanceof Error ? e.message : String(e)}`);
        // Deleted remote task: already dropped from the queue by pushNote
        if (e instanceof RemoteRecordDeletedError) continue;
        await this.db.setNotePerServerStatus(noteId, configId, "error").catch(() => {});
        await this.db.refreshNoteSyncStatus(noteId).catch(() => {});
      }
    }

    const cursorScope = configId;
    const oldestLink = (await this.db.getNoteLinksForConfig(configId))
      .map((l) => l.lastSyncedAt)
      .filter(Boolean)
      .sort()
      .at(0);
    const since = (await this.db.getSyncPullCursor(cursorScope))
      ?? (oldestLink
        ? new Date(new Date(oldestLink).getTime() - FIRST_PULL_CLOCK_MARGIN_MS).toISOString()
        : new Date(0).toISOString());
    try {
      const pulled = await this.pullTasks(creds, since);
      result.pulled = pulled.updated;
      if (pulled.maxWriteDate) await this.db.setSyncPullCursor(cursorScope, pulled.maxWriteDate);
    } catch (e: unknown) {
      result.errors.push(`Pull: ${e instanceof Error ? e.message : String(e)}`);
    }

    return result;
  }

  // ─── Database discovery ───────────────────────────────────────────────────

  /**
   * Fetches the list of available databases from a public Odoo endpoint.
   * Returns an empty array if the server does not expose the list.
   */
  async listDatabases(url: string): Promise<string[]> {
    const baseUrl = this.normalizeUrl(url);
    const endpoint = `${baseUrl}/web/database/list`;
    const resp = await this.rawPost(endpoint, { "Content-Type": "application/json" },
      { jsonrpc: "2.0", method: "call", id: 1, params: {} });
    const json = this.parseNativeResponse(resp, endpoint);
    if (json.error) throw new Error(json.error.data?.message ?? json.error.message ?? "Unknown error");
    if (!Array.isArray(json.result)) return [];
    return json.result as string[];
  }

  // ─── Odoo explorer ───────────────────────────────────────────────────────

  /**
   * Fetches the Odoo major version and the full list of installed models.
   */
  async getOdooExplorer(creds: SyncCredentials): Promise<{
    version: string;
    models: Array<{ name: string; model: string }>;
  }> {
    return this.callWithAuth(creds, async (sessionId, odooVersion) => {
      const rows: Array<{ name: string; model: string }> = await this.jsonRpc(
        creds.odooUrl, sessionId, "ir.model", "search_read",
        [],
        { domain: [], fields: ["name", "model"], order: "model asc", limit: 500 }
      );
      return {
        version: `Odoo ${odooVersion}`,
        models: rows.map((r) => ({ name: r.name, model: r.model })),
      };
    });
  }

  /**
   * Fetches field definitions and record count for one Odoo model.
   */
  async getOdooModelInfo(
    creds: SyncCredentials,
    modelName: string
  ): Promise<{
    count: number;
    fields: Array<{ name: string; fieldDescription: string; ttype: string }>;
  }> {
    return this.callWithAuth(creds, async (sessionId) => {
      const [rawFields, count] = await Promise.all([
        this.jsonRpc(
          creds.odooUrl, sessionId, "ir.model.fields", "search_read",
          [],
          { domain: [["model", "=", modelName]], fields: ["name", "field_description", "ttype"], order: "name asc", limit: 500 }
        ) as Promise<Array<{ name: string; field_description: string; ttype: string }>>,
        (this.jsonRpc(creds.odooUrl, sessionId, modelName, "search_count", [[]]) as Promise<number>)
          .catch(() => -1),
      ]);
      return {
        count,
        fields: rawFields.map((f) => ({
          name: f.name,
          fieldDescription: f.field_description,
          ttype: f.ttype,
        })),
      };
    });
  }

  /**
   * Returns the Odoo server version string (e.g. "17.0+e") from the public
   * /web/webclient/version_info endpoint. Returns null if unavailable.
   */
  async getServerVersion(url: string): Promise<string | null> {
    const baseUrl = this.normalizeUrl(url);
    const endpoint = `${baseUrl}/web/webclient/version_info`;
    try {
      const resp = await this.rawPost(endpoint, { "Content-Type": "application/json" },
        { jsonrpc: "2.0", method: "call", id: 1, params: {} });
      const json = this.parseNativeResponse(resp, endpoint);
      if (json.error || !json.result) return null;
      return (json.result.server_version as string) ?? null;
    } catch {
      return null;
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  /**
   * Makes a POST request.
   *
   * On Android native: uses the RawHttp plugin, which bypasses Android's
   * CookieHandler so manually-set Cookie headers are preserved on plain HTTP
   * connections to IP addresses. If the plugin is absent (old APK), throws a
   * clear error — fetch() cannot be used as a fallback on Android because the
   * WebView blocks cross-origin requests (CORS) to Odoo servers.
   *
   * On web (dev mode): uses fetch() directly.
   */
  private async rawPost(
    url: string,
    headers: Record<string, string>,
    body: object
  ): Promise<{ status: number; headers: Record<string, string | string[]>; data: any }> {
    if (Capacitor.isNativePlatform()) {
      try {
        const resp = await RawHttp.post({ url, headers, body: JSON.stringify(body) });
        return { status: resp.status, headers: resp.headers, data: resp.data };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.toLowerCase().includes("not implement")) {
          throw new Error(
            "Le plugin HTTP natif (RawHttp) n'est pas disponible. " +
            "Reconstruisez l'APK pour activer la synchronisation."
          );
        }
        throw e;
      }
    }
    // Web/dev path — fetch() works here (no Android WebView CORS restriction)
    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const text = await resp.text();
    const respHeaders: Record<string, string> = {};
    // Optional chaining: test mocks may omit headers; real fetch() always has it.
    resp.headers?.forEach?.((val: string, key: string) => { respHeaders[key] = val; });
    return { status: resp.status, headers: respHeaders, data: text };
  }

  /** Ensures the URL has an http(s) scheme; defaults to https. */
  private normalizeUrl(url: string): string {
    const trimmed = url.trim().replace(/\/+$/, "");
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    return `https://${trimmed}`;
  }

  /**
   * Returns the URL without a port suffix, for use with Android's WebKit
   * CookieManager. WebKit stores cookies by domain (ignoring port), so
   * setCookie/getCookies for http://host:8069 must use http://host to work.
   */
  private cookieUrl(url: string): string {
    return this.normalizeUrl(url).replace(/:\d+$/, "");
  }

  /**
   * Validates a CapacitorHttp response and returns its parsed JSON data.
   * Throws a descriptive error for non-2xx status or non-object data.
   */
  private parseNativeResponse(resp: { status: number; data: any }, url: string): any {
    const ok = resp.status >= 200 && resp.status < 300;
    if (!ok) {
      const preview = (typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data))
        .slice(0, 200).replace(/\s+/g, " ");
      throw new Error(`HTTP ${resp.status} depuis ${url} — ${preview}`);
    }
    // CapacitorHttp may return data as a string even with responseType:'json' in some
    // Android configurations. Attempt to parse if so.
    let data = resp.data;
    if (typeof data === "string") {
      try { data = JSON.parse(data); } catch {
        throw new Error(`Réponse non-JSON (HTTP ${resp.status}) de ${url} : ${data.slice(0, 200)}`);
      }
    }
    if (typeof data !== "object" || data === null) {
      throw new Error(`Réponse non-JSON (HTTP ${resp.status}) de ${url} : ${String(data).slice(0, 200)}`);
    }
    return data;
  }

  /**
   * Builds the project.task payload for create/write.
   * Excludes fields not available in older Odoo versions.
   */
  private buildTaskPayload(
    note: Note,
    tagIds: number[],
    odooVersion: number,
    geoPoint: string | null
  ): Record<string, any> {
    const payload: Record<string, any> = {
      name: note.title,
      description: this.buildHtml(note.entries),
      project_id: false,
      priority: note.pinned ? "1" : "0",
      active: !note.archived,
      tag_ids: [[6, 0, tagIds]],
      date_deadline: this.getFirstDate(note.entries),
    };

    // state field introduced in Odoo 17
    if (odooVersion >= 17) {
      payload.state = note.done ? TASK_STATE_DONE : "01_in_progress";
    }

    // geo_task_point: only when the note has positions AND the server has the field
    if (geoPoint !== null) {
      payload.geo_task_point = geoPoint;
    }

    return payload;
  }

  /** Session key of the older format, without the database; purged on login. */
  private legacySessionKey(creds: SyncCredentials): string | null {
    try {
      return StorageConstants.SYNC_SESSION_PREFIX + btoa(`${creds.odooUrl}|${creds.username}`);
    } catch {
      return null;
    }
  }


  /** Minimal HTML escaping for user-generated text. */
  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** Converts Application + database name to SyncCredentials. */
  static credentialsFrom(app: Application, database: string): SyncCredentials {
    return { odooUrl: app.url, username: app.username, password: app.password, database };
  }
}
