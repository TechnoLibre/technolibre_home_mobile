import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";
import { createSyncEnv, installLocalStorage, resetMocks, setNetwork, type SyncEnv } from "../testing/syncTestKit";
import { fakeChatPushNative, type FakeChatPushNative } from "../__mocks__/chatPushNative";
import { OdooRpcClient, syncSessionKey } from "../services/odoo/odooRpcClient";
import { OutboxService } from "../services/outboxService";
import { CapabilityService } from "../services/odoo/capabilityService";
import { ChatService, type ChatSource } from "../services/chat/chatService";
import { CHAT_POST } from "../services/chat/chatOutbox";
import { chatSettings, setChatSettings } from "../services/chat/chatSettings";
import { parseStore } from "../services/chat/chatStore";
import { chatMarker } from "../services/chat/chatBody";
import { CREATE_QUIET_WINDOW_MS } from "../services/outboxMarker";
import type { NativeAction } from "../plugins/chatPushPlugin";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
/** Odoo 18's answers to the notification actions, captured by the lot's spike (hosts and secrets replaced). */
const CAPTURES = resolve(ROOT, "android/app/src/test/resources/chatpush/actions");
const captured = (name: string): string => readFileSync(resolve(CAPTURES, `${name}.json`), "utf-8");
const resultOf = (name: string): any => JSON.parse(captured(name)).result;

const A = { url: "https://odoo.exemple.test", username: "alice", password: "pw", database: "db1" };
const GONE = "https://parti.exemple.test|alice|db1";

/** The conversation, the user's partner and the messages of the captures. */
const CHANNEL = 4;
const SELF = 3;
/** The message post_answer.json answers, and the uuid its marker carries. */
const POSTED = 34;
const POSTED_UUID = "03b81044-5d6f-4256-9671-773a54cfe4d3";
/** The message search_read_marker.json finds, and its uuid. */
const FOUND = 35;
const FOUND_UUID = "24ff0bf7-76b8-4caf-ad92-a71df8436306";
/** The message reaction_add.json answers. */
const REACTED = 32;
/** The conversation of discuss_channel_messages.json (a page Task 9 captured) and its newest message. */
const PAGE_CHANNEL = 17;
const PAGED = 48;
const TEXT = "Bonjour du test d'action";

/**
 * A fake Odoo 18 answering the action routes with the captured answers:
 * get_session_info, /mail/message/post, the marker search (search_read of
 * mail.message, a hit while `marked`), mark_as_read, mark_all_as_read, the
 * mute and the reaction. reaction_add.json is the capture of a 👍 on
 * REACTED: answered to a 👍 on POSTED, its Store names a message the cache
 * does not hold and changes nothing; the tests read what was sent.
 * /discuss/channel/messages answers the captured page of PAGE_CHANNEL
 * (discuss_channel_messages.json: PAGED and the message before it). Any
 * other call answers true.
 */
function fakeOdoo() {
  const calls: { path: string; params: any }[] = [];
  /**
   * marked: the marker search finds FOUND; pageRefused: the messages page answers the captured NotFound;
   * pageFails: it answers HTTP 500.
   */
  const state = { marked: false, pageRefused: false, pageFails: false };
  const raw = (text: string) => ({ ok: true, status: 200, text: async () => text, headers: { forEach: () => {} } } as unknown as Response);
  const ok = (result: unknown) => raw(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: { body: string }) => {
    const path = new URL(url).pathname;
    const params = JSON.parse(init.body).params;
    calls.push({ path, params });
    switch (path) {
      case "/web/session/get_session_info": return raw(captured("session_info"));
      case "/mail/message/post": return raw(captured("post_answer"));
      case "/discuss/channel/mark_as_read": return raw(captured("mark_as_read"));
      case "/discuss/settings/mute": return raw(captured("mute"));
      case "/mail/message/reaction": return raw(captured("reaction_add"));
      case "/discuss/channel/messages":
        if (state.pageRefused) return raw(captured("dead_reaction"));
        if (state.pageFails) return { ...raw(""), ok: false, status: 500 } as Response;
        return ok(JSON.parse(captured("discuss_channel_messages")));
      case "/web/dataset/call_kw": {
        if (params.method === "mark_all_as_read") return raw(captured("mark_all_as_read"));
        if (params.model === "mail.message" && params.method === "search_read") {
          return state.marked ? raw(captured("search_read_marker")) : ok([]);
        }
        return ok(true);
      }
      default: return ok(true);
    }
  }));
  const on = (p: string) => calls.filter((c) => c.path === p);
  return { calls, state, on };
}

describe("ChatPushActions", () => {
  let env: SyncEnv;
  let chat: ChatService;
  let native: FakeChatPushNative;
  let odoo: ReturnType<typeof fakeOdoo>;
  let clock: Date;
  let configId: string;
  let seq = 0;

  const action = (o: Partial<NativeAction>): NativeAction => ({
    id: `act${++seq}`, configId, kind: "reply", state: "handoff", reason: "session_expired", channelId: CHANNEL,
    messageId: null, clientUuid: POSTED_UUID, text: "", content: "", createdAt: clock.getTime(),
    sentAt: null, plainSent: false, answer: null, ...o,
  });
  const source = async (): Promise<ChatSource> => (await chat.sources({ online: false }))[0];
  const ops = () => env.db.getOutboxOpsForConfig(configId);
  const offline = () => setNetwork({ connected: false, wifi: false });

  beforeEach(async () => {
    seq = 0;
    resetMocks();
    installLocalStorage();
    setNetwork({ connected: true, wifi: true });
    clock = new Date("2026-10-29T04:30:00.000Z");
    odoo = fakeOdoo();
    env = await createSyncEnv([A]);
    native = fakeChatPushNative();
    const rpc = new OdooRpcClient();
    chat = new ChatService(env.db, rpc, new OutboxService(env.db, () => clock), new CapabilityService(env.db, rpc), () => clock, { native });
    await env.db.setApplicationOdooVersion(A.url, A.username, "18.0");
    configId = env.configIds[0];
    await SecureStoragePlugin.set({
      key: syncSessionKey({ odooUrl: A.url, username: A.username, password: A.password, database: A.database }),
      // The session's age is checked against the real clock, not the test's
      value: JSON.stringify({ sessionId: "sid-a", odooMajorVersion: 18, createdAt: new Date().toISOString() }),
    });
    // The conversation as a load left it: two unread, a mention, history loaded down to the last message
    await chat.repo.setSourceState({ configId, selfPartnerId: SELF });
    const seed = parseStore({}, configId, SELF);
    seed.channels.push({
      channelId: CHANNEL, channelType: "chat", name: "", isMember: true, isPinned: true,
      unreadCounter: 2, needactionCounter: 1, lastMessageId: FOUND, seenMessageId: 33,
    });
    // The conversation of the captured page, none of its messages cached
    seed.channels.push({
      channelId: PAGE_CHANNEL, channelType: "chat", name: "", isMember: true, isPinned: true,
      unreadCounter: 0, needactionCounter: 0, lastMessageId: PAGED, seenMessageId: PAGED,
    });
    await chat.repo.applyDelta(configId, seed);
    await chat.repo.patchChannel(configId, CHANNEL, { oldestLoadedId: FOUND, historyComplete: false });
  });

  afterEach(() => {
    chat.dispose();
    setChatSettings({ ...chatSettings(), sendRead: true });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("done", () => {
    it("a done reply shows in its conversation offline", async () => {
      offline();
      native.nativeActions = [action({ state: "done", reason: null, text: TEXT, sentAt: clock.getTime(), answer: JSON.stringify(resultOf("post_answer")) })];
      const changes: [string, number | null][] = [];
      chat.onChange = (c, ch) => changes.push([c, ch]);
      expect(await chat.pushActions.drain()).toEqual({ applied: ["act1"], kept: [] });
      const shown = await chat.repo.message(configId, POSTED);
      expect(shown).toMatchObject({ channelId: CHANNEL, status: "sent", authorPartnerId: SELF });
      expect(shown!.body).toContain(chatMarker(POSTED_UUID));
      expect(native.callsOf("ackActions")).toEqual([{ ids: ["act1"] }]);
      expect(native.nativeActions).toEqual([]);
      expect(changes).toContainEqual([configId, CHANNEL]);
      expect(odoo.calls).toEqual([]);
    });

    it("a done reply is never sent by the outbox", async () => {
      native.nativeActions = [action({ state: "done", reason: null, text: TEXT, sentAt: clock.getTime(), answer: JSON.stringify(resultOf("post_answer")) })];
      await chat.pushActions.drain();
      expect(await ops()).toEqual([]);
      await chat.queue.flush((await source()).creds);
      expect(odoo.on("/mail/message/post")).toEqual([]);
      // Drained again (an ack lost): the same message, still nothing queued
      native.nativeActions = [action({ id: "act1", state: "done", reason: null, answer: JSON.stringify(resultOf("post_answer")) })];
      await chat.pushActions.drain();
      expect((await chat.repo.messages(configId, CHANNEL)).filter((m) => m.messageId === POSTED)).toHaveLength(1);
      expect(await ops()).toEqual([]);
    });

    it("a done read clears the conversation's unread count", async () => {
      offline();
      native.nativeActions = [action({ kind: "read", state: "done", reason: null, messageId: FOUND, clientUuid: FOUND_UUID })];
      await chat.pushActions.drain();
      expect(await chat.repo.channel(configId, CHANNEL)).toMatchObject({ seenMessageId: FOUND, unreadCounter: 0, needactionCounter: 0 });
      expect(await ops()).toEqual([]);
    });

    it("a done read below the last message raises the seen message only", async () => {
      native.nativeActions = [action({ kind: "read", state: "done", reason: null, messageId: 34, clientUuid: FOUND_UUID })];
      await chat.pushActions.drain();
      expect(await chat.repo.channel(configId, CHANNEL)).toMatchObject({ seenMessageId: 34, unreadCounter: 2, needactionCounter: 1 });
    });

    it("a done mute patches the mute", async () => {
      offline();
      const createdAt = clock.getTime() - 10 * 60_000;
      native.nativeActions = [action({ kind: "mute", state: "done", reason: null, createdAt })];
      await chat.pushActions.drain();
      expect((await chat.repo.channel(configId, CHANNEL))!.muteUntilDt).toBe("2026-10-29 05:20:00");
      expect(await ops()).toEqual([]);
    });

    it("a done 👍 applies Odoo's answer to its message", async () => {
      offline();
      const seed = parseStore({ "mail.message": [{ id: REACTED, body: "<p>m</p>", date: "2026-10-29 04:20:00", message_type: "comment",
        author: { id: 4, type: "partner" }, thread: { id: CHANNEL, model: "discuss.channel" } }] }, configId, SELF);
      await chat.repo.applyDelta(configId, seed);
      native.nativeActions = [action({ kind: "react", state: "done", reason: null, messageId: REACTED, content: "👍", answer: JSON.stringify(resultOf("reaction_add")) })];
      await chat.pushActions.drain();
      const groups = (await chat.repo.reactionsOf(configId, CHANNEL, [`m${REACTED}`])).get(`m${REACTED}`) ?? [];
      expect(groups.map((g) => [g.content, g.count, g.selfReacted])).toEqual([["👍", 1, true]]);
      expect(await ops()).toEqual([]);
    });
  });

  describe("handoff", () => {
    it("a handoff reply is queued with the native uuid", async () => {
      offline();
      native.nativeActions = [action({ text: TEXT })];
      expect(await chat.pushActions.drain()).toEqual({ applied: ["act1"], kept: [] });
      const [op] = await ops();
      expect(op).toMatchObject({ kind: CHAT_POST, clientUuid: POSTED_UUID, params: { channelId: CHANNEL, text: TEXT, useModule: false } });
      expect(op.params.maybeSent).toBeUndefined();
      expect(op.params.createSentAt).toBeUndefined();
      expect(await chat.repo.messageByClientUuid(configId, POSTED_UUID)).toMatchObject({ status: "pending", channelId: CHANNEL });
      // Online again, the outbox posts it with the native uuid in its marker
      setNetwork({ connected: true, wifi: true });
      await chat.queue.flush((await source()).creds);
      const [post] = odoo.on("/mail/message/post");
      expect(post.params.post_data.body).toContain(chatMarker(POSTED_UUID));
      expect(post.params.context).toEqual({ temporary_id: POSTED_UUID });
      expect(await chat.repo.messageByClientUuid(configId, POSTED_UUID)).toMatchObject({ messageId: POSTED, status: "sent" });
    });

    it("a handoff reply maybe sent searches before posting", async () => {
      odoo.state.marked = true;
      const sentAt = clock.getTime() - CREATE_QUIET_WINDOW_MS - 60_000;
      native.nativeActions = [action({ text: TEXT, clientUuid: FOUND_UUID, sentAt, plainSent: true })];
      await chat.pushActions.drain();
      expect(odoo.on("/mail/message/post")).toEqual([]);
      const search = odoo.on("/web/dataset/call_kw").filter((c) => c.params.method === "search_read");
      expect(search).toHaveLength(1);
      expect(await ops()).toEqual([]);
      expect(await chat.repo.messageByClientUuid(configId, FOUND_UUID)).toMatchObject({ messageId: FOUND, status: "sent" });
    });

    it("a handoff reply maybe sent waits out the quiet window from its send", async () => {
      native.nativeActions = [action({ text: TEXT, sentAt: clock.getTime() - 60_000 })];
      await chat.pushActions.drain();
      expect(odoo.on("/mail/message/post")).toEqual([]);
      const [op] = await ops();
      expect(op.params).toMatchObject({ maybeSent: true, createSentAt: new Date(clock.getTime() - 60_000).toISOString() });
    });

    it("a handoff reply sent with the module is posted again with its uuid, without a search", async () => {
      await chat.repo.setSourceState({ configId, moduleState: "installed", moduleLevel: "1.5" });
      native.nativeActions = [action({ text: TEXT, sentAt: clock.getTime() - CREATE_QUIET_WINDOW_MS - 60_000 })];
      await chat.pushActions.drain();
      const [post] = odoo.on("/mail/message/post");
      expect(post.params.post_data.erplibre_client_uuid).toBe(POSTED_UUID);
      expect(odoo.on("/web/dataset/call_kw").filter((c) => c.params.method === "search_read" && c.params.model === "mail.message")).toEqual([]);
    });

    it("a drained reply whose uuid already has a message is skipped", async () => {
      offline();
      native.nativeActions = [action({ text: TEXT })];
      native.failNext("ackActions");
      await expect(chat.pushActions.drain()).rejects.toThrow("ackActions");
      expect(await ops()).toHaveLength(1);
      // The drain cut before its ack repeats nothing
      expect(await chat.pushActions.drain()).toEqual({ applied: ["act1"], kept: [] });
      expect(await ops()).toHaveLength(1);
      expect((await chat.repo.messages(configId, CHANNEL)).filter((m) => m.clientUuid === POSTED_UUID)).toHaveLength(1);
      // A message the outbox already settled
      setNetwork({ connected: true, wifi: true });
      await chat.queue.flush((await source()).creds);
      native.nativeActions = [action({ id: "act1", text: TEXT })];
      await chat.pushActions.drain();
      expect(await ops()).toEqual([]);
      expect(odoo.on("/mail/message/post")).toHaveLength(1);
    });

    it("a handoff read is sent with read receipts off", async () => {
      setChatSettings({ ...chatSettings(), sendRead: false });
      native.nativeActions = [action({ kind: "read", messageId: FOUND, clientUuid: FOUND_UUID })];
      await chat.pushActions.drain();
      expect(odoo.on("/discuss/channel/mark_as_read").map((c) => c.params)).toEqual([{ channel_id: CHANNEL, last_message_id: FOUND }]);
      const all = odoo.on("/web/dataset/call_kw").filter((c) => c.params.method === "mark_all_as_read");
      expect(all.map((c) => c.params.args)).toEqual([[[["model", "=", "discuss.channel"], ["res_id", "=", CHANNEL], ["id", "<=", FOUND]]]]);
      expect(await ops()).toEqual([]);
    });

    it("a handoff mute is sent with the minutes left", async () => {
      native.nativeActions = [action({ kind: "mute", createdAt: clock.getTime() - 20 * 60_000 })];
      await chat.pushActions.drain();
      expect(odoo.on("/discuss/settings/mute").map((c) => c.params)).toEqual([{ minutes: 40, channel_id: CHANNEL }]);
    });

    it("a handoff mute whose hour passed is dropped", async () => {
      native.nativeActions = [action({ kind: "mute", createdAt: clock.getTime() - 61 * 60_000 })];
      expect(await chat.pushActions.drain()).toEqual({ applied: ["act1"], kept: [] });
      expect(await ops()).toEqual([]);
      expect(odoo.on("/discuss/settings/mute")).toEqual([]);
    });

    it("a handoff 👍 loads its message then reacts", async () => {
      native.nativeActions = [action({ kind: "react", channelId: PAGE_CHANNEL, messageId: PAGED, content: "👍" })];
      expect(await chat.pushActions.drain()).toEqual({ applied: ["act1"], kept: [] });
      const paths = odoo.calls.map((c) => c.path);
      expect(paths.indexOf("/discuss/channel/messages")).toBeGreaterThanOrEqual(0);
      expect(paths.indexOf("/discuss/channel/messages")).toBeLessThan(paths.indexOf("/mail/message/reaction"));
      expect(odoo.on("/discuss/channel/messages")[0].params.channel_id).toBe(PAGE_CHANNEL);
      expect(odoo.on("/mail/message/reaction").map((c) => c.params)).toEqual([{ message_id: PAGED, content: "👍", action: "add" }]);
    });

    it("a handed-over reply is posted as native code writes it, without emoticon conversion", async () => {
      // The parity case native code's ReplyBody is held to
      const parity = (JSON.parse(readFileSync(resolve(ROOT, "android/app/src/test/resources/chatpush/reply_body_parity.json"), "utf-8")) as
        { name: string; text: string; body: string }[]).find((c) => c.name === "outbox url")!;
      expect(parity.text).toContain(":)");
      offline();
      native.nativeActions = [action({ text: parity.text })];
      await chat.pushActions.drain();
      expect((await chat.repo.messageByClientUuid(configId, POSTED_UUID))!.body).toBe(parity.body);
      setNetwork({ connected: true, wifi: true });
      await chat.queue.flush((await source()).creds);
      expect(odoo.on("/mail/message/post").map((c) => c.params.post_data.body)).toEqual([parity.body + chatMarker(POSTED_UUID)]);
    });

    it("a drained record still failing online a day after its tap is dropped", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      odoo.state.pageFails = true;
      const react = { kind: "react" as const, channelId: PAGE_CHANNEL, messageId: PAGED, content: "👍" };
      native.nativeActions = [
        action({ ...react, createdAt: clock.getTime() - 24 * 3600_000 }),
        action({ ...react, createdAt: clock.getTime() - 23 * 3600_000 }),
      ];
      expect(await chat.pushActions.drain()).toEqual({ applied: ["act1"], kept: ["act2"] });
      expect(native.nativeActions.map((a) => a.id)).toEqual(["act2"]);
    });

    it("a handed-over 👍 a day old is kept while offline", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      offline();
      const react = { kind: "react" as const, channelId: PAGE_CHANNEL, messageId: PAGED, content: "👍" };
      native.nativeActions = [
        action({ ...react, createdAt: clock.getTime() - 25 * 3600_000 }),
        action({ ...react, createdAt: clock.getTime() - 23 * 3600_000 }),
      ];
      expect(await chat.pushActions.drain()).toEqual({ applied: [], kept: ["act1", "act2"] });
      setNetwork({ connected: true, wifi: true });
      expect(await chat.pushActions.drain()).toEqual({ applied: ["act1", "act2"], kept: [] });
      // A 👍 is a target state: the second one finds it given
      expect(odoo.on("/mail/message/reaction").map((c) => c.params.message_id)).toEqual([PAGED]);
    });

    it("a drained record Odoo refuses is dropped", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      odoo.state.pageRefused = true;
      native.nativeActions = [action({ kind: "react", messageId: POSTED, content: "👍" })];
      expect(await chat.pushActions.drain()).toEqual({ applied: ["act1"], kept: [] });
      expect(odoo.on("/discuss/channel/messages")).toHaveLength(1);
      expect(odoo.on("/mail/message/reaction")).toEqual([]);
    });

    it("a handoff 👍 offline is kept for the next drain", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      offline();
      native.nativeActions = [
        action({ kind: "react", channelId: PAGE_CHANNEL, messageId: PAGED, content: "👍" }),
        action({ text: TEXT, clientUuid: FOUND_UUID }),
      ];
      expect(await chat.pushActions.drain()).toEqual({ applied: ["act2"], kept: ["act1"] });
      expect(native.nativeActions.map((a) => a.id)).toEqual(["act1"]);
      setNetwork({ connected: true, wifi: true });
      expect(await chat.pushActions.drain()).toEqual({ applied: ["act1"], kept: [] });
      expect(odoo.on("/mail/message/reaction")).toHaveLength(1);
      // Nothing logged names the reply's text
      for (const c of warn.mock.calls) expect(JSON.stringify(c)).not.toContain("Bonjour");
    });

    it("a handoff 👍 without a message id is dropped", async () => {
      native.nativeActions = [action({ kind: "react", messageId: null, content: "👍" })];
      expect(await chat.pushActions.drain()).toEqual({ applied: ["act1"], kept: [] });
      expect(odoo.on("/mail/message/reaction")).toEqual([]);
      expect(await ops()).toEqual([]);
    });
  });

  it("an action of a removed account is acked and dropped", async () => {
    native.nativeActions = [action({ configId: GONE, text: TEXT }), action({ configId: GONE, kind: "read", messageId: FOUND, state: "done" })];
    expect(await chat.pushActions.drain()).toEqual({ applied: ["act1", "act2"], kept: [] });
    expect(native.callsOf("ackActions")).toEqual([{ ids: ["act1", "act2"] }]);
    expect(await env.db.getOutboxOpsForConfig(GONE)).toEqual([]);
    expect(odoo.calls).toEqual([]);
  });

  it("the actions event drains once while a drain runs", async () => {
    offline();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const served = native.actions.bind(native);
    let first = true;
    native.actions = async () => {
      const list = await served();
      if (first) {
        first = false;
        await gate;
      }
      return list;
    };
    chat.pushActions.start();
    native.emitActions([action({ kind: "mute", state: "done", reason: null })]);
    await vi.waitFor(() => expect(native.callsOf("actions")).toHaveLength(1));
    native.emitActions([action({ kind: "mute", state: "done", reason: null })]);
    native.emitActions([action({ kind: "read", state: "done", reason: null, messageId: FOUND })]);
    release();
    await vi.waitFor(() => expect(native.callsOf("ackActions")).toHaveLength(2));
    expect(native.callsOf("actions")).toHaveLength(2);
    expect(native.callsOf("ackActions")).toEqual([{ ids: ["act1"] }, { ids: ["act2", "act3"] }]);
    // Disposed, an event drains nothing
    chat.dispose();
    native.emitActions([action({ kind: "mute", state: "done", reason: null })]);
    await new Promise((r) => setTimeout(r, 0));
    expect(native.callsOf("actions")).toHaveLength(2);
  });
});
