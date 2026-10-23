import { CalendarActivity, DatabaseService, OutboxOp } from "./databaseService";
import { OutboxService } from "./outboxService";
import { OdooRpcClient, OdooRpcError, SyncCredentials } from "./odoo/odooRpcClient";
import { syncConfigIdFor } from "../models/syncConfig";

/** Model of the activities the calendar shows. */
const ACTIVITY_MODEL = "mail.activity";

/**
 * Outbox note id of the calendar's own operations: they act on an
 * activity, not on a note, and wait in the outbox like a note's.
 */
export const CALENDAR_NOTE = "calendar";

/** Outbox kinds of an activity marked done, or given a new deadline, from the calendar. */
export const CALENDAR_DONE = "calendar.done";
export const CALENDAR_RESCHEDULE = "calendar.reschedule";

/** Days before and after today the calendar reads (open activities overdue are read whatever their age). */
export const CALENDAR_PAST_DAYS = 30;
export const CALENDAR_FUTURE_DAYS = 90;

/** Activities one read returns per server, open and done each. */
export const CALENDAR_READ_LIMIT = 500;

/** sync_target_prefs kind of the users a server's calendar shows beside the connected one. */
const USERS_PREF = "calendar.users";

/** sync_target_prefs kind of the connected user's id on a server, kept for offline. */
const UID_PREF = "calendar.uid";

/** Server answers that refuse a calendar change for good (rights, a constraint): the change is undone. */
const REFUSED_ERRORS = new Set([
  "odoo.exceptions.AccessError", "odoo.exceptions.ValidationError", "odoo.exceptions.UserError",
]);

export interface CalendarUser {
  id: number;
  name: string;
}

export interface CalendarRead {
  activities: CalendarActivity[];
  /** The connected user on that server, as last read; null when never read. */
  uid: number | null;
  fromCache: boolean;
  error: string | null;
  /** A read returned CALENDAR_READ_LIMIT rows: some activities may be missing. */
  truncated: boolean;
}

/** "YYYY-MM-DD" of a date in the device's time zone. */
export function dayOf(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The day n days after day ("YYYY-MM-DD"), n negative for before. */
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00`);
  d.setDate(d.getDate() + n);
  return dayOf(d);
}

/** The first and last day the calendar reads, around today. */
export function calendarWindow(today: Date): { from: string; to: string } {
  const day = dayOf(today);
  return { from: addDays(day, -CALENDAR_PAST_DAYS), to: addDays(day, CALENDAR_FUTURE_DAYS) };
}

/**
 * The activities of the connected user and of the users chosen per
 * server, for the activity calendar, kept in activities_cache for
 * offline.
 *
 * refresh() reads, on one server, the open activities due up to
 * CALENDAR_FUTURE_DAYS ahead (overdue ones included, whatever their age)
 * and, on Odoo 17+, those done since CALENDAR_PAST_DAYS ago, which the
 * server archives when their type keeps done activities (Odoo 16 deletes
 * done activities: none are shown). An activity changed in the app and
 * still waiting in the outbox (pending) keeps its local state over what
 * the server sent.
 *
 * markDone() and reschedule() apply at once to the cache, and to the
 * server when online; offline, or when the server cannot be reached, the
 * change waits in the outbox (CALENDAR_DONE, CALENDAR_RESCHEDULE) and is
 * sent by the next sync. An activity gone on the server leaves the cache;
 * a change the server refuses for good (REFUSED_ERRORS) is undone in the
 * cache, its reason kept on the activity (lastError).
 *
 * The cache writes of one server (a refresh replacing it, a change, the
 * outcome of a queued one) run one at a time, so a change made during a
 * refresh is never overwritten by the server's older state.
 */
export class ActivityCalendarService {
  constructor(
    private db: DatabaseService,
    private rpc: OdooRpcClient,
    private outbox: OutboxService,
    private now: () => Date = () => new Date()
  ) {
    this.outbox.registerHandler(CALENDAR_DONE, (creds, op) => this.runQueued(creds, op));
    this.outbox.registerHandler(CALENDAR_RESCHEDULE, (creds, op) => this.runQueued(creds, op));
  }

  /** Tail of the cache writes per config id (see the class). */
  private _locks = new Map<string, Promise<unknown>>();

  private withLock<T>(configId: string, work: () => Promise<T>): Promise<T> {
    const previous = this._locks.get(configId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(work);
    this._locks.set(configId, current);
    return current;
  }

  /** The connected user's id on this server as last read, or null. */
  async knownUid(configId: string): Promise<number | null> {
    const uid = (await this.db.getSyncTargetPref(configId, UID_PREF))?.params.uid;
    return Number.isInteger(uid) ? uid : null;
  }

  /** The users shown beside the connected one on this server. */
  async users(configId: string): Promise<CalendarUser[]> {
    const pref = await this.db.getSyncTargetPref(configId, USERS_PREF);
    return (pref?.params.users ?? []).filter((u: any) => Number.isInteger(u?.id));
  }

  async setUsers(configId: string, users: CalendarUser[]): Promise<void> {
    const unique = [...new Map(users.map((u) => [u.id, u])).values()];
    await this.db.setSyncTargetPref({
      configId, kind: USERS_PREF, params: { users: unique }, updatedAt: this.now().toISOString(),
    });
  }

  /**
   * The members of the connected user's sales teams (crm.team member_ids),
   * none when the server has no CRM.
   */
  async salesTeamUsers(creds: SyncCredentials): Promise<CalendarUser[]> {
    const uid = await this.rpc.currentUid(creds);
    let teams: Array<{ member_ids: number[] }>;
    try {
      teams = await this.rpc.searchRead(creds, "crm.team", [["member_ids", "in", [uid]]], ["member_ids"]);
    } catch (e: unknown) {
      if (e instanceof OdooRpcError && e.odooName === "builtins.KeyError") return [];
      throw e;
    }
    const ids = [...new Set(teams.flatMap((t) => t.member_ids ?? []))].filter((id) => id !== uid);
    if (ids.length === 0) return [];
    const users = await this.rpc.searchRead<{ id: number; name: string }>(creds, "res.users", [["id", "in", ids]], ["name"]);
    return users.map((u) => ({ id: u.id, name: u.name }));
  }

  /** The cached activities of one server. */
  async cached(configId: string): Promise<CalendarActivity[]> {
    return this.db.getCalendarActivities(configId);
  }

  /**
   * See the class: online, read the server and replace its cache; else, or
   * on failure, the cache. The connected user's id is kept per server, so
   * the cache still tells the user's activities apart offline.
   */
  async refresh(creds: SyncCredentials, options: { online: boolean }): Promise<CalendarRead> {
    const configId = syncConfigIdFor(creds.odooUrl, creds.username, creds.database);
    let error: string | null = null;
    if (options.online) {
      try {
        const uid = await this.rpc.currentUid(creds);
        if (uid !== await this.knownUid(configId)) {
          await this.db.setSyncTargetPref({ configId, kind: UID_PREF, params: { uid }, updatedAt: this.now().toISOString() });
        }
        const userIds = [uid, ...(await this.users(configId)).map((u) => u.id)];
        const { activities: read, truncated } = await this.read(creds, configId, userIds);
        const activities = await this.withLock(configId, async () => {
          const pending = (await this.cached(configId)).filter((a) => a.pending);
          const merged = new Map(read.map((a) => [a.resId, a]));
          for (const a of pending) merged.set(a.resId, a);
          const all = [...merged.values()];
          await this.db.replaceCalendarActivities(configId, all);
          return all;
        });
        return { activities, uid, fromCache: false, error: null, truncated };
      } catch (e: unknown) {
        error = e instanceof Error ? e.message : String(e);
      }
    }
    return {
      activities: await this.cached(configId), uid: await this.knownUid(configId), fromCache: true, error, truncated: false,
    };
  }

  /**
   * The activities of userIds: the open ones due from today to the end of
   * the window, then the overdue ones, the most recent first, each read
   * with its own limit so a long backlog never hides what is coming; and on
   * 17+ the done ones. A done one sits on the local day it was archived
   * (write_date, UTC), as the app's own markDone puts it, rather than on
   * date_done, a UTC day.
   */
  private async read(
    creds: SyncCredentials,
    configId: string,
    userIds: number[]
  ): Promise<{ activities: CalendarActivity[]; truncated: boolean }> {
    const version = await this.rpc.odooVersion(creds);
    const { from, to } = calendarWindow(this.now());
    const today = dayOf(this.now());
    const fields = ["res_model", "res_id", "res_name", "activity_type_id", "summary", "date_deadline", "user_id"];
    const coming = await this.rpc.searchRead<any>(creds, ACTIVITY_MODEL,
      [["user_id", "in", userIds], ["date_deadline", ">=", today], ["date_deadline", "<=", to]], fields,
      { order: "date_deadline asc, id asc", limit: CALENDAR_READ_LIMIT });
    const overdue = await this.rpc.searchRead<any>(creds, ACTIVITY_MODEL,
      [["user_id", "in", userIds], ["date_deadline", "<", today]], fields,
      { order: "date_deadline desc, id desc", limit: CALENDAR_READ_LIMIT });
    const done = version >= 17
      ? await this.rpc.searchRead<any>(creds, ACTIVITY_MODEL,
          [["user_id", "in", userIds], ["active", "=", false], ["date_done", ">=", from]], [...fields, "date_done", "write_date"],
          { order: "date_done desc, id desc", limit: CALENDAR_READ_LIMIT, context: { active_test: false } })
      : [];
    const open = [...coming, ...overdue];
    const truncated = [coming, overdue, done].some((rows) => rows.length >= CALENDAR_READ_LIMIT);
    const fetchedAt = this.now().toISOString();
    const many2one = (v: any): [number | null, string | null] => (Array.isArray(v) ? [v[0], v[1] ?? null] : [null, null]);
    const toActivity = (r: any, isDone: boolean): CalendarActivity => {
      const [typeId, typeName] = many2one(r.activity_type_id);
      const [userId, userName] = many2one(r.user_id);
      return {
        configId, resId: r.id, resModel: r.res_model, recordId: r.res_id, recordName: r.res_name || `${r.res_model} #${r.res_id}`,
        typeId, typeName, summary: r.summary || "", deadline: String(r.date_deadline), userId, userName,
        done: isDone, dateDone: isDone ? doneDay(r) : null, pending: false, fetchedAt,
      };
    };
    return { activities: [...open.map((r) => toActivity(r, false)), ...done.map((r) => toActivity(r, true))], truncated };
  }

  /** Marks an activity done (action_feedback); see the class for when it is sent. */
  async markDone(creds: SyncCredentials, activity: CalendarActivity, options: { online: boolean }): Promise<void> {
    await this.apply(creds, activity, { done: true, dateDone: dayOf(this.now()) }, CALENDAR_DONE, {}, options);
  }

  /** Gives an activity a new deadline ("YYYY-MM-DD"); see the class for when it is sent. */
  async reschedule(
    creds: SyncCredentials,
    activity: CalendarActivity,
    day: string,
    options: { online: boolean }
  ): Promise<void> {
    await this.apply(creds, activity, { deadline: day }, CALENDAR_RESCHEDULE, { deadline: day }, options);
  }

  /**
   * Applies change to the cached activity (pending), queues the
   * operation, and runs it now when online. A run that fails leaves the
   * operation to the outbox's retries; one the server refuses is raised to
   * the caller, the change undone (see runQueued). One already queued for
   * the same activity and kind is replaced, its latest change being what
   * counts; one already running is left to finish, the new one running
   * after it. The state before the change is kept in the operation's params
   * (before) to undo a refusal.
   */
  private async apply(
    creds: SyncCredentials,
    activity: CalendarActivity,
    change: Partial<CalendarActivity>,
    kind: string,
    params: Record<string, any>,
    options: { online: boolean }
  ): Promise<void> {
    const op = await this.withLock(activity.configId, async () => {
      const current = (await this.cached(activity.configId)).find((a) => a.resId === activity.resId) ?? activity;
      await this.db.putCalendarActivity({ ...current, ...change, pending: true, lastError: null });
      let before = { done: current.done, dateDone: current.dateDone, deadline: current.deadline };
      for (const queued of await this.outbox.findAll(CALENDAR_NOTE, activity.configId, kind)) {
        if (queued.params.activityId !== activity.resId || queued.status === "running") continue;
        // The state before the first of the replaced changes is the one to come back to
        before = queued.params.before ?? before;
        await this.outbox.cancel(queued.id);
      }
      return this.outbox.enqueue({
        noteId: CALENDAR_NOTE, configId: activity.configId, kind,
        params: { ...params, activityId: activity.resId, before },
      });
    });
    if (!options.online) return;
    try {
      await this.runQueued(creds, op);
    } catch (e: unknown) {
      if (e instanceof CalendarRefusedError) throw e;
      // Kept in the outbox: the next sync sends it
    }
  }

  /**
   * Runs one queued calendar operation as an outbox attempt. On Odoo 17+
   * a done one first reads the activity's active flag: archived means done
   * already, and action_feedback would mark it done, and post that, again.
   * An activity gone (MissingError, or not found) leaves the cache. A done
   * one also turns the note link of that activity, if any, done.
   */
  private async runQueued(creds: SyncCredentials, op: OutboxOp): Promise<void> {
    let refused: string | null = null;
    await this.outbox.attempt(op.id, async (running) => {
      const activityId: number = running.params.activityId;
      let gone = false;
      try {
        if (running.kind === CALENDAR_DONE) {
          const version = await this.rpc.odooVersion(creds);
          const rows = version >= 17
            ? await this.rpc.searchRead<{ id: number; active: boolean }>(creds, ACTIVITY_MODEL,
                [["id", "=", activityId]], ["active"], { limit: 1, context: { active_test: false } })
            : [{ id: activityId, active: true }];
          gone = rows.length === 0;
          if (!gone && rows[0].active !== false) {
            await this.rpc.callKw(creds, ACTIVITY_MODEL, "action_feedback", [[activityId]], { feedback: false });
          }
        } else {
          await this.rpc.callKw(creds, ACTIVITY_MODEL, "write", [[activityId], { date_deadline: running.params.deadline }]);
        }
      } catch (e: unknown) {
        if (!(e instanceof OdooRpcError)) throw e;
        if (e.odooName && REFUSED_ERRORS.has(e.odooName)) refused = e.message;
        else if (e.odooName === "odoo.exceptions.MissingError") gone = true;
        else throw e;
      }
      await this.withLock(running.configId, async () => {
        if (gone) {
          await this.db.deleteCalendarActivity(running.configId, activityId);
          return;
        }
        const cached = (await this.cached(running.configId)).find((a) => a.resId === activityId);
        const others = [
          ...await this.outbox.findAll(CALENDAR_NOTE, running.configId, CALENDAR_DONE),
          ...await this.outbox.findAll(CALENDAR_NOTE, running.configId, CALENDAR_RESCHEDULE),
        ].some((o) => o.id !== running.id && o.params.activityId === activityId);
        if (!cached) return;
        // Refused for good: back to the state before the change, with the reason
        const undone = refused !== null && running.params.before ? running.params.before : {};
        await this.db.putCalendarActivity({ ...cached, ...undone, pending: others, lastError: refused });
      });
      if (gone || refused !== null) return;
      if (running.kind === CALENDAR_DONE) {
        for (const link of await this.db.getNoteLinksForConfig(running.configId)) {
          if (link.kind === "activity" && link.resId === activityId && link.remoteState === "ok") {
            await this.db.setNoteLinkDone(link.id);
          }
        }
      }
    });
    if (refused !== null) throw new CalendarRefusedError(refused);
  }
}

/** A calendar change the server refused for good; the change is undone in the cache. */
export class CalendarRefusedError extends Error {}

/**
 * The local day a done activity was archived: its write_date (UTC
 * "YYYY-MM-DD HH:MM:SS") in the device's time zone, else its date_done.
 */
function doneDay(r: any): string | null {
  if (r.write_date) {
    const d = new Date(`${String(r.write_date).replace(" ", "T")}Z`);
    if (!Number.isNaN(d.getTime())) return dayOf(d);
  }
  return r.date_done ? String(r.date_done).slice(0, 10) : null;
}
