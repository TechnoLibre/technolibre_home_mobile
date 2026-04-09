import { CapacitorCookies } from "@capacitor/core";
import { RawHttp } from "../plugins/rawHttpPlugin";
import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";
import { DatabaseService } from "./databaseService";
import { Application } from "../models/application";
import {
  NoteEntry,
  NoteEntryGeolocationParams,
  NoteEntryTextParams,
  NoteEntryDateParams,
} from "../models/note";
import { StorageConstants } from "../constants/storage";

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
}

// ─── SyncService ──────────────────────────────────────────────────────────────

export class SyncService {
  private db: DatabaseService;
  /** Diagnostic trail of the last authenticate() call — shown in retry errors. */
  private _lastAuthDiag: string = "";

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
    const stored: StoredSession = { sessionId, odooMajorVersion };
    await SecureStoragePlugin.set({ key: this.sessionKey(creds), value: JSON.stringify(stored) });
    return stored;
  }

  /**
   * Returns the stored session. If missing or in the old plain-string format,
   * re-authenticates so the Odoo version is also captured.
   */
  private async getSession(creds: SyncCredentials): Promise<StoredSession> {
    try {
      const result = await SecureStoragePlugin.get({ key: this.sessionKey(creds) });
      const parsed = JSON.parse(result.value);
      if (parsed?.sessionId && parsed?.odooMajorVersion) return parsed as StoredSession;
      throw new Error("stale format");
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
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("session") || msg.includes("100") || msg.includes("401")) {
        // Invalidate stale cached session before re-authenticating
        await SecureStoragePlugin.remove({ key: this.sessionKey(creds) }).catch(() => {});
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
      if (json.error.code === 100) throw new Error(`session_expired (code ${errCode}): ${errMsg}`);
      throw new Error(`RPC ${model}.${method} (HTTP ${resp.status}, code ${errCode}): ${errMsg}`);
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
   * Pushes a single note to Odoo (create or update).
   * Stores the returned odoo_id on first push.
   */
  async pushNote(creds: SyncCredentials, noteId: string): Promise<void> {
    const note = await this.db.getNoteById(noteId);
    if (!note) throw new Error(`Note ${noteId} not found`);

    const syncInfo = await this.db.getNoteSyncInfo(noteId);

    await this.callWithAuth(creds, async (sessionId, odooVersion) => {
      const tagIds = await this.resolveTags(creds, sessionId, note.tags);
      const payload = this.buildTaskPayload(note, tagIds, odooVersion);

      if (syncInfo.odooId) {
        await this.jsonRpc(creds.odooUrl, sessionId, "project.task", "write", [
          [syncInfo.odooId],
          payload,
        ]);
      } else {
        const newId: number = await this.jsonRpc(
          creds.odooUrl, sessionId, "project.task", "create",
          [payload]
        );
        await this.db.setNoteSyncInfo(noteId, {
          odooId: newId,
          odooUrl: creds.odooUrl,
        });
      }

      await this.db.setNoteSyncInfo(noteId, {
        syncStatus: "synced",
        lastSyncedAt: new Date().toISOString(),
      });
    });
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
        }
      );
      return results.map((r) => r.id);
    });
  }

  // ─── Pull ────────────────────────────────────────────────────────────────

  /**
   * Pulls tasks modified since lastSync from Odoo.
   * Updates metadata for notes already known locally (matched by odoo_id).
   * Returns the count of updated notes.
   *
   * Note: text entries are not re-parsed from HTML in v1 —
   * mobile is the primary author of content.
   */
  async pullNotes(creds: SyncCredentials, lastSync: Date): Promise<number> {
    return this.callWithAuth(creds, async (sessionId, odooVersion) => {
      const fields = [
        "id", "name", "priority", "active",
        "tag_ids", "date_deadline", "write_date",
        ...(odooVersion >= 17 ? ["state"] : []),
      ];

      const tasks: any[] = await this.jsonRpc(
        creds.odooUrl, sessionId, "project.task", "search_read",
        [],
        {
          domain: [
            ["project_id", "=", false],
            ["write_date", ">", lastSync.toISOString()],
          ],
          fields,
          limit: 100,
          order: "write_date asc",
        }
      );

      const localNotes = await this.db.getNotesByOdooUrl(creds.odooUrl);
      const localByOdooId = new Map(
        localNotes
          .filter((n) => n.syncInfo.odooId !== null)
          .map((n) => [n.syncInfo.odooId!, n])
      );

      let updated = 0;
      for (const task of tasks) {
        const local = localByOdooId.get(task.id);
        if (!local) continue;

        const updatedNote = {
          ...local,
          title: task.name,
          pinned: task.priority === "1",
          archived: !task.active,
          ...(odooVersion >= 17 ? { done: task.state === "done" } : {}),
        };

        await this.db.updateNote(local.id, updatedNote);
        await this.db.setNoteSyncInfo(local.id, {
          syncStatus: "synced",
          lastSyncedAt: new Date().toISOString(),
        });
        updated++;
      }
      return updated;
    });
  }

  // ─── Sync all ────────────────────────────────────────────────────────────

  /**
   * Full bidirectional sync for a given config:
   * 1. Push all notes marked as 'pending' for this syncConfigId (or odooUrl fallback)
   * 2. Pull all tasks modified since the oldest local sync
   */
  async syncAll(creds: SyncCredentials, syncConfigId?: string): Promise<SyncResult> {
    const result: SyncResult = { pushed: 0, pulled: 0, errors: [] };

    const localNotes = syncConfigId
      ? await this.db.getNotesBySyncConfigId(syncConfigId)
      : await this.db.getNotesByOdooUrl(creds.odooUrl);
    const pending = localNotes.filter((n) => n.syncInfo.syncStatus === "pending");

    for (const note of pending) {
      try {
        await this.pushNote(creds, note.id);
        result.pushed++;
      } catch (e: unknown) {
        result.errors.push(`Push ${note.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const lastSynced = localNotes
      .map((n) => n.syncInfo.lastSyncedAt)
      .filter(Boolean)
      .sort()
      .at(0);

    const since = lastSynced ? new Date(lastSynced) : new Date(0);
    try {
      result.pulled = await this.pullNotes(creds, since);
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
   * Makes a POST request via the RawHttp native plugin, which bypasses
   * Android's CookieHandler so manually-set Cookie headers are preserved.
   * Returns a response shape compatible with parseNativeResponse().
   */
  private async rawPost(
    url: string,
    headers: Record<string, string>,
    body: object
  ): Promise<{ status: number; headers: Record<string, string | string[]>; data: any }> {
    const resp = await RawHttp.post({ url, headers, body: JSON.stringify(body) });
    return { status: resp.status, headers: resp.headers, data: resp.data };
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
    odooVersion: number
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
      payload.state = note.done ? "done" : "01_in_progress";
    }

    // geo_task_point is ERPLibre-specific; only send when there is data
    const geoPoint = this.buildGeoMultiPoint(note.entries);
    if (geoPoint !== null) {
      payload.geo_task_point = geoPoint;
    }

    return payload;
  }

  /** Derives a stable SecureStorage key from the credentials. */
  private sessionKey(creds: SyncCredentials): string {
    return StorageConstants.SYNC_SESSION_PREFIX + btoa(`${creds.odooUrl}|${creds.username}`);
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
