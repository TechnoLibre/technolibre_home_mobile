import { describe, it, expect, vi } from "vitest";
import {
  applyTaskTargets, buildTaskTargetRow, CHOOSE_LATER, filteredOptions, loadingRow, needsTaskTarget,
  NO_PROJECT, targetOfSelection, taskTargetRow,
} from "../services/taskTargetPicker";
import type { ProjectList } from "../services/odoo/projectService";

const list = (projects: Array<{ id: number; name: string }>, over: Partial<ProjectList> = {}): ProjectList => ({
  projects, fromCache: false, fetchedAt: "t", truncated: false, error: null, ...over,
});
const choose = (over: Record<string, any> = {}) => ({ state: "choose" as const, op: null, reason: null, target: null, ...over });

describe("taskTargetRow", () => {
  it("shows a linked or queued server without a choice", () => {
    expect(taskTargetRow({ state: "linked", resId: 4 }, null, null, true)).toMatchObject({
      loading: false, needsChoice: false, linkedResId: 4,
    });
    expect(taskTargetRow({ state: "queued", op: {} as any }, null, null, true).needsChoice).toBe(false);
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

describe("targetOfSelection and filteredOptions", () => {
  const row = taskTargetRow(choose(), list([{ id: 1, name: "Écurie" }, { id: 2, name: "Garage" }]), null, false);

  it("maps the selection to a target", () => {
    expect(targetOfSelection({ ...row, selection: NO_PROJECT })).toEqual({ projectId: null, projectName: null });
    expect(targetOfSelection({ ...row, selection: CHOOSE_LATER })).toBe("later");
    expect(targetOfSelection({ ...row, selection: "1" })).toEqual({ projectId: 1, projectName: "Écurie" });
  });

  it("filters by name ignoring case and accents, keeping the selected option", () => {
    expect(filteredOptions({ ...row, filter: "ecu" }).map((o) => o.value)).toEqual(["1"]);
    expect(filteredOptions({ ...row, filter: "ecu", selection: "2" }).map((o) => o.value)).toEqual(["1", "2"]);
    expect(filteredOptions({ ...row, filter: "  " })).toHaveLength(2);
  });
});

/** Stand-in for SyncService: one TaskTargetState per server. */
function fakeSource(states: Record<string, any>, options: { cap?: any; projects?: ProjectList } = {}) {
  return {
    setTaskTarget: vi.fn(async () => null),
    taskTargetState: vi.fn(async (_n: string, configId: string) => states[configId]),
    capabilities: { ensure: vi.fn(async () => options.cap ?? null) },
    projects: { list: vi.fn(async () => options.projects ?? list([{ id: 1, name: "A" }])) },
  };
}
const CREDS = async () => ({ odooUrl: "https://odoo.example.com", username: "u", password: "p", database: "db" });

describe("picker flow", () => {
  it("opens the picker only when a selected server waits for a project", async () => {
    const source = fakeSource({ a: { state: "linked", resId: 1 }, b: choose() });
    expect(await needsTaskTarget(source, "n", ["a"])).toBe(false);
    expect(await needsTaskTarget(source, "n", ["a", "b"])).toBe(true);
  });

  it("builds a choice row from the probe and the projects, and greys a server without create right", async () => {
    const cap = { exists: true, canRead: true, canCreate: false, canWrite: true, hasActivities: true, hasChatter: true };
    const source = fakeSource({ a: choose() }, { cap });
    const row = await buildTaskTargetRow(source, "n", "a", CREDS, true);
    expect(row).toMatchObject({ needsChoice: true, unusable: "no_access", options: [{ value: "1", name: "A" }] });
    expect(source.capabilities.ensure).toHaveBeenCalledWith(expect.anything(), "project.task", { online: true });
  });

  it("reads nothing from the server for a linked note", async () => {
    const source = fakeSource({ a: { state: "linked", resId: 4 } });
    expect((await buildTaskTargetRow(source, "n", "a", CREDS, true)).linkedResId).toBe(4);
    expect(source.projects.list).not.toHaveBeenCalled();
  });

  it("turns a failure into an error row", async () => {
    const source = fakeSource({});
    source.taskTargetState.mockRejectedValueOnce(new Error("db closed"));
    expect(await buildTaskTargetRow(source, "n", "a", CREDS, true)).toMatchObject({ loading: false, needsChoice: false, error: "db closed" });
  });

  it("records each selected choice before the push, and nothing for linked servers", async () => {
    const source = fakeSource({});
    const choice = { ...taskTargetRow(choose(), list([{ id: 3, name: "C" }]), null, true), selection: "3" };
    const linked = taskTargetRow({ state: "linked", resId: 1 }, null, null, true);
    await applyTaskTargets(source, "n", ["a", "b"], { a: choice, b: linked });
    expect(source.setTaskTarget).toHaveBeenCalledTimes(1);
    expect(source.setTaskTarget).toHaveBeenCalledWith("n", "a", { projectId: 3, projectName: "C" });
  });

  it("refuses to push while a selected row is missing, loading or failed", async () => {
    const source = fakeSource({});
    await expect(applyTaskTargets(source, "n", ["a"], {})).rejects.toThrow();
    await expect(applyTaskTargets(source, "n", ["a"], { a: loadingRow() })).rejects.toThrow();
    await expect(applyTaskTargets(source, "n", ["a"], { a: { ...loadingRow(), loading: false, error: "x" } })).rejects.toThrow();
    expect(source.setTaskTarget).not.toHaveBeenCalled();
  });
});
