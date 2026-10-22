import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseService } from "../services/databaseService";
import { PROJECT_LIST_LIMIT, PROJECT_MODEL, ProjectService } from "../services/odoo/projectService";
import { SyncCredentials } from "../services/odoo/odooRpcClient";
import { addSyncTargetTables } from "../services/migrations/addSyncTargetTables";

const CREDS: SyncCredentials = { odooUrl: "https://odoo.example.com", username: "u", password: "p", database: "db" };
const OTHER: SyncCredentials = { ...CREDS, database: "other" };
const CONFIG = "https://odoo.example.com|u|db";

/** Stand-in for OdooRpcClient.searchRead answering rows, or failing. */
function fakeRpc(rows: Array<{ id: number; name: string }> | Error) {
  const calls: any[] = [];
  return {
    calls,
    searchRead: async (_c: SyncCredentials, model: string, domain: any[], fields: string[], options: any) => {
      calls.push({ model, domain, fields, options });
      if (rows instanceof Error) throw rows;
      return rows;
    },
  } as any;
}

describe("ProjectService", () => {
  let db: DatabaseService;
  const at = new Date("2026-10-22T10:00:00.000Z");

  beforeEach(async () => {
    db = new DatabaseService();
    await db.initialize();
    await addSyncTargetTables(db);
  });

  const service = (rpc: any) => new ProjectService(db, rpc, () => at);

  it("reads the active projects by name and caches them per server", async () => {
    const rpc = fakeRpc([{ id: 2, name: "Bâtiment" }, { id: 1, name: "Atelier" }]);
    const list = await service(rpc).list(CREDS, { online: true });
    expect(rpc.calls[0]).toEqual({
      model: PROJECT_MODEL, domain: [], fields: ["id", "name"], options: { order: "name asc", limit: PROJECT_LIST_LIMIT },
    });
    expect(list).toMatchObject({ fromCache: false, truncated: false, error: null, fetchedAt: at.toISOString() });
    expect(list.projects).toEqual([{ id: 2, name: "Bâtiment" }, { id: 1, name: "Atelier" }]);
    expect((await db.getRemoteRecords(CONFIG, PROJECT_MODEL)).map((r) => r.resId)).toEqual([1, 2]);
  });

  it("drops from the cache a project the server no longer returns", async () => {
    await service(fakeRpc([{ id: 1, name: "A" }, { id: 2, name: "B" }])).list(CREDS, { online: true });
    await service(fakeRpc([{ id: 2, name: "B" }])).list(CREDS, { online: true });
    expect((await db.getRemoteRecords(CONFIG, PROJECT_MODEL)).map((r) => r.resId)).toEqual([2]);
  });

  it("serves the cache offline without calling the server", async () => {
    await service(fakeRpc([{ id: 1, name: "A" }])).list(CREDS, { online: true });
    const rpc = fakeRpc([]);
    const list = await service(rpc).list(CREDS, { online: false });
    expect(rpc.calls).toHaveLength(0);
    expect(list).toMatchObject({ fromCache: true, error: null, projects: [{ id: 1, name: "A" }] });
  });

  it("falls back to the cache, with the error, when the server fails", async () => {
    await service(fakeRpc([{ id: 1, name: "A" }])).list(CREDS, { online: true });
    const list = await service(fakeRpc(new TypeError("Failed to fetch"))).list(CREDS, { online: true });
    expect(list).toMatchObject({ fromCache: true, error: "Failed to fetch", projects: [{ id: 1, name: "A" }] });
  });

  it("keeps each server's projects apart, and says when the list is cut", async () => {
    const many = Array.from({ length: PROJECT_LIST_LIMIT }, (_, i) => ({ id: i + 1, name: `P${i + 1}` }));
    expect((await service(fakeRpc(many)).list(CREDS, { online: true })).truncated).toBe(true);
    const other = await service(fakeRpc([])).list(OTHER, { online: false });
    expect(other).toMatchObject({ projects: [], fetchedAt: null });
  });
});

describe("sync target tables", () => {
  let db: DatabaseService;

  beforeEach(async () => {
    db = new DatabaseService();
    await db.initialize();
    await addSyncTargetTables(db);
    await addSyncTargetTables(db);
  });

  it("keeps the last choice per server and kind", async () => {
    await db.setSyncTargetPref({ configId: CONFIG, kind: "task.create", params: { projectId: 3 }, updatedAt: "t1" });
    await db.setSyncTargetPref({ configId: CONFIG, kind: "task.create", params: { projectId: 4 }, updatedAt: "t2" });
    expect(await db.getSyncTargetPref(CONFIG, "task.create")).toEqual({
      configId: CONFIG, kind: "task.create", params: { projectId: 4 }, updatedAt: "t2",
    });
    expect(await db.getSyncTargetPref(CONFIG, "lead.create")).toBeNull();
  });

  it("moves the choices of a renamed target and drops its cached records", async () => {
    await db.createNoteLinksTable();
    await db.createSyncPullCursorsTable();
    await db.createSyncOutboxTable();
    await db.createServerCapabilitiesTable();
    await db.addSyncColumnsToNotes();
    await db.addSyncConfigIdColumn();
    await db.addSelectedSyncConfigIdsColumn();
    await db.addSyncPerServerStatusColumn();
    const renamed = "https://odoo.example.com/|u|db";
    await db.setSyncTargetPref({ configId: CONFIG, kind: "task.create", params: { projectId: 3 }, updatedAt: "t" });
    await db.replaceRemoteRecords(CONFIG, PROJECT_MODEL, [
      { configId: CONFIG, model: PROJECT_MODEL, resId: 3, displayName: "C", extra: {}, fetchedAt: "t" },
    ]);

    await db.renameSyncConfigId(CONFIG, renamed);

    expect(await db.getSyncTargetPref(CONFIG, "task.create")).toBeNull();
    expect((await db.getSyncTargetPref(renamed, "task.create"))!.params).toEqual({ projectId: 3 });
    expect(await db.getRemoteRecords(CONFIG, PROJECT_MODEL)).toEqual([]);
  });
});
