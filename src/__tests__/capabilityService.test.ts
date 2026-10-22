import { describe, it, expect, beforeEach } from "vitest";
import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";
import { DatabaseService } from "../services/databaseService";
import { CapabilityService, unusableReason } from "../services/odoo/capabilityService";
import { OdooRpcError, SyncCredentials } from "../services/odoo/odooRpcClient";

const CREDS: SyncCredentials = { odooUrl: "https://odoo.example.com", username: "u", password: "p", database: "db" };
const CONFIG = "https://odoo.example.com|u|db";

/** Stand-in for OdooRpcClient: fields per model, rights per operation. */
function fakeRpc(options: {
  fields?: Record<string, Record<string, any>>;
  fieldsError?: Error;
  access?: Record<string, boolean | null>;
} = {}) {
  const calls: string[] = [];
  return {
    calls,
    odooVersion: async () => 17,
    fieldsGet: async (_c: SyncCredentials, model: string) => {
      calls.push(`fields_get ${model}`);
      if (options.fieldsError) throw options.fieldsError;
      return options.fields?.[model] ?? {};
    },
    checkAccess: async (_c: SyncCredentials, _model: string, op: string) => {
      calls.push(`access ${op}`);
      return options.access?.[op] ?? true;
    },
  } as any;
}

describe("CapabilityService", () => {
  let db: DatabaseService;
  let clock: Date;

  beforeEach(async () => {
    SecureStoragePlugin._store.clear();
    db = new DatabaseService();
    await db.initialize();
    await db.createServerCapabilitiesTable();
    clock = new Date("2026-10-23T10:00:00.000Z");
  });

  const service = (rpc: any) => new CapabilityService(db, rpc, () => clock);

  it("probes fields, rights, activities and chatter, and caches them per server", async () => {
    const rpc = fakeRpc({
      fields: { "crm.lead": { name: { type: "char" }, activity_ids: { type: "one2many" }, message_ids: { type: "one2many" } } },
      access: { write: false },
    });
    const cap = await service(rpc).probe(CREDS, "crm.lead");
    expect(cap).toMatchObject({
      configId: CONFIG, model: "crm.lead", exists: true,
      canRead: true, canCreate: true, canWrite: false,
      hasActivities: true, hasChatter: true, odooVersion: 17, error: null,
    });
    expect(await db.getServerCapability(CONFIG, "crm.lead")).toEqual(cap);
    expect(rpc.calls).toEqual(["fields_get crm.lead", "access read", "access create", "access write"]);
  });

  it("stores a model the server does not know as missing", async () => {
    const rpc = fakeRpc({ fieldsError: new OdooRpcError("RPC x.y.fields_get: KeyError", "builtins.KeyError") });
    const cap = await service(rpc).probe(CREDS, "x.y");
    expect(cap.exists).toBe(false);
    expect(cap.error).toContain("KeyError");
    expect(unusableReason(cap, ["create"])).toBe("missing_model");
    expect(rpc.calls).toEqual(["fields_get x.y"]);
  });

  it("stores a refused fields_get as an existing model without rights", async () => {
    const rpc = fakeRpc({ fieldsError: new OdooRpcError("denied", "odoo.exceptions.AccessError") });
    const cap = await service(rpc).probe(CREDS, "account.move");
    expect(cap).toMatchObject({ exists: true, canRead: false, canCreate: false, canWrite: false });
    expect(unusableReason(cap, ["read"])).toBe("no_access");
  });

  it("does not take another server error for a missing model", async () => {
    await service(fakeRpc({ fields: { "crm.lead": { name: {} } } })).probe(CREDS, "crm.lead");
    const failing = fakeRpc({ fieldsError: new OdooRpcError("boom", "odoo.exceptions.UserError") });
    await expect(service(failing).probe(CREDS, "crm.lead")).rejects.toThrow("boom");
    expect((await db.getServerCapability(CONFIG, "crm.lead"))!.exists).toBe(true);
  });

  it("keeps the cache when the server cannot be reached", async () => {
    await service(fakeRpc({ fields: { "crm.lead": { name: {} } } })).probe(CREDS, "crm.lead");
    const down = fakeRpc({ fieldsError: new TypeError("Failed to fetch") });
    await expect(service(down).probe(CREDS, "crm.lead")).rejects.toThrow("Failed to fetch");
    expect((await db.getServerCapability(CONFIG, "crm.lead"))!.exists).toBe(true);
  });

  it("ensure serves a fresh cache, probes a stale one online, keeps it offline", async () => {
    const rpc = fakeRpc({ fields: { "crm.lead": { name: {} } } });
    const svc = service(rpc);
    expect(await svc.ensure(CREDS, "crm.lead", { online: false })).toBeNull();
    await svc.ensure(CREDS, "crm.lead", { online: true });
    expect(rpc.calls.filter((c: string) => c.startsWith("fields_get"))).toHaveLength(1);

    await svc.ensure(CREDS, "crm.lead", { online: true });
    expect(rpc.calls.filter((c: string) => c.startsWith("fields_get"))).toHaveLength(1);

    clock = new Date(clock.getTime() + 25 * 3600 * 1000);
    expect(await svc.ensure(CREDS, "crm.lead", { online: false })).not.toBeNull();
    expect(rpc.calls.filter((c: string) => c.startsWith("fields_get"))).toHaveLength(1);
    await svc.ensure(CREDS, "crm.lead", { online: true });
    expect(rpc.calls.filter((c: string) => c.startsWith("fields_get"))).toHaveLength(2);
  });

  it("ensure falls back to the stale cache when the probe fails", async () => {
    await service(fakeRpc({ fields: { "crm.lead": { name: {} } } })).probe(CREDS, "crm.lead");
    clock = new Date(clock.getTime() + 25 * 3600 * 1000);
    const cap = await service(fakeRpc({ fieldsError: new TypeError("offline") })).ensure(CREDS, "crm.lead", { online: true });
    expect(cap!.exists).toBe(true);
  });

  it("forgets a server's probes", async () => {
    await service(fakeRpc()).probe(CREDS, "crm.lead");
    await db.deleteServerCapabilities(CONFIG);
    expect(await db.getServerCapability(CONFIG, "crm.lead")).toBeNull();
  });

  describe("unusableReason", () => {
    const cap = (over: Record<string, any>) => ({
      configId: CONFIG, model: "m", exists: true, canRead: true, canCreate: true, canWrite: true,
      hasActivities: true, hasChatter: true, fields: {}, odooVersion: 17, probedAt: "", error: null, ...over,
    });

    it("needs a probe", () => expect(unusableReason(null, ["read"])).toBe("unknown"));
    it("checks each need", () => {
      expect(unusableReason(cap({ canCreate: false }), ["create"])).toBe("no_access");
      expect(unusableReason(cap({ hasActivities: false }), ["activities"])).toBe("no_activities");
      expect(unusableReason(cap({ hasChatter: false }), ["chatter"])).toBe("no_chatter");
      expect(unusableReason(cap({ canWrite: false }), ["create"])).toBeNull();
    });
    it("does not block on a right the server did not answer", () => {
      expect(unusableReason(cap({ canCreate: null }), ["create"])).toBeNull();
    });
  });
});
