import {
  messageKeyOf,
  type ChannelType, type ChatAttachment, type ChatMessage, type ChatNotice, type ChatReaction, type MessageTarget,
  type OutgoingFile,
} from "../../models/chat";
import { attachmentSettings, deviceAttachmentIO } from "../attachmentService";
import type { DatabaseService, OutboxOp } from "../databaseService";
import { networkService } from "../networkService";
import { OdooRpcError, RequestNotSentError, type OdooRpcClient, type SyncCredentials } from "../odoo/odooRpcClient";
import {
  OutboxBlockedError,
  OutboxHeldError,
  OutboxRetryLaterError,
  dependencyOrder,
  type DrainResult,
  type OutboxService,
} from "../outboxService";
import {
  deviceChatFiles, originalPath as originalFilePath, removeChatFile, type ChatFiles, type TransferProgress,
} from "./chatFiles";
import { joinDraftText } from "./chatDraft";
import {
  ChatFileTooBigError,
  ChatTransferCancelledError,
  ChatTransferRefusedError,
  MODULE_UPLOAD_ROUTE,
  ODOO_UPLOAD_ROUTE,
  UPLOAD_SLACK_BYTES,
  type ChatTransfer,
} from "./chatTransfer";
import { syncConfigIdFor } from "../../models/syncConfig";
import { CREATE_QUIET_WINDOW_MS, clientMarker } from "../outboxMarker";
import { bodyHasMarker, bodyText, chatMarker, isEmptyMessage, withEditedMark } from "./chatBody";
import { EMPTY_MENTIONS, composeBody, type Mentions } from "./chatCompose";
import { emojiConversions } from "./chatEmoji";
import { effectiveLevel, levelAtLeast } from "./chatModule";
import type { ChatRepository } from "./chatRepository";
import { parseStore, type StoreDelta } from "./chatStore";
import { v4 as uuidv4 } from "uuid";

/** Pseudo note id of every chat row in sync_outbox: the note sync leaves them alone. */
export const CHAT_NOTE = "chat";
/**
 * params { channelId, text, mentions: Mentions, parent: MessageTarget|null,
 * useModule: boolean, createSentAt?, files?, idempotentUpload?,
 * reuploaded? }. mentions: the people and channels picked, the body and
 * the post's partner_ids and special_mentions built from them and the text
 * at each send (composeBody); parent: the message it replies to, its
 * server id read at the send. files: the local uuids of its files in pick
 * order (their rows carry the post's client uuid); idempotentUpload:
 * whether their uploads take the module route (module 1.2); reuploaded:
 * the files the server lost were uploaded again once.
 */
export const CHAT_POST = "chat.post";
/**
 * params { channelId, localUuid, path, name, mimetype, size, voice,
 * useModule, uploadSentAt?, uploadEndedAt?, heldFor? }: one file of a post,
 * uploaded as a pending attachment just before it. The op's client uuid is
 * the client_uuid of the module route (useModule). uploadSentAt: the first
 * send that may have reached the server; uploadEndedAt: the end of the last
 * such send that failed.
 */
export const CHAT_UPLOAD = "chat.upload";
/**
 * params { channelId, localUuid, name, reason, limit? }: a notice, never
 * sent. A file of a post was not sent ("too_big": over `limit`, the
 * session's size limit, or answered 413 without one; "missing": no longer
 * on the phone; "refused", "not_found": the server's answer); the post
 * went without it.
 */
export const CHAT_FILE_REFUSED = "chat.file_refused";
/** Uploads one account runs at a time, beside its other ops. */
export const CHAT_UPLOADS_AT_ONCE = 2;
/** params { channelId, lastMessageId, mentions: boolean } */
export const CHAT_READ = "chat.read";
/**
 * params { channelId, mode: "dm"|"group"|"channel", partnerIds, name,
 * groupId: number|false, useModule, createSentAt? }. channelId is the
 * temporary (negative) id until the create settles; a direct message
 * pinned again carries its own id.
 */
export const CHAT_CREATE = "chat.create";
/** params { channelId } */
export const CHAT_JOIN = "chat.join";
/** params { channelId, partnerIds }; a group or a channel (a chat takes a new group instead). */
export const CHAT_INVITE = "chat.invite";
/** params { channelId, name }: a group or channel's name, a chat's own label. */
export const CHAT_RENAME = "chat.rename";
/** params { channelId, description } */
export const CHAT_DESCRIBE = "chat.describe";
/** params { channelId } */
export const CHAT_LEAVE = "chat.leave";
/** params { channelId }: a direct message unpinned on the server. */
export const CHAT_HIDE = "chat.hide";
/** params { channelId, until }; until: an ISO date, "forever", or null (not muted). */
export const CHAT_MUTE = "chat.mute";
/** params { until }, as CHAT_MUTE, for the whole account. */
export const CHAT_GLOBAL_MUTE = "chat.global_mute";
/** params { channelId, partnerId }: another member removed, by a system user (server module 1.1). */
export const CHAT_REMOVE = "chat.remove";

/**
 * params { channelId, count, label }: a notice, never sent. The server took
 * the conversation away (left elsewhere, deleted) while `count` actions of
 * the user still waited for it; `label` names it as it was cached.
 */
export const CHAT_DROPPED = "chat.dropped";

/**
 * params { channelId, messageId: number|null, clientUuid: string|null,
 * content, action: "add"|"remove", base: boolean }: the user's own
 * reaction `content` (the exact string the server stores) on one message,
 * as a target state. The message is named by its server id, or while it is
 * pending by the client uuid of its post (sameTarget); base: whether the
 * server held that reaction of the user when the first op of the key was
 * queued.
 */
export const CHAT_REACTION = "chat.reaction";

/**
 * params { channelId, messageId: number|null, clientUuid: string|null,
 * text, mentions: Mentions, baseBody: string|null, conflict? }: the text
 * the user's own message is to say, sent as the browser composer's HTML
 * (composeBody). baseBody: the server's body the edit was made against,
 * read when the first op of the message was queued and kept by later
 * ones; null while the message is a post not answered yet (filled from the
 * post's answer, else read before the send). conflict: "changed" or
 * "deleted" once the server's body was found to differ (a refusal, kept
 * for « Reprendre »).
 */
export const CHAT_EDIT = "chat.edit";

/**
 * params { channelId, messageId: number|null, clientUuid: string|null,
 * baseBody: string|null }: the user's own message emptied, as Odoo's delete
 * does. baseBody: the server's body when it was queued, shown again when
 * the server refuses the delete.
 */
export const CHAT_DELETE = "chat.delete";

/** The actions on one message, handled by runMessageAction, each a target state of its message (and content). */
export const MESSAGE_KINDS = [CHAT_REACTION, CHAT_EDIT, CHAT_DELETE];

/** The guarded edit route of the server module (1.3): it writes only over the body whose fingerprint it is given. */
export const MODULE_EDIT_ROUTE = "/erplibre_mobile_chat/message/update_content";

/** Odoo's edit route, also its delete (an emptied body, no attachment). */
const ODOO_EDIT_ROUTE = "/mail/message/update_content";

/**
 * The fingerprint the guarded edit compares (`erplibre_body_fingerprint`):
 * the SHA-256 hex of the body's UTF-8 bytes, the body as Store answers it;
 * an empty body is hashed as "".
 */
export async function bodyFingerprint(body: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A route the server answered with a plain 404 (no JSON-RPC answer): the route does not exist there. */
class RouteMissingError extends Error {}

/**
 * An edit not written because the server's body is no longer the one it
 * was made against: "changed", or "deleted" (the message emptied or gone).
 * `store` is the server's answer holding the current message (the guarded
 * route), `body` its body as re-read (null: no such message).
 */
class EditConflictError extends Error {
  constructor(readonly conflict: "changed" | "deleted", readonly store: any, readonly body: string | null) {
    super(`The message changed on the server since the edit was queued (${conflict}).`);
  }
}

/**
 * The server's body an edit or a delete of `message` is made against: the
 * one the first edit queued on it keeps (`mine`: the ops naming it), else
 * the cached body; null for a message without a server id yet.
 */
function baseBodyOf(message: ChatMessage, mine: OutboxOp[]): string | null {
  const first = dependencyOrder(mine.filter((o) => o.kind === CHAT_EDIT))[0];
  if (first) return first.params.baseBody ?? null;
  return message.messageId === null ? null : message.body;
}

/**
 * Whether `body` is still the body the post of an edit's message sent: it
 * carries that post's marker, which a browser edit, rebuilding the body
 * from its text, drops. An edit of a message the phone did not post has
 * no client uuid and takes any body.
 */
const postBody = (op: OutboxOp, body: string): boolean => !op.params.clientUuid || bodyHasMarker(body, op.params.clientUuid);

/** Whether a post may be on the server already: running, or sent once without the proof that nothing left (createSentAt). */
const postStarted = (op: OutboxOp): boolean => op.status === "running" || !!op.params.createSentAt;

/** The actions handled by runAction, each a target state of one conversation (or of the account). */
const ACTION_KINDS = [
  CHAT_INVITE, CHAT_RENAME, CHAT_DESCRIBE, CHAT_LEAVE, CHAT_HIDE, CHAT_MUTE, CHAT_GLOBAL_MUTE, CHAT_REMOVE,
];

/** The kinds whose blocked rows are notices. */
const NOTICE_KINDS = [...ACTION_KINDS, ...MESSAGE_KINDS, CHAT_DROPPED, CHAT_FILE_REFUSED];

/** The kinds drain leaves to the upload lane (pumpUploads). */
const LANE_KINDS = new Set([CHAT_UPLOAD]);

/** Why a file of a post was not sent (CHAT_FILE_REFUSED). */
export type FileRefusal = "too_big" | "missing" | "refused" | "not_found";

/** The pending attachments of the upload routes: Odoo's placeholder record (mail/controllers/attachment.py). */
const PENDING_MODEL = "mail.compose.message";
/**
 * The mimetypes Odoo's upload route resizes and re-encodes past 1920 px
 * (ir.attachment._postprocess_contents, its default
 * base.image_autoresize_extensions): their stored size is not the size sent.
 */
const RESIZABLE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/bmp", "image/tiff"]);

/** Whether findUploaded looks for the upload's attachment by name alone (a type Odoo's route may resize). */
const foundByNameAlone = (op: OutboxOp): boolean => RESIZABLE_IMAGE_TYPES.has(String(op.params.mimetype ?? "").toLowerCase());

/** The actions of the user a conversation taken away cancels, and counts in its CHAT_DROPPED notice. */
const USER_ACTIONS = new Set([CHAT_INVITE, CHAT_RENAME, CHAT_DESCRIBE, CHAT_MUTE, CHAT_REMOVE, ...MESSAGE_KINDS]);

/**
 * Calls only the server module defines: a server whose module is older or
 * gone answers them with AttributeError (no such method), which no retry
 * gets past.
 */
const MODULE_ONLY = new Set([CHAT_REMOVE]);

/** The actions Odoo would make the user a member for (the mute route joins a non-member): sent only for a member. */
const MEMBER_ONLY = new Set([CHAT_INVITE, CHAT_RENAME, CHAT_DESCRIBE, CHAT_MUTE]);

/** The options of a post (ChatOutbox.queuePost). */
export interface PostOpts {
  files?: OutgoingFile[];
  idempotentUpload?: boolean;
  draftText?: string;
  mentions?: Mentions;
  replyTo?: MessageTarget | null;
}

/** Options of ChatOutbox.queueAction (see there). */
interface QueueActionOpts {
  /** Narrows the key past kind and conversation (the person removed, the message and emoji). */
  same?: (o: OutboxOp) => boolean;
  /** The params written into an op waiting, from its stored ones; the new params by default. */
  merge?: (stored: Record<string, any>) => Record<string, any>;
  /** Shows the action on the phone, with the conversation's id as queued. */
  local?: (channelId: number | null) => Promise<void>;
  /** The op a new one waits for when no op of the key runs, before the conversation's create. */
  after?: string | null;
  /** Whether merged params leave the server as it stood: nothing is sent. */
  noop?: (merged: Record<string, any>) => boolean;
}

/** Odoo's "muted until I turn it back on", as mute_until_dt carries it. */
export const MUTE_FOREVER_DT = "9999-12-31 23:59:59";

/**
 * The `minutes` of /discuss/settings/mute for a mute that ends at `until`,
 * computed when the request leaves: -1 for "forever", false for no mute or
 * one already over (a mute queued longer than it lasts unmutes), otherwise
 * the minutes left, rounded up.
 */
export function muteMinutes(until: string | null, now: Date): number | false {
  if (until === "forever") return -1;
  if (!until) return false;
  const left = Math.ceil((Date.parse(until) - now.getTime()) / 60000);
  return Number.isFinite(left) && left > 0 ? left : false;
}

export type CreateMode = "dm" | "group" | "channel";

/** Odoo's channel_type of each create mode. */
const TYPE_OF: Record<CreateMode, ChannelType> = { dm: "chat", group: "group", channel: "channel" };

/**
 * How far before the stamp of a lost create the fingerprint search looks:
 * create_date is the server's clock and createSentAt the phone's.
 */
export const CREATE_CLOCK_SKEW_MS = 5 * 60 * 1000;

const CHANNEL_MODEL = "discuss.channel";

/** Server exceptions a retry cannot get past: access, rules, a channel that is gone. */
const REFUSED_ERRORS = new Set([
  "odoo.exceptions.AccessError",
  "odoo.exceptions.ValidationError",
  "odoo.exceptions.UserError",
  "odoo.exceptions.MissingError",
  "werkzeug.exceptions.NotFound",
  "werkzeug.exceptions.Forbidden",
]);

const isRefused = (e: unknown): boolean => e instanceof OdooRpcError && e.odooName !== null && REFUSED_ERRORS.has(e.odooName);

/** The refusals of an action on a message that mean the message is gone (or no longer the user's to reach). */
const VANISHED_ERRORS = new Set(["werkzeug.exceptions.NotFound", "odoo.exceptions.MissingError"]);

const isVanished = (e: unknown): boolean => e instanceof OdooRpcError && e.odooName !== null && VANISHED_ERRORS.has(e.odooName);

/** Whether two targets name one message: by the client uuid of its post when both have one, else by server id. */
export function sameTarget(a: MessageTarget, b: MessageTarget): boolean {
  if (a.clientUuid && b.clientUuid) return a.clientUuid === b.clientUuid;
  return a.messageId != null && a.messageId === b.messageId;
}

/** The message an action on a message names, from its params (MESSAGE_KINDS). */
export function targetOf(op: Pick<OutboxOp, "params">): MessageTarget {
  return { messageId: op.params.messageId ?? null, clientUuid: op.params.clientUuid ?? null };
}

/**
 * The key an action is queued under: its kind, conversation, person
 * removed, message (the client uuid of its post when it has one, else its
 * id) and content. Ops of one key are one action, a later one superseding
 * an earlier.
 */
export function targetKey(op: Pick<OutboxOp, "kind" | "params">): string {
  const p = op.params;
  const message = p.clientUuid ? `u${p.clientUuid}` : p.messageId != null ? `m${p.messageId}` : "";
  return JSON.stringify([op.kind, p.channelId ?? null, p.partnerId ?? null, message, p.content ?? null]);
}

/**
 * A reaction group with the user's own reaction in (`on`) or out: the
 * count and the partners follow, the user put first. Unchanged when it
 * already is; null when nobody is left.
 */
function ownReaction<G extends { count: number; selfReacted: boolean; partnerIds: number[] }>(
  g: G,
  on: boolean,
  self: number | null,
): G | null {
  if (g.selfReacted === on) return g.count > 0 ? g : null;
  const others = g.partnerIds.filter((id) => id !== self);
  const count = Math.max(0, g.count + (on ? 1 : -1));
  return count > 0 ? { ...g, selfReacted: on, count, partnerIds: on && self !== null ? [self, ...others] : others } : null;
}

/** Odoo's "YYYY-MM-DD HH:MM:SS" UTC string for a date. */
const odooDate = (d: Date): string => d.toISOString().slice(0, 19).replace("T", " ");

/**
 * Whether a create or join op may have reached the server: it is running,
 * or ran before without the proof that nothing was sent (a create keeps
 * createSentAt then; a join has no such proof).
 */
const createReached = (op: OutboxOp): boolean =>
  op.status === "running" || (op.attempts > 0 && (op.kind !== CHAT_CREATE || !!op.params.createSentAt));

const emptyDelta = (): StoreDelta => ({
  channels: [],
  deletedChannelIds: [],
  members: [],
  deletedMemberIds: [],
  messages: [],
  attachments: [],
  deletedAttachmentIds: [],
  partners: [],
  inboxCounter: null,
  selfPartnerId: null,
});

/** The mute_until_dt a queued `until` stands for on the phone. */
const muteDt = (until: string | null): string | null =>
  until === "forever" ? MUTE_FOREVER_DT : until ? odooDate(new Date(until)) : null;

/**
 * The chat's own outbox: posts and reads queued in sync_outbox under the
 * pseudo note CHAT_NOTE, drained by flush() and never by the note sync.
 *
 * Every post body ends with a hidden comment carrying the op's client uuid;
 * with the server module (useModule) the uuid also travels in post_data.
 * A send stamps createSentAt, and a retry first waits out
 * CREATE_QUIET_WINDOW_MS (the first request may still be running, its row
 * not yet visible to a search), then searches the channel for the comment
 * among the user's own messages and adopts the message it finds instead of
 * posting again. A send that provably never reached the server (offline
 * before it, or a connection that failed: RequestNotSentError) gives the
 * stamp back, so its retry waits for no window; a timeout or a lost answer
 * keeps it.
 */
export class ChatOutbox {
  /** Whether a server may answer now; ChatService points it at its own. */
  isOnline: () => Promise<boolean> = () => networkService.isOnline();
  /**
   * Runs a write of server counters in the account's queue of such writers;
   * ChatService points it at its own (see the class there), so a load
   * reading before a post answered never writes its older counters after it.
   */
  serial: <T>(configId: string, task: () => Promise<T>) => Promise<T> = (_configId, task) => task();
  /**
   * Called once a create or a join is written to the cache, with the id
   * the phone used and the server's (equal for a join or a direct message
   * pinned again); ChatService resubscribes and tells the screens.
   */
  created: (configId: string, tempId: number, channelId: number) => void = () => {};
  /** Called once the server took a leave; ChatService resubscribes and tells the screens. */
  left: (configId: string, channelId: number) => void = () => {};
  /** Called after an action wrote to the cache or was given up; ChatService tells the screens. */
  changed: (configId: string, channelId: number | null) => void = () => {};
  /**
   * Called when the server answered a call of the module as if the module
   * were missing; ChatService probes the module state again.
   */
  moduleRefused: (configId: string) => Promise<void> = async () => {};
  /**
   * Whether an edit takes the guarded route of the module (1.3) rather
   * than a re-read before Odoo's; ChatService points it at its features.
   */
  editGuard: (configId: string) => Promise<boolean> = async () => false;
  /** The app's chat files: the outgoing ones this outbox owns. ChatService sets it with the transfer. */
  files: ChatFiles = deviceChatFiles;
  /** Uploads the files; ChatService sets it. Without one an upload fails and waits for its retry. */
  transfer: ChatTransfer | null = null;
  /** Whether the phone is on Wi-Fi now: attachmentSettings().wifiOnly holds uploads until it is. */
  onWifi: () => Promise<boolean> = () => deviceAttachmentIO.onWifi();

  /** Per account, the end of the queue of exclusive() tasks. */
  private locks = new Map<string, Promise<void>>();
  /** Per account, the ids of the upload ops the lane runs now. */
  private lane = new Map<string, Set<string>>();
  /** Per account, the lane's work still settling (pumps, uploads, the flushes after them), for whenIdle. */
  private laneWork = new Map<string, Set<Promise<unknown>>>();
  /** Transfer id of each upload op on the wire, for a cancel. */
  private transfers = new Map<string, string>();
  /** Upload ops told to stop before their transfer began: it never starts. */
  private stopped = new Set<string>();
  /**
   * Config ids whose lane starts no upload, with the number of pauseUploads
   * not yet resumed: two renames that share an id each keep it paused.
   */
  private paused = new Map<string, number>();
  /** Bytes sent so far, by transfer id. */
  private progress = new Map<string, { localUuid: string; done: number; total: number }>();
  /** Subscribes to the transport's progress events; replaced by setProgressSource. */
  private progressSource: ((fn: (p: TransferProgress) => void) => () => void) | null = null;
  private progressOff: (() => void) | null = null;

  constructor(
    private db: DatabaseService,
    private rpc: OdooRpcClient,
    private outbox: OutboxService,
    private repo: ChatRepository,
    private now: () => Date = () => new Date(),
  ) {
    outbox.registerHandler(CHAT_POST, (creds, op) => this.runPost(creds, op));
    outbox.registerHandler(CHAT_READ, (creds, op) => this.runRead(creds, op));
    outbox.registerHandler(CHAT_CREATE, (creds, op) => this.runCreate(creds, op));
    outbox.registerHandler(CHAT_JOIN, (creds, op) => this.runJoin(creds, op));
    outbox.registerHandler(CHAT_UPLOAD, (creds, op) => this.runUpload(creds, op));
    for (const kind of ACTION_KINDS) outbox.registerHandler(kind, (creds, op) => this.runAction(creds, op));
    for (const kind of MESSAGE_KINDS) outbox.registerHandler(kind, (creds, op) => this.runMessageAction(creds, op));
  }

  /**
   * Runs `task` once the account's earlier exclusive() tasks settled: a
   * post being queued and a temporary id being swapped never interleave,
   * so a post never lands under an id the swap already left. Short cache
   * work only; never awaits serial().
   */
  private exclusive<T>(configId: string, task: () => Promise<T>): Promise<T> {
    const run = (this.locks.get(configId) ?? Promise.resolve()).then(task);
    const tail = run.then(() => undefined, () => undefined);
    this.locks.set(configId, tail);
    void tail.then(() => {
      if (this.locks.get(configId) === tail) this.locks.delete(configId);
    });
    return run;
  }

  /**
   * Runs a draft read or write of the account in its exclusive() queue,
   * with `channelId` taken as the server's id once its create settled: a
   * draft is never written under a temporary id the swap already left, a
   * post being queued sees the draft as it was asked, and a read sees every
   * write asked before it.
   */
  draftTask<T>(configId: string, channelId: number | null, task: (channelId: number) => Promise<T>): Promise<T> {
    return this.exclusive(configId, async () =>
      task(channelId === null ? 0 : (await this.realIdOf(configId, channelId)) ?? channelId));
  }

  /** The server id of a conversation created under `tempId` once its create settled, else null (stored, so it holds across restarts). */
  realIdOf(configId: string, tempId: number): Promise<number | null> {
    return this.repo.realIdOf(configId, tempId);
  }

  /**
   * Stores the text as a pending message and queues its post. The op waits
   * for the newest unfinished post of the same channel, so a failed post
   * holds the ones written after it; the first post of a conversation still
   * being created (or joined) waits for that op. A temporary id whose create
   * already settled is taken as the server's id. A conversation that cannot
   * take a post (one whose create was refused, or a temporary id with no
   * create left) keeps the text as a failed message and queues nothing: a
   * negative id never reaches the server. So does a conversation the user
   * is leaving or left with texts unsent; its files are stored refused
   * ("channel") beside the message.
   *
   * With files (staged under the account's out directory), one CHAT_UPLOAD
   * per file goes between that tail and the post, in pick order:
   * tail ← upload₁ ← … ← uploadₙ ← post, so each file is uploaded just
   * before its post and a later post of the channel waits for all of it.
   * Their rows are stored "queued" under the post's client uuid: a file
   * kept as the conversation's draft is given to the post in place
   * (ChatRepository.queueDrafts), its row and staged file kept, and the
   * post's `drafts` names those. The ops are stored "incomplete" until the
   * rows and the message are written (recoverIncomplete repairs a cut). A
   * post that cannot be queued deletes the other staged files and gives the
   * draft files back to the draft. idempotentUpload sends the files through
   * the module route (module 1.2). draftText is the composer's text as
   * the draft holds it: kept in the post's params, it is removed from the
   * draft (ChatRepository.removeDraftText) in this same step once the
   * message is stored, best-effort (a failure is logged, the post stays);
   * recoverIncomplete finishes a removal a kill cut. A post not stored
   * leaves the draft as it was.
   *
   * mentions: the picks of the composer, the bubble showing the body the
   * browser would post. replyTo: the message it answers, named as the
   * cache holds it (messageOf; one not cached as given); the bubble
   * carries it as parentId, or parentClientUuid while it has no server id.
   */
  queuePost(
    configId: string,
    channelId: number,
    text: string,
    useModule: boolean,
    opts: PostOpts = {},
  ): Promise<ChatMessage> {
    return this.exclusive(configId, async () =>
      this.queuePostNow(configId, (await this.realIdOf(configId, channelId)) ?? channelId, text, useModule, opts));
  }

  /** The rows of a post's files, in pick order. */
  private outgoingRows(
    configId: string,
    channelId: number,
    postClientUuid: string,
    files: OutgoingFile[],
    state: "queued" | "refused",
  ): ChatAttachment[] {
    return files.map((f, seq) => ({
      configId,
      channelId,
      messageId: null,
      attachmentId: null,
      localUuid: f.localUuid,
      postClientUuid,
      seq,
      name: f.name,
      mimetype: f.mimetype,
      size: f.size,
      checksum: null,
      voice: f.voice,
      thumbPath: null,
      thumbBytes: 0,
      originalPath: f.path,
      originalBytes: f.size,
      state,
      error: state === "refused" ? "channel" : null,
      lastOpenedAt: null,
      createdAt: this.now().toISOString(),
    }));
  }

  /** The params of the upload op of one file. */
  private uploadParams(channelId: number, f: OutgoingFile, useModule: boolean): Record<string, any> {
    return {
      channelId,
      localUuid: f.localUuid,
      path: f.path,
      name: f.name,
      mimetype: f.mimetype,
      size: f.size,
      voice: f.voice,
      useModule,
    };
  }

  private async queuePostNow(
    configId: string,
    channelId: number,
    text: string,
    useModule: boolean,
    opts: PostOpts,
  ): Promise<ChatMessage> {
    const files = opts.files ?? [];
    const mentions = opts.mentions ?? EMPTY_MENTIONS;
    const body = composeBody(text, mentions, await emojiConversions()).body;
    const parent = opts.replyTo ? await this.parentOf(configId, opts.replyTo) : null;
    const parentFields = {
      parentId: parent?.messageId ?? null,
      parentClientUuid: parent && parent.messageId === null ? parent.clientUuid : null,
    };
    const drafts = new Set<string>();
    for (const f of files) {
      if ((await this.repo.outgoingFile(configId, f.localUuid))?.state === "draft") drafts.add(f.localUuid);
    }
    const fresh = files.filter((f) => !drafts.has(f.localUuid));
    const channel = await this.repo.channel(configId, channelId);
    if (channel?.createFailed || (channelId < 0 && !channel?.createOpId) || (await this.leaving(configId, channelId))) {
      const failed: ChatMessage = {
        configId,
        channelId,
        messageId: null,
        clientUuid: uuidv4(),
        authorPartnerId: (await this.repo.sourceState(configId)).selfPartnerId,
        body,
        date: odooDate(this.now()),
        messageType: "comment",
        status: "failed",
        outboxOpId: null,
        writeDate: null,
        ...parentFields,
      };
      await this.repo.putPending(failed);
      if (files.length > 0) await this.storeFiles(configId, channelId, failed.clientUuid, files, drafts, "refused");
      await this.releaseDraftText(configId, channelId, opts.draftText);
      return failed;
    }
    const all = await this.db.getOutboxOpsForConfig(configId);
    // The tail of the channel's chain: the unfinished post no other post or upload waits for (an action on its message may)
    const previous = all
      .filter((o) => o.kind === CHAT_POST && o.params.channelId === channelId)
      .filter((c) => !all.some((o) => o.dependsOn === c.id && (o.kind === CHAT_POST || o.kind === CHAT_UPLOAD)))
      .at(-1);
    const createOpId = channel?.createOpId ?? null;
    const creating = createOpId !== null && all.some((o) => o.id === createOpId) ? createOpId : null;
    const uploads: OutboxOp[] = [];
    let tail = previous?.id ?? creating;
    const incomplete = files.length > 0;
    let op: OutboxOp;
    try {
      for (const f of files) {
        const up = await this.outbox.enqueue({
          noteId: CHAT_NOTE,
          configId,
          kind: CHAT_UPLOAD,
          params: this.uploadParams(channelId, f, !!opts.idempotentUpload),
          dependsOn: tail,
          status: "incomplete",
        });
        uploads.push(up);
        tail = up.id;
      }
      op = await this.outbox.enqueue({
        noteId: CHAT_NOTE,
        configId,
        kind: CHAT_POST,
        params: {
          ...(incomplete
            ? {
              channelId, text, mentions, parent, useModule, files: files.map((f) => f.localUuid),
              idempotentUpload: !!opts.idempotentUpload,
              ...(drafts.size > 0 ? { drafts: files.filter((f) => drafts.has(f.localUuid)).map((f) => f.localUuid) } : {}),
            }
            : { channelId, text, mentions, parent, useModule }),
          ...(opts.draftText !== undefined ? { draftText: opts.draftText } : {}),
        },
        dependsOn: tail,
        ...(incomplete ? { status: "incomplete" as const } : {}),
      });
    } catch (e: unknown) {
      for (const up of uploads) await this.outbox.cancel(up.id);
      await this.removeFiles(fresh.map((f) => f.path));
      throw e;
    }
    const message: ChatMessage = {
      configId,
      channelId,
      messageId: null,
      clientUuid: op.clientUuid,
      authorPartnerId: (await this.repo.sourceState(configId)).selfPartnerId,
      body,
      date: odooDate(this.now()),
      messageType: "comment",
      status: "pending",
      outboxOpId: op.id,
      writeDate: null,
      ...parentFields,
    };
    try {
      if (incomplete) await this.storeFiles(configId, channelId, op.clientUuid, files, drafts, "queued");
      await this.repo.putPending(message);
      // The post last: no drain sends it before its uploads are queued
      for (const up of uploads) await this.outbox.complete(up.id, {});
      if (incomplete) await this.outbox.complete(op.id, {});
    } catch (e: unknown) {
      // No op goes out without its bubble
      for (const up of uploads) await this.outbox.cancel(up.id);
      await this.outbox.cancel(op.id);
      if (incomplete) {
        await this.repo.backToDraft(configId, [...drafts]);
        await this.dropOutgoing(configId, fresh.map((f) => f.localUuid));
        // A cut inside putOutgoing leaves files no row names
        await this.removeFiles(fresh.map((f) => f.path));
      }
      throw e;
    }
    await this.releaseDraftText(configId, channelId, opts.draftText);
    return message;
  }

  /** A reply target as the cache names its message (messageOf): its server id and client uuid; one not cached as given. */
  private async parentOf(configId: string, target: MessageTarget): Promise<MessageTarget> {
    const message = await this.repo.messageOf(configId, target);
    return message ? { messageId: message.messageId, clientUuid: message.clientUuid } : { ...target };
  }

  /**
   * The server id a post sends as parent_id, read at its send: the
   * parent's cached row (a pending parent has one once its own post
   * settled), else the id it was named by. Null, left out of the post, for
   * no parent or one that never got an id (dropped or failed before it
   * was sent).
   */
  private async parentIdOf(configId: string, parent: MessageTarget | null | undefined): Promise<number | null> {
    if (!parent) return null;
    return (await this.repo.messageOf(configId, parent))?.messageId ?? parent.messageId;
  }

  /** Removes a stored post's text from the draft (removeDraftText, `notAfter` passed on); a failure is logged, the post is not touched. */
  private async releaseDraftText(configId: string, channelId: number, text: unknown, notAfter?: string): Promise<void> {
    if (typeof text !== "string") return;
    try {
      await this.repo.removeDraftText(configId, channelId, text, notAfter);
    } catch (e: unknown) {
      console.warn("chat: a sent text stays in the draft", e);
    }
  }

  /**
   * Stores the rows of a post's files, each at its position: a draft file's
   * row is given to the post in place, any other is written new.
   */
  private async storeFiles(
    configId: string,
    channelId: number,
    postClientUuid: string,
    files: OutgoingFile[],
    drafts: Set<string>,
    state: "queued" | "refused",
  ): Promise<void> {
    const rows = this.outgoingRows(configId, channelId, postClientUuid, files, state);
    const fresh = rows.filter((r) => !drafts.has(r.localUuid!));
    if (fresh.length > 0) await this.repo.putOutgoing(fresh);
    const given = files.map((file, seq) => ({ file, seq })).filter(({ file }) => drafts.has(file.localUuid));
    if (given.length > 0) await this.repo.queueDrafts(configId, channelId, postClientUuid, given, state);
  }

  /** The paths given whose file is not a draft's: those a cleanup may delete. */
  private async notDrafts(configId: string, files: Record<string, any>[]): Promise<string[]> {
    const out: string[] = [];
    for (const f of files) {
      const row = typeof f.localUuid === "string" ? await this.repo.outgoingFile(configId, f.localUuid) : null;
      if (row?.state !== "draft") out.push(String(f.path ?? ""));
    }
    return out;
  }

  /** Removes outgoing rows by local uuid and deletes their files (the outbox owns them). */
  private async dropOutgoing(configId: string, localUuids: string[]): Promise<void> {
    await this.removeFiles(await this.repo.deleteOutgoing(configId, localUuids));
  }

  /** Deletes files (with their out/<localUuid>/ directory); a missing one is fine, a failed delete is logged. */
  private async removeFiles(paths: string[]): Promise<void> {
    for (const path of paths) {
      if (!path) continue;
      try {
        await removeChatFile(this.files, path);
      } catch (e: unknown) {
        console.warn("chat: an outgoing file was not deleted", e);
      }
    }
  }

  /**
   * Queues "read up to lastMessageId" for a channel. One op waits per
   * channel: a later call raises its message id (never lowers it) and
   * keeps mentions once set. An op already running has sent its values, so
   * a call meanwhile queues a second op behind it.
   */
  async queueRead(configId: string, channelId: number, lastMessageId: number, mentions: boolean): Promise<void> {
    const same = (await this.outbox.findAll(CHAT_NOTE, configId, CHAT_READ))
      .filter((o) => o.params.channelId === channelId);
    const waiting = same.find((o) => o.status !== "running");
    if (waiting) {
      await this.outbox.setParams(waiting.id, {
        lastMessageId: Math.max(waiting.params.lastMessageId ?? 0, lastMessageId),
        mentions: !!waiting.params.mentions || mentions,
      });
      // The row may have started or finished between the lookup and the write
      const now = await this.db.getOutboxOp(waiting.id);
      if (now && now.status !== "running") return;
      await this.outbox.enqueue({
        noteId: CHAT_NOTE,
        configId,
        kind: CHAT_READ,
        params: { channelId, lastMessageId, mentions },
        dependsOn: now?.id ?? null,
      });
      return;
    }
    await this.outbox.enqueue({
      noteId: CHAT_NOTE,
      configId,
      kind: CHAT_READ,
      params: { channelId, lastMessageId, mentions },
      dependsOn: same.at(-1)?.id ?? null,
    });
  }

  /**
   * Queues the creation of a conversation and writes it to the cache at
   * once under `channelId`: a temporary id (negative, from
   * ChatRepository.newTemporaryId) for a new one, or the id of a cached
   * hidden direct message to pin again. A new conversation is a member,
   * pinned row carrying createOpId, with placeholder members (self, then
   * the people invited; ids tempId·1000 − i, never a server's) so a group
   * without a name shows their names. The op is stored "incomplete" until
   * the row is written, so no drain sends a create whose row is missing.
   */
  async queueCreate(
    configId: string,
    channelId: number,
    p: { mode: CreateMode; partnerIds: number[]; name: string; groupId: number | false; useModule: boolean },
  ): Promise<OutboxOp> {
    const op = await this.outbox.enqueue({
      noteId: CHAT_NOTE,
      configId,
      kind: CHAT_CREATE,
      params: { channelId, ...p },
      status: "incomplete",
    });
    try {
      if (channelId >= 0) {
        // Shown again: a hide still waiting would undo it
        for (const o of await this.db.getOutboxOpsForConfig(configId)) {
          if (o.kind === CHAT_HIDE && o.params.channelId === channelId && o.status !== "running") await this.outbox.cancel(o.id);
        }
        await this.repo.patchChannel(configId, channelId, { isPinned: true, createOpId: op.id });
      } else {
        const self = (await this.repo.sourceState(configId)).selfPartnerId;
        const people = [...(self !== null ? [self] : []), ...p.partnerIds.filter((id) => id !== self)];
        await this.repo.applyDelta(configId, {
          channels: [{
            channelId,
            channelType: TYPE_OF[p.mode],
            name: p.mode === "dm" ? "" : p.name,
            isMember: true,
            isPinned: true,
            lastInterestDt: odooDate(this.now()),
            correspondentPartnerId: p.mode === "dm" ? (p.partnerIds[0] ?? null) : null,
            memberCount: people.length,
            groupPublicId: p.mode === "channel" && p.groupId !== false ? p.groupId : null,
            createOpId: op.id,
          }],
          deletedChannelIds: [],
          members: people.map((partnerId, i) => ({ memberId: channelId * 1000 - i, channelId, partnerId })),
          deletedMemberIds: [],
          messages: [],
          attachments: [],
          deletedAttachmentIds: [],
          partners: [],
          inboxCounter: null,
          selfPartnerId: null,
        });
      }
    } catch (e: unknown) {
      await this.outbox.cancel(op.id);
      throw e;
    }
    await this.outbox.complete(op.id, {});
    return op;
  }

  /**
   * Queues joining a public channel. The cached row (written when missing,
   * from `name`) turns member at once and carries the op as createOpId, so
   * posts written meanwhile wait for the join and a load keeps it.
   */
  async queueJoin(configId: string, channelId: number, name = ""): Promise<OutboxOp> {
    const op = await this.outbox.enqueue({
      noteId: CHAT_NOTE,
      configId,
      kind: CHAT_JOIN,
      params: { channelId },
      status: "incomplete",
    });
    try {
      const cached = await this.repo.channel(configId, channelId);
      await this.repo.applyDelta(configId, {
        channels: [{ channelId, ...(cached ? {} : { channelType: "channel" as const, name }), isMember: true, createOpId: op.id }],
        deletedChannelIds: [],
        members: [],
        deletedMemberIds: [],
        messages: [],
        attachments: [],
        deletedAttachmentIds: [],
        partners: [],
        inboxCounter: null,
        selfPartnerId: null,
      });
    } catch (e: unknown) {
      await this.outbox.cancel(op.id);
      throw e;
    }
    await this.outbox.complete(op.id, {});
    return op;
  }

  /**
   * Whether the user is leaving the conversation (its leave is queued, not
   * refused) or left it with texts unsent: nothing more of it goes to the
   * server.
   */
  private async leaving(configId: string, channelId: number): Promise<boolean> {
    if ((await this.repo.channel(configId, channelId))?.leftUnsent) return true;
    return (await this.db.getOutboxOpsForConfig(configId))
      .some((o) => o.kind === CHAT_LEAVE && o.params.channelId === channelId && o.status !== "blocked");
  }

  /**
   * Queues an action as a target state: one op per account, kind and
   * conversation (and `same`, e.g. the person removed) waits at a time. A
   * later call writes its value into every op of that key still waiting
   * (`merge`: the stored params to the new ones; the last value by
   * default), so whichever of them goes out, the server ends on the last
   * value; one that failed and waits for its retry is among them. An op
   * already running has sent its values, so a call meanwhile queues a
   * second op behind it, as when the newest waiting op starts, finishes or
   * is given up between the lookup and the write. An op the outbox gave up on
   * (blocked, a notice) is replaced. A conversation still being created or
   * joined holds the op until that op is done; the swap then moves it to the
   * server's id. `after` (the post of a message not sent yet) holds a new op
   * the same way, when no op of the key runs. With `noop` and no op of the
   * key running or sent, a value that leaves the server as it stood (`noop`
   * of the first waiting op's merged params, whose base is the server's
   * before any of them) cancels the waiting ops and queues nothing: null.
   * An op whose send may have reached the server (params.sentAt, stamped
   * by runMessageAction) counts as running there: it is kept with the new
   * value, a resend being idempotent. Runs under exclusive(), with the id
   * the create settled on when it did.
   */
  private queueAction(
    configId: string,
    kind: string,
    channelId: number | null,
    params: Record<string, any>,
    opts?: QueueActionOpts & { noop?: undefined },
  ): Promise<OutboxOp>;
  private queueAction(
    configId: string,
    kind: string,
    channelId: number | null,
    params: Record<string, any>,
    opts: QueueActionOpts,
  ): Promise<OutboxOp | null>;
  private queueAction(
    configId: string,
    kind: string,
    channelId: number | null,
    params: Record<string, any>,
    opts: QueueActionOpts = {},
  ): Promise<OutboxOp | null> {
    return this.exclusive(configId, async () => {
      const id = channelId === null ? null : ((await this.realIdOf(configId, channelId)) ?? channelId);
      const all = await this.db.getOutboxOpsForConfig(configId);
      const same = all.filter((o) => o.kind === kind && (id === null || o.params.channelId === id) && (opts.same?.(o) ?? true));
      for (const o of same) if (o.status === "blocked") await this.outbox.cancel(o.id);
      const values = { ...(id === null ? {} : { channelId: id }), ...params };
      // In dependency order: the first waits for none of the others, a follow-up comes after the op it waits for
      const waiting = dependencyOrder(same).filter((o) => o.status !== "running" && o.status !== "blocked");
      const running = same.find((o) => o.status === "running");
      const sent = waiting.some((o) => !!o.params.sentAt);
      let op: OutboxOp | null;
      if (waiting.length > 0) {
        for (const w of waiting) await this.outbox.setParams(w.id, opts.merge ? opts.merge(w.params) : params);
        // The newest may have started, finished or been given up between the lookup and the write
        const now = await this.db.getOutboxOp(waiting[waiting.length - 1].id);
        if (now && now.status !== "running" && now.status !== "blocked") {
          const first = waiting.length > 1 ? await this.db.getOutboxOp(waiting[0].id) : now;
          const noop = !running && !sent && !!first && !!opts.noop?.(first.params);
          op = noop ? await this.cancelWaiting(waiting, first!.params) : now;
        } else {
          op = await this.outbox.enqueue({ noteId: CHAT_NOTE, configId, kind, params: values, dependsOn: now?.id ?? null });
        }
      } else if (!running && opts.noop?.(values)) {
        op = null;
      } else {
        const createOpId = id === null ? null : ((await this.repo.channel(configId, id))?.createOpId ?? null);
        const creating = createOpId !== null && all.some((o) => o.id === createOpId) ? createOpId : null;
        op = await this.outbox.enqueue({
          noteId: CHAT_NOTE, configId, kind, params: values, dependsOn: running?.id ?? opts.after ?? creating,
        });
      }
      await opts.local?.(id);
      return op;
    });
  }

  /**
   * Cancels the waiting ops of a key whose value leaves the server as it
   * stood. One that started meanwhile, or whose send may have reached the
   * server (params.sentAt), holds the merged value or an older one: it is
   * kept, a follow-up with `merged` goes behind it, so the server still
   * ends where it stood, and is returned; otherwise null.
   */
  private async cancelWaiting(waiting: OutboxOp[], merged: Record<string, any>): Promise<OutboxOp | null> {
    let started: OutboxOp | null = null;
    for (const w of waiting) {
      const now = await this.db.getOutboxOp(w.id);
      if (!now) continue;
      if (now.status === "running" || now.params.sentAt) started = now;
      else await this.outbox.cancel(w.id);
    }
    if (!started) return null;
    const { blockedReason: _reason, candidates: _candidates, ...params } = merged;
    return this.outbox.enqueue({ noteId: CHAT_NOTE, configId: started.configId, kind: started.kind, params, dependsOn: started.id });
  }

  /** The cached conversation an action names, refused (Error) unless the user is a member of it. */
  private async memberChannel(configId: string, channelId: number) {
    const id = (await this.realIdOf(configId, channelId)) ?? channelId;
    const channel = await this.repo.channel(configId, id);
    if (!channel || !channel.isMember || channel.createFailed || (await this.leaving(configId, id))) {
      throw new Error(`Conversation ${channelId} is not one the user is a member of.`);
    }
    return channel;
  }

  /** Invites people into a group or channel; the people of the op waiting are kept (union). A chat refuses: it takes a new group. */
  async queueInvite(configId: string, channelId: number, partnerIds: number[]): Promise<OutboxOp> {
    const channel = await this.memberChannel(configId, channelId);
    if (channel.channelType === "chat") throw new Error("A direct message takes no member: invite into a new group.");
    const ids = [...new Set(partnerIds)];
    return this.queueAction(configId, CHAT_INVITE, channelId, { partnerIds: ids }, {
      merge: (stored) => ({ partnerIds: [...new Set([...(stored.partnerIds ?? []), ...ids])] }),
    });
  }

  /**
   * Renames a conversation, shown at once: a group or channel's name (a
   * channel never to "", a group to "" shows its members' names again), a
   * chat's own label (customChannelName; "" shows the correspondent again).
   */
  async queueRename(configId: string, channelId: number, name: string): Promise<OutboxOp> {
    const channel = await this.memberChannel(configId, channelId);
    const trimmed = name.trim();
    if (channel.channelType === "channel" && !trimmed) throw new Error("A channel needs a name.");
    return this.queueAction(configId, CHAT_RENAME, channelId, { name: trimmed }, {
      local: (id) => this.repo.patchChannel(configId, id!, channel.channelType === "chat"
        ? { customChannelName: trimmed || null }
        : { name: trimmed }),
    });
  }

  /** Changes the description of a group or channel, shown at once. */
  async queueDescribe(configId: string, channelId: number, description: string): Promise<OutboxOp> {
    await this.memberChannel(configId, channelId);
    return this.queueAction(configId, CHAT_DESCRIBE, channelId, { description }, {
      local: (id) => this.repo.patchChannel(configId, id!, { description }),
    });
  }

  /** Hides a direct message (unpinned on the server), at once on the phone; its next message shows it again. */
  async queueHide(configId: string, channelId: number): Promise<OutboxOp> {
    return this.queueAction(configId, CHAT_HIDE, channelId, {}, {
      local: (id) => this.repo.patchChannel(configId, id!, { isPinned: false }),
    });
  }

  /**
   * Mutes a conversation until `until` (an ISO date, "forever"; null
   * unmutes), shown at once. The minutes leave with the request
   * (muteMinutes), so a mute that waited past its end unmutes.
   */
  async queueMute(configId: string, channelId: number, until: string | null): Promise<OutboxOp> {
    await this.memberChannel(configId, channelId);
    return this.queueAction(configId, CHAT_MUTE, channelId, { until }, {
      local: (id) => this.repo.patchChannel(configId, id!, { muteUntilDt: muteDt(until) }),
    });
  }

  /**
   * Mutes the whole account until `until`, as queueMute; applied at once
   * and stamped (globalMuteAt), so a load that began before it does not
   * write the older value over it.
   */
  async queueGlobalMute(configId: string, until: string | null): Promise<OutboxOp> {
    return this.queueAction(configId, CHAT_GLOBAL_MUTE, null, { until }, {
      local: () => this.repo.setSourceState({ configId, globalMuteUntil: muteDt(until), globalMuteAt: this.now().toISOString() }),
    });
  }

  /** Removes another person from a group or channel (one op per person); the caller checks the right. */
  async queueRemove(configId: string, channelId: number, partnerId: number): Promise<OutboxOp> {
    return this.queueAction(configId, CHAT_REMOVE, channelId, { partnerId }, {
      same: (o) => o.params.partnerId === partnerId,
    });
  }

  /**
   * Queues the user's own reaction `content` on a message, on or off, as
   * the target state of (message, content) (queueAction): the op waiting
   * takes the new action and keeps its base, and a value equal to its base
   * (where the server stood) cancels the waiting ops and queues nothing
   * (null). Shown at once (showReaction). The message is taken as the
   * cache holds it (messageOf): one not sent yet is named by its post's
   * client uuid and its op waits for that post. Rejects for a message not
   * cached, or one whose post failed.
   */
  async queueReaction(
    configId: string,
    channelId: number,
    target: MessageTarget,
    content: string,
    on: boolean,
  ): Promise<OutboxOp | null> {
    const message = await this.repo.messageOf(configId, target);
    if (!message) throw new Error("The message of the reaction is not cached.");
    if (message.status === "failed") throw new Error("A message not sent takes no reaction.");
    const named: MessageTarget = { messageId: message.messageId, clientUuid: message.clientUuid };
    const action = on ? "add" : "remove";
    const key = messageKeyOf(message);
    const group = (await this.repo.reactionsOf(configId, message.channelId, [key])).get(key)?.find((g) => g.content === content);
    return this.queueAction(configId, CHAT_REACTION, channelId, { ...named, content, action, base: !!group?.selfReacted }, {
      same: (o) => o.params.content === content && sameTarget(targetOf(o), named),
      merge: (stored) => ({ action, messageId: stored.messageId ?? named.messageId }),
      after: message.messageId === null ? message.outboxOpId : null,
      noop: (merged) => (merged.action === "add") === !!merged.base,
      local: () => this.showReaction(configId, named, content, on),
    });
  }

  /**
   * Shows the user's own reaction in or out of the cached group of a
   * message (ownReaction); a new group goes after the message's others.
   * The message is read again: a settle may have moved its key.
   */
  private async showReaction(configId: string, target: MessageTarget, content: string, on: boolean): Promise<void> {
    const message = await this.repo.messageOf(configId, target);
    if (!message) return;
    const key = messageKeyOf(message);
    const groups = (await this.repo.reactionsOf(configId, message.channelId, [key])).get(key) ?? [];
    const stored = groups.find((g) => g.content === content);
    const empty: ChatReaction = {
      configId,
      channelId: message.channelId,
      messageKey: key,
      messageId: message.messageId,
      content,
      count: 0,
      selfReacted: false,
      partnerIds: [],
      guestCount: 0,
      sequence: Math.max(0, ...groups.map((g) => g.sequence)) + 1,
    };
    const next = ownReaction(stored ?? empty, on, (await this.repo.sourceState(configId)).selfPartnerId);
    if (next) await this.repo.putReaction(next);
    else if (stored) await this.repo.dropReaction(configId, key, content);
  }

  /**
   * Queues an edit of the user's own message to `text` with the people
   * and channels picked (`mentions`). A message not sent yet whose post has
   * not started (postStarted) takes the text into its post instead, its
   * bubble rebuilt, and nothing more is queued (null); the edits waiting
   * for that post go. Otherwise a text equal to the shown one (bodyText,
   * the browser's own check) queues nothing (null), and one edit waits per
   * message (queueAction): the last text wins, the first op's baseBody is
   * kept (baseBodyOf: a follow-up behind a running edit takes that op's),
   * and an edit of a message whose post still runs waits for it. Waiting
   * edits that end on the base's text (noop: none running or sent) are
   * cancelled and the base shows again. Otherwise shown at once with the
   * edited span the server adds. Rejects for a message not cached,
   * failed, or being deleted.
   */
  async queueEdit(
    configId: string,
    channelId: number,
    target: MessageTarget,
    text: string,
    mentions: Mentions,
  ): Promise<OutboxOp | null> {
    const message = await this.repo.messageOf(configId, target);
    if (!message) throw new Error("The message to edit is not cached.");
    if (message.status === "failed") throw new Error("A message not sent takes no edit.");
    const named: MessageTarget = { messageId: message.messageId, clientUuid: message.clientUuid };
    const mine = (await this.db.getOutboxOpsForConfig(configId))
      .filter((o) => o.status !== "blocked" && sameTarget(targetOf(o), named));
    if (mine.some((o) => o.kind === CHAT_DELETE)) throw new Error("A message being deleted takes no edit.");
    const body = composeBody(text, mentions, await emojiConversions()).body;
    if (message.messageId === null && (await this.foldIntoPost(message, text, mentions, body, mine))) return null;
    if (bodyText(message.body) === text) return null;
    const baseBody = baseBodyOf(message, mine);
    return this.queueAction(configId, CHAT_EDIT, channelId, { ...named, text, mentions, baseBody }, {
      same: (o) => sameTarget(targetOf(o), named),
      merge: (stored) => ({ text, mentions, messageId: stored.messageId ?? named.messageId }),
      after: message.messageId === null ? message.outboxOpId : null,
      noop: (merged) => typeof merged.baseBody === "string" && bodyText(merged.baseBody) === merged.text,
      local: async () => {
        // Nothing left to send (a text back to the base): the base shows again
        const left = (await this.db.getOutboxOpsForConfig(configId))
          .some((o) => o.kind === CHAT_EDIT && o.status !== "blocked" && sameTarget(targetOf(o), named));
        if (left) await this.showBody(configId, named, withEditedMark(body));
        else if (typeof baseBody === "string") await this.showBody(configId, named, baseBody);
      },
    });
  }

  /**
   * Writes an edit into the post of a message not sent yet, when that post
   * has not started: its text and mentions, the pending bubble's body, and
   * the edits waiting for it cancelled. Returns false, writing nothing
   * more, when the post is gone or started, also when it starts during the
   * write: an edit then follows it.
   */
  private async foldIntoPost(
    message: ChatMessage,
    text: string,
    mentions: Mentions,
    body: string,
    mine: OutboxOp[],
  ): Promise<boolean> {
    const post = message.outboxOpId ? await this.db.getOutboxOp(message.outboxOpId) : null;
    if (!post || postStarted(post)) return false;
    await this.outbox.setParams(post.id, { text, mentions });
    const now = await this.db.getOutboxOp(post.id);
    if (!now || postStarted(now)) return false;
    for (const o of mine) if (o.kind === CHAT_EDIT && o.status !== "running") await this.outbox.cancel(o.id);
    await this.repo.putPending({ ...message, body });
    return true;
  }

  /**
   * Queues the delete of the user's own message: its body emptied as
   * Odoo's delete does, shown at once (body ""). A message not sent yet
   * whose post has not started never reaches the server: its post, its
   * uploads and every action on it are cancelled, its row and its files
   * go (dropPendingMessage), and null is returned. Otherwise the edits and
   * reactions of the message still waiting are cancelled, and one delete
   * waits for what still runs on it (an edit, a reaction, its post). A
   * second delete returns the first. Rejects for a message not cached.
   */
  async queueDelete(configId: string, channelId: number, target: MessageTarget): Promise<OutboxOp | null> {
    const message = await this.repo.messageOf(configId, target);
    if (!message) throw new Error("The message to delete is not cached.");
    return this.exclusive(configId, async () => {
      const id = (await this.realIdOf(configId, channelId)) ?? channelId;
      const named: MessageTarget = { messageId: message.messageId, clientUuid: message.clientUuid };
      const all = await this.db.getOutboxOpsForConfig(configId);
      const post = message.messageId === null && message.outboxOpId ? all.find((o) => o.id === message.outboxOpId) ?? null : null;
      if (message.messageId === null && (!post || !postStarted(post))) {
        await this.dropPendingMessage(configId, message, all);
        return null;
      }
      const mine = all.filter((o) => MESSAGE_KINDS.includes(o.kind) && o.status !== "blocked"
        && sameTarget(targetOf(o), named));
      const queued = mine.find((o) => o.kind === CHAT_DELETE);
      if (queued) return queued;
      const baseBody = baseBodyOf(message, mine);
      const running = mine.find((o) => o.status === "running");
      for (const o of mine) if (o.status !== "running") await this.outbox.cancel(o.id);
      const op = await this.outbox.enqueue({
        noteId: CHAT_NOTE,
        configId,
        kind: CHAT_DELETE,
        params: { channelId: id, ...named, baseBody },
        dependsOn: running?.id ?? post?.id ?? null,
      });
      await this.showBody(configId, named, "");
      return op;
    });
  }

  /**
   * Forgets a message that never reached the server, as a leave forgets
   * the posts of its conversation: its post, the uploads and refused-file
   * notices of its files, and every action on it (any state) leave the
   * outbox, an upload on the wire is stopped, and the row, its reactions,
   * its file rows and their files go.
   */
  private async dropPendingMessage(configId: string, message: ChatMessage, all: OutboxOp[]): Promise<void> {
    const uuid = message.clientUuid!;
    const files = new Set((await this.repo.outgoingOf(configId, uuid)).map((r) => r.localUuid).filter((u): u is string => !!u));
    const mine = all.filter((o) => o.noteId === CHAT_NOTE && (
      o.id === message.outboxOpId
      || ((o.kind === CHAT_UPLOAD || o.kind === CHAT_FILE_REFUSED) && files.has(o.params.localUuid))
      || (MESSAGE_KINDS.includes(o.kind) && o.params.clientUuid === uuid)));
    this.stopUploads(mine);
    for (const o of mine) await this.outbox.cancel(o.id);
    await this.repo.dropQueued(configId, uuid);
    await this.dropOutgoing(configId, [...files]);
  }

  /** Shows a body on the cached message a target names: the pending row, or the server's row through a delta. */
  private async showBody(configId: string, target: MessageTarget, body: string): Promise<void> {
    const message = await this.repo.messageOf(configId, target);
    if (!message) return;
    if (message.messageId === null) await this.repo.putPending({ ...message, body });
    else {
      await this.repo.applyDelta(configId, {
        ...emptyDelta(), messages: [{ messageId: message.messageId, channelId: message.channelId, body }],
      });
    }
  }

  /** The body a queued edit shows until the server answers: the browser's HTML with the edited span. */
  private async editedBody(params: Record<string, any>): Promise<string> {
    return withEditedMark(composeBody(params.text ?? "", params.mentions ?? EMPTY_MENTIONS, await emojiConversions()).body);
  }

  /**
   * The refused edit a notice holds (« Reprendre »): returned once, its
   * notice dismissed; null for any other notice or one already taken.
   */
  async takeRefusedEdit(configId: string, noticeId: string): Promise<ChatNotice["edit"] | null> {
    const notice = (await this.notices([configId])).find((n) => n.id === noticeId);
    if (!notice?.edit) return null;
    await this.dismissNotice(configId, noticeId);
    return notice.edit;
  }

  /**
   * Leaves a conversation. On the phone at once: it is no longer a member,
   * so the list stops showing it; every other chat row of it waiting in the
   * outbox (posts, reads, actions) is cancelled, and the texts of its posts
   * turn failed. With failed texts it stays listed (leftUnsent) until the
   * user dismisses it (discardCreate). A row already running is left to
   * finish and the leave waits for it; a post that fails then, or is
   * retried, is not sent again (sendPost). A conversation whose create or
   * join never reached the server (createReached) is not left but given
   * up: that op goes with the rest, and no leave is queued unless it is a
   * direct message pinned again, which exists on the server. One that may
   * have reached it keeps its create or join, and the leave waits for it;
   * the swap keeps the conversation left (settleCreate). The files of its
   * posts are refused ("left"); an upload on the wire is cancelled and the
   * leave waits for it to stop. A second leave returns the first; returns
   * null when nothing has to reach the server.
   */
  queueLeave(configId: string, channelId: number): Promise<OutboxOp | null> {
    return this.exclusive(configId, async () => {
      const id = (await this.realIdOf(configId, channelId)) ?? channelId;
      const all = await this.db.getOutboxOpsForConfig(configId);
      const queued = all.find((o) => o.kind === CHAT_LEAVE && o.params.channelId === id && o.status !== "blocked");
      if (queued) return queued;
      const channel = await this.repo.channel(configId, id);
      const create = channel?.createOpId ? all.find((o) => o.id === channel.createOpId) ?? null : null;
      const keepCreate = create !== null && createReached(create);
      const mine = all.filter((o) => o.noteId === CHAT_NOTE && o.params.channelId === id && !(keepCreate && o.id === create!.id));
      const running = mine.find((o) => o.status === "running");
      for (const o of mine) {
        if (o.status === "running") continue;
        await this.outbox.cancel(o.id);
        if (o.kind === CHAT_POST) {
          await this.repo.failQueued(configId, o.clientUuid);
          await this.refuseFilesOf(configId, o.clientUuid, "left");
        }
        if (o.kind === CHAT_UPLOAD) await this.repo.setRefused(configId, o.params.localUuid, "left");
      }
      this.stopUploads(mine);
      // Exists on the server: a known conversation, one whose create or join may have run, a direct message pinned again
      const onServer = keepCreate || (create === null ? id > 0 : create.kind === CHAT_CREATE && id >= 0);
      const op = onServer
        ? await this.outbox.enqueue({
          noteId: CHAT_NOTE,
          configId,
          kind: CHAT_LEAVE,
          params: { channelId: id },
          dependsOn: running?.id ?? (keepCreate ? create!.id : null),
        })
        : null;
      const unsent = (await this.repo.messages(configId, id)).some((m) => m.messageId === null && m.status === "failed");
      if (!onServer && !unsent) {
        // Never on the server and nothing typed into it: nothing left to keep
        await this.repo.dropChannel(configId, id);
        return null;
      }
      await this.repo.patchChannel(configId, id, {
        isMember: false,
        localPinned: false,
        leftUnsent: unsent,
        ...(create !== null && !keepCreate ? { createOpId: null } : {}),
      });
      return op;
    });
  }

  /**
   * Lays the target states still queued (not given up) over a delta a load
   * read, so the server's older values do not undo what the phone shows
   * until the action is sent: a name or label, a description, a mute, a
   * hidden direct message, a conversation left, the account's mute. Only
   * conversations the delta carries are touched. Then the reactions
   * (overlayMessages).
   */
  async overlayPending(configId: string, delta: StoreDelta): Promise<void> {
    await this.overlayMessages(configId, delta);
    const byId = new Map(delta.channels.map((c) => [c.channelId, c]));
    for (const op of await this.db.getOutboxOpsForConfig(configId)) {
      if (op.noteId !== CHAT_NOTE || op.status === "blocked") continue;
      if (op.kind === CHAT_GLOBAL_MUTE) {
        delta.globalMuteUntil = muteDt(op.params.until ?? null);
        continue;
      }
      const c = byId.get(op.params.channelId);
      if (!c) continue;
      const type = c.channelType ?? (await this.repo.channel(configId, c.channelId))?.channelType;
      if (op.kind === CHAT_RENAME) {
        if (type === "chat") c.customChannelName = op.params.name || null;
        else c.name = op.params.name;
      } else if (op.kind === CHAT_DESCRIBE) c.description = op.params.description;
      else if (op.kind === CHAT_MUTE) c.muteUntilDt = muteDt(op.params.until ?? null);
      else if (op.kind === CHAT_HIDE) c.isPinned = false;
      else if (op.kind === CHAT_LEAVE) c.isMember = false;
    }
  }

  /**
   * Lays the reactions still queued (not given up) over the reaction
   * groups a delta carries (a load, a history page, the bus, an answer), so
   * the server's older groups do not undo what the phone shows until they
   * are sent. Per key the newest op counts: its group in the delta gains
   * or loses the user (ownReaction), and the server's state the delta
   * states for sure becomes the base of the key's ops when none was sent
   * yet; a group the user is put into and the
   * delta's full set (reactionSets) or deletion leaves out is added, after
   * the message's others; one nobody is left in becomes a deletion. Only
   * the messages whose reactions the delta carries are touched. The
   * bodies first (overlayBodies; `except`: the op whose answer the delta
   * is).
   */
  async overlayMessages(configId: string, delta: StoreDelta, except?: string): Promise<void> {
    await this.overlayBodies(configId, delta, except);
    const carried = new Set([...(delta.reactions ?? []), ...(delta.reactionSets ?? []), ...(delta.deletedReactions ?? [])]
      .map((r) => r.messageId));
    if (carried.size === 0) return;
    // Per key, in dependency order: a follow-up comes after the op it waits for
    const byKey = new Map<string, OutboxOp[]>();
    for (const op of dependencyOrder(await this.db.getOutboxOpsForConfig(configId))) {
      if (op.kind === CHAT_REACTION && op.status !== "blocked") byKey.set(targetKey(op), [...(byKey.get(targetKey(op)) ?? []), op]);
    }
    if (byKey.size === 0) return;
    const self = delta.selfPartnerId ?? (await this.repo.sourceState(configId)).selfPartnerId;
    const groups = (delta.reactions ??= []);
    for (const ops of byKey.values()) {
      const op = ops[ops.length - 1];
      const { content } = op.params;
      const messageId: number | null = op.params.messageId
        ?? (op.params.clientUuid ? (await this.repo.messageByClientUuid(configId, op.params.clientUuid))?.messageId ?? null : null);
      if (messageId === null || !carried.has(messageId)) continue;
      const on = op.params.action === "add";
      const set = delta.reactionSets?.find((r) => r.messageId === messageId);
      const named = (r: { messageId: number; content: string }) => r.messageId === messageId && r.content === content;
      const at = groups.findIndex(named);
      // What the server holds of the user's reaction, when the delta says it for sure: the base of ops none of which
      // was sent yet, so a later tap is compared with where the server stands now
      const held = at >= 0 ? groups[at].selfReacted
        : (set && !set.contents.includes(content)) || delta.deletedReactions?.some(named) ? false : null;
      if (held !== null && ops.every((o) => o.status !== "running" && !o.params.sentAt)) {
        for (const o of ops) if (!!o.params.base !== held) await this.outbox.setParams(o.id, { base: held });
      }
      if (at < 0 && (!on || (!set && !delta.deletedReactions?.some(named)))) continue;
      const next = ownReaction(at >= 0 ? groups[at] : {
        messageId,
        content,
        count: 0,
        selfReacted: false,
        partnerIds: [],
        guestCount: 0,
        sequence: Math.max(0, ...groups.filter((g) => g.messageId === messageId).map((g) => g.sequence)) + 1,
      }, on, self);
      if (at >= 0) groups.splice(at, 1);
      delta.deletedReactions = (delta.deletedReactions ?? []).filter((r) => !named(r));
      if (next) {
        groups.push(next);
        if (set && !set.contents.includes(content)) set.contents.push(content);
      } else {
        delta.deletedReactions.push({ messageId, content });
        if (set) set.contents = set.contents.filter((c) => c !== content);
      }
    }
  }

  /**
   * Lays the edits and deletes still queued (not given up) over the bodies
   * a delta carries, so the server's older body does not undo what the
   * phone shows until they are sent: per message a queued delete shows "",
   * else the newest edit its text (editedBody). An edit whose baseBody is
   * still unknown (queued while its post ran) takes the delta's body as
   * its base while that body is still the post's (postBody); a known base
   * never moves, so a browser edit read meanwhile still refuses it. `except` is left out: the op whose own answer this
   * is.
   */
  private async overlayBodies(configId: string, delta: StoreDelta, except?: string): Promise<void> {
    const carried = new Map(delta.messages.filter((m) => m.body !== undefined).map((m) => [m.messageId, m]));
    if (carried.size === 0) return;
    const ops = dependencyOrder(await this.db.getOutboxOpsForConfig(configId))
      .filter((o) => (o.kind === CHAT_EDIT || o.kind === CHAT_DELETE) && o.status !== "blocked" && o.id !== except);
    const shown = new Map<number, OutboxOp>();
    for (const op of ops) {
      const messageId: number | null = op.params.messageId
        ?? (op.params.clientUuid ? (await this.repo.messageByClientUuid(configId, op.params.clientUuid))?.messageId ?? null : null);
      const m = messageId === null ? undefined : carried.get(messageId);
      if (!m || shown.get(messageId!)?.kind === CHAT_DELETE) continue;
      if (op.kind === CHAT_EDIT && op.params.baseBody == null && postBody(op, m.body!)) {
        await this.outbox.setParams(op.id, { baseBody: m.body });
      }
      shown.set(messageId!, op);
    }
    for (const [messageId, op] of shown) {
      carried.get(messageId)!.body = op.kind === CHAT_DELETE ? "" : await this.editedBody(op.params);
    }
  }

  /** The actions of the given accounts the outbox gave up on, oldest first, until dismissed. */
  async notices(configIds: string[]): Promise<ChatNotice[]> {
    const out: ChatNotice[] = [];
    for (const configId of configIds) {
      for (const o of await this.db.getOutboxOpsForConfig(configId)) {
        if (o.status !== "blocked" || !NOTICE_KINDS.includes(o.kind)) continue;
        if (o.kind === CHAT_FILE_REFUSED) {
          out.push({
            id: o.id,
            configId,
            kind: o.kind,
            channelId: o.params.channelId ?? null,
            reason: "refused",
            error: "",
            count: 1,
            label: "",
            file: { name: o.params.name ?? "", reason: o.params.reason, limit: o.params.limit ?? null },
          });
          continue;
        }
        const blocked = o.params.blockedReason;
        const reason = blocked === "vanished" || blocked === "changed" ? blocked : "refused";
        out.push({
          id: o.id,
          configId,
          kind: o.kind,
          channelId: o.params.channelId ?? null,
          reason,
          error: reason === "refused" ? (o.lastError ?? "") : "",
          count: o.params.count ?? 1,
          label: o.params.label ?? "",
          ...(MESSAGE_KINDS.includes(o.kind)
            ? { message: targetOf(o) }
            : {}),
          ...(o.kind === CHAT_EDIT && reason === "changed"
            ? {
              edit: {
                target: targetOf(o),
                text: o.params.text ?? "",
                mentions: o.params.mentions ?? EMPTY_MENTIONS,
                deleted: o.params.conflict === "deleted",
              },
            }
            : {}),
        });
      }
    }
    return out;
  }

  /** Dismisses a notice: its outbox row goes, and for a refused file its row and file. */
  async dismissNotice(configId: string, id: string): Promise<void> {
    const op = await this.db.getOutboxOp(id);
    if (!op || op.configId !== configId || op.status !== "blocked" || !NOTICE_KINDS.includes(op.kind)) return;
    await this.outbox.cancel(id);
    if (op.kind === CHAT_FILE_REFUSED && op.params.localUuid) await this.dropOutgoing(configId, [op.params.localUuid]);
  }

  /**
   * A create or join the server refused: every chat row of the account
   * naming the conversation leaves the outbox (the op and what waits for
   * it), and the conversation stays listed as failed (createFailed), its
   * texts kept as failed messages, until the user dismisses it
   * (discardCreate). A direct message pinned again is a conversation that
   * exists: it is only unpinned again, and its posts still go to it.
   */
  failCreate(configId: string, channelId: number): Promise<void> {
    return this.exclusive(configId, async () => {
      const channel = await this.repo.channel(configId, channelId);
      if (channelId >= 0 && channel?.channelType === "chat") {
        if (channel.createOpId) await this.outbox.cancel(channel.createOpId);
        await this.repo.patchChannel(configId, channelId, { isPinned: false, createOpId: null });
        return;
      }
      await this.dropChannels(configId, [channelId]);
      await this.repo.failPending(configId, channelId);
      await this.repo.patchChannel(configId, channelId, { createOpId: null, createFailed: true });
    });
  }

  /**
   * The user gives up a conversation still being created or joined, or
   * dismisses one the server refused: its rows leave the outbox, and the
   * conversation goes from the cache with its unsent texts. A direct
   * message pinned again keeps its history and is only unpinned again. A
   * conversation left with texts unsent (leftUnsent) goes with them; its
   * leave stays queued.
   */
  discardCreate(configId: string, channelId: number): Promise<void> {
    return this.exclusive(configId, async () => {
      const channel = await this.repo.channel(configId, channelId);
      if (channel?.leftUnsent) {
        await this.repo.dropChannel(configId, channelId);
        return;
      }
      if (!channel || (!channel.createOpId && !channel.createFailed)) return;
      if (channelId >= 0 && channel.channelType === "chat") {
        if (channel.createOpId) await this.outbox.cancel(channel.createOpId);
        await this.repo.patchChannel(configId, channelId, { isPinned: false, createOpId: null });
        return;
      }
      await this.dropChannels(configId, [channelId]);
      await this.repo.dropChannel(configId, channelId);
    });
  }

  /**
   * At startup: a create or join stored "incomplete" was cut between its op
   * and its row. With the row written (its createOpId names the op) it is
   * queued; without it, it is removed. A post with files cut while being
   * queued is queued with its uploads when its message was written, else
   * removed with them, its rows and files; the files it took from the
   * conversation's draft go back to the draft instead, with its text
   * (joinDraftText, ahead of what the draft holds) unless the draft holds
   * it already (draftText), and a staged file a draft row still names is never
   * deleted. An incomplete upload no post waits for is removed. A post
   * that goes (its message stored, or queued as a text before it) has its
   * draftText removed from the draft (a kill between the two), unless the
   * draft was stored after the post. Returns how many were queued.
   */
  async recoverIncomplete(): Promise<number> {
    let queued = 0;
    for (const configId of await this.db.getLiveSyncConfigIds()) {
      const all = await this.db.getOutboxOpsForConfig(configId);
      const byId = new Map(all.map((o) => [o.id, o]));
      const kept = new Set<string>();
      const pending = new Set([...(await this.repo.pendingMessages(configId)).values()].flat().map((m) => m.clientUuid));
      for (const post of all.filter((o) => o.kind === CHAT_POST && o.status === "incomplete")) {
        const chain: OutboxOp[] = [];
        for (let up = post.dependsOn ? byId.get(post.dependsOn) : undefined; up?.kind === CHAT_UPLOAD && up.status === "incomplete";
          up = up.dependsOn ? byId.get(up.dependsOn) : undefined) chain.push(up);
        chain.forEach((up) => kept.add(up.id));
        if (pending.has(post.clientUuid)) {
          for (const op of [...chain.reverse(), post]) await this.outbox.complete(op.id, {});
          queued++;
        } else {
          for (const op of [...chain, post]) await this.outbox.cancel(op.id);
          const drafted = new Set<string>(post.params.drafts ?? []);
          const rows = (await this.repo.outgoingOf(configId, post.clientUuid)).map((r) => r.localUuid!);
          await this.repo.backToDraft(configId, rows.filter((u) => drafted.has(u)));
          await this.dropOutgoing(configId, rows.filter((u) => !drafted.has(u)));
          // A text the composer sent is still the draft's: only another one is given back
          if (drafted.size > 0 && post.params.text && typeof post.params.draftText !== "string") {
            // The post's text is older than what the draft holds now
            const channelId: number = post.params.channelId;
            const held = (await this.repo.draftOf(configId, channelId)).text;
            await this.repo.putDraftText(configId, channelId, joinDraftText(post.params.text, held));
          }
          // Cut before its rows: the uploads' params still name the staged files
          await this.removeFiles(await this.notDrafts(configId, chain.map((up) => up.params)));
        }
      }
      for (const up of all.filter((o) => o.kind === CHAT_UPLOAD && o.status === "incomplete" && !kept.has(o.id))) {
        await this.outbox.cancel(up.id);
        await this.removeFiles(await this.notDrafts(configId, [up.params]));
      }
      // A post that goes (its message stored, or a text queued before its bubble) whose text a kill left in the draft;
      // a draft stored after the post is the same text typed again
      const stored = await this.repo.queuedMessageUuids(configId);
      for (const op of await this.db.getOutboxOpsForConfig(configId)) {
        if (op.kind !== CHAT_POST || (!stored.has(op.clientUuid) && op.status === "incomplete")) continue;
        await this.releaseDraftText(configId, op.params.channelId, op.params.draftText, op.createdAt);
      }
      for (const op of all) {
        if (op.status !== "incomplete" || (op.kind !== CHAT_CREATE && op.kind !== CHAT_JOIN)) continue;
        const channel = await this.repo.channel(configId, op.params.channelId);
        if (channel?.createOpId === op.id) {
          await this.outbox.complete(op.id, {});
          queued++;
        } else {
          await this.outbox.cancel(op.id);
        }
      }
    }
    return queued;
  }

  /**
   * Drains the chat rows of the server the credentials open, then starts
   * its uploads beside them (pumpUploads) without waiting for them: a long
   * upload holds its own post and the posts after it in its conversation,
   * nothing else. A server with no live application has nothing to send
   * to: its rows are left as they are and the call completes. The result
   * counts the drain only; each upload that ends tells the screens
   * (changed) and flushes the account again.
   */
  async flush(creds: SyncCredentials, opts: { force?: boolean } = {}): Promise<DrainResult> {
    const configId = syncConfigIdFor(creds.odooUrl, creds.username, creds.database);
    if (!(await this.db.getLiveSyncConfigIds()).has(configId)) {
      return { done: 0, failed: 0, blocked: 0, held: 0, errors: [] };
    }
    const result = await this.outbox.drain(creds, configId, {
      force: opts.force, onlyNoteIds: new Set([CHAT_NOTE]), skipKinds: LANE_KINDS,
    });
    this.pumpUploads(creds, configId, !!opts.force);
    return result;
  }

  /** Runs `work` as part of the account's lane, so whenIdle waits for it. */
  private laneTrack<T>(configId: string, work: Promise<T>): Promise<T> {
    let set = this.laneWork.get(configId);
    if (!set) this.laneWork.set(configId, (set = new Set()));
    const tracked = set;
    tracked.add(work);
    void work.then(() => undefined, () => undefined).then(() => {
      tracked.delete(work);
      if (tracked.size === 0 && this.laneWork.get(configId) === tracked) this.laneWork.delete(configId);
    });
    return work;
  }

  /**
   * Starts the account's due upload ops whose dependency is done (see
   * OutboxService.isDue; force skips the retry delays), oldest first, up
   * to CHAT_UPLOADS_AT_ONCE running at once; none while the account is
   * paused (pauseUploads). Not awaited by flush.
   *
   * Twins are ordered: uploads the search after a lost answer
   * (findUploaded) cannot tell apart, as it could find either one's
   * attachment. Twins have the same name, and the same size unless either
   * one is looked for by name alone (foundByNameAlone). A running twin
   * holds every other; a twin with no send yet waits while any twin holds
   * a send that may have reached the server (uploadSentAt), so its own
   * attachment never exists while that one is in doubt; among twins in
   * doubt the earliest uploadSentAt (then the op id) goes first. The
   * first in that order always may start, so none waits forever.
   */
  private pumpUploads(creds: SyncCredentials, configId: string, force: boolean): void {
    this.laneTrack(configId, this.pumpNow(creds, configId, force)).catch((e) => console.warn("chat: upload lane failed", e));
  }

  private async pumpNow(creds: SyncCredentials, configId: string, force: boolean): Promise<void> {
    const ops = await this.db.getOutboxOpsForConfig(configId);
    const pendingIds = new Set(ops.map((o) => o.id));
    let running = this.lane.get(configId);
    if (!running) this.lane.set(configId, (running = new Set()));
    const startable = (o: OutboxOp) => !(o.dependsOn && pendingIds.has(o.dependsOn)) && this.outbox.isDue(o, force);
    const twin = (o: OutboxOp, op: OutboxOp) => o.id !== op.id && o.kind === CHAT_UPLOAD
      && o.params.name === op.params.name
      && (o.params.size === op.params.size || foundByNameAlone(o) || foundByNameAlone(op));
    const doubtBefore = (o: OutboxOp, op: OutboxOp) => !!o.params.uploadSentAt
      && (!op.params.uploadSentAt || o.params.uploadSentAt < op.params.uploadSentAt
        || (o.params.uploadSentAt === op.params.uploadSentAt && o.id < op.id));
    const heldByTwin = (op: OutboxOp) => ops.some((o) => twin(o, op) && (running.has(o.id) || doubtBefore(o, op)));
    // No await from here on: two pumps never start the same op or pass the cap
    if (this.paused.has(configId)) return;
    for (const op of dependencyOrder(ops)) {
      if (running.size >= CHAT_UPLOADS_AT_ONCE) return;
      if (op.kind !== CHAT_UPLOAD || op.noteId !== CHAT_NOTE || running.has(op.id)) continue;
      if (!startable(op) || heldByTwin(op)) continue;
      running.add(op.id);
      this.laneTrack(configId, this.laneRun(creds, op, running)).catch((e) => console.warn("chat: upload lane failed", e));
    }
  }

  /**
   * One upload of the lane. Done (sent or refused), the account is flushed
   * again: its post, or the next upload, may run now. Failed, the lane
   * looks for other due uploads. Held, nothing follows: the next flush
   * tries again.
   */
  private async laneRun(creds: SyncCredentials, op: OutboxOp, running: Set<string>): Promise<void> {
    let outcome: "done" | "held" | "failed" = "done";
    try {
      await this.runUpload(creds, op);
    } catch (e: unknown) {
      outcome = e instanceof OutboxHeldError ? "held" : "failed";
    } finally {
      running.delete(op.id);
    }
    this.changed(op.configId, op.params.channelId ?? null);
    if (outcome === "done") {
      this.laneTrack(op.configId, this.flush(creds)).catch((e) => console.warn("chat: flush after an upload failed", e));
    } else if (outcome === "failed") {
      this.pumpUploads(creds, op.configId, false);
    }
  }

  /** Resolves once no upload runs for the account (for every account without one), the flushes they started included. */
  async whenIdle(configId?: string): Promise<void> {
    for (;;) {
      const busy = [...this.laneWork.entries()]
        .filter(([id]) => configId === undefined || id === configId)
        .flatMap(([, set]) => [...set]);
      if (busy.length === 0) return;
      await Promise.allSettled(busy);
    }
  }

  /** Bytes of the file sent so far while its upload is on the wire, else null. */
  uploadProgress(localUuid: string): { done: number; total: number } | null {
    for (const p of this.progress.values()) {
      if (p.localUuid === localUuid) return { done: p.done, total: p.total };
    }
    return null;
  }

  /**
   * The transport's progress events (ChatHttp.onProgress) behind
   * uploadProgress; subscribed at the first upload, the previous source
   * unsubscribed.
   */
  setProgressSource(source: ((fn: (p: TransferProgress) => void) => () => void) | null): void {
    this.progressOff?.();
    this.progressOff = null;
    this.progressSource = source;
  }

  private watchProgress(): void {
    if (this.progressOff || !this.progressSource) return;
    this.progressOff = this.progressSource((p) => {
      const known = this.progress.get(p.id);
      if (known) this.progress.set(p.id, { ...known, done: p.done, total: p.total ?? known.total });
    });
  }

  /** Posts of the account still in the outbox, failed and blocked ones included. */
  async pendingPostCount(configId: string): Promise<number> {
    return (await this.db.getOutboxOpsForConfig(configId)).filter((o) => o.kind === CHAT_POST).length;
  }

  /** Files of the account still to be uploaded (their ops, failed ones included). */
  async pendingUploadCount(configId: string): Promise<number> {
    return (await this.db.getOutboxOpsForConfig(configId)).filter((o) => o.kind === CHAT_UPLOAD).length;
  }

  /**
   * Stops the uploads among `ops` that run now: the transfer on the wire
   * is cancelled, one not started yet never starts. The op then ends as
   * sendUpload decides (refused "left" for a conversation being left).
   */
  private stopUploads(ops: OutboxOp[]): void {
    for (const op of ops) {
      if (op.kind !== CHAT_UPLOAD || op.status !== "running") continue;
      const transferId = this.transfers.get(op.id);
      if (transferId && this.transfer) {
        this.transfer.cancel(transferId).catch((e) => console.warn("chat: upload cancel failed", e));
      } else {
        this.stopped.add(op.id);
      }
    }
  }

  /** Refuses (`reason`) the files of a post still to be sent. */
  private async refuseFilesOf(configId: string, postClientUuid: string, reason: string): Promise<void> {
    for (const row of await this.repo.outgoingOf(configId, postClientUuid)) {
      if (row.localUuid && (row.state === "queued" || row.state === "uploaded")) await this.repo.setRefused(configId, row.localUuid, reason);
    }
  }

  /** Removes the chat rows of the given channels from the outbox, posts and reads alike; their uploads stop. */
  async dropChannels(configId: string, channelIds: number[]): Promise<void> {
    const gone = new Set(channelIds);
    const mine = (await this.db.getOutboxOpsForConfig(configId)).filter((op) => op.noteId === CHAT_NOTE && gone.has(op.params.channelId));
    this.stopUploads(mine);
    for (const op of mine) await this.outbox.cancel(op.id);
  }

  /**
   * The server took these conversations away (a leave or a delete from the
   * bus): their rows leave the outbox as dropChannels does. When the user
   * still had actions waiting for one (USER_ACTIONS, queued or given up as
   * notices), one notice per conversation (CHAT_DROPPED, blocked) says how
   * many were cancelled (one per targetKey, whatever the number of ops),
   * its count added to the one such a notice already
   * held; it stays until dismissed.
   */
  async dropTaken(configId: string, channelIds: number[]): Promise<void> {
    const ops = await this.db.getOutboxOpsForConfig(configId);
    for (const channelId of channelIds) {
      const mine = ops.filter((o) => o.noteId === CHAT_NOTE && o.params.channelId === channelId);
      this.stopUploads(mine);
      // One action per key (per person for a removal, per message and emoji for a reaction), however many ops of it
      // wait: a follow-up behind a running one, a notice
      const actions = new Set(mine.filter((o) => USER_ACTIONS.has(o.kind)).map(targetKey));
      const count = actions.size + mine.reduce((n, o) => n + (o.kind === CHAT_DROPPED ? (o.params.count ?? 0) : 0), 0);
      for (const o of mine) await this.outbox.cancel(o.id);
      if (count === 0) continue;
      const channel = await this.repo.channel(configId, channelId);
      const earlier = mine.find((o) => o.kind === CHAT_DROPPED)?.params.label ?? "";
      const notice = await this.outbox.enqueue({
        noteId: CHAT_NOTE,
        configId,
        kind: CHAT_DROPPED,
        params: { channelId, count, label: channel ? (channel.customChannelName || channel.name) : earlier },
      });
      await this.db.updateOutboxOp(notice.id, {
        status: "blocked",
        lastError: `${count} actions of conversation ${channelId} cancelled: the server took it away.`,
        params: { ...notice.params, blockedReason: "vanished", candidates: [] },
        updatedAt: this.now().toISOString(),
      });
    }
  }

  /**
   * Pauses the lanes of these config ids: no upload starts under them
   * until as many resumeUploads named them, whoever pumps. Their running uploads stop; the
   * call resolves once the lanes settled, which waits for no other
   * upload. A stopped upload ends failed, its send kept in doubt
   * (uploadSentAt), so its retry looks for what that send made. The ops
   * stay in the outbox.
   */
  async pauseUploads(configIds: string[]): Promise<void> {
    for (const id of configIds) this.paused.set(id, (this.paused.get(id) ?? 0) + 1);
    for (const id of configIds) {
      this.stopUploads((await this.db.getOutboxOpsForConfig(id)).filter((op) => op.noteId === CHAT_NOTE));
    }
    for (const id of configIds) await this.whenIdle(id);
  }

  /**
   * Ends one pauseUploads of these config ids: a lane no other pause holds
   * starts uploads again, at the next flush.
   */
  resumeUploads(configIds: string[]): void {
    for (const id of configIds) {
      const left = (this.paused.get(id) ?? 0) - 1;
      if (left > 0) this.paused.set(id, left);
      else this.paused.delete(id);
    }
  }

  /** Removes every chat row of the account from the outbox, posts and reads alike; its uploads stop. */
  async dropAll(configId: string): Promise<void> {
    const mine = (await this.db.getOutboxOpsForConfig(configId)).filter((op) => op.noteId === CHAT_NOTE);
    this.stopUploads(mine);
    for (const op of mine) await this.outbox.cancel(op.id);
  }

  private runPost(creds: SyncCredentials, op: OutboxOp): Promise<void> {
    return this.outbox.attempt(op.id, (running) => this.sendPost(creds, running));
  }

  /**
   * The stamp of the op's last send that may have reached the server, once
   * its quiet window is over; throws OutboxRetryLaterError inside it.
   */
  private async quietStamp(creds: SyncCredentials, op: OutboxOp): Promise<string | undefined> {
    let sentAt: string | undefined = op.params.createSentAt ?? undefined;
    if (sentAt && new Date(sentAt).getTime() > this.now().getTime()) {
      // Stored under a clock that ran fast: the window restarts once, now
      sentAt = this.now().toISOString();
      await this.outbox.setParams(op.id, { createSentAt: sentAt });
    }
    if (sentAt) {
      const quietUntil = new Date(new Date(sentAt).getTime() + CREATE_QUIET_WINDOW_MS);
      if (quietUntil.getTime() > this.now().getTime()) {
        throw new OutboxRetryLaterError(
          `The previous send may still be running on ${creds.odooUrl}; retry after ${quietUntil.toISOString()}.`,
          quietUntil.toISOString(),
        );
      }
    }
    return sentAt;
  }

  /**
   * Posts the text with the files its uploads left "uploaded", in pick
   * order: post_data.attachment_ids and a top-level attachment_tokens of
   * the same length (false each: an internal user's pending attachments
   * carry no token). A file still queued holds the post (a plain error,
   * retried); a refused one is left out. With no text and no file left the
   * message fails and the op ends. A refusal of a post with files, before
   * any re-upload, asks the server which ids it still holds
   * (reuploadVanished): the missing ones are uploaded again once, chained
   * before the post, and the post waits for them. Any other refusal blocks
   * it as for a text.
   *
   * The body, partner_ids and special_mentions come from one composeBody
   * of the text and its picks, so the anchors and the people notified
   * always agree; each list goes only when non-empty, as the browser does.
   * parent_id is the parent's server id at this send (parentIdOf), left
   * out without one.
   */
  private async sendPost(creds: SyncCredentials, op: OutboxOp): Promise<void> {
    const { channelId, text } = op.params;
    if (await this.leaving(op.configId, channelId)) {
      // Left while this post was on the wire or waiting for its retry: never sent after the leave
      await this.repo.failQueued(op.configId, op.clientUuid);
      await this.refuseFilesOf(op.configId, op.clientUuid, "left");
      await this.repo.patchChannel(op.configId, channelId, { leftUnsent: true });
      this.changed(op.configId, channelId);
      return;
    }
    const useModule = !!op.params.useModule;
    const withFiles = (op.params.files ?? []).length > 0;
    const rows = withFiles ? await this.repo.outgoingOf(op.configId, op.clientUuid) : [];
    if (rows.some((r) => r.state === "queued")) {
      if (await this.requeueOrphans(op, rows)) {
        throw new OutboxRetryLaterError(`Files of ${op.clientUuid} wait for their upload again.`, this.now().toISOString());
      }
      throw new Error("A file of the post is still to be uploaded.");
    }
    const ids = rows.filter((r) => r.state === "uploaded" && r.attachmentId !== null).map((r) => r.attachmentId!);
    if (withFiles && ids.length === 0 && !String(text ?? "").trim()) {
      // Every file refused and no text: nothing is left to post
      await this.repo.failQueued(op.configId, op.clientUuid);
      this.changed(op.configId, channelId);
      return;
    }
    // Built before any stamp: a conversion chunk that fails to load is a plain retry, never a possible send
    const composed = composeBody(text, op.params.mentions ?? EMPTY_MENTIONS, await emojiConversions());
    const body = composed.body + chatMarker(op.clientUuid);
    const parentId = await this.parentIdOf(op.configId, op.params.parent);
    const sentAt = await this.quietStamp(creds, op);

    let messageId: number | null = null;
    let result: any = null;
    try {
      if (!(await this.isOnline())) throw new RequestNotSentError("Offline: the post waits for the network.");
      const found = op.attempts > 1 ? await this.findSent(creds, op) : null;
      if (found) {
        messageId = found.id;
        // The body the server holds, so the message settles on it and not on the pending one
        result = { "mail.message": [{ id: found.id, body: found.body, thread: { id: channelId, model: CHANNEL_MODEL } }] };
      }
      if (messageId === null) {
        await this.outbox.setParams(op.id, { createSentAt: this.now().toISOString() });
        const postData: Record<string, any> = {
          body,
          message_type: "comment",
          subtype_xmlid: "mail.mt_comment",
        };
        if (useModule) postData.erplibre_client_uuid = op.clientUuid;
        if (ids.length > 0) postData.attachment_ids = ids;
        if (composed.partnerIds.length > 0) postData.partner_ids = composed.partnerIds;
        if (composed.specialMentions.length > 0) postData.special_mentions = composed.specialMentions;
        if (parentId !== null) postData.parent_id = parentId;
        result = await this.rpc.callWithAuth(creds, (sessionId) =>
          this.rpc.jsonRoute(creds.odooUrl, sessionId, "/mail/message/post", {
            thread_model: CHANNEL_MODEL,
            thread_id: channelId,
            post_data: postData,
            ...(ids.length > 0 ? { attachment_tokens: ids.map(() => false) } : {}),
            context: { temporary_id: op.clientUuid },
          }));
        const id = result?.["mail.message"]?.[0]?.id;
        if (typeof id !== "number") {
          // The server may have posted: a retry finds the message by its marker
          throw new Error("The post answer holds no message id.");
        }
        messageId = id;
      }
    } catch (e: unknown) {
      if (e instanceof RequestNotSentError) {
        // Nothing of this attempt reached the server: the stamp goes back to the earlier one, whose window is over
        await this.outbox.setParams(op.id, { createSentAt: sentAt ?? null });
        throw e;
      }
      if ((isRefused(e) || e instanceof OutboxBlockedError) && (await this.leaving(op.configId, channelId))) {
        // Given up while the user leaves: done, not blocked, so the leave behind it runs
        await this.repo.failQueued(op.configId, op.clientUuid);
        await this.repo.patchChannel(op.configId, channelId, { leftUnsent: true });
        this.changed(op.configId, channelId);
        return;
      }
      if (!isRefused(e)) throw e;
      if (ids.length > 0 && !op.params.reuploaded && (await this.reuploadVanished(creds, op, rows, ids))) {
        throw new OutboxRetryLaterError(`Files of ${op.clientUuid} are uploaded again before the post.`, this.now().toISOString());
      }
      // Refused for good: the quiet window must not hold a later manual retry
      await this.outbox.setParams(op.id, { createSentAt: null });
      await this.repo.markFailed(op.configId, op.clientUuid, (e as Error).message);
      throw new OutboxBlockedError((e as Error).message, "refused", [], op.kind, op.id);
    }

    await this.settle(op, messageId, result);
  }

  /**
   * Queued rows of a post that no upload op names (a cut between a row put
   * back in the queue and its new op) get one, chained before the post
   * behind what it waited for. Returns whether any was made.
   */
  private async requeueOrphans(op: OutboxOp, rows: ChatAttachment[]): Promise<boolean> {
    const ops = await this.db.getOutboxOpsForConfig(op.configId);
    const named = new Set(ops.filter((o) => o.kind === CHAT_UPLOAD).map((o) => o.params.localUuid));
    const orphans = rows.filter((r) => r.state === "queued" && r.localUuid && !named.has(r.localUuid));
    if (orphans.length === 0) return false;
    let previous = (await this.db.getOutboxOp(op.id))?.dependsOn ?? null;
    for (const r of orphans) previous = (await this.enqueueUpload(op, r, previous)).id;
    await this.db.updateOutboxOp(op.id, { dependsOn: previous, updatedAt: this.now().toISOString() });
    return true;
  }

  /** A new upload op for the row of a post's file, after `dependsOn`; its size is the file's on the phone. */
  private async enqueueUpload(op: OutboxOp, r: ChatAttachment, dependsOn: string | null): Promise<OutboxOp> {
    const path = r.originalPath ?? "";
    const size = (path ? await this.files.size(path) : null) ?? r.size;
    const file: OutgoingFile = { localUuid: r.localUuid!, path, name: r.name, mimetype: r.mimetype, size, voice: r.voice };
    return this.outbox.enqueue({
      noteId: CHAT_NOTE,
      configId: op.configId,
      kind: CHAT_UPLOAD,
      params: this.uploadParams(op.params.channelId, file, !!op.params.idempotentUpload),
      dependsOn,
    });
  }

  /**
   * After a refused post: the ids the server no longer holds (a pending
   * attachment collected by Odoo's daily clean-up, deleted meanwhile) are
   * queued for upload again, their rows back to "queued", the new upload
   * ops chained before the post; the post is marked reuploaded (once only)
   * and its send stamp cleared, the refusal proving nothing was posted.
   * Returns false when every id is still there.
   */
  private async reuploadVanished(creds: SyncCredentials, op: OutboxOp, rows: ChatAttachment[], ids: number[]): Promise<boolean> {
    const held = new Set((await this.rpc.searchRead<{ id: number }>(creds, "ir.attachment", [["id", "in", ids]], ["id"]))
      .map((a) => a.id));
    const gone = rows.filter((r) => r.state === "uploaded" && r.attachmentId !== null && !held.has(r.attachmentId) && r.localUuid);
    if (gone.length === 0) return false;
    let previous: string | null = null;
    for (const r of gone) {
      await this.repo.requeueUpload(op.configId, r.localUuid!);
      previous = (await this.enqueueUpload(op, r, previous)).id;
    }
    await this.db.updateOutboxOp(op.id, { dependsOn: previous, updatedAt: this.now().toISOString() });
    await this.outbox.setParams(op.id, { reuploaded: true, createSentAt: null });
    return true;
  }

  /**
   * The id and body of the user's own message in the channel that carries
   * this op's marker comment exactly, or null. The search is by author and the hit is
   * checked on the whole comment, so another member's message that quotes
   * the uuid is never taken for the post. Two hits block the op.
   */
  private async findSent(creds: SyncCredentials, op: OutboxOp): Promise<{ id: number; body: string } | null> {
    const partnerId = (await this.rpc.sessionInfo(creds)).partnerId;
    if (!partnerId) throw new Error("The author partner of the session is unknown.");
    const found = (await this.rpc.searchRead<{ id: number; body: string }>(
      creds,
      "mail.message",
      [
        ["model", "=", CHANNEL_MODEL],
        ["res_id", "=", op.params.channelId],
        ["author_id", "=", partnerId],
        ["body", "ilike", clientMarker(op.clientUuid)],
      ],
      ["id", "body"],
      { limit: 2 },
    )).filter((m) => bodyHasMarker(m.body ?? "", op.clientUuid));
    if (found.length > 1) {
      throw new OutboxBlockedError(
        `Two messages carry the marker of ${op.clientUuid}.`,
        "ambiguous",
        found.map((m) => m.id),
        op.kind,
        op.id,
      );
    }
    return found.length === 1 ? { id: found[0].id, body: found[0].body ?? "" } : null;
  }

  /**
   * Gives the pending message its server id, applies the Store the post
   * answered, and marks the channel read for its author as Odoo does on a
   * post, unless a newer message is already known. The answer's
   * `parentMessage` is the message's parent: false (a parent the server
   * did not find in the channel) gives a plain message, no notice. An
   * answer without it (a post found by its marker) keeps the parent the
   * pending row named. Runs in the account's queue of counter writers
   * (serial). An op no longer stored (its account was erased while the
   * post was on the wire) writes nothing.
   */
  private settle(op: OutboxOp, messageId: number, result: any): Promise<void> {
    return this.serial(op.configId, () => this.settleNow(op, messageId, result));
  }

  private async settleNow(op: OutboxOp, messageId: number, result: any): Promise<void> {
    const { configId } = op;
    if (!(await this.db.getOutboxOp(op.id))) return;
    let parentId: number | null | undefined;
    if (result) {
      const self = (await this.repo.sourceState(configId)).selfPartnerId;
      const delta = parseStore(result, configId, self);
      parentId = delta.messages.find((m) => m.messageId === messageId)?.parentId;
      await this.repo.applyDelta(configId, delta);
    }
    await this.repo.settlePending(configId, op.clientUuid, messageId, parentId !== undefined ? { parentId } : {});
    await this.showQueuedBody(configId, op.clientUuid, messageId);
    if ((op.params.files ?? []).length > 0) await this.keepSentFiles(configId, op.clientUuid, messageId);
    const channel = await this.repo.channel(configId, op.params.channelId);
    if (!channel) return;
    const patch: Record<string, number | null> = {
      seenMessageId: Math.max(channel.seenMessageId ?? 0, messageId),
    };
    if (!channel.lastMessageId || channel.lastMessageId <= messageId) {
      patch.unreadCounter = 0;
      patch.newMessageSeparator = Math.max(channel.newMessageSeparator ?? 0, messageId + 1);
    }
    await this.repo.patchChannel(configId, channel.channelId, patch);
  }

  /**
   * After a post settled: the edit or delete queued while it ran shows
   * again over the server's body (overlayBodies), and an edit takes that
   * body as its base.
   */
  private async showQueuedBody(configId: string, clientUuid: string, messageId: number): Promise<void> {
    const queued = (await this.db.getOutboxOpsForConfig(configId))
      .some((o) => (o.kind === CHAT_EDIT || o.kind === CHAT_DELETE) && o.params.clientUuid === clientUuid);
    const row = queued ? await this.repo.message(configId, messageId) : null;
    if (!row) return;
    const delta: StoreDelta = { ...emptyDelta(), messages: [{ messageId, body: row.body }] };
    await this.overlayBodies(configId, delta);
    await this.repo.applyDelta(configId, delta);
  }

  /**
   * The uploaded files of a settled post become the message's attachments
   * (ChatRepository.adoptOutgoing) and the conversation's cached originals:
   * each file moves from out/<localUuid>/ to files/<attachmentId>/, so the
   * sender never downloads its own file. A file that cannot be moved stays
   * where it is, still recorded as the original.
   */
  private async keepSentFiles(configId: string, postClientUuid: string, messageId: number): Promise<void> {
    const fileDir = await this.repo.fileDirOf(configId);
    for (const a of await this.repo.adoptOutgoing(configId, postClientUuid, messageId)) {
      if (!a.originalPath || a.attachmentId === null) continue;
      const kept = originalFilePath(fileDir, a.attachmentId, a.name);
      if (a.originalPath === kept) continue;
      try {
        await this.files.rename(a.originalPath, kept);
        await this.repo.setOriginal(configId, a.attachmentId, kept, a.originalBytes);
        if (a.originalPath.includes("/out/")) await this.files.removeDir(a.originalPath.slice(0, a.originalPath.lastIndexOf("/")));
      } catch (e: unknown) {
        console.warn("chat: a sent file stays in the outgoing directory", e);
      }
    }
  }

  private runUpload(creds: SyncCredentials, op: OutboxOp): Promise<void> {
    return this.outbox.attempt(op.id, (running) => this.sendUpload(creds, running))
      .finally(() => this.stopped.delete(op.id));
  }

  /**
   * Uploads one file of a post as a pending attachment of its channel, in
   * this order: a conversation being left refuses the file ("left"); Wi-Fi
   * only and off Wi-Fi holds the op (OutboxHeldError: no attempt, no
   * delay); offline waits for the network; a file no longer on the phone
   * ("missing") or over the session's limit with UPLOAD_SLACK_BYTES
   * ("too_big") is refused without a request. Then, with the module
   * (useModule), the module route with the op's client uuid: a retry gets
   * the attachment the first send made. Without it, a retry after a send
   * that may have reached the server (uploadSentAt) waits
   * CREATE_QUIET_WINDOW_MS after that send ended (uploadEndedAt, or
   * uploadSentAt when the app died during it), then looks for the
   * attachment that send made (findUploaded) and takes it; none found, it
   * uploads again (a pending upload left behind is collected by Odoo within
   * a day). uploadSentAt is stamped at the first send; a send that never
   * reached the server (RequestNotSentError) gives it back, any other
   * failure stamps uploadEndedAt. A 413 refuses the file ("too_big", no
   * limit known), a refusal of the route with its reason; a refused file
   * gets a CHAT_FILE_REFUSED notice and the op ends, so the post goes
   * without it. Success records the server's attachment on the row
   * (ChatRepository.setUploaded).
   */
  private async sendUpload(creds: SyncCredentials, op: OutboxOp): Promise<void> {
    const { configId } = op;
    const { channelId, localUuid, path, name, mimetype, size } = op.params;
    // Run again after its outcome was written (a kill before the op went): nothing is left to do
    const row = await this.repo.outgoingFile(configId, localUuid);
    if (!row || row.state === "refused" || (row.state === "uploaded" && row.attachmentId !== null)) return;
    if (await this.leaving(configId, channelId)) return this.refuseLeft(op);
    if (attachmentSettings().wifiOnly && !(await this.onWifi())) {
      await this.outbox.setParams(op.id, { heldFor: "wifi" });
      throw new OutboxHeldError("Wi-Fi only: the file waits for Wi-Fi.", "wifi");
    }
    if (!(await this.isOnline())) throw new RequestNotSentError("Offline: the file waits for the network.");
    if ((await this.files.size(path)) === null) return this.refuseFile(op, "missing");
    const { maxUploadSize } = await this.rpc.sessionInfo(creds);
    if (size + UPLOAD_SLACK_BYTES > maxUploadSize) return this.refuseFile(op, "too_big", maxUploadSize);
    const transfer = this.transfer;
    if (!transfer) throw new Error("No file transfer is set up.");

    const useModule = !!op.params.useModule;
    const firstSend = !op.params.uploadSentAt;
    let sending = false;
    let record: { id: number; checksum: string; size: number; mimetype: string; name: string } | null = null;
    try {
      if (!useModule && op.attempts > 1 && !firstSend) {
        await this.uploadQuiet(creds, op);
        record = await this.findUploaded(creds, op);
      }
      if (record === null) {
        if (this.stopped.has(op.id)) throw new ChatTransferCancelledError(`upload ${op.id} stopped before it began`);
        if (firstSend) await this.outbox.setParams(op.id, { uploadSentAt: this.now().toISOString() });
        // No await from the check to the transfer's start: a stop meanwhile cancels the transfer itself
        if (this.stopped.has(op.id)) throw new ChatTransferCancelledError(`upload ${op.id} stopped before it began`);
        const transferId = `${op.id}-${op.attempts}`;
        this.transfers.set(op.id, transferId);
        this.progress.set(transferId, { localUuid, done: 0, total: size });
        this.watchProgress();
        sending = true;
        try {
          const a = await transfer.upload(creds, {
            id: transferId,
            route: useModule ? MODULE_UPLOAD_ROUTE : ODOO_UPLOAD_ROUTE,
            channelId,
            clientUuid: useModule ? op.clientUuid : null,
            voice: !!op.params.voice,
            path,
            name,
            mimetype,
          });
          record = {
            id: a.id,
            checksum: a.checksum ?? "",
            size: typeof a.size === "number" ? a.size : size,
            mimetype: a.mimetype || mimetype,
            name: a.name || name,
          };
        } finally {
          this.transfers.delete(op.id);
          this.progress.delete(transferId);
        }
      }
    } catch (e: unknown) {
      // A leave reached the server meanwhile (a 404, a cancel): the file goes with the conversation, no notice
      if (await this.leaving(configId, channelId)) return this.refuseLeft(op);
      if (e instanceof RequestNotSentError) {
        // Nothing of this send reached the server: a retry has nothing to look for
        if (firstSend) await this.outbox.setParams(op.id, { uploadSentAt: null });
        throw e;
      }
      if (e instanceof ChatFileTooBigError) return this.refuseFile(op, "too_big");
      if (e instanceof ChatTransferRefusedError && e.reason === "not_found" && useModule) await this.moduleRouteGone(op);
      if (e instanceof ChatTransferRefusedError) return this.refuseFile(op, e.reason);
      // Cancelled by a drop: the op is gone
      if (e instanceof ChatTransferCancelledError && !(await this.db.getOutboxOp(op.id))) return;
      if (sending) await this.outbox.setParams(op.id, { uploadEndedAt: this.now().toISOString() });
      throw e;
    }
    // Left while the file was on the wire: the post is gone, the file is not its
    if (await this.leaving(configId, channelId)) return this.refuseLeft(op);
    await this.repo.setUploaded(configId, localUuid, {
      attachmentId: record.id, checksum: record.checksum, size: record.size, mimetype: record.mimetype, name: record.name,
    });
  }

  /**
   * The module route answered 404 twice: the module may be gone or older.
   * The module state is probed again (moduleRefused); below 1.2 the file
   * and the other files of its post take Odoo's route from now on, as a
   * first send (the module route made nothing), and this throws
   * OutboxRetryLaterError for a retry at once. Still 1.2, it returns: the
   * channel itself is not found. A probe that fails throws a plain error:
   * the retry meets the 404 and probes again, the file is not refused.
   */
  private async moduleRouteGone(op: OutboxOp): Promise<void> {
    try {
      await this.moduleRefused(op.configId);
    } catch (probe) {
      throw new Error(`The module route answered 404 and the module probe failed: ${(probe as Error)?.message ?? probe}`);
    }
    if (levelAtLeast(effectiveLevel(await this.repo.sourceState(op.configId)), "1.2")) return;
    const all = await this.db.getOutboxOpsForConfig(op.configId);
    const post = all.find((o) => o.kind === CHAT_POST && (o.params.files ?? []).includes(op.params.localUuid));
    const siblings = new Set<string>(post?.params.files ?? [op.params.localUuid]);
    for (const o of all) {
      if (o.kind === CHAT_UPLOAD && siblings.has(o.params.localUuid)) {
        await this.outbox.setParams(o.id, { useModule: false, uploadSentAt: null, uploadEndedAt: null });
      }
    }
    if (post) await this.outbox.setParams(post.id, { idempotentUpload: false });
    throw new OutboxRetryLaterError("The module route is gone: the file goes through Odoo's route.", this.now().toISOString());
  }

  /**
   * Throws OutboxRetryLaterError until CREATE_QUIET_WINDOW_MS passed since
   * the upload's last send ended: the request may still be running on the
   * server, its row not visible to a search yet. A stamp ahead of the
   * clock (stored under a clock that ran fast) restarts the window once.
   */
  private async uploadQuiet(creds: SyncCredentials, op: OutboxOp): Promise<void> {
    let since: string = op.params.uploadEndedAt ?? op.params.uploadSentAt;
    if (new Date(since).getTime() > this.now().getTime()) {
      since = this.now().toISOString();
      await this.outbox.setParams(op.id, { uploadEndedAt: since });
    }
    const quietUntil = new Date(new Date(since).getTime() + CREATE_QUIET_WINDOW_MS);
    if (quietUntil.getTime() > this.now().getTime()) {
      throw new OutboxRetryLaterError(
        `The previous upload may still be running on ${creds.odooUrl}; retry after ${quietUntil.toISOString()}.`,
        quietUntil.toISOString(),
      );
    }
  }

  /**
   * The pending attachment a lost upload made, or null: the user's own
   * placeholder rows (res_model mail.compose.message, res_id 0, as Odoo's
   * route stores them) of the same name created between uploadSentAt −
   * CREATE_CLOCK_SKEW_MS and (uploadEndedAt, or now) + CREATE_CLOCK_SKEW_MS,
   * the oldest first. The size must match too, except for the image types
   * Odoo's route may resize (foundByNameAlone): those are stored
   * re-encoded at another size. An attachment another file of this phone
   * already holds (state "uploaded") is never taken again; two uploads
   * this search cannot tell apart are never in doubt at once (pumpUploads
   * orders twins).
   */
  private async findUploaded(
    creds: SyncCredentials,
    op: OutboxOp,
  ): Promise<{ id: number; checksum: string; size: number; mimetype: string; name: string } | null> {
    const { uid } = await this.rpc.sessionInfo(creds);
    const taken = await this.repo.uploadedIds(op.configId);
    const sentAt = new Date(op.params.uploadSentAt).getTime();
    const endedAt = op.params.uploadEndedAt ? new Date(op.params.uploadEndedAt).getTime() : this.now().getTime();
    const found = (await this.rpc.searchRead<any>(
      creds,
      "ir.attachment",
      [
        ["res_model", "=", PENDING_MODEL],
        ["res_id", "=", 0],
        ["create_uid", "=", uid],
        ["name", "=", op.params.name],
        ...(foundByNameAlone(op) ? [] : [["file_size", "=", op.params.size]]),
        ["create_date", ">=", odooDate(new Date(sentAt - CREATE_CLOCK_SKEW_MS))],
        ["create_date", "<=", odooDate(new Date(endedAt + CREATE_CLOCK_SKEW_MS))],
      ],
      ["id", "name", "mimetype", "file_size", "checksum"],
      { order: "id asc", limit: 1 + taken.size },
    )).filter((a) => typeof a.id === "number" && !taken.has(a.id));
    const a = found[0];
    if (!a) return null;
    return {
      id: a.id,
      checksum: a.checksum || "",
      size: typeof a.file_size === "number" ? a.file_size : op.params.size,
      mimetype: a.mimetype || op.params.mimetype,
      name: a.name || op.params.name,
    };
  }

  /** The file of a conversation being left: refused "left", no notice; the op ends. */
  private async refuseLeft(op: OutboxOp): Promise<void> {
    await this.repo.setRefused(op.configId, op.params.localUuid, "left");
    this.changed(op.configId, op.params.channelId);
  }

  /**
   * Refuses a file for good: its row turns "refused" with the reason, a
   * CHAT_FILE_REFUSED notice (blocked, until dismissed) names it, and the
   * op ends, so its post goes without it.
   */
  private async refuseFile(op: OutboxOp, reason: FileRefusal, limit?: number): Promise<void> {
    const { configId } = op;
    const { channelId, localUuid, name } = op.params;
    await this.repo.setRefused(configId, localUuid, reason);
    // Written blocked in one statement: no drain ever sees it queued
    await this.outbox.enqueue({
      noteId: CHAT_NOTE,
      configId,
      kind: CHAT_FILE_REFUSED,
      params: { channelId, localUuid, name, reason, ...(limit ? { limit } : {}), blockedReason: "refused", candidates: [] },
      status: "blocked",
      lastError: `File ${name} not sent: ${reason}.`,
    });
    this.changed(configId, channelId);
  }

  private runCreate(creds: SyncCredentials, op: OutboxOp): Promise<void> {
    return this.outbox.attempt(op.id, (running) => this.sendCreate(creds, running));
  }

  /**
   * Creates the conversation: channel_get for a direct message (Odoo finds
   * the existing chat again, so a repeat is safe), create_group or
   * channel_create otherwise, with the op's client uuid in the context when
   * the server module 1.1 dedupes creates (useModule). A send stamps
   * createSentAt and a retry waits out the quiet window as a post does.
   * Without the module, a retry after a send that may have reached the
   * server first looks for the conversation by its fingerprint
   * (findCreated) and adopts it. A refusal leaves the conversation listed
   * as failed (failCreate); the op and what waits for it go.
   */
  private async sendCreate(creds: SyncCredentials, op: OutboxOp): Promise<void> {
    const { channelId, partnerIds, name, groupId } = op.params;
    const mode = op.params.mode as CreateMode;
    const useModule = !!op.params.useModule;
    // A pair stored by an earlier settle names the conversation: read it, no window to wait out, no search
    const own = await this.repo.realIdOf(op.configId, channelId);
    if (own !== null) {
      if (!(await this.isOnline())) throw new RequestNotSentError("Offline: the create waits for the network.");
      const store = await this.rpc.callWithAuth(creds, (sessionId) =>
        this.rpc.jsonRoute(creds.odooUrl, sessionId, "/discuss/channel/info", { channel_id: own }));
      if (typeof store?.[CHANNEL_MODEL]?.[0]?.id !== "number") throw new Error("The conversation found cannot be read.");
      await this.settleCreate(op, own, store);
      return;
    }
    const sentAt = await this.quietStamp(creds, op);

    let result: any = null;
    try {
      if (!(await this.isOnline())) throw new RequestNotSentError("Offline: the create waits for the network.");
      if (op.attempts > 1 && sentAt && mode !== "dm" && !useModule) result = await this.findCreated(creds, op, sentAt);
      if (result === null) {
        await this.outbox.setParams(op.id, { createSentAt: this.now().toISOString() });
        const context = useModule ? { context: { erplibre_client_uuid: op.clientUuid } } : {};
        if (mode === "dm") {
          result = await this.rpc.callKw(creds, CHANNEL_MODEL, "channel_get", [], { partners_to: partnerIds });
        } else if (mode === "group") {
          result = await this.rpc.callKw(creds, CHANNEL_MODEL, "create_group", [], {
            partners_to: partnerIds,
            ...(name ? { name } : {}),
            ...context,
          });
        } else {
          result = await this.rpc.callKw(creds, CHANNEL_MODEL, "channel_create", [name, groupId], context);
        }
      }
    } catch (e: unknown) {
      if (e instanceof RequestNotSentError) {
        await this.outbox.setParams(op.id, { createSentAt: sentAt ?? null });
        throw e;
      }
      if (!isRefused(e)) throw e;
      await this.failCreate(op.configId, channelId);
      await this.outbox.cancel(op.id);
      throw new OutboxBlockedError((e as Error).message, "refused", [], op.kind, op.id);
    }
    const realId = result?.[CHANNEL_MODEL]?.[0]?.id;
    // The server may have created it: a retry finds it again
    if (typeof realId !== "number") throw new Error("The create answer holds no channel.");
    await this.settleCreate(op, realId, result);
  }

  /**
   * The Store of the conversation a lost create made, or null when there is
   * none. Searches the user's own member conversations of the op's type
   * created between createSentAt − CREATE_CLOCK_SKEW_MS and createSentAt +
   * CREATE_QUIET_WINDOW_MS + CREATE_CLOCK_SKEW_MS (the send cannot have run
   * later), the name too when the op has one; a group must also have
   * exactly the op's people plus self as members, compared on every hit
   * (no limit before the filter). A conversation another create of this
   * phone already settled on is never taken again; the one this create's
   * own pair names is. Two matches block the op
   * ("ambiguous", their ids as candidates); one is read through
   * /discuss/channel/info.
   */
  private async findCreated(creds: SyncCredentials, op: OutboxOp, sentAt: string): Promise<any | null> {
    const mode = op.params.mode as CreateMode;
    const info = await this.rpc.sessionInfo(creds);
    // Without self the member sets never match, and the create would be sent again
    if (!info.partnerId) throw new Error("The partner of the session is unknown.");
    const sent = new Date(sentAt).getTime();
    const domain: any[] = [
      ["create_uid", "=", info.uid],
      ["channel_type", "=", TYPE_OF[mode]],
      ["create_date", ">=", odooDate(new Date(sent - CREATE_CLOCK_SKEW_MS))],
      ["create_date", "<=", odooDate(new Date(sent + CREATE_QUIET_WINDOW_MS + CREATE_CLOCK_SKEW_MS))],
      ["is_member", "=", true],
    ];
    if (op.params.name) domain.push(["name", "=", op.params.name]);
    let found = await this.rpc.searchRead<{ id: number; channel_partner_ids: number[] }>(
      creds, CHANNEL_MODEL, domain, ["id", "channel_partner_ids"],
    );
    const adopted = await this.repo.adoptedIds(op.configId);
    // The one this create already settled on stays its own: a kill came between the pair and the swap
    const own = await this.repo.realIdOf(op.configId, op.params.channelId);
    found = found.filter((c) => !adopted.has(c.id) || c.id === own);
    if (mode === "group") {
      const wanted = new Set<number>([...(op.params.partnerIds ?? []), info.partnerId]);
      found = found.filter((c) => {
        const has = new Set(c.channel_partner_ids ?? []);
        return has.size === wanted.size && [...wanted].every((id) => has.has(id));
      });
    }
    if (found.length > 1) {
      throw new OutboxBlockedError(
        `Several conversations match the create ${op.clientUuid}.`,
        "ambiguous",
        found.map((c) => c.id),
        op.kind,
        op.id,
      );
    }
    if (found.length === 0) return null;
    const store = await this.rpc.callWithAuth(creds, (sessionId) =>
      this.rpc.jsonRoute(creds.odooUrl, sessionId, "/discuss/channel/info", { channel_id: found[0].id }));
    if (typeof store?.[CHANNEL_MODEL]?.[0]?.id !== "number") throw new Error("The conversation found cannot be read.");
    return store;
  }

  /**
   * Writes a settled create or join in the account's queue of counter
   * writers (serial): the server's Store first, then the pair stored in
   * chat_temp_ids, then the temporary id swapped for the server's
   * (ChatRepository.swapChannelId, exclusive of a post being queued), then
   * `created`. Stored first, the pair outlives a kill before the swap: the
   * create's retry finds its own conversation again (findCreated) and
   * swaps. An op no longer stored (its account erased, the conversation
   * given up meanwhile) writes nothing.
   */
  private settleCreate(op: OutboxOp, realId: number, result: any): Promise<void> {
    return this.serial(op.configId, async () => {
      const { configId } = op;
      if (!(await this.db.getOutboxOp(op.id))) return;
      const tempId: number = op.params.channelId;
      const self = (await this.repo.sourceState(configId)).selfPartnerId;
      await this.repo.applyDelta(configId, parseStore(result, configId, self));
      await this.exclusive(configId, async () => {
        const leftUnsent = !!(await this.repo.channel(configId, tempId))?.leftUnsent;
        // Stored before the swap rewrites the op's channelId: a kill between the two still names the pair
        if (tempId !== realId) await this.repo.rememberRealId(configId, tempId, realId);
        await this.repo.swapChannelId(configId, tempId, realId);
        // The server's row won the swap: what the phone queued since (a name, a mute, a leave) shows again
        const own: StoreDelta = { ...emptyDelta(), channels: [{ channelId: realId }] };
        await this.overlayPending(configId, own);
        const { channelId: _id, ...patch } = own.channels[0];
        await this.repo.patchChannel(configId, realId, {
          ...patch,
          ...(leftUnsent ? { leftUnsent: true } : {}),
          ...(patch.isMember === false ? { localPinned: false } : {}),
        });
      });
      this.created(configId, tempId, realId);
    });
  }

  /**
   * Joins a public channel through /discuss/channel/join, which adds self
   * only when missing, so a repeat is safe. A channel the user cannot reach
   * (NotFound, access) is given up as a refused create is.
   */
  private runJoin(creds: SyncCredentials, op: OutboxOp): Promise<void> {
    return this.outbox.attempt(op.id, async (running) => {
      const { channelId } = running.params;
      let result: any;
      try {
        if (!(await this.isOnline())) throw new RequestNotSentError("Offline: the join waits for the network.");
        result = await this.rpc.callWithAuth(creds, (sessionId) =>
          this.rpc.jsonRoute(creds.odooUrl, sessionId, "/discuss/channel/join", { channel_id: channelId }));
      } catch (e: unknown) {
        if (!isRefused(e)) throw e;
        await this.failCreate(running.configId, channelId);
        await this.outbox.cancel(running.id);
        throw new OutboxBlockedError((e as Error).message, "refused", [], running.kind, running.id);
      }
      await this.settleCreate(running, channelId, result);
    });
  }

  /**
   * Sends one action with the params stored when it starts (a value
   * written into the op until then goes out). An action of a conversation
   * the user is leaving, or left with texts unsent, is dropped. A
   * conversation gone, created on the phone only, refused, or one the user
   * is no longer a member of for an action Odoo would join them for
   * (MEMBER_ONLY) is not sent: the op is given up as "vanished". A refusal
   * (REFUSED_ERRORS, or AttributeError for a call of the module,
   * MODULE_ONLY, after which the module state is probed again) gives it up
   * as "refused". Given up, it stays blocked in the outbox as a notice
   * (notices) until dismissed, unless a later op of the same action
   * supersedes it. A refused leave also clears leftUnsent: the next load
   * shows the membership the server kept.
   */
  private runAction(creds: SyncCredentials, op: OutboxOp): Promise<void> {
    return this.outbox.attempt(op.id, async (running) => {
      const act: OutboxOp = { ...running, params: (await this.db.getOutboxOp(running.id))?.params ?? running.params };
      if (!(await this.isOnline())) throw new RequestNotSentError(`Offline: ${act.kind} waits for the network.`);
      const channelId: number | null = act.params.channelId ?? null;
      const channel = channelId === null ? null : await this.repo.channel(act.configId, channelId);
      if (act.kind !== CHAT_LEAVE && act.kind !== CHAT_GLOBAL_MUTE) {
        // Running when the user left, and retried since: dropped with the rest of the conversation
        if (await this.leaving(act.configId, channelId!)) return;
        const gone = !channel || channelId! <= 0 || channel.createFailed
          || (MEMBER_ONLY.has(act.kind) && !channel.isMember);
        if (gone) return this.giveUp(act, "vanished", `The conversation of ${act.kind} is gone or no longer the user's.`);
      }
      try {
        await this.sendAction(creds, act, channel);
      } catch (e: unknown) {
        const moduleMissing = MODULE_ONLY.has(act.kind) && e instanceof OdooRpcError && e.odooName === "builtins.AttributeError";
        if (!isRefused(e) && !moduleMissing) throw e;
        if (moduleMissing) {
          try {
            await this.moduleRefused(act.configId);
          } catch (probe) {
            console.warn("chat: module probe after a refusal failed", probe);
          }
        }
        if (act.kind === CHAT_LEAVE && channel) await this.repo.patchChannel(act.configId, channelId!, { leftUnsent: false });
        return this.giveUp(act, "refused", (e as Error).message);
      }
      if (act.kind === CHAT_LEAVE) this.left(act.configId, channelId!);
      if (act.kind === CHAT_REMOVE) {
        await this.repo.dropMember(act.configId, channelId!, act.params.partnerId);
        this.changed(act.configId, channelId);
      }
    });
  }

  private async sendAction(creds: SyncCredentials, op: OutboxOp, channel: { channelType: ChannelType } | null): Promise<void> {
    const p = op.params;
    const cid: number = p.channelId;
    const mute = (params: Record<string, any>) => this.rpc.callWithAuth(creds, (sessionId) =>
      this.rpc.jsonRoute(creds.odooUrl, sessionId, "/discuss/settings/mute", params));
    switch (op.kind) {
      case CHAT_INVITE:
        await this.rpc.callKw(creds, CHANNEL_MODEL, "add_members", [[cid]], { partner_ids: p.partnerIds });
        return;
      case CHAT_RENAME:
        await this.rpc.callKw(creds, CHANNEL_MODEL, channel?.channelType === "chat" ? "channel_set_custom_name" : "channel_rename",
          [[cid]], { name: p.name });
        return;
      case CHAT_DESCRIBE:
        await this.rpc.callKw(creds, CHANNEL_MODEL, "channel_change_description", [[cid]], { description: p.description });
        return;
      case CHAT_LEAVE:
        await this.rpc.callKw(creds, CHANNEL_MODEL, "action_unfollow", [cid]);
        return;
      case CHAT_HIDE:
        await this.rpc.callKw(creds, CHANNEL_MODEL, "channel_pin", [cid], { pinned: false });
        return;
      case CHAT_MUTE:
        await mute({ minutes: muteMinutes(p.until ?? null, this.now()), channel_id: cid });
        return;
      case CHAT_GLOBAL_MUTE:
        await mute({ minutes: muteMinutes(p.until ?? null, this.now()) });
        return;
      case CHAT_REMOVE:
        await this.rpc.callKw(creds, CHANNEL_MODEL, "erplibre_remove_member", [[cid], p.partnerId]);
        return;
    }
  }

  /**
   * Sends one action on a message with the params stored when it starts.
   * Offline it waits (RequestNotSentError); an action of a conversation the
   * user is leaving, or left with texts unsent, is dropped. The message is
   * the cached one (messageOf: its server id, else its post's client
   * uuid): one no longer cached or still pending with its post gone is not
   * sent, given up as "vanished", and so is a reaction on a message
   * emptied (isEmptyMessage: deleted in Discuss); an edit or a delete is
   * shown in the cache already, so the server decides for them. One whose
   * post still waits holds the action (a plain error, retried). A row gone
   * when the handler reads it was cancelled: nothing is sent. The send
   * stamps sentAt first, given back when the request provably never left
   * (RequestNotSentError). The server's NotFound or MissingError gives it
   * up as "vanished", another refusal as "refused" (giveUpMessage); an edit
   * the server's body no longer allows (EditConflictError) as "changed",
   * the server's body written to the cache first. The answer's Store is
   * applied with the actions still queued laid over it (overlayMessages,
   * this op left out), in the account's queue of server writers (serial);
   * an answered edit is the base of the next edit of its message.
   */
  private runMessageAction(creds: SyncCredentials, op: OutboxOp): Promise<void> {
    return this.outbox.attempt(op.id, async (running) => {
      const stored = await this.db.getOutboxOp(running.id);
      // Cancelled as it started (a tap back to where the server stood): nothing to send
      if (!stored) return;
      const act: OutboxOp = { ...running, params: stored.params };
      if (!(await this.isOnline())) throw new RequestNotSentError(`Offline: ${act.kind} waits for the network.`);
      const { configId } = act;
      const channelId: number = act.params.channelId;
      if (await this.leaving(configId, channelId)) return;
      const message = await this.repo.messageOf(configId, targetOf(act));
      if (message && message.messageId === null && message.outboxOpId && (await this.db.getOutboxOp(message.outboxOpId))) {
        throw new Error(`${act.kind} waits for the post of its message.`);
      }
      const messageId = message?.messageId ?? null;
      const files = messageId === null || act.kind !== CHAT_REACTION ? 0
        : (await this.repo.attachmentsOf(configId, message!.channelId, [messageId], [])).get(`m${messageId}`)?.length ?? 0;
      if (messageId === null || (act.kind === CHAT_REACTION && isEmptyMessage(message!.body, files))) {
        return this.giveUpMessage(act, "vanished", `The message of ${act.kind} is gone.`);
      }
      // The message id: a notice names the message the server knows. sentAt: from now on the server may hold this
      // value, so a tap back is sent rather than taken for a no-op (queueAction)
      const sentAt: string | null = act.params.sentAt ?? null;
      await this.outbox.setParams(act.id, { messageId, sentAt: this.now().toISOString() });
      let result: any;
      try {
        result = await this.sendMessageAction(creds, act, messageId);
      } catch (e: unknown) {
        if (e instanceof RequestNotSentError) {
          // Nothing of this attempt reached the server: the stamp goes back to the earlier one
          await this.outbox.setParams(act.id, { sentAt });
          throw e;
        }
        if (e instanceof EditConflictError) {
          // The follow-ups go first: the server's body is written with nothing of theirs laid over it
          const latest = await this.takeFollowUps(act);
          await this.serial(configId, () => this.applyConflict(act, messageId, e));
          await this.outbox.setParams(act.id, { conflict: e.conflict, ...latest });
          return this.giveUpMessage(act, "changed", e.message);
        }
        if (isVanished(e)) return this.giveUpMessage(act, "vanished", (e as Error).message);
        if (!isRefused(e)) throw e;
        return this.giveUpMessage(act, "refused", (e as Error).message);
      }
      await this.serial(configId, async () => {
        // Its account erased while the request was on the wire: nothing is written
        if (!(await this.db.getOutboxOp(act.id)) || result == null) return;
        const delta = parseStore(result, configId, (await this.repo.sourceState(configId)).selfPartnerId);
        const answered = delta.messages.find((m) => m.messageId === messageId)?.body;
        if (act.kind === CHAT_EDIT && answered !== undefined) {
          await this.rebaseEdits(act, { ...targetOf(act), messageId }, answered);
        }
        await this.overlayMessages(configId, delta, act.id);
        await this.repo.applyDelta(configId, delta);
      });
      this.changed(configId, channelId);
    });
  }

  /**
   * The edits of `op`'s message waiting behind it, refused with it: they
   * were made against the same body. They leave the outbox, and the newest
   * text and picks are returned for `op` to keep, so one notice holds the
   * text the user wrote last; {} when none waits.
   */
  private async takeFollowUps(op: OutboxOp): Promise<{ text?: string; mentions?: Mentions }> {
    const waiting = dependencyOrder(await this.db.getOutboxOpsForConfig(op.configId)).filter((o) => o.id !== op.id
      && o.kind === CHAT_EDIT && o.status !== "running" && o.status !== "blocked" && sameTarget(targetOf(o), targetOf(op)));
    for (const o of waiting) await this.outbox.cancel(o.id);
    const last = waiting.at(-1);
    return last ? { text: last.params.text, mentions: last.params.mentions ?? EMPTY_MENTIONS } : {};
  }

  /** The edits of `target` still to be sent after `op` are made against `body`, the server's answer to it. */
  private async rebaseEdits(op: OutboxOp, target: MessageTarget, body: string): Promise<void> {
    for (const o of await this.db.getOutboxOpsForConfig(op.configId)) {
      if (o.id === op.id || o.kind !== CHAT_EDIT || o.status === "running" || o.status === "blocked") continue;
      if (sameTarget(targetOf(o), target)) await this.outbox.setParams(o.id, { baseBody: body });
    }
  }

  /**
   * The server's message as a refused edit found it, written to the cache
   * with the actions still queued laid over it (this op left out): the
   * guarded route's Store, or the body re-read ("" when the message is no
   * longer there).
   */
  private async applyConflict(op: OutboxOp, messageId: number, e: EditConflictError): Promise<void> {
    const { configId } = op;
    if (!(await this.db.getOutboxOp(op.id))) return;
    const delta = e.store
      ? parseStore(e.store, configId, (await this.repo.sourceState(configId)).selfPartnerId)
      : { ...emptyDelta(), messages: [{ messageId, body: e.body ?? "" }] };
    await this.overlayMessages(configId, delta, op.id);
    await this.repo.applyDelta(configId, delta);
  }

  /**
   * Sends one action on the message `messageId`; resolves with the
   * server's answer (a Store), or null when there is nothing to apply. A
   * delete is Odoo's: the body, the attachments and the subject emptied; a
   * message already gone (NotFound) counts as deleted.
   */
  private async sendMessageAction(creds: SyncCredentials, op: OutboxOp, messageId: number): Promise<any> {
    const p = op.params;
    const route = (path: string, params: Record<string, any>) => this.rpc.callWithAuth(creds, (sessionId) =>
      this.rpc.jsonRoute(creds.odooUrl, sessionId, path, params));
    switch (op.kind) {
      case CHAT_REACTION:
        return route("/mail/message/reaction", { message_id: messageId, content: p.content, action: p.action });
      case CHAT_EDIT:
        return this.sendEdit(creds, op, messageId);
      case CHAT_DELETE:
        try {
          return await route(ODOO_EDIT_ROUTE, { message_id: messageId, body: "", attachment_ids: [], attachment_tokens: [], subject: "" });
        } catch (e: unknown) {
          if (isVanished(e)) return null;
          throw e;
        }
    }
    throw new Error(`No sender for ${op.kind}.`);
  }

  /**
   * Sends an edit as the browser does (D5): the composer's HTML
   * (composeBody), its partner ids, `attachment_ids: null` (the
   * attachments stay). The body it is made against is baseBody, else (its
   * post's answer never read) the server's body read now, taken only while
   * it is still the post's (postBody: otherwise "changed"). With editGuard
   * the module's route writes only when the server's body still has that
   * body's fingerprint; it answers erplibre_conflict with the message
   * otherwise. Without it the body and the attachments are re-read just
   * before Odoo's route: a missing or empty message (isEmptyMessage: no
   * text and no file) is "deleted", another body "changed".
   * A server body that reads as the text this edit sends (the edited span
   * and the paragraph aside: bodyText) is this edit already written, an
   * answer lost, or nothing to change: done, without a write. Any other
   * conflict throws EditConflictError. A plain 404 of the module's route (the module gone
   * or older) probes the module (moduleRefused) and throws a plain error:
   * the retry takes the route the probe leaves.
   */
  private async sendEdit(creds: SyncCredentials, op: OutboxOp, messageId: number): Promise<any> {
    const p = op.params;
    const composed = composeBody(p.text ?? "", p.mentions ?? EMPTY_MENTIONS, await emojiConversions());
    const sends = bodyText(composed.body);
    const values = { message_id: messageId, body: composed.body, attachment_ids: null, partner_ids: composed.partnerIds };
    const guarded = await this.editGuard(op.configId);
    let baseBody: string | null = p.baseBody ?? null;
    if (!guarded || baseBody === null) {
      const rows = await this.rpc.searchRead<{ id: number; body: string | false; attachment_ids: number[] }>(
        creds, "mail.message", [["id", "=", messageId]], ["body", "attachment_ids"]);
      const server = rows.length > 0 ? (rows[0].body || "") : null;
      if (server !== null && bodyText(server) === sends) return { "mail.message": [{ id: messageId, body: server }] };
      if (server === null || isEmptyMessage(server, (rows[0].attachment_ids ?? []).length)) {
        throw new EditConflictError("deleted", null, server);
      }
      if (baseBody === null) {
        // The post's answer never read: the body read now is the base only while it is still the post's
        if (!postBody(op, server)) throw new EditConflictError("changed", null, server);
        baseBody = server;
        await this.outbox.setParams(op.id, { baseBody });
      } else if (server !== baseBody) {
        throw new EditConflictError("changed", null, server);
      }
      if (!guarded) return this.rpc.callWithAuth(creds, (sessionId) => this.rpc.jsonRoute(creds.odooUrl, sessionId, ODOO_EDIT_ROUTE, values));
    }
    const expected = await bodyFingerprint(baseBody);
    const result = await this.rpc.callWithAuth(creds, async (sessionId) => {
      try {
        return await this.rpc.jsonRoute(creds.odooUrl, sessionId, MODULE_EDIT_ROUTE, { ...values, expected_fingerprint: expected });
      } catch (e: unknown) {
        if (Object.getPrototypeOf(e) === Error.prototype && /^HTTP 404\b/.test((e as Error).message)) {
          throw new RouteMissingError((e as Error).message);
        }
        throw e;
      }
    }).catch(async (e: unknown) => {
      if (!(e instanceof RouteMissingError)) throw e;
      try {
        await this.moduleRefused(op.configId);
      } catch (probe) {
        console.warn("chat: module probe after a missing edit route failed", probe);
      }
      throw new Error(`The guarded edit route is missing on ${creds.odooUrl}: ${e.message}`);
    });
    if (!result?.erplibre_conflict) return result;
    const server = parseStore(result, op.configId, null).messages.find((m) => m.messageId === messageId)?.body ?? "";
    if (bodyText(server) === sends) return result;
    throw new EditConflictError(result.erplibre_conflict === "deleted" ? "deleted" : "changed", result, null);
  }


  /**
   * Gives an action on a message up (giveUp). A reaction no later op of
   * its key follows is shown again as the server held it (base). An edit
   * or a delete with no other edit or delete of the message queued shows
   * the message as the server has it: hidden ("") when it vanished, as a
   * re-read that finds no message leaves it; the body it was made against
   * (baseBody) when refused; a conflict wrote the server's body already.
   */
  private async giveUpMessage(op: OutboxOp, reason: ChatNotice["reason"], message: string): Promise<void> {
    const target = targetOf(op);
    const shown = reason === "vanished" ? "" : reason === "refused" ? op.params.baseBody : undefined;
    if ((op.kind === CHAT_EDIT || op.kind === CHAT_DELETE) && typeof shown === "string") {
      const later = (await this.db.getOutboxOpsForConfig(op.configId)).some((o) => o.id !== op.id
        && (o.kind === CHAT_EDIT || o.kind === CHAT_DELETE) && o.status !== "blocked" && sameTarget(targetOf(o), target));
      if (!later) await this.showBody(op.configId, target, shown);
    }
    if (op.kind === CHAT_REACTION) {
      const key = targetKey(op);
      const later = (await this.db.getOutboxOpsForConfig(op.configId)).some((o) => o.id !== op.id && targetKey(o) === key);
      if (!later) await this.showReaction(op.configId, target, op.params.content, !!op.params.base);
    }
    return this.giveUp(op, reason, message);
  }

  /**
   * Gives an action up: blocked with its reason, as a notice, unless a
   * later op of its key (targetKey: the same action, conversation, person
   * removed, message and content) is queued, which supersedes it, or the
   * conversation is being left: then it simply leaves the outbox.
   */
  private async giveUp(op: OutboxOp, reason: ChatNotice["reason"], message: string): Promise<void> {
    const key = targetKey(op);
    const later = (await this.db.getOutboxOpsForConfig(op.configId)).some((o) => o.id !== op.id && targetKey(o) === key);
    this.changed(op.configId, op.params.channelId ?? null);
    if (later) return;
    // An action of a conversation being left goes with it: a blocked one would hold the leave back
    if (op.kind !== CHAT_LEAVE && op.params.channelId != null && (await this.leaving(op.configId, op.params.channelId))) return;
    throw new OutboxBlockedError(message, reason, [], op.kind, op.id);
  }

  private runRead(creds: SyncCredentials, op: OutboxOp): Promise<void> {
    return this.outbox.attempt(op.id, async (running) => {
      // Covers a queueRead write that landed before the "running" mark; a later one finds the row running and queues a follow-up
      const params = (await this.db.getOutboxOp(running.id))?.params ?? running.params;
      const { channelId, lastMessageId, mentions } = params;
      try {
        await this.rpc.callWithAuth(creds, (sessionId) =>
          this.rpc.jsonRoute(creds.odooUrl, sessionId, "/discuss/channel/mark_as_read", {
            channel_id: channelId,
            last_message_id: lastMessageId,
          }));
        if (mentions) {
          await this.rpc.callKw(creds, "mail.message", "mark_all_as_read", [
            [["model", "=", CHANNEL_MODEL], ["res_id", "=", channelId]],
          ]);
        }
      } catch (e: unknown) {
        // A channel the user cannot reach any more has nothing left to mark
        if (!isRefused(e)) throw e;
      }
    });
  }
}
