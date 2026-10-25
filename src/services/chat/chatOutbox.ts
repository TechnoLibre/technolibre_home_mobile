import type { ChannelType, ChatMessage } from "../../models/chat";
import type { DatabaseService, OutboxOp } from "../databaseService";
import { networkService } from "../networkService";
import { OdooRpcError, RequestNotSentError, type OdooRpcClient, type SyncCredentials } from "../odoo/odooRpcClient";
import {
  OutboxBlockedError,
  OutboxRetryLaterError,
  type DrainResult,
  type OutboxService,
} from "../outboxService";
import { syncConfigIdFor } from "../../models/syncConfig";
import { CREATE_QUIET_WINDOW_MS, clientMarker } from "../outboxMarker";
import { bodyHasMarker, textToBody } from "./chatBody";
import type { ChatRepository } from "./chatRepository";
import { parseStore } from "./chatStore";
import { v4 as uuidv4 } from "uuid";

/** Pseudo note id of every chat row in sync_outbox: the note sync leaves them alone. */
export const CHAT_NOTE = "chat";
/** params { channelId, text, useModule: boolean, createSentAt? } */
export const CHAT_POST = "chat.post";
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

/** Odoo's "YYYY-MM-DD HH:MM:SS" UTC string for a date. */
const odooDate = (d: Date): string => d.toISOString().slice(0, 19).replace("T", " ");

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

  /** Per account, the end of the queue of exclusive() tasks. */
  private locks = new Map<string, Promise<void>>();

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
   * negative id never reaches the server.
   */
  queuePost(configId: string, channelId: number, text: string, useModule: boolean): Promise<ChatMessage> {
    return this.exclusive(configId, async () =>
      this.queuePostNow(configId, (await this.realIdOf(configId, channelId)) ?? channelId, text, useModule));
  }

  private async queuePostNow(configId: string, channelId: number, text: string, useModule: boolean): Promise<ChatMessage> {
    const channel = await this.repo.channel(configId, channelId);
    if (channel?.createFailed || (channelId < 0 && !channel?.createOpId)) {
      const failed: ChatMessage = {
        configId,
        channelId,
        messageId: null,
        clientUuid: uuidv4(),
        authorPartnerId: (await this.repo.sourceState(configId)).selfPartnerId,
        body: textToBody(text, null),
        date: odooDate(this.now()),
        messageType: "comment",
        status: "failed",
        outboxOpId: null,
        writeDate: null,
      };
      await this.repo.putPending(failed);
      return failed;
    }
    const all = await this.db.getOutboxOpsForConfig(configId);
    // The tail of the channel's chain: the unfinished post no other op waits for
    const previous = all
      .filter((o) => o.kind === CHAT_POST && o.params.channelId === channelId)
      .filter((c) => !all.some((o) => o.dependsOn === c.id))
      .at(-1);
    const createOpId = channel?.createOpId ?? null;
    const creating = createOpId !== null && all.some((o) => o.id === createOpId) ? createOpId : null;
    const op = await this.outbox.enqueue({
      noteId: CHAT_NOTE,
      configId,
      kind: CHAT_POST,
      params: { channelId, text, useModule },
      dependsOn: previous?.id ?? creating,
    });
    const message: ChatMessage = {
      configId,
      channelId,
      messageId: null,
      clientUuid: op.clientUuid,
      authorPartnerId: (await this.repo.sourceState(configId)).selfPartnerId,
      body: textToBody(text, null),
      date: odooDate(this.now()),
      messageType: "comment",
      status: "pending",
      outboxOpId: op.id,
      writeDate: null,
    };
    try {
      await this.repo.putPending(message);
    } catch (e: unknown) {
      // No op goes out without its bubble
      await this.outbox.cancel(op.id);
      throw e;
    }
    return message;
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
   * message pinned again keeps its history and is only unpinned again.
   */
  discardCreate(configId: string, channelId: number): Promise<void> {
    return this.exclusive(configId, async () => {
      const channel = await this.repo.channel(configId, channelId);
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
   * queued; without it, it is removed. Returns how many were queued.
   */
  async recoverIncomplete(): Promise<number> {
    let queued = 0;
    for (const configId of await this.db.getLiveSyncConfigIds()) {
      for (const op of await this.db.getOutboxOpsForConfig(configId)) {
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
   * Drains the chat rows of the server the credentials open. A server with
   * no live application has nothing to send to: its rows are left as they
   * are and the call completes.
   */
  async flush(creds: SyncCredentials, opts: { force?: boolean } = {}): Promise<DrainResult> {
    const configId = syncConfigIdFor(creds.odooUrl, creds.username, creds.database);
    if (!(await this.db.getLiveSyncConfigIds()).has(configId)) {
      return { done: 0, failed: 0, blocked: 0, errors: [] };
    }
    return this.outbox.drain(creds, configId, { force: opts.force, onlyNoteIds: new Set([CHAT_NOTE]) });
  }

  /** Posts of the account still in the outbox, failed and blocked ones included. */
  async pendingPostCount(configId: string): Promise<number> {
    return (await this.db.getOutboxOpsForConfig(configId)).filter((o) => o.kind === CHAT_POST).length;
  }

  /** Removes the chat rows of the given channels from the outbox, posts and reads alike. */
  async dropChannels(configId: string, channelIds: number[]): Promise<void> {
    const gone = new Set(channelIds);
    for (const op of await this.db.getOutboxOpsForConfig(configId)) {
      if (op.noteId === CHAT_NOTE && gone.has(op.params.channelId)) await this.outbox.cancel(op.id);
    }
  }

  /** Removes every chat row of the account from the outbox, posts and reads alike. */
  async dropAll(configId: string): Promise<void> {
    for (const op of await this.db.getOutboxOpsForConfig(configId)) {
      if (op.noteId === CHAT_NOTE) await this.outbox.cancel(op.id);
    }
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

  private async sendPost(creds: SyncCredentials, op: OutboxOp): Promise<void> {
    const { channelId, text } = op.params;
    const useModule = !!op.params.useModule;
    const sentAt = await this.quietStamp(creds, op);

    let messageId: number | null = null;
    let result: any = null;
    try {
      if (!(await this.isOnline())) throw new RequestNotSentError("Offline: the post waits for the network.");
      if (op.attempts > 1) messageId = await this.findSent(creds, op);
      if (messageId === null) {
        await this.outbox.setParams(op.id, { createSentAt: this.now().toISOString() });
        const postData: Record<string, any> = {
          body: textToBody(text, op.clientUuid),
          message_type: "comment",
          subtype_xmlid: "mail.mt_comment",
        };
        if (useModule) postData.erplibre_client_uuid = op.clientUuid;
        result = await this.rpc.callWithAuth(creds, (sessionId) =>
          this.rpc.jsonRoute(creds.odooUrl, sessionId, "/mail/message/post", {
            thread_model: CHANNEL_MODEL,
            thread_id: channelId,
            post_data: postData,
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
      if (!isRefused(e)) throw e;
      // Refused for good: the quiet window must not hold a later manual retry
      await this.outbox.setParams(op.id, { createSentAt: null });
      await this.repo.markFailed(op.configId, op.clientUuid, (e as Error).message);
      throw new OutboxBlockedError((e as Error).message, "refused", [], op.kind, op.id);
    }

    await this.settle(op, messageId, result);
  }

  /**
   * The id of the user's own message in the channel that carries this op's
   * marker comment exactly, or null. The search is by author and the hit is
   * checked on the whole comment, so another member's message that quotes
   * the uuid is never taken for the post. Two hits block the op.
   */
  private async findSent(creds: SyncCredentials, op: OutboxOp): Promise<number | null> {
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
    return found.length === 1 ? found[0].id : null;
  }

  /**
   * Gives the pending message its server id, applies the Store the post
   * answered, and marks the channel read for its author as Odoo does on a
   * post, unless a newer message is already known. Runs in the account's
   * queue of counter writers (serial). An op no longer stored (its account
   * was erased while the post was on the wire) writes nothing.
   */
  private settle(op: OutboxOp, messageId: number, result: any): Promise<void> {
    return this.serial(op.configId, () => this.settleNow(op, messageId, result));
  }

  private async settleNow(op: OutboxOp, messageId: number, result: any): Promise<void> {
    const { configId } = op;
    if (!(await this.db.getOutboxOp(op.id))) return;
    if (result) {
      const self = (await this.repo.sourceState(configId)).selfPartnerId;
      await this.repo.applyDelta(configId, parseStore(result, configId, self));
    }
    await this.repo.settlePending(configId, op.clientUuid, messageId);
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
   * phone already settled on is never taken again. Two matches block the op
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
    found = found.filter((c) => !adopted.has(c.id));
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
   * writers (serial): the server's Store first, then the temporary id
   * swapped for the server's (ChatRepository.swapChannelId, exclusive of a
   * post being queued) and the pair stored in chat_temp_ids, then `created`. An op no longer stored (its account
   * erased, the conversation given up meanwhile) writes nothing.
   */
  private settleCreate(op: OutboxOp, realId: number, result: any): Promise<void> {
    return this.serial(op.configId, async () => {
      const { configId } = op;
      if (!(await this.db.getOutboxOp(op.id))) return;
      const tempId: number = op.params.channelId;
      const self = (await this.repo.sourceState(configId)).selfPartnerId;
      await this.repo.applyDelta(configId, parseStore(result, configId, self));
      await this.exclusive(configId, async () => {
        await this.repo.swapChannelId(configId, tempId, realId);
        if (tempId !== realId) await this.repo.rememberRealId(configId, tempId, realId);
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
