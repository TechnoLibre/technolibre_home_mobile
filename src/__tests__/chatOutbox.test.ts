import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";
import { DatabaseService } from "../services/databaseService";
import { OdooRpcClient, OdooRpcError, RequestNotSentError, SyncCredentials, syncSessionKey } from "../services/odoo/odooRpcClient";
import { OutboxService } from "../services/outboxService";
import { SyncService, syncConfigIdOf, CREATE_QUIET_WINDOW_MS, clientMarker } from "../services/syncService";
import { addChatTables } from "../services/migrations/addChatTables";
import { ChatRepository } from "../services/chat/chatRepository";
import { CHAT_NOTE, CHAT_POST, CHAT_READ, CHAT_UPLOAD, ChatOutbox } from "../services/chat/chatOutbox";
import { memoryChatFiles } from "../testing/chatFakes";
import type { OutgoingFile } from "../models/chat";
import { chatMarker } from "../services/chat/chatBody";

const CREDS: SyncCredentials = { odooUrl: "https://odoo.example.com", username: "alice", password: "pw", database: "db1" };
const CONFIG = syncConfigIdOf(CREDS);
const GONE: SyncCredentials = { ...CREDS, username: "bob" };
const GONE_CONFIG = syncConfigIdOf(GONE);
const CHANNEL = 7;

interface Posted { id: number; model: string; res_id: number; body: string; uuid: string | null; author?: number }
interface Call { path: string; params: any }

/**
 * A fake Odoo for the chat routes. Records each call; `dropResponses` makes
 * the next N /mail/message/post calls run on the server and then fail on the
 * wire (response lost); `failBefore` makes the next N fail before reaching it;
 * `unsent` makes the next N fail as a connection that never opened does;
 * `postError` answers the next post with a JSON-RPC error. With `module` it
 * dedups posts by erplibre_client_uuid as the server module does.
 */
function chatOdoo(opts: { module?: boolean } = {}) {
  const messages: Posted[] = [];
  const calls: Call[] = [];
  const state = { dropResponses: 0, failBefore: 0, unsent: 0, postError: null as string | null, nextId: 500 };
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
        msg = { id: state.nextId++, model: params.thread_model, res_id: params.thread_id, body: params.post_data.body, uuid, author: 3 };
        messages.push(msg);
      }
      if (state.dropResponses > 0) { state.dropResponses--; throw new TypeError("Failed to fetch"); }
      return ok({
        "mail.message": [{ id: msg.id, body: msg.body, date: "2026-10-25 10:00:05", message_type: "comment",
          author: { id: 3, type: "partner" }, thread: { id: msg.res_id, model: msg.model } }],
      });
    }
    if (path === "/web/dataset/call_kw") {
      const { model, method, kwargs } = params;
      if (model === "mail.message" && method === "search_read") {
        const needle = (kwargs.domain.find((d: any[]) => d[1] === "ilike") ?? [])[2] as string;
        const resId = kwargs.domain.find((d: any[]) => d[0] === "res_id")[2];
        const author = (kwargs.domain.find((d: any[]) => d[0] === "author_id") ?? [])[2];
        const rows = messages
          .filter((m) => m.res_id === resId && m.body.includes(needle) && (author === undefined || m.author === author))
          .map((m) => ({ id: m.id, body: m.body }));
        return ok(rows.slice(0, kwargs.limit ?? rows.length));
      }
      return ok(method === "search_read" ? [] : true);
    }
    if (path === "/web/session/get_session_info") return ok({ uid: 2, partner_id: 3, is_system: false });
    return ok(true);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { messages, calls, state, posts: () => calls.filter((c) => c.path === "/mail/message/post") };
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
    repo = new ChatRepository(db);
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

      it("a text given back at startup joins the one the draft holds, older first, never twice", async () => {
        chatOdoo();
        const cut = async (text: string, draftText: string) => {
          const a = await drafted("j" + text.length);
          await repo.putDraftText(CONFIG, CHANNEL, draftText);
          const store = vi.spyOn(repo, "putPending").mockImplementation(() => new Promise(() => {}));
          void chat.queuePost(CONFIG, CHANNEL, text, false, { files: [a], fromDraft: true });
          await vi.waitFor(() => expect(store).toHaveBeenCalled());
          store.mockRestore();
          chat = new ChatOutbox(db, rpc, outbox, repo, () => clock);
          chat.files = files;
          await chat.recoverIncomplete();
          return (await repo.draftOf(CONFIG, CHANNEL)).text;
        };
        // The draft still held the text sent: it is not doubled
        expect(await cut("first line", "first line")).toBe("first line");
        await repo.putDraftText(CONFIG, CHANNEL, "");
        // Typed after the send, before the kill: kept after the text given back
        expect(await cut("sent before", "typed after")).toBe("sent before\ntyped after");
      });

      it("a post from the draft empties the draft text in the step that queues it; any other post leaves it", async () => {
        chatOdoo();
        await repo.putDraftText(CONFIG, CHANNEL, "hello");
        vi.spyOn(repo, "putPending").mockRejectedValueOnce(new Error("disk full"));
        await expect(chat.queuePost(CONFIG, CHANNEL, "hello", false, { fromDraft: true })).rejects.toThrow("disk full");
        expect((await repo.draftOf(CONFIG, CHANNEL)).text).toBe("hello");
        await chat.queuePost(CONFIG, CHANNEL, "hello", false, { fromDraft: true });
        expect((await repo.draftOf(CONFIG, CHANNEL)).text).toBe("");
        await repo.putDraftText(CONFIG, CHANNEL, "kept");
        await chat.queuePost(CONFIG, CHANNEL, "from elsewhere", false);
        expect((await repo.draftOf(CONFIG, CHANNEL)).text).toBe("kept");
        // A conversation that cannot take a post keeps the text in the failed bubble, not in the draft
        await repo.patchChannel(CONFIG, CHANNEL, { createFailed: true });
        await chat.queuePost(CONFIG, CHANNEL, "kept", false, { fromDraft: true });
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
