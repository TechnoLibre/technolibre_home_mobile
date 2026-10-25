import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as network from "@capacitor/network";
import { createSyncEnv, installLocalStorage, resetMocks, type SyncEnv } from "../testing/syncTestKit";
import { OdooRpcClient } from "../services/odoo/odooRpcClient";
import { OutboxService } from "../services/outboxService";
import { CapabilityService } from "../services/odoo/capabilityService";
import { CHAT_PAGE, ChatService, TYPING_RESEND_MS, TYPING_STOP_MS, type ChatSource } from "../services/chat/chatService";
import { CHAT_READ } from "../services/chat/chatOutbox";
import { setChatSettings } from "../services/chat/chatSettings";
import type { BusNotification } from "../models/chat";

const TARGET = { url: "https://odoo.example.com", username: "alice", password: "pw", database: "db1" };
const SELF = 3;
const BOB = 4;
const CHAT = 10;
const GROUP = 11;
const GENERAL = 12;
const MUTED = 13;
const QUIET = 14;

interface Call { path: string; params: any }

const msg = (id: number, channelId: number, author = BOB, body = `<p>m${id}</p>`) => ({
  id, body, date: "2026-10-25 09:00:00", message_type: "comment",
  author: { id: author, type: "partner" }, thread: { id: channelId, model: "discuss.channel" },
});

/**
 * A /mail/data answer: a chat, a group and three channels with the self
 * member's counters, the last message of each, and the inbox counter (which
 * Odoo counts with the channel mentions in it).
 */
function mailData() {
  const channels: any[] = [];
  const members: any[] = [];
  const messages: any[] = [];
  let memberId = 100;
  const add = (id: number, type: string, name: string, interest: string, o: { unread: number; needaction?: number; mute?: string; last: number }) => {
    channels.push({
      id, channel_type: type, name, last_interest_dt: interest,
      message_needaction_counter: o.needaction ?? 0, mute_until_dt: o.mute ?? false, custom_notifications: false,
    });
    members.push({
      id: memberId++, thread: { id, model: "discuss.channel" }, persona: { id: SELF, type: "partner" },
      message_unread_counter: o.unread, new_message_separator: o.last - o.unread + 1, seen_message_id: o.last - o.unread,
    });
    if (type !== "channel") {
      members.push({ id: memberId++, thread: { id, model: "discuss.channel" }, persona: { id: BOB, type: "partner" } });
    }
    messages.push(msg(o.last, id));
  };
  add(CHAT, "chat", "", "2026-10-25 09:00:00", { unread: 3, last: 80 });
  add(GROUP, "group", "Team", "2026-10-25 08:00:00", { unread: 2, last: 600 });
  add(GENERAL, "channel", "General", "2026-10-25 10:00:00", { unread: 5, needaction: 1, last: 700 });
  add(MUTED, "channel", "Muted", "2026-10-25 07:00:00", { unread: 4, needaction: 2, mute: "9999-12-31 23:59:59", last: 800 });
  add(QUIET, "channel", "Quiet", "2026-10-25 11:00:00", { unread: 7, last: 900 });
  return {
    Store: { inbox: { counter: 4, counter_bus_id: 1000, id: "inbox", model: "mail.box" } },
    "discuss.channel": channels,
    "discuss.channel.member": members,
    "mail.message": messages,
    "res.partner": [{ id: SELF, name: "Alice" }, { id: BOB, name: "Bob", im_status: "online" }],
  };
}

/**
 * A fake Odoo 18 for the chat. `history[channel]` holds the message ids the
 * server has; /discuss/channel/messages answers `around` as Odoo does
 * (limit/2 at or below it, limit/2 above it). `onPost` runs while a post is
 * on the server, before its answer leaves.
 */
function fakeOdoo(opts: { version?: number } = {}) {
  const calls: Call[] = [];
  const history: Record<number, number[]> = { [CHAT]: Array.from({ length: 80 }, (_, i) => i + 1) };
  const state = {
    nextId: 5000,
    onPost: null as null | ((params: any, id: number) => Promise<void>),
    /** While set, /mail/data holds its answer until the promise settles. */
    hold: null as null | Promise<void>,
    data: mailData() as any,
  };
  const ok = (result: unknown) => ({
    ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, result }),
    headers: { forEach: () => {} },
  } as unknown as Response);
  const fetchMock = vi.fn(async (url: string, init: { body: string }) => {
    const path = new URL(url).pathname;
    const params = JSON.parse(init.body).params;
    calls.push({ path, params });
    switch (path) {
      case "/web/session/authenticate":
        return ok({ uid: 2, session_id: "sid", server_version_info: [opts.version ?? 18, 0, 0, "final", 0, ""] });
      case "/web/session/get_session_info":
        return ok({ uid: 2, partner_id: SELF, is_system: false, websocket_worker_version: "18.0-7" });
      case "/mail/data": {
        const answer = JSON.parse(JSON.stringify(state.data));
        if (state.hold) await state.hold;
        return ok(answer);
      }
      case "/discuss/channel/messages": {
        const ids = [...(history[params.channel_id] ?? [])].sort((a, b) => b - a);
        const half = Math.floor(params.limit / 2);
        const below = ids.filter((i) => i <= params.around).slice(0, half);
        const above = ids.filter((i) => i > params.around).reverse().slice(0, half);
        const page = [...above, ...below].sort((a, b) => b - a);
        return ok({ data: { "mail.message": page.map((i) => msg(i, params.channel_id)) }, messages: page });
      }
      case "/mail/message/post": {
        const id = state.nextId++;
        if (state.onPost) await state.onPost(params, id);
        return ok({ "mail.message": [{ ...msg(id, params.thread_id, SELF, params.post_data.body), date: "2026-10-25 10:00:05" }] });
      }
      case "/web/dataset/call_kw": {
        const { method } = params;
        if (method === "fields_get") return ok({ body: { type: "html" } });
        if (method === "search_read") return ok([]);
        return ok(true);
      }
      default:
        return ok(true);
    }
  });
  vi.stubGlobal("fetch", fetchMock);
  const on = (p: string) => calls.filter((c) => c.path === p);
  return { calls, history, state, on, kw: (method: string) => on("/web/dataset/call_kw").filter((c) => c.params.method === method) };
}

const offline = () => (network as any).__setNetworkStatus({ connected: false, connectionType: "none" });
const online = () => (network as any).__setNetworkStatus({ connected: true, connectionType: "wifi" });

describe("ChatService", () => {
  let env: SyncEnv;
  let chat: ChatService;
  let clock: Date;
  let config: string;

  const build = async (targets = [TARGET]) => {
    env = await createSyncEnv(targets);
    const rpc = new OdooRpcClient();
    chat = new ChatService(env.db, rpc, new OutboxService(env.db, () => clock), new CapabilityService(env.db, rpc), () => clock);
    config = env.configIds[0];
  };
  const source = async (): Promise<ChatSource> => {
    await env.db.setApplicationOdooVersion(TARGET.url, TARGET.username, "18.0");
    return (await chat.sources({ online: false }))[0];
  };
  const bus = (id: number, type: string, payload: any): BusNotification => ({ id, message: { type, payload } });

  beforeEach(async () => {
    resetMocks();
    installLocalStorage();
    clock = new Date("2026-10-25T10:00:00.000Z");
    await build();
  });

  afterEach(() => {
    chat.dispose();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("sources keeps only Odoo 18 apps", async () => {
    const odoo = fakeOdoo();
    await build([
      TARGET,
      { ...TARGET, url: "https://old.example.com" },
      { ...TARGET, url: "https://saas.example.net" },
    ]);
    await env.db.setApplicationOdooVersion(TARGET.url, TARGET.username, "18.0");
    await env.db.setApplicationOdooVersion("https://old.example.com", TARGET.username, "17.0");
    await env.db.setApplicationOdooVersion("https://saas.example.net", TARGET.username, "saas~18.2");
    const sources = await chat.sources({ online: true });
    expect(sources.map((s) => s.configId)).toEqual([env.configIds[0], env.configIds[2]]);
    expect(sources.map((s) => s.label)).toEqual(["odoo", "saas"]);
    expect(sources[0].creds).toEqual(env.creds[0]);
    expect(odoo.calls).toHaveLength(0);
  });

  it("sources with empty version asks the server once and stores it", async () => {
    const odoo = fakeOdoo({ version: 18 });
    expect((await chat.sources({ online: true })).map((s) => s.configId)).toEqual([config]);
    expect(odoo.on("/web/session/authenticate")).toHaveLength(1);
    expect((await env.db.getAllApplications())[0].odooVersion).toBe("18.0");
    const before = odoo.calls.length;
    expect(await chat.sources({ online: true })).toHaveLength(1);
    expect(odoo.calls.length).toBe(before);
  });

  it("sources with empty version leaves out a server of another version", async () => {
    fakeOdoo({ version: 17 });
    expect(await chat.sources({ online: true })).toEqual([]);
    expect((await env.db.getAllApplications())[0].odooVersion).toBe("17.0");
  });

  it("offline sources keep a known chat server", async () => {
    const odoo = fakeOdoo();
    await build([TARGET, { ...TARGET, username: "bob" }]);
    await chat.repo.setSourceState({ configId: env.configIds[1], selfPartnerId: 9 });
    const sources = await chat.sources({ online: false });
    expect(sources.map((s) => s.configId)).toEqual([env.configIds[1]]);
    expect(odoo.calls).toHaveLength(0);
  });

  it("load fills conversations and unread total", async () => {
    const odoo = fakeOdoo();
    const changes: any[] = [];
    chat.onChange = (c, ch) => changes.push([c, ch]);
    await chat.load(await source());
    expect(odoo.on("/mail/data")[0].params).toEqual({ init_messaging: {}, channels_as_member: true });
    const conversations = await chat.conversations();
    expect(conversations.map((c) => c.channelId)).toEqual([GENERAL, CHAT, GROUP, MUTED, QUIET]);
    expect(conversations.find((c) => c.channelId === CHAT)).toMatchObject({ name: "Bob", unreadCounter: 3, correspondentPartnerId: BOB });
    // inbox 4 holds the 3 channel mentions: 1 left + chat 3 + group 2 + General 1, Muted excluded, Quiet 0
    expect(await chat.unreadTotal()).toBe(7);
    expect(await chat.unreadTotal([config])).toBe(7);
    expect(await chat.unreadTotal(["https://other.example.com|x|y"])).toBe(0);
    expect(await chat.repo.sourceState(config)).toMatchObject({
      selfPartnerId: SELF, isSystem: false, wsVersion: "18.0-7", moduleState: "unknown", inboxCounter: 4,
      loadedAt: clock.toISOString(),
    });
    expect(changes).toContainEqual([config, null]);
  });

  it("loadOlder pages with around and never before", async () => {
    const odoo = fakeOdoo();
    const src = await source();
    await chat.load(src);
    // The first page holds the last message, already cached by the load
    expect(await chat.loadOlder(src, CHAT)).toBe(CHAT_PAGE - 1);
    expect(await chat.loadOlder(src, CHAT)).toBe(CHAT_PAGE);
    const pages = odoo.on("/discuss/channel/messages").map((c) => c.params);
    expect(pages).toEqual([
      { channel_id: CHAT, around: 81, limit: 2 * CHAT_PAGE },
      { channel_id: CHAT, around: 50, limit: 2 * CHAT_PAGE },
    ]);
    for (const p of pages) {
      expect(p).not.toHaveProperty("before");
      expect(p).not.toHaveProperty("after");
    }
    const ids = (await chat.messages(config, CHAT)).map((m) => m.messageId);
    expect(ids).toEqual(Array.from({ length: 60 }, (_, i) => i + 21));
    expect((await chat.repo.channel(config, CHAT))).toMatchObject({ oldestLoadedId: 21, historyComplete: false });
  });

  it("loadOlder marks history complete", async () => {
    const odoo = fakeOdoo();
    odoo.history[CHAT] = Array.from({ length: 40 }, (_, i) => i + 41);
    const src = await source();
    await chat.load(src);
    expect(await chat.loadOlder(src, CHAT)).toBe(CHAT_PAGE - 1);
    expect((await chat.repo.channel(config, CHAT))!.historyComplete).toBe(false);
    expect(await chat.loadOlder(src, CHAT)).toBe(10);
    expect((await chat.repo.channel(config, CHAT))!.historyComplete).toBe(true);
    const asked = odoo.on("/discuss/channel/messages").length;
    expect(await chat.loadOlder(src, CHAT)).toBe(0);
    expect(odoo.on("/discuss/channel/messages")).toHaveLength(asked);
  });

  it("loadAll pages until the history is complete", async () => {
    const odoo = fakeOdoo();
    odoo.history[CHAT] = Array.from({ length: 250 }, (_, i) => i + 1);
    odoo.state.data["mail.message"][0] = msg(250, CHAT);
    const src = await source();
    await chat.load(src);
    const progress: number[] = [];
    expect(await chat.loadAll(src, CHAT, (n) => progress.push(n))).toBe(249);
    expect(progress).toEqual([99, 199, 249]);
    expect((await chat.messages(config, CHAT))).toHaveLength(250);
    expect(odoo.on("/discuss/channel/messages").every((c) => c.params.limit === 200 && "around" in c.params)).toBe(true);
    expect((await chat.repo.channel(config, CHAT))!.historyComplete).toBe(true);
  });

  it("reload over a gap restarts the history from the last message", async () => {
    const odoo = fakeOdoo();
    const src = await source();
    await chat.load(src);
    await chat.loadOlder(src, CHAT);
    await chat.loadOlder(src, CHAT);
    // Meanwhile the server got 81..100; /mail/data gives only the last one
    odoo.history[CHAT] = Array.from({ length: 100 }, (_, i) => i + 1);
    odoo.state.data["mail.message"][0] = msg(100, CHAT);
    await chat.load(src);
    expect(await chat.repo.channel(config, CHAT)).toMatchObject({ lastMessageId: 100, oldestLoadedId: null, historyComplete: false });
    expect(await chat.loadOlder(src, CHAT)).toBe(19);
    expect(odoo.on("/discuss/channel/messages").at(-1)!.params).toEqual({ channel_id: CHAT, around: 101, limit: 2 * CHAT_PAGE });
    const ids = (await chat.messages(config, CHAT)).map((m) => m.messageId);
    expect(ids).toEqual(Array.from({ length: 80 }, (_, i) => i + 21));
    // A reload with no new message keeps the history where it is
    await chat.load(src);
    expect((await chat.repo.channel(config, CHAT))!.oldestLoadedId).toBe(71);
  });

  it("load drops the conversations the server no longer lists, but a pinned or waiting one", async () => {
    const odoo = fakeOdoo();
    const src = await source();
    await chat.load(src);
    offline();
    await chat.send(src, GROUP, "waiting");
    await chat.repo.patchChannel(config, QUIET, { localPinned: true });
    online();
    odoo.state.data["discuss.channel"] = odoo.state.data["discuss.channel"].filter((c: any) => c.id === CHAT);
    odoo.state.data["discuss.channel.member"] = odoo.state.data["discuss.channel.member"].filter((m: any) => m.thread.id === CHAT);
    odoo.state.data["mail.message"] = odoo.state.data["mail.message"].filter((m: any) => m.thread.id === CHAT);
    await chat.load(src);
    expect((await chat.repo.channels(config)).map((c) => c.channelId).sort()).toEqual([CHAT, GROUP, QUIET]);
  });

  it("send offline keeps a pending message", async () => {
    const odoo = fakeOdoo();
    const src = await source();
    await chat.load(src);
    offline();
    const sent = await chat.send(src, GROUP, "hello");
    expect(sent).toMatchObject({ status: "pending", messageId: null, authorPartnerId: SELF });
    expect(odoo.on("/mail/message/post")).toHaveLength(0);
    expect((await chat.messages(config, GROUP)).at(-1)).toMatchObject({ clientUuid: sent.clientUuid, status: "pending" });
  });

  it("flushAll on reconnect posts it once", async () => {
    const odoo = fakeOdoo();
    const src = await source();
    await chat.load(src);
    offline();
    const sent = await chat.send(src, GROUP, "hello");
    online();
    await chat.flushAll();
    await chat.flushAll();
    const posts = odoo.on("/mail/message/post");
    expect(posts).toHaveLength(1);
    expect(posts[0].params.post_data).not.toHaveProperty("erplibre_client_uuid");
    const mine = (await chat.messages(config, GROUP)).filter((m) => m.clientUuid === sent.clientUuid);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ status: "sent", messageId: 5000 });
  });

  it("send online posts at once, with the module uuid when it is installed", async () => {
    const odoo = fakeOdoo();
    const src = await source();
    await chat.load(src);
    await chat.repo.setSourceState({ configId: config, moduleState: "installed" });
    const sent = await chat.send(src, GROUP, "hello");
    expect(sent.status).toBe("pending");
    expect(odoo.on("/mail/message/post")[0].params.post_data.erplibre_client_uuid).toBe(sent.clientUuid);
    expect((await chat.messages(config, GROUP)).at(-1)).toMatchObject({ status: "sent", messageId: 5000 });
  });

  it("own post echoed by bus before response stays one message", async () => {
    const odoo = fakeOdoo();
    const src = await source();
    await chat.load(src);
    odoo.state.onPost = async (params, id) => {
      await chat.applyBus(config, [bus(1001, "discuss.channel/new_message", {
        id: params.thread_id,
        temporary_id: params.context.temporary_id,
        data: { "mail.message": [msg(id, params.thread_id, SELF, params.post_data.body)] },
      })]);
    };
    const sent = await chat.send(src, GROUP, "echoed");
    const thread = await chat.messages(config, GROUP);
    const mine = thread.filter((m) => m.clientUuid === sent.clientUuid || m.messageId === 5000);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ messageId: 5000, status: "sent", clientUuid: sent.clientUuid, outboxOpId: null });
    expect(thread.filter((m) => m.status === "pending")).toHaveLength(0);
    expect((await chat.repo.channel(config, GROUP))!.unreadCounter).toBe(0);
    expect(await env.db.getOutboxOpsForConfig(config)).toHaveLength(0);
  });

  it("markRead queues the read and, for a chat, channel_fetched", async () => {
    const odoo = fakeOdoo();
    const src = await source();
    await chat.load(src);
    await chat.markRead(src, CHAT);
    expect(odoo.on("/discuss/channel/mark_as_read").map((c) => c.params)).toEqual([{ channel_id: CHAT, last_message_id: 80 }]);
    expect(odoo.kw("channel_fetched").map((c) => c.params.args)).toEqual([[[CHAT]]]);
    expect(odoo.kw("mark_all_as_read")).toHaveLength(0);
    // Counters stay as the server last reported them
    expect((await chat.repo.channel(config, CHAT))!.unreadCounter).toBe(3);
    await chat.markRead(src, GENERAL);
    expect(odoo.kw("mark_all_as_read")).toHaveLength(1);
    expect(odoo.kw("channel_fetched")).toHaveLength(1);
  });

  it("markRead does nothing when sendRead is off", async () => {
    const odoo = fakeOdoo();
    const src = await source();
    await chat.load(src);
    setChatSettings({ sendRead: false, sendTyping: true });
    const before = odoo.calls.length;
    await chat.markRead(src, CHAT);
    expect(odoo.calls.length).toBe(before);
    expect((await env.db.getOutboxOpsForConfig(config)).filter((o) => o.kind === CHAT_READ)).toHaveLength(0);
  });

  it("typing is not sent in a channel the user is not a member of", async () => {
    const odoo = fakeOdoo();
    const src = await source();
    await chat.load(src);
    await chat.applyBus(config, [bus(1001, "mail.record/insert", {
      "discuss.channel": [{ id: 15, channel_type: "channel", name: "Public", message_needaction_counter: 0 }],
    })]);
    expect((await chat.repo.channel(config, 15))!.isMember).toBe(false);
    await chat.typing(src, 15, true);
    expect(odoo.on("/discuss/channel/notify_typing")).toHaveLength(0);
    setChatSettings({ sendRead: true, sendTyping: false });
    await chat.typing(src, GROUP, true);
    expect(odoo.on("/discuss/channel/notify_typing")).toHaveLength(0);
  });

  it("typing throttles to one true per 50 s", async () => {
    const odoo = fakeOdoo();
    const src = await source();
    await chat.load(src);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const typed = () => odoo.on("/discuss/channel/notify_typing").map((c) => c.params.is_typing);
    const key = async (ms: number) => {
      clock = new Date(clock.getTime() + ms);
      await vi.advanceTimersByTimeAsync(ms);
      await chat.typing(src, GROUP, true);
    };
    await key(0);
    for (let i = 0; i < 10; i++) await key(TYPING_STOP_MS - 1);
    expect(typed()).toEqual([true]);
    await key(TYPING_RESEND_MS - 10 * (TYPING_STOP_MS - 1));
    expect(typed()).toEqual([true, true]);
    clock = new Date(clock.getTime() + TYPING_STOP_MS);
    await vi.advanceTimersByTimeAsync(TYPING_STOP_MS);
    await vi.waitFor(() => expect(typed()).toEqual([true, true, false]));
    expect(odoo.on("/discuss/channel/notify_typing")[0].params).toEqual({ channel_id: GROUP, is_typing: true });
    // An explicit stop is sent once, right away
    await chat.typing(src, GROUP, true);
    await chat.typing(src, GROUP, false);
    await chat.typing(src, GROUP, false);
    expect(typed()).toEqual([true, true, false, true, false]);
  });

  it("bus message of another user raises unread and calls onChange", async () => {
    fakeOdoo();
    await chat.load(await source());
    const changes: any[] = [];
    chat.onChange = (c, ch) => changes.push([c, ch]);
    const incoming = bus(1001, "discuss.channel/new_message", { id: GROUP, data: { "mail.message": [msg(601, GROUP)] } });
    await chat.applyBus(config, [incoming]);
    expect(await chat.repo.channel(config, GROUP)).toMatchObject({ unreadCounter: 3, lastMessageId: 601 });
    expect(changes).toEqual([[config, GROUP]]);
    // The same notification again changes nothing
    await chat.applyBus(config, [incoming]);
    expect((await chat.repo.channel(config, GROUP))!.unreadCounter).toBe(3);
    // A counter the server sends wins over the local count
    await chat.applyBus(config, [bus(1002, "mail.record/insert", {
      "discuss.channel.member": [{ id: 102, thread: { id: GROUP, model: "discuss.channel" }, persona: { id: SELF, type: "partner" }, message_unread_counter: 0, message_unread_counter_bus_id: 1002 }],
    })]);
    expect((await chat.repo.channel(config, GROUP))!.unreadCounter).toBe(0);
    // While the conversation is open, a message does not count as unread
    chat.viewing = { configId: config, channelId: GROUP };
    await chat.applyBus(config, [bus(1003, "discuss.channel/new_message", { id: GROUP, data: { "mail.message": [msg(602, GROUP)] } })]);
    expect((await chat.repo.channel(config, GROUP))!.unreadCounter).toBe(0);
  });

  it("bus notifications older than the load leave the counters alone", async () => {
    fakeOdoo();
    await chat.load(await source());
    await chat.applyBus(config, [bus(999, "discuss.channel/new_message", { id: GROUP, data: { "mail.message": [msg(601, GROUP)] } })]);
    expect((await chat.repo.channel(config, GROUP))!.unreadCounter).toBe(2);
    expect((await chat.messages(config, GROUP)).map((m) => m.messageId)).toContain(601);
  });

  it("a replayed record keeps the counters the load read", async () => {
    const odoo = fakeOdoo();
    const data = odoo.state.data;
    data.Store.inbox.counter_bus_id = 2328;
    const selfChat = data["discuss.channel.member"].find((m: any) => m.thread.id === CHAT && m.persona.id === SELF);
    Object.assign(selfChat, { message_unread_counter: 1, message_unread_counter_bus_id: 2328 });
    Object.assign(data["discuss.channel"].find((c: any) => c.id === GENERAL), { message_needaction_counter: 1, message_needaction_counter_bus_id: 2328 });
    await chat.load(await source());
    const member = (counter: number, busId?: number) => ({
      "discuss.channel.member": [{ id: selfChat.id, thread: { id: CHAT, model: "discuss.channel" }, persona: { id: SELF, type: "partner" },
        message_unread_counter: counter, ...(busId ? { message_unread_counter_bus_id: busId } : {}) }],
    });
    const channel = (counter: number, busId?: number) => ({
      "discuss.channel": [{ id: GENERAL, message_needaction_counter: counter, ...(busId ? { message_needaction_counter_bus_id: busId } : {}) }],
    });
    // The first connection replays older rows: the conversation's creation, counters 0
    await chat.applyBus(config, [bus(2316, "mail.record/insert", member(0, 2316)), bus(2317, "mail.record/insert", channel(0, 2317))]);
    expect(await chat.repo.channel(config, CHAT)).toMatchObject({ unreadCounter: 1, unreadCounterBusId: 2328 });
    expect(await chat.repo.channel(config, GENERAL)).toMatchObject({ needactionCounter: 1, needactionCounterBusId: 2328 });
    // A counter without its bus id is not taken from the bus
    await chat.applyBus(config, [bus(2329, "mail.record/insert", member(5)), bus(2329, "mail.record/insert", channel(5))]);
    expect((await chat.repo.channel(config, CHAT))!.unreadCounter).toBe(1);
    expect((await chat.repo.channel(config, GENERAL))!.needactionCounter).toBe(1);
    // Fresher ones are
    await chat.applyBus(config, [bus(2330, "mail.record/insert", member(2, 2330)), bus(2331, "mail.record/insert", channel(3, 2331))]);
    expect(await chat.repo.channel(config, CHAT)).toMatchObject({ unreadCounter: 2, unreadCounterBusId: 2330 });
    expect(await chat.repo.channel(config, GENERAL)).toMatchObject({ needactionCounter: 3, needactionCounterBusId: 2331 });
  });

  it("a load after the server's bus ids restarted resets the marks", async () => {
    const odoo = fakeOdoo();
    const src = await source();
    await chat.load(src);
    await chat.repo.patchChannel(config, CHAT, { unreadCounterBusId: 2330, needactionCounterBusId: 2330 });
    await chat.repo.setSourceState({ configId: config, counterBusId: 2330 });
    // Bus table emptied: the server reads its ids from 0 again
    const data = odoo.state.data;
    data.Store.inbox.counter_bus_id = 0;
    Object.assign(data["discuss.channel.member"].find((m: any) => m.thread.id === CHAT && m.persona.id === SELF),
      { message_unread_counter: 3, message_unread_counter_bus_id: 0 });
    Object.assign(data["discuss.channel"].find((c: any) => c.id === CHAT), { message_needaction_counter: 3, message_needaction_counter_bus_id: 0 });
    await chat.load(src);
    expect(await chat.repo.channel(config, CHAT)).toMatchObject({ unreadCounter: 3, unreadCounterBusId: 0, needactionCounter: 3, needactionCounterBusId: 0 });
    expect((await chat.repo.sourceState(config)).counterBusId).toBe(0);
    await chat.applyBus(config, [bus(5, "mail.record/insert", {
      "discuss.channel.member": [{ id: 100, thread: { id: CHAT, model: "discuss.channel" }, persona: { id: SELF, type: "partner" }, message_unread_counter: 4, message_unread_counter_bus_id: 5 }],
    })]);
    expect(await chat.repo.channel(config, CHAT)).toMatchObject({ unreadCounter: 4, unreadCounterBusId: 5 });
    expect((await chat.repo.sourceState(config)).counterBusId).toBe(5);
  });

  const selfMember = (unread: number, busId: number) => ({
    "discuss.channel.member": [{ id: 100, thread: { id: CHAT, model: "discuss.channel" }, persona: { id: SELF, type: "partner" }, message_unread_counter: unread, message_unread_counter_bus_id: busId }],
  });

  it("a bus record delivered while a load reads is not overwritten by the load", async () => {
    const odoo = fakeOdoo();
    const src = await source();
    await chat.load(src);
    let release!: () => void;
    odoo.state.hold = new Promise((r) => { release = r; });
    const reads = odoo.on("/mail/data").length;
    const loading = chat.load(src);
    await vi.waitFor(() => expect(odoo.on("/mail/data")).toHaveLength(reads + 1));
    // The load's answer is read (unread 3 as of 1000); a newer record arrives before it is written
    const delivering = chat.applyBus(config, [bus(2335, "mail.record/insert", selfMember(5, 2335))]);
    await new Promise((r) => setTimeout(r, 10));
    release();
    await Promise.all([loading, delivering]);
    expect(await chat.repo.channel(config, CHAT)).toMatchObject({ unreadCounter: 5, unreadCounterBusId: 2335 });
    expect((await chat.repo.sourceState(config)).counterBusId).toBe(2335);
  });

  it("a joined delivery loads the account without waiting on itself", async () => {
    const odoo = fakeOdoo();
    const src = await source();
    await chat.load(src);
    odoo.state.data["discuss.channel"].push({ id: 16, channel_type: "channel", name: "New", last_interest_dt: "2026-10-25 12:00:00" });
    odoo.state.data["discuss.channel.member"].push({ id: 160, thread: { id: 16, model: "discuss.channel" }, persona: { id: SELF, type: "partner" }, message_unread_counter: 0 });
    await chat.applyBus(config, [bus(1001, "discuss.channel/joined", { channel: { id: 16, model: "discuss.channel" } })]);
    expect((await chat.repo.channel(config, 16))?.isMember).toBe(true);
    await chat.load(src);
    await chat.applyBus(config, [bus(1002, "mail.record/insert", selfMember(6, 1002))]);
    expect((await chat.repo.channel(config, CHAT))!.unreadCounter).toBe(6);
  });

  it("a delivery that fails does not hold back the next one", async () => {
    fakeOdoo();
    await chat.load(await source());
    vi.spyOn(chat.repo, "applyDelta").mockRejectedValueOnce(new Error("disk full"));
    const failing = chat.applyBus(config, [bus(1001, "mail.record/insert", selfMember(5, 1001))]);
    const next = chat.applyBus(config, [bus(1002, "mail.record/insert", selfMember(6, 1002))]);
    await expect(failing).rejects.toThrow("disk full");
    await next;
    expect(await chat.repo.channel(config, CHAT)).toMatchObject({ unreadCounter: 6, unreadCounterBusId: 1002 });
  });

  it("a load without per-record bus ids seeds the marks with the inbox bus id", async () => {
    fakeOdoo();
    await chat.load(await source());
    expect(await chat.repo.channel(config, GROUP)).toMatchObject({ unreadCounterBusId: 1000, needactionCounterBusId: 1000 });
  });

  it("inbox notifications move the inbox and mention counters", async () => {
    fakeOdoo();
    await chat.load(await source());
    await chat.applyBus(config, [bus(1001, "mail.message/inbox", { "mail.message": [msg(701, GENERAL)] })]);
    expect((await chat.repo.sourceState(config)).inboxCounter).toBe(5);
    expect((await chat.repo.channel(config, GENERAL))!.needactionCounter).toBe(2);
    await chat.applyBus(config, [bus(1002, "mail.message/mark_as_read", { message_ids: [700, 701], needaction_inbox_counter: 3 })]);
    expect((await chat.repo.sourceState(config)).inboxCounter).toBe(3);
    expect((await chat.repo.channel(config, GENERAL))!.needactionCounter).toBe(0);
  });

  it("a replayed mark_as_read leaves the inbox counter of the load", async () => {
    fakeOdoo();
    await chat.load(await source());
    await chat.applyBus(config, [bus(999, "mail.message/mark_as_read", { message_ids: [700], needaction_inbox_counter: 0 })]);
    expect((await chat.repo.sourceState(config)).inboxCounter).toBe(4);
    expect((await chat.repo.channel(config, GENERAL))!.needactionCounter).toBe(1);
  });

  it("the counter bus id holds across a restart", async () => {
    fakeOdoo();
    await chat.load(await source());
    const inbox = bus(1001, "mail.message/inbox", { "mail.message": [msg(701, GENERAL)] });
    await chat.applyBus(config, [inbox]);
    expect((await chat.repo.sourceState(config)).counterBusId).toBe(1001);
    const rpc = new OdooRpcClient();
    const restarted = new ChatService(env.db, rpc, new OutboxService(env.db), new CapabilityService(env.db, rpc));
    await restarted.applyBus(config, [inbox]);
    expect((await chat.repo.sourceState(config)).inboxCounter).toBe(5);
    expect((await chat.repo.channel(config, GENERAL))!.needactionCounter).toBe(2);
  });

  it("bus leave, delete, fetched, presence and joined", async () => {
    const odoo = fakeOdoo();
    await chat.load(await source());
    await chat.applyBus(config, [
      bus(1001, "discuss.channel.member/fetched", { channel_id: CHAT, id: 101, last_message_id: 80, partner_id: BOB }),
      bus(1002, "bus.bus/im_status_updated", { partner_id: BOB, im_status: "away", presence_status: "away" }),
      bus(1003, "discuss.channel/leave", { "discuss.channel": [{ id: QUIET, is_pinned: false }] }),
      bus(1004, "discuss.channel/delete", { id: MUTED }),
      bus(1005, "some.unknown/type", { id: 1 }),
    ]);
    const changes: any[] = [];
    chat.onChange = (c, ch) => changes.push([c, ch]);
    await chat.applyBus(config, [bus(1007, "some.unknown/type", { id: 1 })]);
    expect(changes).toEqual([]);
    expect((await chat.repo.members(config, CHAT)).find((m) => m.memberId === 101)!.fetchedMessageId).toBe(80);
    expect((await chat.repo.partners(config)).find((p) => p.partnerId === BOB)!.imStatus).toBe("away");
    expect((await chat.conversations()).map((c) => c.channelId)).toEqual([GENERAL, CHAT, GROUP]);
    const loads = odoo.on("/mail/data").length;
    await chat.applyBus(config, [bus(1006, "discuss.channel/joined", { channel: { id: 16, model: "discuss.channel" } })]);
    expect(odoo.on("/mail/data")).toHaveLength(loads + 1);
  });
  it("forgetSource erases one account's chat and its outbox rows, not another's", async () => {
    fakeOdoo();
    await build([TARGET, { ...TARGET, username: "bob" }]);
    const [mine, other] = env.configIds;
    for (const id of [mine, other]) {
      await chat.repo.setSourceState({ configId: id, selfPartnerId: SELF });
      await chat.repo.applyDelta(id, {
        channels: [{ channelId: GROUP, channelType: "group", name: "Team", isMember: true }],
        deletedChannelIds: [], members: [], deletedMemberIds: [], messages: [], partners: [], inboxCounter: null, selfPartnerId: null,
      });
      await chat.queue.queuePost(id, GROUP, "not sent", false);
      await chat.queue.queueRead(id, GROUP, 5, false);
    }
    expect(await chat.queue.pendingPostCount(mine)).toBe(1);
    const changes: any[] = [];
    chat.onChange = (c, ch) => changes.push([c, ch]);
    await chat.forgetSource(mine);
    expect(await chat.queue.pendingPostCount(mine)).toBe(0);
    expect((await env.db.getOutboxOpsForConfig(mine)).map((o) => o.noteId)).not.toContain("chat");
    expect(await chat.repo.channels(mine)).toEqual([]);
    expect(await chat.repo.hasSourceState(mine)).toBe(false);
    expect(await chat.queue.pendingPostCount(other)).toBe(1);
    expect(await chat.repo.channels(other)).toHaveLength(1);
    expect(changes).toEqual([[mine, null]]);
  });

  it("realtime keeps a second start keeps one bus per source, stop closes its transport", async () => {
    fakeOdoo();
    const made: { open: any; close: any }[] = [];
    const transportFor = () => {
      const t = { open: vi.fn(), send: vi.fn(), close: vi.fn(), onOpen: () => {}, onMessage: () => {}, onClose: () => {} };
      made.push(t as any);
      return t as any;
    };
    await chat.startRealtime(transportFor);
    await chat.startRealtime(transportFor);
    await vi.waitFor(() => expect(made.length).toBe(1));
    await vi.waitFor(() => expect(made[0].open).toHaveBeenCalledTimes(1));
    chat.stopRealtime();
    expect(made[0].close).toHaveBeenCalled();
    const before = made.length;
    await new Promise((r) => setTimeout(r, 20));
    expect(made.length).toBe(before);
  });
});
