import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseService } from "../services/databaseService";
import {
  ACTIVITY_TYPE_MODEL, ActivityTypeChoice, ActivityTypeService, defaultDeadline, typesForModel,
} from "../services/odoo/activityTypeService";
import { SyncCredentials } from "../services/odoo/odooRpcClient";
import { addSyncTargetTables } from "../services/migrations/addSyncTargetTables";

const CREDS: SyncCredentials = { odooUrl: "https://odoo.example.com", username: "u", password: "p", database: "db" };
const CONFIG = "https://odoo.example.com|u|db";

/** Stand-in for OdooRpcClient.searchRead answering rows, or failing. */
function fakeRpc(rows: any[] | Error) {
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

const type = (over: Partial<ActivityTypeChoice> = {}): ActivityTypeChoice => ({
  id: 1, name: "To-Do", resModel: null, delayCount: 0, delayUnit: "days", delayFrom: "current_date", ...over,
});

describe("ActivityTypeService", () => {
  let db: DatabaseService;
  const at = new Date("2026-10-23T10:00:00.000Z");

  beforeEach(async () => {
    db = new DatabaseService();
    await db.initialize();
    await addSyncTargetTables(db);
  });

  const service = (rpc: any) => new ActivityTypeService(db, rpc, () => at);

  it("reads the types with their model and delay, and caches them per server", async () => {
    const rpc = fakeRpc([
      { id: 4, name: "Call", res_model: false, delay_count: 2, delay_unit: "weeks", delay_from: "current_date" },
      { id: 7, name: "Quote", res_model: "sale.order", delay_count: 0, delay_unit: "days", delay_from: "previous_activity" },
    ]);
    const list = await service(rpc).list(CREDS, { online: true });
    expect(rpc.calls[0]).toMatchObject({ model: ACTIVITY_TYPE_MODEL, domain: [] });
    expect(list).toMatchObject({ fromCache: false, error: null });
    expect(list.types).toEqual([
      type({ id: 4, name: "Call", delayCount: 2, delayUnit: "weeks" }),
      type({ id: 7, name: "Quote", resModel: "sale.order", delayFrom: "previous_activity" }),
    ]);
    expect((await db.getRemoteRecords(CONFIG, ACTIVITY_TYPE_MODEL)).map((r) => r.resId).sort()).toEqual([4, 7]);
  });

  it("serves the cached types offline, and with the error when the server fails", async () => {
    await service(fakeRpc([{ id: 4, name: "Call", res_model: false, delay_count: 3, delay_unit: "days" }]))
      .list(CREDS, { online: true });
    const offline = fakeRpc([]);
    const cached = await service(offline).list(CREDS, { online: false });
    expect(offline.calls).toHaveLength(0);
    expect(cached).toMatchObject({ fromCache: true, error: null, types: [type({ id: 4, name: "Call", delayCount: 3 })] });
    const failed = await service(fakeRpc(new TypeError("Failed to fetch"))).list(CREDS, { online: true });
    expect(failed).toMatchObject({ fromCache: true, error: "Failed to fetch" });
    expect(failed.types).toHaveLength(1);
  });
});

describe("typesForModel", () => {
  it("offers the types of any model and those of the model only", () => {
    const types = [type({ id: 1 }), type({ id: 2, resModel: "crm.lead" }), type({ id: 3, resModel: "sale.order" })];
    expect(typesForModel(types, "crm.lead").map((t) => t.id)).toEqual([1, 2]);
    expect(typesForModel(types, "res.partner").map((t) => t.id)).toEqual([1]);
  });
});

describe("defaultDeadline", () => {
  const today = new Date(2026, 0, 31, 9, 0);

  it("is today without a type or a delay", () => {
    expect(defaultDeadline(null, today)).toBe("2026-01-31");
    expect(defaultDeadline(type(), today)).toBe("2026-01-31");
  });

  it("adds the type's delay in days, weeks or months", () => {
    expect(defaultDeadline(type({ delayCount: 3 }), today)).toBe("2026-02-03");
    expect(defaultDeadline(type({ delayCount: 2, delayUnit: "weeks" }), today)).toBe("2026-02-14");
    expect(defaultDeadline(type({ delayCount: 1, delayUnit: "months" }), new Date(2026, 4, 15))).toBe("2026-06-15");
  });

  it("counts a delay from a previous activity from today, as the server does for a lone activity", () => {
    expect(defaultDeadline(type({ delayCount: 5, delayFrom: "previous_activity" }), today)).toBe("2026-02-05");
  });
});
