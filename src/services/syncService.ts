import { DatabaseService, NoteLink, OutboxOp } from "./databaseService";
import { OutboxBlockedError, OutboxRetryLaterError, OutboxService } from "./outboxService";
import { CapabilityService } from "./odoo/capabilityService";
import { PROJECT_MODEL, ProjectService } from "./odoo/projectService";
import { Application } from "../models/application";
import {
  Note,
  NoteEntry,
  NoteEntryGeolocationParams,
  NoteEntryTextParams,
  NoteEntryDateParams,
} from "../models/note";
import { syncConfigIdFor } from "../models/syncConfig";
import {
  OdooRpcClient,
  OdooRpcError,
  RemoteRecordDeletedError,
  StoredSession,
  SyncCredentials,
} from "./odoo/odooRpcClient";
import { v4 as uuidv4 } from "uuid";

export {
  OdooRpcError,
  RemoteRecordDeletedError,
  SessionExpiredError,
  syncSessionKey,
} from "./odoo/odooRpcClient";
export type { SyncCredentials } from "./odoo/odooRpcClient";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SyncResult {
  pushed: number;
  pulled: number;
  errors: string[];
}

/** Remote model a note is mirrored to by pushNote / pullNotes. */
const TASK_MODEL = "project.task";

/**
 * Minimum time between sending a task create and a retry that searches
 * its marker: longer than the HTTP read timeout plus Odoo's
 * default limit_time_real (120 s), so a create still running on the server
 * has committed — or been killed — before the search.
 */
const CREATE_QUIET_WINDOW_MS = 3 * 60 * 1000;

/** Tasks an ambiguous marker search lists for the user to pick from. */
const AMBIGUOUS_CANDIDATES_SHOWN = 5;

/** Outbox kind of the creation of a note's task on one server. */
export const TASK_CREATE = "task.create";

/**
 * Where a note's task is created on one server: in projectId, or, when
 * null, as a personal task (no project). Chosen once, at creation; later
 * writes leave the task's project alone.
 */
export interface TaskTarget {
  projectId: number | null;
  projectName?: string | null;
}

/**
 * Why a task.create operation waits for the user to choose its project
 * again: the project is gone or hidden from the user (project_missing), or
 * the server refused the creation (refused: rights, a constraint).
 */
const CHOOSE_AGAIN_REASONS = new Set(["project_missing", "refused"]);

/** Server exceptions a create retry cannot get past: the operation blocks. */
const REFUSED_ERRORS = new Set([
  "odoo.exceptions.AccessError",
  "odoo.exceptions.ValidationError",
  "odoo.exceptions.UserError",
  "odoo.exceptions.MissingError",
]);

/**
 * What a note needs before its task can reach one server:
 * - linked: the task exists; a push writes it;
 * - queued: its creation is in the outbox, due, retrying or blocked for a
 *   reason the user settles on the next tap (ambiguous);
 * - choose: the project must be chosen first. op is the creation waiting
 *   for that choice (incomplete, or blocked for a reason in
 *   CHOOSE_AGAIN_REASONS), or null when nothing was ever chosen; reason
 *   "deleted" (with deletedResId) when the linked task was deleted on the
 *   server and choosing recreates it; target is the choice to offer
 *   first: the operation's, else the server's last.
 */
export type TaskTargetState =
  | { state: "linked"; resId: number }
  | { state: "queued"; op: OutboxOp }
  | {
      state: "choose";
      op: OutboxOp | null;
      reason: string | null;
      target: TaskTarget | null;
      deletedResId?: number;
    };

/**
 * Text the app writes in a record it creates, searched to find that record
 * again when the answer to create() was lost.
 */
export function clientMarker(clientUuid: string): string {
  return `erplibre-mobile:${clientUuid}`;
}

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
 * First pull of a config (no cursor yet) starts this long before the
 * oldest link's last sync: that time comes from the device clock, task
 * write_dates from the server clock. Re-reading a task is harmless.
 */
const FIRST_PULL_CLOCK_MARGIN_MS = 24 * 60 * 60 * 1000;

/** task.create params of a target (none: a personal task). */
function targetParams(target: TaskTarget | null): Record<string, any> {
  return { projectId: target?.projectId ?? null, projectName: target?.projectName ?? null };
}

/** Fields of a note a push sends: a change here during a push re-queues it. */
function pushedFingerprint(note: Note): string {
  return JSON.stringify([note.title, note.done, note.archived, note.pinned, note.tags, note.entries]);
}

/** Sync config id of a set of credentials, as built by appToSyncConfig. */
export function syncConfigIdOf(creds: SyncCredentials): string {
  return syncConfigIdFor(creds.odooUrl, creds.username, creds.database);
}

// ─── SyncService ──────────────────────────────────────────────────────────────

export class SyncService {
  private db: DatabaseService;
  /** JSON-RPC transport and session store, shared with the other Odoo services. */
  readonly rpc: OdooRpcClient;
  /** Pending creations and one-shot operations, per note and server. */
  readonly outbox: OutboxService;
  /** Cached probes of what each server allows per model. */
  readonly capabilities: CapabilityService;
  /** Projects a new task can go to, per server, cached for offline. */
  readonly projects: ProjectService;
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
   * Tail of the syncAll runs per config id: a reconnect and a return to
   * the foreground firing together run one after the other.
   */
  private _syncAllChain = new Map<string, Promise<unknown>>();
  /**
   * Called with the id of each note a pull changed, so a screen showing
   * that note reloads it instead of saving its older copy over it.
   */
  onNotePulled: ((noteId: string) => void) | null = null;

  constructor(
    db: DatabaseService,
    rpc: OdooRpcClient = new OdooRpcClient(),
    outbox: OutboxService = new OutboxService(db)
  ) {
    this.db = db;
    this.rpc = rpc;
    this.outbox = outbox;
    this.capabilities = new CapabilityService(db, rpc);
    this.projects = new ProjectService(db, rpc);
    this.outbox.onRetryScheduled = (at) => this.onRetryScheduled?.(at);
    this.outbox.registerHandler(TASK_CREATE, (creds, op) => this.pushNote(creds, op.noteId));
  }

  // ─── Transport (OdooRpcClient) ────────────────────────────────────────────

  /** Logs in and stores the session; see OdooRpcClient.authenticate. */
  authenticate(creds: SyncCredentials): Promise<StoredSession> {
    return this.rpc.authenticate(creds);
  }

  private callWithAuth<T>(
    creds: SyncCredentials,
    fn: (sessionId: string, odooVersion: number) => Promise<T>
  ): Promise<T> {
    return this.rpc.callWithAuth(creds, fn);
  }

  private jsonRpc(
    odooUrl: string,
    sessionId: string,
    model: string,
    method: string,
    args: any[],
    kwargs: Record<string, any> = {}
  ): Promise<any> {
    return this.rpc.jsonRpc(odooUrl, sessionId, model, method, args, kwargs);
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
   * task this note is linked to on that target; without one, the creation
   * runs as the note's "task.create" outbox operation (see createTask).
   * The server is then "synced" — or "pending" again when the note changed
   * while the push ran, since the server got the older content — and the
   * global status is re-derived.
   *
   * A link whose task was deleted on the server is never recreated
   * silently: write() answering MissingError marks the link deleted, drops
   * the server from the note's queue and raises RemoteRecordDeletedError;
   * so does a later push while only that deleted link exists, unless
   * options.recreateDeleted asks for a new task or a task.create operation
   * for it is already queued (a recreate the user confirmed).
   *
   * A creation the outbox holds "blocked" or "incomplete" waits for the
   * user: pushNote raises OutboxBlockedError without contacting the
   * server, unless options.userInitiated (a tap on sync) runs it again.
   * options.adoptTaskId settles an "ambiguous" creation with the task the
   * user picked among the error's candidates. An "incomplete" creation
   * never runs, tap or not: its project is chosen first (setTaskTarget).
   * A creation queued here, with no choice made, goes to the server's last
   * chosen project (see setTaskTarget), else is a personal task.
   */
  async pushNote(
    creds: SyncCredentials,
    noteId: string,
    options: { recreateDeleted?: boolean; userInitiated?: boolean; adoptTaskId?: number } = {}
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
    options: { recreateDeleted?: boolean; userInitiated?: boolean; adoptTaskId?: number }
  ): Promise<void> {
    const note = await this.db.getNoteById(noteId);
    if (!note) throw new Error(`Note ${noteId} not found`);
    const fingerprint = pushedFingerprint(note);

    const configId = syncConfigIdOf(creds);
    const known = await this.db.findNoteLink(noteId, configId, TASK_MODEL, "create", true);
    const link = known?.remoteState === "ok" ? known : null;

    if (!link) {
      const queued = await this.outbox.find(noteId, configId, TASK_CREATE);
      if (known && !options.recreateDeleted && !queued) {
        await this.db.clearNotePerServerStatus(noteId, configId);
        await this.db.refreshNoteSyncStatus(noteId);
        throw new RemoteRecordDeletedError(`La tâche #${known.resId} a été supprimée sur ${creds.odooUrl}.`);
      }
      if (queued?.status === "incomplete") {
        throw new OutboxBlockedError(`La tâche attend le choix de son projet sur ${creds.odooUrl}.`, "incomplete");
      }
      if (queued?.status === "blocked" && !options.userInitiated) {
        throw new OutboxBlockedError(
          queued.lastError ?? queued.status,
          queued.params.blockedReason ?? queued.status,
          queued.params.candidates ?? []
        );
      }
      const op = queued ?? await this.outbox.enqueue({
        noteId, configId, kind: TASK_CREATE, params: targetParams(await this.lastTaskTarget(configId)),
      });
      await this.outbox.attempt(op.id, (running) => this.createTask(creds, running, options.adoptTaskId ?? null));
      return;
    }
    // A creation that linked its task but was cut short before its row
    // was deleted: the link is the outcome, the row is obsolete.
    const stale = await this.outbox.find(noteId, configId, TASK_CREATE);
    if (stale) await this.outbox.cancel(stale.id);

    await this.callWithAuth(creds, async (sessionId, odooVersion) => {
      const payload = await this.taskPayloadFor(creds, sessionId, note, odooVersion, link.clientUuid ?? null);
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
      const now = new Date().toISOString();
      await this.db.setNoteLinkSyncedAt(link.id, now);
      await this.settlePush(noteId, configId, fingerprint, now, null);
    });
  }

  /**
   * The "task.create" operation of a note on one server: creates the
   * project.task carrying the operation's client_uuid marker and links it.
   *
   * On a retry (attempts > 1) an earlier run may have created the task and
   * lost the answer, so the marker is searched first, archived tasks
   * included: one match is adopted (written with the current content),
   * none means create, and several block the operation as "ambiguous"
   * with the matching ids as candidates — which task is the note's is the
   * user's call, answered through adoptTaskId. A copy of the task made on
   * the server (duplicate, project copy) carries the marker too, and
   * archiving it does not end the ambiguity.
   *
   * The search cannot see a create the server is still running (its
   * transaction is not committed). params.createSentAt, stored just before
   * each create() is sent, dates the last one: a retry within
   * CREATE_QUIET_WINDOW_MS of it raises OutboxRetryLaterError instead,
   * whatever triggered it (tap, reconnect, restart). A createSentAt later
   * than now (the clock was set back) is reset to now, so the window ends
   * three minutes after the correction, not after the clock's offset.
   *
   * The task goes to params.projectId (null: no project). Before a create,
   * the project is looked up among the active ones, as the picker lists
   * them: gone, archived or hidden from the user, the operation blocks as
   * "project_missing", and the server stops offering it as its last
   * choice. A create the server refuses (REFUSED_ERRORS) blocks as
   * "refused", its createSentAt cleared since the server answered: a retry
   * would fail the same way. Either waits for the user to choose the
   * project again.
   */
  private async createTask(creds: SyncCredentials, op: OutboxOp, adoptTaskId: number | null): Promise<void> {
    const note = await this.db.getNoteById(op.noteId);
    if (!note) return;
    let createSentAt: string | undefined = op.params.createSentAt;
    if (createSentAt && new Date(createSentAt).getTime() > Date.now()) {
      // Stored under a clock that ran fast: the window restarts once, now
      createSentAt = new Date().toISOString();
      await this.outbox.setParams(op.id, { createSentAt });
    }
    if (adoptTaskId === null && createSentAt) {
      const quietUntil = new Date(new Date(createSentAt).getTime() + CREATE_QUIET_WINDOW_MS);
      if (quietUntil.getTime() > Date.now()) {
        throw new OutboxRetryLaterError(
          `La création précédente peut encore être en cours sur ${creds.odooUrl} ; `
            + `nouvel essai après ${quietUntil.toLocaleTimeString()}.`,
          quietUntil.toISOString()
        );
      }
    }
    const fingerprint = pushedFingerprint(note);
    await this.callWithAuth(creds, async (sessionId, odooVersion) => {
      const payload = await this.taskPayloadFor(creds, sessionId, note, odooVersion, op.clientUuid);
      let taskId: number | null = adoptTaskId;
      if (taskId === null && op.attempts > 1) {
        const found: Array<{ id: number }> = await this.jsonRpc(
          creds.odooUrl, sessionId, TASK_MODEL, "search_read",
          [],
          {
            domain: [["description", "ilike", clientMarker(op.clientUuid)]],
            fields: ["id"],
            limit: AMBIGUOUS_CANDIDATES_SHOWN,
            order: "id asc",
            context: WITH_ARCHIVED,
          }
        );
        if (found.length > 1) {
          throw new OutboxBlockedError(
            `Plusieurs tâches (${found.map((t) => `#${t.id}`).join(", ")}) portent la référence `
              + `${clientMarker(op.clientUuid)} sur ${creds.odooUrl}.`,
            "ambiguous",
            found.map((t) => t.id)
          );
        }
        if (found.length === 1) taskId = found[0].id;
      }
      if (taskId !== null) {
        await this.jsonRpc(creds.odooUrl, sessionId, TASK_MODEL, "write", [[taskId], payload]);
      } else {
        const projectId: number | null = op.params.projectId ?? null;
        if (projectId !== null) await this.checkProject(creds, op.configId, sessionId, projectId);
        await this.outbox.setParams(op.id, { createSentAt: new Date().toISOString() });
        try {
          taskId = await this.jsonRpc(creds.odooUrl, sessionId, TASK_MODEL, "create", [
            { ...payload, project_id: projectId ?? false },
          ]);
        } catch (e: unknown) {
          if (e instanceof OdooRpcError && e.odooName && REFUSED_ERRORS.has(e.odooName)) {
            // The server answered and rolled back: no create is in flight
            await this.outbox.setParams(op.id, { createSentAt: null });
            throw new OutboxBlockedError(`Création refusée par ${creds.odooUrl} : ${e.message}`, "refused");
          }
          throw e;
        }
      }
      const now = new Date().toISOString();
      await this.settlePush(op.noteId, op.configId, fingerprint, now, {
        id: uuidv4(),
        noteId: op.noteId,
        configId: op.configId,
        model: TASK_MODEL,
        resId: taskId!,
        kind: "create",
        remoteState: "ok",
        createdAt: now,
        lastSyncedAt: now,
        clientUuid: op.clientUuid,
      });
    });
  }

  /**
   * Raises OutboxBlockedError "project_missing" when projectId is not an
   * active project the user can see on this server, and then drops it as
   * the server's last choice so the picker no longer preselects it.
   */
  private async checkProject(
    creds: SyncCredentials,
    configId: string,
    sessionId: string,
    projectId: number
  ): Promise<void> {
    let found: Array<{ id: number }> = [];
    try {
      found = await this.jsonRpc(
        creds.odooUrl, sessionId, PROJECT_MODEL, "search_read",
        [],
        { domain: [["id", "=", projectId]], fields: ["id"], limit: 1 }
      );
    } catch (e: unknown) {
      // No right to read projects at all: the project is hidden as well
      if (!(e instanceof OdooRpcError) || e.odooName !== "odoo.exceptions.AccessError") throw e;
    }
    if (found.length === 0) {
      if ((await this.lastTaskTarget(configId))?.projectId === projectId) {
        await this.db.setSyncTargetPref({
          configId, kind: TASK_CREATE, params: targetParams(null), updatedAt: new Date().toISOString(),
        });
      }
      throw new OutboxBlockedError(
        `Le projet #${projectId} est introuvable, archivé ou inaccessible sur ${creds.odooUrl}.`,
        "project_missing"
      );
    }
  }

  // ─── Task target ──────────────────────────────────────────────────────────

  /** The project last chosen for new tasks on this server, if any. */
  async lastTaskTarget(configId: string): Promise<TaskTarget | null> {
    const pref = await this.db.getSyncTargetPref(configId, TASK_CREATE);
    if (!pref) return null;
    return { projectId: pref.params.projectId ?? null, projectName: pref.params.projectName ?? null };
  }

  /** See TaskTargetState. */
  async taskTargetState(noteId: string, configId: string): Promise<TaskTargetState> {
    const known = await this.db.findNoteLink(noteId, configId, TASK_MODEL, "create", true);
    if (known?.remoteState === "ok") return { state: "linked", resId: known.resId };
    const op = await this.outbox.find(noteId, configId, TASK_CREATE);
    if (op) {
      const reason = op.status === "incomplete" ? "incomplete" : op.params.blockedReason ?? null;
      if (op.status === "incomplete"
        || (op.status === "blocked" && reason !== null && CHOOSE_AGAIN_REASONS.has(reason))) {
        const target = "projectId" in op.params
          ? { projectId: op.params.projectId ?? null, projectName: op.params.projectName ?? null }
          : await this.lastTaskTarget(configId);
        return { state: "choose", op, reason, target };
      }
      return { state: "queued", op };
    }
    const target = await this.lastTaskTarget(configId);
    if (known) return { state: "choose", op: null, reason: "deleted", target, deletedResId: known.resId };
    return { state: "choose", op: null, reason: null, target };
  }

  /**
   * Records where the note's task goes on this server, before it is
   * pushed: queues its task.create operation with target, or puts the
   * waiting one (state "choose") back in the queue with it, and remembers
   * target as the server's last choice. For a task deleted on the
   * server, queuing it is the user's confirmation to recreate it (see
   * pushNote). "later" (projects unknown) queues the creation as
   * "incomplete", or parks the waiting one so, its former block reason
   * and error cleared (and its project, when that project was missing):
   * nothing is sent until a project is chosen. Does nothing for a note
   * already linked there or whose creation is queued for another reason.
   * Returns the operation.
   */
  async setTaskTarget(noteId: string, configId: string, target: TaskTarget | "later"): Promise<OutboxOp | null> {
    const current = await this.taskTargetState(noteId, configId);
    if (current.state === "linked" || current.state === "queued") return null;
    const now = new Date().toISOString();
    if (target !== "later") {
      await this.db.setSyncTargetPref({
        configId, kind: TASK_CREATE, params: targetParams(target), updatedAt: now,
      });
    }
    const op = current.state === "choose" ? current.op : null;
    if (!op) {
      return this.outbox.enqueue({
        noteId, configId, kind: TASK_CREATE,
        params: target === "later" ? {} : targetParams(target),
        status: target === "later" ? "incomplete" : "queued",
      });
    }
    if (target === "later") {
      await this.outbox.markIncomplete(op.id, {
        blockedReason: null,
        candidates: [],
        ...(current.reason === "project_missing" ? targetParams(null) : {}),
      });
    } else {
      await this.outbox.complete(op.id, { ...targetParams(target), blockedReason: null, candidates: [] });
    }
    return this.db.getOutboxOp(op.id);
  }

  /** The project.task values of a note, tags resolved, geo probed. */
  private async taskPayloadFor(
    creds: SyncCredentials,
    sessionId: string,
    note: Note,
    odooVersion: number,
    clientUuid: string | null
  ): Promise<Record<string, any>> {
    const tagIds = await this.resolveTags(creds, sessionId, note.tags);
    const geoPoint = this.buildGeoMultiPoint(note.entries);
    const withGeo = geoPoint !== null && await this.hasTaskGeoField(creds, sessionId);
    return this.buildTaskPayload(note, tagIds, odooVersion, withGeo ? geoPoint : null, clientUuid);
  }

  /**
   * Records a successful push under the note's lock: writes newLink when
   * given, then marks the server "synced", or "pending" when the note
   * changed since fingerprint was taken. A note deleted meanwhile gets no
   * link.
   */
  private async settlePush(
    noteId: string,
    configId: string,
    fingerprint: string,
    now: string,
    newLink: NoteLink | null
  ): Promise<void> {
    let noteGone = false;
    await this.db.updateNotePerServerStatus(noteId, async (perServer) => {
      const current = await this.db.getNoteById(noteId);
      if (!current) { noteGone = true; return; }
      if (newLink) await this.db.addNoteLink(newLink);
      perServer[configId] = pushedFingerprint(current) === fingerprint ? "synced" : "pending";
    });
    if (noteGone) return;
    await this.db.setNoteSyncInfo(noteId, { lastSyncedAt: now });
    await this.db.refreshNoteSyncStatus(noteId);
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
   * Lightweight poll — fetches only the ids of the tasks linked on this
   * server (any project) written since lastSync. Returns those ids; no
   * linked task means no request.
   */
  async pollForChanges(creds: SyncCredentials, lastSync: Date): Promise<number[]> {
    const linkedIds = [...(await this.linkedTaskIds(syncConfigIdOf(creds))).keys()];
    if (linkedIds.length === 0) return [];
    return this.callWithAuth(creds, async (sessionId, _odooVersion) => {
      const results: { id: number; write_date: string }[] = await this.jsonRpc(
        creds.odooUrl, sessionId, "project.task", "search_read",
        [],
        {
          domain: [
            ["id", "in", linkedIds],
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
   * Reads, page by page, the tasks linked on this target, whatever their
   * project, with write_date >= since (archived ones included) and copies title, pinned, archived and — on
   * Odoo 17+ — done onto the notes linked to them on this target. A note
   * still "pending" or in "error" for this server is left
   * untouched: its local edits have not reached the server yet, and
   * overwriting them would lose them. A note the pull changes becomes
   * pending for its other servers. Returns the notes changed and the
   * highest write_date read (null when no task came back, or none is
   * linked: then nothing is requested).
   */
  private async pullTasks(
    creds: SyncCredentials,
    since: string
  ): Promise<{ updated: number; maxWriteDate: string | null }> {
    const configId = syncConfigIdOf(creds);
    const linkByResId = await this.linkedTaskIds(configId);
    if (linkByResId.size === 0) return { updated: 0, maxWriteDate: null };
    const linkedIds = [...linkByResId.keys()];
    return this.callWithAuth(creds, async (sessionId, odooVersion) => {
      const fields = [
        "id", "name", "priority", "active",
        "tag_ids", "date_deadline", "write_date",
        ...(odooVersion >= 17 ? ["state"] : []),
      ];

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
          ["id", "in", linkedIds],
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

  /** Live task links of one config, by task id. */
  private async linkedTaskIds(configId: string): Promise<Map<number, NoteLink>> {
    return new Map(
      (await this.db.getNoteLinksForConfig(configId))
        .filter((l) => l.model === TASK_MODEL && l.kind === "create" && l.remoteState === "ok")
        .map((l) => [l.resId, l])
    );
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

  /** Called with next_attempt_at each time an outbox row turns failed. */
  onRetryScheduled: ((nextAttemptAt: string) => void) | null = null;

  /** See OutboxService.nextRetryAt. */
  async nextRetryAt(configId: string): Promise<string | null> {
    return this.outbox.nextRetryAt(configId);
  }

  /**
   * Whether a syncAll without force would send anything to this config: a
   * note pending or in error whose creation is not waiting, or a due
   * outbox operation.
   */
  async hasDueWork(configId: string): Promise<boolean> {
    const ops = await this.db.getOutboxOpsForConfig(configId);
    if (ops.some((op) => this.outbox.isDue(op))) return true;
    const waiting = new Set(ops.filter((op) => op.kind === TASK_CREATE).map((op) => op.noteId));
    return (await this.db.getNoteIdsPendingForConfig(configId)).some((id) => !waiting.has(id));
  }

  /**
   * Full bidirectional sync for one server:
   * 1. Push every note pending (or in error) for this config — syncConfigId,
   *    or the id derived from creds — then run the server's other due
   *    outbox operations
   * 2. Pull the tasks written since the pull cursor of this config (first
   *    pull: a day before the oldest link synced, else everything), then
   *    move the cursor to the highest write_date read
   *
   * Without options.force, a note whose task creation is waiting out its
   * retry delay, or waits for the user (blocked, incomplete), is skipped;
   * force (the network just came back) ignores the delay only.
   */
  async syncAll(
    creds: SyncCredentials,
    syncConfigId?: string,
    options: { force?: boolean } = {}
  ): Promise<SyncResult> {
    const configId = syncConfigId ?? syncConfigIdOf(creds);
    const previous = this._syncAllChain.get(configId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(() => this.syncAllNow(creds, configId, options));
    this._syncAllChain.set(configId, current);
    try {
      return await current;
    } finally {
      if (this._syncAllChain.get(configId) === current) this._syncAllChain.delete(configId);
    }
  }

  private async syncAllNow(
    creds: SyncCredentials,
    configId: string,
    options: { force?: boolean }
  ): Promise<SyncResult> {
    const result: SyncResult = { pushed: 0, pulled: 0, errors: [] };
    const notDue = new Set(
      (await this.db.getOutboxOpsForConfig(configId))
        .filter((op) => op.kind === TASK_CREATE && !this.outbox.isDue(op, options.force))
        .map((op) => op.noteId)
    );

    const pushed = new Set<string>();
    for (const noteId of await this.db.getNoteIdsPendingForConfig(configId)) {
      if (notDue.has(noteId)) continue;
      pushed.add(noteId);
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

    const drained = await this.outbox.drain(creds, configId, { force: options.force, skipNoteIds: pushed });
    result.pushed += drained.done;
    result.errors.push(...drained.errors);

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

  /** Databases the server lists publicly; see OdooRpcClient.listDatabases. */
  listDatabases(url: string): Promise<string[]> {
    return this.rpc.listDatabases(url);
  }

  /** Public server version string; see OdooRpcClient.getServerVersion. */
  getServerVersion(url: string): Promise<string | null> {
    return this.rpc.getServerVersion(url);
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

  // ─── Helpers ─────────────────────────────────────────────────────────────

  /**
   * Builds the project.task payload for create/write.
   * Excludes fields not available in older Odoo versions, and project_id,
   * which only a create sets (see createTask): a task moved to another
   * project on the server stays there. With clientUuid,
   * the description ends with its marker (see clientMarker), kept on every
   * write so the task stays findable.
   */
  private buildTaskPayload(
    note: Note,
    tagIds: number[],
    odooVersion: number,
    geoPoint: string | null,
    clientUuid: string | null = null
  ): Record<string, any> {
    const html = this.buildHtml(note.entries);
    const payload: Record<string, any> = {
      name: note.title,
      description: clientUuid
        ? [html, `<p><small>${clientMarker(clientUuid)}</small></p>`].filter(Boolean).join("\n")
        : html,
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
