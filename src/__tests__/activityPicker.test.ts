import { describe, it, expect, vi } from "vitest";
import {
  ACTIVITY_MODELS, ActivitySection, ActivitySource, ADVANCED_MODEL, buildActivitySection, canAddActivity,
  DEFAULT_TYPE, ME, newDraftRow, NO_RECORD, planActivities, rowTarget, sectionHasWork, withModel,
  withRecords, withType, withUsers,
} from "../services/activityPicker";
import { applyTaskTargets, CHOOSE_LATER, loadingRow, needsTaskTarget, serverUsable } from "../services/targetPicker";
import type { ActivityTypeChoice } from "../services/odoo/activityTypeService";

const CREDS = { odooUrl: "https://odoo.example.com", username: "u", password: "p", database: "db" };

const type = (over: Partial<ActivityTypeChoice> = {}): ActivityTypeChoice => ({
  id: 1, name: "To-Do", resModel: null, delayCount: 0, delayUnit: "days", delayFrom: "current_date", ...over,
});

const op = (id: string, over: Record<string, any> = {}) => ({
  id, clientUuid: `u-${id}`, noteId: "n", configId: "c", kind: "activity.create", params: {},
  status: "queued", attempts: 0, nextAttemptAt: null, lastError: null, dependsOn: null,
  createdAt: "t", updatedAt: "t", ...over,
}) as any;

const target = (over: Record<string, any> = {}) => ({
  resModel: "res.partner", resId: 5, resName: "Acme", typeId: 1, typeName: "To-Do",
  deadline: "2026-11-02", userId: null, userName: null, ...over,
});

/** A source whose server has every model, types To-Do (any) and Quote (sale.order). */
function source(over: Partial<ActivitySource> = {}): ActivitySource & { set: any[]; dropped: string[] } {
  const set: any[] = [];
  const dropped: string[] = [];
  return {
    set,
    dropped,
    activityStates: async () => [],
    setActivity: async (...args: any[]) => { set.push(args); },
    dropActivity: async (_n: string, opId: string) => { dropped.push(opId); },
    targetState: async () => ({ state: "choose", op: null, reason: null, target: null }),
    capabilities: { ensure: async (_c, model) => ({ exists: true, hasActivities: model !== "project.project" } as any) },
    activityTypes: {
      list: async () => ({ types: [type(), type({ id: 2, name: "Quote", resModel: "sale.order", delayCount: 3 })], fromCache: false, error: null }),
    },
    ...over,
  } as any;
}

const build = (src: ActivitySource, online = true, noteDay: string | null = null) =>
  buildActivitySection(src, "n", "c", async () => CREDS, online, noteDay, "2026-10-23");

describe("buildActivitySection", () => {
  it("greys the models the server takes no activities on, and offers the note's task first", async () => {
    const section = await build(source({
      targetState: async (_n, _c, kind) => kind === "task"
        ? { state: "linked", resId: 42 }
        : { state: "choose", op: null, reason: null, target: null },
    }));
    expect(section.models.map((m) => m.model)).toEqual(ACTIVITY_MODELS);
    expect(section.models.find((m) => m.model === "project.project")!.unusable).toBe("no_activities");
    expect(section.shortcuts).toEqual([{ kind: "task", model: "project.task", resId: 42 }]);
    expect(canAddActivity(section)).toBe(true);
  });

  it("shows the note's activities, and edits a creation waiting for its record", async () => {
    const section = await build(source({
      activityStates: async () => [
        { state: "linked", link: { id: "l1" } as any, target: target() },
        { state: "queued", op: op("o1", { status: "blocked", params: { blockedReason: "ambiguous" } }), target: target() },
        { state: "choose", op: op("o2"), reason: "record_missing", target: target({ userId: 8, userName: "Lee" }) },
      ],
    }));
    expect(section.rows.map((r) => r.status)).toEqual(["linked", "stuck", "choose"]);
    expect(section.rows[1].reason).toBe("ambiguous");
    const waiting = section.rows[2];
    expect(waiting).toMatchObject({ opId: "o2", recordSelection: NO_RECORD, userSelection: "8", typeSelection: "1" });
    expect(sectionHasWork(section)).toBe(true);
  });

  it("puts a model the list lacks in the technical name field", async () => {
    const section = await build(source({
      activityStates: async () => [{ state: "choose", op: op("o"), reason: "incomplete", target: target({ resModel: "hr.employee", resId: null }) }],
    }));
    expect(section.rows[0]).toMatchObject({ model: ADVANCED_MODEL, advancedModel: "hr.employee" });
  });

  it("becomes a failed section when the states cannot be read", async () => {
    const section = await build(source({ activityStates: async () => { throw new Error("db locked"); } }));
    expect(section).toMatchObject({ failed: "db locked", loading: false });
    expect(canAddActivity(section)).toBe(false);
    expect(sectionHasWork(section)).toBe(false);
  });
});

describe("activity drafts", () => {
  const section = async (noteDay: string | null = null) => build(source(), true, noteDay);

  it("starts on the first usable model with its first type, due today", async () => {
    const row = newDraftRow(await section(), "d1");
    expect(row).toMatchObject({
      status: "draft", model: "res.partner", typeSelection: "1", deadline: "2026-10-23", userSelection: ME,
    });
  });

  it("is due on the note's date when it has one, whatever the type", async () => {
    const s = await section("2026-12-01");
    expect(withType(s, newDraftRow(s, "d"), "2").deadline).toBe("2026-12-01");
  });

  it("follows the type's delay until a deadline is typed", async () => {
    const s = await section();
    const row = withModel(s, newDraftRow(s, "d"), "sale.order");
    expect(withType(s, row, "2").deadline).toBe("2026-10-26");
    expect(withType(s, { ...row, deadline: "2027-01-01", deadlineEdited: true }, "2").deadline).toBe("2027-01-01");
  });

  it("resets the record on a model change, and drops a type that does not apply", async () => {
    const s = await section();
    const onOrder = withType(s, withModel(s, newDraftRow(s, "d"), "sale.order"), "2");
    const row = withModel(s, { ...onOrder, records: [{ value: "3", name: "S003" }], recordSelection: "3" }, "res.partner");
    expect(row).toMatchObject({ recordSelection: NO_RECORD, records: [], typeSelection: "1" });
  });

  it("keeps the selected record and user through a new search", async () => {
    const s = await section();
    const row = { ...newDraftRow(s, "d"), records: [{ value: "5", name: "Acme" }], recordSelection: "5" };
    const searched = withRecords(s, row, { records: [{ id: 6, name: "Beta" }], fromCache: true, error: "HTTP 502" });
    expect(searched.records.map((o) => o.value)).toEqual(["5", "6"]);
    expect(searched).toMatchObject({ recordsFromCache: true, recordsError: "HTTP 502" });
    const users = withUsers({ ...row, users: [{ value: "8", name: "Lee" }], userSelection: "8" }, { records: [], fromCache: false, error: null });
    expect(users.users).toEqual([{ value: "8", name: "Lee" }]);
  });

  it("stands for a target with the names, and the server's defaults when left", async () => {
    const s = await section();
    const row = { ...newDraftRow(s, "d"), records: [{ value: "5", name: "Acme" }], recordSelection: "5" };
    expect(rowTarget(s, row)).toEqual({
      resModel: "res.partner", resId: 5, resName: "Acme", typeId: 1, typeName: "To-Do",
      deadline: "2026-10-23", userId: null, userName: null,
    });
    expect(rowTarget(s, { ...row, typeSelection: DEFAULT_TYPE, deadline: "" })).toMatchObject({ typeId: null, deadline: null });
  });

  it("needs a record, unless offline where it can wait for one", async () => {
    const s = await section();
    const row = newDraftRow(s, "d");
    expect(rowTarget(s, row)).toEqual({ error: expect.stringContaining("enregistrement") });
    expect(rowTarget(s, { ...row, recordSelection: CHOOSE_LATER })).toHaveProperty("error");
    const offline = await build(source(), false);
    expect(rowTarget(offline, { ...row, recordSelection: CHOOSE_LATER })).toMatchObject({ resId: null, resModel: "res.partner" });
  });

  it("needs a technical name for another model", async () => {
    const s = await section();
    const row = { ...newDraftRow(s, "d"), model: ADVANCED_MODEL, advancedModel: "  ", recordSelection: "5" };
    expect(rowTarget(s, row)).toEqual({ error: expect.stringContaining("modèle") });
    expect(rowTarget(s, { ...row, advancedModel: " hr.employee " })).toMatchObject({ resModel: "hr.employee" });
  });
});

describe("planActivities", () => {
  it("queues drafts, completes waiting creations, drops removed ones, and checks all first", async () => {
    const src = source({
      activityStates: async () => [
        { state: "choose", op: op("o1"), reason: "incomplete", target: target({ resId: null }) },
        { state: "queued", op: op("o2", { status: "failed" }), target: target() },
      ],
    });
    const s: ActivitySection = await build(src);
    s.rows[0] = { ...s.rows[0], records: [{ value: "9", name: "Nine" }], recordSelection: "9" };
    s.rows[1] = { ...s.rows[1], removed: true };
    s.rows.push({ ...newDraftRow(s, "d"), records: [{ value: "5", name: "Acme" }], recordSelection: "5" });
    s.rows.push({ ...newDraftRow(s, "gone"), removed: true });

    const planned = planActivities(src, "n", ["c"], { c: s });
    expect(src.set).toHaveLength(0);
    for (const run of planned) await run();
    expect(src.set.map(([, , t, opId]) => [t.resId, opId])).toEqual([[9, "o1"], [5, null]]);
    expect(src.dropped).toEqual(["o2"]);

    const bad = { ...s, rows: [...s.rows, newDraftRow(s, "empty")] };
    expect(() => planActivities(src, "n", ["c"], { c: bad })).toThrow(/enregistrement/);
  });

  it("refuses a section still loading", () => {
    expect(() => planActivities(source(), "n", ["c"], { c: { ...(null as any), loading: true, rows: [] } })).toThrow();
  });
});

describe("target picker with activities", () => {
  it("opens the picker for a note with only a creation waiting for its record", async () => {
    const choose = { state: "choose" as const, op: null, reason: null, target: null };
    const base = { targetState: async () => choose } as any;
    expect(await needsTaskTarget({ ...base, activityStates: async () => [] }, "n", ["c"])).toBe(true);
    const live = { state: "linked", link: {} as any, target: target() };
    expect(await needsTaskTarget({ ...base, activityStates: async () => [live] }, "n", ["c"])).toBe(false);
    const waiting = { state: "choose", op: op("o"), reason: "incomplete", target: target() };
    expect(await needsTaskTarget({ ...base, activityStates: async () => [live, waiting] }, "n", ["c"])).toBe(true);
  });

  it("sends a server with no kind checked when it has activities to send", async () => {
    const rows = {
      task: { ...loadingRow("task"), loading: false, needsChoice: true },
      lead: { ...loadingRow("lead"), loading: false, needsChoice: true },
    };
    const src = { setTarget: vi.fn(), dropTarget: vi.fn(), setLastKinds: vi.fn() } as any;
    await expect(applyTaskTargets(src, "n", ["c"], { c: rows })).rejects.toThrow(/Aucune cible/);
    await applyTaskTargets(src, "n", ["c"], { c: rows }, () => true);
    expect(src.setTarget).not.toHaveBeenCalled();
    expect(serverUsable({ ...rows, task: { ...rows.task, failed: "x" }, lead: { ...rows.lead, failed: "x" } }, true)).toBe(true);
  });
});

describe("activity picker after review", () => {
  it("counts a removed creation as work, so confirming drops it", async () => {
    const src = source({
      activityStates: async () => [{ state: "choose", op: op("o1"), reason: "record_missing", target: target() }],
    });
    const s = await build(src);
    s.rows[0].removed = true;
    expect(sectionHasWork(s)).toBe(true);
    for (const run of planActivities(src, "n", ["c"], { c: s })) await run();
    expect(src.dropped).toEqual(["o1"]);
    expect(sectionHasWork(s)).toBe(false);
  });

  it("keeps an activity left for later as later while still offline", async () => {
    const states = async () => [{ state: "choose" as const, op: op("o1"), reason: "incomplete", target: target({ resId: null }) }];
    const offline = await build(source({ activityStates: states }), false);
    expect(offline.rows[0].recordSelection).toBe(CHOOSE_LATER);
    expect(rowTarget(offline, offline.rows[0])).toMatchObject({ resId: null });
    const online = await build(source({ activityStates: states }), true);
    expect(online.rows[0].recordSelection).toBe(NO_RECORD);
  });

  it("records each row once, even when applying again after a failure part way", async () => {
    let calls = 0;
    const src = source({
      setActivity: async () => {
        calls++;
        if (calls === 2) throw new Error("disk full");
        return { id: `op-${calls}` };
      },
    });
    const s = await build(src);
    for (const key of ["a", "b"]) s.rows.push({ ...newDraftRow(s, key), records: [{ value: "5", name: "Acme" }], recordSelection: "5" });
    const first = planActivities(src, "n", ["c"], { c: s });
    await first[0]();
    await expect(first[1]()).rejects.toThrow("disk full");
    expect(s.rows.map((r) => r.status)).toEqual(["queued", "draft"]);
    for (const run of planActivities(src, "n", ["c"], { c: s })) await run();
    expect(calls).toBe(3);
    expect(s.rows[0]).toMatchObject({ status: "queued", opId: "op-1" });
  });

  it("does not overwrite the server's default kinds when only activities are sent", async () => {
    const rows = {
      task: { ...loadingRow("task"), loading: false, needsChoice: true },
      lead: { ...loadingRow("lead"), loading: false, needsChoice: true },
    };
    const src = { setTarget: vi.fn(), dropTarget: vi.fn(), setLastKinds: vi.fn() } as any;
    await applyTaskTargets(src, "n", ["c"], { c: rows }, () => true);
    expect(src.setLastKinds).not.toHaveBeenCalled();
  });
});
