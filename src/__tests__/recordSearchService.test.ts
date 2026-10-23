import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseService } from "../services/databaseService";
import { PARTNER_MODEL, RECORD_CACHE_KEEP, RecordSearchService } from "../services/odoo/recordSearchService";
import { SyncCredentials } from "../services/odoo/odooRpcClient";
import { addSyncTargetTables } from "../services/migrations/addSyncTargetTables";

const CREDS: SyncCredentials = { odooUrl: "https://odoo.example.com", username: "u", password: "p", database: "db" };
const CONFIG = "https://odoo.example.com|u|db";

function fakeRpc(answer: Array<{ id: number; name: string }> | Error) {
  const calls: any[] = [];
  return {
    calls,
    nameSearch: async (_c: SyncCredentials, model: string, name: string, options: any) => {
      calls.push({ model, name, options });
      if (answer instanceof Error) throw answer;
      return answer;
    },
  } as any;
}

describe("RecordSearchService", () => {
  let db: DatabaseService;
  let clock = new Date("2026-10-22T10:00:00.000Z");

  beforeEach(async () => {
    db = new DatabaseService();
    await db.initialize();
    await addSyncTargetTables(db);
    clock = new Date("2026-10-22T10:00:00.000Z");
  });

  const service = (rpc: any) => new RecordSearchService(db, rpc, PARTNER_MODEL, () => clock);

  it("searches by name on the server and keeps what it found", async () => {
    const rpc = fakeRpc([{ id: 5, name: "Acme" }]);
    expect(await service(rpc).search(CREDS, " acm ", { online: true })).toEqual({
      records: [{ id: 5, name: "Acme" }], fromCache: false, error: null,
    });
    expect(rpc.calls[0]).toEqual({ model: PARTNER_MODEL, name: "acm", options: { limit: 20 } });
    expect((await db.getRemoteRecords(CONFIG, PARTNER_MODEL)).map((r) => r.resId)).toEqual([5]);
  });

  it("finds offline, in the cache, the names containing the text, ignoring case and accents", async () => {
    await service(fakeRpc([{ id: 5, name: "Société Écho" }, { id: 6, name: "Beta" }])).search(CREDS, "", { online: true });
    const rpc = fakeRpc([]);
    const result = await service(rpc).search(CREDS, "echo", { online: false });
    expect(rpc.calls).toHaveLength(0);
    expect(result).toEqual({ records: [{ id: 5, name: "Société Écho" }], fromCache: true, error: null });
  });

  it("falls back to the cache, with the error, when the server fails", async () => {
    await service(fakeRpc([{ id: 5, name: "Acme" }])).search(CREDS, "", { online: true });
    const result = await service(fakeRpc(new TypeError("Failed to fetch"))).search(CREDS, "ac", { online: true });
    expect(result).toEqual({ records: [{ id: 5, name: "Acme" }], fromCache: true, error: "Failed to fetch" });
  });

  it("keeps only the most recently seen records", async () => {
    const svc = service(fakeRpc([]));
    for (let i = 0; i < RECORD_CACHE_KEEP + 3; i++) {
      clock = new Date(Date.UTC(2026, 0, 1, 0, 0, i));
      await svc.remember(CONFIG, [{ id: i + 1, name: `P${i + 1}` }]);
    }
    const kept = await db.getRemoteRecords(CONFIG, PARTNER_MODEL);
    expect(kept).toHaveLength(RECORD_CACHE_KEEP);
    expect(kept.some((r) => r.resId === 1)).toBe(false);
    expect(kept.some((r) => r.resId === RECORD_CACHE_KEEP + 3)).toBe(true);
  });
});
