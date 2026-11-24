import type { PluginListenerHandle } from "@capacitor/core";

import type { ChatPushNative, NativeAction } from "../../plugins/chatPushPlugin";
import type { ChatChannel } from "../../models/chat";
import { isRefused, muteDt } from "./chatOutbox";
import type { ChatService, ChatSource } from "./chatService";
import { parseStore } from "./chatStore";

/** How long the mute button of a notification mutes, from the tap (ActionRunner.MUTE_MS). */
export const NOTIFICATION_MUTE_MS = 60 * 60_000;

/** After this long from its tap, a record that still fails to apply online is dropped (ActionStore.STALE_MS). */
export const DRAIN_STALE_MS = 24 * 3600_000;

/** What a drain did: the ids it applied (then acked) and those it kept for the next drain. */
export interface DrainResult {
  applied: string[];
  kept: string[];
}

/** The class of an error, for a log line that never carries a reply's text, a session or an endpoint. */
const errorName = (e: unknown): string => (e instanceof Error ? e.name : typeof e);

/**
 * The notification actions native code ended (done) or hands over
 * (handoff), drained into the cache and the chat outbox. actions() serves
 * only those two states: a pending or running record is native code's.
 *
 * A done record already reached Odoo: a reply or a 👍 applies the Store
 * Odoo answered (when native code kept it), a read lowers the cached
 * counters, a mute sets the cached mute; nothing is queued, the next load
 * reconciles. A handoff record is queued as the app's own action would be:
 * a reply by queuePost with the native client uuid (its marker and the
 * module's dedupe key) and native code's body (plainText: no emoticon
 * converted), so either side sends the same message; a read by
 * queueRead whatever the read-receipts option (the user asked for it), its
 * mentions cleared up to the message;
 * a mute until createdAt + NOTIFICATION_MUTE_MS, dropped once that passed;
 * a 👍 on its message id, loaded first (loadUntil), dropped without an id.
 *
 * A reply whose send may have reached Odoo (sentAt) without the module, or
 * once sent without the module's uuid (plainSent), is queued maybeSent:
 * the outbox waits out the quiet window from sentAt and looks for the
 * marker before posting. With the module and only module sends, a resend
 * is answered with the first message. A reply whose uuid a message or an
 * op already carries is skipped, so a drain cut before its ack queues
 * nothing twice; the other kinds are target states, repeat-safe.
 *
 * An action of an account no longer a chat source is acked and dropped.
 * One that fails to apply (offline before its message is cached, a queue
 * error) is kept and tried again at the next drain, unless Odoo refused it
 * for good (isRefused), or it failed while online once DRAIN_STALE_MS
 * passed since its tap: then it is acked and dropped, as native code gives
 * up. Offline, however old, it is kept. The applied ids are
 * acked once all records ran; the accounts a handoff queued for are then
 * flushed.
 */
export class ChatPushActions {
  /** The drain running, and the one asked while it runs (one, whatever the number of asks). */
  private current: Promise<DrainResult> | null = null;
  private next: Promise<DrainResult> | null = null;
  private listener: Promise<PluginListenerHandle> | null = null;
  private disposed = false;

  constructor(
    private chat: ChatService,
    private native: ChatPushNative | null,
    private now: () => Date,
  ) {}

  /** Drains at each `actions` event of the plugin. Once; nothing off a native side. */
  start(): void {
    if (!this.native || this.listener || this.disposed) return;
    this.listener = this.native.addListener("actions", () => {
      if (this.disposed) return;
      this.drain().catch((e) => console.warn("[chat push] actions drain failed:", errorName(e)));
    });
    this.listener.catch((e) => console.warn("[chat push] actions event not followed:", errorName(e)));
  }

  /** Stops following the event; a drain running goes on. */
  dispose(): void {
    this.disposed = true;
    const listener = this.listener;
    this.listener = null;
    listener?.then((h) => h.remove()).catch(() => {});
  }

  /**
   * Applies the records native code serves, then acks the applied ones.
   * One drain at a time: asked while one runs, it runs once after it, and
   * every ask meanwhile shares that run. Rejects when the plugin does
   * (actions or ackActions): nothing is lost, the next drain serves the
   * same records and repeats nothing.
   */
  drain(): Promise<DrainResult> {
    if (!this.native) return Promise.resolve({ applied: [], kept: [] });
    if (!this.current) return this.begin();
    this.next ??= this.current.catch(() => undefined).then(() => {
      this.next = null;
      return this.begin();
    });
    return this.next;
  }

  private begin(): Promise<DrainResult> {
    const run: Promise<DrainResult> = this.drainNow().finally(() => {
      if (this.current === run) this.current = null;
    });
    this.current = run;
    return run;
  }

  private async drainNow(): Promise<DrainResult> {
    const native = this.native!;
    const records = await native.actions();
    const result: DrainResult = { applied: [], kept: [] };
    if (records.length === 0) return result;
    const sources = await this.chat.sources({ online: false });
    const queued = new Map<string, ChatSource>();
    for (const a of records) {
      const src = sources.find((s) => s.configId === a.configId);
      if (!src) {
        // Its removal took its notifications: nothing left to apply
        result.applied.push(a.id);
        continue;
      }
      try {
        if (a.state === "done") await this.applyDone(src, a);
        else if (await this.applyHandoff(src, a)) queued.set(src.configId, src);
        result.applied.push(a.id);
      } catch (e: unknown) {
        const stale = this.now().getTime() - a.createdAt >= DRAIN_STALE_MS;
        if (isRefused(e) || (stale && (await this.chat.isOnline()))) {
          result.applied.push(a.id);
          console.warn(`[chat push] ${a.kind} action dropped:`, errorName(e));
        } else {
          result.kept.push(a.id);
          console.warn(`[chat push] ${a.kind} action kept for the next drain:`, errorName(e));
        }
      }
    }
    try {
      if (result.applied.length > 0) await native.ackActions({ ids: result.applied });
    } finally {
      for (const src of queued.values()) await this.chat.afterAction(src, null);
    }
    return result;
  }

  /** A record native code ended: the cache takes what Odoo now holds. */
  private async applyDone(src: ChatSource, a: NativeAction): Promise<void> {
    const { configId } = src;
    switch (a.kind) {
      case "reply":
      case "react":
        if (a.answer) await this.applyAnswer(configId, a.answer);
        break;
      case "read":
        await this.readLocally(configId, a.channelId, a.messageId);
        break;
      case "mute":
        await this.chat.repo.patchChannel(configId, a.channelId, {
          muteUntilDt: muteDt(new Date(a.createdAt + NOTIFICATION_MUTE_MS).toISOString()),
        });
        break;
    }
    this.chat.onChange?.(configId, a.channelId);
  }

  /** Odoo's Store answer, applied as a load applies its own: what the outbox still has to send wins. */
  private async applyAnswer(configId: string, answer: string): Promise<void> {
    let result: unknown;
    try {
      result = JSON.parse(answer);
    } catch {
      // Not a Store: the next load brings the message
      return;
    }
    const self = (await this.chat.repo.sourceState(configId)).selfPartnerId;
    const delta = parseStore(result, configId, self);
    await this.chat.queue.exclusive(configId, async () => {
      await this.chat.queue.overlayPending(configId, delta);
      await this.chat.repo.applyDelta(configId, delta);
    });
  }

  /**
   * The cached channel read up to `messageId` (its last message when
   * null): the seen message raised, the counters 0 when the read covers
   * the last message.
   */
  private async readLocally(configId: string, channelId: number, messageId: number | null): Promise<void> {
    const channel = await this.chat.repo.channel(configId, channelId);
    const upTo = messageId ?? channel?.lastMessageId ?? null;
    if (!channel || upTo === null) return;
    const patch: Partial<ChatChannel> = { seenMessageId: Math.max(channel.seenMessageId ?? 0, upTo) };
    if (channel.lastMessageId === null || upTo >= channel.lastMessageId) {
      patch.unreadCounter = 0;
      patch.needactionCounter = 0;
    }
    await this.chat.repo.patchChannel(configId, channelId, patch);
  }

  /** A record handed over, queued in the chat outbox; true when the account's outbox is to be flushed. */
  private async applyHandoff(src: ChatSource, a: NativeAction): Promise<boolean> {
    const { configId } = src;
    switch (a.kind) {
      case "reply": {
        if (!a.text.trim() || (await this.chat.queue.knowsClientUuid(configId, a.clientUuid))) return false;
        const useModule = (await this.chat.push.moduleLevel(configId)) !== null;
        const maybeSent = a.sentAt !== null && (!useModule || a.plainSent);
        await this.chat.queue.queuePost(configId, a.channelId, a.text, useModule, {
          clientUuid: a.clientUuid,
          plainText: true,
          ...(maybeSent ? { maybeSentAt: new Date(a.sentAt!).toISOString() } : {}),
        });
        return true;
      }
      case "read": {
        const upTo = a.messageId ?? (await this.chat.repo.channel(configId, a.channelId))?.lastMessageId ?? null;
        if (upTo === null) return false;
        await this.chat.queue.queueRead(configId, a.channelId, upTo, true);
        return true;
      }
      case "mute": {
        const until = a.createdAt + NOTIFICATION_MUTE_MS;
        if (until <= this.now().getTime()) return false;
        await this.chat.queue.queueMute(configId, a.channelId, new Date(until).toISOString());
        return true;
      }
      case "react": {
        if (a.messageId === null || !a.content) return false;
        if (!(await this.chat.repo.message(configId, a.messageId)) && !(await this.chat.isOnline())) {
          throw new Error("The message of the reaction is loaded once online.");
        }
        // A message the history no longer holds takes no reaction
        if (!(await this.chat.loadUntil(src, a.channelId, a.messageId))) return false;
        await this.chat.react(src, a.channelId, { messageId: a.messageId, clientUuid: null }, a.content, true);
        return false;
      }
    }
    return false;
  }
}
