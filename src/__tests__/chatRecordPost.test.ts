import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as network from "@capacitor/network";
import { createSyncEnv, installLocalStorage, resetMocks, type SyncEnv } from "../testing/syncTestKit";
import { OdooRpcClient } from "../services/odoo/odooRpcClient";
import { OutboxService } from "../services/outboxService";
import { CapabilityService } from "../services/odoo/capabilityService";
import { ChatService, type ChatSource } from "../services/chat/chatService";
import { CHAT_FILE_REFUSED, CHAT_RECORD_POST, CHAT_UPLOAD, CREATE_CLOCK_SKEW_MS } from "../services/chat/chatOutbox";
import { MODULE_UPLOAD_ROUTE, ODOO_UPLOAD_ROUTE } from "../services/chat/chatTransfer";
import { chatMarker } from "../services/chat/chatBody";
import { composeBody, EMPTY_MENTIONS, type Mentions } from "../services/chat/chatCompose";
import { emojiConversions } from "../services/chat/chatEmoji";
import { outgoingPath } from "../services/chat/chatFiles";
import { CREATE_QUIET_WINDOW_MS } from "../services/outboxMarker";
import { fakeChatHttp, memoryChatFiles } from "../testing/chatFakes";
import type { ChatMailboxItem, OutgoingFile } from "../models/chat";
import { v4 as uuidv4 } from "uuid";

const TARGET = { url: "https://odoo.example.com", username: "alice", password: "pw", database: "db1" };
const SELF = 3;
const BOB = 4;
const TASK = 5;

/** An inbox item of a followed task, as the mailbox cache holds it. */
const item = (configId: string): ChatMailboxItem => ({
  configId,
  messageId: 60,
  threadModel: "project.task",
  threadId: TASK,
  recordName: "Tâche démo",
  authorPartnerId: BOB,
  body: "<p>Peux-tu regarder ?</p>",
  date: "2026-10-26 09:00:00",
  messageType: "comment",
  needaction: true,
  starred: false,
  history: false,
});

interface Call { path: string; params: any }
interface ServerFile {
  id: number; name: string; file_size: number; mimetype: string; checksum: string;
  res_model: string; res_id: number; create_uid: number; create_date: string; uuid: string | null;
}
interface ServerMessage { id: number; model: string; res_id: number; body: string; author: number; uuid: string | null; attachment_ids: number[] }

const odooDate = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");

/**
 * A fake Odoo 18 for replies on a record. /mail/message/post stores the
 * message on its thread (the module dedups by erplibre_client_uuid on any
 * model when `module`), refuses a post naming an attachment it does not
 * hold, answers `postError` as a JSON-RPC error, and `dropPost` makes the
 * next posts run and lose their answer. search_read of mail.message and
 * ir.attachment filter the stored rows by their "=", ">=", "<=" and
 * "ilike" terms. The upload routes go through fakeChatHttp: Odoo's makes a
 * pending attachment per call, the module's returns the one its
 * client_uuid made; `dropUpload` loses the next answers once the row is
 * made, `uploadStatus` answers every upload with that status and makes
 * nothing.
 */
function recordOdoo(now: () => Date, opts: { module?: boolean } = {}) {
  const calls: Call[] = [];
  const messages: ServerMessage[] = [];
  const attachments: ServerFile[] = [];
  const state = {
    nextId: 5000, nextFile: 900, dropPost: 0, dropUpload: 0,
    postError: null as string | null, uploadStatus: null as number | null,
  };
  const ok = (result: unknown) => ({
    ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, result }), headers: { forEach: () => {} },
  } as unknown as Response);
  const rpcError = (name: string) => ({
    ok: true, status: 200, headers: { forEach: () => {} },
    text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: 200, message: "Odoo Server Error", data: { name, message: "refused" } } }),
  } as unknown as Response);
  const hit = (row: any, domain: any[][]) => domain.every(([field, op, value]) =>
    op === "=" ? row[field] === value : op === ">=" ? row[field] >= value : op === "<=" ? row[field] <= value
      : op === "in" ? value.includes(row[field]) : op === "ilike" ? String(row[field]).includes(value) : false);
  const fileRecord = (a: ServerFile) => ({ id: a.id, name: a.name, mimetype: a.mimetype, size: a.file_size, checksum: a.checksum });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: { body: string }) => {
    const path = new URL(url).pathname;
    const params = JSON.parse(init.body).params;
    calls.push({ path, params });
    if (path === "/web/session/authenticate") return ok({ uid: 2, session_id: "sid", server_version_info: [18, 0, 0, "final", 0, ""] });
    if (path === "/web/session/get_session_info") return ok({ uid: 2, partner_id: SELF, is_internal_user: true });
    if (path === "/mail/message/post") {
      if (state.postError) return rpcError(state.postError);
      const ids: number[] = params.post_data.attachment_ids ?? [];
      if (ids.some((i) => !attachments.some((a) => a.id === i))) return rpcError("odoo.exceptions.UserError");
      const uuid: string | null = params.post_data.erplibre_client_uuid ?? null;
      let m = opts.module && uuid
        ? messages.find((x) => x.uuid === uuid && x.model === params.thread_model && x.res_id === params.thread_id)
        : undefined;
      if (!m) {
        m = { id: state.nextId++, model: params.thread_model, res_id: params.thread_id, body: params.post_data.body, author: SELF, uuid, attachment_ids: ids };
        messages.push(m);
        for (const a of attachments.filter((x) => ids.includes(x.id))) { a.res_model = m.model; a.res_id = m.res_id; }
      }
      if (state.dropPost > 0) { state.dropPost--; throw new TypeError("Failed to fetch"); }
      return ok({ "mail.message": [{ id: m.id, body: m.body, thread: { id: m.res_id, model: m.model } }] });
    }
    if (path === "/web/dataset/call_kw" && params.method === "search_read") {
      const { domain, limit } = params.kwargs;
      if (params.model === "mail.message") {
        const rows = messages.map((m) => ({ ...m, author_id: m.author })).filter((m) => hit(m, domain))
          .map((m) => ({ id: m.id, body: m.body, parent_id: false }));
        return ok(rows.slice(0, limit ?? rows.length));
      }
      if (params.model === "ir.attachment") {
        const rows = attachments.filter((a) => hit(a, domain)).sort((a, b) => a.id - b.id).map((a) => ({ ...fileRecord(a), file_size: a.file_size }));
        return ok(rows.slice(0, limit ?? rows.length));
      }
      return ok([]);
    }
    return ok(true);
  }));
  const files = memoryChatFiles();
  const http = fakeChatHttp({
    getText: () => ({ status: 200, headers: {}, data: '<input type="hidden" name="csrf_token" value="tok1"/>' }),
    upload: async (r) => {
      if (state.uploadStatus !== null) return { status: state.uploadStatus, headers: {}, data: "" };
      const uuid = new URL(r.url).pathname === MODULE_UPLOAD_ROUTE ? r.fields.client_uuid : null;
      let a = uuid ? attachments.find((x) => x.uuid === uuid) : undefined;
      if (!a) {
        const bytes = files.bytes(decodeURI(r.file.uri.replace("file:///memory/files/", "")))!;
        a = {
          id: state.nextFile++, name: r.file.name, file_size: bytes.length, mimetype: r.file.mimetype, checksum: `sha${state.nextFile}`,
          res_model: "mail.compose.message", res_id: 0, create_uid: 2, create_date: odooDate(now()), uuid,
        };
        attachments.push(a);
      }
      if (state.dropUpload > 0) { state.dropUpload--; throw new Error("connection reset"); }
      return { status: 200, headers: {}, data: JSON.stringify({ data: { "ir.attachment": [fileRecord(a)] } }) };
    },
  });
  const on = (p: string) => calls.filter((c) => c.path === p);
  return {
    calls, messages, attachments, state, files, http, on,
    posts: () => on("/mail/message/post"),
    uploads: () => http.calls.filter((c) => c.kind === "upload"),
    searches: (model: string) => on("/web/dataset/call_kw").filter((c) => c.params.method === "search_read" && c.params.model === model),
  };
}

const offline = () => (network as any).__setNetworkStatus({ connected: false, connectionType: "none" });
const online = () => (network as any).__setNetworkStatus({ connected: true, connectionType: "wifi" });

describe("record replies", () => {
  let env: SyncEnv;
  let chat: ChatService;
  let clock: Date;
  let config: string;
  let odoo: ReturnType<typeof recordOdoo>;
  let src: ChatSource;
  let fileDir: string;

  const advance = (ms: number) => { clock = new Date(clock.getTime() + ms); };
  const idle = () => chat.queue.whenIdle(config);
  const ops = async (kind?: string) => (await env.db.getOutboxOpsForConfig(config)).filter((o) => !kind || o.kind === kind);
  const body = async (text: string, mentions: Mentions = EMPTY_MENTIONS) => composeBody(text, mentions, await emojiConversions()).body;
  const stage = (name: string, size = 3, mimetype = "image/jpeg"): OutgoingFile => {
    const localUuid = uuidv4();
    const path = outgoingPath(fileDir, localUuid, name);
    odoo.files.put(path, new Uint8Array(size).fill(7));
    return { localUuid, path, name, mimetype, size, voice: false };
  };
  const withModule = () => chat.repo.setSourceState({ configId: config, moduleState: "installed", moduleLevel: "1.4" });

  beforeEach(async () => {
    resetMocks();
    installLocalStorage();
    clock = new Date("2026-10-26T10:00:00.000Z");
    env = await createSyncEnv([TARGET]);
    config = env.configIds[0];
    odoo = recordOdoo(() => clock, { module: true });
    const rpc = new OdooRpcClient();
    chat = new ChatService(env.db, rpc, new OutboxService(env.db, () => clock), new CapabilityService(env.db, rpc), () => clock);
    chat.useFileIO({ files: odoo.files, http: odoo.http });
    await env.db.setApplicationOdooVersion(TARGET.url, TARGET.username, "18.0");
    src = (await chat.sources({ online: false }))[0];
    await chat.repo.setSourceState({ configId: config, selfPartnerId: SELF });
    fileDir = await chat.fileDirOf(config);
  });

  afterEach(() => {
    chat.dispose();
    vi.unstubAllGlobals();
  });

  it("a reply goes as an internal note by default", async () => {
    const op = await chat.replyOnRecord(src, item(config), "Bonjour", EMPTY_MENTIONS, []);
    expect(op).toMatchObject({
      kind: CHAT_RECORD_POST,
      params: { thread: { model: "project.task", resId: TASK, recordName: "Tâche démo" }, parentId: 60, text: "Bonjour", note: true, useModule: false },
    });
    expect(odoo.posts().map((c) => c.params)).toEqual([{
      thread_model: "project.task",
      thread_id: TASK,
      post_data: {
        body: (await body("Bonjour")) + chatMarker(op.clientUuid), message_type: "comment", subtype_xmlid: "mail.mt_note", parent_id: 60,
      },
      context: { temporary_id: op.clientUuid, mail_post_autofollow: false },
    }]);
    expect(await ops()).toEqual([]);
    expect(await chat.pendingRecordReplies(config)).toEqual(new Map());
  });

  it("a record reply carries the inbox item as parent_id", async () => {
    odoo.state.dropPost = 1;
    const op = await chat.replyOnRecord(src, item(config), "Suite", EMPTY_MENTIONS, [], false);
    expect(odoo.posts()[0].params.post_data).toMatchObject({ parent_id: 60 });
    // The retry's marker search names the record alone, whatever the parent
    advance(CREATE_QUIET_WINDOW_MS + 1);
    await chat.flushAll({ force: true });
    const [search] = odoo.searches("mail.message");
    expect(search.params.kwargs.domain).toEqual([
      ["model", "=", "project.task"],
      ["res_id", "=", TASK],
      ["author_id", "=", SELF],
      ["body", "ilike", expect.stringContaining(op.clientUuid)],
    ]);
    expect(odoo.posts()).toHaveLength(1);
    expect(await ops()).toEqual([]);
  });

  it("a reply as message sends mt_comment", async () => {
    const mentions: Mentions = { partners: [{ id: BOB, name: "Bob" }], channels: [] };
    const op = await chat.replyOnRecord(src, item(config), "Merci @Bob", mentions, [], false);
    const [post] = odoo.posts();
    expect(post.params.post_data).toEqual({
      body: (await body("Merci @Bob", mentions)) + chatMarker(op.clientUuid),
      message_type: "comment",
      subtype_xmlid: "mail.mt_comment",
      partner_ids: [BOB],
      parent_id: 60,
    });
    expect(post.params.context).toEqual({ temporary_id: op.clientUuid, mail_post_autofollow: true });
  });

  it("a reply with a photo uploads to the record's thread then links it", async () => {
    const photo = stage("photo.jpg");
    await chat.replyOnRecord(src, item(config), "Voici", EMPTY_MENTIONS, [photo], true);
    await idle();
    expect(odoo.uploads().map((c) => [new URL(c.url).pathname, c.fields])).toEqual([
      [ODOO_UPLOAD_ROUTE, { thread_id: String(TASK), thread_model: "project.task", is_pending: "true", csrf_token: "tok1" }],
    ]);
    const [post] = odoo.posts();
    expect(post.params.post_data).toMatchObject({ subtype_xmlid: "mail.mt_note", attachment_ids: [900] });
    expect(post.params.attachment_tokens).toEqual([false]);
    expect(odoo.messages).toMatchObject([{ model: "project.task", res_id: TASK, attachment_ids: [900] }]);
    expect(await ops()).toEqual([]);
    // Sent: the phone keeps no row nor copy of a file of a record's chatter
    expect(await chat.repo.outgoingFile(config, photo.localUuid)).toBeNull();
    expect(await odoo.files.size(photo.path)).toBeNull();
  });

  it("with module 1.4 the upload and the post carry their uuids", async () => {
    await withModule();
    const op = await chat.replyOnRecord(src, item(config), "", EMPTY_MENTIONS, [stage("plan.pdf", 4, "application/pdf")], true);
    expect(op.params).toMatchObject({ useModule: true });
    await idle();
    const [up] = odoo.uploads();
    expect(new URL(up.url).pathname).toBe(MODULE_UPLOAD_ROUTE);
    expect(up.fields).toEqual({
      thread_id: String(TASK), thread_model: "project.task", is_pending: "true", csrf_token: "tok1", client_uuid: expect.any(String),
    });
    expect(up.fields!.client_uuid).not.toBe(op.clientUuid);
    expect(odoo.posts()[0].params.post_data).toMatchObject({ erplibre_client_uuid: op.clientUuid, attachment_ids: [900] });
  });

  it("without the module a lost upload answer is found as a pending attachment", async () => {
    const sentAt = clock;
    odoo.state.dropUpload = 1;
    await chat.replyOnRecord(src, item(config), "Voici", EMPTY_MENTIONS, [stage("rapport.pdf", 3, "application/pdf")], true);
    await idle();
    expect(odoo.posts()).toHaveLength(0);
    advance(CREATE_QUIET_WINDOW_MS + 1);
    await chat.flushAll({ force: true });
    await idle();
    const [search] = odoo.searches("ir.attachment");
    expect(search.params.kwargs.domain).toEqual([
      ["res_model", "=", "mail.compose.message"],
      ["res_id", "=", 0],
      ["create_uid", "=", 2],
      ["name", "=", "rapport.pdf"],
      ["file_size", "=", 3],
      ["create_date", ">=", odooDate(new Date(sentAt.getTime() - CREATE_CLOCK_SKEW_MS))],
      ["create_date", "<=", odooDate(new Date(sentAt.getTime() + CREATE_CLOCK_SKEW_MS))],
    ]);
    expect(odoo.uploads()).toHaveLength(1);
    expect(odoo.attachments).toHaveLength(1);
    expect(odoo.posts().map((p) => p.params.post_data.attachment_ids)).toEqual([[900]]);
    expect(await ops()).toEqual([]);
  });

  it("a retried reply with a photo posts once with one attachment", async () => {
    odoo.state.dropPost = 1;
    const op = await chat.replyOnRecord(src, item(config), "Une fois", EMPTY_MENTIONS, [stage("photo.jpg")], true);
    await idle();
    expect(odoo.messages).toHaveLength(1);
    expect(await ops(CHAT_RECORD_POST)).toMatchObject([{ status: "failed", params: { createSentAt: clock.toISOString() } }]);
    advance(CREATE_QUIET_WINDOW_MS + 1);
    await chat.flushAll({ force: true });
    await idle();
    // Found by its marker on the record, not posted again
    const [search] = odoo.searches("mail.message");
    expect(search.params.kwargs.domain).toEqual([
      ["model", "=", "project.task"],
      ["res_id", "=", TASK],
      ["author_id", "=", SELF],
      ["body", "ilike", expect.stringContaining(op.clientUuid)],
    ]);
    expect(odoo.posts()).toHaveLength(1);
    expect(odoo.messages).toMatchObject([{ attachment_ids: [900] }]);
    expect(odoo.uploads()).toHaveLength(1);
    expect(await ops()).toEqual([]);
  });

  it("a reply queued offline leaves once online", async () => {
    offline();
    const op = await chat.replyOnRecord(src, item(config), "Plus tard", EMPTY_MENTIONS, [stage("photo.jpg")], false);
    expect(odoo.calls).toHaveLength(0);
    expect(await chat.pendingRecordReplies(config)).toEqual(new Map([[60, [{ text: "Plus tard", note: false, files: 1 }]]]));
    const [upload] = await ops(CHAT_UPLOAD);
    expect(await ops(CHAT_RECORD_POST)).toMatchObject([{ id: op.id, status: "queued", dependsOn: upload.id }]);
    online();
    await chat.flushAll();
    await idle();
    expect(odoo.posts()).toHaveLength(1);
    expect(odoo.posts()[0].params.post_data).toMatchObject({
      body: (await body("Plus tard")) + chatMarker(op.clientUuid), subtype_xmlid: "mail.mt_comment", attachment_ids: [900],
    });
    expect(await chat.pendingRecordReplies(config)).toEqual(new Map());
  });

  it("a reply refused for access keeps its text and files", async () => {
    odoo.state.postError = "odoo.exceptions.AccessError";
    const photo = stage("photo.jpg");
    const op = await chat.replyOnRecord(src, item(config), "Refusé", EMPTY_MENTIONS, [photo], true);
    await idle();
    const notices = await chat.notices([config]);
    expect(notices).toEqual([expect.objectContaining({
      id: op.id, kind: CHAT_RECORD_POST, channelId: null, reason: "refused",
      reply: { thread: { model: "project.task", resId: TASK, recordName: "Tâche démo" }, text: "Refusé", note: true, files: [photo.localUuid] },
    })]);
    // Still on the phone, whatever a sweep finds
    await chat.recover();
    expect(await chat.repo.outgoingFile(config, photo.localUuid)).toMatchObject({ state: "uploaded", attachmentId: 900 });
    expect(await odoo.files.size(photo.path)).toBe(3);
    expect(await chat.pendingRecordReplies(config)).toEqual(new Map());
    await chat.dismissNotice(config, op.id);
    expect(await chat.notices([config])).toEqual([]);
    expect(await chat.repo.outgoingFile(config, photo.localUuid)).toBeNull();
    expect(await odoo.files.size(photo.path)).toBeNull();
  });

  it("a reply whose upload the record refuses keeps its text and files, and posts nothing", async () => {
    odoo.state.uploadStatus = 404;
    const photo = stage("photo.jpg");
    const op = await chat.replyOnRecord(src, item(config), "Refusé", EMPTY_MENTIONS, [photo], false);
    await idle();
    await chat.flushAll();
    await idle();
    expect(odoo.posts()).toHaveLength(0);
    expect(await ops(CHAT_FILE_REFUSED)).toEqual([]);
    expect(await chat.notices([config])).toEqual([expect.objectContaining({
      id: op.id, kind: CHAT_RECORD_POST, reason: "refused",
      reply: expect.objectContaining({ text: "Refusé", note: false, files: [photo.localUuid] }),
    })]);
    expect(await odoo.files.size(photo.path)).toBe(3);
  });

  it("a record draft keeps its text, picks and files apart from the conversations", async () => {
    const thread = { model: "project.task", resId: TASK, recordName: "Tâche démo" };
    const photo = stage("photo.jpg");
    const mentions: Mentions = { partners: [{ id: BOB, name: "Bob" }], channels: [] };
    await chat.saveRecordDraftText(config, thread, "Brouillon");
    await chat.saveRecordDraftMentions(config, thread, mentions);
    await chat.keepRecordDraftFile(config, thread, photo, 0, "camera");
    expect(await chat.recordDraft(config, thread)).toMatchObject({
      text: "Brouillon", mentions, files: [{ localUuid: photo.localUuid, channelId: 0, threadModel: "project.task", threadId: TASK, origin: "camera" }],
    });
    expect(await chat.draftSummaries(config)).toEqual(new Map());
    expect((await chat.draft(config, 0)).files).toEqual([]);
    // The reply takes the draft's text and file
    offline();
    await chat.replyOnRecord(src, item(config), "Brouillon", mentions, [photo], true, "Brouillon");
    expect(await chat.recordDraft(config, thread)).toMatchObject({ text: "", files: [], mentions: EMPTY_MENTIONS });
    expect(await chat.repo.outgoingFile(config, photo.localUuid)).toMatchObject({ state: "queued", channelId: 0, threadModel: "project.task" });
  });
});
