import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";
import { createSyncEnv, installLocalStorage, resetMocks, setNetwork, type SyncEnv } from "../testing/syncTestKit";
import { fakeChatPushNative, type FakeChatPushNative } from "../__mocks__/chatPushNative";
import { OdooRpcClient, syncSessionKey, type SyncCredentials } from "../services/odoo/odooRpcClient";
import { OutboxService } from "../services/outboxService";
import { CapabilityService } from "../services/odoo/capabilityService";
import { ChatService, type ChatSource } from "../services/chat/chatService";
import { PUSH_STRING_KEYS } from "../services/chat/chatPush";
import { parseNtfyLink, type NtfyLink } from "../services/chat/chatPushLink";
import { chatSettings } from "../services/chat/chatSettings";
import { setHttpAllowed } from "../services/odoo/httpPolicy";
import { AppService } from "../services/appService";
import { DatabaseService } from "../services/databaseService";
import { APP_MIGRATIONS } from "../services/migrations";
import { ChatRepository } from "../services/chat/chatRepository";
import { t } from "../i18n";
import type { PushSettingsMirror } from "../plugins/chatPushPlugin";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const A = { url: "https://odoo.exemple.test", username: "alice", password: "pw", database: "db1" };
const B = { url: "https://bureau.exemple.test", username: "alice", password: "pw", database: "db1" };
const OLD = { url: "https://ancien.exemple.test", username: "alice", password: "pw", database: "db1" };

const LINK = "erplibre-ntfy:setup?v=1&url=http%3A%2F%2Fntfy.exemple.test%3A8080&token=tk_exempleexempleexempleexemple"
  + "&prefix=upab12cd34&cache=43200";
const NTFY = "http://ntfy.exemple.test:8080";
const ODOO_SIDE = "http://odoo-ntfy.exemple.test:8080";
const VAPID = "BExempleVapidUn";

const SELF = 3;
const BOB = 4;
const CHAT = 10;
const GROUP = 11;
const GENERAL = 12;

const link = (over: Partial<NtfyLink> = {}): NtfyLink => ({ ...parseNtfyLink(LINK)!, ...over });

/**
 * A /mail/data answer: a chat with Bruno Tremblay, a group and a channel,
 * each with the self member's counters and one message.
 */
function mailData(o: { chatUnread?: number; groupUnread?: number; mentions?: number } = {}) {
  const channels: any[] = [];
  const members: any[] = [];
  const messages: any[] = [];
  let memberId = 100;
  const add = (id: number, type: string, name: string, unread: number, needaction: number, last: number) => {
    channels.push({
      id, channel_type: type, name, last_interest_dt: "2026-10-25 09:00:00",
      message_needaction_counter: needaction, mute_until_dt: false, custom_notifications: false,
    });
    members.push({
      id: memberId++, thread: { id, model: "discuss.channel" }, persona: { id: SELF, type: "partner" },
      message_unread_counter: unread, new_message_separator: last - unread + 1, seen_message_id: last - unread,
    });
    if (type !== "channel") {
      members.push({ id: memberId++, thread: { id, model: "discuss.channel" }, persona: { id: BOB, type: "partner" } });
    }
    messages.push({
      id: last, body: `<p>m${last}</p>`, date: "2026-10-25 09:00:00", message_type: "comment",
      author: { id: BOB, type: "partner" }, thread: { id, model: "discuss.channel" },
    });
  };
  add(CHAT, "chat", "", o.chatUnread ?? 0, 0, 80);
  add(GROUP, "group", "Équipe", o.groupUnread ?? 0, 0, 90);
  add(GENERAL, "channel", "Général", 5, o.mentions ?? 0, 100);
  return {
    Store: { inbox: { counter: 0, counter_bus_id: 1000, id: "inbox", model: "mail.box" } },
    "discuss.channel": channels,
    "discuss.channel.member": members,
    "mail.message": messages,
    "res.partner": [{ id: SELF, name: "Alice Martin" }, { id: BOB, name: "Bruno Tremblay" }],
  };
}

/**
 * A fake Odoo per host: Odoo 17 on OLD's host, 18 elsewhere. mail.push.device
 * keeps its devices by endpoint as Odoo does: register_devices refuses a
 * VAPID key other than the server's and leaves a known endpoint as it is;
 * `hang` keeps every unregister_devices call on the wire.
 */
function fakeOdoo() {
  const calls: { host: string; path: string; params: any }[] = [];
  const state = {
    vapid: VAPID,
    devices: new Map<string, { keys: any; host: string }>(),
    data: mailData() as any,
    hang: false,
  };
  const ok = (result: unknown) => ({
    ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, result }), headers: { forEach: () => {} },
  } as unknown as Response);
  const rpcError = (name: string) => ({
    ok: true, status: 200, headers: { forEach: () => {} },
    text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: 200, message: "Odoo Server Error", data: { name, message: "refused" } } }),
  } as unknown as Response);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: { body: string }) => {
    const u = new URL(url);
    const params = JSON.parse(init.body).params;
    calls.push({ host: u.hostname, path: u.pathname, params });
    switch (u.pathname) {
      case "/web/session/authenticate":
        return ok({ uid: 2, session_id: `sid-${u.hostname}`, server_version_info: [u.hostname.startsWith("ancien") ? 17 : 18, 0, 0, "final", 0, ""] });
      case "/web/session/get_session_info":
        return ok({
          uid: 2, partner_id: SELF, is_system: false, websocket_worker_version: "18.0-7", is_internal_user: true,
          storeData: { Store: { internalUserGroupId: 11, settings: { mute_until_dt: false } } },
        });
      case "/mail/data":
        return ok(JSON.parse(JSON.stringify(state.data)));
      case "/web/dataset/call_kw": {
        const { model, method, kwargs } = params;
        if (model === "mail.push.device") {
          if (method === "get_web_push_vapid_public_key") return ok(state.vapid);
          if (method === "register_devices") {
            if (kwargs.vapid_public_key !== state.vapid) return rpcError("odoo.addons.mail.tools.jwt.InvalidVapidError");
            if (!state.devices.has(kwargs.endpoint)) state.devices.set(kwargs.endpoint, { keys: kwargs.keys, host: u.hostname });
            return ok(null);
          }
          if (method === "unregister_devices") {
            if (state.hang) return new Promise<Response>(() => {});
            state.devices.delete(kwargs.endpoint);
            return ok(null);
          }
        }
        if (method === "search_read") return ok([]);
        if (method === "fields_get") return ok({});
        return ok(true);
      }
      default:
        return ok(true);
    }
  }));
  const kw = (method: string) => calls.filter((c) => c.path === "/web/dataset/call_kw" && c.params.method === method);
  return { calls, state, kw };
}

const settled = () => new Promise((r) => setTimeout(r, 0));

describe("ChatPush", () => {
  let env: SyncEnv;
  let chat: ChatService;
  let rpc: OdooRpcClient;
  let native: FakeChatPushNative;
  let odoo: ReturnType<typeof fakeOdoo>;
  let clock: Date;
  let ids: string[];

  const build = async (targets = [A, B], versions = ["18.0", "18.0"]) => {
    env = await createSyncEnv(targets);
    rpc = new OdooRpcClient();
    native = fakeChatPushNative();
    chat = new ChatService(env.db, rpc, new OutboxService(env.db, () => clock), new CapabilityService(env.db, rpc), () => clock, { native });
    for (const [i, t] of targets.entries()) await env.db.setApplicationOdooVersion(t.url, t.username, versions[i]);
    ids = env.configIds;
  };
  const sources = async (): Promise<ChatSource[]> => chat.sources({ online: false });
  const sourceOf = async (configId: string) => (await sources()).find((s) => s.configId === configId)!;
  const credsOf = (t: typeof A): SyncCredentials => ({ odooUrl: t.url, username: t.username, password: t.password, database: t.database });
  const storeSession = (t: typeof A, sessionId: string) => SecureStoragePlugin.set({
    key: syncSessionKey(credsOf(t)),
    value: JSON.stringify({ sessionId, odooMajorVersion: 18, createdAt: clock.toISOString() }),
  });
  const lastMirror = () => native.settings as PushSettingsMirror;
  const indexOf = (method: string, test: (args: any) => boolean = () => true) =>
    native.calls.findIndex((c) => c.method === method && test(c.args));

  beforeEach(async () => {
    resetMocks();
    installLocalStorage({ allowHttp: true });
    setNetwork({ connected: true, wifi: true });
    clock = new Date("2026-10-28T10:00:00.000Z");
    odoo = fakeOdoo();
    await build();
  });

  afterEach(() => {
    chat.dispose();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("the strings mirrored are the native fallback keys, each through t()", () => {
    const java = readFileSync(resolve(ROOT, "android/app/src/main/java/ca/erplibre/home/chatpush/PushStrings.java"), "utf-8");
    const javaKeys = [...java.matchAll(/FALLBACK\.put\("([a-z_]+)"/g)].map((m) => m[1]);
    expect([...PUSH_STRING_KEYS].sort()).toEqual([...javaKeys].sort());
    for (const key of PUSH_STRING_KEYS) expect(t(`chat.push_${key}`)).not.toBe(`chat.push_${key}`);
    expect(t("chat.push_summary")).toBe("{n} nouveaux messages — {server}");
  });

  it("applyLink subscribes each account and registers its endpoint with the vapid key", async () => {
    const result = await chat.push.applyLink(ids, link());
    expect(result).toEqual({ ok: true, reason: null, registered: ids });
    expect(native.callsOf("setNtfy")).toEqual([{ url: NTFY, token: "tk_exempleexempleexempleexemple", prefix: "upab12cd34", cacheSeconds: 43200 }]);
    expect(native.callsOf("subscribe")).toEqual([
      { configId: ids[0], ntfyUrl: NTFY, renew: true },
      { configId: ids[1], ntfyUrl: NTFY, renew: true },
    ]);
    const registers = odoo.kw("register_devices");
    expect(registers.map((c) => [c.host, c.params.kwargs])).toEqual([
      ["odoo.exemple.test", { endpoint: `${NTFY}/upab12cd34fake1`, keys: { p256dh: "pub1", auth: "auth1" }, vapid_public_key: VAPID, expirationTime: null }],
      ["bureau.exemple.test", { endpoint: `${NTFY}/upab12cd34fake2`, keys: { p256dh: "pub2", auth: "auth2" }, vapid_public_key: VAPID, expirationTime: null }],
    ]);
    // The VAPID key is asked before each registration
    const vapidAt = odoo.calls.findIndex((c) => c.params?.method === "get_web_push_vapid_public_key");
    expect(vapidAt).toBeLessThan(odoo.calls.indexOf(registers[0]));
    expect(await chat.repo.pushRow(ids[0])).toMatchObject({
      configId: ids[0], ntfyUrl: NTFY, odooNtfyUrl: null, prefix: "upab12cd34", topic: "upab12cd34fake1",
      endpoint: `${NTFY}/upab12cd34fake1`, p256dh: "pub1", auth: "auth1", vapidKey: VAPID,
      registeredAt: clock.toISOString(), staleEndpoints: [], lockScreen: "hidden_locked",
    });
    // The settings go before setNtfy (an http ntfy needs allowHttp mirrored); an equal mirror is not sent again
    expect(indexOf("publishSettings")).toBeLessThan(indexOf("setNtfy"));
    expect(lastMirror().allowHttp).toBe(true);
    expect(lastMirror().accounts.map((a) => a.configId)).toEqual(ids);
  });

  it("the endpoint uses the Odoo-side url when the link has one", async () => {
    await chat.push.applyLink([ids[0]], link({ odooUrl: ODOO_SIDE }));
    expect(odoo.kw("register_devices")[0].params.kwargs.endpoint).toBe(`${ODOO_SIDE}/upab12cd34fake1`);
    expect(await chat.repo.pushRow(ids[0])).toMatchObject({ odooNtfyUrl: ODOO_SIDE, endpoint: `${ODOO_SIDE}/upab12cd34fake1` });
    // setOdooUrl moves the endpoint, unregisters the old one and registers the new one
    await chat.push.setOdooUrl(ids[0], null);
    expect(odoo.kw("unregister_devices").map((c) => c.params.kwargs.endpoint)).toEqual([`${ODOO_SIDE}/upab12cd34fake1`]);
    expect(odoo.kw("register_devices").map((c) => c.params.kwargs.endpoint)).toEqual([`${ODOO_SIDE}/upab12cd34fake1`, `${NTFY}/upab12cd34fake1`]);
    expect(await chat.repo.pushRow(ids[0])).toMatchObject({ odooNtfyUrl: null, endpoint: `${NTFY}/upab12cd34fake1`, staleEndpoints: [] });
  });

  it("a refused token writes nothing", async () => {
    native.ntfyRefusal = "unauthorized";
    expect(await chat.push.applyLink(ids, link())).toEqual({ ok: false, reason: "unauthorized", registered: [] });
    expect(native.callsOf("subscribe")).toEqual([]);
    expect(odoo.kw("register_devices")).toEqual([]);
    expect(await chat.repo.pushRow(ids[0])).toMatchObject({ ntfyUrl: null, endpoint: null, staleEndpoints: [] });
  });

  it("a wiped device is registered again at the next foreground load", async () => {
    await chat.push.applyLink([ids[0]], link());
    // A VAPID wipe: every device goes and the server draws a new key
    odoo.state.devices.clear();
    odoo.state.vapid = "BExempleVapidDeux";
    chat.push.newSession();
    odoo.state.data = mailData();
    await chat.load(await sourceOf(ids[0]));
    const registers = odoo.kw("register_devices").map((c) => c.params.kwargs);
    expect(registers).toHaveLength(2);
    expect(registers[1]).toEqual({ ...registers[0], vapid_public_key: "BExempleVapidDeux" });
    expect(odoo.state.devices.has(`${NTFY}/upab12cd34fake1`)).toBe(true);
    expect((await chat.repo.pushRow(ids[0])).vapidKey).toBe("BExempleVapidDeux");
  });

  it("registration happens once per foreground session", async () => {
    await chat.push.applyLink([ids[0]], link());
    const src = await sourceOf(ids[0]);
    await chat.load(src);
    await chat.load(src);
    expect(odoo.kw("register_devices")).toHaveLength(1);
    chat.push.newSession();
    await chat.load(src);
    await chat.load(src);
    expect(odoo.kw("register_devices")).toHaveLength(2);
    expect(await chat.push.ensureRegistered(await sourceOf(ids[1]))).toBe("none");
  });

  it("a new prefix moves every account to a new topic and unregisters the old endpoint", async () => {
    await chat.push.applyLink(ids, link());
    await chat.push.applyLink([ids[0]], link({ prefix: "upcd34ef56" }));
    expect(native.callsOf("subscribe").slice(2)).toEqual([
      { configId: ids[0], ntfyUrl: NTFY, renew: true },
      { configId: ids[1], ntfyUrl: NTFY, renew: true },
    ]);
    expect(odoo.kw("unregister_devices").map((c) => c.params.kwargs.endpoint)).toEqual([`${NTFY}/upab12cd34fake1`, `${NTFY}/upab12cd34fake2`]);
    // Each old endpoint leaves Odoo before the new one is registered
    const at = (c: any) => odoo.calls.indexOf(c);
    expect(at(odoo.kw("unregister_devices")[0])).toBeLessThan(at(odoo.kw("register_devices")[2]));
    expect([...odoo.state.devices.keys()].sort()).toEqual([`${NTFY}/upcd34ef56fake3`, `${NTFY}/upcd34ef56fake4`]);
    expect(await chat.repo.pushRow(ids[1])).toMatchObject({ prefix: "upcd34ef56", topic: "upcd34ef56fake4", staleEndpoints: [] });
  });

  it("an old endpoint that cannot be unregistered stays stale until the next session", async () => {
    await chat.push.applyLink([ids[0]], link());
    setNetwork({ connected: false, wifi: false });
    await chat.push.applyLink([ids[0]], link({ prefix: "upcd34ef56" }));
    expect(await chat.repo.pushRow(ids[0])).toMatchObject({ staleEndpoints: [`${NTFY}/upab12cd34fake1`], registeredAt: null });
    setNetwork({ connected: true, wifi: true });
    chat.push.newSession();
    expect(await chat.push.ensureRegistered(await sourceOf(ids[0]))).toBe("registered");
    expect([...odoo.state.devices.keys()]).toEqual([`${NTFY}/upcd34ef56fake2`]);
    expect((await chat.repo.pushRow(ids[0])).staleEndpoints).toEqual([]);
  });

  it("removeNtfy unregisters and unsubscribes", async () => {
    await chat.push.applyLink(ids, link());
    await chat.push.removeNtfy(ids[0]);
    expect(native.callsOf("unsubscribe")).toEqual([{ configId: ids[0], pendingEndpoint: null }]);
    expect(native.callsOf("removeNtfy")).toEqual([]);
    expect(odoo.kw("unregister_devices").map((c) => c.params.kwargs.endpoint)).toEqual([`${NTFY}/upab12cd34fake1`]);
    expect(await chat.repo.pushRow(ids[0])).toMatchObject({ ntfyUrl: null, topic: null, endpoint: null, staleEndpoints: [] });
    // The last account on the server takes the server with it
    await chat.push.removeNtfy(ids[1]);
    expect(native.callsOf("removeNtfy")).toEqual([{ url: NTFY }]);
    expect(native.ntfys.size).toBe(0);
    expect(odoo.state.devices.size).toBe(0);
  });

  it("a removal online unregisters before the account goes", async () => {
    await chat.push.applyLink(ids, link());
    const apps = new AppService(env.db);
    const order: string[] = [];
    const remove = vi.spyOn(env.db, "deleteApplication");
    apps.beforeDelete = async (configId) => {
      await chat.push.forget(configId);
      order.push(`forgotten:${remove.mock.calls.length}`);
    };
    apps.onChanged = async (change) => {
      if (change.kind === "delete" && change.configId) await chat.forgetSource(change.configId);
    };
    native.calls.length = 0;
    await apps.delete({ url: A.url, username: A.username });
    expect(order).toEqual(["forgotten:0"]);
    expect(odoo.kw("unregister_devices").map((c) => c.params.kwargs.endpoint)).toEqual([`${NTFY}/upab12cd34fake1`]);
    expect(native.callsOf("unsubscribe")).toEqual([{ configId: ids[0], pendingEndpoint: null }]);
    expect(native.callsOf("forgetSession")).toEqual([{ configId: ids[0] }]);
    // The session copy is let go before the mirror drops the account
    const drop = indexOf("publishSettings", (o) => !o.accounts.some((a: any) => a.configId === ids[0]));
    expect(indexOf("unsubscribe")).toBeLessThan(drop);
    expect(indexOf("forgetSession")).toBeLessThan(drop);
    expect(native.calls.filter((c) => c.method === "publishSettings").every((c) => !(c.args as any).accounts.some((a: any) => a.configId === ids[0]))).toBe(true);
    expect(lastMirror().accounts.map((a) => a.configId)).toEqual([ids[1]]);
    expect(native.callsOf("removeNtfy")).toEqual([]);
    expect(await chat.repo.pushRow(ids[0])).toMatchObject({ ntfyUrl: null, endpoint: null });
  });

  it("a removal offline leaves the endpoint to native code", async () => {
    await chat.push.applyLink([ids[0]], link());
    await chat.push.applyLink([ids[0]], link({ prefix: "upcd34ef56" }));
    await storeSession(A, "sid-a");
    await chat.push.mirrorAll();
    setNetwork({ connected: false, wifi: false });
    odoo.calls.length = 0;
    native.calls.length = 0;
    await chat.push.forget(ids[0]);
    expect(odoo.calls).toEqual([]);
    expect(native.callsOf("unsubscribe")).toEqual([
      { configId: ids[0], pendingEndpoint: `${NTFY}/upcd34ef56fake2` },
    ]);
    expect(native.callsOf("forgetSession")).toEqual([]);
    expect(native.pending).toEqual([{ configId: ids[0], endpoint: `${NTFY}/upcd34ef56fake2` }]);
    expect(native.sessions.has(ids[0])).toBe(true);
    // The last account on the server takes the server with it, after the queue
    expect(native.callsOf("removeNtfy")).toEqual([{ url: NTFY }]);
    const drop = indexOf("publishSettings", (o) => !o.accounts.some((a: any) => a.configId === ids[0]));
    expect(indexOf("unsubscribe")).toBeLessThan(drop);
  });

  it("a removal queues every endpoint not unregistered, stale ones included", async () => {
    await chat.push.applyLink([ids[0]], link());
    setNetwork({ connected: false, wifi: false });
    await chat.push.applyLink([ids[0]], link({ prefix: "upcd34ef56" }));
    await chat.push.forget(ids[0]);
    expect(native.callsOf("unsubscribe")).toEqual([
      { configId: ids[0], pendingEndpoint: `${NTFY}/upcd34ef56fake2` },
      { configId: ids[0], pendingEndpoint: `${NTFY}/upab12cd34fake1` },
    ]);
  });

  it("an unregister that hangs is left to native code after 5 s", async () => {
    await chat.push.applyLink([ids[0]], link());
    odoo.state.hang = true;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const done = chat.push.forget(ids[0]);
    await vi.waitFor(() => expect(odoo.kw("unregister_devices")).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(4900);
    expect(native.callsOf("unsubscribe")).toEqual([]);
    await vi.advanceTimersByTimeAsync(100);
    await done;
    expect(native.callsOf("unsubscribe")).toEqual([{ configId: ids[0], pendingEndpoint: `${NTFY}/upab12cd34fake1` }]);
    expect(native.callsOf("forgetSession")).toEqual([]);
  });

  it("level 5 forgets every session copy", async () => {
    await storeSession(A, "sid-a");
    await storeSession(B, "sid-b");
    await chat.push.start();
    expect([...native.sessions.keys()].sort()).toEqual([...ids].sort());
    await chat.push.setLevel(5);
    expect(chatSettings().notifyLevel).toBe(5);
    expect(native.callsOf("forgetSession")).toEqual([{ configId: ids[0] }, { configId: ids[1] }]);
    expect(native.sessions.size).toBe(0);
    expect(lastMirror().level).toBe(5);
    // Back under 5, the stored sessions are copied again before the mirror that says so
    native.calls.length = 0;
    await chat.push.setLevel(3);
    expect(native.sessions.get(ids[0])).toEqual({ odooUrl: A.url, database: "db1", sessionId: "sid-a" });
    expect(indexOf("mirrorSession")).toBeLessThan(indexOf("publishSettings"));
    expect(lastMirror().level).toBe(3);
  });

  it("a session is mirrored only for chat accounts at levels 1 to 4", async () => {
    await build([A, OLD], ["", ""]);
    // At start, a stored session is copied without logging in again
    await storeSession(A, "sid-stored");
    await chat.push.start();
    expect(odoo.calls).toEqual([]);
    expect(native.callsOf("mirrorSession")).toEqual([]);
    await chat.sources({ online: true });
    await chat.push.idle();
    // sources() logs in on the Odoo 17 account to learn its version: nothing is copied
    expect(odoo.calls.filter((c) => c.path === "/web/session/authenticate").map((c) => c.host)).toEqual(["ancien.exemple.test"]);
    expect(native.callsOf("mirrorSession")).toEqual([]);
    native.calls.length = 0;
    await rpc.authenticate(credsOf(A));
    await rpc.authenticate(credsOf(OLD));
    await chat.push.idle();
    expect(native.callsOf("mirrorSession")).toEqual([
      { configId: ids[0], odooUrl: A.url, database: "db1", sessionId: "sid-odoo.exemple.test" },
    ]);
    // The account is in the mirror published after its session copy
    const after = native.calls.slice(indexOf("mirrorSession"));
    expect(after.some((c) => c.method === "publishSettings" && (c.args as any).accounts.some((a: any) => a.configId === ids[0]))).toBe(true);
    await chat.push.setLevel(5);
    native.calls.length = 0;
    await rpc.authenticate(credsOf(A));
    await chat.push.idle();
    expect(native.callsOf("mirrorSession")).toEqual([]);
  });

  it("a load copies the stored session of a new account once per session", async () => {
    await chat.push.start();
    const src = await sourceOf(ids[0]);
    await chat.load(src);
    expect(native.callsOf("mirrorSession")).toEqual([
      { configId: ids[0], odooUrl: A.url, database: "db1", sessionId: "sid-odoo.exemple.test" },
    ]);
    const mirrored = indexOf("mirrorSession");
    expect(native.calls.slice(mirrored).some((c) => c.method === "publishSettings")).toBe(true);
    await chat.load(src);
    expect(native.callsOf("mirrorSession")).toHaveLength(1);
  });

  it("turning Autoriser http on publishes the settings", async () => {
    setHttpAllowed(false);
    await chat.push.start();
    expect(lastMirror().allowHttp).toBe(false);
    setHttpAllowed(true);
    await chat.push.idle();
    expect(lastMirror().allowHttp).toBe(true);
  });

  it("publish sends labels, lock screen and conversation names", async () => {
    await chat.load(await sourceOf(ids[0]));
    await chat.push.setLockScreen(ids[0], "always");
    const mirror = lastMirror();
    expect(mirror.level).toBe(3);
    expect(mirror.allowHttp).toBe(true);
    expect(Object.keys(mirror.strings).sort()).toEqual([...PUSH_STRING_KEYS].sort());
    expect(mirror.strings.new_message_server).toBe("Nouveau message — {server}");
    expect(mirror.strings.you).toBe("Vous");
    expect(mirror.accounts.map((a) => [a.configId, a.label, a.lockScreen])).toEqual([
      [ids[0], "odoo", "always"],
      [ids[1], "bureau", "hidden_locked"],
    ]);
    expect([...mirror.accounts[0].channels].sort((x, y) => x.id - y.id)).toEqual([
      { id: CHAT, name: "Bruno Tremblay", type: "chat" },
      { id: GROUP, name: "Équipe", type: "group" },
      { id: GENERAL, name: "Général", type: "channel" },
    ]);
    expect(mirror.accounts[1].channels).toEqual([]);
    expect((await chat.repo.pushRow(ids[0])).lockScreen).toBe("always");
  });

  it("an unchanged mirror is not sent again", async () => {
    await chat.push.publish();
    await chat.push.publish();
    expect(native.callsOf("publishSettings")).toHaveLength(1);
  });

  it("a load clears notifications of conversations read elsewhere", async () => {
    native.shownTags = [`chat:${ids[0]}:${CHAT}`, `chat:${ids[0]}:${GROUP}`, `chat:${ids[0]}:${GENERAL}`, `summary:${ids[0]}`, `chat:${ids[1]}:${CHAT}`];
    odoo.state.data = mailData({ chatUnread: 0, groupUnread: 2, mentions: 0 });
    await chat.load(await sourceOf(ids[0]));
    expect(native.callsOf("clear")).toEqual([
      { configId: ids[0], channelId: CHAT },
      { configId: ids[0], channelId: GENERAL },
      { configId: ids[0], summary: true },
    ]);
    expect(native.shownTags).toEqual([`chat:${ids[0]}:${GROUP}`, `chat:${ids[1]}:${CHAT}`]);
  });

  it("a push failure never fails the load", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    native.failNext("shown");
    native.failNext("publishSettings");
    await expect(chat.load(await sourceOf(ids[0]))).resolves.toBeUndefined();
    expect((await chat.repo.sourceState(ids[0])).loadedAt).toBe(clock.toISOString());
  });

  it("without native code every method does nothing", async () => {
    const bare = new ChatService(env.db, rpc, new OutboxService(env.db, () => clock), new CapabilityService(env.db, rpc), () => clock);
    await bare.push.start();
    expect(await bare.push.applyLink(ids, link())).toEqual({ ok: false, reason: "unavailable", registered: [] });
    expect(await bare.push.ensureRegistered(await sourceOf(ids[0]))).toBe("none");
    await bare.push.forget(ids[0]);
    await bare.push.publish();
    await settled();
    expect(odoo.calls).toEqual([]);
    bare.dispose();
  });
});

describe("migration 2026102801", () => {
  let db: DatabaseService;
  const migration = () => APP_MIGRATIONS.find((m) => m.version === 2026102801)!;
  const colsOf = async (t: string) => (await db.rawQuery(`PRAGMA table_info(${t})`)).map((c) => c.name);
  const PUSH_COLS = [
    "config_id", "ntfy_url", "odoo_ntfy_url", "prefix", "topic", "endpoint", "p256dh", "auth", "vapid_key",
    "registered_at", "stale_endpoints", "lock_screen",
  ];

  beforeEach(async () => {
    SecureStoragePlugin._store.clear();
    db = new DatabaseService();
    await db.initialize();
  });

  it("follows 2026102705 and adds the table once", async () => {
    const versions = APP_MIGRATIONS.map((m) => m.version);
    expect(versions[versions.indexOf(2026102801) - 1]).toBe(2026102705);
    expect(versions[versions.length - 1]).toBe(2026102801);
    expect(migration().description).toBe("Clavardage : notifications par ntfy, par compte");
    await migration().run(db);
    const repo = new ChatRepository(db);
    await repo.setPushRow({ configId: "c", lockScreen: "never" });
    await migration().run(db);
    expect(await colsOf("chat_push")).toEqual(PUSH_COLS);
    expect(await repo.pushRow("c")).toMatchObject({ lockScreen: "never" });
  });

  it("a fresh install has it from the chat tables", async () => {
    await db.createChatTables();
    expect(await colsOf("chat_push")).toEqual(PUSH_COLS);
  });
});

describe("ChatRepository push rows", () => {
  let db: DatabaseService;
  let repo: ChatRepository;
  const C1 = "https://odoo.exemple.test|alice|db1";
  const C2 = "https://odoo.exemple.test/|alice|db1";

  beforeEach(async () => {
    SecureStoragePlugin._store.clear();
    db = new DatabaseService();
    await db.initialize();
    await db.createChatTables();
    repo = new ChatRepository(db);
  });

  it("an account without a row reads as no ntfy, hidden when locked", async () => {
    expect(await repo.pushRow(C1)).toEqual({
      configId: C1, ntfyUrl: null, odooNtfyUrl: null, prefix: null, topic: null, endpoint: null, p256dh: null,
      auth: null, vapidKey: null, registeredAt: null, staleEndpoints: [], lockScreen: "hidden_locked",
    });
    expect(await repo.pushRows()).toEqual([]);
  });

  it("setPushRow writes only the fields given; an unknown lock screen reads as the default", async () => {
    await repo.setPushRow({ configId: C1, ntfyUrl: NTFY, staleEndpoints: ["e1"] });
    await repo.setPushRow({ configId: C1, lockScreen: "always" });
    expect(await repo.pushRow(C1)).toMatchObject({ ntfyUrl: NTFY, staleEndpoints: ["e1"], lockScreen: "always" });
    await db.rawRun("UPDATE chat_push SET lock_screen = ?, stale_endpoints = ? WHERE config_id = ?", ["sometimes", "{bad", C1]);
    expect(await repo.pushRow(C1)).toMatchObject({ lockScreen: "hidden_locked", staleEndpoints: [] });
  });

  it("rename and drop source cover chat_push", async () => {
    await repo.setPushRow({ configId: C1, ntfyUrl: NTFY, endpoint: `${NTFY}/upab12cd34x` });
    await db.renameSyncConfigId(C1, C2);
    expect(await repo.pushRow(C1)).toMatchObject({ ntfyUrl: null });
    expect(await repo.pushRow(C2)).toMatchObject({ configId: C2, ntfyUrl: NTFY, endpoint: `${NTFY}/upab12cd34x` });
    await repo.dropSource(C2);
    expect(await repo.pushRows()).toEqual([]);
  });
});
