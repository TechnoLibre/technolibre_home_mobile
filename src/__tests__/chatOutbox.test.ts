import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";
import { DatabaseService } from "../services/databaseService";
import { OdooRpcClient, SyncCredentials, syncSessionKey } from "../services/odoo/odooRpcClient";
import { OutboxService } from "../services/outboxService";
import { SyncService, syncConfigIdOf, CREATE_QUIET_WINDOW_MS } from "../services/syncService";
import { addChatTables } from "../services/migrations/addChatTables";
import { ChatRepository } from "../services/chat/chatRepository";
import { CHAT_NOTE, CHAT_POST, CHAT_READ, ChatOutbox } from "../services/chat/chatOutbox";
import { chatMarker } from "../services/chat/chatBody";

const CREDS: SyncCredentials = { odooUrl: "https://odoo.example.com", username: "alice", password: "pw", database: "db1" };
const CONFIG = syncConfigIdOf(CREDS);
const GONE: SyncCredentials = { ...CREDS, username: "bob" };
const GONE_CONFIG = syncConfigIdOf(GONE);
const CHANNEL = 7;

interface Posted { id: number; model: string; res_id: number; body: string; uuid: string | null }
interface Call { path: string; params: any }

/**
 * A fake Odoo for the chat routes. Records each call; `dropResponses` makes
 * the next N /mail/message/post calls run on the server and then fail on the
 * wire (response lost); `failBefore` makes the next N fail before reaching it;
 * `postError` answers the next post with a JSON-RPC error. With `module` it
 * dedups posts by erplibre_client_uuid as the server module does.
 */
function chatOdoo(opts: { module?: boolean } = {}) {
  const messages: Posted[] = [];
  const calls: Call[] = [];
  const state = { dropResponses: 0, failBefore: 0, postError: null as string | null, nextId: 500 };
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
      if (state.postError) return rpcError(state.postError);
      const uuid: string | null = params.post_data.erplibre_client_uuid ?? null;
      let msg = opts.module && uuid ? messages.find((m) => m.uuid === uuid) : undefined;
      if (!msg) {
        msg = { id: state.nextId++, model: params.thread_model, res_id: params.thread_id, body: params.post_data.body, uuid };
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
        const rows = messages.filter((m) => m.res_id === resId && m.body.includes(needle)).map((m) => ({ id: m.id }));
        return ok(rows.slice(0, kwargs.limit ?? rows.length));
      }
      return ok(method === "search_read" ? [] : true);
    }
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
      deletedChannelIds: [], members: [], deletedMemberIds: [], messages: [], partners: [], inboxCounter: null, selfPartnerId: null,
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

  it("post with module sends uuid and settles", async () => {
    const odoo = chatOdoo({ module: true });
    const m = await chat.queuePost(CONFIG, CHANNEL, "hello", true);
    const res = await chat.flush(CREDS);
    expect(res).toMatchObject({ done: 1, failed: 0, blocked: 0 });
    const [call] = odoo.posts();
    expect(call.params.thread_model).toBe("discuss.channel");
    expect(call.params.thread_id).toBe(CHANNEL);
    expect(call.params.post_data).toMatchObject({ message_type: "comment", subtype_xmlid: "mail.mt_comment", erplibre_client_uuid: m.clientUuid });
    expect(call.params.post_data.body).toBe("hello");
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

  it("two messages carrying the marker block the post as ambiguous", async () => {
    const odoo = chatOdoo();
    odoo.state.dropResponses = 1;
    const m = await chat.queuePost(CONFIG, CHANNEL, "hello", false);
    await chat.flush(CREDS);
    odoo.messages.push({ id: 900, model: "discuss.channel", res_id: CHANNEL, body: "x" + chatMarker(m.clientUuid!), uuid: null });
    advance(CREATE_QUIET_WINDOW_MS);
    const res = await chat.flush(CREDS, { force: true });
    expect(res.blocked).toBe(1);
    const [op] = await db.getOutboxOpsForConfig(CONFIG);
    expect(op).toMatchObject({ status: "blocked", params: { blockedReason: "ambiguous" } });
    expect(odoo.posts()).toHaveLength(1);
  });

  it("lost response with module retries the same uuid", async () => {
    const odoo = chatOdoo({ module: true });
    odoo.state.dropResponses = 1;
    const m = await chat.queuePost(CONFIG, CHANNEL, "hello", true);
    expect(await chat.flush(CREDS)).toMatchObject({ failed: 1 });
    expect(await chat.flush(CREDS, { force: true })).toMatchObject({ done: 1 });
    const posts = odoo.posts();
    expect(posts).toHaveLength(2);
    expect(posts.map((c) => c.params.post_data.erplibre_client_uuid)).toEqual([m.clientUuid, m.clientUuid]);
    expect(odoo.messages).toHaveLength(1);
    expect((await repo.messages(CONFIG, CHANNEL)).map((x) => [x.messageId, x.status])).toEqual([[500, "sent"]]);
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

    expect(await chat.flush(CREDS, { force: true })).toMatchObject({ done: 2 });
    expect(odoo.messages.map((m) => m.uuid)).toEqual([a.clientUuid, b.clientUuid]);
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

  it("drain ignores chat rows of a removed application", async () => {
    const odoo = chatOdoo({ module: true });
    await repo.applyDelta(GONE_CONFIG, {
      channels: [{ channelId: CHANNEL, channelType: "group", name: "Team", isMember: true }],
      deletedChannelIds: [], members: [], deletedMemberIds: [], messages: [], partners: [], inboxCounter: null, selfPartnerId: null,
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
