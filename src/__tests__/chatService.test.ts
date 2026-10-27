import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as network from "@capacitor/network";
import { createSyncEnv, installLocalStorage, resetMocks, type SyncEnv } from "../testing/syncTestKit";
import { OdooRpcClient, RequestNotSentError } from "../services/odoo/odooRpcClient";
import { OutboxService } from "../services/outboxService";
import { CapabilityService } from "../services/odoo/capabilityService";
import {
  CHAT_PAGE, ChatService, PRESENCE_CAP, RELOAD_WINDOW_MS, TYPING_RESEND_MS, TYPING_STOP_MS, type ChatSource,
} from "../services/chat/chatService";
import { CHAT_READ, MODULE_EDIT_ROUTE } from "../services/chat/chatOutbox";
import { MODULE_SEARCH_ROUTE, SERVER_PAGE } from "../services/chat/chatSearch";
import { composeBody, type Mentions } from "../services/chat/chatCompose";
import { emojiConversions } from "../services/chat/chatEmoji";
import { createHash } from "node:crypto";
import { setChatSettings } from "../services/chat/chatSettings";
import { parseStore } from "../services/chat/chatStore";
import type { BusNotification, OutgoingFile } from "../models/chat";
import { memoryChatFiles, fakeChatHttp } from "../testing/chatFakes";
import { MODULE_UPLOAD_ROUTE } from "../services/chat/chatTransfer";
import { outgoingPath, originalPath } from "../services/chat/chatFiles";
import { setAttachmentSettings } from "../services/attachmentService";
import { CREATE_CLOCK_SKEW_MS } from "../services/chat/chatOutbox";
import { CREATE_QUIET_WINDOW_MS } from "../services/outboxMarker";
import { v4 as uuidv4 } from "uuid";
import { AppService } from "../services/appService";
import { syncConfigIdFor } from "../models/syncConfig";

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
function fakeOdoo(opts: { version?: number; sessionMute?: string | false } = {}) {
  const calls: Call[] = [];
  const history: Record<number, number[]> = { [CHAT]: Array.from({ length: 80 }, (_, i) => i + 1) };
  const state = {
    nextId: 5000,
    /**
     * Runs while a post is on the server; a `{__error: name}` it returns answers a JSON-RPC error, a
     * `{__id, __body}` answers that message instead of a new one (the module's uuid dedupe).
     */
    onPost: null as null | ((params: any, id: number) => Promise<any>),
    /** While set, /mail/data holds its answer until the promise settles. */
    hold: null as null | Promise<void>,
    data: mailData() as any,
    /** The account-wide mute get_session_info reports. */
    sessionMute: (opts.sessionMute ?? false) as string | false,
    /** The user's notification_preference get_session_info reports; absent when null. */
    sessionNotification: null as null | "email" | "inbox",
    /** Answers a call_kw first when it returns a value; `{__error: name}` answers a JSON-RPC error. */
    onKw: null as null | ((params: any) => Promise<any>),
    /** Answers a route the fake does not handle itself, same convention as onKw. */
    onRoute: null as null | ((path: string, params: any) => Promise<any>),
    /** The server's ir.attachment rows (fileServer uploads them); a post links the ids it names. */
    attachments: [] as ServerFile[],
    /** max_file_upload_size get_session_info reports; absent when null. */
    maxUpload: null as number | null,
    /** Reply parents by message id: a page record gets `parentMessage`, the parent record follows (as Odoo). */
    parents: {} as Record<number, number>,
    /** Extra keys of each record a messages page answers (its `reactions`, say). */
    pageRecord: null as null | ((id: number) => Record<string, any>),
  };
  const rpcError = (name: string, code = 200) => ({
    ok: true, status: 200,
    text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code, message: "Odoo Server Error", data: { name, message: "refused" } } }),
    headers: { forEach: () => {} },
  } as unknown as Response);
  /** A route the server does not have: Odoo's HTML 404 page, no JSON-RPC envelope. */
  const notJson = (status: number) => ({
    ok: false, status, text: async () => "<!DOCTYPE html><title>404: Not Found</title>", headers: { forEach: () => {} },
  } as unknown as Response);
  const answer = (r: any) => (r && typeof r === "object" && "__status" in r ? notJson(r.__status)
    : r && typeof r === "object" && "__error" in r ? rpcError(r.__error, r.__code) : ok(r));
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
        return ok({
          uid: 2, partner_id: SELF, is_system: false, websocket_worker_version: "18.0-7", is_internal_user: true,
          ...(state.maxUpload !== null ? { max_file_upload_size: state.maxUpload } : {}),
          storeData: {
            Store: { internalUserGroupId: 11, settings: { mute_until_dt: state.sessionMute } },
            ...(state.sessionNotification ? { "res.partner": [{ id: SELF, notification_preference: state.sessionNotification }] } : {}),
          },
        });
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
        const records: any[] = page.map((i) => ({
          ...msg(i, params.channel_id), ...(i in state.parents ? { parentMessage: state.parents[i] } : {}),
          ...(state.pageRecord ? state.pageRecord(i) : {}),
        }));
        for (const i of page) {
          const parent = state.parents[i];
          if (parent !== undefined && !records.some((r) => r.id === parent)) records.push(msg(parent, params.channel_id));
        }
        return ok({ data: { "mail.message": records }, messages: page });
      }
      case "/mail/message/post": {
        const id = state.nextId++;
        const refusal = state.onPost ? await state.onPost(params, id) : undefined;
        if (refusal && typeof refusal === "object" && "__id" in refusal) {
          return ok({ "mail.message": [{ ...msg(refusal.__id, params.thread_id, SELF, refusal.__body), date: "2026-10-25 10:00:05" }] });
        }
        if (refusal && typeof refusal === "object" && "__error" in refusal) return answer(refusal);
        // As _check_attachments_access: one id the server does not hold refuses the whole post
        const ids: number[] = params.post_data.attachment_ids ?? [];
        const linked = ids.map((i) => state.attachments.find((a) => a.id === i));
        if (linked.some((a) => !a)) return rpcError("odoo.exceptions.UserError");
        for (const a of linked as ServerFile[]) { a.res_model = "discuss.channel"; a.res_id = params.thread_id; }
        const posted = {
          ...msg(id, params.thread_id, SELF, params.post_data.body), date: "2026-10-25 10:00:05",
          parentMessage: params.post_data.parent_id ?? false,
        };
        if (ids.length === 0) return ok({ "mail.message": [posted] });
        return ok({
          "mail.message": [{ ...posted, attachment_ids: ids }],
          "ir.attachment": (linked as ServerFile[]).map((a) => attachmentRecord(a)),
        });
      }
      case "/web/dataset/call_kw": {
        const { method } = params;
        if (state.onKw) {
          const r = await state.onKw(params);
          if (r !== undefined) return answer(r);
        }
        if (method === "fields_get") return ok({ body: { type: "html" } });
        if (params.model === "ir.attachment" && method === "search_read") return ok(searchFiles(state.attachments, params.kwargs));
        if (method === "search_read") return ok([]);
        return ok(true);
      }
      default: {
        if (state.onRoute) {
          const r = await state.onRoute(path, params);
          if (r !== undefined) return answer(r);
        }
        return ok(true);
      }
    }
  });
  vi.stubGlobal("fetch", fetchMock);
  const on = (p: string) => calls.filter((c) => c.path === p);
  return { calls, history, state, on, kw: (method: string) => on("/web/dataset/call_kw").filter((c) => c.params.method === method) };
}


interface ServerFile {
  id: number; name: string; file_size: number; mimetype: string; checksum: string; voice: boolean;
  res_model: string; res_id: number; create_uid: number; create_date: string; uuid: string | null;
}

/** The ir.attachment record of a Store, as the upload routes and a post answer it. */
const attachmentRecord = (a: ServerFile) => ({
  id: a.id, name: a.name, filename: a.name, mimetype: a.mimetype, size: a.file_size, checksum: a.checksum, voice: a.voice,
  thread: a.res_model === "discuss.channel" ? { id: a.res_id, model: "discuss.channel" } : false,
});

/** ir.attachment search_read over the fake's rows: "=", ">=", "<=" and "in" terms, order "id asc", limit. */
function searchFiles(rows: ServerFile[], kwargs: any): any[] {
  const hit = (a: any) => (kwargs.domain as any[][]).every(([field, op, value]) =>
    op === "=" ? a[field] === value : op === ">=" ? a[field] >= value : op === "<=" ? a[field] <= value
      : op === "in" ? value.includes(a[field]) : false);
  const found = rows.filter(hit).sort((a, b) => a.id - b.id);
  return found.slice(0, kwargs.limit ?? found.length).map((a) => ({ ...attachmentRecord(a), file_size: a.file_size }));
}

/**
 * The file side of a fake Odoo 18 over fakeOdoo: the CSRF page and the two
 * upload routes through fakeChatHttp, over memory files. Odoo's route
 * creates one pending attachment per call; the module's returns the one its
 * client_uuid already made. `drop` makes the next uploads create their row
 * and lose the answer; `status` answers the next one with that HTTP status
 * and creates nothing; `hold` keeps the nth upload call on the wire
 * ("before" or "after" its row is made) until `release()` or a cancel;
 * `notFound` answers 404 to the module route ("module", a module gone) or
 * to every upload ("all", a conversation the server no longer shows).
 * `resize` stores the images Odoo's route resizes (png, jpeg, bmp, tiff)
 * smaller than the bytes sent, as its post-processing does over 1920 px.
 */
function fileServer(odoo: ReturnType<typeof fakeOdoo>, now: () => Date) {
  const files = memoryChatFiles();
  const state = {
    nextId: 900, drop: 0, status: null as number | null,
    hold: null as null | { nth: number; when: "before" | "after" },
    notFound: null as null | "module" | "all",
    resize: false,
  };
  let count = 0;
  const held = new Map<string, { resolve: () => void; reject: (e: unknown) => void }>();
  const http = fakeChatHttp({
    getText: () => ({ status: 200, headers: {}, data: '<input type="hidden" name="csrf_token" value="tok1"/>' }),
    upload: async (r) => {
      count++;
      const hold = state.hold?.nth === count ? state.hold.when : null;
      const wait = () => new Promise<void>((resolve, reject) => { held.set(r.id, { resolve, reject }); });
      if (state.status !== null) {
        const status = state.status;
        state.status = null;
        return { status, headers: {}, data: "" };
      }
      if (hold === "before") await wait();
      const onModule = new URL(r.url).pathname === MODULE_UPLOAD_ROUTE;
      if (state.notFound === "all" || (state.notFound === "module" && onModule)) return { status: 404, headers: {}, data: "" };
      const uuid = new URL(r.url).pathname === MODULE_UPLOAD_ROUTE ? r.fields.client_uuid : null;
      let a = uuid ? odoo.state.attachments.find((x) => x.uuid === uuid) : undefined;
      if (!a) {
        const bytes = files.bytes(decodeURI(r.file.uri.replace("file:///memory/files/", "")))!;
        const resized = state.resize && !onModule && /^image\/(png|jpeg|bmp|tiff)$/.test(r.file.mimetype);
        a = {
          id: state.nextId++, name: r.file.name, file_size: resized ? Math.ceil(bytes.length / 2) : bytes.length, mimetype: r.file.mimetype, checksum: `sha${state.nextId}`,
          voice: r.fields.voice === "true", res_model: "mail.compose.message", res_id: 0, create_uid: 2,
          create_date: now().toISOString().slice(0, 19).replace("T", " "), uuid,
        };
        odoo.state.attachments.push(a);
      }
      if (hold === "after") await wait();
      if (state.drop > 0) { state.drop--; throw new Error("connection reset"); }
      return { status: 200, headers: {}, data: JSON.stringify({ data: { "ir.attachment": [attachmentRecord(a)] } }) };
    },
    cancel: (id) => {
      held.get(id)?.reject(Object.assign(new Error("cancelled"), { code: "CANCELLED" }));
      held.delete(id);
    },
  });
  const release = () => {
    for (const h of held.values()) h.resolve();
    held.clear();
  };
  return { files, http, state, release, uploads: () => http.calls.filter((c) => c.kind === "upload") };
}

interface ServerChannel { id: number; type: string; name: string; partners: number[]; uuid: string | null; createDate: string }

/**
 * The conversation side of a fake Odoo 18 over fakeOdoo's hooks:
 * channel_get (finds a chat again), create_group and channel_create (each
 * call creates, unless `module` and the context uuid matches a channel of
 * the user), the discuss.channel fingerprint search, /discuss/channel/info
 * and /discuss/channel/join. `dropNext` creates and then loses the answer;
 * `refuse` answers creates with that error; `onCreate` runs while the
 * create is on the server, before its answer leaves.
 */
function createServer(odoo: ReturnType<typeof fakeOdoo>, opts: { module?: boolean; now?: () => Date } = {}) {
  const channels: ServerChannel[] = [];
  const state = {
    nextId: 300, dropNext: 0, refuse: null as string | null,
    onCreate: null as null | ((store: any) => Promise<void>),
  };
  const odooNow = () => (opts.now?.() ?? new Date()).toISOString().slice(0, 19).replace("T", " ");
  const store = (c: ServerChannel) => ({
    "discuss.channel": [{ id: c.id, channel_type: c.type, name: c.name, last_interest_dt: c.createDate,
      message_needaction_counter: 0, is_pinned: true, memberCount: c.partners.length }],
    "discuss.channel.member": c.partners.map((partner, i) => ({
      id: c.id * 10 + i, thread: { id: c.id, model: "discuss.channel" }, persona: { id: partner, type: "partner" },
      create_date: c.createDate, ...(partner === SELF ? { message_unread_counter: 0, seen_message_id: false } : {}),
    })),
    "res.partner": c.partners.map((partner) => ({ id: partner, name: partner === SELF ? "Alice" : `P${partner}` })),
  });
  const make = (type: string, name: string, partners: number[], uuid: string | null): ServerChannel => {
    const c = { id: state.nextId++, type, name, partners: [...new Set([SELF, ...partners])], uuid, createDate: odooNow() };
    channels.push(c);
    return c;
  };
  const create = async (build: () => ServerChannel) => {
    if (state.refuse) return { __error: state.refuse };
    const c = build();
    if (state.onCreate) await state.onCreate(store(c));
    if (state.dropNext > 0) { state.dropNext--; throw new TypeError("Failed to fetch"); }
    return store(c);
  };
  odoo.state.onKw = async ({ model, method, args, kwargs }) => {
    if (model !== "discuss.channel") return undefined;
    const uuid = kwargs?.context?.erplibre_client_uuid ?? null;
    const known = () => (opts.module && uuid ? channels.find((c) => c.uuid === uuid) : undefined);
    if (method === "channel_get") {
      const wanted = [...new Set([SELF, ...kwargs.partners_to])].sort();
      return create(() => channels.find((c) => c.type === "chat" && [...c.partners].sort().join() === wanted.join())
        ?? make("chat", "", kwargs.partners_to, null));
    }
    if (method === "create_group") return create(() => known() ?? make("group", kwargs.name ?? "", kwargs.partners_to, opts.module ? uuid : null));
    if (method === "channel_create") return create(() => known() ?? make("channel", args[0], [], opts.module ? uuid : null));
    if (method === "search_read") {
      const value = (field: string) => kwargs.domain.find((d: any[]) => d[0] === field)?.[2];
      const dates = kwargs.domain.filter((d: any[]) => d[0] === "create_date");
      return channels
        .filter((c) => c.type === value("channel_type"))
        .filter((c) => dates.every(([, op, v]: any[]) => (op === ">=" ? c.createDate >= v : c.createDate <= v)))
        .filter((c) => value("name") === undefined || c.name === value("name"))
        .map((c) => ({ id: c.id, channel_partner_ids: c.partners }));
    }
    return undefined;
  };
  odoo.state.onRoute = async (path, params) => {
    const c = channels.find((x) => x.id === params.channel_id);
    if (path === "/discuss/channel/info") return c ? store(c) : null;
    if (path === "/discuss/channel/join") {
      if (!c || c.type !== "channel") return { __error: "werkzeug.exceptions.NotFound" };
      if (!c.partners.includes(SELF)) c.partners.push(SELF);
      return store(c);
    }
    return undefined;
  };
  return { channels, state, store, make };
}

interface ServerReaction { messageId: number; content: string; partnerId: number }

/**
 * The reaction side of a fake Odoo 18 over fakeOdoo's onRoute:
 * /mail/message/reaction adds only when absent and removes only when
 * present (mail_message.py _message_reaction), then answers the full group
 * of (message, content) as mail_message.py:920-933 does, a lone DELETE
 * object once nobody is left. `rows` are the server's reactions; a message
 * in `missing` answers NotFound; `drop` applies the next calls then loses
 * their answer; `hang` applies them and never answers (an app killed
 * meanwhile); `unsent` fails them as a connection that never opened; while
 * `hold` is set, a call waits on the server for it.
 */
function reactionServer(odoo: ReturnType<typeof fakeOdoo>) {
  const state = {
    rows: [] as ServerReaction[],
    missing: new Set<number>(),
    drop: 0,
    hang: 0,
    unsent: 0,
    hold: null as null | Promise<void>,
  };
  const previous = odoo.state.onRoute;
  odoo.state.onRoute = async (path, params) => {
    if (path !== "/mail/message/reaction") return previous?.(path, params);
    const { message_id: messageId, content, action } = params;
    if (state.missing.has(messageId)) return { __error: "werkzeug.exceptions.NotFound" };
    if (state.hold) await state.hold;
    if (state.unsent > 0) { state.unsent--; throw new RequestNotSentError("RawHttp error: connection refused"); }
    const ofGroup = (r: ServerReaction) => r.messageId === messageId && r.content === content;
    const own = state.rows.find((r) => ofGroup(r) && r.partnerId === SELF);
    if (action === "add" && !own) state.rows.push({ messageId, content, partnerId: SELF });
    if (action === "remove" && own) state.rows.splice(state.rows.indexOf(own), 1);
    if (state.drop > 0) { state.drop--; throw new TypeError("Failed to fetch"); }
    if (state.hang > 0) { state.hang--; return new Promise<never>(() => {}); }
    const group = state.rows.filter(ofGroup);
    if (group.length === 0) return { "mail.message": [{ id: messageId, reactions: [["DELETE", { message: messageId, content }]] }] };
    return {
      "mail.message": [{ id: messageId, reactions: [["ADD", [{ message: messageId, content }]]] }],
      MessageReactions: [{
        content, count: group.length, sequence: 1, message: messageId,
        personas: group.map((r) => ({ id: r.partnerId, type: "partner" })),
      }],
      "res.partner": group.map((r) => ({ id: r.partnerId, name: r.partnerId === SELF ? "Alice" : `P${r.partnerId}` })),
    };
  };
  return { state, calls: () => odoo.on("/mail/message/reaction").map((c) => c.params) };
}

/**
 * The edit side of a fake Odoo 18 over fakeOdoo's hooks. Odoo's
 * /mail/message/update_content writes the body with the edited span inside
 * the paragraph of a text body, a lone span for a message it empties, ""
 * for one already empty (mail_thread.py _message_update_content). With
 * `module` the guarded route compares the sha256 of the stored body with
 * `expected_fingerprint` and answers erplibre_conflict without writing;
 * without it that route answers Odoo's HTML 404. `bodies` are the server's
 * messages, `files` their attachment ids (a message with files is not
 * empty); a search_read of mail.message by id reads both, one by body
 * (the marker search of a retried post) the user's messages holding the
 * text. A message in `missing` answers NotFound; `drop` applies the next
 * calls then loses their answer; while `hold` is set, a call waits on the
 * server for it.
 */
function editServer(odoo: ReturnType<typeof fakeOdoo>) {
  const state = {
    bodies: new Map<number, string>(),
    files: new Map<number, number[]>(),
    missing: new Set<number>(),
    module: false,
    drop: 0,
    hold: null as null | Promise<void>,
  };
  const emptyBody = (b: string) => !b || b.replace('<span class="o-mail-Message-edited"></span>', "").replace(/<\/?p>|\s/g, "") === "";
  const empty = (id: number) => emptyBody(state.bodies.get(id)!) && (state.files.get(id) ?? []).length === 0;
  const store = (id: number) => ({
    "mail.message": [{
      id, body: state.bodies.get(id), thread: { id: GROUP, model: "discuss.channel" }, attachment_ids: state.files.get(id) ?? [],
    }],
  });
  const previousRoute = odoo.state.onRoute;
  odoo.state.onRoute = async (path, params) => {
    if (path !== "/mail/message/update_content" && path !== MODULE_EDIT_ROUTE) return previousRoute?.(path, params);
    if (path === MODULE_EDIT_ROUTE && !state.module) return { __status: 404 };
    const id: number = params.message_id;
    if (!state.bodies.has(id) || state.missing.has(id)) return { __error: "werkzeug.exceptions.NotFound" };
    if (state.hold) await state.hold;
    const old = state.bodies.get(id)!;
    if (path === MODULE_EDIT_ROUTE) {
      const fingerprint = createHash("sha256").update(old, "utf8").digest("hex");
      if (fingerprint !== params.expected_fingerprint || (empty(id) && params.body)) {
        return { erplibre_conflict: empty(id) ? "deleted" : "changed", ...store(id) };
      }
    }
    const wasEmpty = empty(id);
    if (Array.isArray(params.attachment_ids) && params.attachment_ids.length === 0) state.files.delete(id);
    state.bodies.set(id, params.body
      ? `<p>${params.body}<span class="o-mail-Message-edited"></span></p>`
      : wasEmpty ? "" : '<span class="o-mail-Message-edited"></span>');
    if (state.drop > 0) { state.drop--; throw new TypeError("Failed to fetch"); }
    return store(id);
  };
  const previousKw = odoo.state.onKw;
  odoo.state.onKw = async (params) => {
    const domain: any[][] = params.model === "mail.message" && params.method === "search_read" ? params.kwargs.domain : [];
    const byId = domain.find((d) => d[0] === "id" && d[1] === "=");
    const byBody = domain.find((d) => d[0] === "body" && d[1] === "ilike");
    if (byId) {
      const id: number = byId[2];
      return state.bodies.has(id) ? [{ id, body: state.bodies.get(id) || false, attachment_ids: state.files.get(id) ?? [] }] : [];
    }
    if (byBody) return [...state.bodies].filter(([, b]) => b.includes(byBody[2])).map(([id, body]) => ({ id, body }));
    return previousKw?.(params);
  };
  return {
    state,
    /** The edit calls, either route, in order. */
    edits: () => odoo.calls.filter((c) => c.path === "/mail/message/update_content" || c.path === MODULE_EDIT_ROUTE),
    /** The re-reads of a message body by id. */
    reads: () => odoo.kw("search_read").filter((c) => c.params.model === "mail.message"
      && c.params.kwargs.domain.some((d: any[]) => d[0] === "id")),
  };
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
    // an account-wide mute ahead leaves only the inbox remainder
    await chat.repo.setSourceState({ configId: config, globalMuteUntil: "9999-12-31 23:59:59" });
    expect(await chat.unreadTotal([config])).toBe(1);
    await chat.repo.setSourceState({ configId: config, globalMuteUntil: null });
    expect(await chat.repo.sourceState(config)).toMatchObject({
      selfPartnerId: SELF, isSystem: false, wsVersion: "18.0-7", moduleState: "unknown", inboxCounter: 4,
      internalUserGroupId: 11, isInternalUser: true, globalMuteUntil: null,
      loadedAt: clock.toISOString(),
    });
    expect(changes).toContainEqual([config, null]);
  });

  it("a load reads the global mute fresh and a newer bus change wins over a load that started earlier", async () => {
    fakeOdoo({ sessionMute: "9999-12-31 23:59:59" });
    const src = await source();
    await chat.load(src);
    expect((await chat.repo.sourceState(src.configId)).globalMuteUntil).toBe("9999-12-31 23:59:59");
    // the bus unmutes after the load started: the session value read is older
    await chat.repo.applyDelta(src.configId, { channels: [], deletedChannelIds: [], members: [], deletedMemberIds: [],
      messages: [], attachments: [], deletedAttachmentIds: [], partners: [], inboxCounter: null, selfPartnerId: null, globalMuteUntil: null }, { fromBus: true });
    const after = await chat.repo.sourceState(src.configId);
    expect(after.globalMuteUntil).toBeNull();
    expect(after.globalMuteAt).not.toBeNull();
    await chat.repo.setSourceState({ configId: src.configId, globalMuteAt: new Date(clock.getTime() + 60000).toISOString() });
    await chat.load(src);
    expect((await chat.repo.sourceState(src.configId)).globalMuteUntil).toBeNull();
    // a load started after the bus change takes the server's value
    await chat.repo.setSourceState({ configId: src.configId, globalMuteAt: new Date(clock.getTime() - 60000).toISOString() });
    await chat.load(src);
    expect((await chat.repo.sourceState(src.configId)).globalMuteUntil).toBe("9999-12-31 23:59:59");
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

  it("a page counts its own messages only: a reply's older parent is cached, not loaded", async () => {
    const odoo = fakeOdoo();
    odoo.state.parents[60] = 5;
    const src = await source();
    await chat.load(src);
    expect(await chat.loadOlder(src, CHAT)).toBe(CHAT_PAGE - 1);
    expect(await chat.repo.channel(config, CHAT)).toMatchObject({ oldestLoadedId: 81 - CHAT_PAGE, historyComplete: false });
    expect(await chat.repo.message(config, 60)).toMatchObject({ parentId: 5 });
    expect(await chat.repo.message(config, 5)).toMatchObject({ channelId: CHAT, body: "<p>m5</p>" });
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

  it("a forced flushAll sends a post its retry delay still holds", async () => {
    const odoo = fakeOdoo();
    const src = await source();
    await chat.load(src);
    await chat.queue.queuePost(config, GROUP, "hello", false);
    // A drain while the network drops: the attempt fails before any request
    chat.isOnline = async () => false;
    await chat.flushAll();
    chat.isOnline = async () => true;
    await chat.flushAll();
    expect(odoo.on("/mail/message/post")).toHaveLength(0);
    await chat.flushAll({ force: true });
    expect(odoo.on("/mail/message/post")).toHaveLength(1);
  });

  it("reconnectNow reaches every running bus", async () => {
    fakeOdoo();
    const made: any[] = [];
    await chat.startRealtime(() => {
      const t = { open: vi.fn(), send: vi.fn(), close: vi.fn(), onOpen: () => {}, onMessage: () => {}, onClose: () => {} };
      made.push(t);
      return t as any;
    });
    await vi.waitFor(() => expect(made).toHaveLength(1));
    made[0].onClose(1006, "");
    await new Promise((r) => setTimeout(r, 0));
    chat.reconnectNow();
    // Well before the first backoff step (1 s and more)
    await vi.waitFor(() => expect(made).toHaveLength(2), { timeout: 500 });
    chat.stopRealtime();
  });

  it("send online posts at once, with the module uuid when it is installed", async () => {
    const odoo = fakeOdoo();
    const src = await source();
    await chat.load(src);
    await chat.repo.setSourceState({ configId: config, moduleState: "installed", moduleLevel: "1.2" });
    const sent = await chat.send(src, GROUP, "hello");
    expect(sent.status).toBe("pending");
    expect(odoo.on("/mail/message/post")[0].params.post_data.erplibre_client_uuid).toBe(sent.clientUuid);
    expect((await chat.messages(config, GROUP)).at(-1)).toMatchObject({ status: "sent", messageId: 5000 });
  });

  it("send uses the module uuid for post when outdated (1.0), not when absent or unknown", async () => {
    const odoo = fakeOdoo();
    const src = await source();
    await chat.load(src);
    const uuids: Array<string | undefined> = [];
    for (const [st, level] of [["outdated", "1.0"], ["absent", null], ["unknown", null]] as const) {
      await chat.repo.setSourceState({ configId: config, moduleState: st, moduleLevel: level });
      await chat.send(src, GROUP, st);
      uuids.push(odoo.on("/mail/message/post").at(-1)!.params.post_data.erplibre_client_uuid);
    }
    expect(uuids[0]).toEqual(expect.any(String));
    expect(uuids[1]).toBeUndefined();
    expect(uuids[2]).toBeUndefined();
  });

  it("features follow the module level, member removal also a system user", async () => {
    fakeOdoo();
    await chat.load(await source());
    const matrix: Array<[any, any, boolean, boolean, boolean, boolean, boolean, boolean]> = [
      ["installed", "1.4", true, true, true, true, true, true],
      ["installed", "1.4", false, false, true, true, true, true],
      ["outdated", "1.3", true, true, true, true, true, false],
      ["outdated", "1.3", false, false, true, true, true, false],
      ["outdated", "1.2", true, true, true, true, false, false],
      ["outdated", "1.2", false, false, true, true, false, false],
      ["outdated", "1.1", true, true, true, false, false, false],
      ["outdated", "1.1", false, false, true, false, false, false],
      ["outdated", "1.0", true, false, false, false, false, false],
      ["available", null, true, false, false, false, false, false],
      ["unknown", null, false, false, false, false, false, false],
    ];
    for (const [moduleState, moduleLevel, isSystem, remove, create, upload, guarded, v14] of matrix) {
      await chat.repo.setSourceState({ configId: config, moduleState, moduleLevel, isSystem });
      expect(await chat.features(config)).toEqual({
        canRemoveMembers: remove, idempotentCreate: create, idempotentUpload: upload, guardedEdit: guarded,
        serverSearch: v14, idempotentStar: v14, idempotentRecordPost: v14,
      });
    }
  });

  it("a row stored before the level existed falls back on its module state, offline", async () => {
    fakeOdoo();
    const src = await source();
    await chat.load(src);
    await chat.repo.setSourceState({ configId: config, moduleState: "installed", moduleLevel: null, isSystem: true });
    expect(await chat.features(config)).toEqual({
      canRemoveMembers: true, idempotentCreate: true, idempotentUpload: false, guardedEdit: false,
      serverSearch: false, idempotentStar: false, idempotentRecordPost: false,
    });
    await chat.repo.setSourceState({ configId: config, moduleState: "outdated", moduleLevel: null });
    expect(await chat.features(config)).toEqual({
      canRemoveMembers: false, idempotentCreate: false, idempotentUpload: false, guardedEdit: false,
      serverSearch: false, idempotentStar: false, idempotentRecordPost: false,
    });
    for (const st of ["installed", "outdated"] as const) {
      const odoo = fakeOdoo();
      await chat.repo.setSourceState({ configId: config, moduleState: st, moduleLevel: null });
      await chat.send(src, GROUP, st);
      expect(odoo.on("/mail/message/post").at(-1)!.params.post_data.erplibre_client_uuid).toEqual(expect.any(String));
    }
  });

  it("features give nothing when the module is ignored", async () => {
    fakeOdoo();
    await chat.load(await source());
    await chat.repo.setSourceState({ configId: config, moduleState: "installed", moduleLevel: "1.4", isSystem: true });
    const ignoring = new ChatService(env.db, (chat as any).rpc, new OutboxService(env.db), (chat as any).capabilities, undefined, { moduleMode: "ignore" });
    expect(await ignoring.features(config)).toEqual({
      canRemoveMembers: false, idempotentCreate: false, idempotentUpload: false, guardedEdit: false,
      serverSearch: false, idempotentStar: false, idempotentRecordPost: false,
    });
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

  it("ir.attachment/delete removes the row and releases its paths; mail.record/insert with fewer ids drops the other", async () => {
    fakeOdoo();
    await chat.load(await source());
    const released: string[][] = [];
    chat.repo.onFilesReleased = (paths) => { released.push(paths); };
    const att = (id: number) => ({ id, name: `f${id}.png`, mimetype: "image/png", size: 5, checksum: `c${id}`, thread: { id: GROUP, model: "discuss.channel" }, voice: false });
    await chat.applyBus(config, [bus(1001, "mail.record/insert", {
      "mail.message": [{ id: 700, thread: { id: GROUP, model: "discuss.channel" }, body: "x", attachment_ids: [1, 2] }],
      "ir.attachment": [att(1), att(2)],
    })]);
    await chat.repo.setOriginal(config, 1, "chat/d/files/1/f1.png", 5);
    await chat.repo.setPreview(config, 2, "chat/d/thumbs/2", 5);
    expect((await chat.repo.attachmentsOf(config, GROUP, [700], [])).get("m700")).toHaveLength(2);
    await chat.applyBus(config, [bus(1002, "mail.record/insert", {
      "mail.message": [{ id: 700, thread: { id: GROUP, model: "discuss.channel" }, attachment_ids: [1] }],
    })]);
    expect(released).toEqual([["chat/d/thumbs/2"]]);
    const changes: any[] = [];
    chat.onChange = (c, ch) => changes.push([c, ch]);
    await chat.applyBus(config, [bus(1003, "ir.attachment/delete", { id: 1 })]);
    expect(changes).toEqual([[config, GROUP]]);
    expect(released).toEqual([["chat/d/thumbs/2"], ["chat/d/files/1/f1.png"]]);
    expect((await chat.repo.attachmentsOf(config, GROUP, [700], [])).size).toBe(0);
  });

  it("mail.message/delete drops the message, its reactions and its files; another message stays", async () => {
    fakeOdoo();
    await chat.load(await source());
    const released: string[][] = [];
    chat.repo.onFilesReleased = (paths) => { released.push(paths); };
    const thread = { id: GROUP, model: "discuss.channel" };
    await chat.applyBus(config, [bus(1001, "mail.record/insert", {
      "mail.message": [
        { id: 700, thread, body: "x", attachment_ids: [1], reactions: [["ADD", [{ message: 700, content: "👍" }]]] },
        { id: 701, thread, body: "y", reactions: [{ message: 701, content: "👍" }] },
      ],
      MessageReactions: [
        { content: "👍", count: 1, sequence: 1, message: 700, personas: [{ id: BOB, type: "partner" }] },
        { content: "👍", count: 1, sequence: 2, message: 701, personas: [{ id: SELF, type: "partner" }] },
      ],
      "ir.attachment": [{ id: 1, name: "f1.png", mimetype: "image/png", size: 5, checksum: "c1", thread, voice: false }],
    })]);
    await chat.repo.setOriginal(config, 1, "chat/d/files/1/f1.png", 5);
    expect((await chat.repo.reactionsOf(config, GROUP, ["m701"])).get("m701")![0]).toMatchObject({ selfReacted: true });
    const changes: any[] = [];
    chat.onChange = (c, ch) => changes.push([c, ch]);
    await chat.applyBus(config, [bus(1002, "mail.message/delete", { message_ids: [700] })]);
    expect(changes).toEqual([[config, GROUP]]);
    expect(await chat.repo.message(config, 700)).toBeNull();
    expect(await chat.repo.message(config, 701)).not.toBeNull();
    expect([...(await chat.repo.reactionsOf(config, GROUP, ["m700", "m701"])).keys()]).toEqual(["m701"]);
    expect(await chat.repo.attachment(config, 1)).toBeNull();
    expect(released).toEqual([["chat/d/files/1/f1.png"]]);
    // A message not cached changes nothing
    await chat.applyBus(config, [bus(1003, "mail.message/delete", { message_ids: [999] })]);
    expect(changes).toHaveLength(1);
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
    // As in the browser, a message counts even while its conversation is open; marking read brings it down
    await chat.applyBus(config, [bus(1003, "discuss.channel/new_message", { id: GROUP, data: { "mail.message": [msg(602, GROUP)] } })]);
    expect((await chat.repo.channel(config, GROUP))!.unreadCounter).toBe(1);
    // In a channel too: it makes the channel bold, it is not counted
    await chat.applyBus(config, [bus(1004, "discuss.channel/new_message", { id: QUIET, data: { "mail.message": [msg(901, QUIET)] } })]);
    expect((await chat.repo.channel(config, QUIET))!.unreadCounter).toBe(8);
    expect((await chat.repo.channel(config, QUIET))!.needactionCounter).toBe(0);
    // The user's own message never counts
    await chat.applyBus(config, [bus(1005, "discuss.channel/new_message", { id: GROUP, data: { "mail.message": [msg(603, GROUP, SELF)] } })]);
    expect((await chat.repo.channel(config, GROUP))!.unreadCounter).toBe(1);
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

  it("the list follows the order setting, and setOnTop rebuilds it", async () => {
    fakeOdoo();
    await chat.load(await source());
    const changes: any[] = [];
    chat.onChange = (c, ch) => changes.push([c, ch]);
    const base = (await chat.conversations()).map((c) => c.channelId);
    expect(base).toEqual([GENERAL, CHAT, GROUP, MUTED, QUIET]);
    await chat.setOnTop(config, QUIET, true);
    expect(changes).toEqual([[config, QUIET]]);
    // on_top_first (default): the kept conversation leads even though read
    expect((await chat.conversations()).map((c) => c.channelId)).toEqual([QUIET, GENERAL, CHAT, GROUP, MUTED]);
    setChatSettings({ sendRead: true, sendTyping: true, listOrder: "unread_first" } as any);
    // unread_first: every counted unread conversation (MUTED counts) before the read one kept on top
    const ids = (await chat.conversations()).map((c) => c.channelId);
    expect(ids).toEqual([GENERAL, CHAT, GROUP, MUTED, QUIET]);
    await chat.setOnTop(config, QUIET, false);
    expect((await chat.conversations()).map((c) => c.channelId)).toEqual([GENERAL, CHAT, GROUP, MUTED, QUIET]);
  });

  it("search finds the conversations the list shows, by display name", async () => {
    fakeOdoo();
    await chat.load(await source());
    expect((await chat.search.local([config], "bob")).conversations).toEqual([{ configId: config, channelId: CHAT }]);
    expect((await chat.search.local([config], "team")).conversations).toEqual([{ configId: config, channelId: GROUP }]);
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
        deletedChannelIds: [], members: [], deletedMemberIds: [], messages: [], attachments: [], deletedAttachmentIds: [], partners: [], inboxCounter: null, selfPartnerId: null,
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

  it("deleting an account does not wait for a pending load of that account", async () => {
    const odoo = fakeOdoo();
    const src = await source();
    odoo.state.hold = new Promise(() => {});
    void chat.load(src).catch(() => {});
    await vi.waitFor(() => expect(odoo.on("/mail/data")).toHaveLength(1));
    await chat.queue.queuePost(config, GROUP, "not sent", false);
    const forgotten = await Promise.race([
      chat.forgetSource(config).then(() => true),
      new Promise((r) => setTimeout(() => r(false), 1000)),
    ]);
    expect(forgotten).toBe(true);
    expect(await chat.repo.hasSourceState(config)).toBe(false);
    expect(await chat.queue.pendingPostCount(config)).toBe(0);
  });

  it("a load landing after its account was deleted writes nothing", async () => {
    const odoo = fakeOdoo();
    const src = await source();
    let release!: () => void;
    odoo.state.hold = new Promise((r) => { release = r; });
    const loading = chat.load(src);
    await vi.waitFor(() => expect(odoo.on("/mail/data")).toHaveLength(1));
    await chat.forgetSource(config);
    release();
    await loading;
    expect(await chat.repo.channels(config)).toEqual([]);
    expect(await chat.repo.hasSourceState(config)).toBe(false);
  });

  it("stopping one source's realtime leaves the others, starting it opens a single new bus", async () => {
    fakeOdoo();
    await build([TARGET, { ...TARGET, username: "bob" }]);
    for (const app of await env.db.getAllApplications()) await env.db.setApplicationOdooVersion(app.url, app.username, "18.0");
    const [a, b] = env.configIds;
    const made: Record<string, any[]> = { [a]: [], [b]: [] };
    const transportFor = (id: string) => {
      const t = { open: vi.fn(), send: vi.fn(), close: vi.fn(), onOpen: () => {}, onMessage: () => {}, onClose: () => {} };
      made[id].push(t);
      return t as any;
    };
    await chat.startRealtime(transportFor);
    await vi.waitFor(() => expect(made[a][0]?.open).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(made[b][0]?.open).toHaveBeenCalledTimes(1));
    chat.stopSourceRealtime(a);
    expect(made[a][0].close).toHaveBeenCalled();
    expect(made[b][0].close).not.toHaveBeenCalled();
    await chat.startSourceRealtime(a);
    await vi.waitFor(() => expect(made[a]).toHaveLength(2));
    await vi.waitFor(() => expect(made[a][1].open).toHaveBeenCalledTimes(1));
    expect(made[b]).toHaveLength(1);
    chat.stopRealtime();
  });

  it("markRead after an own send sends nothing when already seen", async () => {
    const odoo = fakeOdoo();
    const src = await source();
    await chat.load(src);
    await chat.send(src, GROUP, "hello");
    // Stands in for the bus delivering the own message: the last message becomes the one the post settled on
    expect((await chat.repo.channel(config, GROUP))!.seenMessageId).toBe(5000);
    await chat.repo.patchChannel(config, GROUP, { lastMessageId: 5000 });
    const reads = odoo.kw("mark_as_read").length + odoo.on("/discuss/channel/mark_as_read").length;
    const ops = (await env.db.getOutboxOpsForConfig(config)).length;
    await chat.markRead(src, GROUP);
    expect(odoo.kw("mark_as_read").length + odoo.on("/discuss/channel/mark_as_read").length).toBe(reads);
    expect((await env.db.getOutboxOpsForConfig(config)).length).toBe(ops);
  });

  it("an account re-added while a delete's load hangs keeps what it writes after", async () => {
    const odoo = fakeOdoo();
    const src = await source();
    let release!: () => void;
    odoo.state.hold = new Promise((r) => { release = r; });
    const loading = chat.load(src).catch(() => {});
    await vi.waitFor(() => expect(odoo.on("/mail/data")).toHaveLength(1));
    await env.db.deleteApplication(TARGET.url, TARGET.username);
    await chat.forgetSource(config);
    await env.db.addApplication({
      ...TARGET, odooVersion: "18.0", autoSync: false, pollIntervalMinutes: 5, ntfyUrl: "", ntfyTopic: "", ntfyToken: "",
    } as any);
    await chat.queue.queuePost(config, GROUP, "written after the re-add", false);
    release();
    await loading;
    // The second erase, queued behind the hung load, has run its turn
    await chat.load(await source());
    expect(await chat.queue.pendingPostCount(config)).toBe(1);
    expect((await chat.messages(config, GROUP)).map((m) => m.status)).toEqual(["sent", "pending"]);
    expect((await chat.repo.channels(config)).length).toBeGreaterThan(0);
  });

  it("a page landing after a delete writes nothing", async () => {
    const odoo = fakeOdoo();
    const src = await source();
    await chat.load(src);
    const real = globalThis.fetch as any;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    vi.stubGlobal("fetch", async (url: string, init: any) => {
      const answer = real(url, init);
      if (new URL(url).pathname === "/discuss/channel/messages") await gate;
      return answer;
    });
    const paging = chat.loadOlder(src, CHAT);
    await vi.waitFor(() => expect(odoo.on("/discuss/channel/messages")).toHaveLength(1));
    await chat.forgetSource(config);
    release();
    expect(await paging).toBe(0);
    expect(await chat.repo.channels(config)).toEqual([]);
    expect(await chat.repo.messages(config, CHAT)).toEqual([]);
  });

  it("a source whose load never answers does not hold back another source's bus", async () => {
    fakeOdoo();
    await build([TARGET, { ...TARGET, username: "bob" }]);
    for (const id of env.configIds) await chat.repo.setSourceState({ configId: id, selfPartnerId: SELF });
    for (const app of await env.db.getAllApplications()) await env.db.setApplicationOdooVersion(app.url, app.username, "18.0");
    const [silent, live] = env.configIds;
    const load = chat.load.bind(chat);
    vi.spyOn(chat, "load").mockImplementation((src) => (src.configId === silent ? new Promise(() => {}) : load(src)));
    const opened: string[] = [];
    const starting = chat.startRealtime((configId) => {
      const t = { open: vi.fn(() => opened.push(configId)), send: vi.fn(), close: vi.fn(), onOpen: () => {}, onMessage: () => {}, onClose: () => {} };
      return t as any;
    });
    await vi.waitFor(() => expect(opened).toEqual([live]));
    chat.stopRealtime();
    void starting;
  });

  it("leaving a channel drops its outbox rows and keeps its unsent texts as failed", async () => {
    fakeOdoo();
    const src = await source();
    await chat.load(src);
    await chat.queue.queuePost(config, QUIET, "too late", false);
    await chat.queue.queueRead(config, QUIET, 900, false);
    await chat.queue.queuePost(config, GROUP, "stays", false);
    await chat.applyBus(config, [bus(1001, "discuss.channel/leave", { "discuss.channel": [{ id: QUIET }] })]);
    const ops = await env.db.getOutboxOpsForConfig(config);
    expect(ops.map((o) => o.params.channelId)).toEqual([GROUP]);
    expect((await chat.messages(config, QUIET)).map((m) => [m.status, m.outboxOpId])).toEqual([["failed", null]]);
  });

  it("a post answered while a load reads is settled after the load writes", async () => {
    const odoo = fakeOdoo();
    const src = await source();
    await chat.load(src);
    let release!: () => void;
    odoo.state.hold = new Promise((r) => { release = r; });
    const reads = odoo.on("/mail/data").length;
    // The load reads GROUP with 2 unread, before the post exists
    const loading = chat.load(src);
    await vi.waitFor(() => expect(odoo.on("/mail/data")).toHaveLength(reads + 1));
    const sending = chat.send(src, GROUP, "hello");
    await vi.waitFor(() => expect(odoo.on("/mail/message/post")).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 10));
    release();
    await Promise.all([loading, sending]);
    // Posting reads the channel for its author: the older read does not bring the 2 back
    expect((await chat.repo.channel(config, GROUP))!.unreadCounter).toBe(0);
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
  // ─── Lot 2: hidden direct messages, membership, presence, global mute ────

  /** Starts realtime on a fake socket and opens it; frames go in through deliver(). */
  const openBus = async () => {
    const made: any[] = [];
    await source();
    const applied = vi.spyOn(chat, "applyBus");
    const presence = vi.spyOn(chat, "presenceChannels");
    await chat.startRealtime(() => {
      const t = { open: vi.fn(), send: vi.fn(), close: vi.fn(), onOpen: () => {}, onMessage: (_: string) => {}, onClose: () => {} };
      made.push(t);
      return t as any;
    });
    await vi.waitFor(() => expect(made[0]?.open).toHaveBeenCalledTimes(1));
    const t = made[0];
    const subscribes = (): string[][] => t.send.mock.calls
      .map((c: any[]) => JSON.parse(c[0]))
      .filter((f: any) => f.event_name === "subscribe")
      .map((f: any) => f.data.channels);
    t.onOpen();
    await vi.waitFor(() => expect(subscribes()).toHaveLength(1));
    const deliver = async (n: BusNotification[]) => {
      const calls = applied.mock.results.length;
      t.onMessage(JSON.stringify(n));
      await vi.waitFor(() => expect(applied.mock.results.length).toBe(calls + 1));
      await applied.mock.results[calls].value;
      // A resubscribe sends once its channel list is read: past that read, its send has run
      await Promise.all(presence.mock.results.map((r) => r.value));
      await Promise.resolve();
    };
    return { subscribes, deliver };
  };

  /** The Store the other person's new group or DM brings: the channel, self and their member rows. */
  const newConversation = (id: number, type: string, others: number[], o: { pinned?: boolean } = {}) => ({
    "discuss.channel": [{ id, channel_type: type, name: type === "chat" ? "" : "Fresh", last_interest_dt: "2026-10-25 12:00:00",
      message_needaction_counter: 0, ...(o.pinned === undefined ? {} : { is_pinned: o.pinned }) }],
    "discuss.channel.member": [SELF, ...others].map((partner, i) => ({
      id: id * 10 + i, thread: { id, model: "discuss.channel" }, persona: { id: partner, type: "partner" },
      create_date: "2026-10-25 12:00:00", ...(partner === SELF ? { message_unread_counter: 0 } : {}),
    })),
    "res.partner": others.map((partner) => ({ id: partner, name: `P${partner}`, im_status: "offline" })),
  });

  it("unpin hides a DM, a new message shows it again", async () => {
    fakeOdoo();
    await chat.load(await source());
    const changes: any[] = [];
    chat.onChange = (c, ch) => changes.push([c, ch]);
    await chat.applyBus(config, [bus(1001, "discuss.channel/unpin", { id: CHAT })]);
    expect(changes).toContainEqual([config, CHAT]);
    expect((await chat.conversations()).map((c) => c.channelId)).not.toContain(CHAT);
    // A replay older than the load leaves the pin the load read
    await chat.repo.patchChannel(config, GROUP, { isPinned: true });
    await chat.applyBus(config, [bus(999, "discuss.channel/unpin", { id: GROUP })]);
    expect((await chat.repo.channel(config, GROUP))!.isPinned).toBe(true);
    // A post pins the chat for every member: Odoo sends {id, is_pinned:true} before the message
    await chat.applyBus(config, [
      bus(1002, "mail.record/insert", { "discuss.channel": [{ id: CHAT, is_pinned: true }] }),
      bus(1003, "discuss.channel/new_message", { id: CHAT, data: { "mail.message": [msg(81, CHAT)] } }),
    ]);
    expect((await chat.conversations()).map((c) => c.channelId)).toContain(CHAT);
    // The message alone pins it too
    await chat.applyBus(config, [bus(1004, "discuss.channel/unpin", { id: CHAT })]);
    await chat.applyBus(config, [bus(1005, "discuss.channel/new_message", { id: CHAT, data: { "mail.message": [msg(82, CHAT)] } })]);
    expect((await chat.conversations()).map((c) => c.channelId)).toContain(CHAT);
    // The other person's brand-new empty DM arrives unpinned: not listed until its first message
    await chat.applyBus(config, [bus(1006, "mail.record/insert", newConversation(20, "chat", [7], { pinned: false }))]);
    expect(await chat.repo.channel(config, 20)).toMatchObject({ isMember: true, isPinned: false });
    expect((await chat.conversations()).map((c) => c.channelId)).not.toContain(20);
    // A group or a channel is never hidden by the pin flag
    await chat.repo.patchChannel(config, GROUP, { isPinned: false });
    expect((await chat.conversations()).map((c) => c.channelId)).toContain(GROUP);
  });

  it("a channel that gains self membership resubscribes once", async () => {
    fakeOdoo();
    const { subscribes, deliver } = await openBus();
    // Neither a counter nor a known member channel changes the subscription
    await deliver([bus(1001, "mail.record/insert", selfMember(5, 1001))]);
    expect(subscribes()).toHaveLength(1);
    // A non-member channel seen is no membership either
    await deliver([bus(1002, "mail.record/insert", { "discuss.channel": [{ id: 15, channel_type: "channel", name: "Public" }] })]);
    expect(subscribes()).toHaveLength(1);
    // The other person's new group and new DM in one batch: one subscribe, carrying their presence
    await deliver([
      bus(1003, "mail.record/insert", newConversation(21, "group", [BOB, 7])),
      bus(1004, "mail.record/insert", newConversation(22, "chat", [8], { pinned: false })),
    ]);
    expect(subscribes()).toHaveLength(2);
    expect(subscribes()[1]).toEqual(expect.arrayContaining(["odoo-presence-res.partner_7", "odoo-presence-res.partner_8"]));
    // The channel seen before becomes a member one
    await deliver([bus(1005, "mail.record/insert", {
      "discuss.channel": [{ id: 15, selfMember: { id: 150, thread: { id: 15, model: "discuss.channel" }, persona: { id: SELF, type: "partner" } } }],
    })]);
    expect(subscribes()).toHaveLength(3);
    chat.stopRealtime();
  });

  it("an answer applied outside the bus resubscribes through noteMembershipChange", async () => {
    fakeOdoo();
    const { subscribes } = await openBus();
    const before = await chat.memberChannelIds(config);
    expect(chat.noteMembershipChange(config, before, new Set(before))).toBe(false);
    await chat.repo.applyDelta(config, parseStore(newConversation(23, "group", [BOB]), config, SELF));
    expect(chat.noteMembershipChange(config, before, await chat.memberChannelIds(config))).toBe(true);
    await vi.waitFor(() => expect(subscribes()).toHaveLength(2));
    chat.stopRealtime();
  });

  it("leave resubscribes", async () => {
    fakeOdoo();
    const { subscribes, deliver } = await openBus();
    await deliver([bus(1001, "discuss.channel/leave", { "discuss.channel": [{ id: QUIET, is_pinned: false, isLocallyPinned: false }] })]);
    expect(subscribes()).toHaveLength(2);
    // A joined delivery resubscribes once, after the reload it runs
    await deliver([bus(1002, "discuss.channel/joined", { channel: { id: 16, model: "discuss.channel" } })]);
    expect(subscribes()).toHaveLength(3);
    chat.stopRealtime();
  });

  it("presence channels include group members, never self nor a partner without a user", async () => {
    const odoo = fakeOdoo();
    odoo.state.data["discuss.channel.member"].push({ id: 190, thread: { id: GROUP, model: "discuss.channel" }, persona: { id: 5, type: "partner" } });
    odoo.state.data["res.partner"].push({ id: 5, name: "Carol", im_status: "away" }, { id: 6, name: "Contact", im_status: "im_partner" });
    const { subscribes } = await openBus();
    const first = subscribes()[0];
    expect(first).toEqual(expect.arrayContaining(["odoo-presence-res.partner_4", "odoo-presence-res.partner_5"]));
    expect(first).not.toContain(`odoo-presence-res.partner_${SELF}`);
    expect(first).not.toContain("odoo-presence-res.partner_6");
    expect(new Set(first).size).toBe(first.length);
    chat.stopRealtime();
  });

  it("presence keeps the PRESENCE_CAP partners of the most recent conversations", async () => {
    fakeOdoo();
    await chat.load(await source());
    // A partner of no conversation (an author, a search hit) ranks after every member, whatever its id
    const LONE = 90000;
    await chat.repo.applyDelta(config, parseStore({ "res.partner": [{ id: LONE, name: "Lone", im_status: "offline" }] }, config, SELF));
    expect(await chat.presenceChannels(config)).toEqual([`odoo-presence-res.partner_${BOB}`, `odoo-presence-res.partner_${LONE}`]);
    // One group per partner, all more recent than BOB's, the later the more recent; the newest holds two partners at one interest
    const n = PRESENCE_CAP + 5;
    for (let i = 0; i < n; i++) {
      const id = 1000 + i;
      const others = i === n - 1 ? [20001, 20002] : [10000 + i];
      const dt = `2026-11-${String(1 + Math.floor(i / 10)).padStart(2, "0")} ${String(i % 10).padStart(2, "0")}:00:00`;
      await chat.repo.applyDelta(config, parseStore(newConversation(id, "group", others), config, SELF));
      await chat.repo.patchChannel(config, id, { lastInterestDt: dt });
    }
    const channels = await chat.presenceChannels(config);
    expect(channels).toHaveLength(PRESENCE_CAP);
    // The same interest: the higher partner id first
    expect(channels.slice(0, 2)).toEqual(["odoo-presence-res.partner_20002", "odoo-presence-res.partner_20001"]);
    // Out first: LONE, then BOB (older conversations), then the partners of the oldest groups
    expect(channels).not.toContain(`odoo-presence-res.partner_${LONE}`);
    expect(channels).not.toContain(`odoo-presence-res.partner_${BOB}`);
    const singles = n - 1;
    const firstKept = singles - (PRESENCE_CAP - 2);
    expect(channels).not.toContain(`odoo-presence-res.partner_${10000 + firstKept - 1}`);
    expect(channels.at(-1)).toBe(`odoo-presence-res.partner_${10000 + firstKept}`);
  });

  it("global mute from settings mutes every conversation and clears", async () => {
    fakeOdoo();
    await chat.load(await source());
    expect(await chat.unreadTotal()).toBe(7);
    const changes: any[] = [];
    chat.onChange = (c, ch) => changes.push([c, ch]);
    await chat.applyBus(config, [bus(1001, "res.users.settings", { id: 1, mute_until_dt: "9999-12-31 23:59:59" })]);
    expect(changes).toEqual([[config, null]]);
    const muted = await chat.repo.sourceState(config);
    expect(muted.globalMuteUntil).toBe("9999-12-31 23:59:59");
    expect(muted.globalMuteAt).not.toBeNull();
    // Only the inbox remainder is left
    expect(await chat.unreadTotal()).toBe(1);
    // Settings without the mute key leave it as it is
    await chat.applyBus(config, [bus(1002, "res.users.settings", { id: 1, channel_notifications: "mentions" })]);
    expect((await chat.repo.sourceState(config)).globalMuteUntil).toBe("9999-12-31 23:59:59");
    // A replay older than the load changes nothing
    await chat.applyBus(config, [bus(998, "res.users.settings", { id: 1, mute_until_dt: false })]);
    expect((await chat.repo.sourceState(config)).globalMuteUntil).toBe("9999-12-31 23:59:59");
    await chat.applyBus(config, [bus(1003, "res.users.settings", { id: 1, mute_until_dt: false })]);
    expect((await chat.repo.sourceState(config)).globalMuteUntil).toBeNull();
    expect(await chat.unreadTotal()).toBe(7);
  });

  it("new_message on a non-member cached channel reloads nothing", async () => {
    const odoo = fakeOdoo();
    await chat.load(await source());
    await chat.applyBus(config, [bus(1001, "mail.record/insert", { "discuss.channel": [{ id: 15, channel_type: "channel", name: "Public" }] })]);
    const loads = odoo.on("/mail/data").length;
    const changes: any[] = [];
    chat.onChange = (c, ch) => changes.push([c, ch]);
    for (let i = 0; i < 5; i++) {
      await chat.applyBus(config, [bus(1002 + i, "discuss.channel/new_message", { id: 15, data: { "mail.message": [msg(900 + i, 15)] } })]);
    }
    expect(odoo.on("/mail/data")).toHaveLength(loads);
    expect(await chat.repo.messages(config, 15)).toEqual([]);
    expect(await chat.repo.channel(config, 15)).toMatchObject({ unreadCounter: 0, lastMessageId: null });
    expect(changes).toEqual([]);
  });

  it("unknown channels reload at most once per window", async () => {
    const odoo = fakeOdoo();
    await chat.load(await source());
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const loads = () => odoo.on("/mail/data").length;
    const before = loads();
    const unknown = (busId: number, channelId: number) =>
      bus(busId, "discuss.channel/new_message", { id: channelId, data: { "mail.message": [msg(busId, channelId)] } });
    await chat.applyBus(config, [unknown(1001, 30), unknown(1002, 31)]);
    await chat.applyBus(config, [unknown(1003, 32)]);
    expect(loads()).toBe(before + 1);
    // What the window held back is loaded once at its end
    clock = new Date(clock.getTime() + RELOAD_WINDOW_MS);
    await vi.advanceTimersByTimeAsync(RELOAD_WINDOW_MS);
    await vi.waitFor(() => expect(loads()).toBe(before + 2));
    await vi.advanceTimersByTimeAsync(RELOAD_WINDOW_MS);
    expect(loads()).toBe(before + 2);
    // Past the window, an unknown channel reloads at once
    clock = new Date(clock.getTime() + RELOAD_WINDOW_MS);
    await chat.applyBus(config, [unknown(1004, 33)]);
    expect(loads()).toBe(before + 3);
  });

  it("a hidden DM keeps its history across a load and shows again on a fresh message only", async () => {
    const odoo = fakeOdoo();
    const src = await source();
    await chat.load(src);
    await chat.loadOlder(src, CHAT);
    const cached = (await chat.repo.messages(config, CHAT)).length;
    expect(cached).toBeGreaterThan(1);
    await chat.applyBus(config, [bus(1001, "discuss.channel/unpin", { id: CHAT })]);
    // /mail/data leaves a hidden chat out
    const data = odoo.state.data;
    data["discuss.channel"] = data["discuss.channel"].filter((c: any) => c.id !== CHAT);
    data["discuss.channel.member"] = data["discuss.channel.member"].filter((m: any) => m.thread.id !== CHAT);
    data["mail.message"] = data["mail.message"].filter((m: any) => m.thread.id !== CHAT);
    const before = await chat.memberChannelIds(config);
    const resubscribe = vi.spyOn(chat, "resubscribe");
    await chat.load(src);
    expect(resubscribe).not.toHaveBeenCalled();
    expect(await chat.memberChannelIds(config)).toEqual(before);
    expect(await chat.repo.channel(config, CHAT)).toMatchObject({ isMember: true, isPinned: false });
    expect(await chat.repo.messages(config, CHAT)).toHaveLength(cached);
    expect(await chat.repo.members(config, CHAT)).toHaveLength(2);
    expect((await chat.conversations()).map((c) => c.channelId)).not.toContain(CHAT);
    // A replay at or below the load's bus id shows nothing again
    await chat.applyBus(config, [
      bus(999, "mail.record/insert", { "discuss.channel": [{ id: CHAT, is_pinned: true }] }),
      bus(1000, "discuss.channel/new_message", { id: CHAT, data: { "mail.message": [msg(81, CHAT)] } }),
    ]);
    expect((await chat.conversations()).map((c) => c.channelId)).not.toContain(CHAT);
    // A fresh message is a post: the chat shows again, with no reload
    const loads = odoo.on("/mail/data").length;
    await chat.applyBus(config, [bus(1002, "discuss.channel/new_message", { id: CHAT, data: { "mail.message": [msg(82, CHAT)] } })]);
    expect((await chat.conversations()).map((c) => c.channelId)).toContain(CHAT);
    expect(odoo.on("/mail/data")).toHaveLength(loads);
  });

  it("a mute changed while a load reads /mail/data is in what the load writes", async () => {
    const odoo = fakeOdoo();
    const src = await source();
    await chat.load(src);
    expect((await chat.repo.sourceState(config)).globalMuteUntil).toBeNull();
    let release!: () => void;
    odoo.state.hold = new Promise<void>((r) => (release = r));
    const loading = chat.load(src);
    await vi.waitFor(() => expect(odoo.on("/mail/data")).toHaveLength(2));
    // Muted on the server now: its bus event falls at or below the inbox bus id this load sets
    odoo.state.sessionMute = "9999-12-31 23:59:59";
    release();
    await loading;
    expect((await chat.repo.sourceState(config)).globalMuteUntil).toBe("9999-12-31 23:59:59");
  });

  it("stopping realtime cancels a reload the window still owes", async () => {
    const odoo = fakeOdoo();
    await chat.load(await source());
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const unknown = (busId: number, channelId: number) =>
      bus(busId, "discuss.channel/new_message", { id: channelId, data: { "mail.message": [msg(busId, channelId)] } });
    const before = odoo.on("/mail/data").length;
    await chat.applyBus(config, [unknown(1001, 30), unknown(1002, 31)]);
    expect(odoo.on("/mail/data")).toHaveLength(before + 1);
    chat.stopSourceRealtime(config);
    await vi.advanceTimersByTimeAsync(2 * RELOAD_WINDOW_MS);
    expect(odoo.on("/mail/data")).toHaveLength(before + 1);
    clock = new Date(clock.getTime() + RELOAD_WINDOW_MS);
    await chat.applyBus(config, [unknown(1003, 32)]);
    clock = new Date(clock.getTime() + 1);
    await chat.applyBus(config, [unknown(1004, 33)]);
    chat.stopRealtime();
    await vi.advanceTimersByTimeAsync(2 * RELOAD_WINDOW_MS);
    expect(odoo.on("/mail/data")).toHaveLength(before + 2);
  });

  it("load keeps a channel being created offline", async () => {
    fakeOdoo();
    const src = await source();
    await chat.load(src);
    await chat.repo.applyDelta(config, {
      ...parseStore({ "discuss.channel": [{ id: -1, channel_type: "group", name: "Offline" }] }, config, SELF),
    });
    await chat.repo.patchChannel(config, -1, { isMember: true, createOpId: "op-create-1" });
    await chat.repo.applyDelta(config, parseStore({ "discuss.channel": [{ id: -2, channel_type: "group", name: "Settled" }] }, config, SELF));
    await chat.load(src);
    expect(await chat.repo.channel(config, -1)).toMatchObject({ name: "Offline", createOpId: "op-create-1" });
    expect(await chat.repo.channel(config, -2)).toBeNull();
  });

  // ─── Lot 2: creates, joins, temporary ids ─────────────────────────────────

  const createCalls = (odoo: ReturnType<typeof fakeOdoo>) =>
    odoo.on("/web/dataset/call_kw").filter((c) => ["channel_get", "create_group", "channel_create"].includes(c.params.method));
  const advance = (ms: number) => { clock = new Date(clock.getTime() + ms); };

  it("direct message reuses a cached chat", async () => {
    const odoo = fakeOdoo();
    const server = createServer(odoo, { now: () => clock });
    server.channels.push({ id: CHAT, type: "chat", name: "", partners: [SELF, BOB], uuid: null, createDate: "2026-10-01 09:00:00" });
    const src = await source();
    await chat.load(src);
    // Shown: returned at once, nothing sent
    expect(await chat.startDirect(src, BOB)).toEqual({ configId: config, channelId: CHAT });
    expect(createCalls(odoo)).toHaveLength(0);
    // Hidden: the same chat, shown again, and pinned on the server through channel_get
    await chat.repo.patchChannel(config, CHAT, { isPinned: false });
    expect(await chat.startDirect(src, BOB)).toEqual({ configId: config, channelId: CHAT });
    expect(createCalls(odoo).map((c) => c.params.kwargs)).toEqual([{ partners_to: [BOB] }]);
    expect(await chat.repo.channel(config, CHAT)).toMatchObject({ isPinned: true, createOpId: null });
    // Nobody cached: a temporary chat, returned again while offline, created once online
    offline();
    const first = await chat.startDirect(src, 7);
    expect(first.channelId).toBeLessThan(0);
    expect(await chat.repo.channel(config, first.channelId)).toMatchObject({ channelType: "chat", correspondentPartnerId: 7, isMember: true });
    expect(await chat.startDirect(src, 7)).toEqual(first);
    online();
    await chat.flushAll();
    await chat.flushAll();
    expect(createCalls(odoo)).toHaveLength(2);
    const realId = (await chat.realIdOf(config, first.channelId))!;
    expect(realId).toBeGreaterThan(0);
    expect(await chat.repo.channel(config, first.channelId)).toBeNull();
    expect(await chat.repo.channel(config, realId)).toMatchObject({ correspondentPartnerId: 7, createOpId: null });
    expect(await chat.startDirect(src, 7)).toEqual({ configId: config, channelId: realId });
    expect(createCalls(odoo)).toHaveLength(2);
  });

  it("a create in the background returns its temporary id before the server answers, then swaps", async () => {
    const odoo = fakeOdoo();
    const server = createServer(odoo, { now: () => clock });
    const src = await source();
    await chat.load(src);
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    server.state.onCreate = () => held;
    const changes: [string, number | null][] = [];
    chat.onChange = (c, ch) => changes.push([c, ch]);
    const opened = await chat.createGroup(src, [BOB, 7], "", { background: true });
    expect(opened.channelId).toBeLessThan(0);
    await vi.waitFor(() => expect(createCalls(odoo)).toHaveLength(1));
    // The server still holds the answer: nothing settled, the screen is already open on the temporary id
    expect(await chat.realIdOf(config, opened.channelId)).toBeNull();
    release();
    await vi.waitFor(async () => expect(await chat.realIdOf(config, opened.channelId)).toBe(server.channels[0].id));
    expect(changes.map(([, ch]) => ch)).toContain(server.channels[0].id);
    // Waiting (the default) returns the server's id
    const waited = await chat.createGroup(src, [BOB], "Waited");
    expect(waited.channelId).toBe(server.channels[1].id);
  });

  it("offline group then posts survive a restart and the id swap", async () => {
    const odoo = fakeOdoo();
    const server = createServer(odoo, { now: () => clock });
    const src = await source();
    await chat.load(src);
    offline();
    const { channelId: tempId } = await chat.createGroup(src, [BOB, 7]);
    await chat.send(src, tempId, "first");
    await chat.send(src, tempId, "second");
    const ops = await env.db.getOutboxOpsForConfig(config);
    const create = ops.find((o) => o.kind === "chat.create")!;
    expect(create.params).toMatchObject({ channelId: tempId, mode: "group", partnerIds: [BOB, 7], name: "", useModule: false });
    const postOf = (text: string) => ops.find((o) => o.kind === "chat.post" && o.params.text === text)!;
    expect(postOf("first").dependsOn).toBe(create.id);
    expect(postOf("second").dependsOn).toBe(postOf("first").id);
    // The nameless group shows its people while only the phone knows it
    expect((await chat.repo.members(config, tempId)).map((m) => m.partnerId)).toEqual([SELF, BOB, 7]);

    // The app is killed: a new service over the same database, then the network is back
    chat.dispose();
    const rpc = new OdooRpcClient();
    chat = new ChatService(env.db, rpc, new OutboxService(env.db, () => clock), new CapabilityService(env.db, rpc), () => clock);
    online();
    await chat.flushAll();

    expect(server.channels).toHaveLength(1);
    const realId = server.channels[0].id;
    expect(createCalls(odoo)).toHaveLength(1);
    const sent = odoo.on("/mail/message/post");
    expect(sent.map((c) => c.params.thread_id)).toEqual([realId, realId]);
    expect(sent.map((c) => c.params.post_data.body.split("<!--")[0])).toEqual(["first", "second"]);
    expect(await chat.repo.channel(config, tempId)).toBeNull();
    expect(await chat.repo.channel(config, realId)).toMatchObject({ channelType: "group", isMember: true, createOpId: null });
    expect((await chat.messages(config, realId)).map((m) => m.status)).toEqual(["sent", "sent"]);
    expect(await chat.messages(config, tempId)).toEqual([]);
    expect((await chat.repo.members(config, realId)).every((m) => m.memberId > 0)).toBe(true);
    expect(await env.db.getOutboxOpsForConfig(config)).toHaveLength(0);
    expect((await chat.realIdOf(config, tempId))).toBe(realId);
    // A post from a screen still on the temporary id goes to the group
    await chat.send(src, tempId, "third");
    expect(odoo.on("/mail/message/post").at(-1)!.params.thread_id).toBe(realId);
  });

  it("group create lost response with module adopts", async () => {
    const odoo = fakeOdoo();
    const server = createServer(odoo, { module: true, now: () => clock });
    const src = await source();
    await chat.load(src);
    await chat.repo.setSourceState({ configId: config, moduleState: "installed", moduleLevel: "1.2" });
    server.state.dropNext = 1;
    const { channelId: tempId } = await chat.createGroup(src, [BOB], "Team B");
    expect(tempId).toBeLessThan(0);
    expect(server.channels).toHaveLength(1);
    // Inside the quiet window nothing is sent again
    advance(60_000);
    await chat.flushAll({ force: true });
    expect(createCalls(odoo)).toHaveLength(1);
    advance(3 * 60_000);
    await chat.flushAll({ force: true });
    const calls = createCalls(odoo);
    expect(calls).toHaveLength(2);
    expect(calls[0].params.kwargs).toMatchObject({ partners_to: [BOB], name: "Team B", context: { erplibre_client_uuid: expect.any(String) } });
    expect(calls[1].params.kwargs.context).toEqual(calls[0].params.kwargs.context);
    expect(server.channels).toHaveLength(1);
    expect((await chat.realIdOf(config, tempId))).toBe(server.channels[0].id);
    expect(odoo.kw("search_read").filter((c) => c.params.model === "discuss.channel")).toHaveLength(0);
  });

  it("group create lost response without module adopts by fingerprint after the quiet window", async () => {
    const odoo = fakeOdoo();
    const server = createServer(odoo, { now: () => clock });
    const src = await source();
    await chat.load(src);
    // Same type, created in the window, other members: not this create
    server.make("group", "", [7], null);
    server.state.dropNext = 1;
    const { channelId: tempId } = await chat.createGroup(src, [BOB, 8]);
    await chat.send(src, tempId, "hello");
    expect(server.channels).toHaveLength(2);
    expect(odoo.on("/mail/message/post")).toHaveLength(0);
    const sentAt = (await env.db.getOutboxOpsForConfig(config)).find((o) => o.kind === "chat.create")!.params.createSentAt;
    advance(3 * 60_000 + 1);
    await chat.flushAll();
    expect(createCalls(odoo)).toHaveLength(1);
    const search = odoo.kw("search_read").find((c) => c.params.model === "discuss.channel")!;
    const at = (ms: number) => new Date(new Date(sentAt).getTime() + ms).toISOString().slice(0, 19).replace("T", " ");
    expect(search.params.kwargs.domain).toEqual([
      ["create_uid", "=", 2], ["channel_type", "=", "group"],
      ["create_date", ">=", at(-5 * 60_000)], ["create_date", "<=", at(3 * 60_000 + 5 * 60_000)],
      ["is_member", "=", true],
    ]);
    // Every hit is compared on its members: no limit cuts the list first
    expect(search.params.kwargs.limit).toBeUndefined();
    const realId = server.channels[1].id;
    expect(odoo.on("/discuss/channel/info").map((c) => c.params)).toEqual([{ channel_id: realId }]);
    expect((await chat.realIdOf(config, tempId))).toBe(realId);
    expect(odoo.on("/mail/message/post").map((c) => c.params.thread_id)).toEqual([realId]);
    expect(server.channels).toHaveLength(2);
  });

  it("two fingerprint matches block ambiguous", async () => {
    const odoo = fakeOdoo();
    const server = createServer(odoo, { now: () => clock });
    const src = await source();
    await chat.load(src);
    server.state.dropNext = 1;
    const { channelId: tempId } = await chat.createChannel(src, "Ops", 11);
    await chat.send(src, tempId, "hello");
    // The same channel created again in the window (another device of the user)
    server.make("channel", "Ops", [], null);
    advance(3 * 60_000 + 1);
    await chat.flushAll();
    const ops = await env.db.getOutboxOpsForConfig(config);
    const create = ops.find((o) => o.kind === "chat.create")!;
    const post = ops.find((o) => o.kind === "chat.post")!;
    expect(create).toMatchObject({ kind: "chat.create", status: "blocked" });
    expect(create.params).toMatchObject({ blockedReason: "ambiguous", candidates: server.channels.map((c) => c.id) });
    expect(post).toMatchObject({ kind: "chat.post", status: "queued" });
    expect(createCalls(odoo)).toHaveLength(1);
    expect(odoo.on("/mail/message/post")).toHaveLength(0);
    expect(await chat.repo.channel(config, tempId)).toMatchObject({ name: "Ops", createOpId: create.id });
  });

  it("bus insert before settle merges into one row", async () => {
    const odoo = fakeOdoo();
    const server = createServer(odoo, { now: () => clock });
    const src = await source();
    await chat.load(src);
    server.state.onCreate = (store) => chat.applyBus(config, [bus(1001, "mail.record/insert", store)]);
    const before = (await chat.repo.channels(config)).length;
    const { channelId } = await chat.createGroup(src, [BOB], "Fresh");
    const realId = server.channels[0].id;
    expect(channelId).toBe(realId);
    const rows = (await chat.repo.channels(config)).filter((c) => c.name === "Fresh");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ channelId: realId, isMember: true, createOpId: null });
    expect(await chat.repo.channels(config)).toHaveLength(before + 1);
    expect((await chat.repo.members(config, realId)).map((m) => m.partnerId).sort()).toEqual([SELF, BOB]);
  });

  it("join then a message arrives live", async () => {
    const odoo = fakeOdoo();
    const server = createServer(odoo, { now: () => clock });
    const pub = server.make("channel", "Public", [], null);
    pub.partners = [BOB];
    const { subscribes, deliver } = await openBus();
    const loads = odoo.on("/mail/data").length;
    const src = (await chat.sources({ online: false }))[0];
    expect(await chat.join(src, pub.id, "Public")).toEqual({ configId: config, channelId: pub.id });
    expect(odoo.on("/discuss/channel/join").map((c) => c.params)).toEqual([{ channel_id: pub.id }]);
    expect(await chat.repo.channel(config, pub.id)).toMatchObject({ isMember: true, createOpId: null, name: "Public" });
    await vi.waitFor(() => expect(subscribes()).toHaveLength(2));
    await deliver([bus(1001, "discuss.channel/new_message", { id: pub.id, data: { "mail.message": [msg(950, pub.id)] } })]);
    expect((await chat.messages(config, pub.id)).map((m) => m.messageId)).toEqual([950]);
    expect(odoo.on("/mail/data")).toHaveLength(loads);
    // Joining again is the same membership: the route answers it as it is
    await chat.join(src, pub.id);
    expect(server.channels[0].partners.filter((p) => p === SELF)).toHaveLength(1);
    chat.stopRealtime();
  });

  it("refused create fails its queued posts with a notice", async () => {
    const odoo = fakeOdoo();
    const server = createServer(odoo, { now: () => clock });
    const src = await source();
    await chat.load(src);
    offline();
    const { channelId: tempId } = await chat.createChannel(src, "Secret", 99);
    await chat.send(src, tempId, "one");
    await chat.send(src, tempId, "two");
    server.state.refuse = "odoo.exceptions.AccessError";
    online();
    await chat.flushAll();
    expect(odoo.on("/mail/message/post")).toHaveLength(0);
    expect(await env.db.getOutboxOpsForConfig(config)).toHaveLength(0);
    // Still listed, marked failed, with its texts readable
    expect(await chat.repo.channel(config, tempId)).toMatchObject({ name: "Secret", createFailed: true, createOpId: null });
    expect((await chat.conversations()).map((c) => c.channelId)).toContain(tempId);
    const kept = await chat.messages(config, tempId);
    expect(kept.map((m) => [m.status, m.outboxOpId, m.body])).toEqual([["failed", null, "one"], ["failed", null, "two"]]);
    // A load keeps it; a post written into it now fails at once and queues nothing
    await chat.load(src);
    expect(await chat.repo.channel(config, tempId)).toMatchObject({ createFailed: true });
    const late = await chat.send(src, tempId, "three");
    expect(late.status).toBe("failed");
    expect(await env.db.getOutboxOpsForConfig(config)).toHaveLength(0);
    // Another create of the account never reuses its id
    offline();
    const next = await chat.createGroup(src, [BOB]);
    expect(next.channelId).not.toBe(tempId);
    // Dismissing removes it with its texts
    await chat.discardCreate(config, tempId);
    expect(await chat.repo.channel(config, tempId)).toBeNull();
    expect(await chat.messages(config, tempId)).toEqual([]);
    expect((await chat.conversations()).map((c) => c.channelId)).not.toContain(tempId);
  });

  it("a refused join stays listed as failed until dismissed", async () => {
    const odoo = fakeOdoo();
    createServer(odoo, { now: () => clock });
    const src = await source();
    await chat.load(src);
    await chat.join(src, 77, "Gone");
    expect(await chat.repo.channel(config, 77)).toMatchObject({ name: "Gone", createFailed: true, isMember: true });
    expect(await env.db.getOutboxOpsForConfig(config)).toHaveLength(0);
    // With no text in it, only the flag keeps it across a load
    await chat.load(src);
    expect(await chat.repo.channel(config, 77)).toMatchObject({ createFailed: true });
    await chat.discardCreate(config, 77);
    expect(await chat.repo.channel(config, 77)).toBeNull();
  });

  it("a discarded create takes its posts out of the outbox", async () => {
    fakeOdoo();
    const src = await source();
    await chat.load(src);
    offline();
    const { channelId: tempId } = await chat.createGroup(src, [BOB]);
    await chat.send(src, tempId, "draft");
    await chat.discardCreate(config, tempId);
    expect(await env.db.getOutboxOpsForConfig(config)).toHaveLength(0);
    expect(await chat.repo.channel(config, tempId)).toBeNull();
    expect(await chat.messages(config, tempId)).toEqual([]);
  });

  it("a temporary id resolves after a restart, and one with nothing behind it never reaches the server", async () => {
    const odoo = fakeOdoo();
    createServer(odoo, { now: () => clock });
    const src = await source();
    await chat.load(src);
    const { channelId: realId } = await chat.createGroup(src, [BOB], "Kept");
    const tempId = (await env.db.rawQuery("SELECT temp_id FROM chat_temp_ids"))[0].temp_id;
    chat.dispose();
    const rpc = new OdooRpcClient();
    chat = new ChatService(env.db, rpc, new OutboxService(env.db, () => clock), new CapabilityService(env.db, rpc), () => clock);
    expect(await chat.realIdOf(config, tempId)).toBe(realId);
    await chat.send(src, tempId, "after restart");
    expect(odoo.on("/mail/message/post").at(-1)!.params.thread_id).toBe(realId);
    // A negative id never created on this phone: the text fails, nothing is queued or sent
    const posts = odoo.on("/mail/message/post").length;
    const lost = await chat.send(src, -123, "nowhere");
    expect(lost).toMatchObject({ status: "failed", outboxOpId: null, channelId: -123 });
    expect(await env.db.getOutboxOpsForConfig(config)).toHaveLength(0);
    expect(odoo.on("/mail/message/post")).toHaveLength(posts);
  });

  it("a create cut between its op and its row is queued, or removed, at startup", async () => {
    const odoo = fakeOdoo();
    const server = createServer(odoo, { now: () => clock });
    const src = await source();
    await chat.load(src);
    offline();
    const { channelId: tempId } = await chat.createGroup(src, [BOB], "Cut");
    const [op] = await env.db.getOutboxOpsForConfig(config);
    await env.db.updateOutboxOp(op.id, { status: "incomplete", updatedAt: clock.toISOString() });
    // An op whose row never got written
    const orphan = await new OutboxService(env.db, () => clock).enqueue({
      noteId: "chat", configId: config, kind: "chat.create", status: "incomplete",
      params: { channelId: tempId - 1, mode: "group", partnerIds: [BOB], name: "", groupId: false, useModule: false },
    });
    expect(await chat.recover()).toBe(1);
    const ops = await env.db.getOutboxOpsForConfig(config);
    expect(ops.map((o) => [o.id, o.status])).toEqual([[op.id, "queued"]]);
    expect(ops.some((o) => o.id === orphan.id)).toBe(false);
    online();
    await chat.flushAll();
    expect(server.channels.map((c) => c.name)).toEqual(["Cut"]);
    expect(await chat.realIdOf(config, tempId)).toBe(server.channels[0].id);
  });

  it("typing is never sent for a conversation still being created", async () => {
    const odoo = fakeOdoo();
    const src = await source();
    await chat.load(src);
    offline();
    const { channelId: tempId } = await chat.createGroup(src, [BOB]);
    online();
    chat.isOnline = async () => true;
    await chat.typing(src, tempId, true);
    expect(odoo.on("/discuss/channel/notify_typing")).toHaveLength(0);
  });

  it("fingerprint ignores conversations outside the window and those another create took", async () => {
    const odoo = fakeOdoo();
    const server = createServer(odoo, { now: () => clock });
    const src = await source();
    await chat.load(src);
    server.state.dropNext = 1;
    // The create runs on the server but its answer is lost: that group is then claimed by another create of the phone
    await chat.createGroup(src, [BOB]);
    const lost = server.channels[0];
    await chat.repo.rememberRealId(config, -999, lost.id);
    // Same people, created much later: past the latest moment the lost send could have run
    const later = server.make("group", "", [BOB], null);
    later.createDate = "2026-10-25 11:00:00";
    advance(3 * 60_000 + 1);
    await chat.flushAll();
    expect(createCalls(odoo)).toHaveLength(2);
    expect(server.channels).toHaveLength(3);
    expect(odoo.on("/discuss/channel/info")).toHaveLength(0);
  });

  it("bus first: the real channel and its message arrive before the create answers, posts move to it", async () => {
    const odoo = fakeOdoo();
    const server = createServer(odoo, { now: () => clock });
    const src = await source();
    await chat.load(src);
    offline();
    const { channelId: tempId } = await chat.createChannel(src, "Live", 11);
    await chat.send(src, tempId, "a");
    await chat.send(src, tempId, "b");
    server.state.onCreate = async (store) => {
      const id = store["discuss.channel"][0].id;
      await chat.applyBus(config, [
        bus(1001, "mail.record/insert", store),
        bus(1002, "discuss.channel/new_message", { id, data: { "mail.message": [msg(940, id, SELF, "<div>created this channel.</div>")] } }),
      ]);
    };
    online();
    await chat.flushAll();
    const realId = server.channels[0].id;
    const rows = (await chat.repo.channels(config)).filter((c) => c.name === "Live");
    expect(rows.map((c) => [c.channelId, c.createOpId, c.lastMessageId])).toEqual([[realId, null, 940]]);
    expect(odoo.on("/mail/message/post").map((c) => [c.params.thread_id, c.params.post_data.body.split("<!--")[0]]))
      .toEqual([[realId, "a"], [realId, "b"]]);
    const thread = await chat.messages(config, realId);
    expect(thread.map((m) => m.messageId)).toEqual([940, 5000, 5001]);
    expect(await chat.messages(config, tempId)).toEqual([]);
  });

  it("a create killed while running is adopted after the quiet window, one conversation", async () => {
    const odoo = fakeOdoo();
    const server = createServer(odoo, { now: () => clock });
    const src = await source();
    await chat.load(src);
    // The app dies while create_group is on the server: no answer ever comes back
    server.state.onCreate = async () => { throw new TypeError("Failed to fetch"); };
    const { channelId: tempId } = await chat.createGroup(src, [BOB, 7]);
    await chat.send(src, tempId, "queued");
    const [create] = (await env.db.getOutboxOpsForConfig(config)).filter((o) => o.kind === "chat.create");
    await env.db.updateOutboxOp(create.id, { status: "running", updatedAt: clock.toISOString() });
    server.state.onCreate = null;
    chat.dispose();
    const rpc = new OdooRpcClient();
    const outbox = new OutboxService(env.db, () => clock);
    chat = new ChatService(env.db, rpc, outbox, new CapabilityService(env.db, rpc), () => clock);
    expect(await outbox.recoverInterrupted()).toBe(1);
    await chat.recover();
    await chat.flushAll();
    expect(createCalls(odoo)).toHaveLength(1);
    advance(3 * 60_000 + 1);
    await chat.flushAll();
    expect(createCalls(odoo)).toHaveLength(1);
    expect(server.channels).toHaveLength(1);
    const realId = server.channels[0].id;
    expect(await chat.realIdOf(config, tempId)).toBe(realId);
    expect(odoo.on("/mail/message/post").map((c) => c.params.thread_id)).toEqual([realId]);
    expect(await env.db.getOutboxOpsForConfig(config)).toHaveLength(0);
  });

  it("a kill between the stored pair and the swap: the retry settles on the same group, swapped", async () => {
    const odoo = fakeOdoo();
    const server = createServer(odoo, { now: () => clock });
    const src = await source();
    await chat.load(src);
    offline();
    const { channelId: tempId } = await chat.createGroup(src, [BOB, 7]);
    await chat.send(src, tempId, "queued");
    online();
    // The app dies once the pair is stored, before the swap rewrites the rows
    const swap = vi.spyOn(chat.repo, "swapChannelId").mockRejectedValueOnce(new Error("killed"));
    await chat.flushAll();
    expect(server.channels).toHaveLength(1);
    const realId = server.channels[0].id;
    expect(await chat.realIdOf(config, tempId)).toBe(realId);
    expect(await chat.repo.channel(config, tempId)).not.toBeNull();
    swap.mockRestore();
    const [create] = (await env.db.getOutboxOpsForConfig(config)).filter((o) => o.kind === "chat.create");
    expect(create.params.channelId).toBe(tempId);
    await env.db.updateOutboxOp(create.id, { status: "running", updatedAt: clock.toISOString() });
    chat.dispose();
    const rpc = new OdooRpcClient();
    const outbox = new OutboxService(env.db, () => clock);
    chat = new ChatService(env.db, rpc, outbox, new CapabilityService(env.db, rpc), () => clock);
    expect(await outbox.recoverInterrupted()).toBe(1);
    advance(3 * 60_000 + 1);
    await chat.flushAll();
    // The fingerprint search takes the group the pair names, not a second one
    expect(server.channels).toHaveLength(1);
    expect(createCalls(odoo)).toHaveLength(1);
    expect(await chat.repo.channel(config, tempId)).toBeNull();
    expect(await chat.repo.channel(config, realId)).toMatchObject({ isMember: true, createOpId: null });
    expect(odoo.on("/mail/message/post").map((c) => c.params.thread_id)).toEqual([realId]);
    expect(await env.db.getOutboxOpsForConfig(config)).toHaveLength(0);
  });

  // ─── Lot 2: invite, rename, describe, leave, hide, mute, remove ───────────

  const kwOf = (odoo: ReturnType<typeof fakeOdoo>, method: string) =>
    odoo.kw(method).map((c) => [c.params.args, c.params.kwargs]);
  const actionOps = async () => (await env.db.getOutboxOpsForConfig(config)).filter((o) => o.kind !== CHAT_READ);

  it("each management action sends its Odoo call", async () => {
    const odoo = fakeOdoo();
    const src = await source();
    await chat.load(src);
    await chat.repo.setSourceState({ configId: config, moduleState: "installed", moduleLevel: "1.2", isSystem: true });
    await chat.invite(src, GROUP, [7, 8]);
    await chat.rename(src, GROUP, "  Crew ");
    await chat.rename(src, CHAT, "Pal");
    await chat.describe(src, GENERAL, "News");
    await chat.hide(src, CHAT);
    await chat.removeMember(src, GROUP, BOB);
    await chat.mute(src, GENERAL, 60);
    await chat.globalMute(src, 15);
    await chat.leave(src, QUIET);
    expect(kwOf(odoo, "add_members")).toEqual([[[[GROUP]], { partner_ids: [7, 8] }]]);
    expect(kwOf(odoo, "channel_rename")).toEqual([[[[GROUP]], { name: "Crew" }]]);
    expect(kwOf(odoo, "channel_set_custom_name")).toEqual([[[[CHAT]], { name: "Pal" }]]);
    expect(kwOf(odoo, "channel_change_description")).toEqual([[[[GENERAL]], { description: "News" }]]);
    expect(kwOf(odoo, "channel_pin")).toEqual([[[CHAT], { pinned: false }]]);
    expect(kwOf(odoo, "erplibre_remove_member")).toEqual([[[[GROUP], BOB], {}]]);
    expect(kwOf(odoo, "action_unfollow")).toEqual([[[QUIET], {}]]);
    expect(odoo.on("/discuss/settings/mute").map((c) => c.params)).toEqual([
      { minutes: 60, channel_id: GENERAL },
      { minutes: 15 },
    ]);
    expect(await env.db.getOutboxOpsForConfig(config)).toHaveLength(0);
    // Applied on the phone at once
    expect(await chat.repo.channel(config, GROUP)).toMatchObject({ name: "Crew" });
    expect(await chat.repo.channel(config, CHAT)).toMatchObject({ customChannelName: "Pal", isPinned: false });
    expect(await chat.repo.channel(config, GENERAL)).toMatchObject({ description: "News", muteUntilDt: "2026-10-25 11:00:00" });
    expect(await chat.repo.channel(config, QUIET)).toMatchObject({ isMember: false, leftUnsent: false });
    expect(await chat.repo.sourceState(config)).toMatchObject({
      globalMuteUntil: "2026-10-25 10:15:00", globalMuteAt: clock.toISOString(),
    });
    expect((await chat.conversations()).map((c) => c.channelId)).not.toContain(QUIET);
    expect((await chat.conversations()).map((c) => c.channelId)).not.toContain(CHAT);
    // A channel keeps a name; a group may go back to its members' names
    await expect(chat.rename(src, GENERAL, "  ")).rejects.toThrow();
    await chat.rename(src, GROUP, "");
    expect(kwOf(odoo, "channel_rename").at(-1)).toEqual([[[GROUP]], { name: "" }]);
  });

  it("target-state actions coalesce one op per conversation, and a load keeps their local value", async () => {
    const odoo = fakeOdoo();
    const src = await source();
    await chat.load(src);
    offline();
    await chat.rename(src, GROUP, "First");
    await chat.rename(src, GROUP, "Last");
    await chat.invite(src, GROUP, [7]);
    await chat.invite(src, GROUP, [8, 7]);
    await chat.mute(src, GENERAL, 60);
    await chat.mute(src, GENERAL, 15);
    await chat.globalMute(src, 60);
    await chat.globalMute(src, false);
    const ops = await actionOps();
    expect(ops.map((o) => o.kind).sort()).toEqual(["chat.global_mute", "chat.invite", "chat.mute", "chat.rename"]);
    // The server's older values do not undo what the phone shows
    await chat.load(src);
    expect(await chat.repo.channel(config, GROUP)).toMatchObject({ name: "Last" });
    expect(await chat.repo.channel(config, GENERAL)).toMatchObject({ muteUntilDt: "2026-10-25 10:15:00" });
    odoo.state.sessionMute = "2026-10-25 12:00:00";
    await chat.load(src);
    expect((await chat.repo.sourceState(config)).globalMuteUntil).toBeNull();
    online();
    await chat.flushAll();
    expect(kwOf(odoo, "channel_rename")).toEqual([[[[GROUP]], { name: "Last" }]]);
    expect(kwOf(odoo, "add_members")).toEqual([[[[GROUP]], { partner_ids: [7, 8] }]]);
    const mutes = odoo.on("/discuss/settings/mute").map((c) => c.params);
    expect(mutes).toHaveLength(2);
    expect(mutes).toEqual(expect.arrayContaining([{ minutes: 15, channel_id: GENERAL }, { minutes: false }]));
  });

  it("an action queued while the same one is on the wire goes after it with its own value", async () => {
    const odoo = fakeOdoo();
    const src = await source();
    await chat.load(src);
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let renamed = 0;
    odoo.state.onKw = async ({ method }) => {
      if (method === "channel_rename" && renamed++ === 0) await held;
      return undefined;
    };
    const first = chat.rename(src, GROUP, "One");
    await vi.waitFor(() => expect(odoo.kw("channel_rename")).toHaveLength(1));
    await chat.rename(src, GROUP, "Two");
    release();
    await first;
    await chat.flushAll();
    expect(kwOf(odoo, "channel_rename").map(([, k]) => k.name)).toEqual(["One", "Two"]);
    expect(await env.db.getOutboxOpsForConfig(config)).toHaveLength(0);
  });

  it("leave cancels the queued posts of that conversation with a notice", async () => {
    const odoo = fakeOdoo();
    const src = await source();
    await chat.load(src);
    offline();
    await chat.send(src, GROUP, "one");
    await chat.send(src, GROUP, "two");
    await chat.send(src, CHAT, "elsewhere");
    await chat.rename(src, GROUP, "Renamed");
    await chat.mute(src, GROUP, 60);
    await chat.leave(src, GROUP);
    const ops = await actionOps();
    expect(ops.map((o) => [o.kind, o.params.channelId]).sort()).toEqual([["chat.leave", GROUP], ["chat.post", CHAT]]);
    // The texts stay readable, failed, out of the outbox; the conversation is listed as left
    const kept = await chat.messages(config, GROUP);
    expect(kept.filter((m) => m.messageId === null).map((m) => [m.status, m.outboxOpId])).toEqual([["failed", null], ["failed", null]]);
    expect(await chat.repo.channel(config, GROUP)).toMatchObject({ isMember: false, leftUnsent: true });
    expect((await chat.conversations()).map((c) => c.channelId)).toContain(GROUP);
    // Its unread no longer counts
    expect(await chat.unreadTotal()).toBe(5);
    // A text written into it now fails at once and queues nothing
    expect((await chat.send(src, GROUP, "three")).status).toBe("failed");
    await expect(chat.rename(src, GROUP, "Again")).rejects.toThrow();
    // A load before the leave is sent does not make it a member again
    await chat.load(src);
    expect(await chat.repo.channel(config, GROUP)).toMatchObject({ isMember: false, leftUnsent: true });
    online();
    await chat.flushAll();
    expect(kwOf(odoo, "action_unfollow")).toEqual([[[GROUP], {}]]);
    expect(odoo.on("/mail/message/post").map((c) => c.params.thread_id)).toEqual([CHAT]);
    expect(odoo.kw("channel_rename")).toHaveLength(0);
    expect(odoo.on("/discuss/settings/mute")).toHaveLength(0);
    // The server's leave keeps the conversation while it holds those texts, and so does a load
    await chat.applyBus(config, [bus(1001, "discuss.channel/leave", { "discuss.channel": [{ id: GROUP, is_pinned: false }] })]);
    const data = odoo.state.data;
    data["discuss.channel"] = data["discuss.channel"].filter((c: any) => c.id !== GROUP);
    data["discuss.channel.member"] = data["discuss.channel.member"].filter((m: any) => m.thread.id !== GROUP);
    data["mail.message"] = data["mail.message"].filter((m: any) => m.thread.id !== GROUP);
    await chat.load(src);
    expect(await chat.repo.channel(config, GROUP)).toMatchObject({ isMember: false, leftUnsent: true });
    expect((await chat.messages(config, GROUP)).filter((m) => m.status === "failed")).toHaveLength(3);
    // Dismissed, it goes with its texts
    await chat.discardCreate(config, GROUP);
    expect(await chat.repo.channel(config, GROUP)).toBeNull();
    expect(await chat.messages(config, GROUP)).toEqual([]);
  });

  it("a post on the wire when leaving is answered first, the leave goes after it", async () => {
    const odoo = fakeOdoo();
    const src = await source();
    await chat.load(src);
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    odoo.state.onPost = async () => { await held; };
    const posting = chat.send(src, GROUP, "on the wire");
    await vi.waitFor(() => expect(odoo.on("/mail/message/post")).toHaveLength(1));
    await chat.leave(src, GROUP);
    expect(kwOf(odoo, "action_unfollow")).toHaveLength(0);
    release();
    await posting;
    await chat.flushAll();
    expect(kwOf(odoo, "action_unfollow")).toEqual([[[GROUP], {}]]);
    expect((await chat.messages(config, GROUP)).at(-1)!.status).toBe("sent");
    // Nothing was lost: the left conversation is not kept listed
    expect(await chat.repo.channel(config, GROUP)).toMatchObject({ isMember: false, leftUnsent: false });
    expect((await chat.conversations()).map((c) => c.channelId)).not.toContain(GROUP);
  });

  it("a post retried after a leave is not sent and keeps the conversation listed as left", async () => {
    const odoo = fakeOdoo();
    const src = await source();
    await chat.load(src);
    odoo.state.onPost = async () => { throw new Error("Server busy"); };
    await chat.send(src, GROUP, "will fail");
    const [post] = await actionOps();
    expect(post.status).toBe("failed");
    // The leave is queued while the post runs again
    await env.db.updateOutboxOp(post.id, { status: "running", updatedAt: clock.toISOString() });
    await chat.leave(src, GROUP);
    await env.db.updateOutboxOp(post.id, { status: "failed", updatedAt: clock.toISOString() });
    odoo.state.onPost = null;
    await chat.flushAll({ force: true });
    expect(odoo.on("/mail/message/post")).toHaveLength(1);
    expect(kwOf(odoo, "action_unfollow")).toEqual([[[GROUP], {}]]);
    expect(await chat.repo.channel(config, GROUP)).toMatchObject({ leftUnsent: true });
    expect((await chat.messages(config, GROUP)).at(-1)).toMatchObject({ status: "failed", outboxOpId: null });
  });

  it("an expired queued mute sends false", async () => {
    const odoo = fakeOdoo();
    const src = await source();
    await chat.load(src);
    offline();
    await chat.mute(src, GENERAL, 15);
    await chat.mute(src, GROUP, 60);
    await chat.globalMute(src, 15);
    expect(await chat.repo.channel(config, GENERAL)).toMatchObject({ muteUntilDt: "2026-10-25 10:15:00" });
    advance(20 * 60_000 + 30_000);
    online();
    await chat.flushAll();
    const sent = odoo.on("/discuss/settings/mute").map((c) => c.params);
    expect(sent).toEqual(expect.arrayContaining([
      { minutes: false, channel_id: GENERAL },
      { minutes: 40, channel_id: GROUP },
      { minutes: false },
    ]));
    expect(sent).toHaveLength(3);
  });

  it("forever mute sends -1, and unmute false", async () => {
    const odoo = fakeOdoo();
    const src = await source();
    await chat.load(src);
    await chat.mute(src, GENERAL, -1);
    expect(await chat.repo.channel(config, GENERAL)).toMatchObject({ muteUntilDt: "9999-12-31 23:59:59" });
    await chat.mute(src, GENERAL, false);
    expect(await chat.repo.channel(config, GENERAL)).toMatchObject({ muteUntilDt: null });
    await chat.globalMute(src, -1);
    expect((await chat.repo.sourceState(config)).globalMuteUntil).toBe("9999-12-31 23:59:59");
    expect(odoo.on("/discuss/settings/mute").map((c) => c.params)).toEqual([
      { minutes: -1, channel_id: GENERAL },
      { minutes: false, channel_id: GENERAL },
      { minutes: -1 },
    ]);
  });

  it("mute is never sent for a non-member channel", async () => {
    const odoo = fakeOdoo();
    const src = await source();
    await chat.load(src);
    await chat.repo.applyDelta(config, parseStore({ "discuss.channel": [{ id: 15, channel_type: "channel", name: "Public" }] }, config, SELF));
    await expect(chat.mute(src, 15, 60)).rejects.toThrow();
    await expect(chat.rename(src, 15, "Mine")).rejects.toThrow();
    await expect(chat.invite(src, 15, [7])).rejects.toThrow();
    expect(await env.db.getOutboxOpsForConfig(config)).toHaveLength(0);
    // A conversation that stops being a member before the mute leaves drops it, with a notice
    offline();
    await chat.mute(src, GENERAL, 60);
    await chat.repo.patchChannel(config, GENERAL, { isMember: false });
    online();
    await chat.flushAll();
    expect(odoo.on("/discuss/settings/mute")).toHaveLength(0);
    const notices = await chat.notices();
    expect(notices).toEqual([expect.objectContaining({ configId: config, kind: "chat.mute", channelId: GENERAL, reason: "vanished" })]);
    await chat.dismissNotice(config, notices[0].id);
    expect(await chat.notices()).toEqual([]);
    expect(await env.db.getOutboxOpsForConfig(config)).toHaveLength(0);
  });

  it("an action of a conversation still being created waits for it and goes to the server id", async () => {
    const odoo = fakeOdoo();
    const server = createServer(odoo, { now: () => clock });
    const src = await source();
    await chat.load(src);
    offline();
    const { channelId: tempId } = await chat.createGroup(src, [BOB]);
    await chat.rename(src, tempId, "Named");
    await chat.mute(src, tempId, 60);
    expect(await chat.repo.channel(config, tempId)).toMatchObject({ name: "Named" });
    online();
    await chat.flushAll();
    const realId = server.channels[0].id;
    expect(kwOf(odoo, "channel_rename")).toEqual([[[[realId]], { name: "Named" }]]);
    expect(odoo.on("/discuss/settings/mute").map((c) => c.params)).toEqual([{ minutes: 60, channel_id: realId }]);
    expect(odoo.on("/discuss/settings/mute").every((c) => c.params.channel_id > 0)).toBe(true);
    // The server's row won the swap, the phone's queued values were laid over it again
    expect(await chat.repo.channel(config, realId)).toMatchObject({ name: "Named", muteUntilDt: "2026-10-25 11:00:00" });
  });

  it("remove refused when not admin or module old", async () => {
    const odoo = fakeOdoo();
    const src = await source();
    await chat.load(src);
    for (const [isSystem, moduleState] of [[false, "installed"], [true, "outdated"], [true, "absent"]] as const) {
      await chat.repo.setSourceState({ configId: config, isSystem, moduleState });
      await expect(chat.removeMember(src, GROUP, BOB)).rejects.toThrow();
    }
    expect(await env.db.getOutboxOpsForConfig(config)).toHaveLength(0);
    expect(odoo.kw("erplibre_remove_member")).toHaveLength(0);
    // An admin with module 1.1 sends it; the server's refusal stays as a notice
    await chat.repo.setSourceState({ configId: config, isSystem: true, moduleState: "installed", moduleLevel: "1.2" });
    odoo.state.onKw = async ({ method }) =>
      (method === "erplibre_remove_member" ? { __error: "odoo.exceptions.UserError" } : undefined);
    await chat.removeMember(src, GROUP, 7);
    expect(kwOf(odoo, "erplibre_remove_member")).toEqual([[[[GROUP], 7], {}]]);
    expect(await chat.notices()).toEqual([expect.objectContaining({ kind: "chat.remove", channelId: GROUP, reason: "refused" })]);
    // Done, the member leaves the cached list
    odoo.state.onKw = null;
    await chat.removeMember(src, GROUP, BOB);
    expect((await chat.repo.members(config, GROUP)).map((m) => m.partnerId)).toEqual([SELF]);
  });

  it("invite into a chat creates a group", async () => {
    const odoo = fakeOdoo();
    const server = createServer(odoo, { now: () => clock });
    const src = await source();
    await chat.load(src);
    const result = await chat.invite(src, CHAT, [7]);
    expect(odoo.kw("add_members")).toHaveLength(0);
    expect(kwOf(odoo, "create_group")).toEqual([[[], { partners_to: [BOB, 7] }]]);
    expect(result).toEqual({ configId: config, channelId: server.channels[0].id });
    expect(await chat.repo.channel(config, result.channelId)).toMatchObject({ channelType: "group" });
  });

  it("a hidden direct message opened again drops its queued hide", async () => {
    const odoo = fakeOdoo();
    createServer(odoo, { now: () => clock });
    const src = await source();
    await chat.load(src);
    offline();
    await chat.hide(src, CHAT);
    await chat.startDirect(src, BOB);
    expect((await actionOps()).map((o) => o.kind)).toEqual(["chat.create"]);
  });

  it("members pages until all are cached", async () => {
    const odoo = fakeOdoo();
    const src = await source();
    await chat.load(src);
    // The server's members of General: self (104, already cached) and four others, two per page
    const all = [104, 201, 202, 203, 204];
    odoo.state.onRoute = async (path, params) => {
      if (path !== "/discuss/channel/members") return undefined;
      const page = all.filter((id) => !params.known_member_ids.includes(id)).slice(0, 2);
      return {
        "discuss.channel": [{ id: params.channel_id, memberCount: all.length }],
        "discuss.channel.member": page.map((id) => ({
          id, thread: { id: params.channel_id, model: "discuss.channel" }, persona: { id: id === 104 ? SELF : id - 100, type: "partner" },
        })),
        "res.partner": page.filter((id) => id !== 104).map((id) => ({ id: id - 100, name: `P${id - 100}` })),
      };
    };
    // A placeholder from an offline create gives way to the server's members
    await chat.repo.applyDelta(config, { ...parseStore({}, config, SELF), members: [{ memberId: -5, channelId: GENERAL, partnerId: 101 }] });
    const members = await chat.members(src, GENERAL);
    expect(members.map((m) => m.memberId).sort()).toEqual(all);
    const asked = odoo.on("/discuss/channel/members").map((c) => c.params);
    expect(asked).toEqual([
      { channel_id: GENERAL, known_member_ids: [104] },
      { channel_id: GENERAL, known_member_ids: [104, 201, 202] },
    ]);
    expect(await chat.repo.channel(config, GENERAL)).toMatchObject({ memberCount: 5 });
    // Offline: the cache alone
    offline();
    expect((await chat.members(src, GENERAL)).map((m) => m.memberId).sort()).toEqual(all);
    expect(odoo.on("/discuss/channel/members")).toHaveLength(2);
  });

  it("a load drops the cached members of a chat or a group it no longer carries, never a channel's", async () => {
    fakeOdoo();
    const src = await source();
    await chat.load(src);
    const memberIds = async (channelId: number) => (await chat.repo.members(config, channelId)).map((m) => m.memberId).sort();
    const before = { group: await memberIds(GROUP), general: await memberIds(GENERAL) };
    // Someone who left the group meanwhile, a channel member read by a members page, a placeholder
    await chat.repo.applyDelta(config, { ...parseStore({}, config, SELF), members: [
      { memberId: 999, channelId: GROUP, partnerId: 7 },
      { memberId: 998, channelId: GENERAL, partnerId: 8 },
      { memberId: -3, channelId: GROUP, partnerId: 9 },
    ] });
    await chat.load(src);
    expect(await memberIds(GROUP)).toEqual([-3, ...before.group]);
    expect(await memberIds(GENERAL)).toEqual([...before.general, 998].sort());
  });

  it("members read again from none known when the cache holds more than the server counts", async () => {
    const odoo = fakeOdoo();
    const src = await source();
    await chat.load(src);
    const all = [104, 201, 202, 203];
    odoo.state.onRoute = async (path, params) => {
      if (path !== "/discuss/channel/members") return undefined;
      const page = all.filter((id) => !params.known_member_ids.includes(id)).slice(0, 2);
      return {
        "discuss.channel": [{ id: params.channel_id, memberCount: all.length }],
        "discuss.channel.member": page.map((id) => ({
          id, thread: { id: params.channel_id, model: "discuss.channel" }, persona: { id: id === 104 ? SELF : id - 100, type: "partner" },
        })),
      };
    };
    // Every server member cached, and one who left since
    await chat.repo.applyDelta(config, { ...parseStore({}, config, SELF), members: [201, 202, 203, 299].map((id) => ({
      memberId: id, channelId: GENERAL, partnerId: id - 100,
    })) });
    const members = await chat.members(src, GENERAL);
    expect(members.map((m) => m.memberId).sort()).toEqual(all);
    expect(odoo.on("/discuss/channel/members").map((c) => c.params.known_member_ids)).toEqual([
      [104, 201, 202, 203, 299], [], [104, 201],
    ]);

    // A re-read page that fails drops nothing
    await chat.repo.applyDelta(config, { ...parseStore({}, config, SELF), members: [{ memberId: 298, channelId: GENERAL, partnerId: 198 }] });
    let calls = 0;
    const answer = odoo.state.onRoute;
    odoo.state.onRoute = async (path, params) => (path === "/discuss/channel/members" && calls++ === 1
      ? { __error: "odoo.exceptions.AccessError" } : answer(path, params));
    expect((await chat.members(src, GENERAL)).map((m) => m.memberId).sort()).toEqual([...all, 298]);
  });

  it("a value queued after the in-flight op failed is the one the server ends on", async () => {
    const odoo = fakeOdoo();
    const src = await source();
    await chat.load(src);
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let renamed = 0;
    odoo.state.onKw = async ({ method }) => {
      if (method === "channel_rename" && renamed++ === 0) { await held; throw new TypeError("Failed to fetch"); }
      return undefined;
    };
    const first = chat.rename(src, GROUP, "One");
    await vi.waitFor(() => expect(odoo.kw("channel_rename")).toHaveLength(1));
    await chat.rename(src, GROUP, "Two");
    release();
    await first;
    // The first op failed back to its retry; the third value reaches both waiting ops
    offline();
    await chat.rename(src, GROUP, "Three");
    expect((await actionOps()).map((o) => o.params.name)).toEqual(["Three", "Three"]);
    online();
    await chat.flushAll({ force: true });
    await chat.flushAll({ force: true });
    expect(kwOf(odoo, "channel_rename").map(([, k]) => k.name).at(-1)).toBe("Three");
    expect(await chat.repo.channel(config, GROUP)).toMatchObject({ name: "Three" });
    expect(await env.db.getOutboxOpsForConfig(config)).toHaveLength(0);
  });

  it("a post on the wire refused while leaving is done as left, and the leave goes", async () => {
    const odoo = fakeOdoo();
    const src = await source();
    await chat.load(src);
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    odoo.state.onPost = async () => { await held; return { __error: "odoo.exceptions.AccessError" }; };
    const posting = chat.send(src, GROUP, "refused late");
    await vi.waitFor(() => expect(odoo.on("/mail/message/post")).toHaveLength(1));
    await chat.leave(src, GROUP);
    // Nothing failed yet when the leave was queued: the conversation is hidden
    expect(await chat.repo.channel(config, GROUP)).toMatchObject({ leftUnsent: false });
    release();
    await posting;
    await chat.flushAll();
    expect(kwOf(odoo, "action_unfollow")).toEqual([[[GROUP], {}]]);
    expect(await chat.repo.channel(config, GROUP)).toMatchObject({ isMember: false, leftUnsent: true });
    expect((await chat.conversations()).map((c) => c.channelId)).toContain(GROUP);
    expect((await chat.messages(config, GROUP)).at(-1)).toMatchObject({ status: "failed", outboxOpId: null });
    expect(await env.db.getOutboxOpsForConfig(config)).toHaveLength(0);
  });

  it("leaving a conversation whose create never left gives it up, nothing reaches the server", async () => {
    const odoo = fakeOdoo();
    const server = createServer(odoo, { now: () => clock });
    const src = await source();
    await chat.load(src);
    offline();
    const { channelId: typed } = await chat.createGroup(src, [BOB]);
    await chat.send(src, typed, "hello");
    await chat.rename(src, typed, "Ours");
    await chat.leave(src, typed);
    const { channelId: empty } = await chat.createGroup(src, [7]);
    await chat.leave(src, empty);
    expect(await env.db.getOutboxOpsForConfig(config)).toHaveLength(0);
    // With a text typed into it, it stays listed as left; without, it is gone
    expect(await chat.repo.channel(config, typed)).toMatchObject({ isMember: false, leftUnsent: true, createOpId: null });
    expect((await chat.messages(config, typed)).map((m) => m.status)).toEqual(["failed"]);
    expect(await chat.repo.channel(config, empty)).toBeNull();
    online();
    await chat.flushAll();
    await chat.load(src);
    expect(server.channels).toHaveLength(0);
    expect(createCalls(odoo)).toHaveLength(0);
    expect(odoo.kw("action_unfollow")).toHaveLength(0);
    expect(await chat.repo.channel(config, typed)).toMatchObject({ leftUnsent: true });
    await chat.discardCreate(config, typed);
    expect(await chat.repo.channel(config, typed)).toBeNull();
  });

  it("leaving a conversation whose create is on the wire leaves it once created", async () => {
    const odoo = fakeOdoo();
    const server = createServer(odoo, { now: () => clock });
    const src = await source();
    await chat.load(src);
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    server.state.onCreate = async () => { await held; };
    const creating = chat.createGroup(src, [BOB]);
    await vi.waitFor(() => expect(createCalls(odoo)).toHaveLength(1));
    const tempId = (await chat.repo.channels(config)).find((c) => c.channelId < 0)!.channelId;
    offline();
    await chat.send(src, tempId, "hello");
    await chat.leave(src, tempId);
    release();
    await creating;
    const realId = server.channels[0].id;
    // The swap keeps it left, with its text: the server's row does not make it a member again
    expect(await chat.repo.channel(config, realId)).toMatchObject({ isMember: false, leftUnsent: true });
    online();
    await chat.flushAll();
    expect(kwOf(odoo, "action_unfollow")).toEqual([[[realId], {}]]);
    expect(odoo.on("/mail/message/post")).toHaveLength(0);
    expect(server.channels).toHaveLength(1);
    expect((await chat.messages(config, realId)).map((m) => m.status)).toEqual(["failed"]);
    expect((await chat.conversations()).map((c) => c.channelId)).toContain(realId);
  });

  it("a conversation the server takes away leaves one notice for the actions it cancels", async () => {
    fakeOdoo();
    const src = await source();
    await chat.load(src);
    offline();
    await chat.rename(src, GROUP, "Renamed");
    await chat.mute(src, GROUP, 60);
    // A follow-up of the same rename (as behind a running one) is the same action
    const [rename] = (await actionOps()).filter((o) => o.kind === "chat.rename");
    await env.db.addOutboxOp({ ...rename, id: "follow-up", clientUuid: "follow-up-uuid", dependsOn: rename.id });
    await chat.applyBus(config, [
      bus(1001, "discuss.channel/delete", { id: GROUP }),
      bus(1002, "discuss.channel/leave", { "discuss.channel": [{ id: GENERAL }] }),
    ]);
    const notices = await chat.notices();
    expect(notices).toEqual([expect.objectContaining({ kind: "chat.dropped", channelId: GROUP, count: 2, label: "Renamed", reason: "vanished" })]);
    // Only the notice stays in the outbox, and no flush sends it
    expect((await env.db.getOutboxOpsForConfig(config)).map((o) => [o.kind, o.status])).toEqual([["chat.dropped", "blocked"]]);
    online();
    await chat.flushAll();
    expect((await chat.notices())).toHaveLength(1);
    await chat.dismissNotice(config, notices[0].id);
    expect(await chat.notices()).toEqual([]);
  });

  it("removal on a server whose module lacks it is refused once and the module state probed again", async () => {
    const odoo = fakeOdoo();
    const src = await source();
    await chat.load(src);
    await chat.repo.setSourceState({ configId: config, isSystem: true, moduleState: "installed", moduleLevel: "1.2" });
    odoo.state.onKw = async ({ method }) =>
      (method === "erplibre_remove_member" ? { __error: "builtins.AttributeError" } : undefined);
    await chat.removeMember(src, GROUP, BOB);
    expect(await chat.notices()).toEqual([expect.objectContaining({ kind: "chat.remove", reason: "refused" })]);
    expect((await env.db.getOutboxOpsForConfig(config)).map((o) => o.status)).toEqual(["blocked"]);
    expect((await chat.repo.sourceState(config)).moduleState).not.toBe("installed");
    expect((await chat.features(config)).canRemoveMembers).toBe(false);
    await chat.flushAll({ force: true });
    expect(odoo.kw("erplibre_remove_member")).toHaveLength(1);
  });

  it("a refused leave shows a notice and gives the conversation back", async () => {
    const odoo = fakeOdoo();
    const src = await source();
    await chat.load(src);
    offline();
    await chat.send(src, GROUP, "typed");
    await chat.leave(src, GROUP);
    expect(await chat.repo.channel(config, GROUP)).toMatchObject({ leftUnsent: true });
    odoo.state.onKw = async ({ method }) =>
      (method === "action_unfollow" ? { __error: "odoo.exceptions.AccessError" } : undefined);
    online();
    await chat.flushAll();
    expect(await chat.notices()).toEqual([expect.objectContaining({ kind: "chat.leave", channelId: GROUP, reason: "refused" })]);
    expect(await chat.repo.channel(config, GROUP)).toMatchObject({ leftUnsent: false });
    // The next load shows the membership the server kept, and posting works again
    await chat.load(src);
    expect(await chat.repo.channel(config, GROUP)).toMatchObject({ isMember: true });
    odoo.state.onKw = null;
    expect((await chat.send(src, GROUP, "again")).status).toBe("pending");
    expect(odoo.on("/mail/message/post")).toHaveLength(1);
  });

  it("a create whose own temp pair exists settles at once from channel info", async () => {
    const odoo = fakeOdoo();
    const server = createServer(odoo, { now: () => clock });
    const src = await source();
    await chat.load(src);
    // The group is made on the server, its answer lost: the op fails with its stamp kept
    server.state.dropNext = 1;
    const { channelId: tempId } = await chat.createGroup(src, [BOB, 8]);
    expect(tempId).toBeLessThan(0);
    const realId = server.channels[0].id;
    // The app died between the stored pair and the swap
    await chat.repo.rememberRealId(config, tempId, realId);
    const calls = createCalls(odoo).length;
    // Still inside the quiet window: the pair is read, not waited out nor searched
    advance(60_000);
    await chat.flushAll({ force: true });
    expect(createCalls(odoo)).toHaveLength(calls);
    expect(odoo.on("/discuss/channel/info").map((c) => c.params.channel_id)).toEqual([realId]);
    expect(await chat.realIdOf(config, tempId)).toBe(realId);
    expect(await chat.repo.channel(config, realId)).toMatchObject({ createOpId: null });
    expect(await chat.repo.channel(config, tempId)).toBeNull();
    expect(await env.db.getOutboxOpsForConfig(config)).toHaveLength(0);
  });

  it("leaving a conversation whose create failed after a send that may have arrived leaves it once created", async () => {
    const odoo = fakeOdoo();
    const server = createServer(odoo, { now: () => clock });
    const src = await source();
    await chat.load(src);
    // The group is made on the server, its answer lost: the op fails with its stamp kept
    server.state.dropNext = 1;
    const { channelId: tempId } = await chat.createGroup(src, [BOB, 8]);
    const [create] = (await env.db.getOutboxOpsForConfig(config)).filter((o) => o.kind === "chat.create");
    expect(create).toMatchObject({ status: "failed", attempts: 1 });
    expect(create.params.createSentAt).toBeTruthy();
    expect(server.channels).toHaveLength(1);
    offline();
    await chat.send(src, tempId, "hello");
    await chat.leave(src, tempId);
    // The create is kept and the leave waits for it
    const ops = await env.db.getOutboxOpsForConfig(config);
    expect(ops.map((o) => o.kind).sort()).toEqual(["chat.create", "chat.leave"]);
    expect(ops.find((o) => o.kind === "chat.leave")!.dependsOn).toBe(create.id);
    expect(await chat.repo.channel(config, tempId)).toMatchObject({ isMember: false, leftUnsent: true, createOpId: create.id });
    online();
    advance(3 * 60_000 + 1);
    await chat.flushAll();
    // The retry adopts the group the lost send made: one group, left, its text kept as failed
    expect(createCalls(odoo)).toHaveLength(1);
    expect(server.channels).toHaveLength(1);
    const realId = server.channels[0].id;
    expect(await chat.realIdOf(config, tempId)).toBe(realId);
    expect(kwOf(odoo, "action_unfollow")).toEqual([[[realId], {}]]);
    expect(odoo.on("/mail/message/post")).toHaveLength(0);
    expect(await chat.repo.channel(config, realId)).toMatchObject({ isMember: false, leftUnsent: true, createOpId: null });
    expect((await chat.messages(config, realId)).map((m) => m.status)).toEqual(["failed"]);
    expect(await env.db.getOutboxOpsForConfig(config)).toHaveLength(0);
  });

  describe("server search", () => {
    const TERM = "l'eau & co";
    const HTML = "l'eau%&amp;%co";
    const RAW = "l'eau%&%co";
    let odoo: ReturnType<typeof fakeOdoo>;
    let src: ChatSource;
    /** The member channels search_read answers, read at each call. */
    let members: number[];
    /** The mail.message rows search_read answers and the count search_count answers. */
    let rows: any[];
    let count: number;

    const row = (id: number, channelId: number, body: string, p: any = {}) => ({
      id, body, date: "2026-10-25 09:00:00", author_id: [BOB, "Bob"], res_id: channelId, attachment_ids: [], ...p,
    });
    const messageReads = () => odoo.kw("search_read").filter((c) => c.params.model === "mail.message");
    const memberReads = () => odoo.kw("search_read").filter((c) => c.params.model === "discuss.channel"
      && c.params.kwargs.domain.some((d: any[]) => d[0] === "is_member" && d[2] === true));
    const withModule = () => chat.repo.setSourceState({ configId: config, moduleState: "installed", moduleLevel: "1.4" });
    /** No call that marks a message read or done went out, and every history page used `around`. */
    const markedNothing = () => {
      expect(odoo.on("/mail/thread/messages")).toEqual([]);
      expect(odoo.on("/discuss/channel/messages").every((c) => typeof c.params.around === "number")).toBe(true);
      expect(odoo.on("/discuss/channel/mark_as_read")).toEqual([]);
      expect(odoo.kw("set_message_done")).toEqual([]);
      expect(odoo.kw("mark_all_as_read")).toEqual([]);
    };

    beforeEach(async () => {
      odoo = fakeOdoo();
      src = await source();
      await chat.load(src);
      members = [GROUP, GENERAL];
      rows = [];
      count = 0;
      odoo.state.onKw = async ({ model, method, kwargs }) => {
        if (model === "discuss.channel" && method === "search_read" && kwargs.domain.some((d: any[]) => d[0] === "is_member" && d[2] === true)) {
          return members.map((id) => ({ id }));
        }
        if (model === "mail.message" && method === "search_read") return rows;
        if (model === "mail.message" && method === "search_count") return count;
        if (model === "res.partner" && method === "im_search") return { "res.partner": [] };
        return undefined;
      };
    });

    it("the module route gets the raw term", async () => {
      await withModule();
      odoo.state.onRoute = async (path) => path !== MODULE_SEARCH_ROUTE ? undefined : {
        count: 2,
        messages: [501, 500],
        data: {
          "mail.message": [
            msg(501, GROUP, BOB, "<p>Voici l'eau &amp; co ici</p>"),
            { ...msg(500, GENERAL, SELF, "<p>pièce jointe</p>"), attachment_ids: [77] },
          ],
          "ir.attachment": [{ id: 77, name: "L'eau & co.pdf", mimetype: "application/pdf", thread: { id: GENERAL, model: "discuss.channel" } }],
          "res.partner": [{ id: BOB, name: "Bob Démo" }],
        },
      };
      const r = await chat.search.server(src, ` ${TERM} `);
      expect(odoo.on(MODULE_SEARCH_ROUTE).map((c) => c.params)).toEqual([{ search_term: TERM, before: null, limit: SERVER_PAGE }]);
      expect(r.hits).toEqual([
        { configId: config, channelId: GROUP, messageId: 501, clientUuid: null, authorPartnerId: BOB, date: "2026-10-25 09:00:00",
          snippet: "Voici l'eau & co ici", fileName: null, origin: "server" },
        { configId: config, channelId: GENERAL, messageId: 500, clientUuid: null, authorPartnerId: SELF, date: "2026-10-25 09:00:00",
          snippet: "L'eau & co.pdf", fileName: "L'eau & co.pdf", origin: "server" },
      ]);
      expect(r).toMatchObject({ count: 2, more: false, offline: false });
      expect(messageReads()).toEqual([]);
      // The hits stay in memory: the cache holds neither message, the author's name is known for the results
      expect(await chat.repo.message(config, 501)).toBeNull();
      expect(await chat.repo.message(config, 500)).toBeNull();
      expect((await chat.repo.partners(config)).find((p) => p.partnerId === BOB)?.name).toBe("Bob Démo");
      // A next page asks below the id given, without the names again
      await chat.search.server(src, TERM, 500);
      expect(odoo.on(MODULE_SEARCH_ROUTE)[1].params).toEqual({ search_term: TERM, before: 500, limit: SERVER_PAGE });
      expect(odoo.kw("im_search")).toHaveLength(1);
      markedNothing();
    });

    it("a 404 of the module route falls back", async () => {
      await withModule();
      odoo.state.onRoute = async (path) => (path === MODULE_SEARCH_ROUTE ? { __status: 404 } : undefined);
      rows = [row(501, GROUP, "<p>l'eau &amp; co</p>")];
      count = 1;
      const r = await chat.search.server(src, TERM);
      expect(odoo.on(MODULE_SEARCH_ROUTE)).toHaveLength(1);
      expect(messageReads()).toHaveLength(1);
      expect(r.hits.map((h) => [h.messageId, h.channelId, h.snippet])).toEqual([[501, GROUP, "l'eau & co"]]);
      expect(r).toMatchObject({ count: 1, more: false, offline: false });
    });

    it("a non-404 error of the module route does not fall back", async () => {
      await withModule();
      rows = [row(501, GROUP, "<p>l'eau &amp; co</p>")];
      count = 1;
      // A server error
      odoo.state.onRoute = async (path) => (path === MODULE_SEARCH_ROUTE ? { __status: 500 } : undefined);
      await expect(chat.search.server(src, TERM)).rejects.toThrow(/500/);
      expect(odoo.on(MODULE_SEARCH_ROUTE)).toHaveLength(1);
      // An expired session, then the same error once signed in again
      let calls = 0;
      odoo.state.onRoute = async (path) => {
        if (path !== MODULE_SEARCH_ROUTE) return undefined;
        return ++calls === 1 ? { __error: "odoo.http.SessionExpiredException", __code: 100 } : { __status: 500 };
      };
      await expect(chat.search.server(src, TERM)).rejects.toThrow(/500/);
      expect(odoo.on(MODULE_SEARCH_ROUTE)).toHaveLength(3);
      expect(calls).toBe(2);
      expect(messageReads()).toEqual([]);
    });

    it("the fallback domain escapes like the module", async () => {
      rows = [row(502, GENERAL, "<p>Pas dans le texte</p>", { attachment_ids: [78] }), row(501, GROUP, "<p>l'eau &amp; co</p>")];
      count = 2;
      odoo.state.attachments.push({
        id: 78, name: "l'eau & co.ods", file_size: 10, mimetype: "application/vnd.oasis.opendocument.spreadsheet", checksum: "c78",
        voice: false, res_model: "discuss.channel", res_id: GENERAL, create_uid: 2, create_date: "2026-10-25 09:00:00", uuid: null,
      });
      const r = await chat.search.server(src, TERM);
      expect(odoo.on(MODULE_SEARCH_ROUTE)).toEqual([]);
      const domain = [
        ["model", "=", "discuss.channel"], ["res_id", "in", [GROUP, GENERAL]], ["message_type", "!=", "user_notification"],
        "|", "|", ["body", "ilike", HTML], ["subject", "ilike", RAW], ["attachment_ids.name", "ilike", RAW],
      ];
      expect(messageReads().map((c) => c.params.kwargs)).toEqual([{
        domain, fields: ["id", "body", "date", "author_id", "res_id", "attachment_ids"], limit: SERVER_PAGE, order: "id desc",
      }]);
      expect(odoo.kw("search_count").map((c) => c.params.args)).toEqual([[domain]]);
      expect(r.hits.map((h) => [h.messageId, h.fileName])).toEqual([[502, "l'eau & co.ods"], [501, null]]);
      // A next page bounds the read, never the count
      await chat.search.server(src, TERM, 501);
      expect(messageReads()[1].params.kwargs.domain).toEqual([...domain, ["id", "<", 501]]);
      expect(odoo.kw("search_count")[1].params.args).toEqual([domain]);
      markedNothing();
    });

    it("the fallback restricts to member channel ids", async () => {
      rows = [row(501, GROUP, "<p>l'eau &amp; co</p>")];
      count = 1;
      await chat.search.server(src, TERM);
      expect(memberReads().map((c) => c.params.kwargs)).toEqual([{ domain: [["is_member", "=", true]], fields: ["id"] }]);
      // Read fresh at each search: a channel left on the server since the last load is out at once
      members = [GENERAL];
      await chat.search.server(src, TERM);
      expect(messageReads()[1].params.kwargs.domain[1]).toEqual(["res_id", "in", [GENERAL]]);
      // A user in no channel finds nothing, and no message is read
      members = [];
      const r = await chat.search.server(src, TERM);
      expect(messageReads()).toHaveLength(2);
      expect(r).toMatchObject({ hits: [], count: 0, more: false, offline: false });
    });

    it("a short page with a larger count offers more", async () => {
      // Odoo filters the rows the user may read after its limit: a page short of SERVER_PAGE is not the end
      rows = [row(520, GROUP, "<p>l'eau &amp; co 1</p>"), row(510, GROUP, "<p>l'eau &amp; co 2</p>")];
      count = 40;
      expect(await chat.search.server(src, TERM)).toMatchObject({ count: 40, more: true });
      count = 2;
      expect(await chat.search.server(src, TERM)).toMatchObject({ count: 2, more: false });
      rows = [];
      count = 40;
      expect(await chat.search.server(src, TERM, 510)).toMatchObject({ hits: [], count: 40, more: false });
    });

    it("offline the server is not asked", async () => {
      await withModule();
      const before = odoo.calls.length;
      offline();
      expect(await chat.search.server(src, TERM)).toEqual({ hits: [], joinable: [], people: [], count: null, more: false, offline: true });
      online();
      expect(odoo.calls.length).toBe(before);
    });

    it("open at an unloaded hit pages with around and marks nothing read", async () => {
      // Message 150 was deleted on the server
      odoo.history[GROUP] = Array.from({ length: 600 }, (_, i) => i + 1).filter((id) => id !== 150);
      expect(await chat.repo.message(config, 350)).toBeNull();
      expect(await chat.loadUntil(src, GROUP, 350)).toBe(true);
      expect(await chat.repo.message(config, 350)).not.toBeNull();
      // Three pages of CHAT_FULL_PAGE below the last message, each with `around`, then it stops
      expect(odoo.on("/discuss/channel/messages").map((c) => c.params.around)).toEqual([601, 500, 400]);
      expect((await chat.repo.channel(config, GROUP))?.oldestLoadedId).toBe(301);
      markedNothing();
      // Already loaded: no request
      expect(await chat.loadUntil(src, GROUP, 400)).toBe(true);
      expect(odoo.on("/discuss/channel/messages")).toHaveLength(3);
      // A message the history no longer holds: paged down to it, false
      expect(await chat.loadUntil(src, GROUP, 150)).toBe(false);
      expect(odoo.on("/discuss/channel/messages").map((c) => c.params.around)).toEqual([601, 500, 400, 300, 200]);
      markedNothing();
    });
  });

  describe("pinned messages", () => {
    let odoo: ReturnType<typeof fakeOdoo>;
    let src: ChatSource;
    /** What /discuss/channel/pinned_messages answers: a bare Store of the channel's pinned messages. */
    let pinned: any[];
    const pinnedMsg = (id: number, at: string) => ({ ...msg(id, GROUP), pinned_at: at });
    const cache = (id: number, at: string | null) => chat.repo.applyDelta(config, {
      ...parseStore({ "mail.message": [{ ...msg(id, GROUP), pinned_at: at || false }] }, config, SELF),
    });
    const ids = (r: { messages: { messageId: number | null }[] }) => r.messages.map((m) => m.messageId);

    beforeEach(async () => {
      odoo = fakeOdoo();
      pinned = [];
      odoo.state.onRoute = async (path) => (path === "/discuss/channel/pinned_messages" ? { "mail.message": pinned } : undefined);
      src = await source();
      await chat.load(src);
    });

    it("the pinned list drops a message the server no longer lists, not one with a queued pin", async () => {
      await cache(590, "2026-10-24 08:00:00");
      await cache(599, "2026-10-24 09:00:00");
      offline();
      await chat.pin(src, GROUP, { messageId: 600, clientUuid: null }, true);
      expect(odoo.kw("set_message_pin")).toEqual([]);
      online();
      // Unpinned in the browser meanwhile: 590 is no longer listed; 600's pin has not reached the server
      pinned = [pinnedMsg(599, "2026-10-24 09:00:00")];
      const r = await chat.pinnedMessages(src, GROUP);
      expect(odoo.on("/discuss/channel/pinned_messages").map((c) => c.params)).toEqual([{ channel_id: GROUP }]);
      expect(r.offline).toBe(false);
      expect(ids(r)).toEqual([600, 599]);
      expect((await chat.repo.message(config, 590))?.pinnedAt).toBeNull();
      expect((await chat.repo.message(config, 600))?.pinnedAt).toBe("2026-10-25 10:00:00");
      expect((await env.db.getOutboxOpsForConfig(config)).filter((o) => o.kind === "chat.pin")).toHaveLength(1);
      // Nothing of it marks read
      expect(odoo.on("/discuss/channel/mark_as_read")).toEqual([]);
    });

    it("unread pinned messages come first", async () => {
      // The user has seen up to 598 in the group
      const floor = (await chat.repo.channel(config, GROUP))?.oldestLoadedId;
      pinned = [
        pinnedMsg(590, "2026-10-25 08:00:00"),
        pinnedMsg(599, "2026-10-24 07:00:00"),
        { ...pinnedMsg(600, "2026-10-24 09:00:00"), parentMessage: 580 },
        // A reply's parent comes along, not pinned
        msg(580, GROUP),
      ];
      const r = await chat.pinnedMessages(src, GROUP);
      expect(ids(r)).toEqual([600, 599, 590]);
      expect(r.messages[0].pinnedAt).toBe("2026-10-24 09:00:00");
      // Written: offline the phone answers the same list, said to be the phone's
      offline();
      const cached = await chat.pinnedMessages(src, GROUP);
      expect(cached.offline).toBe(true);
      expect(ids(cached)).toEqual([600, 599, 590]);
      expect(odoo.on("/discuss/channel/pinned_messages")).toHaveLength(1);
      // Below the loaded history: cached for the panel, the history's floor unmoved (the thread hides them, as a reply's parent)
      expect((await chat.repo.channel(config, GROUP))?.oldestLoadedId).toBe(floor);
      expect((await chat.repo.channel(config, GROUP))?.historyComplete).toBe(false);
    });

    it("pin and unpin send set_message_pin on the channel", async () => {
      await chat.pin(src, GROUP, { messageId: 600, clientUuid: null }, true);
      await chat.pin(src, GROUP, { messageId: 600, clientUuid: null }, false);
      expect(odoo.kw("set_message_pin").map((c) => [c.params.args, c.params.kwargs])).toEqual([
        [[[GROUP]], { message_id: 600, pinned: true }],
        [[[GROUP]], { message_id: 600, pinned: false }],
      ]);
      expect((await chat.repo.message(config, 600))?.pinnedAt).toBeNull();
    });

    it("an action queued while the pinned list or a history page writes is not undone by it", async () => {
      await cache(599, "2026-10-24 09:00:00");
      pinned = [pinnedMsg(599, "2026-10-24 09:00:00")];
      await chat.repo.applyDelta(config, parseStore({ "mail.message": [msg(70, CHAT)] }, config, SELF));
      odoo.state.pageRecord = () => ({ starred: false });
      const apply = chat.repo.applyDelta.bind(chat.repo);
      let queued: Promise<unknown>[] = [];
      const queueDuringWrite = (queue: () => Promise<unknown>) =>
        vi.spyOn(chat.repo, "applyDelta").mockImplementationOnce(async (configId, delta, opts) => {
          // The overlay read the queued ops: an action queued now comes before the write
          queued.push(queue());
          await new Promise((r) => setTimeout(r, 20));
          return apply(configId, delta, opts);
        });
      queueDuringWrite(() => chat.queue.queuePin(config, GROUP, { messageId: 599, clientUuid: null }, false));
      await chat.pinnedMessages(src, GROUP);
      await Promise.all(queued);
      expect((await chat.repo.message(config, 599))?.pinnedAt).toBeNull();
      queued = [];
      queueDuringWrite(() => chat.queue.queueStar(config, 70, true, CHAT));
      await chat.loadOlder(src, CHAT);
      await Promise.all(queued);
      expect(odoo.on("/discuss/channel/messages").length).toBeGreaterThan(0);
      expect((await chat.repo.message(config, 70))?.starred).toBe(true);
    });
  });

  describe("starred messages", () => {
    let odoo: ReturnType<typeof fakeOdoo>;
    let src: ChatSource;
    /** The ids the user starred on the server. */
    let server: Set<number>;
    /** What /mail/starred/messages answers, newest first; a page is cut at `before` and `limit`. */
    let page: any[];
    const counter = async () => (await chat.repo.sourceState(config)).starredCounter;
    const flagged = async (id: number) => (await chat.repo.message(config, id))?.starred ?? false;
    const shown = async () => (await chat.starred([config])).map((i) => i.messageId);
    const record = (id: number, name: string) => ({
      id, body: `<p>r${id}</p>`, date: "2026-10-25 09:00:00", message_type: "comment",
      author: { id: BOB, type: "partner" }, thread: { id: 70, model: "res.partner" }, record_name: name, starred: true,
    });
    const starredBox = (ids: number[], flags: Record<string, any>) => chat.repo.applyDelta(config, {
      ...parseStore({}, config, SELF),
      mailbox: ids.map((id) => ({ messageId: id, threadModel: "discuss.channel", threadId: GROUP, body: `<p>m${id}</p>`, ...flags })),
    });

    beforeEach(async () => {
      odoo = fakeOdoo();
      server = new Set();
      page = [];
      odoo.state.data.Store.starred = { counter: 2, counter_bus_id: 1000, id: "starred", model: "mail.box" };
      odoo.state.onKw = async (p) => {
        if (p.model === "mail.message" && p.method === "search_read" && p.kwargs.fields?.includes("starred")) {
          const id = p.kwargs.domain.find((d: any[]) => d[0] === "id")[2];
          return [{ id, starred: server.has(id) }];
        }
        if (p.method === "toggle_message_starred") {
          const id = p.args[0][0];
          if (server.has(id)) server.delete(id);
          else server.add(id);
          return { "mail.message": [{ id, starred: server.has(id) }] };
        }
        return undefined;
      };
      odoo.state.onRoute = async (path, params) => {
        if (path !== "/mail/starred/messages") return undefined;
        const rows = page.filter((m) => params.before === undefined || m.id < params.before).slice(0, params.limit);
        return { data: { "mail.message": rows }, messages: rows.map((m) => m.id) };
      };
      src = await source();
      await chat.load(src);
    });

    it("the bus echo of an own star moves the counter once", async () => {
      expect(await counter()).toBe(2);
      await chat.star(src, 600, true, GROUP);
      expect(odoo.kw("toggle_message_starred").map((c) => c.params.args)).toEqual([[[600]]]);
      expect(await flagged(600)).toBe(true);
      expect(await counter()).toBe(3);
      // The server tells every device of the user, this one included
      await chat.applyBus(config, [bus(1001, "mail.message/toggle_star", { message_ids: [600], starred: true })]);
      expect(await counter()).toBe(3);
      expect(await flagged(600)).toBe(true);
      expect(await shown()).toEqual([600]);
    });

    it("a star from another device counts", async () => {
      await chat.applyBus(config, [bus(1001, "mail.message/toggle_star", { message_ids: [600], starred: true })]);
      expect(await flagged(600)).toBe(true);
      expect(await counter()).toBe(3);
      // A message the phone does not hold counts too, and a replay at or below the last bus id counts nothing
      await chat.applyBus(config, [bus(1002, "mail.message/toggle_star", { message_ids: [4242], starred: true })]);
      expect(await counter()).toBe(4);
      await chat.applyBus(config, [bus(1002, "mail.message/toggle_star", { message_ids: [4242], starred: true })]);
      expect(await counter()).toBe(4);
      await chat.applyBus(config, [bus(1003, "mail.message/toggle_star", { message_ids: [600, 4242], starred: false })]);
      expect(await flagged(600)).toBe(false);
      expect(await counter()).toBe(2);
    });

    it("a message deleted on the server leaves the starred box, with the server's counter", async () => {
      await chat.applyBus(config, [bus(1001, "mail.message/toggle_star", { message_ids: [600], starred: true })]);
      // Odoo's delete clears every star of the emptied message and sends the box's count (_cleanup_side_records)
      const cleared = { "mail.thread": [{ counter: 1, counter_bus_id: 1002, id: "starred", messages: [["DELETE", [600]]], model: "mail.box" }] };
      await chat.applyBus(config, [bus(1002, "mail.record/insert", cleared)]);
      expect(await flagged(600)).toBe(false);
      expect(await counter()).toBe(1);
      expect(await shown()).toEqual([]);
      // Replayed: the counter stays
      await chat.repo.setSourceState({ configId: config, starredCounter: 5 });
      await chat.applyBus(config, [bus(1002, "mail.record/insert", cleared)]);
      expect(await counter()).toBe(5);
    });

    it("the starred page unstars a row it no longer lists", async () => {
      await starredBox([590, 595], { starred: true });
      // Starred in the browser: a channel message and a record's message
      page = [{ ...msg(599, GROUP), starred: true }, record(98, "Tâche démo")];
      expect(await chat.refreshStarred(src)).toMatchObject({ offline: false, complete: true });
      expect(odoo.on("/mail/starred/messages").map((c) => c.params)).toEqual([{ limit: 30 }]);
      // A page shorter than its limit covers every id below it: 590 and 595 are no longer starred
      expect(await shown()).toEqual([599, 98]);
      expect(await chat.repo.mailboxItem(config, 98)).toMatchObject({ threadModel: "res.partner", threadId: 70, recordName: "Tâche démo", starred: true });
      expect(await flagged(599)).toBe(true);
      // A page before an id proves only the range below it
      await starredBox([590, 610], { starred: true });
      page = [];
      await chat.refreshStarred(src, 600);
      expect(odoo.on("/mail/starred/messages").at(-1)!.params).toEqual({ limit: 30, before: 600 });
      expect(await shown()).toEqual([610]);
      expect(odoo.on("/mail/thread/messages")).toEqual([]);
    });

    it("a queued star survives a refresh", async () => {
      offline();
      await chat.star(src, 600, true, GROUP);
      expect(await counter()).toBe(3);
      online();
      // The server does not hold it yet: its page leaves it out, and the load's counter does not count it
      page = [{ ...msg(590, GROUP), starred: true }];
      await chat.refreshStarred(src);
      expect(await shown()).toEqual([600, 590]);
      expect(await flagged(600)).toBe(true);
      await chat.load(src);
      expect(await counter()).toBe(3);
      expect((await env.db.getOutboxOpsForConfig(config)).filter((o) => o.kind === "chat.star")).toHaveLength(1);
      // Offline, the cache answers alone
      offline();
      expect(await chat.refreshStarred(src)).toMatchObject({ offline: true });
      expect(await shown()).toEqual([600, 590]);
    });

    it("the starred list puts the unread first, then the newest", async () => {
      await starredBox([590, 599, 600], { starred: true });
      await chat.repo.applyDelta(config, { ...parseStore({}, config, SELF), mailbox: [
        { messageId: 700, threadModel: "res.partner", threadId: 70, recordName: "Tâche démo", starred: true },
        { messageId: 701, threadModel: "res.partner", threadId: 70, recordName: "Tâche démo", needaction: true },
      ] });
      // The group is seen up to 598: 599 and 600 are unread, a record's message never is
      expect(await shown()).toEqual([600, 599, 700, 590]);
      await chat.repo.patchChannel(config, GROUP, { seenMessageId: 600 });
      expect(await shown()).toEqual([700, 600, 599, 590]);
      // A message whose delete waits is hidden at once
      await chat.repo.applyDelta(config, parseStore({ "mail.message": [{ ...msg(599, GROUP, SELF), starred: true }] }, config, SELF));
      offline();
      await chat.deleteMessage(src, GROUP, { messageId: 599, clientUuid: null });
      expect(await shown()).toEqual([700, 600, 590]);
    });

    it("a starred page lowers the counter by the rows it unstars, unless it carries the server's", async () => {
      await starredBox([590, 595], { starred: true });
      expect(await counter()).toBe(2);
      page = [];
      await chat.refreshStarred(src);
      expect(await shown()).toEqual([]);
      expect(await counter()).toBe(0);
      // A page that carries the server's count: it wins, the stars still queued laid over it
      await starredBox([590], { starred: true });
      offline();
      await chat.star(src, 600, true, GROUP);
      online();
      odoo.state.onRoute = async (path) => (path === "/mail/starred/messages"
        ? { data: { Store: { starred: { counter: 5 } } }, messages: [] } : undefined);
      await chat.refreshStarred(src);
      expect(await counter()).toBe(6);
    });
  });

  describe("inbox", () => {
    let odoo: ReturnType<typeof fakeOdoo>;
    let src: ChatSource;
    /** The messages the server holds, by id; `unread` the ids still needaction for the user. */
    let records: Map<number, any>;
    let unread: Set<number>;
    const counter = async () => (await chat.repo.sourceState(config)).inboxCounter;
    const mentions = async () => (await chat.repo.channel(config, MUTED))!.needactionCounter;
    const shown = async (box: "inbox" | "history" = "inbox") => (await chat.inbox.items([config], box)).map((i) => i.messageId);
    const record = (id: number, p: Record<string, any> = {}) => ({
      id, body: `<p>r${id}</p>`, date: "2026-10-25 09:00:00", message_type: "comment",
      author: { id: BOB, type: "partner" }, thread: { id: 70, model: "res.partner" }, record_name: "Tâche démo", ...p,
    });
    const serve = (...ms: any[]) => {
      for (const m of ms) {
        records.set(m.id, m);
        unread.add(m.id);
      }
    };
    const kwArgs = (method: string) => odoo.kw(method).map((c) => c.params.args);
    /** The server reads the messages still unread among `ids`: its inbox count and their channels' mentions go down. */
    const markRead = (ids: number[]) => {
      const done = ids.filter((id) => unread.delete(id));
      const box = odoo.state.data.Store.inbox;
      box.counter = Math.max(0, box.counter - done.length);
      for (const id of done) {
        const thread = records.get(id)?.thread;
        const channel = thread?.model === "discuss.channel"
          ? odoo.state.data["discuss.channel"].find((c: any) => c.id === thread.id) : undefined;
        if (channel) channel.message_needaction_counter = Math.max(0, channel.message_needaction_counter - 1);
      }
      return done;
    };

    beforeEach(async () => {
      odoo = fakeOdoo();
      records = new Map();
      unread = new Set();
      odoo.state.onRoute = async (path, params) => {
        if (path !== "/mail/inbox/messages" && path !== "/mail/history/messages") return undefined;
        const inbox = path === "/mail/inbox/messages";
        const rows = [...records.values()]
          .filter((m) => unread.has(m.id) === inbox && (params.before === undefined || m.id < params.before))
          .sort((a, b) => b.id - a.id)
          .slice(0, params.limit)
          .map((m) => ({ ...m, needaction: unread.has(m.id) }));
        return { data: { "mail.message": rows }, messages: rows.map((m) => m.id) };
      };
      odoo.state.onKw = async (p) => {
        if (p.method === "set_message_done") {
          markRead(p.args[0]);
          return null;
        }
        if (p.method === "mark_all_as_read") {
          const max = p.args[0].find((d: any[]) => d[0] === "id")[2];
          return markRead([...unread].filter((id) => id <= max));
        }
        return undefined;
      };
      src = await source();
      await chat.load(src);
      // A mention in « Muted » (2 mentions there) and a followed record's message
      serve({ ...msg(801, MUTED), needaction: true }, record(98));
    });

    describe("notification type", () => {
      const typeOf = async () => (await chat.repo.sourceState(config)).notificationType;
      /** The user's own write of notification_type, as Odoo's self-write: the preference then reads back. */
      const selfWrite = (answer: () => Promise<any> | any = () => null) => {
        odoo.state.onKw = async (p) => {
          if (p.model !== "res.users" || p.method !== "write") return undefined;
          const r = await answer();
          if (r === null) odoo.state.sessionNotification = p.args[1].notification_type;
          return r;
        };
      };
      const writes = () => odoo.kw("write").filter((c) => c.params.model === "res.users");

      it("a load stores the notification type the server reports", async () => {
        expect(await typeOf()).toBeNull();
        odoo.state.sessionNotification = "email";
        await chat.load(src);
        expect(await typeOf()).toBe("email");
      });

      it("the switch writes notification_type inbox and stores the type read back", async () => {
        odoo.state.sessionNotification = "email";
        await chat.load(src);
        selfWrite();
        expect(await chat.switchToInbox(src)).toBe("done");
        expect(writes().map((c) => c.params.args)).toEqual([[[2], { notification_type: "inbox" }]]);
        expect(await typeOf()).toBe("inbox");
      });

      it("offline nothing is sent, and a request that never left answers offline", async () => {
        odoo.state.sessionNotification = "email";
        await chat.load(src);
        selfWrite();
        offline();
        expect(await chat.switchToInbox(src)).toBe("offline");
        expect(writes()).toEqual([]);
        online();
        selfWrite(() => { throw new RequestNotSentError("RawHttp error: connection refused"); });
        expect(await chat.switchToInbox(src)).toBe("offline");
        expect(await typeOf()).toBe("email");
      });

      it("a write accepted but not applied answers refused", async () => {
        odoo.state.sessionNotification = "email";
        await chat.load(src);
        odoo.state.onKw = async (p) => (p.model === "res.users" && p.method === "write" ? null : undefined);
        expect(await chat.switchToInbox(src)).toBe("refused");
        expect(await typeOf()).toBe("email");
      });

      it("a refusal changes nothing and answers refused", async () => {
        odoo.state.sessionNotification = "email";
        await chat.load(src);
        selfWrite(() => ({ __error: "odoo.exceptions.AccessError" }));
        expect(await chat.switchToInbox(src)).toBe("refused");
        expect(await typeOf()).toBe("email");
      });
    });

    it("a done item and its bus echo lower the count once", async () => {
      await chat.inbox.refresh(src, "inbox");
      expect(await shown()).toEqual([801, 98]);
      expect(await counter()).toBe(4);
      offline();
      await chat.markDone(src, [801]);
      expect(await shown()).toEqual([98]);
      expect(await shown("history")).toEqual([801]);
      expect(await counter()).toBe(3);
      expect(await mentions()).toBe(1);
      // A load while the done waits: the server still counts it, the phone does not
      online();
      await chat.load(src);
      expect(await counter()).toBe(3);
      expect(await mentions()).toBe(1);
      await chat.queue.flush(src.creds);
      expect(kwArgs("set_message_done")).toEqual([[[801]]]);
      // The server tells every device of the user, this one included
      await chat.applyBus(config, [bus(1001, "mail.message/mark_as_read", { message_ids: [801], needaction_inbox_counter: 3 })]);
      expect(await counter()).toBe(3);
      expect(await mentions()).toBe(1);
      expect(odoo.on("/mail/thread/messages")).toEqual([]);
    });

    it("a done of an item read in the browser meanwhile ends on the server's count", async () => {
      await chat.inbox.refresh(src, "inbox");
      expect(await counter()).toBe(4);
      offline();
      await chat.markDone(src, [98]);
      expect(await counter()).toBe(3);
      // Read in the browser while the phone was offline: its bus never reached the phone
      markRead([98]);
      online();
      await chat.load(src);
      // The waiting done still takes it off a count that no longer holds it
      expect(await counter()).toBe(2);
      await chat.queue.flush(src.creds);
      expect(kwArgs("set_message_done")).toEqual([[[98]]]);
      // Odoo's set_message_done of a read item sends nothing on the bus: the counts are read again after the send
      expect(await counter()).toBe(3);
      expect(await mentions()).toBe(2);
      expect(await shown("history")).toEqual([98]);
    });

    it("a read in the browser moves the item to history", async () => {
      await chat.inbox.refresh(src, "inbox");
      await chat.applyBus(config, [bus(1001, "mail.message/mark_as_read", { message_ids: [801, 98], needaction_inbox_counter: 2 })]);
      expect(await shown()).toEqual([]);
      expect(await shown("history")).toEqual([801, 98]);
      expect(await counter()).toBe(2);
      expect(await mentions()).toBe(1);
    });

    it("a mention on the bus fills the inbox with its conversation", async () => {
      const mention = { "mail.message": [{ ...msg(802, MUTED), needaction: true }] };
      await chat.applyBus(config, [bus(1001, "mail.message/inbox", mention)]);
      expect(await chat.repo.mailboxItem(config, 802)).toMatchObject({
        threadModel: "discuss.channel", threadId: MUTED, recordName: "Muted", needaction: true,
      });
      expect(await counter()).toBe(5);
      expect(await mentions()).toBe(3);
      // A replay at or below the last bus id counts nothing and flags nothing
      await chat.applyBus(config, [bus(1001, "mail.message/inbox", { "mail.message": [{ ...msg(803, MUTED), needaction: true }] })]);
      expect(await counter()).toBe(5);
      expect(await chat.repo.mailboxItem(config, 803)).toBeNull();
    });

    it("an item whose bus delivery a load overtook is read from the inbox page", async () => {
      // Notified before the load, which counts it: its delivery comes at or below the load's bus id (1000)
      serve(record(99));
      await chat.applyBus(config, [bus(1000, "mail.message/inbox", { "mail.message": [{ ...record(99), needaction: true }] })]);
      expect(await chat.repo.mailboxItem(config, 99)).toMatchObject({ threadModel: "res.partner", threadId: 70, needaction: true });
      expect(odoo.on("/mail/inbox/messages")).toHaveLength(1);
      expect(await counter()).toBe(4);
      // A message the phone already holds reads no page; one read since is not listed by the page
      await chat.applyBus(config, [bus(1000, "mail.message/inbox", { "mail.message": [{ ...record(99), needaction: true }] })]);
      expect(odoo.on("/mail/inbox/messages")).toHaveLength(1);
      serve(record(100));
      markRead([100]);
      await chat.applyBus(config, [bus(1000, "mail.message/inbox", { "mail.message": [{ ...record(100), needaction: true }] })]);
      expect(odoo.on("/mail/inbox/messages")).toHaveLength(2);
      expect(await chat.repo.mailboxItem(config, 100)).toBeNull();
      expect(await counter()).toBe(4);
    });

    it("a page drops an item the server moved to history", async () => {
      await chat.inbox.refresh(src, "inbox");
      // Read in the browser while the phone missed the bus
      unread.delete(98);
      await chat.inbox.refresh(src, "inbox");
      expect(await shown()).toEqual([801]);
      expect(await shown("history")).toEqual([98]);
      // A done still waiting keeps its item out of the inbox, the server listing it or not
      offline();
      await chat.markDone(src, [801]);
      online();
      await chat.inbox.refresh(src, "inbox");
      expect(await shown()).toEqual([]);
      expect(kwArgs("set_message_done")).toEqual([]);
    });

    it("the history tab pages with before", async () => {
      for (let id = 1; id <= 40; id++) records.set(id, record(id));
      expect(await chat.inbox.refresh(src, "history")).toMatchObject({ offline: false, more: true, oldestId: 11 });
      expect(await shown("history")).toHaveLength(30);
      expect(await chat.inbox.refresh(src, "history", 11)).toMatchObject({ more: false, oldestId: 1 });
      expect(odoo.on("/mail/history/messages").map((c) => c.params)).toEqual([{ limit: 30 }, { limit: 30, before: 11 }]);
      expect(await shown("history")).toHaveLength(40);
      // Read-only: nothing marked
      expect(kwArgs("set_message_done")).toEqual([]);
      expect(odoo.on("/mail/thread/messages")).toEqual([]);
      offline();
      expect(await chat.inbox.refresh(src, "history")).toMatchObject({ offline: true });
    });

    it("mark all is bounded by the newest item shown", async () => {
      await chat.inbox.refresh(src, "inbox");
      expect(await chat.inbox.maxShown(config)).toBe(801);
      offline();
      await chat.markAllDone(src);
      expect(await shown()).toEqual([]);
      expect(await counter()).toBe(2);
      // A mention arrives on the server before the network returns
      serve({ ...msg(805, MUTED), needaction: true });
      online();
      await chat.queue.flush(src.creds);
      expect(kwArgs("mark_all_as_read")).toEqual([[[["needaction", "=", true], ["id", "<=", 801]]]]);
      expect([...unread]).toEqual([805]);
      await chat.inbox.refresh(src, "inbox");
      expect(await shown()).toEqual([805]);
    });

    it("an op queued while a load writes its counters still counts", async () => {
      odoo.state.data.Store.starred = { counter: 2, counter_bus_id: 1000, id: "starred", model: "mail.box" };
      await chat.inbox.refresh(src, "inbox");
      await chat.load(src);
      const apply = chat.repo.applyDelta.bind(chat.repo);
      let queued: Promise<unknown> | null = null;
      vi.spyOn(chat.repo, "applyDelta").mockImplementationOnce(async (configId, delta, opts) => {
        // The load read the queued ops for its overlay: a star and a done queued now come before its write
        queued = Promise.all([chat.queue.queueStar(config, 600, true, GROUP), chat.queue.queueInboxDone(config, [801])]);
        await new Promise((r) => setTimeout(r, 20));
        return apply(configId, delta, opts);
      });
      await chat.load(src);
      await queued;
      expect((await chat.repo.sourceState(config)).starredCounter).toBe(3);
      expect(await counter()).toBe(3);
      expect(await mentions()).toBe(1);
    });
  });

  describe("reactions", () => {
    let odoo: ReturnType<typeof fakeOdoo>;
    let server: ReturnType<typeof reactionServer>;
    let src: ChatSource;
    const THUMBS = "\u{1F44D}";
    const HEART = "\u2764\uFE0F";
    const sent = (messageId: number) => ({ messageId, clientUuid: null });
    const groupOf = async (channelId: number, key: string, content: string) =>
      (await chat.reactions(config, channelId, [key])).get(key)?.find((r) => r.content === content) ?? null;
    const reactionOps = async () => (await env.db.getOutboxOpsForConfig(config)).filter((o) => o.kind === "chat.reaction");
    /** Message 600 of the group as /mail/data sends it, with `reactions` its full set and `groups` its MessageReactions. */
    const serverReactions = (contents: string[], groups: any[]) => {
      const data = odoo.state.data;
      data["mail.message"].find((m: any) => m.id === 600).reactions = contents.map((content) => ({ message: 600, content }));
      data.MessageReactions = groups;
    };
    /** What /mail/data answers for message 600 follows the server's reactions of it. */
    const mirror = () => {
      const rows = server.state.rows.filter((r) => r.messageId === 600);
      const contents = [...new Set(rows.map((r) => r.content))];
      serverReactions(contents, contents.map((content) => {
        const of = rows.filter((r) => r.content === content);
        return { content, count: of.length, sequence: 1, message: 600, personas: of.map((r) => ({ id: r.partnerId, type: "partner" })) };
      }));
    };
    /** The app killed and started again: a new service over the same database, its interrupted rows failed. */
    const reborn = async () => {
      chat.dispose();
      const rpc = new OdooRpcClient();
      chat = new ChatService(env.db, rpc, new OutboxService(env.db, () => clock), new CapabilityService(env.db, rpc), () => clock);
      await new OutboxService(env.db, () => clock).recoverInterrupted();
      await chat.recover();
    };

    beforeEach(async () => {
      odoo = fakeOdoo();
      server = reactionServer(odoo);
      src = await source();
      await chat.load(src);
    });

    it("a reaction sends action add with the exact content", async () => {
      await chat.react(src, GROUP, sent(600), HEART, true);
      expect(server.calls()).toEqual([{ message_id: 600, content: "\u2764\uFE0F", action: "add" }]);
      expect(server.state.rows).toEqual([{ messageId: 600, content: HEART, partnerId: SELF }]);
      expect(await groupOf(GROUP, "m600", HEART)).toMatchObject({ count: 1, selfReacted: true, partnerIds: [SELF] });
      expect(await reactionOps()).toEqual([]);
      // Counted for the quick bar; a removal is not
      await chat.react(src, GROUP, sent(600), HEART, false);
      expect(JSON.parse(localStorage.getItem("chat.emoji.frequent")!)).toEqual({ [HEART]: 1 });
      expect(server.calls().map((c) => c.action)).toEqual(["add", "remove"]);
      expect(await groupOf(GROUP, "m600", HEART)).toBeNull();
    });

    it("add then remove offline sends nothing", async () => {
      offline();
      await chat.react(src, GROUP, sent(600), THUMBS, true);
      expect(await groupOf(GROUP, "m600", THUMBS)).toMatchObject({ count: 1, selfReacted: true });
      await chat.react(src, GROUP, sent(600), THUMBS, false);
      expect(await groupOf(GROUP, "m600", THUMBS)).toBeNull();
      expect(await reactionOps()).toEqual([]);
      online();
      await chat.flushAll();
      expect(server.calls()).toEqual([]);
    });

    it("remove then add of a server reaction sends nothing", async () => {
      serverReactions([THUMBS], [{
        content: THUMBS, count: 2, sequence: 5, message: 600,
        personas: [{ id: BOB, type: "partner" }, { id: SELF, type: "partner" }],
      }]);
      server.state.rows = [{ messageId: 600, content: THUMBS, partnerId: BOB }, { messageId: 600, content: THUMBS, partnerId: SELF }];
      await chat.load(src);
      offline();
      await chat.react(src, GROUP, sent(600), THUMBS, false);
      expect(await groupOf(GROUP, "m600", THUMBS)).toMatchObject({ count: 1, selfReacted: false, partnerIds: [BOB] });
      expect((await reactionOps()).map((o) => o.params)).toEqual([expect.objectContaining({ action: "remove", base: true })]);
      await chat.react(src, GROUP, sent(600), THUMBS, true);
      expect(await groupOf(GROUP, "m600", THUMBS)).toMatchObject({ count: 2, selfReacted: true });
      expect(await reactionOps()).toEqual([]);
      online();
      await chat.flushAll();
      expect(server.calls()).toEqual([]);
    });

    it("add, remove, add offline sends one add", async () => {
      offline();
      await chat.react(src, GROUP, sent(600), THUMBS, true);
      await chat.react(src, GROUP, sent(600), THUMBS, false);
      await chat.react(src, GROUP, sent(600), THUMBS, true);
      expect((await reactionOps()).map((o) => o.params)).toEqual([expect.objectContaining({ action: "add", base: false })]);
      online();
      await chat.flushAll();
      expect(server.calls()).toEqual([{ message_id: 600, content: THUMBS, action: "add" }]);
      expect(server.state.rows).toHaveLength(1);
      expect(await groupOf(GROUP, "m600", THUMBS)).toMatchObject({ count: 1, selfReacted: true });
    });

    it("a reaction while one runs queues a follow-up", async () => {
      let release!: () => void;
      server.state.hold = new Promise<void>((r) => { release = r; });
      const first = chat.react(src, GROUP, sent(600), THUMBS, true);
      await vi.waitFor(() => expect(server.calls()).toHaveLength(1));
      await chat.react(src, GROUP, sent(600), THUMBS, false);
      const ops = await reactionOps();
      const sending = ops.find((o) => o.status === "running")!;
      expect(sending.params.action).toBe("add");
      expect(ops.filter((o) => o !== sending).map((o) => [o.status, o.params.action, o.dependsOn])).toEqual([["queued", "remove", sending.id]]);
      expect(await groupOf(GROUP, "m600", THUMBS)).toBeNull();
      server.state.hold = null;
      release();
      await first;
      // The answer of the add does not show the reaction the follow-up removes
      expect(await groupOf(GROUP, "m600", THUMBS)).toBeNull();
      await chat.flushAll();
      expect(server.calls().map((c) => c.action)).toEqual(["add", "remove"]);
      expect(server.state.rows).toEqual([]);
      expect(await groupOf(GROUP, "m600", THUMBS)).toBeNull();
      expect(await reactionOps()).toEqual([]);
    });

    it("a dropped reaction answer leaves one reaction", async () => {
      server.state.drop = 1;
      await chat.react(src, GROUP, sent(600), THUMBS, true);
      expect(server.state.rows).toHaveLength(1);
      expect((await reactionOps()).map((o) => o.status)).toEqual(["failed"]);
      await chat.flushAll({ force: true });
      expect(server.calls().map((c) => c.action)).toEqual(["add", "add"]);
      expect(server.state.rows).toEqual([{ messageId: 600, content: THUMBS, partnerId: SELF }]);
      expect(await groupOf(GROUP, "m600", THUMBS)).toMatchObject({ count: 1, selfReacted: true });
      expect(await reactionOps()).toEqual([]);
    });

    it("a toggle back after a dropped answer is still sent", async () => {
      server.state.drop = 1;
      await chat.react(src, GROUP, sent(600), THUMBS, true);
      expect(server.state.rows).toHaveLength(1);
      await chat.react(src, GROUP, sent(600), THUMBS, false);
      await chat.flushAll({ force: true });
      expect(server.calls().map((c) => c.action)).toEqual(["add", "remove"]);
      expect(server.state.rows).toEqual([]);
      mirror();
      await chat.load(src);
      expect(await groupOf(GROUP, "m600", THUMBS)).toBeNull();
    });

    it("a toggle back after a kill during the send is still sent", async () => {
      server.state.hang = 1;
      void chat.react(src, GROUP, sent(600), THUMBS, true);
      await vi.waitFor(() => expect(server.state.rows).toHaveLength(1));
      await reborn();
      await chat.react(src, GROUP, sent(600), THUMBS, false);
      await chat.flushAll({ force: true });
      expect(server.calls().map((c) => c.action)).toEqual(["add", "remove"]);
      expect(server.state.rows).toEqual([]);
      mirror();
      await chat.load(src);
      expect(await groupOf(GROUP, "m600", THUMBS)).toBeNull();
    });

    it("with two ops waiting, a tap is a no-op against the first one's base", async () => {
      let release!: () => void;
      server.state.hold = new Promise<void>((r) => { release = r; });
      server.state.unsent = 1;
      const first = chat.react(src, GROUP, sent(600), THUMBS, true);
      await vi.waitFor(() => expect(server.calls()).toHaveLength(1));
      // A follow-up behind the add on the wire, then the add never reaches the server
      advance(1000);
      await chat.react(src, GROUP, sent(600), THUMBS, false);
      server.state.hold = null;
      release();
      await first;
      expect((await reactionOps()).map((o) => o.params.base).sort()).toEqual([false, true]);
      await chat.react(src, GROUP, sent(600), THUMBS, true);
      await chat.flushAll({ force: true });
      expect(server.state.rows).toEqual([{ messageId: 600, content: THUMBS, partnerId: SELF }]);
      expect(await groupOf(GROUP, "m600", THUMBS)).toMatchObject({ count: 1, selfReacted: true });
      expect(await reactionOps()).toEqual([]);
    });

    it("a browser change read while a reaction waits is the base its next tap compares with", async () => {
      offline();
      await chat.react(src, GROUP, sent(600), THUMBS, true);
      // The user adds the same reaction in the browser; a load reads it
      server.state.rows = [{ messageId: 600, content: THUMBS, partnerId: SELF }];
      mirror();
      await chat.load(src);
      expect((await reactionOps()).map((o) => o.params.base)).toEqual([true]);
      await chat.react(src, GROUP, sent(600), THUMBS, false);
      online();
      await chat.flushAll();
      expect(server.calls().map((c) => c.action)).toEqual(["remove"]);
      expect(server.state.rows).toEqual([]);
      mirror();
      await chat.load(src);
      expect(await groupOf(GROUP, "m600", THUMBS)).toBeNull();
    });

    it("a failed message takes no reaction", async () => {
      odoo.state.onPost = async () => ({ __error: "odoo.exceptions.AccessError" });
      const failed = await chat.send(src, GROUP, "refused");
      expect((await chat.messages(config, GROUP)).find((m) => m.clientUuid === failed.clientUuid)!.status).toBe("failed");
      await expect(chat.react(src, GROUP, { messageId: null, clientUuid: failed.clientUuid }, THUMBS, true)).rejects.toThrow();
      expect(await reactionOps()).toEqual([]);
      expect(await groupOf(GROUP, `u${failed.clientUuid}`, THUMBS)).toBeNull();
    });

    it("a tap back is never taken for a no-op over an op sent during the tap", async () => {
      offline();
      await chat.react(src, GROUP, sent(600), THUMBS, true);
      const [op] = await reactionOps();
      const update = env.db.updateOutboxOp.bind(env.db);
      let ran = false;
      vi.spyOn(env.db, "updateOutboxOp").mockImplementation(async (id, patch) => {
        await update(id, patch);
        // The op runs, is sent and fails between the tap's lookup and its cancel
        if (id === op.id && patch.params?.action === "remove" && !ran) {
          ran = true;
          await update(id, { status: "failed", params: { ...patch.params, sentAt: clock.toISOString() } });
        }
      });
      await chat.react(src, GROUP, sent(600), THUMBS, false);
      const after = await reactionOps();
      expect(after.find((o) => o.id === op.id)).toBeDefined();
      expect(after.filter((o) => o.id !== op.id).map((o) => [o.dependsOn, o.params.action])).toEqual([[op.id, "remove"]]);
    });

    it("a reaction cancelled as it starts is not sent", async () => {
      offline();
      await chat.react(src, GROUP, sent(600), THUMBS, true);
      const [op] = await reactionOps();
      const update = env.db.updateOutboxOp.bind(env.db);
      vi.spyOn(env.db, "updateOutboxOp").mockImplementation(async (id, patch) => {
        await update(id, patch);
        // Its row goes between the "running" mark and the handler's read
        if (id === op.id && patch.status === "running") await env.db.deleteOutboxOp(id);
      });
      online();
      await chat.flushAll();
      expect(server.calls()).toEqual([]);
    });

    it("a reaction on a message deleted meanwhile is dropped with a notice", async () => {
      const thread = { id: GROUP, model: "discuss.channel" };
      await chat.applyBus(config, [bus(1001, "mail.record/insert", { "mail.message": [msg(599, GROUP)] })]);
      offline();
      await chat.react(src, GROUP, sent(600), THUMBS, true);
      await chat.react(src, GROUP, sent(599), THUMBS, true);
      // Deleted in the browser: emptied (Odoo's delete), or unlinked
      await chat.applyBus(config, [
        bus(1002, "mail.record/insert", { "mail.message": [{ id: 600, thread, body: '<span class="o-mail-Message-edited"></span>' }] }),
        bus(1003, "mail.message/delete", { message_ids: [599] }),
      ]);
      online();
      await chat.flushAll();
      expect(server.calls()).toEqual([]);
      expect((await chat.notices()).sort((a, b) => a.message!.messageId! - b.message!.messageId!)).toEqual([
        expect.objectContaining({ kind: "chat.reaction", channelId: GROUP, reason: "vanished", message: { messageId: 599, clientUuid: null } }),
        expect.objectContaining({ kind: "chat.reaction", channelId: GROUP, reason: "vanished", message: { messageId: 600, clientUuid: null } }),
      ]);
    });

    it("NotFound gives the vanished notice", async () => {
      server.state.missing.add(600);
      await chat.react(src, GROUP, sent(600), THUMBS, true);
      expect(server.calls()).toHaveLength(1);
      expect(await chat.notices()).toEqual([
        expect.objectContaining({ kind: "chat.reaction", channelId: GROUP, reason: "vanished", message: { messageId: 600, clientUuid: null } }),
      ]);
      // Not shown as done
      expect(await groupOf(GROUP, "m600", THUMBS)).toBeNull();
      // A refusal is the refused notice
      odoo.state.onRoute = async () => ({ __error: "odoo.exceptions.AccessError" });
      await chat.react(src, GROUP, sent(600), HEART, true);
      expect((await chat.notices()).map((n) => [n.reason, n.error]).sort())
        .toEqual([["refused", expect.stringContaining("refused")], ["vanished", ""]]);
      expect(await groupOf(GROUP, "m600", HEART)).toBeNull();
    });

    it("notices of two messages' reactions do not supersede each other", async () => {
      await chat.applyBus(config, [bus(1001, "mail.record/insert", { "mail.message": [msg(599, GROUP)] })]);
      server.state.missing = new Set([599, 600]);
      offline();
      await chat.react(src, GROUP, sent(600), THUMBS, true);
      await chat.react(src, GROUP, sent(599), THUMBS, true);
      online();
      await chat.flushAll();
      expect((await chat.notices()).map((n) => n.message?.messageId).sort()).toEqual([599, 600]);
    });

    it("a reaction on a pending message waits for its post and sends its server id", async () => {
      offline();
      const pending = await chat.send(src, GROUP, "hello");
      await chat.react(src, GROUP, { messageId: null, clientUuid: pending.clientUuid }, THUMBS, true);
      await chat.send(src, GROUP, "after");
      const ops = await env.db.getOutboxOpsForConfig(config);
      const post = ops.find((o) => o.kind === "chat.post" && o.params.text === "hello")!;
      const [reaction] = await reactionOps();
      expect(reaction.dependsOn).toBe(post.id);
      expect(reaction.params).toMatchObject({ channelId: GROUP, messageId: null, clientUuid: pending.clientUuid, action: "add", base: false });
      // The channel's posts still wait for each other
      expect(ops.find((o) => o.kind === "chat.post" && o.params.text === "after")!.dependsOn).toBe(post.id);
      expect(await groupOf(GROUP, `u${pending.clientUuid}`, THUMBS)).toMatchObject({ count: 1, selfReacted: true });
      online();
      await chat.flushAll();
      const sentId = (await chat.repo.messageByClientUuid(config, pending.clientUuid!))!.messageId!;
      expect(sentId).toEqual(expect.any(Number));
      expect(server.calls()).toEqual([{ message_id: sentId, content: THUMBS, action: "add" }]);
      const paths = odoo.calls.map((c) => c.path);
      expect(paths.indexOf("/mail/message/reaction")).toBeGreaterThan(paths.indexOf("/mail/message/post"));
      expect(await groupOf(GROUP, `m${sentId}`, THUMBS)).toMatchObject({ count: 1, selfReacted: true });
      expect(await env.db.getOutboxOpsForConfig(config)).toEqual([]);
    });

    it("a reaction on a pending message survives a restart", async () => {
      offline();
      const pending = await chat.send(src, GROUP, "hello");
      await chat.react(src, GROUP, { messageId: null, clientUuid: pending.clientUuid }, THUMBS, true);
      // The app is killed: a new service over the same database, then the network is back
      chat.dispose();
      const rpc = new OdooRpcClient();
      chat = new ChatService(env.db, rpc, new OutboxService(env.db, () => clock), new CapabilityService(env.db, rpc), () => clock);
      await chat.recover();
      online();
      await chat.flushAll();
      const sentId = (await chat.repo.messageByClientUuid(config, pending.clientUuid!))!.messageId!;
      expect(odoo.on("/mail/message/post")).toHaveLength(1);
      expect(server.calls()).toEqual([{ message_id: sentId, content: THUMBS, action: "add" }]);
      expect(await groupOf(GROUP, `m${sentId}`, THUMBS)).toMatchObject({ count: 1, selfReacted: true });
    });

    it("a load between the tap and the send keeps the optimistic reaction", async () => {
      // The server has Bob's and the user's heart, and no thumbs
      serverReactions([HEART], [{
        content: HEART, count: 2, sequence: 5, message: 600,
        personas: [{ id: BOB, type: "partner" }, { id: SELF, type: "partner" }],
      }]);
      server.state.rows = [{ messageId: 600, content: HEART, partnerId: BOB }, { messageId: 600, content: HEART, partnerId: SELF }];
      await chat.load(src);
      offline();
      await chat.react(src, GROUP, sent(600), THUMBS, true);
      await chat.react(src, GROUP, sent(600), HEART, false);
      await chat.load(src);
      expect(await groupOf(GROUP, "m600", THUMBS)).toMatchObject({ count: 1, selfReacted: true, partnerIds: [SELF] });
      expect(await groupOf(GROUP, "m600", HEART)).toMatchObject({ count: 1, selfReacted: false, partnerIds: [BOB] });
      // A bus record carrying the server's set keeps them too
      await chat.applyBus(config, [bus(1001, "mail.record/insert", {
        "mail.message": [{ id: 600, reactions: [{ message: 600, content: HEART }] }],
        MessageReactions: [{ content: HEART, count: 2, sequence: 5, message: 600,
          personas: [{ id: BOB, type: "partner" }, { id: SELF, type: "partner" }] }],
      })]);
      expect(await groupOf(GROUP, "m600", THUMBS)).toMatchObject({ count: 1, selfReacted: true });
      expect(await groupOf(GROUP, "m600", HEART)).toMatchObject({ count: 1, selfReacted: false });
      online();
      await chat.flushAll();
      // Two keys, sent in either order
      expect(server.calls().map((c) => [c.content, c.action]).sort()).toEqual([[THUMBS, "add"], [HEART, "remove"]].sort());
      expect(await groupOf(GROUP, "m600", HEART)).toMatchObject({ count: 1, selfReacted: false, partnerIds: [BOB] });
    });

    it("a history page keeps the optimistic reaction", async () => {
      await chat.loadOlder(src, CHAT);
      offline();
      await chat.react(src, CHAT, sent(80), THUMBS, true);
      // The next page answers the messages above it too, each with its full set: none
      odoo.state.pageRecord = () => ({ reactions: [] });
      await chat.loadOlder(src, CHAT);
      expect(await groupOf(CHAT, "m80", THUMBS)).toMatchObject({ count: 1, selfReacted: true });
    });
  });

  describe("edit and delete", () => {
    let odoo: ReturnType<typeof fakeOdoo>;
    let server: ReturnType<typeof editServer>;
    let src: ChatSource;
    const HELLO = "<p>hello</p>";
    const EDITED = '<span class="o-mail-Message-edited"></span>';
    const BOB_PICK: Mentions = { partners: [{ id: BOB, name: "Bob" }], channels: [] };
    const NONE: Mentions = { partners: [], channels: [] };
    const sent = (messageId: number) => ({ messageId, clientUuid: null });
    const bodyOf = async (messageId: number) => (await chat.repo.message(config, messageId))?.body;
    const ops = async (kind?: string) => (await env.db.getOutboxOpsForConfig(config)).filter((o) => !kind || o.kind === kind);
    const browserHtml = async (text: string, m: Mentions) => composeBody(text, m, await emojiConversions()).body;
    const withModule = async () => {
      server.state.module = true;
      await chat.repo.setSourceState({ configId: config, moduleState: "installed", moduleLevel: "1.4" });
    };

    beforeEach(async () => {
      odoo = fakeOdoo();
      server = editServer(odoo);
      // Two messages of the user in the group, as the server holds them
      odoo.state.data["mail.message"].push(msg(601, GROUP, SELF, HELLO), msg(602, GROUP, SELF, "<p>bye</p>"));
      server.state.bodies.set(601, HELLO).set(602, "<p>bye</p>");
      src = await source();
      await chat.load(src);
    });

    it("an edit sends attachment_ids null and the browser HTML", async () => {
      const text = "hi @Bob\nsee www.example.com";
      await chat.editMessage(src, GROUP, sent(601), text, BOB_PICK);
      const body = await browserHtml(text, BOB_PICK);
      expect(body).toContain('data-oe-id="4"');
      expect(body).toContain("<br>");
      expect(server.edits().map((c) => [c.path, c.params])).toEqual([["/mail/message/update_content", {
        message_id: 601, body, attachment_ids: null, partner_ids: [BOB],
      }]]);
      // Re-read just before the write, without the module
      expect(server.reads()).toHaveLength(1);
      expect(await bodyOf(601)).toBe(`<p>${body}${EDITED}</p>`);
      expect(await ops()).toEqual([]);
    });

    it("an edit to the text it already has sends nothing", async () => {
      expect(await chat.queue.queueEdit(config, GROUP, sent(601), "hello", NONE)).toBeNull();
      expect(await ops()).toEqual([]);
    });

    it("an edit back to the server's text writes nothing, both paths", async () => {
      for (const guarded of [false, true]) {
        if (guarded) await withModule();
        offline();
        await chat.editMessage(src, GROUP, sent(601), "x", NONE);
        await chat.editMessage(src, GROUP, sent(601), "hello", NONE);
        // Nothing left to send: the base shows again
        expect(await ops()).toEqual([]);
        expect(await bodyOf(601)).toBe(HELLO);
        online();
        await chat.flushAll();
        expect(server.edits()).toEqual([]);
      }
    });

    it("a caption added to a photo-only message without the module is written", async () => {
      await chat.applyBus(config, [bus(1001, "mail.record/insert", { "mail.message": [{ ...msg(603, GROUP, SELF, ""), attachment_ids: [77] }] })]);
      server.state.bodies.set(603, "");
      server.state.files.set(603, [77]);
      await chat.editMessage(src, GROUP, sent(603), "a caption", NONE);
      expect(server.edits().map((c) => c.params)).toEqual([expect.objectContaining({ message_id: 603, body: "a caption", attachment_ids: null })]);
      expect(server.state.bodies.get(603)).toBe(`<p>a caption${EDITED}</p>`);
      expect(server.state.files.get(603)).toEqual([77]);
      expect(await chat.notices()).toEqual([]);
    });

    it("an edit while its post runs survives the post's lost answer", async () => {
      let release!: () => void;
      const held = new Promise<void>((r) => { release = r; });
      odoo.state.onPost = async (params, id) => {
        server.state.bodies.set(id, params.post_data.body);
        await held;
        throw new TypeError("Failed to fetch");
      };
      const sending = chat.send(src, GROUP, "helo");
      await vi.waitFor(() => expect(odoo.on("/mail/message/post")).toHaveLength(1));
      const pending = (await chat.messages(config, GROUP)).find((m) => m.messageId === null)!;
      await chat.editMessage(src, GROUP, { messageId: null, clientUuid: pending.clientUuid }, "hello", NONE);
      release();
      await sending;
      // The retry finds the post by its marker and settles it with the body the server holds
      clock = new Date(clock.getTime() + CREATE_QUIET_WINDOW_MS + 1000);
      odoo.state.onPost = null;
      await chat.flushAll({ force: true });
      await chat.flushAll({ force: true });
      expect(odoo.on("/mail/message/post")).toHaveLength(1);
      expect(server.state.bodies.get(5000)).toBe(`<p>hello${EDITED}</p>`);
      expect(await chat.notices()).toEqual([]);
      expect(await ops()).toEqual([]);
    });

    it("a post found again after a lost answer settles on the server's body", async () => {
      odoo.state.onPost = async (params, id) => {
        server.state.bodies.set(id, `<p>${params.post_data.body}</p>`);
        throw new TypeError("Failed to fetch");
      };
      await chat.send(src, GROUP, "found again");
      clock = new Date(clock.getTime() + CREATE_QUIET_WINDOW_MS + 1000);
      odoo.state.onPost = null;
      await chat.flushAll({ force: true });
      expect(odoo.on("/mail/message/post")).toHaveLength(1);
      expect(await bodyOf(5000)).toBe(server.state.bodies.get(5000));
    });

    it("a browser edit before the post's retried settle refuses the edit", async () => {
      await chat.repo.setSourceState({ configId: config, moduleState: "outdated", moduleLevel: "1.0" });
      let release!: () => void;
      const held = new Promise<void>((r) => { release = r; });
      odoo.state.onPost = async (params, id) => {
        server.state.bodies.set(id, params.post_data.body);
        await held;
        // Echoed by the bus, then the answer is lost
        await chat.applyBus(config, [bus(1001, "discuss.channel/new_message", {
          id: params.thread_id, temporary_id: params.context.temporary_id,
          data: { "mail.message": [msg(id, params.thread_id, SELF, params.post_data.body)] },
        })]);
        throw new TypeError("Failed to fetch");
      };
      const sending = chat.send(src, GROUP, "helo");
      await vi.waitFor(() => expect(odoo.on("/mail/message/post")).toHaveLength(1));
      const pending = (await chat.messages(config, GROUP)).find((m) => m.messageId === null)!;
      await chat.editMessage(src, GROUP, { messageId: null, clientUuid: pending.clientUuid }, "hello", NONE);
      release();
      await sending;
      // Edited in the browser: the body loses the post's marker, and its record reaches the phone
      server.state.bodies.set(5000, `<p>browser${EDITED}</p>`);
      await chat.applyBus(config, [bus(1002, "mail.record/insert", { "mail.message": [
        { id: 5000, body: `<p>browser${EDITED}</p>`, thread: { id: GROUP, model: "discuss.channel" } },
      ] })]);
      expect((await ops("chat.edit"))[0].params.baseBody).toBeNull();
      // The retried post finds no marker; the module answers the message it holds
      clock = new Date(clock.getTime() + CREATE_QUIET_WINDOW_MS + 1000);
      odoo.state.onPost = async () => ({ __id: 5000, __body: server.state.bodies.get(5000) });
      await chat.flushAll({ force: true });
      await chat.flushAll({ force: true });
      expect(server.edits()).toEqual([]);
      expect(server.state.bodies.get(5000)).toBe(`<p>browser${EDITED}</p>`);
      expect((await chat.notices()).map((n) => [n.kind, n.reason, n.edit?.text])).toEqual([["chat.edit", "changed", "hello"]]);
    });

    it("a refused running edit takes its waiting follow-up into one notice", async () => {
      await withModule();
      let release!: () => void;
      server.state.hold = new Promise<void>((r) => { release = r; });
      const first = chat.editMessage(src, GROUP, sent(601), "one", NONE);
      await vi.waitFor(() => expect(server.edits()).toHaveLength(1));
      await chat.editMessage(src, GROUP, sent(601), "two", BOB_PICK);
      // The browser edits while the first is on the wire
      server.state.bodies.set(601, `<p>browser${EDITED}</p>`);
      server.state.hold = null;
      release();
      await first;
      await chat.flushAll();
      expect(server.edits()).toHaveLength(1);
      expect(await ops("chat.edit")).toEqual([expect.objectContaining({ status: "blocked" })]);
      expect((await chat.notices()).map((n) => n.edit)).toEqual([
        { target: { messageId: 601, clientUuid: null }, text: "two", mentions: BOB_PICK, deleted: false },
      ]);
      expect(await bodyOf(601)).toBe(`<p>browser${EDITED}</p>`);
    });

    it("two offline edits send the last text once", async () => {
      offline();
      await chat.editMessage(src, GROUP, sent(601), "one", NONE);
      await chat.editMessage(src, GROUP, sent(601), "two", NONE);
      expect((await ops("chat.edit")).map((o) => o.params)).toEqual([
        expect.objectContaining({ channelId: GROUP, messageId: 601, clientUuid: null, text: "two", baseBody: HELLO }),
      ]);
      expect(await bodyOf(601)).toBe(`two${EDITED}`);
      online();
      await chat.flushAll();
      expect(server.edits().map((c) => c.params.body)).toEqual(["two"]);
      expect(await bodyOf(601)).toBe(`<p>two${EDITED}</p>`);
    });

    it("edit of a pending post rewrites it", async () => {
      offline();
      const pending = await chat.send(src, GROUP, "helo");
      await chat.editMessage(src, GROUP, { messageId: null, clientUuid: pending.clientUuid }, "hello @Bob", BOB_PICK);
      expect(await ops("chat.edit")).toEqual([]);
      expect((await ops("chat.post")).map((o) => o.params)).toEqual([
        expect.objectContaining({ text: "hello @Bob", mentions: BOB_PICK }),
      ]);
      expect((await chat.repo.messageByClientUuid(config, pending.clientUuid!))!.body).toBe(await browserHtml("hello @Bob", BOB_PICK));
      online();
      await chat.flushAll();
      expect(odoo.on("/mail/message/post")).toHaveLength(1);
      expect(odoo.on("/mail/message/post")[0].params.post_data.body).toMatch(/^hello /);
      expect(server.edits()).toEqual([]);
    });

    it("an edit folded into a pending post sends its partner_ids", async () => {
      offline();
      const pending = await chat.send(src, GROUP, "helo");
      await chat.editMessage(src, GROUP, { messageId: null, clientUuid: pending.clientUuid }, "hello @Bob", BOB_PICK);
      online();
      await chat.flushAll();
      const [post] = odoo.on("/mail/message/post");
      expect(post.params.post_data.partner_ids).toEqual([BOB]);
      expect(post.params.post_data.body.startsWith(await browserHtml("hello @Bob", BOB_PICK))).toBe(true);
    });

    it("send passes its mentions and reply target to the post", async () => {
      const text = "@Bob @everyone see";
      await chat.send(src, GROUP, text, [], { mentions: BOB_PICK, replyTo: sent(601) });
      const [post] = odoo.on("/mail/message/post");
      expect(post.params.post_data).toMatchObject({ partner_ids: [BOB], special_mentions: ["everyone"], parent_id: 601 });
      expect(post.params.post_data.body.startsWith(await browserHtml(text, BOB_PICK))).toBe(true);
      expect((await chat.messages(config, GROUP)).find((m) => m.messageId === 5000)).toMatchObject({ parentId: 601 });
    });

    it("delete of a pending post cancels it and its uploads", async () => {
      const files = fileServer(odoo, () => clock);
      chat.useFileIO({ files: files.files, http: files.http });
      const fileDir = await chat.fileDirOf(config);
      const localUuid = uuidv4();
      const path = outgoingPath(fileDir, localUuid, "a.jpg");
      files.files.put(path, new Uint8Array(3).fill(7));
      offline();
      const pending = await chat.send(src, GROUP, "with a file", [
        { localUuid, path, name: "a.jpg", mimetype: "image/jpeg", size: 3, voice: false },
      ]);
      const target = { messageId: null, clientUuid: pending.clientUuid };
      await chat.react(src, GROUP, target, "\u{1F44D}", true);
      expect((await ops()).map((o) => o.kind).sort()).toEqual(["chat.post", "chat.reaction", "chat.upload"]);
      const outbox = (chat.queue as any).outbox as OutboxService;
      const kinds = new Map((await ops()).map((o) => [o.id, o.kind]));
      const cancelled = vi.spyOn(outbox, "cancel");
      await chat.deleteMessage(src, GROUP, target);
      // The post goes last: an action cut off before it never runs against a row without its post
      expect(cancelled.mock.calls.map(([id]) => kinds.get(id)).at(-1)).toBe("chat.post");
      expect(await ops()).toEqual([]);
      expect(await chat.repo.messageByClientUuid(config, pending.clientUuid!)).toBeNull();
      expect(await chat.repo.outgoingOf(config, pending.clientUuid!)).toEqual([]);
      expect(files.files.bytes(path)).toBeUndefined();
      expect(await chat.reactions(config, GROUP, [`u${pending.clientUuid}`])).toEqual(new Map());
      online();
      await chat.flushAll();
      await chat.queue.whenIdle(config);
      expect(odoo.on("/mail/message/post")).toEqual([]);
      expect(files.uploads()).toEqual([]);
      expect(server.edits()).toEqual([]);
    });

    it("delete of a running post waits and then deletes", async () => {
      let release!: () => void;
      const held = new Promise<void>((r) => { release = r; });
      odoo.state.onPost = async (params, id) => {
        server.state.bodies.set(id, params.post_data.body);
        await held;
      };
      const sending = chat.send(src, GROUP, "soon gone");
      await vi.waitFor(() => expect(odoo.on("/mail/message/post")).toHaveLength(1));
      const pending = (await chat.messages(config, GROUP)).find((m) => m.messageId === null)!;
      const post = (await ops("chat.post"))[0];
      const deleting = chat.deleteMessage(src, GROUP, { messageId: null, clientUuid: pending.clientUuid });
      await vi.waitFor(async () => expect((await ops("chat.delete")).map((o) => o.dependsOn)).toEqual([post.id]));
      release();
      await sending;
      await deleting;
      await chat.flushAll();
      expect(server.edits().map((c) => c.params)).toEqual([
        { message_id: 5000, body: "", attachment_ids: [], attachment_tokens: [], subject: "" },
      ]);
      expect(server.state.bodies.get(5000)).toBe(EDITED);
      expect(await bodyOf(5000)).toBe(EDITED);
      expect(await ops()).toEqual([]);
    });

    it("an edit while its post runs waits for it and is made against the post's answer", async () => {
      let releasePost!: () => void;
      const posting = new Promise<void>((r) => { releasePost = r; });
      odoo.state.onPost = async (params, id) => {
        server.state.bodies.set(id, params.post_data.body);
        await posting;
      };
      const sending = chat.send(src, GROUP, "helo");
      await vi.waitFor(() => expect(odoo.on("/mail/message/post")).toHaveLength(1));
      const pending = (await chat.messages(config, GROUP)).find((m) => m.messageId === null)!;
      const post = (await ops("chat.post"))[0];
      await chat.editMessage(src, GROUP, { messageId: null, clientUuid: pending.clientUuid }, "hello", NONE);
      expect((await ops("chat.edit")).map((o) => [o.dependsOn, o.params.baseBody])).toEqual([[post.id, null]]);
      releasePost();
      await sending;
      // Settled: the bubble still shows the edit, which is made against the body the post's answer gave
      expect(server.edits()).toEqual([]);
      expect((await ops("chat.edit"))[0].params.baseBody).toBe(server.state.bodies.get(5000));
      expect(await bodyOf(5000)).toBe(`hello${EDITED}`);
      await chat.flushAll();
      expect(server.state.bodies.get(5000)).toBe(`<p>hello${EDITED}</p>`);
      expect(await chat.notices()).toEqual([]);
    });

    it("a delete cancels the waiting edit of the message", async () => {
      offline();
      await chat.editMessage(src, GROUP, sent(601), "changed my mind", NONE);
      await chat.react(src, GROUP, sent(601), "\u{1F44D}", true);
      await chat.deleteMessage(src, GROUP, sent(601));
      expect((await ops()).map((o) => o.kind)).toEqual(["chat.delete"]);
      expect(await bodyOf(601)).toBe("");
      // An edit of a message being deleted is refused
      await expect(chat.queue.queueEdit(config, GROUP, sent(601), "again", NONE)).rejects.toThrow();
      online();
      await chat.flushAll();
      expect(server.edits().map((c) => c.params.body)).toEqual([""]);
      expect(odoo.on("/mail/message/reaction")).toEqual([]);
      expect(server.state.bodies.get(601)).toBe(EDITED);
    });

    it("the module path sends the fingerprint of the base body", async () => {
      await withModule();
      offline();
      await chat.editMessage(src, GROUP, sent(601), "guarded", NONE);
      online();
      await chat.flushAll();
      expect(server.edits().map((c) => [c.path, c.params])).toEqual([[MODULE_EDIT_ROUTE, {
        message_id: 601,
        body: "guarded",
        expected_fingerprint: createHash("sha256").update(HELLO, "utf8").digest("hex"),
        attachment_ids: null,
        partner_ids: [],
      }]]);
      expect(server.reads()).toEqual([]);
      expect(await bodyOf(601)).toBe(`<p>guarded${EDITED}</p>`);
    });

    it("a module conflict refuses the edit with its text", async () => {
      await withModule();
      offline();
      await chat.editMessage(src, GROUP, sent(601), "late @Bob", BOB_PICK);
      // Edited in the browser meanwhile
      server.state.bodies.set(601, `<p>browser${EDITED}</p>`);
      online();
      await chat.flushAll();
      expect(server.edits()).toHaveLength(1);
      expect(server.state.bodies.get(601)).toBe(`<p>browser${EDITED}</p>`);
      expect(await bodyOf(601)).toBe(`<p>browser${EDITED}</p>`);
      expect(await chat.notices()).toEqual([expect.objectContaining({
        kind: "chat.edit", channelId: GROUP, reason: "changed",
        message: { messageId: 601, clientUuid: null },
        edit: { target: { messageId: 601, clientUuid: null }, text: "late @Bob", mentions: BOB_PICK, deleted: false },
      })]);
    });

    it("a module conflict on a deleted message refuses as deleted", async () => {
      await withModule();
      offline();
      await chat.editMessage(src, GROUP, sent(601), "late", NONE);
      server.state.bodies.set(601, EDITED);
      online();
      await chat.flushAll();
      expect(server.state.bodies.get(601)).toBe(EDITED);
      expect((await chat.notices())[0].edit).toMatchObject({ text: "late", deleted: true });
    });

    it("a re-read that finds another body refuses the edit", async () => {
      offline();
      await chat.editMessage(src, GROUP, sent(601), "late", NONE);
      server.state.bodies.set(601, `<p>browser${EDITED}</p>`);
      online();
      await chat.flushAll();
      expect(server.reads()).toHaveLength(1);
      expect(server.edits()).toEqual([]);
      expect(await bodyOf(601)).toBe(`<p>browser${EDITED}</p>`);
      expect(await chat.notices()).toEqual([expect.objectContaining({
        kind: "chat.edit", reason: "changed", edit: expect.objectContaining({ text: "late", deleted: false }),
      })]);
    });

    it("a re-read that finds no message refuses as deleted", async () => {
      offline();
      await chat.editMessage(src, GROUP, sent(601), "late", NONE);
      server.state.bodies.delete(601);
      online();
      await chat.flushAll();
      expect(server.edits()).toEqual([]);
      expect((await chat.notices())[0]).toMatchObject({ kind: "chat.edit", reason: "changed", edit: { text: "late", deleted: true } });
      expect(await bodyOf(601)).toBe("");
    });

    it("an edit replayed after a lost answer counts as done, both paths", async () => {
      for (const guarded of [false, true]) {
        if (guarded) await withModule();
        const text = guarded ? "replayed guarded" : "replayed";
        server.state.drop = 1;
        await chat.editMessage(src, GROUP, sent(601), text, NONE);
        expect(server.state.bodies.get(601)).toBe(`<p>${text}${EDITED}</p>`);
        expect((await ops("chat.edit")).map((o) => o.status)).toEqual(["failed"]);
        await chat.flushAll({ force: true });
        expect(await chat.notices()).toEqual([]);
        expect(await ops()).toEqual([]);
        expect(await bodyOf(601)).toBe(`<p>${text}${EDITED}</p>`);
      }
      // Without the module the replay only re-read; with it the guarded route answered the conflict
      expect(server.edits().map((c) => c.path)).toEqual([
        "/mail/message/update_content", MODULE_EDIT_ROUTE, MODULE_EDIT_ROUTE,
      ]);
    });

    it("a delete replayed after a lost answer counts as done", async () => {
      server.state.drop = 1;
      await chat.deleteMessage(src, GROUP, sent(601));
      await chat.flushAll({ force: true });
      expect(server.edits()).toHaveLength(2);
      expect(server.state.bodies.get(601)).toBe("");
      expect(await chat.notices()).toEqual([]);
      expect(await ops()).toEqual([]);
    });

    it("the module route answering 404 probes the module and the retry re-reads", async () => {
      await chat.repo.setSourceState({ configId: config, moduleState: "installed", moduleLevel: "1.4" });
      await chat.editMessage(src, GROUP, sent(601), "older module", NONE);
      // The probe found no module 1.3: the retry takes Odoo's route after a re-read
      expect((await chat.features(config)).guardedEdit).toBe(false);
      await chat.flushAll({ force: true });
      expect(server.edits().map((c) => c.path)).toEqual([MODULE_EDIT_ROUTE, "/mail/message/update_content"]);
      expect(server.state.bodies.get(601)).toBe(`<p>older module${EDITED}</p>`);
      expect(await chat.notices()).toEqual([]);
    });

    it("takeRefusedEdit gives the text back once", async () => {
      offline();
      await chat.editMessage(src, GROUP, sent(601), "late", NONE);
      server.state.bodies.set(601, `<p>browser${EDITED}</p>`);
      online();
      await chat.flushAll();
      const [notice] = await chat.notices();
      const edit = { target: { messageId: 601, clientUuid: null }, text: "late", mentions: NONE, deleted: false };
      // Through « Reprendre »: asked in the list, taken by the thread of its conversation only
      chat.requestResume(config, notice.id);
      expect(await chat.takeResume(config, CHAT)).toBeNull();
      expect(await chat.takeResume(config, GROUP)).toEqual(edit);
      expect(await chat.takeResume(config, GROUP)).toBeNull();
      expect(await chat.notices()).toEqual([]);
      expect(await chat.queue.takeRefusedEdit(config, notice.id)).toBeNull();
    });

    it("takeRefusedEdit returns the edit and dismisses its notice", async () => {
      offline();
      await chat.editMessage(src, GROUP, sent(601), "late", NONE);
      server.state.bodies.delete(601);
      online();
      await chat.flushAll();
      const [notice] = await chat.notices();
      expect(await chat.queue.takeRefusedEdit(config, notice.id)).toMatchObject({ text: "late", deleted: true });
      expect(await chat.queue.takeRefusedEdit(config, notice.id)).toBeNull();
      expect(await chat.notices()).toEqual([]);
    });

    it("an edit's picks stored before the edit in an empty draft are kept", async () => {
      await chat.saveDraftMentions(config, GROUP, BOB_PICK);
      await chat.saveDraftEdit(config, GROUP, { target: sent(601), text: "hello @Bob" });
      expect((await chat.draft(config, GROUP)).mentions).toEqual(BOB_PICK);
    });

    it("takeResume stores the refused text in the draft before its notice goes", async () => {
      const refuse = async (deleted: boolean) => {
        offline();
        await chat.editMessage(src, GROUP, sent(601), "late @Bob", BOB_PICK);
        if (deleted) server.state.bodies.delete(601);
        else server.state.bodies.set(601, `<p>browser${EDITED}</p>`);
        online();
        await chat.flushAll();
        const [notice] = await chat.notices();
        chat.requestResume(config, notice.id);
        return notice;
      };
      // A store that fails keeps the notice, its text with it
      const first = await refuse(false);
      vi.spyOn(chat.repo, "putDraftEdit").mockRejectedValueOnce(new Error("disk full"));
      await expect(chat.takeResume(config, GROUP)).rejects.toThrow("disk full");
      expect((await chat.notices()).map((n) => n.id)).toEqual([first.id]);
      chat.requestResume(config, first.id);
      // Changed: the draft's edit, whatever the screen does next
      await chat.takeResume(config, GROUP);
      expect(await chat.notices()).toEqual([]);
      expect(await chat.draft(config, GROUP)).toMatchObject({ edit: { target: sent(601), text: "late @Bob" }, mentions: BOB_PICK });
      await chat.saveDraftEdit(config, GROUP, null);
      // Deleted: joined into the new message's text
      await chat.saveDraftText(config, GROUP, "typed");
      await refuse(true);
      await chat.takeResume(config, GROUP);
      expect(await chat.draft(config, GROUP)).toMatchObject({ text: "typed\nlate @Bob", edit: null, mentions: BOB_PICK });
      expect(await chat.notices()).toEqual([]);
    });

    it("takeResume of a message deleted since its refusal joins the new message's text", async () => {
      offline();
      await chat.editMessage(src, GROUP, sent(601), "late", NONE);
      server.state.bodies.set(601, `<p>browser${EDITED}</p>`);
      online();
      await chat.flushAll();
      const [notice] = await chat.notices();
      expect(notice.edit).toMatchObject({ text: "late", deleted: false });
      // Deleted afterwards: the emptied row stays cached
      await chat.deleteMessage(src, GROUP, sent(601));
      expect(await bodyOf(601)).toBe(EDITED);
      chat.requestResume(config, notice.id);
      const asked: any[] = [];
      await chat.takeResume(config, GROUP, async (e) => { asked.push(e); return true; });
      expect(asked).toEqual([expect.objectContaining({ text: "late", deleted: true })]);
      expect(await chat.draft(config, GROUP)).toMatchObject({ text: "late", edit: null });
    });

    it("takeResume asks first; a refusal keeps the notice and forgets the request", async () => {
      offline();
      await chat.editMessage(src, GROUP, sent(601), "late", NONE);
      server.state.bodies.set(601, `<p>browser${EDITED}</p>`);
      online();
      await chat.flushAll();
      const [notice] = await chat.notices();
      chat.requestResume(config, notice.id);
      const asked: any[] = [];
      expect(await chat.takeResume(config, GROUP, async (e) => { asked.push(e); return false; })).toBeNull();
      expect(asked).toEqual([expect.objectContaining({ text: "late", deleted: false })]);
      expect((await chat.notices()).map((n) => n.id)).toEqual([notice.id]);
      expect((await chat.draft(config, GROUP)).edit).toBeNull();
      expect(await chat.takeResume(config, GROUP)).toBeNull();
    });

    it("a refused edit's notice survives a new edit of the same message", async () => {
      offline();
      await chat.editMessage(src, GROUP, sent(601), "late", NONE);
      server.state.bodies.set(601, `<p>browser${EDITED}</p>`);
      online();
      await chat.flushAll();
      const [refused] = await chat.notices();
      expect(refused.edit).toMatchObject({ text: "late" });
      await chat.editMessage(src, GROUP, sent(601), "made again", NONE);
      expect(server.state.bodies.get(601)).toBe(`<p>made again${EDITED}</p>`);
      // The refused text stays available, its « Reprendre » with it
      expect((await chat.notices()).map((n) => [n.id, n.edit?.text])).toEqual([[refused.id, "late"]]);
    });

    it("a second refused edit of a message is a notice of its own", async () => {
      offline();
      await chat.editMessage(src, GROUP, sent(601), "late", NONE);
      server.state.bodies.set(601, `<p>browser${EDITED}</p>`);
      online();
      await chat.flushAll();
      offline();
      await chat.editMessage(src, GROUP, sent(601), "second", NONE);
      server.state.bodies.set(601, `<p>browser again${EDITED}</p>`);
      online();
      await chat.flushAll();
      // Both refused texts stay available, the newest with its own « Reprendre »
      const texts = (await chat.notices()).map((n) => `${n.reason} ${n.edit?.text}`).sort();
      expect(texts).toEqual(["changed late", "changed second"]);
      expect((await ops("chat.edit")).map((o) => `${o.status} ${o.params.text}`).sort()).toEqual(["blocked late", "blocked second"]);
    });

    it("an edit after a lost edit answer is sent, both paths", async () => {
      for (const guarded of [false, true]) {
        if (guarded) await withModule();
        const [one, two] = guarded ? ["g1", "g2"] : ["one", "two"];
        server.state.drop = 1;
        await chat.editMessage(src, GROUP, sent(601), one, NONE);
        await chat.editMessage(src, GROUP, sent(601), two, NONE);
        // The first keeps its text, which may be on the server already: the second waits behind it
        const edits = await ops("chat.edit");
        const first = edits.find((o) => o.params.text === one)!;
        expect(edits.find((o) => o.id !== first.id)).toMatchObject({ dependsOn: first.id, params: { text: two } });
        await chat.flushAll({ force: true });
        expect(server.state.bodies.get(601)).toBe(`<p>${two}${EDITED}</p>`);
        expect(await chat.notices()).toEqual([]);
        expect(await ops()).toEqual([]);
        expect(await bodyOf(601)).toBe(`<p>${two}${EDITED}</p>`);
      }
    });

    it("an edit works without Array.prototype.findLastIndex", async () => {
      const original = Array.prototype.findLastIndex;
      // @ts-expect-error older WebViews lack it
      delete Array.prototype.findLastIndex;
      try {
        server.state.drop = 1;
        await chat.editMessage(src, GROUP, sent(601), "one", NONE);
        await chat.editMessage(src, GROUP, sent(601), "two", NONE);
        const edits = await ops("chat.edit");
        const first = edits.find((o) => o.params.text === "one")!;
        expect(edits.find((o) => o.id !== first.id)).toMatchObject({ dependsOn: first.id, params: { text: "two" } });
      } finally {
        Array.prototype.findLastIndex = original;
      }
    });

    it("an edit from the draft ends the draft's edit once queued, before the flush", async () => {
      await chat.saveDraftText(config, GROUP, "kept new text");
      await chat.saveDraftEdit(config, GROUP, { target: sent(601), text: "edited " });
      let atQueue: any = null;
      await chat.editMessage(src, GROUP, sent(601), "edited", NONE, {
        fromDraft: true,
        onQueued: () => { atQueue = server.edits().length; },
      });
      expect(atQueue).toBe(0);
      expect(server.state.bodies.get(601)).toBe(`<p>edited${EDITED}</p>`);
      expect(await chat.draft(config, GROUP)).toMatchObject({ text: "kept new text", edit: null });
      // An edit of another message leaves the draft's
      await chat.saveDraftEdit(config, GROUP, { target: sent(602), text: "bye!" });
      await chat.editMessage(src, GROUP, sent(601), "again", NONE, { fromDraft: true });
      expect((await chat.draft(config, GROUP)).edit).toEqual({ target: sent(602), text: "bye!" });
    });

    it("a reply sent from the draft takes its reply target and picks with its text", async () => {
      offline();
      await chat.saveDraftText(config, GROUP, "the answer ");
      await chat.saveDraftReply(config, GROUP, sent(601));
      await chat.saveDraftMentions(config, GROUP, BOB_PICK);
      // Kept across leaving and reopening the conversation
      expect(await chat.draft(config, GROUP)).toMatchObject({ text: "the answer ", replyTo: sent(601), mentions: BOB_PICK });
      await chat.send(src, GROUP, "the answer", [], { draftText: "the answer ", replyTo: sent(601), mentions: BOB_PICK });
      expect(await chat.draft(config, GROUP)).toEqual({
        text: "", files: [], lost: [], replyTo: null, edit: null, mentions: NONE,
      });
    });

    it("an answered edit rebases the next one", async () => {
      let release!: () => void;
      server.state.hold = new Promise<void>((r) => { release = r; });
      const first = chat.editMessage(src, GROUP, sent(601), "one", NONE);
      await vi.waitFor(() => expect(server.edits()).toHaveLength(1));
      await chat.editMessage(src, GROUP, sent(601), "two", NONE);
      const follow = (await ops("chat.edit")).find((o) => o.status !== "running")!;
      expect(follow.params).toMatchObject({ text: "two", baseBody: HELLO });
      server.state.hold = null;
      release();
      await first;
      expect((await env.db.getOutboxOp(follow.id))!.params.baseBody).toBe(`<p>one${EDITED}</p>`);
      await chat.flushAll();
      expect(server.edits().map((c) => c.params.body)).toEqual(["one", "two"]);
      expect(server.state.bodies.get(601)).toBe(`<p>two${EDITED}</p>`);
      expect(await chat.notices()).toEqual([]);
    });

    it("delete NotFound counts as done", async () => {
      server.state.missing.add(601);
      await chat.deleteMessage(src, GROUP, sent(601));
      expect(server.edits()).toHaveLength(1);
      expect(await chat.notices()).toEqual([]);
      expect(await ops()).toEqual([]);
    });

    it("edit NotFound is vanished", async () => {
      server.state.missing.add(601);
      await chat.editMessage(src, GROUP, sent(601), "nobody home", NONE);
      expect(server.edits()).toHaveLength(1);
      expect(await chat.notices()).toEqual([expect.objectContaining({
        kind: "chat.edit", reason: "vanished", message: { messageId: 601, clientUuid: null },
      })]);
      expect((await chat.notices())[0].edit).toBeUndefined();
      // Gone for the server: hidden, as a re-read that finds no message leaves it
      expect(await bodyOf(601)).toBe("");
    });

    it("a refused delete shows the message again", async () => {
      odoo.state.onRoute = async () => ({ __error: "odoo.exceptions.AccessError" });
      await chat.deleteMessage(src, GROUP, sent(602));
      expect((await chat.notices()).map((n) => [n.kind, n.reason])).toEqual([["chat.delete", "refused"]]);
      expect(await bodyOf(602)).toBe("<p>bye</p>");
    });

    it("a refused delete shows the message without the reactions it cancelled", async () => {
      offline();
      await chat.react(src, GROUP, sent(602), "\u{1F44D}", true);
      expect((await chat.reactions(config, GROUP, ["m602"])).get("m602")).toHaveLength(1);
      await chat.deleteMessage(src, GROUP, sent(602));
      odoo.state.onRoute = async () => ({ __error: "odoo.exceptions.AccessError" });
      online();
      await chat.flushAll();
      expect((await chat.notices()).map((n) => [n.kind, n.reason])).toEqual([["chat.delete", "refused"]]);
      expect(await bodyOf(602)).toBe("<p>bye</p>");
      expect((await chat.reactions(config, GROUP, ["m602"])).get("m602") ?? []).toEqual([]);
    });

    it("a refused delete over an edit whose answer was lost shows the server's body", async () => {
      server.state.drop = 1;
      await chat.editMessage(src, GROUP, sent(601), "applied", NONE);
      expect(server.state.bodies.get(601)).toBe(`<p>applied${EDITED}</p>`);
      odoo.state.onRoute = async () => ({ __error: "odoo.exceptions.AccessError" });
      await chat.deleteMessage(src, GROUP, sent(601));
      await chat.flushAll({ force: true });
      expect((await chat.notices()).map((n) => [n.kind, n.reason])).toEqual([["chat.delete", "refused"]]);
      expect(await bodyOf(601)).toBe(`<p>applied${EDITED}</p>`);
    });

    it("a refused delete does not restore the base of a reaction whose op had sentAt", async () => {
      offline();
      await chat.react(src, GROUP, sent(602), "\u{1F44D}", true);
      // The send may have reached the server: its answer was lost
      const [reaction] = await ops("chat.reaction");
      await env.db.updateOutboxOp(reaction.id, { params: { ...reaction.params, sentAt: clock.toISOString() } });
      odoo.state.onRoute = async () => ({ __error: "odoo.exceptions.AccessError" });
      await chat.deleteMessage(src, GROUP, sent(602));
      online();
      await chat.flushAll({ force: true });
      expect((await chat.notices()).map((n) => [n.kind, n.reason])).toEqual([["chat.delete", "refused"]]);
      // The reaction may be on the server: it stays shown as the user left it
      expect((await chat.reactions(config, GROUP, ["m602"])).get("m602")).toHaveLength(1);
    });

    it("a load keeps the optimistic edit and the hidden delete", async () => {
      offline();
      await chat.editMessage(src, GROUP, sent(601), "new text", NONE);
      await chat.deleteMessage(src, GROUP, sent(602));
      await chat.load(src);
      expect(await bodyOf(601)).toBe(`new text${EDITED}`);
      expect(await bodyOf(602)).toBe("");
      // A bus record of the server's body keeps them too
      await chat.applyBus(config, [bus(1001, "mail.record/insert", { "mail.message": [
        { id: 601, body: HELLO, thread: { id: GROUP, model: "discuss.channel" } },
        { id: 602, body: "<p>bye</p>", thread: { id: GROUP, model: "discuss.channel" } },
      ] })]);
      expect(await bodyOf(601)).toBe(`new text${EDITED}`);
      expect(await bodyOf(602)).toBe("");
      // The base stays the body first read: a load never moves it
      expect((await ops("chat.edit"))[0].params.baseBody).toBe(HELLO);
    });

    it("editDraftOf gives the post's text, or the sent body's text with its mentions", async () => {
      const body = await browserHtml("hi @Bob", BOB_PICK);
      server.state.bodies.set(601, body);
      await chat.applyBus(config, [bus(1001, "mail.record/insert", { "mail.message": [{
        id: 601, body: `<p>${body}${EDITED}</p>`, thread: { id: GROUP, model: "discuss.channel" },
        recipients: [{ id: BOB, type: "partner" }],
      }] })]);
      expect(await chat.editDraftOf(config, GROUP, sent(601))).toEqual({ text: "hi @Bob", mentions: BOB_PICK });
      offline();
      const pending = await chat.send(src, GROUP, "draft @Bob");
      await chat.editMessage(src, GROUP, { messageId: null, clientUuid: pending.clientUuid }, "draft @Bob!", BOB_PICK);
      expect(await chat.editDraftOf(config, GROUP, { messageId: null, clientUuid: pending.clientUuid }))
        .toEqual({ text: "draft @Bob!", mentions: BOB_PICK });
      expect(await chat.editDraftOf(config, GROUP, sent(999))).toBeNull();
    });
  });

  describe("posts with files", () => {
    let odoo: ReturnType<typeof fakeOdoo>;
    let server: ReturnType<typeof fileServer>;
    let src: ChatSource;
    let fileDir: string;
    const advance = (ms: number) => { clock = new Date(clock.getTime() + ms); };
    const odooDate = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");
    /** A file staged in the account's out directory, as the composer leaves it. */
    const stage = (name: string, size = 3, mimetype = "image/jpeg", voice = false): OutgoingFile => {
      const localUuid = uuidv4();
      const path = outgoingPath(fileDir, localUuid, name);
      server.files.put(path, new Uint8Array(size).fill(7));
      return { localUuid, path, name, mimetype, size, voice };
    };
    const idle = () => chat.queue.whenIdle(config);
    const posts = () => odoo.on("/mail/message/post");
    const ops = async (kind?: string) => (await env.db.getOutboxOpsForConfig(config)).filter((o) => !kind || o.kind === kind);
    const fields = (thread: number) => ({ thread_id: String(thread), thread_model: "discuss.channel", is_pending: "true", csrf_token: "tok1" });
    const reborn = async () => {
      chat.dispose();
      const rpc = new OdooRpcClient();
      const outbox = new OutboxService(env.db, () => clock);
      chat = new ChatService(env.db, rpc, outbox, new CapabilityService(env.db, rpc), () => clock);
      chat.useFileIO({ files: server.files, http: server.http });
      return outbox;
    };

    beforeEach(async () => {
      odoo = fakeOdoo();
      server = fileServer(odoo, () => clock);
      chat.useFileIO({ files: server.files, http: server.http });
      src = await source();
      await chat.load(src);
      fileDir = await chat.fileDirOf(config);
    });

    it("a post with two files uploads them in order then posts their ids", async () => {
      const a = stage("a.jpg");
      const b = stage("b.pdf", 5, "application/pdf");
      const sent = await chat.send(src, GROUP, "two", [a, b]);
      await idle();
      expect(server.uploads().map((c) => [new URL(c.url).pathname, c.file!.name, c.file!.mimetype, c.fields])).toEqual([
        ["/mail/attachment/upload", "a.jpg", "image/jpeg", fields(GROUP)],
        ["/mail/attachment/upload", "b.pdf", "application/pdf", fields(GROUP)],
      ]);
      expect(posts()).toHaveLength(1);
      expect(posts()[0].params.post_data.attachment_ids).toEqual([900, 901]);
      expect(posts()[0].params.attachment_tokens).toEqual([false, false]);
      expect((await chat.messages(config, GROUP)).find((m) => m.clientUuid === sent.clientUuid)).toMatchObject({ status: "sent", messageId: 5000 });
      expect(await ops()).toEqual([]);
    });

    it("a text-only post carries no attachment fields", async () => {
      await chat.send(src, GROUP, "plain");
      expect(posts()[0].params.post_data).not.toHaveProperty("attachment_ids");
      expect(posts()[0].params).not.toHaveProperty("attachment_tokens");
    });

    it("voice sends voice=true", async () => {
      await chat.send(src, GROUP, "", [stage("Voice-2026-10-26-123.mp3", 4, "audio/mpeg", true)]);
      await idle();
      expect(server.uploads()[0].fields).toEqual({ ...fields(GROUP), voice: "true" });
      expect(posts()[0].params.post_data.attachment_ids).toEqual([900]);
    });

    it("the module route sends client_uuid", async () => {
      await chat.repo.setSourceState({ configId: config, moduleState: "installed", moduleLevel: "1.2" });
      await chat.send(src, GROUP, "", [stage("a.jpg")]);
      await idle();
      const [up] = server.uploads();
      expect(new URL(up.url).pathname).toBe(MODULE_UPLOAD_ROUTE);
      expect(up.fields).toEqual({ ...fields(GROUP), client_uuid: expect.any(String) });
      expect(odoo.state.attachments[0].uuid).toBe(up.fields!.client_uuid);
    });

    it("lost upload answer with the module adopts the first attachment", async () => {
      await chat.repo.setSourceState({ configId: config, moduleState: "installed", moduleLevel: "1.2" });
      server.state.drop = 1;
      await chat.send(src, GROUP, "once", [stage("a.jpg")]);
      await idle();
      expect(posts()).toHaveLength(0);
      const [up] = await ops("chat.upload");
      expect(up).toMatchObject({ status: "failed", attempts: 1 });
      await chat.flushAll({ force: true });
      await idle();
      const sent = server.uploads();
      expect(sent).toHaveLength(2);
      expect(sent[1].fields!.client_uuid).toBe(sent[0].fields!.client_uuid);
      expect(odoo.state.attachments).toHaveLength(1);
      expect(posts().map((p) => p.params.post_data.attachment_ids)).toEqual([[900]]);
      expect(await ops()).toEqual([]);
    });

    it("lost upload answer without the module reuses its pending upload", async () => {
      const sentAt = clock;
      server.state.drop = 1;
      await chat.send(src, GROUP, "once", [stage("a.pdf", 3, "application/pdf")]);
      await idle();
      const [up] = await ops("chat.upload");
      expect(up.params).toMatchObject({ uploadSentAt: sentAt.toISOString(), uploadEndedAt: sentAt.toISOString() });
      // Inside the quiet window: neither a search nor a second upload
      await chat.flushAll({ force: true });
      await idle();
      expect(server.uploads()).toHaveLength(1);
      expect(odoo.kw("search_read").filter((c) => c.params.model === "ir.attachment")).toHaveLength(0);
      advance(3 * 60_000 + 1);
      await chat.flushAll({ force: true });
      await idle();
      const [search] = odoo.kw("search_read").filter((c) => c.params.model === "ir.attachment");
      expect(search.params.kwargs).toMatchObject({
        domain: [
          ["res_model", "=", "mail.compose.message"],
          ["res_id", "=", 0],
          ["create_uid", "=", 2],
          ["name", "=", "a.pdf"],
          ["file_size", "=", 3],
          ["create_date", ">=", odooDate(new Date(sentAt.getTime() - CREATE_CLOCK_SKEW_MS))],
          ["create_date", "<=", odooDate(new Date(sentAt.getTime() + CREATE_CLOCK_SKEW_MS))],
        ],
        order: "id asc",
        limit: 1,
      });
      expect(server.uploads()).toHaveLength(1);
      expect(odoo.state.attachments).toHaveLength(1);
      expect(posts().map((p) => p.params.post_data.attachment_ids)).toEqual([[900]]);
      expect(await ops()).toEqual([]);
    });

    it("lost upload answer without the module finds the photo Odoo's route resized", async () => {
      const sentAt = clock;
      server.state.resize = true;
      server.state.drop = 1;
      await chat.send(src, GROUP, "once", [stage("big.jpg", 8)]);
      await idle();
      advance(3 * 60_000 + 1);
      await chat.flushAll({ force: true });
      await idle();
      const [search] = odoo.kw("search_read").filter((c) => c.params.model === "ir.attachment");
      expect(search.params.kwargs.domain).toEqual([
        ["res_model", "=", "mail.compose.message"],
        ["res_id", "=", 0],
        ["create_uid", "=", 2],
        ["name", "=", "big.jpg"],
        ["create_date", ">=", odooDate(new Date(sentAt.getTime() - CREATE_CLOCK_SKEW_MS))],
        ["create_date", "<=", odooDate(new Date(sentAt.getTime() + CREATE_CLOCK_SKEW_MS))],
      ]);
      expect(server.uploads()).toHaveLength(1);
      expect(odoo.state.attachments).toHaveLength(1);
      expect(posts().map((p) => p.params.post_data.attachment_ids)).toEqual([[900]]);
      expect(await chat.repo.attachment(config, 900)).toMatchObject({ attachmentId: 900, size: 4 });
      expect(await ops()).toEqual([]);
    });

    it("three files survive a kill during the second upload", async () => {
      offline();
      const files = [stage("1.jpg"), stage("2.jpg", 4), stage("3.jpg", 5)];
      await chat.send(src, GROUP, "three", files);
      expect(server.uploads()).toHaveLength(0);
      online();
      // The second upload reaches the server, then the app dies before its answer
      server.state.hold = { nth: 2, when: "after" };
      await chat.flushAll();
      await vi.waitFor(() => expect(server.uploads()).toHaveLength(2));
      await vi.waitFor(async () => expect((await ops("chat.upload")).find((o) => o.params.name === "2.jpg")?.status).toBe("running"));
      const outbox = await reborn();
      expect(await outbox.recoverInterrupted()).toBe(1);
      await chat.recover();
      await chat.flushAll();
      await idle();
      expect(server.uploads()).toHaveLength(2);
      advance(3 * 60_000 + 1);
      await chat.flushAll();
      await idle();
      expect(server.uploads().map((c) => c.file!.name)).toEqual(["1.jpg", "2.jpg", "3.jpg"]);
      expect(odoo.state.attachments.map((a) => a.name)).toEqual(["1.jpg", "2.jpg", "3.jpg"]);
      expect(posts().map((p) => p.params.post_data.attachment_ids)).toEqual([[900, 901, 902]]);
      expect(await ops()).toEqual([]);
    });

    it("413 refuses the file once and the text still goes", async () => {
      const big = stage("big.jpg", 9);
      server.state.status = 413;
      await chat.send(src, GROUP, "text", [big, stage("ok.jpg")]);
      await idle();
      const sent = posts();
      expect(sent).toHaveLength(1);
      expect(sent[0].params.post_data.attachment_ids).toEqual([900]);
      const [row] = (await chat.repo.outgoingOf(config, (await chat.messages(config, GROUP)).at(-1)!.clientUuid));
      expect(row).toMatchObject({ localUuid: big.localUuid, state: "refused", error: "too_big" });
      expect(await chat.notices([config])).toEqual([expect.objectContaining({
        kind: "chat.file_refused", channelId: GROUP, file: { name: "big.jpg", reason: "too_big", limit: null },
      })]);
      await chat.flushAll({ force: true });
      advance(3 * 60_000 + 1);
      await chat.flushAll({ force: true });
      await idle();
      expect(server.uploads()).toHaveLength(2);
      expect(posts()).toHaveLength(1);
    });

    it("a file over the session limit is refused without a request", async () => {
      odoo.state.maxUpload = 65536 + 10;
      await chat.load(src);
      await chat.send(src, GROUP, "text", [stage("big.jpg", 11)]);
      await idle();
      expect(server.http.calls).toEqual([]);
      expect(posts()).toHaveLength(1);
      expect(posts()[0].params.post_data).not.toHaveProperty("attachment_ids");
      expect((await chat.notices([config]))[0]).toMatchObject({ file: { name: "big.jpg", reason: "too_big", limit: 65546 } });
    });

    it("uploadLimit is the session's limit, null while the session cannot be read", async () => {
      odoo.state.maxUpload = 2 * 1024 * 1024;
      await chat.load(src);
      expect(await chat.uploadLimit(src)).toBe(2 * 1024 * 1024);
      const rpc = new OdooRpcClient();
      const offline = new ChatService(env.db, rpc, new OutboxService(env.db, () => clock), new CapabilityService(env.db, rpc), () => clock);
      vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
      expect(await offline.uploadLimit(src)).toBeNull();
      offline.dispose();
    });

    it("a missing file is refused with a notice", async () => {
      const gone = stage("gone.jpg");
      await server.files.remove(gone.path);
      await chat.send(src, GROUP, "text", [gone]);
      await idle();
      expect(server.uploads()).toHaveLength(0);
      expect(posts()).toHaveLength(1);
      const [notice] = await chat.notices([config]);
      expect(notice).toMatchObject({ kind: "chat.file_refused", file: { name: "gone.jpg", reason: "missing", limit: null } });
      // Dismissed, the notice takes the refused row with it
      await chat.dismissNotice(config, notice.id);
      expect(await chat.notices([config])).toEqual([]);
      expect(await env.db.rawQuery("SELECT id FROM chat_attachments WHERE config_id = ? AND id LIKE ?", [config, "%#l%"])).toEqual([]);
    });

    it("a text-less post whose only file is refused fails, nothing posted", async () => {
      const gone = stage("gone.jpg");
      await server.files.remove(gone.path);
      const sent = await chat.send(src, GROUP, "", [gone]);
      await idle();
      expect(posts()).toHaveLength(0);
      expect((await chat.messages(config, GROUP)).find((m) => m.clientUuid === sent.clientUuid)).toMatchObject({ status: "failed", outboxOpId: null });
      expect(await ops("chat.post")).toEqual([]);
    });

    it("wifi only holds the upload without attempt or delay; Wi-Fi sends it", async () => {
      setAttachmentSettings({ wifiOnly: true, maxMb: null });
      (network as any).__setNetworkStatus({ connected: true, connectionType: "cellular" });
      await chat.send(src, GROUP, "later", [stage("a.jpg")]);
      await idle();
      await chat.flushAll({ force: true });
      await idle();
      expect(server.http.calls).toEqual([]);
      expect(posts()).toHaveLength(0);
      const [up] = await ops("chat.upload");
      expect(up).toMatchObject({ status: "queued", attempts: 0, nextAttemptAt: null, lastError: null });
      expect(up.params.heldFor).toBe("wifi");
      online();
      await chat.flushAll();
      await idle();
      expect(server.uploads()).toHaveLength(1);
      expect(posts()).toHaveLength(1);
      expect(await ops()).toEqual([]);
    });

    it("a long upload does not hold another conversation's post", async () => {
      server.state.hold = { nth: 1, when: "before" };
      await chat.send(src, GROUP, "with file", [stage("a.jpg")]);
      await vi.waitFor(() => expect(server.uploads()).toHaveLength(1));
      expect(await chat.queue.pendingUploadCount(config)).toBe(1);
      await chat.send(src, GENERAL, "other");
      expect(posts().map((p) => p.params.thread_id)).toEqual([GENERAL]);
      await chat.send(src, GROUP, "after");
      expect(posts().map((p) => p.params.thread_id)).toEqual([GENERAL]);
      server.release();
      await idle();
      expect(posts().map((p) => [p.params.thread_id, p.params.post_data.attachment_ids ?? null])).toEqual([
        [GENERAL, null], [GROUP, [900]], [GROUP, null],
      ]);
      expect(await chat.queue.pendingUploadCount(config)).toBe(0);
    });

    it("upload progress follows the transfer of the file", async () => {
      server.state.hold = { nth: 1, when: "before" };
      const a = stage("a.jpg", 10);
      await chat.send(src, GROUP, "", [a]);
      await vi.waitFor(() => expect(server.uploads()).toHaveLength(1));
      expect(chat.queue.uploadProgress(a.localUuid)).toEqual({ done: 0, total: 10 });
      server.http.emit({ id: server.uploads()[0].id!, done: 4, total: null });
      expect(chat.queue.uploadProgress(a.localUuid)).toEqual({ done: 4, total: 10 });
      server.release();
      await idle();
      expect(chat.queue.uploadProgress(a.localUuid)).toBeNull();
    });

    it("a post refused for a vanished attachment re-uploads it once", async () => {
      let vanish = true;
      odoo.state.onPost = async () => {
        // The pending attachment is collected on the server before the post
        if (vanish) odoo.state.attachments.splice(0, 1);
        vanish = false;
      };
      const sent = await chat.send(src, GROUP, "again", [stage("a.jpg")]);
      await idle();
      expect(server.uploads()).toHaveLength(2);
      expect(posts().map((p) => p.params.post_data.attachment_ids)).toEqual([[900], [901]]);
      expect((await chat.messages(config, GROUP)).find((m) => m.clientUuid === sent.clientUuid)).toMatchObject({ status: "sent" });
      expect(await ops()).toEqual([]);
    });

    it("a post refused again after its re-upload is blocked", async () => {
      odoo.state.onPost = async () => { odoo.state.attachments.length = 0; };
      const sent = await chat.send(src, GROUP, "again", [stage("a.jpg")]);
      await idle();
      expect(server.uploads()).toHaveLength(2);
      expect(posts()).toHaveLength(2);
      const [post] = await ops("chat.post");
      expect(post).toMatchObject({ status: "blocked" });
      expect((await chat.messages(config, GROUP)).find((m) => m.clientUuid === sent.clientUuid)).toMatchObject({ status: "failed" });
    });

    it("a settled post's files become the conversation's cache, no download", async () => {
      const a = stage("a.jpg");
      await chat.send(src, GROUP, "kept", [a]);
      await idle();
      const rows = (await chat.repo.attachmentsOf(config, GROUP, [5000], [])).get("m5000")!;
      const kept = originalPath(fileDir, 900, "a.jpg");
      expect(rows).toEqual([expect.objectContaining({
        attachmentId: 900, messageId: 5000, state: "posted", originalPath: kept, originalBytes: 3,
      })]);
      expect(server.files.bytes(kept)).toEqual(new Uint8Array(3).fill(7));
      expect(server.files.bytes(a.path)).toBeUndefined();
      expect(server.http.calls.filter((c) => c.kind === "download")).toEqual([]);
    });

    it("leaving cancels the conversation's uploads", async () => {
      server.state.hold = { nth: 1, when: "before" };
      const [a, b] = [stage("a.jpg"), stage("b.jpg")];
      const sent = await chat.send(src, GROUP, "never", [a, b]);
      await vi.waitFor(() => expect(server.uploads()).toHaveLength(1));
      await chat.leave(src, GROUP);
      await idle();
      expect(server.http.calls.filter((c) => c.kind === "cancel").map((c) => c.id)).toEqual([server.uploads()[0].id]);
      expect(server.uploads()).toHaveLength(1);
      expect(posts()).toHaveLength(0);
      expect((await chat.repo.outgoingOf(config, sent.clientUuid)).map((r) => [r.localUuid, r.state, r.error])).toEqual([
        [a.localUuid, "refused", "left"], [b.localUuid, "refused", "left"],
      ]);
      expect((await chat.messages(config, GROUP)).find((m) => m.clientUuid === sent.clientUuid)).toMatchObject({ status: "failed" });
      expect(odoo.kw("action_unfollow")).toHaveLength(1);
      expect(await chat.notices([config])).toEqual([]);
      expect(await ops()).toEqual([]);
    });

    it("two renames that pause one id overlap: the lane stays paused until both resumed", async () => {
      offline();
      await chat.send(src, GROUP, "later", [stage("a.jpg")]);
      online();
      const first = syncConfigIdFor("https://ODOO.example.com", TARGET.username, TARGET.database);
      const second = syncConfigIdFor("https://Odoo.Example.com", TARGET.username, TARGET.database);
      await chat.pauseUploads(config, first);
      await chat.pauseUploads(config, second);
      await chat.resumeUploads(config, first);
      await chat.flushAll({ force: true });
      await idle();
      expect(server.uploads()).toHaveLength(0);
      await chat.resumeUploads(config, second);
      await chat.flushAll({ force: true });
      await idle();
      expect(server.uploads()).toHaveLength(1);
      expect(posts().map((p) => p.params.post_data.attachment_ids)).toEqual([[900]]);
    });

    it("pauseUploads stops the account's running upload and resolves once it settled, its send kept in doubt", async () => {
      server.state.hold = { nth: 1, when: "after" };
      await chat.send(src, GROUP, "later", [stage("a.jpg")]);
      await vi.waitFor(() => expect(server.uploads()).toHaveLength(1));
      const renamed = syncConfigIdFor("https://ODOO.example.com", TARGET.username, TARGET.database);
      await chat.pauseUploads(config, renamed);
      expect(server.http.calls.filter((c) => c.kind === "cancel").map((c) => c.id)).toEqual([server.uploads()[0].id]);
      const [up] = await ops("chat.upload");
      expect(up).toMatchObject({ status: "failed", attempts: 1 });
      expect(up.params.uploadSentAt).toBeTruthy();
      expect(up.params.uploadEndedAt).toBeTruthy();
      // Paused, the lane starts nothing; resumed, the retry looks for the attachment the stopped send made
      advance(3 * 60_000 + 1);
      await chat.flushAll({ force: true });
      await idle();
      expect(odoo.kw("search_read").filter((c) => c.params.model === "ir.attachment")).toHaveLength(0);
      await chat.resumeUploads(config, renamed);
      await chat.flushAll({ force: true });
      await idle();
      expect(server.uploads()).toHaveLength(1);
      expect(odoo.state.attachments).toHaveLength(1);
      expect(posts().map((p) => p.params.post_data.attachment_ids)).toEqual([[900]]);
    });

    it("a module route gone falls back on Odoo's route, one post with the file", async () => {
      await chat.repo.setSourceState({ configId: config, moduleState: "installed", moduleLevel: "1.2" });
      server.state.notFound = "module";
      const sent = await chat.send(src, GROUP, "with file", [stage("a.jpg")]);
      await idle();
      expect(server.uploads().map((c) => [new URL(c.url).pathname, c.fields!.client_uuid ?? null])).toEqual([
        [MODULE_UPLOAD_ROUTE, expect.any(String)], [MODULE_UPLOAD_ROUTE, expect.any(String)], ["/mail/attachment/upload", null],
      ]);
      expect(posts().map((p) => p.params.post_data.attachment_ids)).toEqual([[900]]);
      expect((await chat.messages(config, GROUP)).find((m) => m.clientUuid === sent.clientUuid)).toMatchObject({ status: "sent" });
      expect(await chat.notices([config])).toEqual([]);
      expect((await chat.repo.sourceState(config)).moduleLevel).toBeNull();
    });

    it("a module route not found while the module is still there refuses the file", async () => {
      await chat.repo.setSourceState({ configId: config, moduleState: "installed", moduleLevel: "1.2" });
      odoo.state.onKw = async ({ model, method }) =>
        (method === "fields_get" && model === "ir.attachment" ? { erplibre_client_uuid: { type: "char" } } : undefined);
      server.state.notFound = "module";
      await chat.send(src, GROUP, "text", [stage("a.jpg")]);
      await idle();
      expect(server.uploads()).toHaveLength(2);
      expect((await chat.notices([config]))[0]).toMatchObject({ file: { name: "a.jpg", reason: "not_found" } });
      expect(posts()).toHaveLength(1);
    });

    it("a module probe that fails after the 404s keeps the file for a retry", async () => {
      await chat.repo.setSourceState({ configId: config, moduleState: "installed", moduleLevel: "1.2" });
      server.state.notFound = "module";
      const probe = vi.spyOn(chat.queue, "moduleRefused").mockRejectedValueOnce(new Error("network down"));
      const sent = await chat.send(src, GROUP, "with file", [stage("a.jpg")]);
      await idle();
      expect(await chat.notices([config])).toEqual([]);
      expect((await chat.repo.outgoingOf(config, sent.clientUuid))[0]).toMatchObject({ state: "queued" });
      expect(await ops("chat.upload")).toEqual([expect.objectContaining({ status: "failed" })]);
      probe.mockRestore();
      await chat.flushAll({ force: true });
      await idle();
      expect(new URL(server.uploads().at(-1)!.url).pathname).toBe("/mail/attachment/upload");
      expect(posts().map((p) => p.params.post_data.attachment_ids)).toEqual([[900]]);
    });

    it("an upload of the same file held by its conversation waits for the twin in doubt", async () => {
      offline();
      // B first in the outbox, behind a text of its conversation that fails once
      await chat.send(src, GROUP, "p0");
      await chat.send(src, GROUP, "b", [stage("same.jpg")]);
      advance(1);
      await chat.send(src, GENERAL, "a", [stage("same.jpg")]);
      let fail = true;
      odoo.state.onPost = async (params) => {
        if (fail && params.post_data.body.startsWith("p0")) {
          fail = false;
          return { __error: "builtins.RuntimeError" };
        }
      };
      online();
      server.state.drop = 2;
      await chat.flushAll();
      await idle();
      for (let i = 0; i < 4; i++) {
        advance(3 * 60_000 + 1);
        await chat.flushAll();
        await idle();
      }
      expect(await ops()).toEqual([]);
      expect(server.uploads()).toHaveLength(2);
      const linked = posts().filter((p) => p.params.post_data.attachment_ids).map((p) => [p.params.thread_id, p.params.post_data.attachment_ids]);
      // Each conversation gets the attachment its own send made: A sent first (900)
      expect(linked.sort()).toEqual([[GENERAL, [900]], [GROUP, [901]]].sort());
    });

    /** Makes the first delete of op `id` fail, as an app killed after the op's work and before its row went. */
    const killBeforeDelete = (id: () => string | undefined) => {
      const remove = env.db.deleteOutboxOp.bind(env.db);
      let killed = false;
      return vi.spyOn(env.db, "deleteOutboxOp").mockImplementation(async (opId: string) => {
        if (!killed && opId === id()) { killed = true; throw new Error("killed"); }
        return remove(opId);
      });
    };

    it("an upload run again after its row was uploaded sends nothing more", async () => {
      offline();
      await chat.send(src, GROUP, "once", [stage("a.jpg")]);
      const [up] = await ops("chat.upload");
      online();
      killBeforeDelete(() => up.id);
      await chat.flushAll();
      await idle();
      const outbox = await reborn();
      await outbox.recoverInterrupted();
      advance(3 * 60_000 + 1);
      await chat.flushAll();
      await idle();
      expect(server.uploads()).toHaveLength(1);
      expect(posts().map((p) => p.params.post_data.attachment_ids)).toEqual([[900]]);
      expect(await ops()).toEqual([]);
    });

    it("an upload run again after its file was refused sends nothing and adds no notice", async () => {
      offline();
      await chat.send(src, GROUP, "text", [stage("big.jpg")]);
      const [up] = await ops("chat.upload");
      online();
      server.state.status = 413;
      killBeforeDelete(() => up.id);
      await chat.flushAll();
      await idle();
      const outbox = await reborn();
      await outbox.recoverInterrupted();
      await chat.flushAll();
      await idle();
      expect(server.uploads()).toHaveLength(1);
      expect(await chat.notices([config])).toHaveLength(1);
      expect(posts()).toHaveLength(1);
    });

    it("two lost uploads of the same file to two conversations keep their own attachment", async () => {
      server.state.drop = 2;
      await chat.send(src, GROUP, "one", [stage("same.jpg")]);
      await chat.send(src, GENERAL, "two", [stage("same.jpg")]);
      await idle();
      // The second waits while the first holds a send that may have reached the server
      expect(odoo.state.attachments).toHaveLength(1);
      for (let i = 0; i < 2; i++) {
        advance(3 * 60_000 + 1);
        await chat.flushAll({ force: true });
        await idle();
      }
      expect(server.uploads()).toHaveLength(2);
      expect(odoo.state.attachments).toHaveLength(2);
      expect(posts().map((p) => [p.params.thread_id, p.params.post_data.attachment_ids])).toEqual([[GROUP, [900]], [GENERAL, [901]]]);
    });

    it("two same-named photos of different sizes in two conversations, both answers lost, each post keeps its own attachment", async () => {
      // Odoo's route resizes them: the search after a lost answer leaves the size out
      server.state.resize = true;
      server.state.drop = 2;
      await chat.send(src, GROUP, "one", [stage("x.jpg", 8)]);
      await chat.send(src, GENERAL, "two", [stage("x.jpg", 6)]);
      await idle();
      for (let i = 0; i < 2; i++) {
        advance(3 * 60_000 + 1);
        await chat.flushAll({ force: true });
        await idle();
      }
      expect(await ops()).toEqual([]);
      expect(server.uploads()).toHaveLength(2);
      expect(odoo.state.attachments.map((a) => [a.id, a.file_size])).toEqual([[900, 4], [901, 3]]);
      expect(posts().map((p) => [p.params.thread_id, p.params.post_data.attachment_ids])).toEqual([[GROUP, [900]], [GENERAL, [901]]]);
    });

    it("a rename waits for no upload and no upload writes under the old id", async () => {
      const apps = new AppService(env.db);
      apps.beforeRename = (from, to) => chat.pauseUploads(from, to);
      apps.afterRename = (from, to) => chat.resumeUploads(from, to);
      // A file of another conversation, failed once and due again while the rename runs
      server.state.status = 503;
      await chat.send(src, CHAT, "c", [stage("c.pdf", 3, "application/pdf")]);
      await idle();
      expect(await ops("chat.upload")).toEqual([expect.objectContaining({ status: "failed" })]);
      // A photo on the wire, its attachment made, when the edit starts
      server.state.hold = { nth: 2, when: "after" };
      await chat.send(src, GROUP, "a", [stage("a.jpg")]);
      await vi.waitFor(() => expect(server.uploads()).toHaveLength(2));
      advance(3 * 60_000 + 1);
      // An upload that starts now stays on the wire until released
      server.state.hold = { nth: 3, when: "before" };
      const renamed = syncConfigIdFor("https://ODOO.example.com", TARGET.username, TARGET.database);
      let startedInside = -1;
      const move = (env.db as any).renameChatRows.bind(env.db);
      vi.spyOn(env.db as any, "renameChatRows").mockImplementation(async (from: any, to: any) => {
        // The outbox rows moved, the chat rows not yet: a flush meanwhile starts no upload
        await chat.flushAll({ force: true });
        await chat.queue.whenIdle();
        startedInside = server.uploads().length;
        return move(from, to);
      });
      const [app] = await env.db.getAllApplications();
      let done = false;
      const editing = apps.edit({ url: app.url, username: app.username }, { ...app, url: "https://ODOO.example.com" })
        .then(() => { done = true; });
      await vi.waitFor(() => expect(done).toBe(true));
      await editing;
      expect(server.http.calls.filter((c) => c.kind === "cancel").map((c) => c.id)).toEqual([server.uploads()[1].id]);
      expect(startedInside).toBe(2);
      // The lane runs again under the new id
      await vi.waitFor(() => expect(server.uploads()).toHaveLength(3));
      server.release();
      await vi.waitFor(async () => expect(posts()).toHaveLength(1));
      advance(3 * 60_000 + 1);
      await chat.flushAll({ force: true });
      await vi.waitFor(async () => expect(posts()).toHaveLength(2));
      await chat.queue.whenIdle();
      expect(server.uploads().map((c) => c.file!.name)).toEqual(["c.pdf", "a.jpg", "c.pdf"]);
      expect(odoo.state.attachments.map((a) => a.name)).toEqual(["a.jpg", "c.pdf"]);
      expect(posts().map((p) => [p.params.thread_id, p.params.post_data.attachment_ids])).toEqual([[CHAT, [901]], [GROUP, [900]]]);
      expect(await env.db.getOutboxOpsForConfig(config)).toEqual([]);
      expect(await env.db.getOutboxOpsForConfig(renamed)).toEqual([]);
    });

    it("a queued file whose upload op was lost gets one again and its post goes", async () => {
      const queue = (chat.queue as any).outbox as OutboxService;
      let vanish = true;
      odoo.state.onPost = async () => {
        if (!vanish) return;
        vanish = false;
        odoo.state.attachments.splice(0, 1);
        // The app dies between the row put back in the queue and its new op
        const enqueue = queue.enqueue.bind(queue);
        vi.spyOn(queue, "enqueue").mockImplementationOnce(async () => { throw new Error("killed"); }).mockImplementation(enqueue);
      };
      const sent = await chat.send(src, GROUP, "again", [stage("a.jpg")]);
      await idle();
      expect(await ops("chat.upload")).toEqual([]);
      await chat.flushAll({ force: true });
      await idle();
      // The refused send's stamp still holds the post for its quiet window
      advance(3 * 60_000 + 1);
      await chat.flushAll({ force: true });
      await idle();
      expect(server.uploads()).toHaveLength(2);
      expect(posts().map((p) => p.params.post_data.attachment_ids)).toEqual([[900], [901]]);
      expect((await chat.messages(config, GROUP)).find((m) => m.clientUuid === sent.clientUuid)).toMatchObject({ status: "sent" });
    });

    it("a leave that reaches the server first refuses the file on the wire without a notice", async () => {
      server.state.hold = { nth: 1, when: "before" };
      const a = stage("a.jpg");
      const sent = await chat.send(src, GROUP, "never", [a]);
      await vi.waitFor(() => expect(server.uploads()).toHaveLength(1));
      // The cancel does not reach the transfer: its answer comes back as for a channel left
      vi.spyOn(chat.queue.transfer!, "cancel").mockResolvedValue(undefined);
      await chat.leave(src, GROUP);
      server.state.notFound = "all";
      server.release();
      await idle();
      expect(await chat.notices([config])).toEqual([]);
      expect((await chat.repo.outgoingOf(config, sent.clientUuid))[0]).toMatchObject({ state: "refused", error: "left" });
    });

    it("a refused file's notice is written blocked at once", async () => {
      const add = vi.spyOn(env.db, "addOutboxOp");
      const update = vi.spyOn(env.db, "updateOutboxOp");
      server.state.status = 413;
      await chat.send(src, GROUP, "text", [stage("big.jpg")]);
      await idle();
      const notice = add.mock.calls.map(([op]) => op).find((op) => op.kind === "chat.file_refused")!;
      expect(notice).toMatchObject({ status: "blocked", params: { name: "big.jpg", reason: "too_big", blockedReason: "refused" } });
      expect(update.mock.calls.filter(([id]) => id === notice.id)).toEqual([]);
    });

    it("a temporary id swap reaches upload ops and rows", async () => {
      const groups = createServer(odoo, { now: () => clock });
      offline();
      const { channelId: tempId } = await chat.createGroup(src, [BOB], "Files");
      const sent = await chat.send(src, tempId, "to the new group", [stage("a.jpg")]);
      online();
      await chat.flushAll();
      await idle();
      const realId = groups.channels[0].id;
      expect(server.uploads()[0].fields).toEqual(fields(realId));
      expect(posts().map((p) => [p.params.thread_id, p.params.post_data.attachment_ids])).toEqual([[realId, [900]]]);
      const message = (await chat.messages(config, realId)).find((m) => m.clientUuid === sent.clientUuid)!;
      expect((await chat.repo.attachmentsOf(config, realId, [message.messageId!], [])).get(`m${message.messageId}`))
        .toEqual([expect.objectContaining({ attachmentId: 900, channelId: realId })]);
    });

    describe("drafts", () => {
      it("a draft's text and files survive a restart and the startup repair", async () => {
        const a = stage("IMG_20261026_101500.jpg");
        const b = stage("notes.pdf", 5, "application/pdf");
        await chat.saveDraftText(config, GROUP, "half a sentence");
        await chat.keepDraftFile(config, GROUP, b, 1, "file");
        await chat.keepDraftFile(config, GROUP, a, 0, "camera");
        await reborn();
        await chat.recover();
        const draft = await chat.draft(config, GROUP);
        expect(draft.text).toBe("half a sentence");
        expect(draft.files.map((f) => [f.localUuid, f.name, f.size, f.originalPath, f.origin])).toEqual([
          [a.localUuid, a.name, 3, a.path, "camera"], [b.localUuid, b.name, 5, b.path, "file"],
        ]);
        expect(draft.lost).toEqual([]);
        expect(server.files.bytes(a.path)).toBeDefined();
        expect(server.files.bytes(b.path)).toBeDefined();
      });

      it("an emptied text and a removed file leave no draft; the removed file is deleted", async () => {
        const a = stage("a.jpg");
        await chat.saveDraftText(config, GROUP, "x");
        await chat.keepDraftFile(config, GROUP, a, 0);
        await chat.saveDraftText(config, GROUP, "");
        await chat.dropDraftFile(config, a);
        expect(await chat.draft(config, GROUP)).toEqual({ text: "", files: [], lost: [], replyTo: null, edit: null, mentions: { partners: [], channels: [] } });
        expect(server.files.bytes(a.path)).toBeUndefined();
        expect(await chat.repo.draftChannels(config)).toEqual(new Set());
      });

      it("a draft file whose staged copy is gone is dropped from the draft and named", async () => {
        const a = stage("a.jpg");
        const b = stage("b.jpg");
        await chat.keepDraftFile(config, GROUP, a, 0);
        await chat.keepDraftFile(config, GROUP, b, 1);
        await server.files.remove(a.path);
        const draft = await chat.draft(config, GROUP);
        expect(draft.lost).toEqual(["a.jpg"]);
        expect(draft.files.map((f) => f.localUuid)).toEqual([b.localUuid]);
        expect(await chat.repo.outgoingFile(config, a.localUuid)).toBeNull();
      });

      it("a send takes the draft files in place and posts them", async () => {
        const a = stage("a.jpg");
        const voice = stage("Voice-2026-10-26-123.mp3", 4, "audio/mpeg", true);
        await chat.keepDraftFile(config, GROUP, a, 0);
        await chat.keepDraftFile(config, GROUP, voice, 1);
        await chat.saveDraftText(config, GROUP, "two ");
        let queued: string | undefined;
        const sent = await chat.send(src, GROUP, "two", [a, voice], {
          draftText: "two ",
          onQueued: () => { queued = posts().length === 0 ? "before the flush" : "after"; },
        });
        expect(queued).toBe("before the flush");
        await idle();
        expect(server.uploads().map((c) => c.file!.name)).toEqual(["a.jpg", "Voice-2026-10-26-123.mp3"]);
        expect(posts().map((p) => p.params.post_data.attachment_ids)).toEqual([[900, 901]]);
        expect((await chat.messages(config, GROUP)).find((m) => m.clientUuid === sent.clientUuid)).toMatchObject({ status: "sent" });
        expect(await chat.draft(config, GROUP)).toEqual({ text: "", files: [], lost: [], replyTo: null, edit: null, mentions: { partners: [], channels: [] } });
        expect(await chat.repo.draftFileCount(config)).toBe(0);
      });

      it("a conversation created offline keeps its draft through the id swap", async () => {
        const groups = createServer(odoo, { now: () => clock });
        offline();
        const { channelId: tempId } = await chat.createGroup(src, [BOB], "Drafts");
        const a = stage("a.jpg");
        await chat.saveDraftText(config, tempId, "for the new group");
        await chat.keepDraftFile(config, tempId, a, 0);
        online();
        await chat.flushAll();
        await idle();
        const realId = groups.channels[0].id;
        const draft = await chat.draft(config, realId);
        expect(draft.text).toBe("for the new group");
        expect(draft.files.map((f) => [f.localUuid, f.channelId])).toEqual([[a.localUuid, realId]]);
        // A screen still on the temporary id reads and writes the server's
        expect((await chat.draft(config, tempId)).text).toBe("for the new group");
        await chat.saveDraftText(config, tempId, "typed after the swap");
        expect((await chat.repo.draftOf(config, realId)).text).toBe("typed after the swap");
        expect(await chat.repo.draftChannels(config)).toEqual(new Set([`${config}#${realId}`]));
      });

      it("a dropped conversation releases its draft files", async () => {
        const a = stage("a.jpg");
        await chat.keepDraftFile(config, GROUP, a, 0);
        await chat.saveDraftText(config, GROUP, "x");
        await chat.repo.dropChannel(config, GROUP);
        expect(server.files.bytes(a.path)).toBeUndefined();
        expect(await chat.repo.draftChannels(config)).toEqual(new Set());
      });

      it("a screen opened while a send of its conversation runs reads the draft once the post is queued", async () => {
        const a = stage("a.jpg");
        await chat.saveDraftText(config, GROUP, "sent from the first screen");
        await chat.keepDraftFile(config, GROUP, a, 0, "camera");
        // The first screen's tap: the compress question still open
        const end = chat.sendStarted(config, GROUP);
        let read: any = null;
        const reading = chat.draft(config, GROUP).then((d) => { read = d; });
        await new Promise((r) => setTimeout(r, 0));
        expect(read).toBeNull();
        offline();
        await chat.send(src, GROUP, "sent from the first screen", [a], { draftText: "sent from the first screen", onQueued: end });
        await reading;
        expect(read).toEqual({ text: "", files: [], lost: [], replyTo: null, edit: null, mentions: { partners: [], channels: [] } });
        // Another conversation is not held by it
        const other = chat.sendStarted(config, GROUP + 1);
        expect(await chat.draft(config, GROUP)).toEqual({ text: "", files: [], lost: [], replyTo: null, edit: null, mentions: { partners: [], channels: [] } });
        other();
        other();
        online();
      });

      it("the drafts of an account read after the writes asked before them", async () => {
        void chat.saveDraftText(config, GROUP, "written as the screen closes");
        expect(await chat.draftSummaries(config)).toEqual(new Map([[GROUP, { text: "written as the screen closes", files: 0, editing: false }]]));
      });
    });
  });
});
