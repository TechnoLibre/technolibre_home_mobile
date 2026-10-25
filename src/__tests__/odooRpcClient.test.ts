import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";
import { Capacitor, __clearPluginMocks, __setPluginMock } from "@capacitor/core";
import { OdooRpcClient, OdooRpcError, RequestNotSentError, SyncCredentials, syncSessionKey } from "../services/odoo/odooRpcClient";

const CREDS: SyncCredentials = { odooUrl: "https://odoo.example.com", username: "u", password: "p", database: "db" };

type Call = { url: string; params: any };

/** fetch mock answering each call_kw through handler(params). */
function server(handler: (params: any) => object) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (url: string, opts: { body: string }) => {
    const params = JSON.parse(opts.body).params;
    calls.push({ url, params });
    const text = JSON.stringify(handler(params));
    return { ok: true, status: 200, text: async () => text, headers: { forEach: () => {} } } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

async function storeSession(version: number) {
  await SecureStoragePlugin.set({
    key: syncSessionKey(CREDS),
    value: JSON.stringify({ sessionId: "sid", odooMajorVersion: version, createdAt: new Date().toISOString() }),
  });
}

const rpcError = (name: string, message = "nope") => ({ error: { code: 200, message: "Odoo Server Error", data: { name, message } } });

describe("OdooRpcClient authenticate over fetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    SecureStoragePlugin._store.clear();
  });

  it("keeps the new session when the old one's deletion comes after it", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const headers = new Headers();
      if (url.endsWith("/web/session/authenticate")) {
        headers.append("set-cookie", "session_id=NEWSESSION; Path=/; HttpOnly");
        headers.append("set-cookie", "session_id=OLDSESSION; Max-Age=0; Path=/");
      }
      const result = url.endsWith("/web/session/authenticate")
        ? { uid: 2, server_version_info: [17, 0, 0, "final", 0] }
        : { server_version_info: [17, 0, 0, "final", 0] };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200, headers });
    }));
    const session = await new OdooRpcClient().authenticate(CREDS);
    expect(session.sessionId).toBe("NEWSESSION");
  });
});

describe("OdooRpcClient helpers", () => {
  let rpc: OdooRpcClient;

  beforeEach(async () => {
    SecureStoragePlugin._store.clear();
    rpc = new OdooRpcClient();
    await storeSession(17);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("sends model, method, args and kwargs through call_kw with the session cookie", async () => {
    const calls = server(() => ({ result: 3 }));
    expect(await rpc.callKw(CREDS, "res.partner", "search_count", [[]], { context: { lang: "fr_FR" } })).toBe(3);
    expect(calls[0].url).toBe("https://odoo.example.com/web/dataset/call_kw");
    expect(calls[0].params).toEqual({
      model: "res.partner", method: "search_count", args: [[]], kwargs: { context: { lang: "fr_FR" } },
    });
  });

  it("searchRead passes domain, fields and options", async () => {
    const calls = server(() => ({ result: [{ id: 1 }] }));
    await rpc.searchRead(CREDS, "project.project", [["active", "=", true]], ["name"], { limit: 5, order: "name" });
    expect(calls[0].params.kwargs).toEqual({ domain: [["active", "=", true]], fields: ["name"], limit: 5, order: "name" });
  });

  it("nameSearch maps [id, name] pairs", async () => {
    const calls = server(() => ({ result: [[4, "Acme"], [9, "Acme Inc"]] }));
    expect(await rpc.nameSearch(CREDS, "res.partner", "acme", { limit: 2 })).toEqual([
      { id: 4, name: "Acme" }, { id: 9, name: "Acme Inc" },
    ]);
    expect(calls[0].params.method).toBe("name_search");
    expect(calls[0].params.kwargs).toEqual({ name: "acme", args: [], operator: "ilike", limit: 2 });
  });

  it("fieldsGet asks the default attributes, optionally for some fields", async () => {
    const calls = server(() => ({ result: { name: { type: "char", required: true } } }));
    await rpc.fieldsGet(CREDS, "crm.lead");
    await rpc.fieldsGet(CREDS, "crm.lead", ["type"], ["name"]);
    expect(calls[0].params.args).toEqual([]);
    expect(calls[0].params.kwargs.attributes).toEqual(["type", "string", "required", "readonly", "relation", "selection", "depends"]);
    expect(calls[1].params.args).toEqual([["name"]]);
    expect(calls[1].params.kwargs.attributes).toEqual(["type"]);
  });

  it("an unknown model reaches the caller as an OdooRpcError, not a wrapped Error", async () => {
    server(() => rpcError("builtins.KeyError", "x.y"));
    const err = await rpc.fieldsGet(CREDS, "x.y").catch((e) => e);
    expect(err).toBeInstanceOf(OdooRpcError);
    expect(err.odooName).toBe("builtins.KeyError");
  });

  it("defaultGet sends the fields and the context", async () => {
    const calls = server(() => ({ result: { type: "opportunity" } }));
    expect(await rpc.defaultGet(CREDS, "crm.lead", ["type"], { default_type: "opportunity" })).toEqual({ type: "opportunity" });
    expect(calls[0].params.args).toEqual([["type"]]);
    expect(calls[0].params.kwargs).toEqual({ context: { default_type: "opportunity" } });
  });

  it("checkAccess uses check_access_rights without raising on Odoo 17", async () => {
    const calls = server(() => ({ result: false }));
    expect(await rpc.checkAccess(CREDS, "crm.lead", "create")).toBe(false);
    expect(calls.map((c) => c.params.method)).toEqual(["check_access_rights"]);
    expect(calls[0].params.args).toEqual(["create"]);
    expect(calls[0].params.kwargs).toEqual({ raise_exception: false });
  });

  it("checkAccess uses has_access on Odoo 18, then check_access_rights if refused", async () => {
    await storeSession(18);
    let calls = server(() => ({ result: true }));
    expect(await rpc.checkAccess(CREDS, "crm.lead", "write")).toBe(true);
    expect(calls.map((c) => [c.params.method, c.params.args])).toEqual([["has_access", [[], "write"]]]);

    calls = server((p) => (p.method === "has_access" ? rpcError("odoo.exceptions.AccessError") : { result: true }));
    expect(await rpc.checkAccess(CREDS, "crm.lead", "write")).toBe(true);
    expect(calls.map((c) => c.params.method)).toEqual(["has_access", "check_access_rights"]);
  });

  it("checkAccess answers null when no probe is accepted", async () => {
    server(() => rpcError("odoo.exceptions.AccessError"));
    expect(await rpc.checkAccess(CREDS, "crm.lead", "read")).toBeNull();
  });

  it("checkAccess lets a transport failure through", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    await expect(rpc.checkAccess(CREDS, "crm.lead", "read")).rejects.toThrow("Failed to fetch");
  });

  it("messagePost posts an internal HTML note on Odoo 17+, with optional attachments", async () => {
    const calls = server(() => ({ result: 321 }));
    expect(await rpc.messagePost(CREDS, "account.move", 8, "<p>hi</p>", { attachmentIds: [2] })).toBe(321);
    expect(calls[0].params.args).toEqual([[8]]);
    expect(calls[0].params.kwargs).toEqual({
      body: "<p>hi</p>", body_is_html: true, message_type: "comment",
      subtype_xmlid: "mail.mt_note", attachment_ids: [2],
    });
  });

  it("messagePost sends no body_is_html to Odoo 16, which has no such parameter", async () => {
    await storeSession(16);
    const calls = server(() => ({ result: 1 }));
    await rpc.messagePost(CREDS, "account.move", 8, "<p>hi</p>");
    expect(calls[0].params.kwargs).not.toHaveProperty("body_is_html");
  });

  it("sessionInfo returns partner id, system flag and websocket version", async () => {
    const calls = server(() => ({
      result: {
        uid: 7, partner_id: 42, is_system: true, websocket_worker_version: "18.0-7",
        user_companies: { allowed_companies: { 1: { id: 1, name: "Main" } }, current_company: 1 },
      },
    }));
    expect(await rpc.sessionInfo(CREDS)).toEqual({
      uid: 7, companies: [{ id: 1, name: "Main" }], currentCompany: 1,
      partnerId: 42, isSystem: true, websocketWorkerVersion: "18.0-7",
      internalUserGroupId: null, globalMuteUntil: null, isInternalUser: false,
    });
    await rpc.sessionInfo(CREDS);
    expect(calls).toHaveLength(1);
  });

  it("sessionInfo reads the internal group, the global mute and the internal-user flag", async () => {
    server(() => ({
      result: {
        uid: 7, is_internal_user: true,
        storeData: { Store: { internalUserGroupId: 11, settings: { mute_until_dt: "2026-02-01 10:00:00" } } },
      },
    }));
    expect(await rpc.sessionInfo(CREDS)).toMatchObject({
      internalUserGroupId: 11, globalMuteUntil: "2026-02-01 10:00:00", isInternalUser: true,
    });
  });

  it("sessionInfo falls back when the server omits the new keys", async () => {
    server(() => ({ result: { uid: 7 } }));
    expect(await rpc.sessionInfo(CREDS)).toMatchObject({
      partnerId: 0, isSystem: false, websocketWorkerVersion: null,
      internalUserGroupId: null, globalMuteUntil: null, isInternalUser: false,
    });
  });

  it("odooVersion reads the stored session", async () => {
    await storeSession(16);
    expect(await rpc.odooVersion(CREDS)).toBe(16);
  });
});

describe("OdooRpcClient over the native RawHttp", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    __clearPluginMocks();
  });

  const nativeRejecting = (error: unknown) => {
    vi.spyOn(Capacitor, "isNativePlatform").mockReturnValue(true);
    __setPluginMock("RawHttp", { post: vi.fn(async () => { throw error; }) });
  };

  it("a connection that never opened is a RequestNotSentError, through callWithAuth too", async () => {
    nativeRejecting(Object.assign(new Error("RawHttp error: Connection refused"), { code: "UNSENT" }));
    await storeSession(18);
    const rpc = new OdooRpcClient();
    await expect(rpc.callWithAuth(CREDS, (sid) => rpc.jsonRoute(CREDS.odooUrl, sid, "/mail/message/post", {})))
      .rejects.toBeInstanceOf(RequestNotSentError);
  });

  it("any other failure, a read timeout among them, is not", async () => {
    nativeRejecting(new Error("RawHttp error: Read timed out"));
    await storeSession(18);
    const rpc = new OdooRpcClient();
    const failure = rpc.callWithAuth(CREDS, (sid) => rpc.jsonRoute(CREDS.odooUrl, sid, "/mail/message/post", {}));
    await expect(failure).rejects.toThrow("Read timed out");
    await expect(failure).rejects.not.toBeInstanceOf(RequestNotSentError);
  });
});
