import type { ChatMessage } from "../../models/chat";
import type { DatabaseService, OutboxOp } from "../databaseService";
import { OdooRpcError, type OdooRpcClient, type SyncCredentials } from "../odoo/odooRpcClient";
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

/** Pseudo note id of every chat row in sync_outbox: the note sync leaves them alone. */
export const CHAT_NOTE = "chat";
/** params { channelId, text, useModule: boolean, createSentAt? } */
export const CHAT_POST = "chat.post";
/** params { channelId, lastMessageId, mentions: boolean } */
export const CHAT_READ = "chat.read";

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
 * posting again.
 */
export class ChatOutbox {
  constructor(
    private db: DatabaseService,
    private rpc: OdooRpcClient,
    private outbox: OutboxService,
    private repo: ChatRepository,
    private now: () => Date = () => new Date(),
  ) {
    outbox.registerHandler(CHAT_POST, (creds, op) => this.runPost(creds, op));
    outbox.registerHandler(CHAT_READ, (creds, op) => this.runRead(creds, op));
  }

  /**
   * Stores the text as a pending message and queues its post. The op waits
   * for the newest unfinished post of the same channel, so a failed post
   * holds the ones written after it.
   */
  async queuePost(configId: string, channelId: number, text: string, useModule: boolean): Promise<ChatMessage> {
    const all = await this.db.getOutboxOpsForConfig(configId);
    // The tail of the channel's chain: the unfinished post no other op waits for
    const previous = all
      .filter((o) => o.kind === CHAT_POST && o.params.channelId === channelId)
      .filter((c) => !all.some((o) => o.dependsOn === c.id))
      .at(-1);
    const op = await this.outbox.enqueue({
      noteId: CHAT_NOTE,
      configId,
      kind: CHAT_POST,
      params: { channelId, text, useModule },
      dependsOn: previous?.id ?? null,
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

  private runPost(creds: SyncCredentials, op: OutboxOp): Promise<void> {
    return this.outbox.attempt(op.id, (running) => this.sendPost(creds, running));
  }

  private async sendPost(creds: SyncCredentials, op: OutboxOp): Promise<void> {
    const { channelId, text } = op.params;
    const useModule = !!op.params.useModule;

    let sentAt: string | undefined = op.params.createSentAt;
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

    let messageId: number | null = null;
    let result: any = null;
    try {
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
   * post, unless a newer message is already known.
   */
  private async settle(op: OutboxOp, messageId: number, result: any): Promise<void> {
    const { configId } = op;
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
