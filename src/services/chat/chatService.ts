import type { Application } from "../../models/application";
import type { BusNotification, ChatChannel, ChatMessage, ChatModuleState } from "../../models/chat";
import { syncConfigIdFor } from "../../models/syncConfig";
import type { DatabaseService } from "../databaseService";
import { networkService } from "../networkService";
import type { CapabilityService } from "../odoo/capabilityService";
import type { OdooRpcClient, SyncCredentials } from "../odoo/odooRpcClient";
import type { OutboxService } from "../outboxService";
import { BUS_VERSION_FALLBACK, ChatBus, type BusTransport } from "./chatBus";
import { moduleState } from "./chatModule";
import { ChatOutbox } from "./chatOutbox";
import { ChatRepository } from "./chatRepository";
import { chatSettings } from "./chatSettings";
import { CHAT_MAJOR, parseOdooMajor, sourceLabels, type ChatSource } from "./chatSources";
import { parseStore, type StoreDelta } from "./chatStore";
import { sortConversations, totalUnread } from "./chatUnread";

export type { ChatSource } from "./chatSources";

/** Older messages one history page brings. */
export const CHAT_PAGE = 30;
/** Older messages per request when the whole history is fetched. */
export const CHAT_FULL_PAGE = 100;
/** While the user keeps typing, "typing" is sent again after this delay (Odoo's LONG_TYPING). */
export const TYPING_RESEND_MS = 50000;
/** "Stopped typing" is sent this long after the last keystroke (Odoo's SHORT_TYPING). */
export const TYPING_STOP_MS = 5000;

const CHANNEL_MODEL = "discuss.channel";

const credsOf = (app: Application): SyncCredentials => ({
  odooUrl: app.url,
  username: app.username,
  password: app.password,
  database: app.database,
});

const configOf = (app: Application): string => syncConfigIdFor(app.url, app.username, app.database);

const emptyDelta = (): StoreDelta => ({
  channels: [],
  deletedChannelIds: [],
  members: [],
  deletedMemberIds: [],
  messages: [],
  partners: [],
  inboxCounter: null,
  selfPartnerId: null,
});

/** A conversation the list shows: one the user is a member of, or keeps pinned locally. */
const shown = (c: ChatChannel): boolean => c.isMember || c.localPinned;

const maxDt = (a: string | null, b: string | null | undefined): string | null =>
  !b ? a : !a || b > a ? b : a;

/**
 * The chat as the screens and the app lifecycle use it, over the cache
 * (repo) and the chat outbox (queue). Every server call goes through the
 * shared OdooRpcClient; nothing here starts a timer or a listener at
 * construction, so the service builds in node as in the app.
 *
 * Counters come from the server: /mail/data at load, then the bus. The
 * inbox counter moves on a bus notification only when its bus id is above
 * the account's stored counterBusId, which load sets to the bus id
 * /mail/data reports (Store.inbox.counter_bus_id), lower or not, and each
 * notification applied raises to its own; stored, it holds across
 * restarts. A channel's unread and mention counters carry their own bus id
 * marks, as Odoo's records do: a load sets them, a bus value older than the
 * mark is not taken, a local change is made only by a notification above
 * it. So a notification replayed after a load or a restart is never counted
 * twice and never rolls a counter back. Records (messages, members,
 * partners) are upserts and are always applied.
 *
 * The writers of server counters of one account (load, a history page, a
 * bus delivery) run one at a time, each from its server read to its last
 * write, in call order: a load writes its read as authoritative, so a bus
 * notification applied between that read and that write would be
 * overwritten by the older read and never replayed.
 */
export class ChatService {
  readonly repo: ChatRepository;
  readonly queue: ChatOutbox;
  /** Called after the cache changed: the account, and the channel when one alone changed. */
  onChange: ((configId: string, channelId: number | null) => void) | null = null;
  /** Whether a server may answer now; replaceable in tests. */
  isOnline: () => Promise<boolean> = () => networkService.isOnline();

  /** The running bus of each account, and the counter that voids a start overtaken by a stop. */
  private buses = new Map<string, ChatBus>();
  private realtimeRun = 0;

  /** Per account, the end of the queue of serial() tasks; settled tasks leave it. */
  private chains = new Map<string, Promise<void>>();

  /** Per "configId#channelId", when "typing" was last sent and the pending stop. */
  private typingState = new Map<string, { sentAt: number | null; stop: ReturnType<typeof setTimeout> | null }>();

  /**
   * "auto" posts through the server module when it is installed; "ignore"
   * always takes the marker path, as against a server without the module.
   * Public so a test kit can switch it on the service SyncService builds.
   */
  moduleMode: "auto" | "ignore";

  constructor(
    private db: DatabaseService,
    private rpc: OdooRpcClient,
    outbox: OutboxService,
    private capabilities: CapabilityService,
    private now: () => Date = () => new Date(),
    opts: { moduleMode?: "auto" | "ignore" } = {},
  ) {
    this.moduleMode = opts.moduleMode ?? "auto";
    this.repo = new ChatRepository(db);
    this.queue = new ChatOutbox(db, rpc, outbox, this.repo, now);
    this.queue.isOnline = () => this.isOnline();
  }

  private changed(configId: string, channelId: number | null): void {
    this.onChange?.(configId, channelId);
  }

  /**
   * Runs `task` once every task queued before it for the account has
   * settled, and returns its result. A task that fails rejects its own
   * caller only; the next ones still run. A task must not await serial()
   * for its own account: it would wait on itself.
   */
  private serial<T>(configId: string, task: () => Promise<T>): Promise<T> {
    const run = (this.chains.get(configId) ?? Promise.resolve()).then(task);
    const tail = run.then(() => undefined, () => undefined);
    this.chains.set(configId, tail);
    void tail.then(() => {
      if (this.chains.get(configId) === tail) this.chains.delete(configId);
    });
    return run;
  }

  private async raiseBusId(configId: string, busId: number): Promise<void> {
    if (busId > (await this.repo.sourceState(configId)).counterBusId) {
      await this.repo.setSourceState({ configId, counterBusId: busId });
    }
  }

  // ─── Sources ──────────────────────────────────────────────────────────────

  /**
   * The applications with a database whose Odoo major version is CHAT_MAJOR,
   * labelled with sourceLabels. An application whose version is unknown is
   * asked once when online and the answer stored ("18.0"); offline, or when
   * the server cannot be reached, it counts when it was a chat source before
   * (a chat_sources row exists). `online` defaults to the network state.
   */
  async sources(opts: { online?: boolean } = {}): Promise<ChatSource[]> {
    const online = opts.online ?? (await this.isOnline());
    const kept: Application[] = [];
    for (const app of await this.db.getAllApplications()) {
      if (!app.database) continue;
      let major = parseOdooMajor(app.odooVersion ?? "");
      if (major === null && online) {
        try {
          major = await this.rpc.odooVersion(credsOf(app));
          await this.db.setApplicationOdooVersion(app.url, app.username, `${major}.0`);
        } catch {
          // Unreachable now: decided as offline
        }
      }
      const isSource = major === null ? await this.repo.hasSourceState(configOf(app)) : major === CHAT_MAJOR;
      if (isSource) kept.push(app);
    }
    const labels = sourceLabels(kept);
    return kept.map((app, i) => ({ configId: configOf(app), app, creds: credsOf(app), label: labels[i] }));
  }

  /** The source of an account whatever its version, or null when its application is gone. */
  private async sourceOf(configId: string): Promise<ChatSource | null> {
    const app = (await this.db.getAllApplications()).find((a) => a.database && configOf(a) === configId);
    return app ? { configId, app, creds: credsOf(app), label: sourceLabels([app])[0] } : null;
  }

  // ─── Load and read ────────────────────────────────────────────────────────

  /**
   * Reads the account from the server: the session (self partner, system
   * right, websocket version), then /mail/data with the member channels and
   * their last message, then the server module state. A cached conversation
   * the server no longer lists (left or hidden meanwhile) is dropped, unless
   * it is pinned locally or still holds a post waiting to go. A channel
   * whose last message is above every cached one and not cached itself may
   * miss messages in between: its history restarts (oldestLoadedId null,
   * not complete), so the next pages come down from the last message again
   * and upsert the rows already cached. A failed module probe keeps the
   * state stored before; any other failure propagates. Queued behind the
   * account's other server writers (see the class).
   */
  load(src: ChatSource): Promise<void> {
    return this.serial(src.configId, () => this.loadNow(src));
  }

  /** load() without the queue, for a task already running in it. */
  private async loadNow(src: ChatSource): Promise<void> {
    const { configId, creds } = src;
    const info = await this.rpc.sessionInfo(creds);
    const self = info.partnerId || null;
    await this.repo.setSourceState({
      configId,
      selfPartnerId: self,
      isSystem: info.isSystem,
      wsVersion: info.websocketWorkerVersion,
    });
    const result = await this.rpc.callWithAuth(creds, (sessionId) =>
      this.rpc.jsonRoute(creds.odooUrl, sessionId, "/mail/data", { init_messaging: {}, channels_as_member: true }));
    const delta = parseStore(result, configId, self);
    const lastOf = new Map(delta.channels.map((c) => [c.channelId, c.lastMessageId]));
    const gaps: number[] = [];
    for (const c of await this.repo.channels(configId)) {
      const cached = await this.repo.messages(configId, c.channelId);
      if (!lastOf.has(c.channelId)) {
        if (c.localPinned || cached.some((m) => m.messageId === null)) continue;
        delta.deletedChannelIds.push(c.channelId);
        continue;
      }
      const last = lastOf.get(c.channelId);
      const highest = Math.max(0, ...cached.map((m) => m.messageId ?? 0));
      if (last != null && highest > 0 && highest < last) gaps.push(c.channelId);
    }
    const busId = Number(result?.Store?.inbox?.counter_bus_id);
    if (Number.isFinite(busId)) {
      // A counter read without its own bus id is as of the read: it sets the mark a replay must beat
      for (const c of delta.channels) {
        if (c.unreadCounter !== undefined && c.unreadCounterBusId === undefined) c.unreadCounterBusId = busId;
        if (c.needactionCounter !== undefined && c.needactionCounterBusId === undefined) c.needactionCounterBusId = busId;
      }
    }
    await this.repo.applyDelta(configId, delta);
    for (const channelId of gaps) {
      await this.repo.patchChannel(configId, channelId, { oldestLoadedId: null, historyComplete: false });
    }
    // Set, not raised: the server's bus ids restart from 0 when its bus table is emptied
    if (Number.isFinite(busId)) await this.repo.setSourceState({ configId, counterBusId: busId });

    let module: ChatModuleState | null = null;
    try {
      module = await moduleState(this.rpc, this.capabilities, creds, { online: true });
    } catch {
      // The state stored before stands
    }
    await this.repo.setSourceState({
      configId,
      ...(module ? { moduleState: module } : {}),
      loadedAt: this.now().toISOString(),
    });
    this.changed(configId, null);
  }

  private async configIds(configIds?: string[]): Promise<string[]> {
    return configIds ?? [...(await this.db.getLiveSyncConfigIds())];
  }

  /** The conversations of the given accounts (all live ones by default), sorted for the list. */
  async conversations(configIds?: string[]): Promise<ChatChannel[]> {
    const all: ChatChannel[] = [];
    for (const id of await this.configIds(configIds)) {
      all.push(...(await this.repo.channels(id)).filter(shown));
    }
    return sortConversations(all);
  }

  /**
   * Unread messages of the given accounts, as the tile shows them. Odoo's
   * inbox counter already holds the mentions of every channel, which the
   * conversations count themselves: they are taken out of it first, as
   * Odoo's messaging menu does, so a mention counts once.
   */
  async unreadTotal(configIds?: string[]): Promise<number> {
    let total = 0;
    for (const id of await this.configIds(configIds)) {
      const channels = await this.repo.channels(id);
      const mentions = channels.reduce((sum, c) => sum + c.needactionCounter, 0);
      const inbox = Math.max(0, (await this.repo.sourceState(id)).inboxCounter - mentions);
      total += totalUnread(channels.filter(shown), [inbox], this.now());
    }
    return total;
  }

  /** The cached messages of a channel; opts as ChatRepository.messages (beforeId, limit). */
  async messages(
    configId: string,
    channelId: number,
    opts: { beforeId?: number; limit?: number } = {},
  ): Promise<ChatMessage[]> {
    return this.repo.messages(configId, channelId, opts);
  }

  // ─── History ──────────────────────────────────────────────────────────────

  /** One page of older messages; returns how many were not cached before. */
  async loadOlder(src: ChatSource, channelId: number): Promise<number> {
    return (await this.page(src, channelId, CHAT_PAGE)).added;
  }

  /**
   * Every older message, CHAT_FULL_PAGE per request, until the start of the
   * history; returns and reports (onProgress) the running count of messages
   * not cached before.
   */
  async loadAll(src: ChatSource, channelId: number, onProgress?: (n: number) => void): Promise<number> {
    let total = 0;
    for (;;) {
      const { fetched, added } = await this.page(src, channelId, CHAT_FULL_PAGE);
      total += added;
      if (added > 0) onProgress?.(total);
      const channel = await this.repo.channel(src.configId, channelId);
      if (fetched === 0 || !channel || channel.historyComplete) return total;
    }
  }

  /**
   * Fetches the `size` messages below the oldest loaded one (below the
   * last known one + 1 when none is loaded). The request always uses
   * `around`: without it Odoo marks the fetched messages done, which clears
   * mentions. `around` also returns up to `size` newer messages; only the
   * ones at or below it are this page. Fewer than `size` means the start of
   * the history is reached. Returns the messages of the page (fetched) and
   * those of them not cached before (added). Queued behind the account's
   * other server writers (see the class).
   */
  private page(src: ChatSource, channelId: number, size: number): Promise<{ fetched: number; added: number }> {
    return this.serial(src.configId, () => this.pageNow(src, channelId, size));
  }

  private async pageNow(src: ChatSource, channelId: number, size: number): Promise<{ fetched: number; added: number }> {
    const { configId, creds } = src;
    const channel = await this.repo.channel(configId, channelId);
    if (!channel || channel.historyComplete) return { fetched: 0, added: 0 };
    const around = channel.oldestLoadedId !== null
      ? channel.oldestLoadedId - 1
      : channel.lastMessageId !== null ? channel.lastMessageId + 1 : 0;
    if (around < 1) {
      await this.repo.patchChannel(configId, channelId, { historyComplete: true });
      return { fetched: 0, added: 0 };
    }
    const result = await this.rpc.callWithAuth(creds, (sessionId) =>
      this.rpc.jsonRoute(creds.odooUrl, sessionId, "/discuss/channel/messages", {
        channel_id: channelId,
        around,
        limit: 2 * size,
      }));
    const self = (await this.repo.sourceState(configId)).selfPartnerId;
    const delta = parseStore(result?.data, configId, self);
    delta.messages = delta.messages.filter((m) => m.messageId <= around && m.channelId === channelId);
    let added = 0;
    for (const m of delta.messages) if (!(await this.repo.message(configId, m.messageId))) added++;
    await this.repo.applyDelta(configId, delta);
    const ids = delta.messages.map((m) => m.messageId);
    const patch: Partial<ChatChannel> = {};
    if (ids.length > 0) patch.oldestLoadedId = Math.min(...ids, channel.oldestLoadedId ?? Infinity);
    if (ids.length < size) patch.historyComplete = true;
    await this.repo.patchChannel(configId, channelId, patch);
    this.changed(configId, channelId);
    return { fetched: ids.length, added };
  }

  // ─── Send, read, typing ───────────────────────────────────────────────────

  /**
   * Queues the text (stored as a pending message before any request), then,
   * online, flushes the account's chat outbox at once. Returns the pending
   * message; a failed flush leaves it queued for the next one.
   */
  async send(src: ChatSource, channelId: number, text: string): Promise<ChatMessage> {
    const { configId } = src;
    const useModule = this.moduleMode === "auto"
      && (await this.repo.sourceState(configId)).moduleState === "installed";
    const message = await this.queue.queuePost(configId, channelId, text, useModule);
    this.changed(configId, channelId);
    if (await this.isOnline()) {
      try {
        await this.queue.flush(src.creds);
      } catch {
        // Kept in the outbox for the next flush
      }
      this.changed(configId, channelId);
    }
    return message;
  }

  /**
   * Marks the conversation read up to its last known message, through the
   * outbox (mentions cleared too when the channel has some), flushed at
   * once when online; a chat is also marked fetched, a courtesy whose
   * failure is ignored. With sendRead off nothing goes to the server. The
   * local counters change only when the server reports them back.
   */
  async markRead(src: ChatSource, channelId: number): Promise<void> {
    if (!chatSettings().sendRead) return;
    const { configId } = src;
    const channel = await this.repo.channel(configId, channelId);
    if (!channel || channel.lastMessageId === null) return;
    await this.queue.queueRead(configId, channelId, channel.lastMessageId, channel.needactionCounter > 0);
    if (!(await this.isOnline())) return;
    try {
      await this.queue.flush(src.creds);
    } catch {
      // Kept in the outbox for the next flush
    }
    if (channel.channelType === "chat") {
      try {
        await this.rpc.callKw(src.creds, CHANNEL_MODEL, "channel_fetched", [[channelId]]);
      } catch {
        // A courtesy mark: the next read sends it again
      }
    }
  }

  /**
   * Tells the conversation the user is typing (true at each keystroke) or
   * stopped (false). Sent only with sendTyping on, online, and in a
   * conversation the user is a member of (Odoo would make them one). "true"
   * goes once per TYPING_RESEND_MS while keystrokes keep coming; "false"
   * goes TYPING_STOP_MS after the last one, or at once on an explicit stop,
   * and only after a "true". Typing is never queued: a failed call is dropped.
   */
  async typing(src: ChatSource, channelId: number, isTyping: boolean): Promise<void> {
    const key = `${src.configId}#${channelId}`;
    if (isTyping) {
      if (!chatSettings().sendTyping) return;
      if (!(await this.repo.channel(src.configId, channelId))?.isMember) return;
      if (!(await this.isOnline())) return;
    }
    const state = this.typingState.get(key) ?? { sentAt: null, stop: null };
    this.typingState.set(key, state);
    if (state.stop) clearTimeout(state.stop);
    state.stop = null;
    if (!isTyping) {
      if (state.sentAt === null) return;
      state.sentAt = null;
      await this.notifyTyping(src, channelId, false);
      return;
    }
    const now = this.now().getTime();
    const send = state.sentAt === null || now - state.sentAt >= TYPING_RESEND_MS;
    if (send) state.sentAt = now;
    state.stop = setTimeout(() => {
      state.stop = null;
      if (state.sentAt === null) return;
      state.sentAt = null;
      void this.notifyTyping(src, channelId, false);
    }, TYPING_STOP_MS);
    if (send) await this.notifyTyping(src, channelId, true);
  }

  private async notifyTyping(src: ChatSource, channelId: number, isTyping: boolean): Promise<void> {
    try {
      await this.rpc.callWithAuth(src.creds, (sessionId) =>
        this.rpc.jsonRoute(src.creds.odooUrl, sessionId, "/discuss/channel/notify_typing", {
          channel_id: channelId,
          is_typing: isTyping,
        }));
    } catch {
      // Transient by nature: dropped
    }
  }

  /** Cancels the pending typing stops; nothing more is sent for them. */
  dispose(): void {
    this.stopRealtime();
    for (const state of this.typingState.values()) {
      if (state.stop) clearTimeout(state.stop);
    }
    this.typingState.clear();
  }

  /**
   * Erases one account's chat from the phone: its rows leave the outbox
   * (posts not sent are lost), then its cache goes. Queued behind the
   * account's server writers, so a delivery already running cannot write
   * after the erase.
   */
  async forgetSource(configId: string): Promise<void> {
    await this.serial(configId, async () => {
      await this.queue.dropAll(configId);
      await this.repo.dropSource(configId);
    });
    this.changed(configId, null);
  }

  /**
   * Flushes the chat outbox of every application; one that fails does not
   * stop the others. force skips the retry delays (not a quiet window).
   */
  async flushAll(opts: { force?: boolean } = {}): Promise<void> {
    for (const app of await this.db.getAllApplications()) {
      if (!app.database) continue;
      try {
        const result = await this.queue.flush(credsOf(app), { force: opts.force });
        if (result.done + result.failed + result.blocked > 0) this.changed(configOf(app), null);
      } catch {
        // Kept in the outbox for the next flush
      }
    }
  }

  // ─── Realtime ─────────────────────────────────────────────────────────────

  /**
   * Starts one ChatBus per source (the buses running before are stopped
   * first, so there is never more than one per account). The sources start
   * side by side: each is loaded, then its bus starts, so the bus catches
   * up from a fresh cache, and a slow or silent server holds back its own
   * bus only. A load that fails (server unreachable) does not hold its bus
   * back, which reconnects by itself. A stopRealtime during the start
   * cancels what has not started yet. The bus resubscribes after a delivery
   * that joined a channel, once the reload that delivery triggers is done.
   */
  async startRealtime(transportFor: (configId: string) => BusTransport): Promise<void> {
    this.stopRealtime();
    const run = this.realtimeRun;
    const sources = await this.sources({ online: true });
    if (run !== this.realtimeRun) return;
    await Promise.all(sources.map((src) => this.startSource(src, run, transportFor)));
  }

  private async startSource(src: ChatSource, run: number, transportFor: (configId: string) => BusTransport): Promise<void> {
    try {
      await this.load(src);
    } catch (e) {
      console.warn("chat: load before realtime failed", e);
    }
    if (run !== this.realtimeRun) return;
    const bus = new ChatBus(src, {
      transport: () => transportFor(src.configId),
      session: async () => ({
        sessionId: (await this.rpc.getSession(src.creds)).sessionId,
        version: (await this.repo.sourceState(src.configId)).wsVersion ?? BUS_VERSION_FALLBACK,
      }),
      reauth: async () => {
        await this.rpc.authenticate(src.creds);
      },
      state: () => this.repo.sourceState(src.configId),
      saveLast: (id) =>
        this.repo.setSourceState({ configId: src.configId, lastBusId: id, busSeenAt: this.now().toISOString() }),
      channels: async () =>
        (await this.repo.channels(src.configId))
          .filter((c) => c.correspondentPartnerId != null)
          .map((c) => `odoo-presence-res.partner_${c.correspondentPartnerId}`),
      deliver: async (n) => {
        await this.applyBus(src.configId, n);
        if (n.some((x) => x.message?.type === "discuss.channel/joined")) bus.resubscribe();
      },
      reload: () => this.load(src),
    });
    try {
      bus.start();
    } catch (e) {
      // An insecure server (http without the option) gets no realtime
      console.warn("chat: realtime not started", e);
      return;
    }
    this.buses.set(src.configId, bus);
  }

  /** The network is back: every bus not connected tries at once (ChatBus.reconnectNow). */
  reconnectNow(): void {
    for (const bus of this.buses.values()) bus.reconnectNow();
  }

  /** Stops and forgets every bus; a start still loading is cancelled. */
  stopRealtime(): void {
    this.realtimeRun++;
    for (const bus of this.buses.values()) bus.stop();
    this.buses.clear();
  }

  // ─── Bus ──────────────────────────────────────────────────────────────────

  /**
   * Applies bus notifications of one account in order. Each handled type
   * ends with onChange; an unknown type is ignored. See the class for the
   * bus id rule that guards the counters. Queued behind the account's other
   * server writers; a notification that reloads the account (a channel
   * joined, a message of an unknown channel) runs that load inline.
   */
  applyBus(configId: string, notifications: BusNotification[]): Promise<void> {
    return this.serial(configId, () => this.applyBusNow(configId, notifications));
  }

  private async applyBusNow(configId: string, notifications: BusNotification[]): Promise<void> {
    for (const n of notifications) {
      const fresh = n.id > (await this.repo.sourceState(configId)).counterBusId;
      const result = await this.applyOne(configId, n.message?.type, n.message?.payload ?? {}, n.id, fresh);
      if (fresh) await this.raiseBusId(configId, n.id);
      if (result !== undefined) this.changed(configId, result);
    }
  }

  /**
   * Applies one notification; returns the channel it changed (null: several),
   * undefined when ignored. `fresh`: above the account's counterBusId.
   */
  private async applyOne(
    configId: string,
    type: string,
    p: any,
    busId: number,
    fresh: boolean,
  ): Promise<number | null | undefined> {
    switch (type) {
      case "discuss.channel/new_message":
        return this.applyNewMessage(configId, p, busId, fresh);
      case "mail.record/insert": {
        const delta = await this.applyStore(configId, p);
        return delta.channels.length === 1 ? delta.channels[0].channelId : null;
      }
      case "discuss.channel.member/fetched": {
        const channelId = Number(p.channel_id);
        await this.repo.applyDelta(configId, {
          ...emptyDelta(),
          members: [{ memberId: Number(p.id), channelId, partnerId: Number(p.partner_id), fetchedMessageId: Number(p.last_message_id) }],
        });
        return channelId;
      }
      case "discuss.channel/joined":
        await this.reload(configId);
        return typeof p.channel?.id === "number" ? p.channel.id : null;
      case "discuss.channel/leave":
      case "discuss.channel/delete": {
        const ids: number[] = type === "discuss.channel/delete"
          ? [Number(p.id)]
          : (p[CHANNEL_MODEL] ?? []).map((c: any) => Number(c.id));
        await this.repo.applyDelta(configId, { ...emptyDelta(), deletedChannelIds: ids.filter(Number.isInteger) });
        return ids.length === 1 ? ids[0] : null;
      }
      case "mail.message/inbox":
        return this.applyInbox(configId, p, busId, fresh);
      case "mail.message/mark_as_read":
        return this.applyMarkAsRead(configId, p, busId, fresh);
      case "bus.bus/im_status_updated": {
        const partner = (await this.repo.partners(configId)).find((x) => x.partnerId === p.partner_id);
        if (partner && typeof p.im_status === "string") {
          await this.repo.applyDelta(configId, { ...emptyDelta(), partners: [{ ...partner, imStatus: p.im_status }] });
        }
        return null;
      }
      default:
        return undefined;
    }
  }

  private async selfOf(configId: string): Promise<number | null> {
    return (await this.repo.sourceState(configId)).selfPartnerId;
  }

  /**
   * Applies a Store as a bus delivers it. A partial of a channel never seen
   * and without its type (a pin flag, a counter) is left out: it would make
   * an empty conversation. A channel counter is taken only with a bus id
   * not older than the stored one (see ChatRepository.applyDelta).
   */
  private async applyStore(configId: string, result: any): Promise<StoreDelta> {
    const delta = parseStore(result, configId, await this.selfOf(configId));
    const kept: StoreDelta["channels"] = [];
    for (const c of delta.channels) {
      if (c.channelType !== undefined || (await this.repo.channel(configId, c.channelId))) kept.push(c);
    }
    delta.channels = kept;
    await this.repo.applyDelta(configId, delta, { fromBus: true });
    return delta;
  }

  /** Loads the account from inside a bus delivery, which already holds its queue. */
  private async reload(configId: string): Promise<void> {
    const src = await this.sourceOf(configId);
    if (src) await this.loadNow(src);
  }

  /**
   * A new message in a channel. A channel the cache does not hold as a
   * member one reloads the account. The message settles the pending post
   * whose client uuid is the payload's temporary_id. A message of someone
   * else, newer than the last known one, raises the unread counter by one
   * in any conversation type, the open one included, as the browser's
   * local counter does, unless the payload carries the server's counter or
   * the stored counter is as of this bus id or later. Marking read, and
   * the member record the server sends back, bring it down again; a
   * channel's unread still counts nowhere but in its bold (unreadOf).
   */
  private async applyNewMessage(configId: string, p: any, busId: number, fresh: boolean): Promise<number | null> {
    const channelId = Number(p.id);
    const known = await this.repo.channel(configId, channelId);
    if (!known || !known.isMember) {
      await this.reload(configId);
      return channelId;
    }
    const delta = await this.applyStore(configId, p.data);
    const message = delta.messages.find((m) => m.channelId === channelId);
    if (!message) return channelId;

    if (typeof p.temporary_id === "string") {
      const pending = (await this.repo.messages(configId, channelId))
        .some((m) => m.messageId === null && m.clientUuid === p.temporary_id);
      if (pending) await this.repo.settlePending(configId, p.temporary_id, message.messageId);
    }

    const self = await this.selfOf(configId);
    const patch: Partial<ChatChannel> = {
      lastMessageId: Math.max(known.lastMessageId ?? 0, message.messageId),
      lastInterestDt: maxDt(known.lastInterestDt, message.date),
    };
    const serverCounted = delta.channels.some((c) => c.channelId === channelId && c.unreadCounter !== undefined);
    const fromOther = self === null || message.authorPartnerId !== self;
    if (
      fresh && busId > known.unreadCounterBusId
      && !serverCounted && fromOther
      && message.messageId > (known.lastMessageId ?? 0)
    ) {
      patch.unreadCounter = known.unreadCounter + 1;
    }
    await this.repo.patchChannel(configId, channelId, patch);
    return channelId;
  }

  /**
   * A message that needs the user's action: the inbox counter goes up by
   * one, and its channel's mentions too unless they are as of this bus id
   * or later.
   */
  private async applyInbox(configId: string, p: any, busId: number, fresh: boolean): Promise<number | null> {
    const delta = await this.applyStore(configId, p);
    const channelId = delta.messages[0]?.channelId ?? null;
    if (!fresh) return channelId;
    const state = await this.repo.sourceState(configId);
    await this.repo.setSourceState({ configId, inboxCounter: state.inboxCounter + 1 });
    const channel = channelId !== null ? await this.repo.channel(configId, channelId) : null;
    if (channel && busId > channel.needactionCounterBusId) {
      await this.repo.patchChannel(configId, channel.channelId, { needactionCounter: channel.needactionCounter + 1 });
    }
    return channelId;
  }

  /**
   * Messages whose needaction the user cleared: the inbox counter takes the
   * server's value (a replay at or below counterBusId changes nothing), and
   * each cached message lowers its channel's mentions by one (every id
   * listed was a needaction of the user), unless the channel's mentions are
   * as of this bus id or later.
   */
  private async applyMarkAsRead(configId: string, p: any, busId: number, fresh: boolean): Promise<number | null> {
    if (!fresh) return null;
    if (typeof p.needaction_inbox_counter === "number") {
      await this.repo.setSourceState({ configId, inboxCounter: p.needaction_inbox_counter });
    }
    const perChannel = new Map<number, number>();
    for (const id of p.message_ids ?? []) {
      const m = typeof id === "number" ? await this.repo.message(configId, id) : null;
      if (m) perChannel.set(m.channelId, (perChannel.get(m.channelId) ?? 0) + 1);
    }
    for (const [channelId, n] of perChannel) {
      const channel = await this.repo.channel(configId, channelId);
      if (channel && busId > channel.needactionCounterBusId) {
        await this.repo.patchChannel(configId, channelId, { needactionCounter: Math.max(0, channel.needactionCounter - n) });
      }
    }
    return perChannel.size === 1 ? [...perChannel.keys()][0] : null;
  }
}
