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

// ─── SyncService ──────────────────────────────────────────────────────────────

export class SyncService {
  private db: DatabaseService;

  constructor(db: DatabaseService) {
    this.db = db;
  }

  // ─── Authentication ───────────────────────────────────────────────────────

  /**
   * Authenticates with an Odoo instance and stores the session ID in
   * SecureStorage. Returns the session ID.
   */
  async authenticate(creds: SyncCredentials): Promise<string> {
    const response = await fetch(`${creds.odooUrl}/web/session/authenticate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "call",
        id: 1,
        params: {
          db: creds.database,
          login: creds.username,
          password: creds.password,
        },
      }),
    });

    const json = await response.json();
    if (json.error) throw new Error(`Odoo auth error: ${json.error.data?.message ?? json.error.message}`);

    const uid = json.result?.uid;
    if (!uid) throw new Error("Authentication failed — invalid credentials");

    const sessionId: string = json.result?.session_id ?? "";
    await SecureStoragePlugin.set({
      key: this.sessionKey(creds),
      value: sessionId,
    });
    return sessionId;
  }

  /**
   * Retrieves the stored session ID, re-authenticates if missing or expired.
   */
  private async getSession(creds: SyncCredentials): Promise<string> {
    try {
      const result = await SecureStoragePlugin.get({ key: this.sessionKey(creds) });
      return result.value;
    } catch {
      return this.authenticate(creds);
    }
  }

  /**
   * Wraps a JSON-RPC call with automatic re-auth on session expiry.
   * Retries once after re-authenticating.
   */
  private async callWithAuth<T>(
    creds: SyncCredentials,
    fn: (sessionId: string) => Promise<T>
  ): Promise<T> {
    const sessionId = await this.getSession(creds);
    try {
      return await fn(sessionId);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("session") || msg.includes("100") || msg.includes("401")) {
        const newSession = await this.authenticate(creds);
        return fn(newSession);
      }
      throw e;
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
    const response = await fetch(`${odooUrl}/web/dataset/call_kw`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `session_id=${sessionId}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "call",
        id: Date.now(),
        params: { model, method, args, kwargs },
      }),
    });

    const json = await response.json();
    if (json.error) {
      const errMsg = json.error.data?.message ?? json.error.message ?? "Unknown RPC error";
      if (json.error.code === 100) throw new Error(`session_expired: ${errMsg}`);
      throw new Error(`RPC error on ${model}.${method}: ${errMsg}`);
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

    await this.callWithAuth(creds, async (sessionId) => {
      const tagIds = await this.resolveTags(creds, sessionId, note.tags);

      const payload: Record<string, any> = {
        name: note.title,
        description: this.buildHtml(note.entries),
        project_id: false,
        priority: note.pinned ? "1" : "0",
        active: !note.archived,
        state: note.done ? "done" : "01_in_progress",
        tag_ids: [[6, 0, tagIds]],
        date_deadline: this.getFirstDate(note.entries),
        geo_task_point: this.buildGeoMultiPoint(note.entries),
      };

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
    return this.callWithAuth(creds, async (sessionId) => {
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
    return this.callWithAuth(creds, async (sessionId) => {
      const tasks: any[] = await this.jsonRpc(
        creds.odooUrl, sessionId, "project.task", "search_read",
        [],
        {
          domain: [
            ["project_id", "=", false],
            ["write_date", ">", lastSync.toISOString()],
          ],
          fields: [
            "id", "name", "priority", "active", "state",
            "tag_ids", "date_deadline", "write_date",
          ],
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

        // Update metadata — preserve mobile entries
        const updatedNote = {
          ...local,
          title: task.name,
          pinned: task.priority === "1",
          archived: !task.active,
          done: task.state === "done",
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
   * Full bidirectional sync:
   * 1. Push all notes marked as 'pending' for this Odoo URL
   * 2. Pull all tasks modified since the oldest local sync
   */
  async syncAll(creds: SyncCredentials): Promise<SyncResult> {
    const result: SyncResult = { pushed: 0, pulled: 0, errors: [] };

    const localNotes = await this.db.getNotesByOdooUrl(creds.odooUrl);
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

  // ─── Helpers ─────────────────────────────────────────────────────────────

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
