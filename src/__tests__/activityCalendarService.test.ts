import { describe, it, expect, beforeEach, vi } from "vitest";
import { DatabaseService } from "../services/databaseService";
import { OutboxService } from "../services/outboxService";
import {
  ActivityCalendarService, CALENDAR_DONE, CALENDAR_NOTE, CALENDAR_RESCHEDULE, CalendarRefusedError,
} from "../services/activityCalendarService";
import { OdooRpcError, SyncCredentials } from "../services/odoo/odooRpcClient";
import { addActivitiesCacheTable } from "../services/migrations/addActivitiesCacheTable";
import { addSyncTargetTables } from "../services/migrations/addSyncTargetTables";

const CREDS: SyncCredentials = { odooUrl: "https://odoo.example.com", username: "u", password: "p", database: "db" };
const CONFIG = "https://odoo.example.com|u|db";
const NOW = new Date(2026, 9, 23, 10, 0);

/**
 * Stand-in for OdooRpcClient: uid 2, Odoo version, the activities each
 * search answers (open, done), and a record of the calls; fail makes
 * every call throw it.
 */
function fakeRpc(options: {
  version?: number; open?: any[]; overdue?: any[]; done?: any[]; fail?: Error; active?: boolean; gone?: boolean; teams?: any;
  refuse?: string;
} = {}) {
  const calls: any[] = [];
  return {
    calls,
    currentUid: async () => { if (options.fail) throw options.fail; return 2; },
    odooVersion: async () => options.version ?? 17,
    searchRead: async (_c: any, model: string, domain: any[], fields: string[], opts: any = {}) => {
      calls.push({ model, method: "search_read", domain, fields, opts });
      if (options.fail) throw options.fail;
      if (model === "crm.team") {
        if (options.teams instanceof Error) throw options.teams;
        return options.teams ?? [];
      }
      if (model === "res.users") return domain[0][2].map((id: number) => ({ id, name: `User ${id}` }));
      if (domain[0][0] === "id") return options.gone ? [] : [{ id: domain[0][2], active: options.active ?? true }];
      if (domain.some((d: any) => d[0] === "active")) return options.done ?? [];
      return domain.some((d: any) => d[1] === "<") ? options.overdue ?? [] : options.open ?? [];
    },
    callKw: async (_c: any, model: string, method: string, args: any[], kwargs: any) => {
      calls.push({ model, method, args, kwargs });
      if (options.fail) throw options.fail;
      if (options.gone) throw new OdooRpcError("gone", "odoo.exceptions.MissingError");
      if (options.refuse) throw new OdooRpcError("not yours", options.refuse);
      return true;
    },
  } as any;
}

const row = (over: any = {}) => ({
  id: 41, res_model: "crm.lead", res_id: 7, res_name: "Deal", activity_type_id: [3, "Call"], summary: "Call back",
  date_deadline: "2026-10-25", user_id: [2, "Me"], ...over,
});

describe("ActivityCalendarService", () => {
  let db: DatabaseService;
  let outbox: OutboxService;

  beforeEach(async () => {
    db = new DatabaseService();
    await db.initialize();
    await addSyncTargetTables(db);
    await addActivitiesCacheTable(db);
    await db.createSyncOutboxTable();
    await db.createNoteLinksTable();
    outbox = new OutboxService(db, () => NOW);
  });

  const service = (rpc: any) => new ActivityCalendarService(db, rpc, outbox, () => NOW);

  it("reads my open activities up to 90 days ahead, overdue included, and on 17+ those done in the last 30", async () => {
    const rpc = fakeRpc({
      open: [row()], overdue: [row({ id: 40, date_deadline: "2026-01-02" })],
      done: [row({ id: 42, date_done: "2026-10-20", write_date: "2026-10-21 23:30:00" })],
    });
    const s = service(rpc);
    await s.setUsers(CONFIG, [{ id: 9, name: "Lee" }]);
    const read = await s.refresh(CREDS, { online: true });
    const [coming, overdue, done] = rpc.calls.filter((c: any) => c.model === "mail.activity");
    expect(coming.domain).toEqual([["user_id", "in", [2, 9]], ["date_deadline", ">=", "2026-10-23"], ["date_deadline", "<=", "2027-01-21"]]);
    expect(overdue.domain).toEqual([["user_id", "in", [2, 9]], ["date_deadline", "<", "2026-10-23"]]);
    expect(overdue.opts.order).toBe("date_deadline desc, id desc");
    expect(done.domain).toEqual([["user_id", "in", [2, 9]], ["active", "=", false], ["date_done", ">=", "2026-09-23"]]);
    expect(done.opts.context).toEqual({ active_test: false });
    expect(read).toMatchObject({ uid: 2, fromCache: false, error: null, truncated: false });
    expect(read.activities.map((a) => [a.resId, a.done])).toEqual([[41, false], [40, false], [42, true]]);
    // Archived at 23:30 UTC: the device's day, as markDone puts it
    expect(read.activities[2].dateDone).toBe(new Date(Date.UTC(2026, 9, 21, 23, 30)).toLocaleDateString("sv-SE"));
    expect(read.activities[0]).toMatchObject({
      recordName: "Deal", resModel: "crm.lead", recordId: 7, typeName: "Call", userId: 2, deadline: "2026-10-25",
    });
    expect((await s.cached(CONFIG)).map((a) => a.resId).sort()).toEqual([40, 41, 42]);
  });

  it("reads no done activities on Odoo 16, which deletes them", async () => {
    const rpc = fakeRpc({ version: 16, open: [row()] });
    await service(rpc).refresh(CREDS, { online: true });
    expect(rpc.calls.filter((c: any) => c.model === "mail.activity")).toHaveLength(2);
  });

  it("says when a read was cut at its limit", async () => {
    const many = Array.from({ length: 500 }, (_, i) => row({ id: i + 1 }));
    expect((await service(fakeRpc({ open: many })).refresh(CREDS, { online: true })).truncated).toBe(true);
  });

  it("keeps the connected user known offline, once read online", async () => {
    await service(fakeRpc({ open: [row()] })).refresh(CREDS, { online: true });
    expect((await service(fakeRpc()).refresh(CREDS, { online: false })).uid).toBe(2);
    expect((await service(fakeRpc({ fail: new TypeError("Failed to fetch") })).refresh(CREDS, { online: true })).uid).toBe(2);
  });

  it("undoes a change the server refuses for good, keeps the reason, and raises it", async () => {
    const s = service(fakeRpc({ open: [row()] }));
    const [a] = (await s.refresh(CREDS, { online: true })).activities;
    const err = await service(fakeRpc({ refuse: "odoo.exceptions.AccessError" }))
      .reschedule(CREDS, a, "2026-11-02", { online: true }).catch((e) => e);
    expect(err).toBeInstanceOf(CalendarRefusedError);
    expect((await s.cached(CONFIG))[0]).toMatchObject({ deadline: "2026-10-25", pending: false, lastError: expect.stringContaining("not yours") });
    expect(await db.getOutboxOpsForConfig(CONFIG)).toEqual([]);
  });

  it("does not lose a change made while a refresh is replacing the cache", async () => {
    const s = service(fakeRpc({ open: [row()] }));
    const [a] = (await s.refresh(CREDS, { online: true })).activities;
    // The refresh is held between its look at the pending changes and its replace
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const replace = db.replaceCalendarActivities.bind(db);
    vi.spyOn(db, "replaceCalendarActivities").mockImplementation(async (...args) => { await gate; return replace(...args); });
    const refreshing = s.refresh(CREDS, { online: true });
    await new Promise((r) => setTimeout(r, 0));
    const changing = s.reschedule(CREDS, a, "2026-11-02", { online: false });
    await new Promise((r) => setTimeout(r, 0));
    release();
    await refreshing;
    await changing;
    vi.restoreAllMocks();
    expect((await s.cached(CONFIG))[0]).toMatchObject({ deadline: "2026-11-02", pending: true });
  });

  it("moves the cached activities with a respelled server url", async () => {
    await db.addSyncColumnsToNotes();
    await db.addSyncConfigIdColumn();
    await db.addSelectedSyncConfigIdsColumn();
    await db.addSyncPerServerStatusColumn();
    await db.createSyncPullCursorsTable();
    await db.createServerCapabilitiesTable();
    await db.createRemoteRecordsCacheTable();
    const s = service(fakeRpc({ open: [row()] }));
    await s.refresh(CREDS, { online: true });
    await db.renameSyncConfigId(CONFIG, "https://new.example.com|u|db");
    expect(await s.cached(CONFIG)).toEqual([]);
    expect((await s.cached("https://new.example.com|u|db"))[0]).toMatchObject({ resId: 41, configId: "https://new.example.com|u|db" });
  });

  it("serves the cache offline, and with the error when the server fails", async () => {
    await service(fakeRpc({ open: [row()] })).refresh(CREDS, { online: true });
    const offline = await service(fakeRpc()).refresh(CREDS, { online: false });
    expect(offline).toMatchObject({ fromCache: true, error: null, uid: 2 });
    expect(offline.activities).toHaveLength(1);
    const failed = await service(fakeRpc({ fail: new TypeError("Failed to fetch") })).refresh(CREDS, { online: true });
    expect(failed).toMatchObject({ fromCache: true, error: "Failed to fetch" });
  });

  it("marks done online with action_feedback, after checking the activity is still active (17+)", async () => {
    const s = service(fakeRpc({ open: [row()] }));
    const [a] = (await s.refresh(CREDS, { online: true })).activities;
    const rpc = fakeRpc();
    await service(rpc).markDone(CREDS, a, { online: true });
    expect(rpc.calls.map((c: any) => c.method)).toEqual(["search_read", "action_feedback"]);
    expect(rpc.calls[1].args).toEqual([[41]]);
    expect((await s.cached(CONFIG))[0]).toMatchObject({ done: true, pending: false, dateDone: "2026-10-23" });
    expect(await db.getOutboxOpsForConfig(CONFIG)).toEqual([]);
  });

  it("does not mark done again an activity archived on the server", async () => {
    const s = service(fakeRpc({ open: [row()] }));
    const [a] = (await s.refresh(CREDS, { online: true })).activities;
    const rpc = fakeRpc({ active: false });
    await service(rpc).markDone(CREDS, a, { online: true });
    expect(rpc.calls.some((c: any) => c.method === "action_feedback")).toBe(false);
  });

  it("queues a change made offline, keeps it over a refresh, and sends it with the next sync", async () => {
    const s = service(fakeRpc({ open: [row()] }));
    const [a] = (await s.refresh(CREDS, { online: true })).activities;
    await s.reschedule(CREDS, a, "2026-11-02", { online: false });
    const [op] = await db.getOutboxOpsForConfig(CONFIG);
    expect(op).toMatchObject({ noteId: CALENDAR_NOTE, kind: CALENDAR_RESCHEDULE, params: { activityId: 41, deadline: "2026-11-02" } });

    await service(fakeRpc({ open: [row()] })).refresh(CREDS, { online: true });
    expect((await s.cached(CONFIG))[0]).toMatchObject({ deadline: "2026-11-02", pending: true });

    const rpc = fakeRpc();
    const s2 = service(rpc);
    expect((await outbox.drain(CREDS, CONFIG)).done).toBe(1);
    expect(rpc.calls[0]).toMatchObject({ method: "write", args: [[41], { date_deadline: "2026-11-02" }] });
    expect((await s2.cached(CONFIG))[0].pending).toBe(false);
  });

  it("keeps only the latest change of one kind waiting for an activity", async () => {
    const s = service(fakeRpc({ open: [row()] }));
    const [a] = (await s.refresh(CREDS, { online: true })).activities;
    await s.reschedule(CREDS, a, "2026-11-02", { online: false });
    await s.reschedule(CREDS, a, "2026-11-05", { online: false });
    const ops = await db.getOutboxOpsForConfig(CONFIG);
    expect(ops.map((o) => o.params.deadline)).toEqual(["2026-11-05"]);
  });

  it("drops from the cache an activity gone on the server", async () => {
    const s = service(fakeRpc({ open: [row()] }));
    const [a] = (await s.refresh(CREDS, { online: true })).activities;
    await service(fakeRpc({ gone: true })).markDone(CREDS, a, { online: true });
    expect(await s.cached(CONFIG)).toEqual([]);
  });

  it("turns done the note link of an activity marked done from the calendar", async () => {
    await db.addParamsToNoteLinks();
    await db.addNoteLink({
      id: "lk", noteId: "n", configId: CONFIG, model: "mail.activity", resId: 41, kind: "activity",
      remoteState: "ok", createdAt: "t", lastSyncedAt: null,
    });
    const s = service(fakeRpc({ open: [row()] }));
    const [a] = (await s.refresh(CREDS, { online: true })).activities;
    await service(fakeRpc()).markDone(CREDS, a, { online: true });
    expect((await db.getNoteLinks("n"))[0].remoteState).toBe("done");
  });

  it("keeps a change that fails online in the outbox for the next sync", async () => {
    const s = service(fakeRpc({ open: [row()] }));
    const [a] = (await s.refresh(CREDS, { online: true })).activities;
    await service(fakeRpc({ fail: new TypeError("Failed to fetch") })).markDone(CREDS, a, { online: true });
    const [op] = await db.getOutboxOpsForConfig(CONFIG);
    expect(op).toMatchObject({ kind: CALENDAR_DONE, status: "failed" });
    expect((await s.cached(CONFIG))[0]).toMatchObject({ done: true, pending: true });
  });

  it("finds my sales team's members, none without a CRM", async () => {
    expect(await service(fakeRpc({ teams: [{ member_ids: [2, 5, 6] }, { member_ids: [6] }] })).salesTeamUsers(CREDS))
      .toEqual([{ id: 5, name: "User 5" }, { id: 6, name: "User 6" }]);
    expect(await service(fakeRpc({ teams: new OdooRpcError("no crm", "builtins.KeyError") })).salesTeamUsers(CREDS)).toEqual([]);
  });

  it("remembers the users chosen per server, once each", async () => {
    const s = service(fakeRpc());
    await s.setUsers(CONFIG, [{ id: 5, name: "A" }, { id: 5, name: "A" }, { id: 6, name: "B" }]);
    expect(await s.users(CONFIG)).toEqual([{ id: 5, name: "A" }, { id: 6, name: "B" }]);
    expect(await s.users("other")).toEqual([]);
  });
});
