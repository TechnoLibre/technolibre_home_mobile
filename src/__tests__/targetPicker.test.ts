import { describe, it, expect, vi } from "vitest";
import {
  applyTaskTargets, buildTargetRows, CHOOSE_LATER, filteredOptions, leadTargetRow, loadingRow,
  needsTaskTarget, NO_PARTNER, NO_PROJECT, parseRevenue, serverUsable, targetOfSelection,
  taskTargetRow, withPartners,
} from "../services/targetPicker";
import type { ProjectList } from "../services/odoo/projectService";
import type { RecordSearch } from "../services/odoo/recordSearchService";

const list = (projects: Array<{ id: number; name: string }>, over: Partial<ProjectList> = {}): ProjectList => ({
  projects, fromCache: false, fetchedAt: "t", truncated: false, error: null, ...over,
});
const found = (records: Array<{ id: number; name: string }>, over: Partial<RecordSearch> = {}): RecordSearch => ({
  records, fromCache: false, error: null, ...over,
});
const choose = (over: Record<string, any> = {}) => ({ state: "choose" as const, op: null, reason: null, target: null, ...over });

describe("taskTargetRow", () => {
  it("shows a linked or queued server without a choice, as sent", () => {
    expect(taskTargetRow({ state: "linked", resId: 4 }, null, null, true)).toMatchObject({
      loading: false, needsChoice: false, linkedResId: 4, checked: true,
    });
    expect(taskTargetRow({ state: "queued", op: {} as any }, null, null, true)).toMatchObject({ queued: true, checked: true });
  });

  it("selects the server's last project when the list has it, else no project", () => {
    const projects = list([{ id: 1, name: "A" }, { id: 2, name: "B" }]);
    expect(taskTargetRow(choose({ target: { projectId: 2 } }), projects, null, true).selection).toBe("2");
    expect(taskTargetRow(choose(), projects, null, true).selection).toBe(NO_PROJECT);
  });

  it("drops the remembered project that a fresh full list no longer has", () => {
    const row = taskTargetRow(choose({ target: { projectId: 9, projectName: "Archived" } }), list([{ id: 1, name: "A" }]), null, true);
    expect(row.options.map((o) => o.value)).toEqual(["1"]);
    expect(row.selection).toBe(NO_PROJECT);
  });

  it("offers choosing later when projects could not be read, offline or from a failing server", () => {
    expect(taskTargetRow(choose(), list([]), null, true).canDefer).toBe(false);
    expect(taskTargetRow(choose(), list([], { fromCache: true }), null, false).canDefer).toBe(true);
    expect(taskTargetRow(choose(), list([], { fromCache: true, error: "HTTP 502" }), null, true).canDefer).toBe(true);
  });

  it("keeps the chosen project offered when an older cache lacks it", () => {
    const row = taskTargetRow(choose({ target: { projectId: 9, projectName: "Neuf" } }), list([], { fromCache: true }), null, false);
    expect(row.options).toEqual([{ value: "9", name: "Neuf" }]);
    expect(row).toMatchObject({ selection: "9", offline: true, fromCache: true });
  });

  it("does not preselect a project found missing", () => {
    const row = taskTargetRow(
      choose({ reason: "project_missing", target: { projectId: 9, projectName: "Gone" } }),
      list([{ id: 9, name: "Gone" }]), null, true
    );
    expect(row.selection).toBe(NO_PROJECT);
    expect(row.reason).toBe("project_missing");
  });

  it("greys a server whose probe denies creating tasks, but not one never probed", () => {
    expect(taskTargetRow(choose(), list([]), "no_access", true).unusable).toBe("no_access");
    expect(taskTargetRow(choose(), list([]), "unknown", false).unusable).toBeNull();
  });
});

describe("leadTargetRow", () => {
  it("lists the partners found and keeps the chosen one and its revenue", () => {
    const row = leadTargetRow(
      choose({ target: { partnerId: 5, partnerName: "Acme", expectedRevenue: 1200 } }),
      found([{ id: 3, name: "Beta" }]), null, true
    );
    expect(row.options).toEqual([{ value: "5", name: "Acme" }, { value: "3", name: "Beta" }]);
    expect(row).toMatchObject({ kind: "lead", selection: "5", revenue: "1200", needsChoice: true });
  });

  it("does not preselect a partner found missing", () => {
    const row = leadTargetRow(choose({ reason: "partner_missing", target: { partnerId: 5 } }), found([]), null, true);
    expect(row.selection).toBe(NO_PARTNER);
    expect(row.options).toEqual([]);
  });

  it("replaces the partners with a new search, keeping the selected one", () => {
    const row = { ...leadTargetRow(choose(), found([{ id: 3, name: "Beta" }]), null, true), selection: "3" };
    const next = withPartners(row, found([{ id: 8, name: "Gamma" }], { fromCache: true, error: "offline" }));
    expect(next.options.map((o) => o.value)).toEqual(["3", "8"]);
    expect(next).toMatchObject({ fromCache: true, canDefer: true });
  });
});

describe("targetOfSelection, parseRevenue and filteredOptions", () => {
  const row = taskTargetRow(choose(), list([{ id: 1, name: "Écurie" }, { id: 2, name: "Garage" }]), null, false);

  it("maps a task selection to a target", () => {
    expect(targetOfSelection({ ...row, selection: NO_PROJECT })).toEqual({ projectId: null, projectName: null });
    expect(targetOfSelection({ ...row, selection: CHOOSE_LATER })).toBe("later");
    expect(targetOfSelection({ ...row, selection: "1" })).toEqual({ projectId: 1, projectName: "Écurie" });
  });

  it("maps a lead selection to partner and revenue", () => {
    const lead = leadTargetRow(choose(), found([{ id: 3, name: "Beta" }]), null, true);
    expect(targetOfSelection({ ...lead, selection: "3", revenue: "1 500,50" })).toEqual({
      partnerId: 3, partnerName: "Beta", expectedRevenue: 1500.5,
    });
    expect(targetOfSelection({ ...lead, revenue: "" })).toEqual({ partnerId: null, partnerName: null, expectedRevenue: null });
  });

  it("reads a revenue of at least 0, anything else as none", () => {
    expect(parseRevenue("12.5")).toBe(12.5);
    expect(parseRevenue("12,5")).toBe(12.5);
    expect(parseRevenue("1,500.50")).toBe(1500.5);
    expect(parseRevenue("1.500,50")).toBe(1500.5);
    expect(parseRevenue("1.500.000")).toBe(1500000);
    expect(parseRevenue("1 500")).toBe(1500);
    expect(parseRevenue("0")).toBe(0);
    expect(parseRevenue("-3")).toBeNull();
    expect(parseRevenue("abc")).toBeNull();
    expect(parseRevenue("  ")).toBeNull();
  });

  it("filters by name ignoring case and accents, keeping the selected option", () => {
    expect(filteredOptions({ ...row, filter: "ecu" }).map((o) => o.value)).toEqual(["1"]);
    expect(filteredOptions({ ...row, filter: "ecu", selection: "2" }).map((o) => o.value)).toEqual(["1", "2"]);
    expect(filteredOptions({ ...row, filter: "  " })).toHaveLength(2);
  });
});

/** Stand-in for SyncService: TargetState per server and kind. */
function fakeSource(states: Record<string, Record<string, any>>, options: { cap?: any; kinds?: string[] } = {}) {
  return {
    setTarget: vi.fn(async () => null),
    dropTarget: vi.fn(async () => {}),
    setLastKinds: vi.fn(async () => {}),
    lastKinds: vi.fn(async () => (options.kinds ?? ["task"]) as any),
    targetState: vi.fn(async (_n: string, configId: string, kind: string) => states[configId]?.[kind] ?? choose()),
    capabilities: { ensure: vi.fn(async () => options.cap ?? null) },
    projects: { list: vi.fn(async () => list([{ id: 1, name: "A" }])) },
    partners: { search: vi.fn(async () => found([{ id: 7, name: "Acme" }])) },
  };
}
const CREDS = async () => ({ odooUrl: "https://odoo.example.com", username: "u", password: "p", database: "db" });

describe("picker flow", () => {
  it("opens the picker for a server with nothing, or with a creation waiting for a choice", async () => {
    const linked = { task: { state: "linked", resId: 1 }, lead: choose() };
    expect(await needsTaskTarget(fakeSource({ a: linked }), "n", ["a"])).toBe(false);
    expect(await needsTaskTarget(fakeSource({ a: {} }), "n", ["a"])).toBe(true);
    const waiting = { task: { state: "linked", resId: 1 }, lead: choose({ op: {}, reason: "incomplete" }) };
    expect(await needsTaskTarget(fakeSource({ a: waiting }), "n", ["a"])).toBe(true);
    const deleted = { task: choose({ reason: "deleted", deletedResId: 3 }), lead: { state: "linked", resId: 2 } };
    expect(await needsTaskTarget(fakeSource({ a: deleted }), "n", ["a"])).toBe(true);
  });

  it("checks the server's last kinds for a note with nothing there", async () => {
    const rows = await buildTargetRows(fakeSource({}, { kinds: ["lead"] }), "n", "a", CREDS, true);
    expect(rows.task).toMatchObject({ needsChoice: true, checked: false });
    expect(rows.lead).toMatchObject({ needsChoice: true, checked: true, options: [{ value: "7", name: "Acme" }] });
  });

  it("leaves a new kind unchecked on a server where the note already has a record", async () => {
    const source = fakeSource({ a: { task: { state: "linked", resId: 4 } } }, { kinds: ["task", "lead"] });
    const rows = await buildTargetRows(source, "n", "a", CREDS, true);
    expect(rows.task).toMatchObject({ linkedResId: 4, checked: true });
    expect(rows.lead).toMatchObject({ needsChoice: true, checked: false });
    expect(source.projects.list).not.toHaveBeenCalled();
  });

  it("greys a kind whose create right the probe denies, probing the kind's model", async () => {
    const cap = { exists: false, canRead: null, canCreate: null, canWrite: null, hasActivities: false, hasChatter: false };
    const source = fakeSource({}, { cap, kinds: ["task", "lead"] });
    const rows = await buildTargetRows(source, "n", "a", CREDS, true);
    expect(rows.lead).toMatchObject({ unusable: "missing_model", checked: false });
    expect(source.capabilities.ensure).toHaveBeenCalledWith(expect.anything(), "crm.lead", { online: true });
    expect(serverUsable(rows)).toBe(false);
  });

  it("turns a failure into rows that offer nothing", async () => {
    const source = fakeSource({});
    source.targetState.mockRejectedValue(new Error("db closed"));
    const rows = await buildTargetRows(source, "n", "a", CREDS, true);
    expect(rows.task).toMatchObject({ loading: false, needsChoice: false, failed: "db closed" });
    expect(serverUsable(rows)).toBe(false);
  });

  it("records each checked choice and the checked kinds before the push", async () => {
    const source = fakeSource({});
    const task = { ...taskTargetRow(choose(), list([{ id: 3, name: "C" }]), null, true), selection: "3", checked: true };
    const lead = { ...leadTargetRow(choose(), found([{ id: 7, name: "Acme" }]), null, true), selection: "7", revenue: "10", checked: true };
    const linkedTask = taskTargetRow({ state: "linked", resId: 1 }, null, null, true);
    const uncheckedLead = { ...leadTargetRow(choose(), found([]), null, true), checked: false };
    await applyTaskTargets(source, "n", ["a", "b"], { a: { task, lead }, b: { task: linkedTask, lead: uncheckedLead } });
    expect(source.setTarget).toHaveBeenCalledTimes(2);
    expect(source.setTarget).toHaveBeenCalledWith("n", "a", "task", { projectId: 3, projectName: "C" });
    expect(source.setTarget).toHaveBeenCalledWith("n", "a", "lead", { partnerId: 7, partnerName: "Acme", expectedRevenue: 10 });
    expect(source.setLastKinds).toHaveBeenCalledWith("a", ["task", "lead"]);
    // b already had a task: its unchecked opportunity says nothing about the next note
    expect(source.setLastKinds).toHaveBeenCalledTimes(1);
    expect(source.dropTarget).not.toHaveBeenCalled();
  });

  it("drops a kind the user unchecked while it waited", async () => {
    const source = fakeSource({});
    const task = taskTargetRow({ state: "linked", resId: 1 }, null, null, true);
    const lead = { ...leadTargetRow(choose({ op: {}, reason: "refused" }), found([]), null, true), checked: false };
    await applyTaskTargets(source, "n", ["a"], { a: { task, lead } });
    expect(source.dropTarget).toHaveBeenCalledWith("n", "a", "lead");
    expect(source.setTarget).not.toHaveBeenCalled();
  });

  it("drops a waiting kind the server no longer lets be sent, and keeps a later lead's revenue", async () => {
    const source = fakeSource({});
    const task = { ...taskTargetRow(choose(), list([]), null, true), checked: true, selection: CHOOSE_LATER };
    const blocked = { ...leadTargetRow(choose({ op: {}, reason: "refused" }), found([]), "no_access", true), checked: false };
    await applyTaskTargets(source, "n", ["a"], { a: { task, lead: blocked } });
    expect(source.dropTarget).toHaveBeenCalledWith("n", "a", "lead");

    const later = { ...leadTargetRow(choose(), found([]), null, false), checked: true, selection: CHOOSE_LATER, revenue: "250" };
    await applyTaskTargets(source, "n", ["b"], { b: { task: { ...task, checked: false }, lead: later } });
    expect(source.setTarget).toHaveBeenCalledWith("n", "b", "lead", "later", { expectedRevenue: 250 });
  });

  it("lets a failed or blocked queued creation be unchecked to drop it", async () => {
    const stuck = taskTargetRow({ state: "queued", op: { status: "failed", params: {} } as any }, null, null, true);
    expect(stuck).toMatchObject({ queued: true, droppable: true, checked: true, reason: "failed" });
    expect(taskTargetRow({ state: "queued", op: { status: "queued", params: {} } as any }, null, null, true).droppable).toBe(false);

    const source = fakeSource({});
    const lead = { ...leadTargetRow(choose(), found([]), null, true), checked: true };
    await applyTaskTargets(source, "n", ["a"], { a: { task: { ...stuck, checked: false }, lead } });
    expect(source.dropTarget).toHaveBeenCalledWith("n", "a", "task");
  });

  it("refuses to push while a selected server is missing, loading, or has nothing checked", async () => {
    const source = fakeSource({});
    const unchecked = { task: { ...taskTargetRow(choose(), list([]), null, true), checked: false }, lead: { ...leadTargetRow(choose(), found([]), null, true), checked: false } };
    await expect(applyTaskTargets(source, "n", ["a"], {})).rejects.toThrow();
    await expect(applyTaskTargets(source, "n", ["a"], { a: { task: loadingRow("task"), lead: loadingRow("lead") } })).rejects.toThrow();
    await expect(applyTaskTargets(source, "n", ["a"], { a: unchecked })).rejects.toThrow();
    expect(source.setTarget).not.toHaveBeenCalled();
  });
});
