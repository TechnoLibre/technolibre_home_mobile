import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";
import { DatabaseService } from "../services/databaseService";
import { OdooRpcClient, OdooRpcError, RequestNotSentError, SyncCredentials, syncSessionKey } from "../services/odoo/odooRpcClient";
import { OutboxService } from "../services/outboxService";
import { SyncService, syncConfigIdOf, CREATE_QUIET_WINDOW_MS, clientMarker } from "../services/syncService";
import { addChatTables } from "../services/migrations/addChatTables";
import { ChatRepository } from "../services/chat/chatRepository";
import {
  CHAT_INBOX_ALL, CHAT_INBOX_DONE, CHAT_NOTE, CHAT_PIN, CHAT_POST, CHAT_REACTION, CHAT_READ, CHAT_STAR, CHAT_UPLOAD, ChatOutbox,
  bodyFingerprint, sameTarget,
  targetKey,
} from "../services/chat/chatOutbox";
import { memoryChatFiles } from "../testing/chatFakes";
import type { OutgoingFile } from "../models/chat";
import { chatMarker } from "../services/chat/chatBody";
import { composeBody, type Mentions } from "../services/chat/chatCompose";
import { emojiConversions } from "../services/chat/chatEmoji";
import { createHash } from "node:crypto";

// The real conversions, replaceable per test (a chunk that fails to load)
vi.mock("../services/chat/chatEmoji", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../services/chat/chatEmoji")>();
  return { ...mod, emojiConversions: vi.fn(mod.emojiConversions) };
});

const CREDS: SyncCredentials = { odooUrl: "https://odoo.example.com", username: "alice", password: "pw", database: "db1" };
const CONFIG = syncConfigIdOf(CREDS);
const GONE: SyncCredentials = { ...CREDS, username: "bob" };
const GONE_CONFIG = syncConfigIdOf(GONE);
const CHANNEL = 7;

interface Posted { id: number; model: string; res_id: number; body: string; uuid: string | null; author?: number; parent?: number | false }
interface Call { path: string; params: any }

/**
 * A fake Odoo for the chat routes. Records each call; `dropResponses` makes
 * the next N /mail/message/post calls run on the server and then fail on the
 * wire (response lost); `failBefore` makes the next N fail before reaching it;
 * `unsent` makes the next N fail as a connection that never opened does;
 * `postError` answers the next post with a JSON-RPC error. With `module` it
 * dedups posts by erplibre_client_uuid as the server module does. A post
 * keeps the parent_id it was given, or none (false) when none was given or
 * the parent is in `elsewhere` (ids the server holds in another channel),
 * as Odoo does for a channel; it answers it as `parentMessage`, and a
 * search_read answers it as `parent_id` (`[id, name]` or false).
 * `pinDrops` makes the next N set_message_pin calls run on the server and
 * then lose their answer; `pinError` and `editError` answer set_message_pin
 * and /mail/message/update_content (an edit or a delete) with that error.
 * `starred` holds the ids the user starred on the server: a search_read of
 * `starred` reads it (no row for an id in `gone`), toggle_message_starred
 * flips it, and erplibre_set_starred sets it with the module (an
 * AttributeError without); `starDrops` makes the next N of those two run
 * and then lose their answer, `starError` answers them with that error.
 */
function chatOdoo(opts: { module?: boolean } = {}) {
  const messages: Posted[] = [];
  const calls: Call[] = [];
  const state = {
    dropResponses: 0, failBefore: 0, unsent: 0, postError: null as string | null, nextId: 500, elsewhere: new Set<number>(),
    pinDrops: 0, pinError: null as string | null, editError: null as string | null,
    starred: new Set<number>(), gone: new Set<number>(), starDrops: 0, starError: null as string | null,
  };
  const ok = (result: unknown) => ({
    ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, result }),
    headers: { forEach: () => {} },
  } as unknown as Response);
  const rpcError = (name: string) => ({
    ok: true, status: 200,
    text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: 200, message: "Odoo Server Error", data: { name, message: "refused" } } }),
    headers: { forEach: () => {} },
  } as unknown as Response);

  const fetchMock = vi.fn(async (url: string, init: { body: string }) => {
    const path = new URL(url).pathname;
    const params = JSON.parse(init.body).params;
    calls.push({ path, params });
    if (path === "/mail/message/post") {
      if (state.failBefore > 0) { state.failBefore--; throw new TypeError("Failed to fetch"); }
      if (state.unsent > 0) { state.unsent--; throw new RequestNotSentError("RawHttp error: connection refused"); }
      if (state.postError) return rpcError(state.postError);
      const uuid: string | null = params.post_data.erplibre_client_uuid ?? null;
      let msg = opts.module && uuid ? messages.find((m) => m.uuid === uuid) : undefined;
      if (!msg) {
        const given: number | undefined = params.post_data.parent_id;
        const parent = given === undefined || state.elsewhere.has(given) ? false : given;
        msg = { id: state.nextId++, model: params.thread_model, res_id: params.thread_id, body: params.post_data.body, uuid, author: 3, parent };
        messages.push(msg);
      }
      if (state.dropResponses > 0) { state.dropResponses--; throw new TypeError("Failed to fetch"); }
      const parent = msg.parent ?? false;
      return ok({
        "mail.message": [{ id: msg.id, body: msg.body, date: "2026-10-25 10:00:05", message_type: "comment",
          author: { id: 3, type: "partner" }, thread: { id: msg.res_id, model: msg.model }, parentMessage: parent }],
      });
    }
    if (path === "/web/dataset/call_kw") {
      const { model, method, kwargs } = params;
      if (model === "mail.message" && method === "search_read" && kwargs.fields?.includes("starred")) {
        const id: number = kwargs.domain.find((d: any[]) => d[0] === "id")[2];
        return ok(state.gone.has(id) ? [] : [{ id, starred: state.starred.has(id) }]);
      }
      if (model === "mail.message" && (method === "toggle_message_starred" || method === "erplibre_set_starred")) {
        if (method === "erplibre_set_starred" && !opts.module) return rpcError("builtins.AttributeError");
        if (state.starError) return rpcError(state.starError);
        const id: number = params.args[0][0];
        const on = method === "toggle_message_starred" ? !state.starred.has(id) : !!params.args[1];
        if (on) state.starred.add(id);
        else state.starred.delete(id);
        if (state.starDrops > 0) { state.starDrops--; throw new TypeError("Failed to fetch"); }
        return ok({ "mail.message": [{ id, starred: on }] });
      }
      if (model === "mail.message" && method === "search_read") {
        const needle = (kwargs.domain.find((d: any[]) => d[1] === "ilike") ?? [])[2] as string;
        const resId = kwargs.domain.find((d: any[]) => d[0] === "res_id")[2];
        const author = (kwargs.domain.find((d: any[]) => d[0] === "author_id") ?? [])[2];
        const rows = messages
          .filter((m) => m.res_id === resId && m.body.includes(needle) && (author === undefined || m.author === author))
          .map((m) => ({ id: m.id, body: m.body, parent_id: m.parent ? [m.parent, "m" + m.parent] : false }));
        return ok(rows.slice(0, kwargs.limit ?? rows.length));
      }
      if (method === "set_message_pin" && state.pinError) return rpcError(state.pinError);
      if (method === "set_message_pin" && state.pinDrops > 0) { state.pinDrops--; throw new TypeError("Failed to fetch"); }
      return ok(method === "search_read" ? [] : true);
    }
    if (path === "/web/session/get_session_info") return ok({ uid: 2, partner_id: 3, is_system: false });
    if (path === "/mail/message/update_content" && state.editError) return rpcError(state.editError);
    return ok(true);
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    messages, calls, state,
    posts: () => calls.filter((c) => c.path === "/mail/message/post"),
    pins: () => calls.filter((c) => c.path === "/web/dataset/call_kw" && c.params.method === "set_message_pin").map((c) => c.params),
    /** The star writes sent (toggle_message_starred, erplibre_set_starred), as call_kw params. */
    stars: () => calls.filter((c) => c.path === "/web/dataset/call_kw"
      && (c.params.method === "toggle_message_starred" || c.params.method === "erplibre_set_starred")).map((c) => c.params),
    /** The ids of the star re-reads (search_read of `starred`), in order. */
    starReads: () => calls.filter((c) => c.path === "/web/dataset/call_kw" && c.params.method === "search_read"
      && c.params.kwargs.fields?.includes("starred")).map((c) => c.params.kwargs.domain.find((d: any[]) => d[0] === "id")[2]),
  };
}

describe("ChatOutbox", () => {
  let db: DatabaseService;
  let repo: ChatRepository;
  let outbox: OutboxService;
  let rpc: OdooRpcClient;
  let chat: ChatOutbox;
  let clock: Date;

  beforeEach(async () => {
    SecureStoragePlugin._store.clear();
    db = new DatabaseService();
    await db.initialize();
    await db.addSyncFieldsToApplications();
    await db.addNtfyTokenColumn();
    await db.createSyncOutboxTable();
    await addChatTables(db);
    for (const c of [CREDS]) {
      await db.addApplication({
        url: c.odooUrl, username: c.username, password: c.password, database: c.database,
        odooVersion: "", autoSync: false, pollIntervalMinutes: 5, ntfyUrl: "", ntfyTopic: "", ntfyToken: "",
      } as any);
    }
    await SecureStoragePlugin.set({
      key: syncSessionKey(CREDS),
      value: JSON.stringify({ sessionId: "sid", odooMajorVersion: 18, createdAt: new Date().toISOString() }),
    });
    clock = new Date("2026-10-25T10:00:00.000Z");
    repo = new ChatRepository(db, () => clock);
    rpc = new OdooRpcClient();
    outbox = new OutboxService(db, () => clock);
    chat = new ChatOutbox(db, rpc, outbox, repo, () => clock);
    await repo.setSourceState({ configId: CONFIG, selfPartnerId: 3 });
    await repo.applyDelta(CONFIG, {
      channels: [{ channelId: CHANNEL, channelType: "group", name: "Team", unreadCounter: 4, isMember: true, lastMessageId: 40, seenMessageId: 30 }],
      deletedChannelIds: [], members: [], deletedMemberIds: [], messages: [], attachments: [], deletedAttachmentIds: [], partners: [], inboxCounter: null, selfPartnerId: null,
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  const advance = (ms: number) => { clock = new Date(clock.getTime() + ms); };

  it("sameTarget names one message by its client uuid when both have one, else by its id", () => {
    expect(sameTarget({ messageId: 5, clientUuid: "u1" }, { messageId: null, clientUuid: "u1" })).toBe(true);
    expect(sameTarget({ messageId: 5, clientUuid: "u1" }, { messageId: 5, clientUuid: "u2" })).toBe(false);
    expect(sameTarget({ messageId: 5, clientUuid: null }, { messageId: 5, clientUuid: "u1" })).toBe(true);
    expect(sameTarget({ messageId: 5, clientUuid: null }, { messageId: 6, clientUuid: null })).toBe(false);
    expect(sameTarget({ messageId: null, clientUuid: null }, { messageId: null, clientUuid: null })).toBe(false);
  });

  it("bodyFingerprint is the sha256 hex of the body's UTF-8, the empty body hashed as \"\"", async () => {
    expect(await bodyFingerprint("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(await bodyFingerprint("<p>café 👍</p>")).toBe(createHash("sha256").update("<p>café 👍</p>", "utf8").digest("hex"));
  });

  it("targetKey tells apart two messages, two emoji and two people removed", () => {
    const op = (params: Record<string, any>, kind = CHAT_REACTION) => ({ kind, params }) as any;
    const r = { channelId: 7, messageId: 5, clientUuid: null, content: "x" };
    expect(targetKey(op(r))).toBe(targetKey(op({ ...r, action: "remove" })));
    expect(targetKey(op(r))).not.toBe(targetKey(op({ ...r, messageId: 6 })));
    expect(targetKey(op(r))).not.toBe(targetKey(op({ ...r, content: "y" })));
    expect(targetKey(op({ channelId: 7, partnerId: 1 }, "chat.remove"))).not.toBe(targetKey(op({ channelId: 7, partnerId: 2 }, "chat.remove")));
    expect(targetKey(op({ channelId: 7, name: "a" }, "chat.rename"))).toBe(targetKey(op({ channelId: 7, name: "b" }, "chat.rename")));
  });

  it("queuePost stores the op and a pending message before any request", async () => {
    const odoo = chatOdoo();
    const m = await chat.queuePost(CONFIG, CHANNEL, "a < b\nline", true);
    expect(odoo.calls).toHaveLength(0);
    expect(m).toMatchObject({ status: "pending", messageId: null, authorPartnerId: 3, channelId: CHANNEL });
    expect(m.body).toBe("a &lt; b<br>line");
    const [op] = await db.getOutboxOpsForConfig(CONFIG);
    expect(op).toMatchObject({ kind: CHAT_POST, noteId: CHAT_NOTE, params: { channelId: CHANNEL, text: "a < b\nline", useModule: true } });
    expect(m.clientUuid).toBe(op.clientUuid);
    expect(m.outboxOpId).toBe(op.id);
    expect((await repo.messages(CONFIG, CHANNEL)).map((x) => x.clientUuid)).toEqual([op.clientUuid]);
  });

  it("a post settled after its account was deleted writes nothing", async () => {
    await chat.queuePost(CONFIG, CHANNEL, "hi", true);
    const [op] = await db.getOutboxOpsForConfig(CONFIG);
    await chat.dropAll(CONFIG);
    await repo.dropSource(CONFIG);
    await (chat as any).settleNow(op, 600, {
      "mail.message": [{ id: 600, body: "hi", date: "2026-10-25 10:00:05", message_type: "comment",
        author: { id: 3, type: "partner" }, thread: { id: CHANNEL, model: "discuss.channel" } }],
      "res.partner": [{ id: 3, name: "Alice" }],
    });
    expect(await repo.messages(CONFIG, CHANNEL)).toEqual([]);
    expect(await repo.partners(CONFIG)).toEqual([]);
    expect(await repo.channels(CONFIG)).toEqual([]);
  });

  it("post with module sends uuid and settles", async () => {
    const odoo = chatOdoo({ module: true });
    const m = await chat.queuePost(CONFIG, CHANNEL, "hello", true);
    const res = await chat.flush(CREDS);
    expect(res).toMatchObject({ done: 1, failed: 0, blocked: 0 });
    const [call] = odoo.posts();
    expect(call.params.thread_model).toBe("discuss.channel");
    expect(call.params.thread_id).toBe(CHANNEL);
    expect(call.params.post_data).toMatchObject({ message_type: "comment", subtype_xmlid: "mail.mt_comment", erplibre_client_uuid: m.clientUuid });
    expect(call.params.post_data.body).toBe("hello" + chatMarker(m.clientUuid!));
    expect(call.params.context).toEqual({ temporary_id: m.clientUuid });
    expect(await db.getOutboxOpsForConfig(CONFIG)).toHaveLength(0);
    const rows = await repo.messages(CONFIG, CHANNEL);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ messageId: 500, status: "sent", clientUuid: m.clientUuid });
  });

  it("a posted message marks its channel read for the author", async () => {
    chatOdoo({ module: true });
    await chat.queuePost(CONFIG, CHANNEL, "hello", true);
    await chat.flush(CREDS);
    expect(await repo.channel(CONFIG, CHANNEL)).toMatchObject({ seenMessageId: 500, unreadCounter: 0, newMessageSeparator: 501 });
  });

  it("post without module appends marker", async () => {
    const odoo = chatOdoo();
    const m = await chat.queuePost(CONFIG, CHANNEL, "hello <b>", false);
    await chat.flush(CREDS);
    const [call] = odoo.posts();
    expect(call.params.post_data).not.toHaveProperty("erplibre_client_uuid");
    expect(call.params.post_data.body).toBe("hello &lt;b&gt;" + chatMarker(m.clientUuid!));
    expect(call.params.post_data.body.endsWith(" -->")).toBe(true);
    expect(await db.getOutboxOpsForConfig(CONFIG)).toHaveLength(0);
  });

  it("a post sends the browser composer's HTML, then the marker", async () => {
    const odoo = chatOdoo();
    const m = await chat.queuePost(CONFIG, CHANNEL, "voir https://example.com :) fin", false);
    const html = 'voir <a target="_blank" rel="noreferrer noopener" href="https://example.com/">https://example.com</a> 😊 fin';
    expect(m.body).toBe(html);
    await chat.flush(CREDS);
    expect(odoo.posts()[0].params.post_data.body).toBe(html + chatMarker(m.clientUuid!));
  });

  describe("mentions and reply", () => {
    const BOB: Mentions = { partners: [{ id: 4, name: "Bob Martin" }], channels: [] };
    const html = async (text: string, m: Mentions) => composeBody(text, m, await emojiConversions()).body;
    const QUESTION = 40;

    beforeEach(async () => {
      await repo.applyDelta(CONFIG, {
        channels: [], deletedChannelIds: [], members: [], deletedMemberIds: [], attachments: [], deletedAttachmentIds: [],
        partners: [], inboxCounter: null, selfPartnerId: null,
        messages: [{ messageId: QUESTION, channelId: CHANNEL, authorPartnerId: 4, body: "<p>question</p>", date: "2026-10-25 09:00:00", messageType: "comment" }],
      });
    });

    it("a mention sends partner_ids and the anchor", async () => {
      const odoo = chatOdoo();
      const m = await chat.queuePost(CONFIG, CHANNEL, "hi @Bob Martin", false, { mentions: BOB });
      const body = await html("hi @Bob Martin", BOB);
      expect(body).toContain('data-oe-id="4"');
      expect(m.body).toBe(body);
      expect((await db.getOutboxOpsForConfig(CONFIG))[0].params).toMatchObject({ mentions: BOB, parent: null });
      // A pick edited away out of the text mentions no one
      await chat.queuePost(CONFIG, CHANNEL, "hi Bob", false, { mentions: BOB });
      await chat.flush(CREDS);
      const [first, second] = odoo.posts().map((c) => c.params.post_data);
      expect(first.body).toBe(body + chatMarker(m.clientUuid!));
      expect(first.partner_ids).toEqual([4]);
      expect(first).not.toHaveProperty("special_mentions");
      expect(first).not.toHaveProperty("parent_id");
      expect(second).not.toHaveProperty("partner_ids");
    });

    it("@everyone sends special_mentions", async () => {
      const odoo = chatOdoo();
      const m = await chat.queuePost(CONFIG, CHANNEL, "hello @everyone", false);
      const body = await html("hello @everyone", { partners: [], channels: [] });
      expect(body).toContain('class="o-discuss-mention"');
      await chat.flush(CREDS);
      const [post] = odoo.posts().map((c) => c.params.post_data);
      expect(post.body).toBe(body + chatMarker(m.clientUuid!));
      expect(post.special_mentions).toEqual(["everyone"]);
      expect(post).not.toHaveProperty("partner_ids");
    });

    it("a reply sends parent_id", async () => {
      const odoo = chatOdoo();
      const m = await chat.queuePost(CONFIG, CHANNEL, "answer", false, { replyTo: { messageId: QUESTION, clientUuid: null } });
      expect(m).toMatchObject({ parentId: QUESTION, parentClientUuid: null });
      expect((await db.getOutboxOpsForConfig(CONFIG))[0].params.parent).toEqual({ messageId: QUESTION, clientUuid: null });
      await chat.flush(CREDS);
      expect(odoo.posts()[0].params.post_data.parent_id).toBe(QUESTION);
      expect(await repo.message(CONFIG, 500)).toMatchObject({ status: "sent", parentId: QUESTION, parentClientUuid: null });
    });

    it("a reply to a pending message sends the parent's server id", async () => {
      const odoo = chatOdoo();
      const question = await chat.queuePost(CONFIG, CHANNEL, "question?", false);
      const answer = await chat.queuePost(CONFIG, CHANNEL, "answer", false, { replyTo: { messageId: null, clientUuid: question.clientUuid } });
      expect(answer).toMatchObject({ parentId: null, parentClientUuid: question.clientUuid });
      await chat.flush(CREDS);
      const [first, second] = odoo.posts().map((c) => c.params.post_data);
      expect(first).not.toHaveProperty("parent_id");
      expect(second.parent_id).toBe(500);
      expect(await repo.message(CONFIG, 501)).toMatchObject({ clientUuid: answer.clientUuid, parentId: 500, parentClientUuid: null });
    });

    it("a reply to a message dropped before it was sent goes without parent_id", async () => {
      const odoo = chatOdoo();
      const question = await chat.queuePost(CONFIG, CHANNEL, "question?", false);
      await chat.queuePost(CONFIG, CHANNEL, "answer", false, { replyTo: { messageId: null, clientUuid: question.clientUuid } });
      expect(await chat.queueDelete(CONFIG, CHANNEL, { messageId: null, clientUuid: question.clientUuid })).toBeNull();
      await chat.flush(CREDS);
      expect(odoo.posts().map((c) => c.params.post_data.body)).toEqual([expect.stringMatching(/^answer/)]);
      expect(odoo.posts()[0].params.post_data).not.toHaveProperty("parent_id");
    });

    it("a parent dropped by the server gives a plain message", async () => {
      const odoo = chatOdoo();
      odoo.state.elsewhere.add(QUESTION);
      await chat.queuePost(CONFIG, CHANNEL, "answer", false, { replyTo: { messageId: QUESTION, clientUuid: null } });
      expect(await chat.flush(CREDS)).toMatchObject({ done: 1, failed: 0, blocked: 0 });
      expect(odoo.posts()[0].params.post_data.parent_id).toBe(QUESTION);
      expect(await repo.message(CONFIG, 500)).toMatchObject({ status: "sent", parentId: null, parentClientUuid: null });
      expect(await db.getOutboxOpsForConfig(CONFIG)).toEqual([]);
      expect(await chat.notices([CONFIG])).toEqual([]);
    });

    it("a parent of another channel dropped behind a lost answer gives a plain message once found", async () => {
      const odoo = chatOdoo();
      odoo.state.dropResponses = 1;
      odoo.state.elsewhere.add(QUESTION);
      await chat.queuePost(CONFIG, CHANNEL, "answer", false, { replyTo: { messageId: QUESTION, clientUuid: null } });
      expect(await chat.flush(CREDS)).toMatchObject({ failed: 1 });
      advance(CREATE_QUIET_WINDOW_MS + 1000);
      expect(await chat.flush(CREDS, { force: true })).toMatchObject({ done: 1, failed: 0 });
      expect(odoo.posts()).toHaveLength(1);
      expect(await repo.message(CONFIG, 500)).toMatchObject({ status: "sent", parentId: null, parentClientUuid: null });
      expect(await chat.notices([CONFIG])).toEqual([]);
    });

    it("a retried post with mentions is found by its marker and not re-sent", async () => {
      const odoo = chatOdoo();
      odoo.state.dropResponses = 1;
      const m = await chat.queuePost(CONFIG, CHANNEL, "hi @Bob Martin @everyone", false, {
        mentions: BOB, replyTo: { messageId: QUESTION, clientUuid: null },
      });
      expect(await chat.flush(CREDS)).toMatchObject({ failed: 1 });
      advance(CREATE_QUIET_WINDOW_MS + 1000);
      expect(await chat.flush(CREDS, { force: true })).toMatchObject({ done: 1, failed: 0 });
      const [post] = odoo.posts().map((c) => c.params.post_data);
      expect(odoo.posts()).toHaveLength(1);
      expect(odoo.messages).toHaveLength(1);
      expect(post).toMatchObject({ partner_ids: [4], special_mentions: ["everyone"], parent_id: QUESTION });
      expect(post.body).toBe(await html("hi @Bob Martin @everyone", BOB) + chatMarker(m.clientUuid!));
      // The answer was lost: the parent stays the one the post named
      expect(await repo.message(CONFIG, 500)).toMatchObject({ status: "sent", clientUuid: m.clientUuid, parentId: QUESTION });
    });
  });

  it("a post whose emoji chunk fails to load is not stamped as possibly sent", async () => {
    const odoo = chatOdoo();
    const m = await chat.queuePost(CONFIG, CHANNEL, "hello :)", false);
    vi.mocked(emojiConversions).mockRejectedValueOnce(new Error("chunk failed"));
    await chat.flush(CREDS);
    expect(odoo.posts()).toHaveLength(0);
    const [op] = await db.getOutboxOpsForConfig(CONFIG);
    expect(op.params.createSentAt ?? null).toBeNull();
    advance(60_000);
    await chat.flush(CREDS);
    expect(odoo.posts().map((p) => p.params.post_data.body)).toEqual(["hello 😊" + chatMarker(m.clientUuid!)]);
  });

  it("lost response then retry adopts the marked message", async () => {
    const odoo = chatOdoo();
    odoo.state.dropResponses = 1;
    const m = await chat.queuePost(CONFIG, CHANNEL, "hello", false);

    expect(await chat.flush(CREDS)).toMatchObject({ failed: 1 });
    expect(odoo.messages).toHaveLength(1);
    const [stuck] = await db.getOutboxOpsForConfig(CONFIG);
    expect(stuck).toMatchObject({ status: "failed", attempts: 1 });
    expect(stuck.params.createSentAt).toBe(clock.toISOString());

    // Inside the quiet window the first request may still be running: nothing is sent
    advance(60_000);
    const before = odoo.calls.length;
    await chat.flush(CREDS, { force: true });
    expect(odoo.calls).toHaveLength(before);
    expect((await db.getOutboxOp(stuck.id))!.attempts).toBe(1);

    advance(CREATE_QUIET_WINDOW_MS);
    expect(await chat.flush(CREDS, { force: true })).toMatchObject({ done: 1, failed: 0 });
    expect(odoo.posts()).toHaveLength(1);
    expect(odoo.messages).toHaveLength(1);
    const rows = await repo.messages(CONFIG, CHANNEL);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ messageId: 500, status: "sent", clientUuid: m.clientUuid });
    expect(await db.getOutboxOpsForConfig(CONFIG)).toHaveLength(0);
  });

  it("a failure before the server saw the post is re-sent with the same body", async () => {
    const odoo = chatOdoo();
    odoo.state.failBefore = 1;
    await chat.queuePost(CONFIG, CHANNEL, "a < b & c", false);
    await chat.flush(CREDS);
    advance(CREATE_QUIET_WINDOW_MS);
    expect(await chat.flush(CREDS, { force: true })).toMatchObject({ done: 1 });
    const [first, second] = odoo.posts();
    expect(second.params.post_data.body).toBe(first.params.post_data.body);
    expect(first.params.post_data.body).toContain("a &lt; b &amp; c");
    expect(first.params.post_data.body).not.toContain("&amp;lt;");
    expect(odoo.messages).toHaveLength(1);
  });

  it("a post whose connection never opened is retried without the quiet window", async () => {
    const odoo = chatOdoo();
    odoo.state.unsent = 1;
    await chat.queuePost(CONFIG, CHANNEL, "hello", false);
    expect(await chat.flush(CREDS)).toMatchObject({ failed: 1 });
    const [op] = await db.getOutboxOpsForConfig(CONFIG);
    expect(op.params.createSentAt ?? null).toBeNull();
    advance(1000);
    expect(await chat.flush(CREDS, { force: true })).toMatchObject({ done: 1 });
    expect(odoo.messages).toHaveLength(1);
    expect((await repo.messages(CONFIG, CHANNEL)).map((x) => x.status)).toEqual(["sent"]);
  });

  it("offline, a post is not tried and its retry waits for no window", async () => {
    const odoo = chatOdoo();
    chat.isOnline = async () => false;
    await chat.queuePost(CONFIG, CHANNEL, "hello", false);
    expect(await chat.flush(CREDS)).toMatchObject({ failed: 1 });
    expect(odoo.posts()).toHaveLength(0);
    expect((await db.getOutboxOpsForConfig(CONFIG))[0].params.createSentAt ?? null).toBeNull();
    chat.isOnline = async () => true;
    expect(await chat.flush(CREDS, { force: true })).toMatchObject({ done: 1 });
    expect(odoo.posts()).toHaveLength(1);
  });

  it("an unsent retry gives back the earlier stamp, whose window is over", async () => {
    const odoo = chatOdoo();
    // A failure the client cannot place: the post may have run, the window holds
    odoo.state.failBefore = 1;
    await chat.queuePost(CONFIG, CHANNEL, "hello", false);
    await chat.flush(CREDS);
    const stamped = clock.toISOString();
    expect((await db.getOutboxOpsForConfig(CONFIG))[0].params.createSentAt).toBe(stamped);
    advance(CREATE_QUIET_WINDOW_MS);
    odoo.state.unsent = 1;
    expect(await chat.flush(CREDS, { force: true })).toMatchObject({ failed: 1 });
    expect((await db.getOutboxOpsForConfig(CONFIG))[0].params.createSentAt).toBe(stamped);
    advance(1000);
    expect(await chat.flush(CREDS, { force: true })).toMatchObject({ done: 1 });
    expect(odoo.messages).toHaveLength(1);
  });

  it("two messages carrying the marker block the post as ambiguous", async () => {
    const odoo = chatOdoo();
    odoo.state.dropResponses = 1;
    const m = await chat.queuePost(CONFIG, CHANNEL, "hello", false);
    await chat.flush(CREDS);
    odoo.messages.push({ id: 900, model: "discuss.channel", res_id: CHANNEL, body: "x" + chatMarker(m.clientUuid!), uuid: null, author: 3 });
    advance(CREATE_QUIET_WINDOW_MS);
    const res = await chat.flush(CREDS, { force: true });
    expect(res.blocked).toBe(1);
    const [op] = await db.getOutboxOpsForConfig(CONFIG);
    expect(op).toMatchObject({ status: "blocked", params: { blockedReason: "ambiguous" } });
    expect(odoo.posts()).toHaveLength(1);
  });

  it("lost response with module waits the quiet window then adopts", async () => {
    const odoo = chatOdoo({ module: true });
    odoo.state.dropResponses = 1;
    const m = await chat.queuePost(CONFIG, CHANNEL, "hello", true);
    expect(await chat.flush(CREDS)).toMatchObject({ failed: 1 });

    advance(60_000);
    await chat.flush(CREDS, { force: true });
    expect(odoo.posts()).toHaveLength(1);

    advance(CREATE_QUIET_WINDOW_MS);
    expect(await chat.flush(CREDS, { force: true })).toMatchObject({ done: 1 });
    expect(odoo.posts()).toHaveLength(1);
    expect(odoo.messages).toHaveLength(1);
    expect(odoo.posts()[0].params.post_data.erplibre_client_uuid).toBe(m.clientUuid);
    expect((await repo.messages(CONFIG, CHANNEL)).map((x) => [x.messageId, x.status])).toEqual([[500, "sent"]]);
  });

  it("a message of another author carrying the marker text is not adopted", async () => {
    const odoo = chatOdoo();
    odoo.state.failBefore = 1;
    const m = await chat.queuePost(CONFIG, CHANNEL, "hello", false);
    await chat.flush(CREDS);
    odoo.messages.push({ id: 900, model: "discuss.channel", res_id: CHANNEL, body: chatMarker(m.clientUuid!), uuid: null, author: 99 });
    advance(CREATE_QUIET_WINDOW_MS);
    expect(await chat.flush(CREDS, { force: true })).toMatchObject({ done: 1 });
    expect(odoo.posts()).toHaveLength(2);
    expect((await repo.messages(CONFIG, CHANNEL)).map((x) => x.messageId)).toEqual([500]);
  });

  it("a hit whose body only quotes the uuid is not adopted", async () => {
    const odoo = chatOdoo();
    odoo.state.failBefore = 1;
    const m = await chat.queuePost(CONFIG, CHANNEL, "hello", false);
    await chat.flush(CREDS);
    odoo.messages.push({ id: 900, model: "discuss.channel", res_id: CHANNEL, body: "see " + clientMarker(m.clientUuid!), uuid: null, author: 3 });
    advance(CREATE_QUIET_WINDOW_MS);
    expect(await chat.flush(CREDS, { force: true })).toMatchObject({ done: 1 });
    expect(odoo.posts()).toHaveLength(2);
  });

  it("a refused marker search blocks the op and keeps the text as failed", async () => {
    const odoo = chatOdoo();
    odoo.state.failBefore = 1;
    const m = await chat.queuePost(CONFIG, CHANNEL, "keep me", false);
    await chat.flush(CREDS);
    vi.spyOn(rpc, "searchRead").mockImplementation(async () => { throw new OdooRpcError("no", "odoo.exceptions.AccessError"); });
    advance(CREATE_QUIET_WINDOW_MS);
    expect(await chat.flush(CREDS, { force: true })).toMatchObject({ blocked: 1 });
    const [op] = await db.getOutboxOpsForConfig(CONFIG);
    expect(op).toMatchObject({ status: "blocked", params: { blockedReason: "refused" } });
    expect((await repo.messages(CONFIG, CHANNEL))[0]).toMatchObject({ status: "failed", clientUuid: m.clientUuid });
  });

  it("a refused post blocks the op and keeps the text as failed", async () => {
    const odoo = chatOdoo();
    odoo.state.postError = "odoo.exceptions.AccessError";
    const m = await chat.queuePost(CONFIG, CHANNEL, "keep me", false);
    const res = await chat.flush(CREDS);
    expect(res.blocked).toBe(1);
    const [op] = await db.getOutboxOpsForConfig(CONFIG);
    expect(op).toMatchObject({ status: "blocked", params: { blockedReason: "refused" } });
    expect(op.params.createSentAt ?? null).toBeNull();
    const [row] = await repo.messages(CONFIG, CHANNEL);
    expect(row).toMatchObject({ status: "failed", clientUuid: m.clientUuid });
    expect(row.body).toContain("keep me");
  });

  it("two queued posts keep their order when the first fails", async () => {
    const odoo = chatOdoo({ module: true });
    odoo.state.failBefore = 1;
    const a = await chat.queuePost(CONFIG, CHANNEL, "first", true);
    advance(1000);
    const b = await chat.queuePost(CONFIG, CHANNEL, "second", true);
    const ops = await db.getOutboxOpsForConfig(CONFIG);
    expect(ops[1].dependsOn).toBe(ops[0].id);
    expect(ops[0].dependsOn).toBeNull();

    expect(await chat.flush(CREDS)).toMatchObject({ failed: 1, done: 0 });
    expect(odoo.posts()).toHaveLength(1);
    expect(odoo.messages).toHaveLength(0);

    advance(CREATE_QUIET_WINDOW_MS);
    expect(await chat.flush(CREDS, { force: true })).toMatchObject({ done: 2 });
    expect(odoo.messages.map((m) => m.uuid)).toEqual([a.clientUuid, b.clientUuid]);
  });

  it("three posts queued at the same instant form a chain", async () => {
    chatOdoo({ module: true });
    for (const t of ["1", "2", "3"]) await chat.queuePost(CONFIG, CHANNEL, t, true);
    const ops = await db.getOutboxOpsForConfig(CONFIG);
    const byText = (t: string) => ops.find((o) => o.params.text === t)!;
    expect(byText("1").dependsOn).toBeNull();
    expect(byText("2").dependsOn).toBe(byText("1").id);
    expect(byText("3").dependsOn).toBe(byText("2").id);
  });

  it("a pending message that cannot be stored leaves no op behind", async () => {
    chatOdoo({ module: true });
    vi.spyOn(repo, "putPending").mockRejectedValueOnce(new Error("disk full"));
    await expect(chat.queuePost(CONFIG, CHANNEL, "hello", true)).rejects.toThrow("disk full");
    expect(await db.getOutboxOpsForConfig(CONFIG)).toHaveLength(0);
  });

  describe("posts with files", () => {
    let files: ReturnType<typeof memoryChatFiles>;
    const file = (uuid: string, name = `${uuid}.jpg`): OutgoingFile => {
      const path = `chat/dir/out/${uuid}/${name}`;
      files.put(path, new Uint8Array(3));
      return { localUuid: uuid, path, name, mimetype: "image/jpeg", size: 3, voice: false };
    };

    beforeEach(() => {
      files = memoryChatFiles();
      chat.files = files;
    });

    it("queuePost with files chains its uploads between the channel's tail and the post", async () => {
      chatOdoo();
      await chat.queuePost(CONFIG, CHANNEL, "first", false);
      const m = await chat.queuePost(CONFIG, CHANNEL, "", false, { files: [file("l1"), file("l2")], idempotentUpload: true });
      await chat.queuePost(CONFIG, CHANNEL, "after", false);
      const ops = await db.getOutboxOpsForConfig(CONFIG);
      const first = ops.find((o) => o.params.text === "first")!;
      const post = ops.find((o) => o.clientUuid === m.clientUuid)!;
      const [up1, up2] = ["l1", "l2"].map((u) => ops.find((o) => o.kind === CHAT_UPLOAD && o.params.localUuid === u)!);
      expect(up1).toMatchObject({
        status: "queued", noteId: CHAT_NOTE, dependsOn: first.id,
        params: { channelId: CHANNEL, localUuid: "l1", path: "chat/dir/out/l1/l1.jpg", name: "l1.jpg", mimetype: "image/jpeg", size: 3, voice: false, useModule: true },
      });
      expect(up2.dependsOn).toBe(up1.id);
      expect(post).toMatchObject({ status: "queued", dependsOn: up2.id, params: { text: "", files: ["l1", "l2"], idempotentUpload: true } });
      // The tail of the channel is the post, never one of its uploads
      expect(ops.find((o) => o.params.text === "after")!.dependsOn).toBe(post.id);
      expect((await repo.outgoingOf(CONFIG, m.clientUuid)).map((r) => [r.localUuid, r.seq, r.state, r.originalPath, r.channelId])).toEqual([
        ["l1", 0, "queued", "chat/dir/out/l1/l1.jpg", CHANNEL], ["l2", 1, "queued", "chat/dir/out/l2/l2.jpg", CHANNEL],
      ]);
      expect(await chat.pendingUploadCount(CONFIG)).toBe(2);
    });

    it("a conversation that cannot take a post keeps its files refused beside the failed text", async () => {
      chatOdoo();
      await repo.patchChannel(CONFIG, CHANNEL, { createFailed: true });
      const m = await chat.queuePost(CONFIG, CHANNEL, "x", false, { files: [file("l1")] });
      expect(m.status).toBe("failed");
      expect(await db.getOutboxOpsForConfig(CONFIG)).toEqual([]);
      expect((await repo.outgoingOf(CONFIG, m.clientUuid)).map((r) => [r.state, r.error])).toEqual([["refused", "channel"]]);
    });

    it("a post with files that cannot be stored leaves no op, row or file behind", async () => {
      chatOdoo();
      vi.spyOn(repo, "putPending").mockRejectedValueOnce(new Error("disk full"));
      const f = file("l1");
      await expect(chat.queuePost(CONFIG, CHANNEL, "x", false, { files: [f] })).rejects.toThrow("disk full");
      expect(await db.getOutboxOpsForConfig(CONFIG)).toEqual([]);
      expect(await db.rawQuery("SELECT id FROM chat_attachments")).toEqual([]);
      expect(files.bytes(f.path)).toBeUndefined();
    });

    it("a post whose rows cannot be stored deletes its staged files", async () => {
      chatOdoo();
      vi.spyOn(repo, "putOutgoing").mockRejectedValueOnce(new Error("disk full"));
      const f = file("l1");
      await expect(chat.queuePost(CONFIG, CHANNEL, "x", false, { files: [f] })).rejects.toThrow("disk full");
      expect(await db.getOutboxOpsForConfig(CONFIG)).toEqual([]);
      expect(files.bytes(f.path)).toBeUndefined();
    });

    it("a post cut before its rows were stored deletes its staged files at startup", async () => {
      chatOdoo();
      const f = file("c1");
      const up = await outbox.enqueue({ noteId: CHAT_NOTE, configId: CONFIG, kind: CHAT_UPLOAD, params: { channelId: CHANNEL, localUuid: "c1", path: f.path }, status: "incomplete" });
      await outbox.enqueue({ noteId: CHAT_NOTE, configId: CONFIG, kind: CHAT_POST, params: { channelId: CHANNEL, text: "", files: ["c1"] }, dependsOn: up.id, status: "incomplete" });
      expect(await chat.recoverIncomplete()).toBe(0);
      expect(await db.getOutboxOpsForConfig(CONFIG)).toEqual([]);
      expect(files.bytes(f.path)).toBeUndefined();
    });

    it("an upload cut before its post was queued deletes its staged file at startup", async () => {
      chatOdoo();
      const f = file("u1");
      await outbox.enqueue({ noteId: CHAT_NOTE, configId: CONFIG, kind: CHAT_UPLOAD, params: { channelId: CHANNEL, localUuid: "u1", path: f.path }, status: "incomplete" });
      await chat.recoverIncomplete();
      expect(await db.getOutboxOpsForConfig(CONFIG)).toEqual([]);
      expect(files.bytes(f.path)).toBeUndefined();
    });

    it("a post with files cut while being queued is repaired at startup", async () => {
      chatOdoo();
      // Cut before the completion: everything written, still incomplete
      const complete = vi.spyOn(outbox, "complete").mockImplementation(async () => {});
      const kept = await chat.queuePost(CONFIG, CHANNEL, "kept", false, { files: [file("k1")] });
      complete.mockRestore();
      // Cut before the message: the op and its upload stored, a row, no bubble
      const lost = await outbox.enqueue({ noteId: CHAT_NOTE, configId: CONFIG, kind: CHAT_POST, params: { channelId: 8, text: "lost", files: ["g1"] }, status: "incomplete" });
      const lostUp = await outbox.enqueue({ noteId: CHAT_NOTE, configId: CONFIG, kind: CHAT_UPLOAD, params: { channelId: 8, localUuid: "g1" }, status: "incomplete" });
      await db.updateOutboxOp(lost.id, { dependsOn: lostUp.id, updatedAt: clock.toISOString() });
      const g1 = file("g1");
      await repo.putOutgoing([{ ...(await repo.outgoingOf(CONFIG, kept.clientUuid))[0], channelId: 8, localUuid: "g1", postClientUuid: lost.clientUuid, originalPath: g1.path }]);
      const orphan = await outbox.enqueue({ noteId: CHAT_NOTE, configId: CONFIG, kind: CHAT_UPLOAD, params: { channelId: 8, localUuid: "o1" }, status: "incomplete" });
      expect(await chat.recoverIncomplete()).toBe(1);
      const ops = await db.getOutboxOpsForConfig(CONFIG);
      expect(ops.map((o) => [o.kind, o.status]).sort()).toEqual([[CHAT_POST, "queued"], [CHAT_UPLOAD, "queued"]]);
      expect(ops.some((o) => o.id === orphan.id || o.id === lost.id || o.id === lostUp.id)).toBe(false);
      expect(await repo.outgoingOf(CONFIG, lost.clientUuid)).toEqual([]);
      expect(files.bytes(g1.path)).toBeUndefined();
    });

    describe("draft files", () => {
      /** A file of the conversation's composer, kept as its draft. */
      const drafted = async (uuid: string, seq = 0): Promise<OutgoingFile> => {
        const f = file(uuid);
        await repo.putDraftFile({
          configId: CONFIG, channelId: CHANNEL, messageId: null, attachmentId: null, localUuid: uuid, postClientUuid: null,
          seq, name: f.name, mimetype: f.mimetype, size: f.size, checksum: null, voice: false, thumbPath: null, thumbBytes: 0,
          originalPath: f.path, originalBytes: f.size, state: "draft", error: null, lastOpenedAt: null, createdAt: clock.toISOString(),
        });
        return f;
      };
      const statesOf = async (...uuids: string[]) =>
        Promise.all(uuids.map(async (u) => (await repo.outgoingFile(CONFIG, u))?.state ?? null));

      it("a post takes its draft files in place: same rows and files, no delete or insert", async () => {
        chatOdoo();
        const [a, b] = [await drafted("d1", 5), await drafted("d2", 6)];
        const fresh = file("n1");
        const run = vi.spyOn(db, "rawRun");
        const m = await chat.queuePost(CONFIG, CHANNEL, "with drafts", false, { files: [b, a, fresh] });
        const touching = run.mock.calls.map((c) => String(c[0])).filter((q) => q.includes("chat_attachments"));
        run.mockRestore();
        // One update per draft row, the fresh file inserted as before
        expect(touching.filter((q) => q.startsWith("UPDATE"))).toHaveLength(2);
        expect(touching.filter((q) => q.startsWith("DELETE"))).toEqual([]);
        expect(touching.filter((q) => q.startsWith("INSERT"))).toHaveLength(1);
        expect((await repo.outgoingOf(CONFIG, m.clientUuid)).map((r) => [r.localUuid, r.seq, r.state, r.originalPath])).toEqual([
          ["d2", 0, "queued", b.path], ["d1", 1, "queued", a.path], ["n1", 2, "queued", fresh.path],
        ]);
        expect(files.bytes(a.path)).toBeDefined();
        expect((await repo.draftOf(CONFIG, CHANNEL)).files).toEqual([]);
        const post = (await db.getOutboxOpsForConfig(CONFIG)).find((o) => o.kind === CHAT_POST)!;
        expect(post.params.drafts).toEqual(["d2", "d1"]);
      });

      it("a post whose message cannot be stored gives its draft files back to the draft", async () => {
        chatOdoo();
        const a = await drafted("d1");
        const fresh = file("n1");
        vi.spyOn(repo, "putPending").mockRejectedValueOnce(new Error("disk full"));
        await expect(chat.queuePost(CONFIG, CHANNEL, "x", false, { files: [a, fresh] })).rejects.toThrow("disk full");
        expect(await db.getOutboxOpsForConfig(CONFIG)).toEqual([]);
        expect(await statesOf("d1", "n1")).toEqual(["draft", null]);
        expect((await repo.outgoingFile(CONFIG, "d1"))!.postClientUuid).toBeNull();
        expect(files.bytes(a.path)).toBeDefined();
        expect(files.bytes(fresh.path)).toBeUndefined();
      });

      it("a post whose ops cannot be stored keeps its draft files", async () => {
        chatOdoo();
        const a = await drafted("d1");
        const enqueue = outbox.enqueue.bind(outbox);
        vi.spyOn(outbox, "enqueue").mockImplementation(async (op: any) => {
          if (op.kind === CHAT_POST) throw new Error("disk full");
          return enqueue(op);
        });
        await expect(chat.queuePost(CONFIG, CHANNEL, "x", false, { files: [a] })).rejects.toThrow("disk full");
        expect(await statesOf("d1")).toEqual(["draft"]);
        expect(files.bytes(a.path)).toBeDefined();
      });

      it("a kill between a post's ops and its draft files' conversion keeps them at startup, and the next send takes them", async () => {
        chatOdoo();
        const a = await drafted("d1");
        // The process dies inside the conversion: no catch runs
        const convert = vi.spyOn(repo, "queueDrafts").mockImplementation(() => new Promise(() => {}));
        void chat.queuePost(CONFIG, CHANNEL, "cut", false, { files: [a] });
        await vi.waitFor(() => expect(convert).toHaveBeenCalled());
        convert.mockRestore();
        chat = new ChatOutbox(db, rpc, outbox, repo, () => clock);
        chat.files = files;
        expect(await chat.recoverIncomplete()).toBe(0);
        expect(await db.getOutboxOpsForConfig(CONFIG)).toEqual([]);
        expect(await statesOf("d1")).toEqual(["draft"]);
        expect(files.bytes(a.path)).toBeDefined();
        expect((await repo.draftOf(CONFIG, CHANNEL)).text).toBe("cut");
        const m = await chat.queuePost(CONFIG, CHANNEL, "again", false, { files: [a] });
        expect((await repo.outgoingOf(CONFIG, m.clientUuid)).map((r) => [r.localUuid, r.state])).toEqual([["d1", "queued"]]);
      });

      it("a kill after the conversion, before the message, gives the files and the text back to the draft at startup", async () => {
        chatOdoo();
        const a = await drafted("d1");
        const store = vi.spyOn(repo, "putPending").mockImplementation(() => new Promise(() => {}));
        void chat.queuePost(CONFIG, CHANNEL, "typed before the kill", false, { files: [a] });
        await vi.waitFor(() => expect(store).toHaveBeenCalled());
        store.mockRestore();
        chat = new ChatOutbox(db, rpc, outbox, repo, () => clock);
        chat.files = files;
        expect(await chat.recoverIncomplete()).toBe(0);
        expect(await db.getOutboxOpsForConfig(CONFIG)).toEqual([]);
        const draft = await repo.draftOf(CONFIG, CHANNEL);
        expect(draft.text).toBe("typed before the kill");
        expect(draft.files.map((f) => [f.localUuid, f.state, f.postClientUuid])).toEqual([["d1", "draft", null]]);
        expect(files.bytes(a.path)).toBeDefined();
      });

      it("a post cut before its message leaves the draft text alone when it came from it, and gives back any other", async () => {
        chatOdoo();
        const cut = async (text: string, held: string, fromDraft: boolean) => {
          const a = await drafted("j" + text.length);
          await repo.putDraftText(CONFIG, CHANNEL, held);
          const store = vi.spyOn(repo, "putPending").mockImplementation(() => new Promise(() => {}));
          void chat.queuePost(CONFIG, CHANNEL, text, false, { files: [a], ...(fromDraft ? { draftText: text } : {}) });
          await vi.waitFor(() => expect(store).toHaveBeenCalled());
          store.mockRestore();
          chat = new ChatOutbox(db, rpc, outbox, repo, () => clock);
          chat.files = files;
          await chat.recoverIncomplete();
          return (await repo.draftOf(CONFIG, CHANNEL)).text;
        };
        // The draft still holds the text the composer sent: nothing to give back, nothing doubled
        expect(await cut("sent from the composer", "sent from the composer", true)).toBe("sent from the composer");
        expect(await cut("sent once", "sent once  ", true)).toBe("sent once  ");
        // A text that was never the draft's goes back ahead of what the draft holds
        expect(await cut("sent before", "typed after", false)).toBe("sent before\ntyped after");
      });

      it("a post from the draft removes exactly its text from the draft once its message is stored", async () => {
        chatOdoo();
        await repo.putDraftText(CONFIG, CHANNEL, "hello");
        vi.spyOn(repo, "putPending").mockRejectedValueOnce(new Error("disk full"));
        await expect(chat.queuePost(CONFIG, CHANNEL, "hello", false, { draftText: "hello" })).rejects.toThrow("disk full");
        expect((await repo.draftOf(CONFIG, CHANNEL)).text).toBe("hello");
        const m = await chat.queuePost(CONFIG, CHANNEL, "hello", false, { draftText: "hello" });
        expect((await repo.draftOf(CONFIG, CHANNEL)).text).toBe("");
        expect((await db.getOutboxOpsForConfig(CONFIG)).find((o) => o.clientUuid === m.clientUuid)!.params.draftText).toBe("hello");
        // A draft that is no longer that text, or a post that did not come from it, leaves the draft
        await repo.putDraftText(CONFIG, CHANNEL, "hello world");
        await chat.queuePost(CONFIG, CHANNEL, "hello", false, { draftText: "hello" });
        await chat.queuePost(CONFIG, CHANNEL, "hello world", false);
        expect((await repo.draftOf(CONFIG, CHANNEL)).text).toBe("hello world");
        // A conversation that cannot take a post keeps the text in the failed bubble, not in the draft
        await repo.patchChannel(CONFIG, CHANNEL, { createFailed: true });
        await chat.queuePost(CONFIG, CHANNEL, "hello world", false, { draftText: "hello world" });
        expect((await repo.draftOf(CONFIG, CHANNEL)).text).toBe("");
      });

      it("a draft text that cannot be removed is logged and never cancels the post", async () => {
        chatOdoo();
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        await repo.putDraftText(CONFIG, CHANNEL, "hello");
        vi.spyOn(repo, "removeDraftText").mockRejectedValueOnce(new Error("disk full"));
        const m = await chat.queuePost(CONFIG, CHANNEL, "hello", false, { draftText: "hello" });
        expect(m.status).toBe("pending");
        expect((await db.getOutboxOpsForConfig(CONFIG)).map((o) => [o.clientUuid, o.status])).toEqual([[m.clientUuid, "queued"]]);
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
      });

      it("a kill after the message is stored, before the draft text is removed, is finished at startup", async () => {
        chatOdoo();
        // A text-only post, then one with a draft file
        for (const picked of [[], [await drafted("k1")]]) {
          await repo.putDraftText(CONFIG, CHANNEL, "almost sent");
          const remove = vi.spyOn(repo, "removeDraftText").mockImplementation(() => new Promise(() => {}));
          void chat.queuePost(CONFIG, CHANNEL, "almost sent", false, { files: picked, draftText: "almost sent" });
          await vi.waitFor(() => expect(remove).toHaveBeenCalled());
          remove.mockRestore();
          chat = new ChatOutbox(db, rpc, outbox, repo, () => clock);
          chat.files = files;
          await chat.recoverIncomplete();
          expect((await repo.draftOf(CONFIG, CHANNEL)).text).toBe("");
          // The post itself still goes
          expect((await repo.pendingMessages(CONFIG)).get(CHANNEL)!.at(-1)!.body).toBe("almost sent");
        }
      });

      it("startup takes the reply target out of the draft with the text a kill left", async () => {
        chatOdoo();
        await repo.putDraftText(CONFIG, CHANNEL, "the answer");
        await repo.putDraftReply(CONFIG, CHANNEL, { messageId: 51, clientUuid: null });
        await outbox.enqueue({
          noteId: CHAT_NOTE, configId: CONFIG, kind: CHAT_POST,
          params: {
            channelId: CHANNEL, text: "the answer", useModule: false, draftText: "the answer",
            parent: { messageId: 51, clientUuid: null },
          },
        });
        await chat.recoverIncomplete();
        expect(await repo.draftOf(CONFIG, CHANNEL)).toMatchObject({ text: "", replyTo: null });
      });

      it("startup leaves a draft text typed again after its post was queued", async () => {
        chatOdoo();
        await repo.putDraftText(CONFIG, CHANNEL, "ok");
        await chat.queuePost(CONFIG, CHANNEL, "ok", false, { draftText: "ok" });
        expect((await repo.draftOf(CONFIG, CHANNEL)).text).toBe("");
        // Offline: the post waits; the same text is typed again later
        advance(60_000);
        await repo.putDraftText(CONFIG, CHANNEL, "ok");
        chat = new ChatOutbox(db, rpc, outbox, repo, () => clock);
        await chat.recoverIncomplete();
        expect((await repo.draftOf(CONFIG, CHANNEL)).text).toBe("ok");
      });

      it("startup releases the draft text of a text-only post that will be sent though its message was never stored", async () => {
        chatOdoo();
        await repo.putDraftText(CONFIG, CHANNEL, "cut before its bubble");
        await outbox.enqueue({
          noteId: CHAT_NOTE, configId: CONFIG, kind: CHAT_POST,
          params: { channelId: CHANNEL, text: "cut before its bubble", useModule: false, draftText: "cut before its bubble" },
        });
        await chat.recoverIncomplete();
        expect((await repo.draftOf(CONFIG, CHANNEL)).text).toBe("");
      });

      it("a conversation that cannot take a post keeps the draft files refused beside the failed text", async () => {
        chatOdoo();
        const a = await drafted("d1");
        await repo.patchChannel(CONFIG, CHANNEL, { createFailed: true });
        const m = await chat.queuePost(CONFIG, CHANNEL, "x", false, { files: [a] });
        expect((await repo.outgoingOf(CONFIG, m.clientUuid)).map((r) => [r.localUuid, r.state, r.error])).toEqual([["d1", "refused", "channel"]]);
        expect((await repo.draftOf(CONFIG, CHANNEL)).files).toEqual([]);
      });
    });
  });

  it("posts of different channels do not wait for each other", async () => {
    chatOdoo({ module: true });
    await chat.queuePost(CONFIG, CHANNEL, "a", true);
    await chat.queuePost(CONFIG, 8, "b", true);
    const ops = await db.getOutboxOpsForConfig(CONFIG);
    expect(ops.map((o) => o.dependsOn)).toEqual([null, null]);
  });

  it("reads coalesce to the highest message id", async () => {
    const odoo = chatOdoo();
    await chat.queueRead(CONFIG, CHANNEL, 50, false);
    await chat.queueRead(CONFIG, CHANNEL, 60, false);
    await chat.queueRead(CONFIG, CHANNEL, 55, false);
    advance(1);
    await chat.queueRead(CONFIG, 9, 5, false);
    const ops = (await db.getOutboxOpsForConfig(CONFIG)).filter((o) => o.kind === CHAT_READ);
    expect(ops).toHaveLength(2);
    expect(ops.find((o) => o.params.channelId === CHANNEL)!.params).toMatchObject({ lastMessageId: 60, mentions: false });

    await chat.flush(CREDS);
    const reads = odoo.calls.filter((c) => c.path === "/discuss/channel/mark_as_read");
    expect(reads.map((c) => c.params)).toEqual([
      { channel_id: CHANNEL, last_message_id: 60 },
      { channel_id: 9, last_message_id: 5 },
    ]);
    expect(await db.getOutboxOpsForConfig(CONFIG)).toHaveLength(0);
  });

  it("read with mentions also calls mark_all_as_read", async () => {
    const odoo = chatOdoo();
    await chat.queueRead(CONFIG, CHANNEL, 50, false);
    await chat.queueRead(CONFIG, CHANNEL, 40, true);
    await chat.flush(CREDS);
    const done = odoo.calls.find((c) => c.params.method === "mark_all_as_read")!;
    expect(done.params.model).toBe("mail.message");
    expect(done.params.args).toEqual([[["model", "=", "discuss.channel"], ["res_id", "=", CHANNEL]]]);
    expect(odoo.calls.find((c) => c.path === "/discuss/channel/mark_as_read")!.params.last_message_id).toBe(50);
  });

  it("a read without mentions does not call mark_all_as_read", async () => {
    const odoo = chatOdoo();
    await chat.queueRead(CONFIG, CHANNEL, 50, false);
    await chat.flush(CREDS);
    expect(odoo.calls.some((c) => c.params.method === "mark_all_as_read")).toBe(false);
  });

  it("a read raised while the same read is running is sent after it", async () => {
    const odoo = chatOdoo();
    await chat.queueRead(CONFIG, CHANNEL, 50, false);
    const [op] = await db.getOutboxOpsForConfig(CONFIG);
    await db.updateOutboxOp(op.id, { status: "running", updatedAt: clock.toISOString() });
    await chat.queueRead(CONFIG, CHANNEL, 70, false);
    const ops = await db.getOutboxOpsForConfig(CONFIG);
    expect(ops).toHaveLength(2);
    expect(ops.find((o) => o.id === op.id)!.params.lastMessageId).toBe(50);
    expect(ops.find((o) => o.id !== op.id)!.params.lastMessageId).toBe(70);
    expect(odoo.calls).toHaveLength(0);
  });

  it("a read that starts during the write queues a follow-up behind it", async () => {
    chatOdoo();
    await chat.queueRead(CONFIG, CHANNEL, 50, false);
    const real = outbox.setParams.bind(outbox);
    vi.spyOn(outbox, "setParams").mockImplementationOnce(async (id, v) => {
      await db.updateOutboxOp(id, { status: "running", updatedAt: clock.toISOString() });
      await real(id, v);
    });
    await chat.queueRead(CONFIG, CHANNEL, 70, true);
    const ops = await db.getOutboxOpsForConfig(CONFIG);
    expect(ops).toHaveLength(2);
    const follow = ops.find((o) => o.status !== "running")!;
    expect(follow.dependsOn).toBe(ops.find((o) => o.status === "running")!.id);
    expect(follow.params).toMatchObject({ lastMessageId: 70, mentions: true });
  });

  it("drain ignores chat rows of a removed application", async () => {
    const odoo = chatOdoo({ module: true });
    await repo.applyDelta(GONE_CONFIG, {
      channels: [{ channelId: CHANNEL, channelType: "group", name: "Team", isMember: true }],
      deletedChannelIds: [], members: [], deletedMemberIds: [], messages: [], attachments: [], deletedAttachmentIds: [], partners: [], inboxCounter: null, selfPartnerId: null,
    });
    await chat.queuePost(GONE_CONFIG, CHANNEL, "orphan", true);
    await chat.queueRead(GONE_CONFIG, CHANNEL, 5, true);
    await expect(chat.flush(GONE)).resolves.toMatchObject({ done: 0, failed: 0, blocked: 0 });
    expect(odoo.calls).toHaveLength(0);
    expect(await db.getOutboxOpsForConfig(GONE_CONFIG)).toHaveLength(2);
  });

  describe("pinned messages", () => {
    const SENT = { messageId: 40, clientUuid: null };
    const pinnedAt = async () => (await repo.message(CONFIG, 40))?.pinnedAt ?? null;
    const pinOps = async () => (await db.getOutboxOpsForConfig(CONFIG)).filter((o) => o.kind === CHAT_PIN);

    beforeEach(async () => {
      await repo.applyDelta(CONFIG, {
        channels: [], deletedChannelIds: [], members: [], deletedMemberIds: [], attachments: [], deletedAttachmentIds: [],
        partners: [], inboxCounter: null, selfPartnerId: null,
        messages: [{ messageId: 40, channelId: CHANNEL, body: "<p>Réunion demain</p>", authorPartnerId: 9, messageType: "comment" }],
      });
    });

    it("a pin sends set_message_pin with pinned true", async () => {
      const odoo = chatOdoo();
      const op = await chat.queuePin(CONFIG, CHANNEL, SENT, true);
      expect(op).toMatchObject({ kind: CHAT_PIN, params: { channelId: CHANNEL, messageId: 40, clientUuid: null, pinned: true, base: false } });
      // Shown at once
      expect(await pinnedAt()).toBe("2026-10-25 10:00:00");
      expect(await chat.flush(CREDS)).toMatchObject({ done: 1, failed: 0, blocked: 0 });
      expect(odoo.pins()).toEqual([{ model: "discuss.channel", method: "set_message_pin", args: [[CHANNEL]], kwargs: { message_id: 40, pinned: true } }]);
      expect(await pinOps()).toEqual([]);
      expect(await pinnedAt()).toBe("2026-10-25 10:00:00");
      // A message not sent yet takes no pin
      const pending = await chat.queuePost(CONFIG, CHANNEL, "pas encore", true);
      await expect(chat.queuePin(CONFIG, CHANNEL, { messageId: null, clientUuid: pending.clientUuid }, true)).rejects.toThrow();
    });

    it("pin then unpin offline sends nothing", async () => {
      const odoo = chatOdoo();
      chat.isOnline = async () => false;
      await chat.queuePin(CONFIG, CHANNEL, SENT, true);
      expect(await pinnedAt()).not.toBeNull();
      expect(await chat.queuePin(CONFIG, CHANNEL, SENT, false)).toBeNull();
      expect(await pinnedAt()).toBeNull();
      expect(await pinOps()).toEqual([]);
      chat.isOnline = async () => true;
      await chat.flush(CREDS, { force: true });
      expect(odoo.pins()).toEqual([]);
    });

    it("a dropped pin answer resends the same target", async () => {
      const odoo = chatOdoo();
      odoo.state.pinDrops = 1;
      await chat.queuePin(CONFIG, CHANNEL, SENT, true);
      expect(await chat.flush(CREDS)).toMatchObject({ failed: 1 });
      expect((await pinOps()).map((o) => [o.status, !!o.params.sentAt])).toEqual([["failed", true]]);
      expect(await chat.flush(CREDS, { force: true })).toMatchObject({ done: 1 });
      expect(odoo.pins().map((p) => p.kwargs)).toEqual([{ message_id: 40, pinned: true }, { message_id: 40, pinned: true }]);
      expect(await pinOps()).toEqual([]);
      // After another lost answer, a tap back is still sent: the server may hold the pin
      odoo.state.pinDrops = 1;
      await chat.queuePin(CONFIG, CHANNEL, SENT, false);
      await chat.flush(CREDS);
      expect(await chat.queuePin(CONFIG, CHANNEL, SENT, true)).not.toBeNull();
      await chat.flush(CREDS, { force: true });
      expect(odoo.pins().map((p) => p.kwargs.pinned)).toEqual([true, true, false, true]);
    });

    it("a pin on a message deleted meanwhile gives the vanished notice and the base back", async () => {
      const odoo = chatOdoo();
      chat.isOnline = async () => false;
      await chat.queuePin(CONFIG, CHANNEL, SENT, true);
      expect(await pinnedAt()).not.toBeNull();
      // Deleted in Discuss: the bus empties its body
      await repo.applyDelta(CONFIG, {
        channels: [], deletedChannelIds: [], members: [], deletedMemberIds: [], attachments: [], deletedAttachmentIds: [],
        partners: [], inboxCounter: null, selfPartnerId: null, messages: [{ messageId: 40, body: "" }],
      });
      chat.isOnline = async () => true;
      expect(await chat.flush(CREDS, { force: true })).toMatchObject({ blocked: 1 });
      expect(odoo.pins()).toEqual([]);
      expect(await pinnedAt()).toBeNull();
      expect(await chat.notices([CONFIG])).toEqual([
        expect.objectContaining({ kind: CHAT_PIN, reason: "vanished", message: { messageId: 40, clientUuid: null } }),
      ]);
    });

    it("a delete over a waiting pin shows the pin's base again, and a refused delete leaves it there", async () => {
      const odoo = chatOdoo();
      const BASE_AT = "2026-10-24 08:00:00";
      chat.isOnline = async () => false;
      // Not pinned on the server: pinned on the phone, then deleted
      await chat.queuePin(CONFIG, CHANNEL, SENT, true);
      expect(await pinnedAt()).not.toBeNull();
      await chat.queueDelete(CONFIG, CHANNEL, SENT);
      expect(await pinOps()).toEqual([]);
      expect(await pinnedAt()).toBeNull();
      odoo.state.editError = "odoo.exceptions.AccessError";
      chat.isOnline = async () => true;
      expect(await chat.flush(CREDS, { force: true })).toMatchObject({ blocked: 1 });
      expect((await repo.message(CONFIG, 40))?.body).toBe("<p>Réunion demain</p>");
      expect(await pinnedAt()).toBeNull();
      expect(odoo.pins()).toEqual([]);
      for (const n of await chat.notices([CONFIG])) await chat.dismissNotice(CONFIG, n.id);
      // Pinned on the server: unpinned on the phone, then deleted: back at its own pin date
      await repo.applyDelta(CONFIG, {
        channels: [], deletedChannelIds: [], members: [], deletedMemberIds: [], attachments: [], deletedAttachmentIds: [],
        partners: [], inboxCounter: null, selfPartnerId: null, messages: [{ messageId: 40, pinnedAt: BASE_AT }],
      });
      chat.isOnline = async () => false;
      await chat.queuePin(CONFIG, CHANNEL, SENT, false);
      expect(await pinnedAt()).toBeNull();
      await chat.queueDelete(CONFIG, CHANNEL, SENT);
      expect(await pinnedAt()).toBe(BASE_AT);
      chat.isOnline = async () => true;
      expect(await chat.flush(CREDS, { force: true })).toMatchObject({ blocked: 1 });
      expect(await pinnedAt()).toBe(BASE_AT);
    });

    it("a delete over a pin whose answer was lost keeps the pin shown", async () => {
      const odoo = chatOdoo();
      odoo.state.pinDrops = 1;
      await chat.queuePin(CONFIG, CHANNEL, SENT, true);
      await chat.flush(CREDS);
      const shown = await pinnedAt();
      expect(shown).not.toBeNull();
      // The server may hold the pin: its base is no longer where the server stands
      chat.isOnline = async () => false;
      await chat.queueDelete(CONFIG, CHANNEL, SENT);
      expect(await pinnedAt()).toBe(shown);
    });

    it("an unpin given up shows the pin again at its own date", async () => {
      const odoo = chatOdoo();
      const BASE_AT = "2026-10-24 08:00:00";
      await repo.applyDelta(CONFIG, {
        channels: [], deletedChannelIds: [], members: [], deletedMemberIds: [], attachments: [], deletedAttachmentIds: [],
        partners: [], inboxCounter: null, selfPartnerId: null, messages: [{ messageId: 40, pinnedAt: BASE_AT }],
      });
      odoo.state.pinError = "odoo.exceptions.AccessError";
      await chat.queuePin(CONFIG, CHANNEL, SENT, false);
      expect(await chat.flush(CREDS)).toMatchObject({ blocked: 1 });
      expect(odoo.pins().map((p) => p.kwargs)).toEqual([{ message_id: 40, pinned: false }]);
      expect(await pinnedAt()).toBe(BASE_AT);
      expect(await chat.notices([CONFIG])).toEqual([expect.objectContaining({ kind: CHAT_PIN, reason: "refused" })]);
    });

    it("a server pinned_at read while a pin waits does not undo it, and becomes its base", async () => {
      chatOdoo();
      const SERVER_AT = "2026-10-24 08:00:00";
      const busDelta = (at: string | null) => ({
        channels: [], deletedChannelIds: [], members: [], deletedMemberIds: [], attachments: [], deletedAttachmentIds: [],
        partners: [], inboxCounter: null, selfPartnerId: null, messages: [{ messageId: 40, pinnedAt: at }],
      });
      chat.isOnline = async () => false;
      await chat.queuePin(CONFIG, CHANNEL, SENT, true);
      const shown = await pinnedAt();
      // An older read says not pinned: the phone's pin stays
      let delta: any = busDelta(null);
      await chat.overlayMessages(CONFIG, delta);
      await repo.applyDelta(CONFIG, delta);
      expect(await pinnedAt()).toBe(shown);
      // Pinned in the browser meanwhile: the server's date shows, and the pin's base follows it
      delta = busDelta(SERVER_AT);
      await chat.overlayMessages(CONFIG, delta);
      await repo.applyDelta(CONFIG, delta);
      expect(await pinnedAt()).toBe(SERVER_AT);
      expect((await pinOps()).map((o) => [o.params.base, o.params.baseAt])).toEqual([[true, SERVER_AT]]);
      // An unpin is then laid over the server's pin, and a tap back to pinned is where the server stands: nothing queued
      await chat.queuePin(CONFIG, CHANNEL, SENT, false);
      delta = busDelta(SERVER_AT);
      await chat.overlayMessages(CONFIG, delta);
      await repo.applyDelta(CONFIG, delta);
      expect(await pinnedAt()).toBeNull();
      expect(await chat.queuePin(CONFIG, CHANNEL, SENT, true)).toBeNull();
      expect(await pinOps()).toEqual([]);
    });
  });

  describe("starred messages", () => {
    const SENT = { messageId: 40, clientUuid: null };
    const flagged = async () => (await repo.message(CONFIG, 40))?.starred ?? false;
    const counter = async () => (await repo.sourceState(CONFIG)).starredCounter;
    const starOps = async () => (await db.getOutboxOpsForConfig(CONFIG)).filter((o) => o.kind === CHAT_STAR);
    const delta = (p: Record<string, any>) => ({
      channels: [], deletedChannelIds: [], members: [], deletedMemberIds: [], attachments: [], deletedAttachmentIds: [],
      partners: [], inboxCounter: null, selfPartnerId: null, messages: [], ...p,
    });

    beforeEach(async () => {
      await repo.applyDelta(CONFIG, delta({
        messages: [{ messageId: 40, channelId: CHANNEL, body: "<p>Réunion demain</p>", authorPartnerId: 9, messageType: "comment", starred: false }],
      }));
      await repo.setSourceState({ configId: CONFIG, starredCounter: 2 });
    });

    it("with the module the star sends erplibre_set_starred", async () => {
      const odoo = chatOdoo({ module: true });
      chat.starIdempotent = async () => true;
      const op = await chat.queueStar(CONFIG, 40, true, CHANNEL);
      expect(op).toMatchObject({ kind: CHAT_STAR, params: { messageId: 40, starred: true, base: false, channelId: CHANNEL } });
      // Shown at once, in the thread, the starred box and the counter
      expect(await flagged()).toBe(true);
      expect(await counter()).toBe(3);
      expect(await repo.mailboxItem(CONFIG, 40)).toMatchObject({ threadModel: "discuss.channel", threadId: CHANNEL, starred: true });
      expect(await chat.flush(CREDS)).toMatchObject({ done: 1, failed: 0, blocked: 0 });
      expect(odoo.stars()).toEqual([{ model: "mail.message", method: "erplibre_set_starred", args: [[40], true], kwargs: {} }]);
      expect(odoo.starReads()).toEqual([]);
      expect(await starOps()).toEqual([]);
      expect(await counter()).toBe(3);
      // A lost answer: the same set goes again, idempotent
      odoo.state.starDrops = 1;
      await chat.queueStar(CONFIG, 40, false, CHANNEL);
      expect(await chat.flush(CREDS)).toMatchObject({ failed: 1 });
      expect(await chat.flush(CREDS, { force: true })).toMatchObject({ done: 1 });
      expect(odoo.stars().map((c) => c.args)).toEqual([[[40], true], [[40], false], [[40], false]]);
      expect(odoo.state.starred.has(40)).toBe(false);
      expect(await flagged()).toBe(false);
      expect(await counter()).toBe(2);
    });

    it("a module that answers as missing is probed again and the star retried with a re-read", async () => {
      const odoo = chatOdoo();
      let idempotent = true;
      chat.starIdempotent = async () => idempotent;
      chat.moduleRefused = vi.fn(async () => { idempotent = false; });
      await chat.queueStar(CONFIG, 40, true, CHANNEL);
      expect(await chat.flush(CREDS)).toMatchObject({ failed: 1, blocked: 0 });
      expect(chat.moduleRefused).toHaveBeenCalledWith(CONFIG);
      expect(await chat.flush(CREDS, { force: true })).toMatchObject({ done: 1 });
      expect(odoo.stars().map((c) => c.method)).toEqual(["erplibre_set_starred", "toggle_message_starred"]);
      expect(odoo.starReads()).toEqual([40]);
      expect(odoo.state.starred.has(40)).toBe(true);
    });

    it("without the module a stale base re-reads before toggling", async () => {
      const odoo = chatOdoo();
      // Starred in the browser since the phone last read it: the phone still shows it unstarred
      odoo.state.starred.add(40);
      await chat.queueStar(CONFIG, 40, true, CHANNEL);
      expect(await chat.flush(CREDS)).toMatchObject({ done: 1 });
      expect(odoo.starReads()).toEqual([40]);
      expect(odoo.stars()).toEqual([]);
      expect(odoo.state.starred.has(40)).toBe(true);
      // Where the server differs from the target, one toggle
      await chat.queueStar(CONFIG, 40, false, CHANNEL);
      expect(await chat.flush(CREDS)).toMatchObject({ done: 1 });
      expect(odoo.starReads()).toEqual([40, 40]);
      expect(odoo.stars()).toEqual([{ model: "mail.message", method: "toggle_message_starred", args: [[40]], kwargs: {} }]);
      expect(odoo.state.starred.has(40)).toBe(false);
      expect(await flagged()).toBe(false);
    });

    it("a replayed star after a lost answer sends no second toggle", async () => {
      const odoo = chatOdoo();
      odoo.state.starDrops = 1;
      await chat.queueStar(CONFIG, 40, true, CHANNEL);
      expect(await chat.flush(CREDS)).toMatchObject({ failed: 1 });
      expect((await starOps()).map((o) => [o.status, !!o.params.sentAt])).toEqual([["failed", true]]);
      expect(await chat.flush(CREDS, { force: true })).toMatchObject({ done: 1 });
      // The retry read the server first: starred already, nothing toggled back
      expect(odoo.starReads()).toEqual([40, 40]);
      expect(odoo.stars().map((c) => c.method)).toEqual(["toggle_message_starred"]);
      expect(odoo.state.starred.has(40)).toBe(true);
      // Three taps offline, then sent with the answer lost: the server ends on the last one
      chat.isOnline = async () => false;
      await chat.queueStar(CONFIG, 40, false, CHANNEL);
      expect(await chat.queueStar(CONFIG, 40, true, CHANNEL)).toBeNull();
      await chat.queueStar(CONFIG, 40, false, CHANNEL);
      chat.isOnline = async () => true;
      odoo.state.starDrops = 1;
      expect(await chat.flush(CREDS, { force: true })).toMatchObject({ failed: 1 });
      expect(await chat.flush(CREDS, { force: true })).toMatchObject({ done: 1 });
      expect(odoo.stars().map((c) => c.method)).toEqual(["toggle_message_starred", "toggle_message_starred"]);
      expect(odoo.state.starred.has(40)).toBe(false);
      expect(await flagged()).toBe(false);
      expect(await counter()).toBe(2);
    });

    it("star then unstar offline sends nothing", async () => {
      const odoo = chatOdoo();
      chat.isOnline = async () => false;
      await chat.queueStar(CONFIG, 40, true, CHANNEL);
      expect(await counter()).toBe(3);
      expect(await chat.queueStar(CONFIG, 40, false, CHANNEL)).toBeNull();
      expect(await flagged()).toBe(false);
      expect(await counter()).toBe(2);
      expect(await starOps()).toEqual([]);
      chat.isOnline = async () => true;
      await chat.flush(CREDS, { force: true });
      expect(odoo.stars()).toEqual([]);
      expect(odoo.starReads()).toEqual([]);
      // A message the phone does not hold takes no star
      await expect(chat.queueStar(CONFIG, 41, true, CHANNEL)).rejects.toThrow();
    });

    it("a refused star gives its base back with a notice, and a message gone drops it", async () => {
      const odoo = chatOdoo();
      odoo.state.starError = "odoo.exceptions.AccessError";
      await chat.queueStar(CONFIG, 40, true, CHANNEL);
      expect(await chat.flush(CREDS)).toMatchObject({ blocked: 1 });
      expect(await flagged()).toBe(false);
      expect(await counter()).toBe(2);
      expect(await chat.notices([CONFIG])).toEqual([
        expect.objectContaining({ kind: CHAT_STAR, reason: "refused", channelId: CHANNEL, message: SENT }),
      ]);
      for (const n of await chat.notices([CONFIG])) await chat.dismissNotice(CONFIG, n.id);
      odoo.state.starError = null;
      odoo.state.gone.add(40);
      await chat.queueStar(CONFIG, 40, true, CHANNEL);
      expect(await chat.flush(CREDS)).toMatchObject({ blocked: 1 });
      // Only the refused toggle went: the re-read found no message
      expect(odoo.stars()).toHaveLength(1);
      expect(await flagged()).toBe(false);
      expect(await counter()).toBe(2);
      expect(await chat.notices([CONFIG])).toEqual([expect.objectContaining({ kind: CHAT_STAR, reason: "vanished" })]);
    });

    it("a delete over a waiting star shows its base again, as Odoo's delete unstars", async () => {
      const odoo = chatOdoo();
      chat.isOnline = async () => false;
      await chat.queueStar(CONFIG, 40, true, CHANNEL);
      await chat.queueDelete(CONFIG, CHANNEL, SENT);
      expect(await starOps()).toEqual([]);
      expect(await flagged()).toBe(false);
      expect(await counter()).toBe(2);
      expect((await repo.mailboxItem(CONFIG, 40))?.starred).toBe(false);
      chat.isOnline = async () => true;
      expect(await chat.flush(CREDS, { force: true })).toMatchObject({ done: 1 });
      expect(odoo.stars()).toEqual([]);
      // A star whose answer was lost may be on the server: a delete over it keeps it shown
      await repo.applyDelta(CONFIG, delta({ messages: [{ messageId: 40, body: "<p>Réunion demain</p>" }] }));
      odoo.state.starDrops = 1;
      await chat.queueStar(CONFIG, 40, true, CHANNEL);
      await chat.flush(CREDS);
      chat.isOnline = async () => false;
      await chat.queueDelete(CONFIG, CHANNEL, SENT);
      expect(await flagged()).toBe(true);
    });

    it("a server flag read while a star waits does not undo it, and becomes its base", async () => {
      chatOdoo();
      chat.isOnline = async () => false;
      await chat.queueStar(CONFIG, 40, true, CHANNEL);
      // An older read says unstarred, with the server's counter: the phone's star stays and stays counted
      let d: any = delta({ messages: [{ messageId: 40, starred: false }], starredCounter: 2 });
      await chat.overlayMessages(CONFIG, d);
      await repo.applyDelta(CONFIG, d);
      expect(await flagged()).toBe(true);
      expect(await counter()).toBe(3);
      // Starred in the browser meanwhile: the base follows the server, which the counter already holds
      d = delta({ messages: [{ messageId: 40, starred: true }], starredCounter: 3 });
      await chat.overlayMessages(CONFIG, d);
      await repo.applyDelta(CONFIG, d);
      expect((await starOps()).map((o) => o.params.base)).toEqual([true]);
      expect(await counter()).toBe(3);
      // A tap to unstar is then laid over the server's star, and a tap back is where the server stands
      await chat.queueStar(CONFIG, 40, false, CHANNEL);
      expect(await flagged()).toBe(false);
      expect(await chat.queueStar(CONFIG, 40, true, CHANNEL)).toBeNull();
      expect(await starOps()).toEqual([]);
    });
  });

  describe("inbox", () => {
    const counter = async () => (await repo.sourceState(CONFIG)).inboxCounter;
    const mentions = async () => (await repo.channel(CONFIG, CHANNEL))!.needactionCounter;
    const inboxOps = async () => (await db.getOutboxOpsForConfig(CONFIG))
      .filter((o) => o.kind === CHAT_INBOX_DONE || o.kind === CHAT_INBOX_ALL);
    const sent = (odoo: ReturnType<typeof chatOdoo>, method: string) => odoo.calls
      .filter((c) => c.path === "/web/dataset/call_kw" && c.params.method === method).map((c) => c.params.args);
    const item = (messageId: number, p: Record<string, any> = {}) => ({
      messageId, threadModel: "res.partner", threadId: 70, recordName: "Tâche démo", body: `<p>r${messageId}</p>`,
      messageType: "comment", needaction: true, ...p,
    });

    beforeEach(async () => {
      await repo.applyDelta(CONFIG, {
        channels: [], deletedChannelIds: [], members: [], deletedMemberIds: [], messages: [], attachments: [], deletedAttachmentIds: [],
        partners: [], inboxCounter: 3, selfPartnerId: null,
        mailbox: [item(41), item(42), item(43, { threadModel: "discuss.channel", threadId: CHANNEL, recordName: "Team" })],
      });
      await repo.patchChannel(CONFIG, CHANNEL, { needactionCounter: 1 });
    });

    it("an item done offline is sent once online with set_message_done", async () => {
      const odoo = chatOdoo();
      chat.isOnline = async () => false;
      const op = await chat.queueInboxDone(CONFIG, [43]);
      expect(op).toMatchObject({ kind: CHAT_INBOX_DONE, params: { messageIds: [43], cleared: [43] } });
      // Shown at once: the item in the history, the inbox and its conversation's mentions one lower
      expect(await repo.mailboxItem(CONFIG, 43)).toMatchObject({ needaction: false, history: true });
      expect(await counter()).toBe(2);
      expect(await mentions()).toBe(0);
      await chat.flush(CREDS);
      expect(sent(odoo, "set_message_done")).toEqual([]);
      chat.isOnline = async () => true;
      await chat.flush(CREDS, { force: true });
      expect(sent(odoo, "set_message_done")).toEqual([[[43]]]);
      expect(await inboxOps()).toEqual([]);
      await chat.flush(CREDS, { force: true });
      expect(sent(odoo, "set_message_done")).toHaveLength(1);
      expect(await counter()).toBe(2);
    });

    it("two items done offline go in one call", async () => {
      const odoo = chatOdoo();
      chat.isOnline = async () => false;
      await chat.queueInboxDone(CONFIG, [41]);
      await chat.queueInboxDone(CONFIG, [42, 41]);
      const ops = await inboxOps();
      expect(ops).toHaveLength(1);
      expect(ops[0].params).toMatchObject({ messageIds: [41, 42], cleared: [41, 42] });
      // A record's message is no mention: its conversation's count is the channel's alone
      expect(await counter()).toBe(1);
      expect(await mentions()).toBe(1);
      chat.isOnline = async () => true;
      await chat.flush(CREDS, { force: true });
      expect(sent(odoo, "set_message_done")).toEqual([[[41, 42]]]);
    });

    it("mark all sends the bound it was queued with, the larger after a second tap", async () => {
      const odoo = chatOdoo();
      chat.isOnline = async () => false;
      await chat.queueInboxAll(CONFIG, 42);
      expect((await repo.mailboxItems(CONFIG, "inbox")).map((i) => i.messageId)).toEqual([43]);
      expect(await counter()).toBe(1);
      await chat.queueInboxAll(CONFIG, 41);
      expect((await inboxOps())[0].params).toMatchObject({ maxId: 42, cleared: [41, 42] });
      chat.isOnline = async () => true;
      await chat.flush(CREDS, { force: true });
      expect(sent(odoo, "mark_all_as_read")).toEqual([[[["needaction", "=", true], ["id", "<=", 42]]]]);
      expect(await inboxOps()).toEqual([]);
    });

    it("a refused or vanished inbox op puts its rows back in the inbox and the counts", async () => {
      chatOdoo();
      const callKw = rpc.callKw.bind(rpc);
      let failing: { method: string; error: string } | null = { method: "set_message_done", error: "odoo.exceptions.AccessError" };
      vi.spyOn(rpc, "callKw").mockImplementation(async (creds, model, method, ...rest) => {
        if (failing && method === failing.method) throw new OdooRpcError("no", failing.error);
        return callKw(creds, model, method, ...rest);
      });
      const inbox = async () => (await repo.mailboxItems(CONFIG, "inbox")).map((i) => i.messageId).sort();
      chat.isOnline = async () => false;
      await chat.queueInboxDone(CONFIG, [43, 41]);
      expect(await counter()).toBe(1);
      expect(await mentions()).toBe(0);
      chat.isOnline = async () => true;
      expect(await chat.flush(CREDS, { force: true })).toMatchObject({ blocked: 1 });
      // As the server still holds them: in the inbox, counted, the conversation's mention back
      expect(await inbox()).toEqual([41, 42, 43]);
      expect(await repo.mailboxItem(CONFIG, 43)).toMatchObject({ needaction: true, history: false });
      expect(await counter()).toBe(3);
      expect(await mentions()).toBe(1);
      expect(await chat.notices([CONFIG])).toEqual([expect.objectContaining({ kind: CHAT_INBOX_DONE, reason: "refused" })]);
      for (const n of await chat.notices([CONFIG])) await chat.dismissNotice(CONFIG, n.id);
      // A mark all gone: its rows come back, but one a waiting done covers stays done, counted by that done
      failing = { method: "mark_all_as_read", error: "odoo.exceptions.MissingError" };
      chat.isOnline = async () => false;
      await chat.queueInboxAll(CONFIG, 42);
      await chat.queueInboxDone(CONFIG, [41]);
      expect(await inbox()).toEqual([43]);
      expect(await counter()).toBe(1);
      chat.isOnline = async () => true;
      expect(await chat.flush(CREDS, { force: true })).toMatchObject({ blocked: 1 });
      expect(await inbox()).toEqual([42, 43]);
      expect(await counter()).toBe(2);
      expect(await chat.notices([CONFIG])).toEqual([expect.objectContaining({ kind: CHAT_INBOX_ALL, reason: "vanished" })]);
    });

    it("a load laid over by a waiting done keeps the item done and the counters lowered", async () => {
      chat.isOnline = async () => false;
      await chat.queueInboxDone(CONFIG, [43]);
      const delta: any = {
        channels: [{ channelId: CHANNEL, needactionCounter: 1 }], deletedChannelIds: [], members: [], deletedMemberIds: [],
        messages: [], attachments: [], deletedAttachmentIds: [], partners: [], inboxCounter: 3, selfPartnerId: null,
        mailbox: [item(43, { threadModel: "discuss.channel", threadId: CHANNEL })],
      };
      await chat.overlayPending(CONFIG, delta);
      expect(delta.inboxCounter).toBe(2);
      expect(delta.channels[0].needactionCounter).toBe(0);
      expect(delta.mailbox[0]).toMatchObject({ needaction: false, history: true });
      // Done on the server meanwhile (another device): the server's count already leaves it out
      await chat.forgetCleared(CONFIG, (id) => id === 43);
      const again: any = { ...delta, channels: [{ channelId: CHANNEL, needactionCounter: 0 }], inboxCounter: 2, mailbox: [] };
      await chat.overlayPending(CONFIG, again);
      expect(again.inboxCounter).toBe(2);
      expect(again.channels[0].needactionCounter).toBe(0);
    });
  });

  describe("apart from the note sync", () => {
    let svc: SyncService;

    beforeEach(async () => {
      await db.addSyncColumnsToNotes();
      await db.addSyncConfigIdColumn();
      await db.addSelectedSyncConfigIdsColumn();
      await db.addSyncPerServerStatusColumn();
      await db.createNoteLinksTable();
      await db.createSyncPullCursorsTable();
      await db.createServerCapabilitiesTable();
      await db.createRemoteRecordsCacheTable();
      await db.createSyncTargetPrefsTable();
      await db.createTagsTable();
      svc = new SyncService(db, rpc, outbox);
      chat = new ChatOutbox(db, rpc, svc.outbox, repo, () => clock);
    });

    it("syncAll leaves chat rows alone", async () => {
      const odoo = chatOdoo({ module: true });
      await chat.queuePost(CONFIG, CHANNEL, "hello", true);
      advance(1);
      await chat.queueRead(CONFIG, CHANNEL, 50, true);
      await svc.syncAll(CREDS, CONFIG, { force: true });
      expect(odoo.posts()).toHaveLength(0);
      expect(odoo.calls.some((c) => c.path === "/discuss/channel/mark_as_read")).toBe(false);
      const ops = await db.getOutboxOpsForConfig(CONFIG);
      expect(ops.map((o) => [o.kind, o.status, o.attempts])).toEqual([[CHAT_POST, "queued", 0], [CHAT_READ, "queued", 0]]);
    });

    it("hasDueWork ignores chat rows", async () => {
      chatOdoo({ module: true });
      await chat.queuePost(CONFIG, CHANNEL, "hello", true);
      await chat.queueRead(CONFIG, CHANNEL, 50, false);
      expect(await svc.hasDueWork(CONFIG)).toBe(false);
    });

    it("flush runs the chat rows and nothing else", async () => {
      const odoo = chatOdoo({ module: true });
      await outbox.enqueue({ noteId: "n1", configId: CONFIG, kind: "task.create", params: {} });
      await chat.queuePost(CONFIG, CHANNEL, "hello", true);
      await chat.flush(CREDS);
      expect(odoo.posts()).toHaveLength(1);
      expect((await db.getOutboxOpsForConfig(CONFIG)).map((o) => o.kind)).toEqual(["task.create"]);
    });
  });
});
