import { describe, it, expect } from "vitest";
import { CHAT_MODULE, CHAT_UUID_FIELD, installModule, moduleState, upgradeModule } from "../services/chat/chatModule";
import { OdooRpcError, SyncCredentials } from "../services/odoo/odooRpcClient";

const CREDS: SyncCredentials = { odooUrl: "https://odoo.example.com", username: "u", password: "p", database: "db" };

/**
 * Capability service stand-in: the fields the next ensure() sees for
 * mail.message (msgSeq) and discuss.channel (chanSeq), and its calls.
 */
function fakeCaps(msgSeq: Array<Record<string, any> | null>, chanSeq: Array<Record<string, any> | null> = [{}]) {
  const calls: any[] = [];
  const seen: Record<string, number> = {};
  return {
    calls,
    ensure: async (_c: SyncCredentials, model: string, options: any) => {
      calls.push({ model, options });
      const seq = model === "discuss.channel" ? chanSeq : msgSeq;
      const i = seen[model] ?? 0;
      seen[model] = i + 1;
      const fields = seq[Math.min(i, seq.length - 1)];
      return fields === null ? null : { fields };
    },
  } as any;
}

function fakeRpc(options: { isSystem?: boolean; rows?: any[]; installError?: Error; upgradeError?: Error } = {}) {
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
      if (method === "button_immediate_install" && options.installError) throw options.installError;
      if (method === "button_immediate_upgrade" && options.upgradeError) throw options.upgradeError;
      return true;
    },
  } as any;
}

const WITH = { [CHAT_UUID_FIELD]: { type: "char" } };

describe("chat module state", () => {
  it("is installed when the module's field is on discuss.channel", async () => {
    const rpc = fakeRpc({ isSystem: true });
    const caps = fakeCaps([WITH], [WITH]);
    expect(await moduleState(rpc, caps, CREDS, { online: true })).toBe("installed");
    expect(rpc.calls).toEqual([]);
    expect(caps.calls).toContainEqual({ model: "discuss.channel", options: { online: true, maxAgeMs: undefined } });
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
    expect(await moduleState(rpc, fakeCaps([WITH], [WITH]), CREDS, { online: false })).toBe("installed");
    expect(await moduleState(rpc, fakeCaps([{}]), CREDS, { online: false })).toBe("unknown");
    expect(rpc.calls).toEqual([]);
  });

  it("fresh bypasses the capability cache", async () => {
    const caps = fakeCaps([WITH], [WITH]);
    await moduleState(fakeRpc(), caps, CREDS, { online: true, fresh: true });
    expect(caps.calls.length).toBeGreaterThan(0);
    for (const c of caps.calls) expect(c.options).toEqual({ online: true, maxAgeMs: 0 });
  });
});

describe("chat module state matrix", () => {
  const MATRIX: Array<[string, any, any, boolean, string]> = [
    ["both fields, system", WITH, WITH, true, "installed"],
    ["both fields, not system", WITH, WITH, false, "installed"],
    ["message field only, system", WITH, {}, true, "outdated"],
    ["message field only, not system", WITH, {}, false, "outdated"],
    ["no field, not system", {}, {}, false, "unknown"],
  ];
  for (const [label, msg, chan, isSystem, expected] of MATRIX) {
    it(`${label} is ${expected}`, async () => {
      const rpc = fakeRpc({ isSystem, rows: [{ id: 7, state: "installed" }] });
      const state = await moduleState(rpc, fakeCaps([msg], [chan]), CREDS, { online: true });
      expect(state).toBe(expected);
      if (expected !== "unknown" ) expect(rpc.calls).toEqual([]);
    });
  }

  it("no field, system user with a row to upgrade is outdated", async () => {
    const rpc = fakeRpc({ isSystem: true, rows: [{ id: 7, state: "to upgrade" }] });
    expect(await moduleState(rpc, fakeCaps([{}]), CREDS, { online: true })).toBe("outdated");
  });

  it("offline, reads both cached capabilities", async () => {
    const rpc = fakeRpc({ isSystem: true });
    expect(await moduleState(rpc, fakeCaps([WITH], [{}]), CREDS, { online: false })).toBe("outdated");
    expect(rpc.calls).toEqual([]);
  });
});

describe("upgrade chat module", () => {
  it("upgrades the module row, then probes fresh", async () => {
    const rpc = fakeRpc({ isSystem: true, rows: [{ id: 7, state: "installed" }] });
    const caps = fakeCaps([WITH], [{}, WITH]);
    expect(await upgradeModule(rpc, caps, CREDS)).toBe("installed");
    expect(rpc.calls).toContain("ir.module.module.button_immediate_upgrade [[7]]");
    expect(caps.calls.at(-1).options.maxAgeMs).toBe(0);
  });

  it("treats a lost response as no error and returns what the probe says", async () => {
    const rpc = fakeRpc({ isSystem: true, rows: [{ id: 7, state: "installed" }], upgradeError: new Error("timeout") });
    expect(await upgradeModule(rpc, fakeCaps([WITH], [{}, WITH]), CREDS)).toBe("installed");
  });

  it("returns the probed state on an AccessError and propagates other server errors", async () => {
    const denied = new OdooRpcError("denied", "odoo.exceptions.AccessError");
    const refused = fakeRpc({ isSystem: true, rows: [{ id: 7, state: "installed" }], upgradeError: denied });
    expect(await upgradeModule(refused, fakeCaps([WITH], [{}]), CREDS)).toBe("outdated");
    const boom = new OdooRpcError("broken", "odoo.exceptions.UserError");
    const broken = fakeRpc({ isSystem: true, rows: [{ id: 7, state: "installed" }], upgradeError: boom });
    await expect(upgradeModule(broken, fakeCaps([WITH], [{}]), CREDS)).rejects.toBe(boom);
  });

  it("never upgrades for a non-system user nor when not outdated", async () => {
    const user = fakeRpc({ isSystem: false });
    expect(await upgradeModule(user, fakeCaps([WITH], [{}]), CREDS)).toBe("outdated");
    expect(user.calls).toEqual([]);
    const current = fakeRpc({ isSystem: true, rows: [{ id: 7, state: "installed" }] });
    expect(await upgradeModule(current, fakeCaps([WITH], [WITH]), CREDS)).toBe("installed");
    expect(current.calls).toEqual([]);
  });
});

describe("install chat module", () => {
  it("installs the module row, then probes fresh", async () => {
    const rpc = fakeRpc({ isSystem: true, rows: [{ id: 7, state: "uninstalled" }] });
    const caps = fakeCaps([{}, WITH], [{}, WITH]);
    expect(await installModule(rpc, caps, CREDS)).toBe("installed");
    expect(rpc.calls).toContain("ir.module.module.button_immediate_install [[7]]");
    expect(caps.calls.at(-1).options.maxAgeMs).toBe(0);
  });

  it("treats a lost response as no error and returns what the probe says", async () => {
    const rpc = fakeRpc({ isSystem: true, rows: [{ id: 7, state: "uninstalled" }], installError: new Error("timeout") });
    expect(await installModule(rpc, fakeCaps([{}, WITH], [{}, WITH]), CREDS)).toBe("installed");
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
