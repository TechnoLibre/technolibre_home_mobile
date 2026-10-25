import { describe, it, expect } from "vitest";
import { CHAT_MODULE, CHAT_UUID_FIELD, installModule, moduleState } from "../services/chat/chatModule";
import { OdooRpcError, SyncCredentials } from "../services/odoo/odooRpcClient";

const CREDS: SyncCredentials = { odooUrl: "https://odoo.example.com", username: "u", password: "p", database: "db" };

/** Capability service stand-in: the fields the next ensure() sees, and its calls. */
function fakeCaps(fieldsSeq: Array<Record<string, any> | null>) {
  const calls: any[] = [];
  let i = 0;
  return {
    calls,
    ensure: async (_c: SyncCredentials, model: string, options: any) => {
      calls.push({ model, options });
      const fields = fieldsSeq[Math.min(i++, fieldsSeq.length - 1)];
      return fields === null ? null : { fields };
    },
  } as any;
}

function fakeRpc(options: { isSystem?: boolean; rows?: any[]; installError?: Error } = {}) {
  const calls: string[] = [];
  return {
    calls,
    sessionInfo: async () => ({ isSystem: options.isSystem ?? false }),
    searchRead: async (_c: SyncCredentials, model: string, domain: any[]) => {
      calls.push(`search_read ${model} ${JSON.stringify(domain)}`);
      return options.rows ?? [];
    },
    callKw: async (_c: SyncCredentials, model: string, method: string, args: any[]) => {
      calls.push(`${model}.${method} ${JSON.stringify(args)}`);
      if (options.installError) throw options.installError;
      return true;
    },
  } as any;
}

const WITH = { [CHAT_UUID_FIELD]: { type: "char" } };

describe("chat module state", () => {
  it("is installed when the module's field is on mail.message", async () => {
    const rpc = fakeRpc({ isSystem: true });
    const caps = fakeCaps([WITH]);
    expect(await moduleState(rpc, caps, CREDS, { online: true })).toBe("installed");
    expect(rpc.calls).toEqual([]);
    expect(caps.calls[0]).toEqual({ model: "mail.message", options: { online: true, maxAgeMs: undefined } });
  });

  it("is available to a system user when the module row is uninstalled", async () => {
    const rpc = fakeRpc({ isSystem: true, rows: [{ id: 7, state: "uninstalled" }] });
    expect(await moduleState(rpc, fakeCaps([{}]), CREDS, { online: true })).toBe("available");
    expect(rpc.calls[0]).toBe(`search_read ir.module.module ${JSON.stringify([["name", "=", CHAT_MODULE]])}`);
  });

  it("is absent when no module row exists", async () => {
    const rpc = fakeRpc({ isSystem: true, rows: [] });
    expect(await moduleState(rpc, fakeCaps([{}]), CREDS, { online: true })).toBe("absent");
  });

  it("is installed when the row says installed but the registry has no field yet", async () => {
    const rpc = fakeRpc({ isSystem: true, rows: [{ id: 7, state: "installed" }] });
    expect(await moduleState(rpc, fakeCaps([{}]), CREDS, { online: true })).toBe("installed");
  });

  it("is unknown to a user who is not a system user", async () => {
    const rpc = fakeRpc({ isSystem: false });
    expect(await moduleState(rpc, fakeCaps([{}]), CREDS, { online: true })).toBe("unknown");
    expect(rpc.calls).toEqual([]);
  });

  it("is unknown offline without a cached capability, and asks nothing of the server", async () => {
    const rpc = fakeRpc({ isSystem: true });
    expect(await moduleState(rpc, fakeCaps([null]), CREDS, { online: false })).toBe("unknown");
    expect(rpc.calls).toEqual([]);
  });

  it("offline, reads the cached field and does not query the module row", async () => {
    const rpc = fakeRpc({ isSystem: true, rows: [{ id: 7, state: "uninstalled" }] });
    expect(await moduleState(rpc, fakeCaps([WITH]), CREDS, { online: false })).toBe("installed");
    expect(await moduleState(rpc, fakeCaps([{}]), CREDS, { online: false })).toBe("unknown");
    expect(rpc.calls).toEqual([]);
  });

  it("fresh bypasses the capability cache", async () => {
    const caps = fakeCaps([WITH]);
    await moduleState(fakeRpc(), caps, CREDS, { online: true, fresh: true });
    expect(caps.calls[0].options).toEqual({ online: true, maxAgeMs: 0 });
  });
});

describe("install chat module", () => {
  it("installs the module row, then probes fresh", async () => {
    const rpc = fakeRpc({ isSystem: true, rows: [{ id: 7, state: "uninstalled" }] });
    const caps = fakeCaps([{}, WITH]);
    expect(await installModule(rpc, caps, CREDS)).toBe("installed");
    expect(rpc.calls).toContain("ir.module.module.button_immediate_install [[7]]");
    expect(caps.calls.at(-1).options.maxAgeMs).toBe(0);
  });

  it("treats a lost response as no error and returns what the probe says", async () => {
    const rpc = fakeRpc({ isSystem: true, rows: [{ id: 7, state: "uninstalled" }], installError: new Error("timeout") });
    expect(await installModule(rpc, fakeCaps([{}, WITH]), CREDS)).toBe("installed");
  });

  it("returns the probed state when the server refuses with an AccessError", async () => {
    const refusal = new OdooRpcError("denied", "odoo.exceptions.AccessError");
    const rpc = fakeRpc({ isSystem: true, rows: [{ id: 7, state: "uninstalled" }], installError: refusal });
    expect(await installModule(rpc, fakeCaps([{}, {}]), CREDS)).toBe("available");
  });

  it("propagates any other server error", async () => {
    const boom = new OdooRpcError("broken", "odoo.exceptions.UserError");
    const rpc = fakeRpc({ isSystem: true, rows: [{ id: 7, state: "uninstalled" }], installError: boom });
    await expect(installModule(rpc, fakeCaps([{}]), CREDS)).rejects.toBe(boom);
  });

  it("does not call install when the module is not available", async () => {
    const rpc = fakeRpc({ isSystem: true, rows: [] });
    expect(await installModule(rpc, fakeCaps([{}]), CREDS)).toBe("absent");
    expect(rpc.calls.some((c: string) => c.includes("button_immediate_install"))).toBe(false);
  });
});
