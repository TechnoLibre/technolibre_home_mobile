import type { Application } from "../../models/application";
import type {
  BusNotification, ChatAttachment, ChatChannel, ChatFileOrigin, ChatMailboxItem, ChatMember, ChatMessage, ChatModuleState,
  ChatNotice, ChatReaction, MessageTarget, OutgoingFile, RecordThread,
} from "../../models/chat";
import { messageKeyOf } from "../../models/chat";
import { syncConfigIdFor } from "../../models/syncConfig";
import type { DatabaseService, OutboxOp } from "../databaseService";
import { networkService } from "../networkService";
import { openRecordInApp } from "../../utils/openRecordInApp";
import type { CapabilityService } from "../odoo/capabilityService";
import { OdooRpcError, RequestNotSentError, type OdooRpcClient, type SyncCredentials } from "../odoo/odooRpcClient";
import type { OutboxService } from "../outboxService";
import { nativeChatHttp } from "../../plugins/chatFilePlugin";
import { BUS_VERSION_FALLBACK, ChatBus, type BusTransport } from "./chatBus";
import { ChatAttachmentCache } from "./chatAttachmentCache";
import { bodyText, isEmptyMessage, mentionAnchors } from "./chatBody";
import { EMPTY_MENTIONS, joinMentions, type Mentions } from "./chatCompose";
import { joinDraftText } from "./chatDraft";
import { ChatCsrf } from "./chatCsrf";
import { countEmojiUse } from "./chatEmoji";
import { deviceChatFiles, type ChatFiles, type ChatHttp } from "./chatFiles";
import { ChatModuleLevel, effectiveLevel, levelAtLeast, moduleProbe } from "./chatModule";
import { CHAT_DELETE, CHAT_EDIT, CHAT_STAR, ChatOutbox, sameTarget, targetOf, type CreateMode } from "./chatOutbox";
import { ChatInbox } from "./chatInbox";
import { ChatMentions } from "./chatMentions";
import { ChatPeople } from "./chatPeople";
import { ChatRepository, type ChatDraft, type DraftThread } from "./chatRepository";
import { ChatSearch } from "./chatSearch";
import { chatSettings } from "./chatSettings";
import { CHAT_MAJOR, parseOdooMajor, sourceLabels, type ChatSource } from "./chatSources";
import { mailboxPartialsOf, parseStore, type StoreDelta } from "./chatStore";
import { ChatTransfer } from "./chatTransfer";
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
/** Partners whose presence the bus follows, the most recent conversations first. */
export const PRESENCE_CAP = 200;
/** A message of a channel the cache does not hold reloads the account at most once per this window. */
export const RELOAD_WINDOW_MS = 10000;

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
  attachments: [],
  deletedAttachmentIds: [],
  partners: [],
  inboxCounter: null,
  selfPartnerId: null,
});

/**
 * A conversation the list shows: one the user is a member of, keeps
 * pinned locally, or left with texts unsent (until dismissed); a direct
 * message only while pinned on the server, so a hidden one and the other
 * person's new one still empty stay out.
 */
const shown = (c: ChatChannel): boolean =>
  (c.isMember || c.localPinned || c.leftUnsent) && (c.channelType !== "chat" || c.isPinned);

/** A shown conversation whose unread counts: not one the user left. */
const counted = (c: ChatChannel): boolean => shown(c) && !c.leftUnsent;

const maxDt = (a: string | null, b: string | null | undefined): string | null =>
  !b ? a : !a || b > a ? b : a;

/**
 * How a new conversation's call returns. By default it waits for the flush
 * and returns the server's id once the create settled; `background` returns
 * the id it queued under at once (temporary for a new one) and lets the
 * flush run, so a screen opens on it and follows the swap (realIdOf).
 */
/**
 * Whether a pinned message is unread: above the channel's seen message
 * (`seenMessageId`; null, nothing seen yet, makes every message unread).
 */
export function unreadPin(m: ChatMessage, seenMessageId: number | null): boolean {
  return m.messageId !== null && m.messageId > (seenMessageId ?? 0);
}

/** How many starred messages a page of /mail/starred/messages asks for. */
export const STARRED_PAGE = 30;

export interface QueuedOpts {
  background?: boolean;
}

/** The record of a reply's draft, without its name. */
const draftThread = (thread: RecordThread): DraftThread => ({ model: thread.model, resId: thread.resId });
/** The key of a record's sends in sendsRunning; a conversation's is "configId#channelId". */
const recordSendKey = (configId: string, thread: RecordThread): string => `${configId}#${thread.model}#${thread.resId}`;

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
  /** Per account, the counter that voids a bus start overtaken by a stop of that account alone. */
  private sourceRuns = new Map<string, number>();
  /** The transport factory of the last startRealtime, reused to start one account's bus alone. */
  private transportFor: ((configId: string) => BusTransport) | null = null;
  /** Per account, the counter forgetSource moves: a load or page that began before it discards its answer. */
  private generations = new Map<string, number>();

  /** Per account, the end of the queue of serial() tasks; settled tasks leave it. */
  private chains = new Map<string, Promise<void>>();

  /**
   * Per account, when a message of an unknown channel last reloaded it,
   * and the reload the window holds back.
   */
  private unknownReloadAt = new Map<string, number>();
  private unknownReloadOwed = new Map<string, ReturnType<typeof setTimeout>>();

  /** Per "configId#channelId", when "typing" was last sent and the pending stop. */
  private typingState = new Map<string, { sentAt: number | null; stop: ReturnType<typeof setTimeout> | null }>();

  /**
   * "auto" posts through the server module when it is installed; "ignore"
   * always takes the marker path, as against a server without the module.
   * Public so a test kit can switch it on the service SyncService builds.
   */
  moduleMode: "auto" | "ignore";

  /** Who to write to, channels to join and access groups of a new channel. */
  readonly people: ChatPeople;

  /** The composer's @ and # suggestions, from the cache and the server. */
  readonly mentions: ChatMentions;

  /** Search of messages, conversations, people, files and the mailbox, over the conversations of the list. */
  readonly search: ChatSearch;

  /** Odoo's inbox and its history, read-only pages into chat_mailbox; marking read goes through markDone and markAllDone. */
  readonly inbox: ChatInbox;

  /** The attachments' files on the phone: previews, downloads, space, purge (made by useFileIO). */
  attachments!: ChatAttachmentCache;

  constructor(
    private db: DatabaseService,
    private rpc: OdooRpcClient,
    outbox: OutboxService,
    private capabilities: CapabilityService,
    private now: () => Date = () => new Date(),
    opts: { moduleMode?: "auto" | "ignore" } = {},
  ) {
    this.moduleMode = opts.moduleMode ?? "auto";
    this.repo = new ChatRepository(db, now);
    this.people = new ChatPeople(rpc, this.repo, () => this.isOnline());
    this.mentions = new ChatMentions(this.repo, rpc, this.people, () => this.isOnline());
    this.search = new ChatSearch(this.repo, this.people, rpc, (configId) => this.features(configId), () => this.isOnline());
    this.search.conversations = (configIds) => this.conversations(configIds);
    this.search.moduleRefused = (configId) => this.probeModule(configId);
    this.queue = new ChatOutbox(db, rpc, outbox, this.repo, now);
    this.queue.isOnline = () => this.isOnline();
    this.queue.serial = (configId, task) => this.serial(configId, task);
    this.queue.created = (configId, _tempId, channelId) => {
      // The server fixes the channels a socket receives at subscribe time
      this.resubscribe(configId);
      this.changed(configId, channelId);
    };
    this.queue.left = (configId, channelId) => {
      // The local row stopped being a member before: no load or delivery sees the membership change
      this.resubscribe(configId);
      this.changed(configId, channelId);
    };
    this.queue.changed = (configId, channelId) => this.changed(configId, channelId);
    this.queue.moduleRefused = (configId) => this.probeModule(configId);
    this.queue.editGuard = async (configId) => (await this.features(configId)).guardedEdit;
    this.queue.starIdempotent = async (configId) => (await this.features(configId)).idempotentStar;
    this.queue.inboxSent = async (configId) => {
      const src = await this.sourceOf(configId);
      if (src) await this.load(src);
    };
    this.inbox = new ChatInbox(this.repo, rpc, () => this.isOnline());
    this.inbox.serial = (configId, task) => this.serial(configId, task);
    this.inbox.queue = this.queue;
    this.inbox.erasedSince = (configId) => this.erasedSince(configId);
    this.inbox.changed = (configId) => this.changed(configId, null);
    this.inbox.noteLinks = (configId) => this.db.getNoteLinksForConfig(configId);
    this.useFileIO({ files: deviceChatFiles, http: nativeChatHttp() });
  }

  /**
   * The files and the file transport the outbox uploads with (the device's
   * by default; memory files and a fake transport in tests and the test
   * kit), and optionally how Wi-Fi is known. Nothing is subscribed or
   * sent here: progress events are followed from the first upload or
   * download. The attachment cache is made again over them, and the files
   * the repository releases are deleted through it.
   */
  useFileIO(io: { files: ChatFiles; http: ChatHttp; onWifi?: () => Promise<boolean> }): void {
    this.queue.files = io.files;
    this.queue.transfer = new ChatTransfer(this.rpc, io.http, io.files, new ChatCsrf(this.rpc, io.http));
    this.queue.setProgressSource((fn) => io.http.onProgress(fn));
    if (io.onWifi) this.queue.onWifi = io.onWifi;
    this.attachments?.setProgressSource(null);
    this.attachments = new ChatAttachmentCache(
      this.repo, io.files, this.queue.transfer, this.queue.onWifi, (configId) => this.db.getOutboxOpsForConfig(configId), this.now,
    );
    this.attachments.setProgressSource((fn) => io.http.onProgress(fn));
    this.repo.onFilesReleased = (paths) => this.attachments.release(paths);
  }

  /** The account's directory name under chat/ (ChatRepository.fileDirOf), where its files are staged. */
  fileDirOf(configId: string): Promise<string> {
    return this.repo.fileDirOf(configId);
  }

  /**
   * The largest request the account's server takes (its session's
   * max_file_upload_size, kept for the app's lifetime and renewed by each
   * load), so the composer names it before sending; null when the session
   * cannot be read (offline before any load). The outbox checks the limit
   * again when it sends.
   */
  async uploadLimit(src: ChatSource): Promise<number | null> {
    try {
      return (await this.rpc.sessionInfo(src.creds)).maxUploadSize;
    } catch {
      return null;
    }
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
   * their last message, then the account-wide mute, then the server module
   * state. A chat or a group comes with all its members: a cached member
   * it does not carry (gone meanwhile) is dropped. A cached conversation the
   * server no longer lists (left or hidden meanwhile) is dropped, unless it is pinned locally, still being created
   * (createOpId), refused and not dismissed yet (createFailed) or still
   * holds a post waiting to go; a direct message, which
   * /mail/data leaves out while hidden, is kept with its history and marked
   * unpinned. A channel whose last message is above every
   * cached one and not cached itself may miss messages in between: its
   * history restarts (oldestLoadedId null, not complete), so the next
   * pages come down from the last message again and upsert the rows
   * already cached. A failed module probe keeps the
   * state stored before; any other failure propagates. Queued behind the
   * account's other server writers (see the class).
   */
  load(src: ChatSource): Promise<void> {
    return this.serial(src.configId, () => this.tracked(src.configId, () => this.loadNow(src)));
  }

  /** load() without the queue, for a task already running in it. */
  private async loadNow(src: ChatSource): Promise<void> {
    const { configId, creds } = src;
    const erased = this.erasedSince(configId);
    const startedAt = this.now().toISOString();
    const info = await this.rpc.sessionInfo(creds);
    if (erased()) return;
    const self = info.partnerId || null;
    await this.repo.setSourceState({
      configId,
      selfPartnerId: self,
      isSystem: info.isSystem,
      wsVersion: info.websocketWorkerVersion,
      internalUserGroupId: info.internalUserGroupId,
      isInternalUser: info.isInternalUser,
    });
    const result = await this.rpc.callWithAuth(creds, (sessionId) =>
      this.rpc.jsonRoute(creds.odooUrl, sessionId, "/mail/data", { init_messaging: {}, channels_as_member: true }));
    if (erased()) return;
    // Read fresh after /mail/data: a mute changed before the inbox bus id this load sets is in the
    // value, since its bus event, at or below that id, is no longer applied
    const fresh = await this.rpc.sessionInfo(creds, { fresh: true });
    const mute = fresh.globalMuteUntil;
    if (erased()) return;
    // The notification type has no bus event: each load reads it again
    await this.repo.setSourceState({ configId, notificationType: fresh.notificationType });
    const lastMuteAt = (await this.repo.sourceState(configId)).globalMuteAt;
    // A bus change newer than this load's start wins over the value read
    const muteIsStale = lastMuteAt !== null && lastMuteAt > startedAt;
    const delta = parseStore(result, configId, self);
    if (muteIsStale) delete delta.globalMuteUntil;
    else delta.globalMuteUntil = mute;
    const lastOf = new Map(delta.channels.map((c) => [c.channelId, c.lastMessageId]));
    const typeOf = new Map(delta.channels.map((c) => [c.channelId, c.channelType]));
    const carried = new Set(delta.members.map((m) => m.memberId));
    const gaps: number[] = [];
    for (const c of await this.repo.channels(configId)) {
      const cached = await this.repo.messages(configId, c.channelId);
      // Odoo sends every member of a chat or a group: a cached one it left out is no longer there
      if (lastOf.has(c.channelId) && ["chat", "group"].includes(typeOf.get(c.channelId) ?? c.channelType)) {
        for (const m of await this.repo.members(configId, c.channelId)) {
          if (m.memberId > 0 && !carried.has(m.memberId)) delta.deletedMemberIds.push(m.memberId);
        }
      }
      if (!lastOf.has(c.channelId)) {
        if (c.localPinned || c.createOpId !== null || c.createFailed || cached.some((m) => m.messageId === null)) continue;
        // A direct message is never left, only hidden: it stays cached with its history, unpinned
        if (c.channelType === "chat") {
          delta.channels.push({ channelId: c.channelId, isPinned: false });
          continue;
        }
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
    if (erased()) return;
    // What the phone already changed and still has to send wins over the server's older values; in one
    // exclusive() task with the write, so an action queued after the overlay read the ops is not written over
    await this.queue.exclusive(configId, async () => {
      await this.queue.overlayPending(configId, delta);
      await this.repo.applyDelta(configId, delta);
    });
    for (const channelId of gaps) {
      await this.repo.patchChannel(configId, channelId, { oldestLoadedId: null, historyComplete: false });
    }
    // Set, not raised: the server's bus ids restart from 0 when its bus table is emptied
    if (Number.isFinite(busId)) await this.repo.setSourceState({ configId, counterBusId: busId });

    let module: { state: ChatModuleState; level: ChatModuleLevel | null } | null = null;
    try {
      module = await moduleProbe(this.rpc, this.capabilities, creds, { online: true });
    } catch {
      // The state stored before stands
    }
    if (erased()) return;
    await this.repo.setSourceState({
      configId,
      ...(module ? { moduleState: module.state, moduleLevel: module.level } : {}),
      loadedAt: this.now().toISOString(),
    });
    this.changed(configId, null);
  }

  /**
   * A probe for the account's erasure: take it before an await on the
   * server, call it after; true when forgetSource ran meanwhile, so the
   * answer must not be written.
   */
  private erasedSince(configId: string): () => boolean {
    const gen = this.generations.get(configId) ?? 0;
    return () => (this.generations.get(configId) ?? 0) !== gen;
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
    return sortConversations(all, chatSettings().listOrder);
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
      const state = await this.repo.sourceState(id);
      const inbox = Math.max(0, state.inboxCounter - mentions);
      total += totalUnread(channels.filter(counted), [inbox], this.now(), state.globalMuteUntil);
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
   * Older pages, CHAT_FULL_PAGE per request (always `around`, see page),
   * while the loaded history starts above `messageId` and is not
   * complete; a page that brings nothing stops it. True when the message
   * is then cached within the loaded history (at or above oldestLoadedId,
   * or the history complete): a thread can render it. False when the
   * history no longer holds it (deleted) or the channel is not cached.
   * Nothing is marked read.
   */
  async loadUntil(src: ChatSource, channelId: number, messageId: number): Promise<boolean> {
    const { configId } = src;
    const reached = (c: ChatChannel) => c.historyComplete || (c.oldestLoadedId !== null && c.oldestLoadedId <= messageId);
    for (;;) {
      const channel = await this.repo.channel(configId, channelId);
      if (!channel) return false;
      if (reached(channel)) break;
      if ((await this.page(src, channelId, CHAT_FULL_PAGE)).fetched === 0) break;
    }
    const channel = await this.repo.channel(configId, channelId);
    return !!channel && reached(channel) && (await this.repo.message(configId, messageId)) !== null;
  }

  /**
   * Fetches the `size` messages below the oldest loaded one (below the
   * last known one + 1 when none is loaded). The request always uses
   * `around`: without it Odoo marks the fetched messages done, which clears
   * mentions. `around` also returns up to `size` newer messages; only the
   * ones at or below it, among those the answer's `messages` names, are this
   * page; the parents of its replies are cached without counting or moving
   * oldestLoadedId. Fewer than `size` means the start of
   * the history is reached. Returns the messages of the page (fetched) and
   * those of them not cached before (added). Queued behind the account's
   * other server writers (see the class).
   */
  private page(src: ChatSource, channelId: number, size: number): Promise<{ fetched: number; added: number }> {
    return this.serial(src.configId, () => this.pageNow(src, channelId, size));
  }

  private async pageNow(src: ChatSource, channelId: number, size: number): Promise<{ fetched: number; added: number }> {
    const { configId, creds } = src;
    const erased = this.erasedSince(configId);
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
    if (erased()) return { fetched: 0, added: 0 };
    const self = (await this.repo.sourceState(configId)).selfPartnerId;
    const delta = parseStore(result?.data, configId, self);
    const named = Array.isArray(result?.messages)
      ? new Set(result.messages.map((v: any) => (typeof v === "number" ? v : v?.id)))
      : null;
    const page = delta.messages.filter((m) =>
      m.messageId <= around && m.channelId === channelId && (named === null || named.has(m.messageId)));
    const parents = new Set(page.map((m) => m.parentId).filter((id): id is number => typeof id === "number"));
    delta.messages = delta.messages.filter((m) =>
      page.includes(m) || (parents.has(m.messageId) && m.channelId === channelId));
    let added = 0;
    for (const m of page) if (!(await this.repo.message(configId, m.messageId))) added++;
    // The user's actions still to be sent win over the server's older state; in one exclusive() task
    // with the write, so an action queued after the overlay read the ops is not written over
    await this.queue.exclusive(configId, async () => {
      await this.queue.overlayMessages(configId, delta);
      await this.repo.applyDelta(configId, delta);
    });
    const ids = page.map((m) => m.messageId);
    const patch: Partial<ChatChannel> = {};
    if (ids.length > 0) patch.oldestLoadedId = Math.min(...ids, channel.oldestLoadedId ?? Infinity);
    if (ids.length < size) patch.historyComplete = true;
    await this.repo.patchChannel(configId, channelId, patch);
    this.changed(configId, channelId);
    return { fetched: ids.length, added };
  }

  // ─── Send, read, typing ───────────────────────────────────────────────────

  /**
   * What the account's server supports, from the stored module level: member
   * removal needs a system user and module 1.1; an idempotent channel create
   * needs module 1.1 (message posts also work with 1.0); an idempotent
   * attachment upload needs module 1.2; a guarded edit, which checks the
   * body fingerprint, needs module 1.3; server search, an idempotent star and
   * an idempotent chatter post need module 1.4.
   */
  async features(configId: string): Promise<{
    canRemoveMembers: boolean;
    idempotentCreate: boolean;
    idempotentUpload: boolean;
    guardedEdit: boolean;
    serverSearch: boolean;
    idempotentStar: boolean;
    idempotentRecordPost: boolean;
  }> {
    const state = await this.repo.sourceState(configId);
    const at = (min: ChatModuleLevel) => this.moduleMode === "auto" && levelAtLeast(effectiveLevel(state), min);
    return {
      canRemoveMembers: state.isSystem && at("1.1"),
      idempotentCreate: at("1.1"),
      idempotentUpload: at("1.2"),
      guardedEdit: at("1.3"),
      serverSearch: at("1.4"),
      idempotentStar: at("1.4"),
      idempotentRecordPost: at("1.4"),
    };
  }

  /**
   * Queues the text and the files staged for it (under fileDirOf; the text
   * may be empty when files go), stored as a pending message before any
   * request, then, online, flushes the account's chat outbox at once: the
   * files upload in the background and the post follows them. Returns the
   * pending message; a failed flush leaves it queued for the next one.
   * draftText: the composer's text as the draft holds it, removed from the
   * draft with the post (ChatOutbox.queuePost). onQueued is called once
   * the post is queued, before the flush. mentions: the people and
   * channels picked in the composer; replyTo: the message it answers.
   */
  async send(
    src: ChatSource,
    channelId: number,
    text: string,
    files: OutgoingFile[] = [],
    opts: { draftText?: string; onQueued?: () => void; mentions?: Mentions; replyTo?: MessageTarget | null } = {},
  ): Promise<ChatMessage> {
    const { configId } = src;
    // Module 1.0 already dedupes message posts by uuid; only 1.1 adds channels
    const level = effectiveLevel(await this.repo.sourceState(configId));
    const useModule = this.moduleMode === "auto" && level !== null;
    const idempotentUpload = files.length > 0 && (await this.features(configId)).idempotentUpload;
    const message = await this.queue.queuePost(configId, channelId, text, useModule, {
      files, idempotentUpload, draftText: opts.draftText, mentions: opts.mentions, replyTo: opts.replyTo,
    });
    opts.onQueued?.();
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
   * Queues a reply in the chatter of the record of an inbox item
   * (ChatOutbox.queueRecordPost): an internal note by default, a message
   * to the record's followers with note false; text, picks and files
   * (staged under fileDirOf) as a conversation's post holds them. Module
   * 1.4 (features.idempotentRecordPost) sends the files by its upload
   * route and the reply with its client uuid. draftText: the composer's
   * text as the record's draft holds it, removed from it with the reply.
   * Online, the outbox is flushed at once: the files upload in the
   * background and the reply follows them; a failed flush leaves it
   * queued. Returns the reply's op.
   */
  async replyOnRecord(
    src: ChatSource,
    item: ChatMailboxItem,
    text: string,
    mentions: Mentions,
    files: OutgoingFile[],
    note = true,
    draftText?: string,
  ): Promise<OutboxOp> {
    const { configId } = src;
    const idempotent = (await this.features(configId)).idempotentRecordPost;
    const op = await this.queue.queueRecordPost(configId, item, text, mentions, files, note, { idempotent, draftText });
    this.changed(configId, null);
    if (await this.isOnline()) {
      try {
        await this.queue.flush(src.creds);
      } catch {
        // Kept in the outbox for the next flush
      }
      this.changed(configId, null);
    }
    return op;
  }

  /**
   * The replies on records of the account not sent yet (refused ones are
   * notices), by the inbox message they answer: text, note or message, how
   * many files.
   */
  pendingRecordReplies(configId: string): Promise<Map<number, { text: string; note: boolean; files: number }[]>> {
    return this.queue.pendingRecordReplies(configId);
  }

  // ─── Drafts ───────────────────────────────────────────────────────────────

  /**
   * The composer sends between their tap and their post queued, per
   * "configId#channelId" (sendStarted) or "configId#model#resId" of a
   * record (recordSendStarted).
   */
  private sendsRunning = new Map<string, Set<Promise<void>>>();

  /**
   * Marks a send of the conversation as running, from the composer's tap
   * (before its compress question) until its post is queued or refused:
   * call the function returned then (more calls do nothing). Meanwhile
   * draft() of that conversation waits, so a second screen never shows
   * again the text and the files a send is taking.
   */
  sendStarted(configId: string, channelId: number): () => void {
    return this.startSend(`${configId}#${channelId}`);
  }

  /**
   * sendStarted for the reply composer of a record: from the tap until the
   * reply is queued or refused, recordDraft() of that record waits.
   */
  recordSendStarted(configId: string, thread: RecordThread): () => void {
    return this.startSend(recordSendKey(configId, thread));
  }

  /** Registers one running send under `k` in sendsRunning; the function returned ends it, once. */
  private startSend(k: string): () => void {
    let end!: () => void;
    const running = new Promise<void>((resolve) => { end = resolve; });
    const set = this.sendsRunning.get(k) ?? new Set<Promise<void>>();
    set.add(running);
    this.sendsRunning.set(k, set);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      set.delete(running);
      if (set.size === 0 && this.sendsRunning.get(k) === set) this.sendsRunning.delete(k);
      end();
    };
  }

  /**
   * What the conversation's composer kept (ChatRepository.draftOf): its
   * text and its draft files in chip order, the message it answers, the
   * edit in progress and the picks, read once the sends of the conversation
   * still before their queue have ended (sendStarted). A file whose staged
   * copy is gone is dropped from the draft and its name given in `lost`. A
   * temporary id whose create settled reads the server's id, as every draft
   * call does (ChatOutbox.draftTask).
   */
  async draft(configId: string, channelId: number): Promise<ChatDraft & { lost: string[] }> {
    const real = (await this.realIdOf(configId, channelId)) ?? channelId;
    for (const id of new Set([channelId, real])) await Promise.all([...(this.sendsRunning.get(`${configId}#${id}`) ?? [])]);
    return this.queue.draftTask(configId, channelId, (id) => this.draftNow(configId, id));
  }

  /** draftOf of a conversation or a record, its files whose staged copy is gone dropped and named in `lost`. */
  private async draftNow(configId: string, where: number | DraftThread): Promise<ChatDraft & { lost: string[] }> {
    const { files, ...rest } = await this.repo.draftOf(configId, where);
    const kept: ChatAttachment[] = [];
    const lost: string[] = [];
    for (const f of files) {
      if (f.originalPath && (await this.queue.files.size(f.originalPath)) !== null) {
        kept.push(f);
        continue;
      }
      lost.push(f.name);
      await this.repo.removeDraftFile(configId, f.localUuid!);
    }
    return { ...rest, files: kept, lost };
  }

  /**
   * What the composer of a reply on a record kept: its text, picks and
   * draft files in chip order, as draft() reads a conversation's (a file
   * whose staged copy is gone dropped, named in `lost`), read once the
   * record's sends still before their queue have ended (recordSendStarted).
   */
  async recordDraft(configId: string, thread: RecordThread): Promise<ChatDraft & { lost: string[] }> {
    await Promise.all([...(this.sendsRunning.get(recordSendKey(configId, thread)) ?? [])]);
    return this.queue.draftTask(configId, null, () => this.draftNow(configId, draftThread(thread)));
  }

  /** Stores the text typed in a record's reply composer; "" with nothing else in the draft leaves no draft. */
  saveRecordDraftText(configId: string, thread: RecordThread, text: string): Promise<void> {
    return this.queue.draftTask(configId, null, () => this.repo.putDraftText(configId, draftThread(thread), text));
  }

  /** Stores the people and channels picked in a record's reply composer. */
  saveRecordDraftMentions(configId: string, thread: RecordThread, mentions: Mentions): Promise<void> {
    return this.queue.draftTask(configId, null, () => this.repo.putDraftMentions(configId, draftThread(thread), mentions));
  }

  /** Keeps a file staged in a record's reply composer as a draft file at chip position `seq`, with where it was taken. */
  keepRecordDraftFile(
    configId: string,
    thread: RecordThread,
    file: OutgoingFile,
    seq: number,
    origin: ChatFileOrigin | null = null,
  ): Promise<void> {
    return this.queue.draftTask(configId, null, () => this.repo.putDraftFile({
      ...this.draftFileRow(configId, 0, file, seq, origin),
      threadModel: thread.model,
      threadId: thread.resId,
    }));
  }

  /** Stores the text typed in a conversation's composer; "" with nothing else in the draft leaves no draft. */
  saveDraftText(configId: string, channelId: number, text: string): Promise<void> {
    return this.queue.draftTask(configId, channelId, (id) => this.repo.putDraftText(configId, id, text));
  }

  /** Stores the message the composer's text answers (Reply); null ends the reply. */
  saveDraftReply(configId: string, channelId: number, target: MessageTarget | null): Promise<void> {
    return this.queue.draftTask(configId, channelId, (id) => this.repo.putDraftReply(configId, id, target));
  }

  /** Stores the composer's edit in progress, its message and its text (Edit); null ends it. */
  saveDraftEdit(configId: string, channelId: number, edit: { target: MessageTarget; text: string } | null): Promise<void> {
    return this.queue.draftTask(configId, channelId, (id) => this.repo.putDraftEdit(configId, id, edit));
  }

  /** Stores the people and channels picked in the composer, those of the new message and of the edit together. */
  saveDraftMentions(configId: string, channelId: number, mentions: Mentions): Promise<void> {
    return this.queue.draftTask(configId, channelId, (id) => this.repo.putDraftMentions(configId, id, mentions));
  }

  /** Keeps a file staged in a conversation's composer as a draft file at chip position `seq`, with where it was taken. */
  keepDraftFile(
    configId: string,
    channelId: number,
    file: OutgoingFile,
    seq: number,
    origin: ChatFileOrigin | null = null,
  ): Promise<void> {
    return this.queue.draftTask(configId, channelId, (id) => this.repo.putDraftFile(this.draftFileRow(configId, id, file, seq, origin)));
  }

  /** The draft row of a staged file of a composer, at chip position `seq`. */
  private draftFileRow(configId: string, channelId: number, file: OutgoingFile, seq: number, origin: ChatFileOrigin | null): ChatAttachment {
    return {
      configId,
      channelId,
      messageId: null,
      attachmentId: null,
      localUuid: file.localUuid,
      postClientUuid: null,
      seq,
      name: file.name,
      mimetype: file.mimetype,
      size: file.size,
      checksum: null,
      voice: file.voice,
      thumbPath: null,
      thumbBytes: 0,
      originalPath: file.path,
      originalBytes: file.size,
      state: "draft",
      error: null,
      lastOpenedAt: null,
      createdAt: this.now().toISOString(),
      origin,
    };
  }

  /**
   * Removes a file from its conversation's draft (the chip's ✕) and deletes
   * its staged file with its out/<localUuid>/ directory, its row found or
   * not; a file already given to a post keeps its row and its file.
   */
  dropDraftFile(configId: string, file: OutgoingFile): Promise<void> {
    return this.queue.draftTask(configId, null, async () => {
      const row = await this.repo.outgoingFile(configId, file.localUuid);
      if (row && row.state !== "draft") return;
      await this.repo.removeDraftFile(configId, file.localUuid);
      await this.attachments.release([file.path]);
    });
  }

  /** Per conversation of the account with a draft: its text, how many files it keeps, an edit in progress (the list's line). */
  draftSummaries(configId: string): Promise<Map<number, { text: string; files: number; editing: boolean }>> {
    return this.queue.draftTask(configId, null, () => this.repo.draftSummaries(configId));
  }

  // ─── New conversations ────────────────────────────────────────────────────

  /**
   * Opens a direct message with a person. A cached chat with that
   * correspondent shown in the list (one still being created included) is
   * returned at once; a hidden one is shown again and channel_get is
   * queued to pin it on the server; otherwise a new chat is written under a
   * temporary id and channel_get queued. Online, the outbox is flushed at
   * once, and the server's id is returned when the create settled (see
   * QueuedOpts).
   */
  async startDirect(src: ChatSource, partnerId: number, opts: QueuedOpts = {}): Promise<{ configId: string; channelId: number }> {
    const { configId } = src;
    const chats = (await this.repo.channels(configId))
      .filter((c) => c.channelType === "chat" && c.isMember && c.correspondentPartnerId === partnerId)
      .sort((a, b) => ((a.lastInterestDt ?? "") < (b.lastInterestDt ?? "") ? 1 : -1));
    const open = chats.find(shown);
    if (open) return { configId, channelId: open.channelId };
    const hidden = chats[0];
    const channelId = hidden ? hidden.channelId : await this.repo.newTemporaryId(configId, this.now());
    await this.queue.queueCreate(configId, channelId, { mode: "dm", partnerIds: [partnerId], name: "", groupId: false, useModule: false });
    return this.afterQueued(src, channelId, opts);
  }

  /** Creates a group with these people (self is added by Odoo); see createConversation. */
  createGroup(src: ChatSource, partnerIds: number[], name = "", opts: QueuedOpts = {}): Promise<{ configId: string; channelId: number }> {
    return this.createConversation(src, "group", partnerIds, name, false, opts);
  }

  /** Creates a channel open to an access group (false: everyone); the name is required. */
  createChannel(
    src: ChatSource,
    name: string,
    groupId: number | false,
    opts: QueuedOpts = {},
  ): Promise<{ configId: string; channelId: number }> {
    if (!name.trim()) throw new Error("A channel needs a name.");
    return this.createConversation(src, "channel", [], name.trim(), groupId, opts);
  }

  /**
   * Writes the conversation under a temporary id and queues its create,
   * deduped by the server module 1.1 when installed (features), else by a
   * fingerprint after a lost answer. Online, the outbox is flushed at once,
   * and the server's id is returned when the create settled (see
   * QueuedOpts).
   */
  private async createConversation(
    src: ChatSource,
    mode: CreateMode,
    partnerIds: number[],
    name: string,
    groupId: number | false,
    opts: QueuedOpts,
  ): Promise<{ configId: string; channelId: number }> {
    const { configId } = src;
    const useModule = (await this.features(configId)).idempotentCreate;
    const channelId = await this.repo.newTemporaryId(configId, this.now());
    await this.queue.queueCreate(configId, channelId, { mode, partnerIds: [...new Set(partnerIds)], name, groupId, useModule });
    return this.afterQueued(src, channelId, opts);
  }

  /**
   * Joins a public channel through the outbox; `name` labels the cached row
   * while the server has not answered. Online, the outbox is flushed at
   * once (see QueuedOpts).
   */
  async join(src: ChatSource, channelId: number, name = "", opts: QueuedOpts = {}): Promise<{ configId: string; channelId: number }> {
    await this.queue.queueJoin(src.configId, channelId, name);
    return this.afterQueued(src, channelId, opts);
  }

  private async afterQueued(
    src: ChatSource,
    channelId: number,
    opts: QueuedOpts,
  ): Promise<{ configId: string; channelId: number }> {
    const { configId } = src;
    this.changed(configId, channelId);
    const flushed = (async () => {
      if (!(await this.isOnline())) return;
      try {
        await this.queue.flush(src.creds);
      } catch {
        // Kept in the outbox for the next flush
      }
      // The swap already told the screens; a create still waiting changed its row (attempts, a block)
      this.changed(configId, channelId);
    })();
    if (opts.background) {
      void flushed;
      return { configId, channelId };
    }
    await flushed;
    return { configId, channelId: (await this.realIdOf(configId, channelId)) ?? channelId };
  }

  /**
   * The server id of a conversation created under a temporary id, once its
   * create settled; null before, or for an id that was never temporary. A
   * screen open on the temporary id moves to it.
   */
  realIdOf(configId: string, tempId: number): Promise<number | null> {
    return this.queue.realIdOf(configId, tempId);
  }

  /**
   * Gives up a conversation still being created (or joined), or dismisses
   * one the server refused (createFailed) or one left with texts unsent
   * (leftUnsent): its rows leave the outbox (a leave stays) and it goes
   * from the cache with its unsent texts (ChatOutbox.discardCreate).
   * Queued behind the account's other writers: a create settled before it
   * is kept (nothing left to discard); one whose answer lands after it
   * writes nothing, and the next load brings what the server made.
   */
  discardCreate(configId: string, channelId: number): Promise<void> {
    return this.serial(configId, async () => {
      await this.queue.discardCreate(configId, channelId);
      await this.sweep(configId);
      this.changed(configId, null);
    });
  }

  // ─── Managing a conversation ──────────────────────────────────────────────

  /**
   * Flushes the account's chat outbox once an action is queued, when
   * online; a failed flush leaves it queued for the next one.
   */
  private async afterAction(src: ChatSource, channelId: number | null): Promise<void> {
    this.changed(src.configId, channelId);
    if (!(await this.isOnline())) return;
    try {
      await this.queue.flush(src.creds);
    } catch {
      // Kept in the outbox for the next flush
    }
    this.changed(src.configId, channelId);
  }

  /**
   * Invites people into a group or a channel the user is a member of. A
   * direct message takes no member: inviting there creates a group with
   * the correspondent and the people picked (createGroup), whose id is
   * returned; otherwise the conversation's own.
   */
  async invite(src: ChatSource, channelId: number, partnerIds: number[]): Promise<{ configId: string; channelId: number }> {
    const channel = await this.repo.channel(src.configId, channelId);
    if (channel?.channelType === "chat") {
      const people = [channel.correspondentPartnerId, ...partnerIds].filter((id): id is number => id != null);
      return this.createGroup(src, people);
    }
    await this.queue.queueInvite(src.configId, channelId, partnerIds);
    await this.afterAction(src, channelId);
    return { configId: src.configId, channelId };
  }

  /** Renames a conversation as Odoo's rules per type allow (see ChatOutbox.queueRename); rejects otherwise. */
  async rename(src: ChatSource, channelId: number, name: string): Promise<void> {
    await this.queue.queueRename(src.configId, channelId, name);
    await this.afterAction(src, channelId);
  }

  /** Changes the description of a group or channel. */
  async describe(src: ChatSource, channelId: number, description: string): Promise<void> {
    await this.queue.queueDescribe(src.configId, channelId, description);
    await this.afterAction(src, channelId);
  }

  /** Leaves a group or a channel (see ChatOutbox.queueLeave): out of the list at once, its queued texts not sent. */
  async leave(src: ChatSource, channelId: number): Promise<void> {
    await this.queue.queueLeave(src.configId, channelId);
    await this.sweep(src.configId);
    await this.afterAction(src, channelId);
  }

  /** Hides a direct message; its next message shows it again. */
  async hide(src: ChatSource, channelId: number): Promise<void> {
    await this.queue.queueHide(src.configId, channelId);
    await this.afterAction(src, channelId);
  }

  /**
   * The `until` an action queues for `minutes` of mute from now: -1 is
   * "forever", false or 0 unmutes.
   */
  private muteUntil(minutes: number | false): string | null {
    if (minutes === -1) return "forever";
    if (!minutes) return null;
    return new Date(this.now().getTime() + minutes * 60000).toISOString();
  }

  /**
   * Mutes a conversation the user is a member of for `minutes` (-1:
   * until turned back on; false: unmute); rejects for any other one, which
   * Odoo's mute route would join.
   */
  async mute(src: ChatSource, channelId: number, minutes: number | false): Promise<void> {
    await this.queue.queueMute(src.configId, channelId, this.muteUntil(minutes));
    await this.afterAction(src, channelId);
  }

  /**
   * Keeps a conversation on top of the list, or not. Local to the phone:
   * nothing is sent to the server. Rebuilds the list.
   */
  async setOnTop(configId: string, channelId: number, on: boolean): Promise<void> {
    await this.repo.setOnTop(configId, channelId, on, this.now());
    this.changed(configId, channelId);
  }

  /**
   * Switches the user's Odoo notifications from email to the inbox: a
   * write of the user's own `notification_type`, which Odoo lets a user
   * make on their own record. Online only, not an outbox operation: a
   * preference with an immediate answer. Then the type is read back fresh
   * and stored, so the notice goes away only if the server holds the
   * change. "offline": no network, or the request never left; "refused":
   * Odoo answered with an error (no right to write it, a portal user
   * whose type must stay email).
   */
  async switchToInbox(src: ChatSource): Promise<"done" | "offline" | "refused"> {
    const { configId, creds } = src;
    if (!(await this.isOnline())) return "offline";
    try {
      const { uid } = await this.rpc.sessionInfo(creds);
      await this.rpc.callKw(creds, "res.users", "write", [[uid], { notification_type: "inbox" }]);
    } catch (e: unknown) {
      if (e instanceof RequestNotSentError) return "offline";
      if (e instanceof OdooRpcError) return "refused";
      throw e;
    }
    const info = await this.rpc.sessionInfo(creds, { fresh: true });
    await this.repo.setSourceState({ configId, notificationType: info.notificationType });
    this.changed(configId, null);
    return "done";
  }

  /** Opens the user's own record (res.users) of the account in the web view, where the notification preference is. */
  async openPreferences(src: ChatSource): Promise<void> {
    const { uid } = await this.rpc.sessionInfo(src.creds);
    await openRecordInApp({
      label: src.label,
      appUrl: src.app.url,
      username: src.app.username,
      password: src.app.password,
      model: "res.users",
      resId: uid,
    });
  }

  /** Mutes every conversation of the account for `minutes`, as mute(). */
  async globalMute(src: ChatSource, minutes: number | false): Promise<void> {
    await this.queue.queueGlobalMute(src.configId, this.muteUntil(minutes));
    await this.afterAction(src, null);
  }

  /**
   * Removes another person from a group or a channel; rejects unless the
   * server allows it (features().canRemoveMembers: a system user and the
   * server module 1.1). A refusal of the server is a notice.
   */
  async removeMember(src: ChatSource, channelId: number, partnerId: number): Promise<void> {
    if (!(await this.features(src.configId)).canRemoveMembers) {
      throw new Error("Removing a member needs a system user and the server module 1.1.");
    }
    await this.queue.queueRemove(src.configId, channelId, partnerId);
    await this.afterAction(src, channelId);
  }

  /**
   * Turns the user's own reaction `content` on a message on or off (see
   * ChatOutbox.queueReaction): shown at once, sent when online. An emoji
   * put on counts toward the most used (countEmojiUse).
   */
  async react(src: ChatSource, channelId: number, target: MessageTarget, content: string, on: boolean): Promise<void> {
    await this.queue.queueReaction(src.configId, channelId, target, content, on);
    if (on) countEmojiUse(content);
    await this.afterAction(src, channelId);
  }

  /**
   * Edits the user's own message to `text` with the people and channels
   * picked (see ChatOutbox.queueEdit): shown at once, sent when online; a
   * message not sent yet takes the text into its post. An edit the server's
   * newer body refuses is a notice keeping the text (takeResume).
   * fromDraft: the edit is the composer's, and the draft's edit of that
   * message ends once it is queued. onQueued is called then, before the
   * flush. A kill between the two brings the edit mode back with the text
   * already queued; sending it again queues nothing more (the shown body
   * already reads that text).
   */
  async editMessage(
    src: ChatSource,
    channelId: number,
    target: MessageTarget,
    text: string,
    mentions: Mentions,
    opts: { fromDraft?: boolean; onQueued?: () => void } = {},
  ): Promise<void> {
    const { configId } = src;
    await this.queue.queueEdit(configId, channelId, target, text, mentions);
    if (opts.fromDraft) {
      try {
        await this.queue.draftTask(configId, channelId, (id) => this.repo.removeDraftEdit(configId, id, target));
      } catch (e: unknown) {
        console.warn("chat: an edit sent stays in the draft", e);
      }
    }
    opts.onQueued?.();
    await this.afterAction(src, channelId);
  }

  /**
   * Deletes the user's own message as Odoo does, its body and files
   * emptied (see ChatOutbox.queueDelete): hidden at once; a message not
   * sent yet is simply dropped with its files.
   */
  async deleteMessage(src: ChatSource, channelId: number, target: MessageTarget): Promise<void> {
    await this.queue.queueDelete(src.configId, channelId, target);
    await this.afterAction(src, channelId);
  }

  /**
   * Pins a sent message in its channel, or unpins it (see
   * ChatOutbox.queuePin): shown at once, sent when online.
   */
  async pin(src: ChatSource, channelId: number, target: MessageTarget, on: boolean): Promise<void> {
    await this.queue.queuePin(src.configId, channelId, target, on);
    await this.afterAction(src, channelId);
  }

  /**
   * The pinned messages of a channel, as « Messages épinglés » lists them.
   * Online the server's list (/discuss/channel/pinned_messages: a bare
   * Store, read-only, nothing marked read) is written first, in the
   * account's queue of server writers, with the pins still queued laid
   * over it (overlayMessages, in one exclusive() task with the write);
   * the channel's cached messages it does not name lose pinnedAt
   * (pinnedSets). A message below the loaded history is
   * cached and the thread does not show it as a row, as a reply's parent.
   * Offline, or when the request never left, the cache answers alone and
   * `offline` says so; another failure rejects. Then the cached pinned
   * messages, those emptied with no file or with a delete queued left out:
   * the unread ones first (unreadPin), then by pinnedAt, newest first, ties
   * by id as the browser sorts them.
   */
  async pinnedMessages(src: ChatSource, channelId: number): Promise<{ messages: ChatMessage[]; offline: boolean }> {
    const { configId, creds } = src;
    let offline = !(await this.isOnline());
    if (!offline) {
      try {
        await this.serial(configId, async () => {
          const erased = this.erasedSince(configId);
          const result = await this.rpc.callWithAuth(creds, (sessionId) =>
            this.rpc.jsonRoute(creds.odooUrl, sessionId, "/discuss/channel/pinned_messages", { channel_id: channelId }));
          if (erased()) return;
          const delta = parseStore(result, configId, (await this.repo.sourceState(configId)).selfPartnerId);
          // A reply's parent comes along in the Store: only the messages pinned are the list
          const messageIds = delta.messages.filter((m) => m.channelId === channelId && !!m.pinnedAt).map((m) => m.messageId);
          delta.pinnedSets = [{ channelId, messageIds }];
          await this.queue.exclusive(configId, async () => {
            await this.queue.overlayMessages(configId, delta);
            await this.repo.applyDelta(configId, delta);
          });
        });
        this.changed(configId, channelId);
      } catch (e: unknown) {
        if (!(e instanceof RequestNotSentError)) throw e;
        offline = true;
      }
    }
    const pinned = await this.repo.pinnedMessages(configId, channelId);
    const files = pinned.length
      ? await this.repo.attachmentsOf(configId, channelId, pinned.map((m) => m.messageId!), [])
      : new Map<string, ChatAttachment[]>();
    const deletes = (await this.db.getOutboxOpsForConfig(configId))
      .filter((o) => o.kind === CHAT_DELETE && o.status !== "blocked")
      .map(targetOf);
    const seen = (await this.repo.channel(configId, channelId))?.seenMessageId ?? null;
    const shown = pinned.filter((m) => !isEmptyMessage(m.body, files.get(messageKeyOf(m))?.length ?? 0)
      && !deletes.some((d) => sameTarget(d, m)));
    shown.sort((a, b) => Number(unreadPin(b, seen)) - Number(unreadPin(a, seen))
      || (a.pinnedAt === b.pinnedAt ? a.messageId! - b.messageId! : a.pinnedAt! < b.pinnedAt! ? 1 : -1));
    return { messages: shown, offline };
  }

  /**
   * Stars a message, or unstars it (see ChatOutbox.queueStar): shown at
   * once with the counter, sent when online. `channelId` names the
   * conversation of a channel message for the screens; null for a
   * record's message.
   */
  async star(src: ChatSource, messageId: number, on: boolean, channelId: number | null): Promise<void> {
    await this.queue.queueStar(src.configId, messageId, on, channelId);
    await this.afterAction(src, channelId);
  }

  /**
   * Marks inbox items read (ChatOutbox.queueInboxDone): moved to the
   * history at once with the counters, sent when online.
   */
  async markDone(src: ChatSource, messageIds: number[]): Promise<void> {
    await this.queue.queueInboxDone(src.configId, messageIds);
    await this.afterAction(src, null);
  }

  /**
   * « Tout marquer comme lu » for the account: every inbox item up to the
   * newest the phone shows (ChatInbox.maxShown), so a mention newer than
   * the tap stays unread; nothing when the inbox on the phone is empty.
   */
  async markAllDone(src: ChatSource): Promise<void> {
    const maxId = await this.inbox.maxShown(src.configId);
    if (maxId === null) return;
    await this.queue.queueInboxAll(src.configId, maxId);
    await this.afterAction(src, null);
  }

  /**
   * The starred messages of the given accounts as the phone holds them
   * (the mailbox rows flagged starred), a channel message emptied with no
   * file or with a delete queued left out: the unread first (a channel
   * message above its cached channel's seenMessageId, as unreadPin), then
   * the newest id.
   */
  async starred(configIds: string[]): Promise<ChatMailboxItem[]> {
    const out: { item: ChatMailboxItem; unread: boolean }[] = [];
    for (const configId of configIds) {
      const items = await this.repo.mailboxItems(configId, "starred");
      if (items.length === 0) continue;
      const deletes = (await this.db.getOutboxOpsForConfig(configId))
        .filter((o) => o.kind === CHAT_DELETE && o.status !== "blocked")
        .map(targetOf);
      // Per channel, its cached row: undefined when the channel is not cached, which leaves its messages read
      const channels = new Map<number, ChatChannel | undefined>();
      for (const item of items) {
        let unread = false;
        if (item.threadModel === CHANNEL_MODEL) {
          const message = await this.repo.message(configId, item.messageId);
          if (message && deletes.some((d) => sameTarget(d, message))) continue;
          if (message && isEmptyMessage(message.body, 0)) {
            const files = await this.repo.attachmentsOf(configId, message.channelId, [item.messageId], []);
            if (isEmptyMessage(message.body, files.get(`m${item.messageId}`)?.length ?? 0)) continue;
          }
          if (!channels.has(item.threadId)) channels.set(item.threadId, (await this.repo.channel(configId, item.threadId)) ?? undefined);
          const channel = channels.get(item.threadId);
          unread = !!channel && item.messageId > (channel.seenMessageId ?? 0);
        }
        out.push({ item, unread });
      }
    }
    out.sort((a, b) => Number(b.unread) - Number(a.unread) || b.item.messageId - a.item.messageId);
    return out.map((x) => x.item);
  }

  /**
   * Reads a page of the server's starred messages (/mail/starred/messages,
   * STARRED_PAGE of them below `before`; read-only, nothing marked read)
   * into the cache, in the account's queue of server writers, with the
   * stars still queued laid over it (overlayMessages): a record's message
   * as its mailbox row, a channel message as its mailbox row and, for a
   * cached channel, its chat message. A page proves the id range it
   * covers, from its smallest id (from 0 when it is shorter than asked) up
   * to `before`: a cached starred row in that range the page does not
   * list, with no chat.star op waiting, is unstarred, and starredCounter
   * loses one per row unstarred unless the page carries the server's
   * count, which is taken instead. The overlay, the write and the proof
   * run in one exclusive() task. Offline, or when the
   * request never left, nothing is read and `offline` says so; another
   * failure rejects. `oldestId` is the page's smallest id, the `before` of
   * the next page; `complete` says no older page exists.
   */
  async refreshStarred(src: ChatSource, before?: number): Promise<{ offline: boolean; oldestId: number | null; complete: boolean }> {
    const { configId, creds } = src;
    if (!(await this.isOnline())) return { offline: true, oldestId: null, complete: false };
    try {
      return await this.serial(configId, async () => {
        const erased = this.erasedSince(configId);
        const result = await this.rpc.callWithAuth(creds, (sessionId) =>
          this.rpc.jsonRoute(creds.odooUrl, sessionId, "/mail/starred/messages",
            { limit: STARRED_PAGE, ...(before !== undefined ? { before } : {}) }));
        if (erased()) return { offline: false, oldestId: null, complete: false };
        const parsed = parseStore(result?.data, configId, (await this.repo.sourceState(configId)).selfPartnerId);
        const ids: number[] = (Array.isArray(result?.messages) ? result.messages : [])
          .map((v: any) => (typeof v === "number" ? v : v?.id))
          .filter((v: any): v is number => typeof v === "number");
        const listed = new Set(ids);
        // A chat message row only in a cached channel: the page's messages of other channels are mailbox rows alone
        const kept = new Set<number>();
        for (const m of parsed.messages) {
          if (listed.has(m.messageId) && m.channelId !== undefined && (await this.repo.channel(configId, m.channelId))) kept.add(m.messageId);
        }
        const messages = parsed.messages.filter((m) => kept.has(m.messageId));
        const files = new Set(messages.flatMap((m) => m.attachmentIds ?? []));
        const delta: StoreDelta = {
          ...emptyDelta(),
          partners: parsed.partners,
          messages,
          attachments: parsed.attachments.filter((a) => files.has(a.attachmentId)),
          reactions: (parsed.reactions ?? []).filter((r) => kept.has(r.messageId)),
          reactionSets: (parsed.reactionSets ?? []).filter((r) => kept.has(r.messageId)),
          mailbox: [
            ...(parsed.mailbox ?? []).filter((m) => listed.has(m.messageId)).map((m) => ({ ...m, starred: true })),
            ...(mailboxPartialsOf(parsed, ids, { starred: true }) ?? []),
          ],
        };
        // A channel the Store does not name: its cached name stands for the record name
        for (const m of delta.mailbox!) {
          if (m.threadModel !== CHANNEL_MODEL || m.recordName) continue;
          const name = (await this.repo.channel(configId, m.threadId!))?.name;
          if (name) m.recordName = name;
        }
        // The server's count, when the page carries it, wins with the stars queued laid over it
        if (parsed.starredCounter != null) delta.starredCounter = parsed.starredCounter;
        const complete = ids.length < STARRED_PAGE;
        const low = complete ? 0 : Math.min(...ids);
        // One exclusive() task from the queued stars read to the last write: a star queued meanwhile comes after it
        await this.queue.exclusive(configId, async () => {
          await this.queue.overlayMessages(configId, delta);
          await this.repo.applyDelta(configId, delta);
          // The range the page proves: nothing starred in it but what it lists
          const waiting = new Set((await this.db.getOutboxOpsForConfig(configId))
            .filter((o) => o.kind === CHAT_STAR && o.status !== "blocked")
            .map((o) => o.params.messageId));
          let unstarred = 0;
          for (const item of await this.repo.mailboxItems(configId, "starred")) {
            const id = item.messageId;
            if (id >= low && (before === undefined || id < before) && !listed.has(id) && !waiting.has(id)) {
              await this.repo.setStarred(configId, id, false);
              unstarred++;
            }
          }
          // Without the server's count, the stored one loses the rows the page unstarred
          if (unstarred > 0 && delta.starredCounter == null) {
            const { starredCounter } = await this.repo.sourceState(configId);
            await this.repo.setSourceState({ configId, starredCounter: Math.max(0, starredCounter - unstarred) });
          }
        });
        return { offline: false, oldestId: ids.length > 0 ? Math.min(...ids) : null, complete };
      }).finally(() => this.changed(configId, null));
    } catch (e: unknown) {
      if (e instanceof RequestNotSentError) return { offline: true, oldestId: null, complete: false };
      throw e;
    }
  }

  /**
   * The text and picks the composer starts from to edit a message, null
   * when it is not cached. A message not sent yet, or one whose edit still
   * waits, gives the text and picks queued. A sent one gives its body as
   * the browser reads it back (bodyText); the partners are its recipients
   * by their cached names, as the browser's `message.recipients`, and the
   * channels the ones its body links by their cached names (a channel not
   * cached stays plain text).
   */
  async editDraftOf(configId: string, _channelId: number, target: MessageTarget): Promise<{ text: string; mentions: Mentions } | null> {
    const message = await this.repo.messageOf(configId, target);
    if (!message) return null;
    const named: MessageTarget = { messageId: message.messageId, clientUuid: message.clientUuid };
    const ops = await this.db.getOutboxOpsForConfig(configId);
    const post = message.messageId === null && message.outboxOpId ? ops.find((o) => o.id === message.outboxOpId) : undefined;
    const edits = ops.filter((o) => o.kind === CHAT_EDIT && o.status !== "blocked" && sameTarget(targetOf(o), named));
    // The waiting one holds the newest text; a running one the text it sends
    const edit = edits.find((o) => o.status !== "running") ?? edits[0];
    const queued = edit ?? post;
    if (queued) return { text: queued.params.text ?? "", mentions: queued.params.mentions ?? EMPTY_MENTIONS };
    const names = new Map((await this.repo.partners(configId)).map((p) => [p.partnerId, p.name]));
    const partners = (message.recipientIds ?? [])
      .filter((id) => !!names.get(id))
      .map((id) => ({ id, name: names.get(id)! }));
    const channels: Mentions["channels"] = [];
    for (const id of mentionAnchors(message.body).channels) {
      const c = await this.repo.channel(configId, id);
      if (!c?.name) continue;
      const parent = c.parentChannelId ? await this.repo.channel(configId, c.parentChannelId) : null;
      channels.push({ id, name: c.name, parentName: parent?.name || null });
    }
    return { text: bodyText(message.body), mentions: { partners, channels } };
  }

  /** Per account, the refused-edit notice whose « Reprendre » was tapped in the list, for its thread to take (takeResume). */
  private resumes = new Map<string, string>();

  /** Remembers that « Reprendre » was tapped on a refused-edit notice; the thread of its conversation then takes it. */
  requestResume(configId: string, noticeId: string): void {
    this.resumes.set(configId, noticeId);
  }

  /**
   * The refused edit whose « Reprendre » was asked (requestResume), when
   * it belongs to this conversation, taken once; null otherwise. `accept`,
   * when given, is asked first: false leaves the notice and forgets the
   * request. The text is stored in the draft before the notice goes, so it
   * is never only in memory: a message still cached and not deleted gets
   * it as the draft's edit (in place of the draft's own), a deleted or gone
   * one (also one emptied since the refusal: isEmptyMessage, `deleted`
   * then given to `accept` as true) joins it to the new message's text
   * (joinDraftText); the picks
   * join the draft's. A store that fails keeps the notice (the error is
   * thrown). The screen reads the draft again (draft()).
   */
  async takeResume(
    configId: string,
    channelId: number,
    accept?: (edit: NonNullable<ChatNotice["edit"]>) => Promise<boolean>,
  ): Promise<ChatNotice["edit"] | null> {
    const noticeId = this.resumes.get(configId);
    if (!noticeId) return null;
    const notice = (await this.queue.notices([configId])).find((n) => n.id === noticeId);
    if (!notice?.edit) {
      this.resumes.delete(configId);
      return null;
    }
    if (notice.channelId !== channelId) return null;
    this.resumes.delete(configId);
    const edit = { ...notice.edit, deleted: notice.edit.deleted || !(await this.editable(configId, notice.edit.target)) };
    if (accept && !(await accept(edit))) return null;
    await this.queue.draftTask(configId, channelId, async (id) => {
      const draft = await this.repo.draftOf(configId, id);
      const live = !edit.deleted && (await this.editable(configId, edit.target));
      if (live) await this.repo.putDraftEdit(configId, id, { target: edit.target, text: edit.text });
      else await this.repo.putDraftText(configId, id, joinDraftText(draft.text, edit.text));
      await this.repo.putDraftMentions(configId, id, joinMentions(draft.mentions, edit.mentions));
    });
    const taken = await this.queue.takeRefusedEdit(configId, noticeId);
    this.changed(configId, channelId);
    return taken;
  }

  /** Whether the message a target names is cached and not emptied (isEmptyMessage: deleted in Discuss). */
  private async editable(configId: string, target: MessageTarget): Promise<boolean> {
    const message = await this.repo.messageOf(configId, target);
    if (!message) return false;
    const key = messageKeyOf(message);
    const files = (await this.repo.attachmentsOf(configId, message.channelId,
      message.messageId === null ? [] : [message.messageId], message.clientUuid ? [message.clientUuid] : [])).get(key) ?? [];
    return !isEmptyMessage(message.body, files.length);
  }

  /** The cached reaction groups of the given message keys (messageKeyOf) of a channel, each list in the server's order. */
  async reactions(configId: string, channelId: number, keys: string[]): Promise<Map<string, ChatReaction[]>> {
    return this.repo.reactionsOf(configId, channelId, keys);
  }

  /**
   * The members of a conversation. Online, the ones not cached yet are
   * read from /discuss/channel/members (at most 100 per page, the cached
   * member ids sent as known) page after page, until the cache holds the
   * count the server gives or a page brings nobody new; each page is cached
   * with that count (memberCount), and the placeholder members of a
   * conversation created offline (negative ids) give way. When the cache
   * then holds more than that count, the members are read again from none
   * known and the ones the server no longer returns are dropped
   * (reconcileMembers). Offline, for a conversation only the phone knows,
   * or when a page fails, the cached members are returned.
   * Queued behind the account's other server writers.
   */
  async members(src: ChatSource, channelId: number): Promise<ChatMember[]> {
    const { configId } = src;
    if (channelId > 0 && (await this.isOnline())) {
      try {
        await this.serial(configId, () => this.membersNow(src, channelId));
      } catch (e) {
        console.warn("chat: members page failed", e);
      }
    }
    return this.repo.members(configId, channelId);
  }

  private async membersNow(src: ChatSource, channelId: number): Promise<void> {
    const { configId, creds } = src;
    const erased = this.erasedSince(configId);
    for (;;) {
      const known = (await this.repo.members(configId, channelId))
        .map((m) => m.memberId).filter((id) => id > 0).sort((a, b) => a - b);
      const result = await this.rpc.callWithAuth(creds, (sessionId) =>
        this.rpc.jsonRoute(creds.odooUrl, sessionId, "/discuss/channel/members", {
          channel_id: channelId,
          known_member_ids: known,
        }));
      if (erased()) return;
      const delta = parseStore(result, configId, await this.selfOf(configId));
      // A page answers for this channel only: the self member it may carry does not change membership elsewhere
      delta.members = delta.members.filter((m) => m.channelId === channelId);
      // The server's members replace the placeholders written while only the phone knew the conversation
      delta.deletedMemberIds = (await this.repo.members(configId, channelId)).map((m) => m.memberId).filter((id) => id < 0);
      delta.channels = delta.channels.filter((c) => c.channelId === channelId).map((c) => ({
        channelId, ...(c.memberCount !== undefined ? { memberCount: c.memberCount } : {}),
      }));
      const fresh = delta.members.filter((m) => !known.includes(m.memberId)).length;
      await this.repo.applyDelta(configId, delta);
      this.changed(configId, channelId);
      const count = (await this.repo.channel(configId, channelId))?.memberCount ?? null;
      if (fresh === 0 || count === null || known.length + fresh >= count) {
        if (count !== null && known.length + fresh > count) await this.reconcileMembers(src, channelId, erased);
        return;
      }
    }
  }

  /**
   * Reads the members of a channel again from none known, page after
   * page, until a page brings nobody new or the server's count is read,
   * then drops the cached members it did not return: the cache held more
   * than the server counts, so some left. A failed page drops nothing.
   */
  private async reconcileMembers(src: ChatSource, channelId: number, erased: () => boolean): Promise<void> {
    const { configId, creds } = src;
    const seen = new Set<number>();
    for (;;) {
      const result = await this.rpc.callWithAuth(creds, (sessionId) =>
        this.rpc.jsonRoute(creds.odooUrl, sessionId, "/discuss/channel/members", {
          channel_id: channelId,
          known_member_ids: [...seen].sort((a, b) => a - b),
        }));
      if (erased()) return;
      const delta = parseStore(result, configId, await this.selfOf(configId));
      delta.members = delta.members.filter((m) => m.channelId === channelId);
      delta.channels = delta.channels.filter((c) => c.channelId === channelId).map((c) => ({
        channelId, ...(c.memberCount !== undefined ? { memberCount: c.memberCount } : {}),
      }));
      const page = delta.members.filter((m) => !seen.has(m.memberId));
      for (const m of page) seen.add(m.memberId);
      await this.repo.applyDelta(configId, delta);
      const count = (await this.repo.channel(configId, channelId))?.memberCount ?? null;
      if (page.length === 0 || count === null || seen.size >= count) break;
    }
    const stale = (await this.repo.members(configId, channelId)).map((m) => m.memberId).filter((id) => id > 0 && !seen.has(id));
    if (stale.length === 0) return;
    await this.repo.applyDelta(configId, { ...emptyDelta(), deletedMemberIds: stale });
    this.changed(configId, channelId);
  }

  /**
   * Probes the server module again, skipping the capability cache, and
   * stores the state: a call of the module answered as a missing method
   * means the module is older or gone, so the features it gives go.
   */
  private async probeModule(configId: string): Promise<void> {
    const src = await this.sourceOf(configId);
    if (!src) return;
    const { state, level } = await moduleProbe(this.rpc, this.capabilities, src.creds, { online: true, fresh: true });
    await this.repo.setSourceState({ configId, moduleState: state, moduleLevel: level });
    this.changed(configId, null);
  }

  /** The actions the outbox gave up on for the given accounts (all live ones by default), until dismissed. */
  async notices(configIds?: string[]): Promise<ChatNotice[]> {
    return this.queue.notices(await this.configIds(configIds));
  }

  /** Dismisses a notice of notices(). */
  async dismissNotice(configId: string, id: string): Promise<void> {
    await this.queue.dismissNotice(configId, id);
    this.changed(configId, null);
  }

  /**
   * Startup repair of the chat outbox, after OutboxService.recoverInterrupted:
   * a create or join cut between its op and its row is queued, or removed
   * when its row is missing (ChatOutbox.recoverIncomplete); then every
   * account's files nothing needs go (ChatAttachmentCache.sweep), and the
   * staged directories no row names (sweepStaged: no composer is open yet).
   */
  async recover(): Promise<number> {
    const queued = await this.queue.recoverIncomplete();
    for (const configId of await this.db.getLiveSyncConfigIds()) {
      await this.sweep(configId);
      await this.attachments.sweepStaged(configId).catch((e) => console.warn("chat: sweep of staged files failed", e));
    }
    return queued;
  }

  /** Drops the account's files of the phone nothing needs any more; a failure is logged. */
  private async sweep(configId: string): Promise<void> {
    try {
      await this.attachments.sweep(configId);
    } catch (e: unknown) {
      console.warn("chat: sweep of unsent files failed", e);
    }
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
    // Odoo marked the author read on a post: nothing is left to tell it
    if (
      channel.seenMessageId !== null && channel.seenMessageId >= channel.lastMessageId
      && channel.unreadCounter === 0 && channel.needactionCounter === 0
    ) return;
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
      const channel = await this.repo.channel(src.configId, channelId);
      // A conversation the server does not have yet (or refused) has nobody to tell
      if (!channel?.isMember || channel.createOpId !== null || channel.createFailed || channelId <= 0) return;
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
   * Erases one account's chat from the phone: its bus stops, its rows
   * leave the outbox (posts not sent are lost), then its cache goes. It
   * does not wait for a request in flight: moving the account's generation
   * makes a load or a page answer that lands later discard itself, and a
   * post settled later finds its op gone. A second erase queued behind the
   * account's writers removes whatever a writer past its check still wrote,
   * unless the account was erased again or configured again meanwhile.
   */
  async forgetSource(configId: string): Promise<void> {
    this.stopSourceRealtime(configId);
    this.unknownReloadAt.delete(configId);
    this.generations.set(configId, (this.generations.get(configId) ?? 0) + 1);
    await this.erase(configId);
    const gen = this.generations.get(configId);
    this.serial(configId, async () => {
      // An account added again meanwhile owns its rows now: they stay
      if (this.generations.get(configId) !== gen || (await this.sourceOf(configId))) return;
      await this.erase(configId);
    }).catch((e) => console.warn("chat: second erase failed", e));
    this.changed(configId, null);
  }

  /**
   * Before the account's rows move from one config id to another (an edit
   * of the application): stops its running uploads, waits for them to
   * settle, and starts none under either id until resumeUploads. An
   * upload running across the move would write its result under the id
   * its rows no longer have, and its file would go up again.
   */
  async pauseUploads(oldConfigId: string, newConfigId: string): Promise<void> {
    await this.queue.pauseUploads([oldConfigId, newConfigId]);
  }

  /**
   * Once the rows moved (or the move failed): the uploads may start again,
   * and the account under its new id is flushed, not awaited, so the
   * stopped ones and those they held go on.
   */
  async resumeUploads(oldConfigId: string, newConfigId: string): Promise<void> {
    this.queue.resumeUploads([oldConfigId, newConfigId]);
    const source = await this.sourceOf(newConfigId);
    if (source) this.queue.flush(source.creds).catch((e) => console.warn("chat: flush after a rename failed", e));
  }

  /** The account's ops leave the outbox, then its files, then its rows. */
  private async erase(configId: string): Promise<void> {
    await this.queue.dropAll(configId);
    await this.attachments.erase(configId);
    await this.repo.dropSource(configId);
  }

  /**
   * Flushes the chat outbox of every application; one that fails does not
   * stop the others. force skips the retry delays (not a quiet window).
   * The originals held for Wi-Fi start then, not waited for.
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
    this.attachments.resumeWaiting().catch((e) => console.warn("chat: held downloads did not start", e));
  }

  // ─── Realtime ─────────────────────────────────────────────────────────────

  /**
   * Starts one ChatBus per source (the buses running before are stopped
   * first, so there is never more than one per account). The sources start
   * side by side: each is loaded, then its bus starts, so the bus catches
   * up from a fresh cache, and a slow or silent server holds back its own
   * bus only. A load that fails (server unreachable) does not hold its bus
   * back, which reconnects by itself. A stopRealtime during the start
   * cancels what has not started yet. The bus follows the presence of
   * presenceChannels(), read again at each subscribe; applyBus decides
   * when it subscribes again.
   */
  async startRealtime(transportFor: (configId: string) => BusTransport): Promise<void> {
    this.stopRealtime();
    this.transportFor = transportFor;
    const run = this.realtimeRun;
    const sources = await this.sources({ online: true });
    if (run !== this.realtimeRun) return;
    await Promise.all(sources.map((src) => this.startSource(src, run, transportFor)));
  }

  /**
   * Starts one account's bus alone, after a stop of it: the account is
   * read again from the application list (its credentials may have
   * changed), loaded, and its bus started, the other buses untouched. Does
   * nothing before startRealtime gave a transport, or for an account that
   * is not a source.
   */
  async startSourceRealtime(configId: string): Promise<void> {
    const transportFor = this.transportFor;
    if (!transportFor) return;
    this.stopSourceRealtime(configId);
    const run = this.realtimeRun;
    const src = (await this.sources({ online: true })).find((s) => s.configId === configId);
    if (!src || run !== this.realtimeRun) return;
    await this.startSource(src, run, transportFor);
  }

  /** Stops one account's bus, its start still loading and its owed reload; the others keep running. */
  stopSourceRealtime(configId: string): void {
    clearTimeout(this.unknownReloadOwed.get(configId));
    this.unknownReloadOwed.delete(configId);
    this.sourceRuns.set(configId, (this.sourceRuns.get(configId) ?? 0) + 1);
    this.buses.get(configId)?.stop();
    this.buses.delete(configId);
  }

  private async startSource(src: ChatSource, run: number, transportFor: (configId: string) => BusTransport): Promise<void> {
    const token = this.sourceRuns.get(src.configId) ?? 0;
    const current = () => run === this.realtimeRun && token === (this.sourceRuns.get(src.configId) ?? 0);
    try {
      await this.load(src);
    } catch (e) {
      console.warn("chat: load before realtime failed", e);
    }
    if (!current()) return;
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
      channels: () => this.presenceChannels(src.configId),
      deliver: (n) => this.applyBus(src.configId, n),
      reload: () => this.load(src),
    });
    try {
      bus.start();
    } catch (e) {
      // An insecure server (http without the option) gets no realtime
      console.warn("chat: realtime not started", e);
      return;
    }
    this.buses.get(src.configId)?.stop();
    this.buses.set(src.configId, bus);
  }

  /**
   * Sends the account's subscription again (ChatBus.resubscribe): the server
   * fixes the channels a socket receives at subscribe time, from the
   * memberships it has then. Nothing happens while its bus is not connected.
   */
  resubscribe(configId: string): void {
    this.buses.get(configId)?.resubscribe();
  }

  /** The channels of the account where self is a member, as noteMembershipChange compares them. */
  async memberChannelIds(configId: string): Promise<Set<number>> {
    return new Set((await this.repo.channels(configId)).filter((c) => c.isMember).map((c) => c.channelId));
  }

  /**
   * Resubscribes the account once when `after` (memberChannelIds once a
   * Store is applied) holds a member channel `before` did not, or lost one:
   * a new member gets no message of its channel before it subscribes
   * again, and a left channel would keep sending messages of a channel no
   * longer cached. Returns whether it resubscribed. An answer applied
   * outside applyBus and load (a create, a join) calls it itself.
   */
  noteMembershipChange(configId: string, before: Set<number>, after: Set<number>): boolean {
    const changed = before.size !== after.size || [...after].some((id) => !before.has(id));
    if (changed) this.resubscribe(configId);
    return changed;
  }

  /** Runs `task` between two reads of the memberships and resubscribes once when they differ. */
  private async tracked(configId: string, task: () => Promise<void>, force = false): Promise<void> {
    const before = await this.memberChannelIds(configId);
    await task();
    const after = await this.memberChannelIds(configId);
    if (!this.noteMembershipChange(configId, before, after) && force) this.resubscribe(configId);
  }

  /**
   * The presence channels the bus follows: every cached partner of the
   * account but self and those without a user (`im_partner`), as Odoo's
   * browser tracks every persona of its store. At most PRESENCE_CAP, ranked
   * by the last interest of the most recent conversation they are a member
   * or the correspondent of, then by partner id, higher first; a partner of
   * no cached conversation ranks last.
   */
  async presenceChannels(configId: string): Promise<string[]> {
    const self = await this.selfOf(configId);
    const channels = await this.repo.channels(configId);
    const interest = new Map(channels.map((c) => [c.channelId, c.lastInterestDt ?? ""]));
    const seen = new Map<number, string>();
    const see = (partnerId: number, dt: string) => {
      if ((seen.get(partnerId) ?? "") <= dt) seen.set(partnerId, dt);
    };
    for (const [channelId, members] of await this.repo.membersBySource(configId)) {
      for (const m of members) see(m.partnerId, interest.get(channelId) ?? "");
    }
    for (const c of channels) if (c.correspondentPartnerId != null) see(c.correspondentPartnerId, c.lastInterestDt ?? "");
    return (await this.repo.partners(configId))
      .filter((p) => p.partnerId !== self && p.imStatus !== "im_partner")
      .map((p) => ({ id: p.partnerId, dt: seen.get(p.partnerId) ?? "" }))
      .sort((a, b) => (a.dt === b.dt ? b.id - a.id : a.dt < b.dt ? 1 : -1))
      .slice(0, PRESENCE_CAP)
      .map((p) => `odoo-presence-res.partner_${p.id}`);
  }

  /** The network is back: every bus not connected tries at once (ChatBus.reconnectNow). */
  reconnectNow(): void {
    for (const bus of this.buses.values()) bus.reconnectNow();
  }

  /** Stops and forgets every bus; a start still loading and the owed reloads are cancelled. */
  stopRealtime(): void {
    this.realtimeRun++;
    for (const timer of this.unknownReloadOwed.values()) clearTimeout(timer);
    this.unknownReloadOwed.clear();
    for (const bus of this.buses.values()) bus.stop();
    this.buses.clear();
  }

  // ─── Bus ──────────────────────────────────────────────────────────────────

  /**
   * Applies bus notifications of one account in order. Each handled type
   * ends with onChange; an unknown type is ignored. See the class for the
   * bus id rule that guards the counters. Queued behind the account's other
   * server writers; a notification that reloads the account (a channel
   * joined, a message of an unknown channel) runs that load inline. The
   * bus resubscribes at most once per call: when the memberships differ
   * after it (noteMembershipChange), or after a channel joined.
   */
  applyBus(configId: string, notifications: BusNotification[]): Promise<void> {
    const joined = notifications.some((n) => n.message?.type === "discuss.channel/joined");
    return this.serial(configId, () => this.tracked(configId, () => this.applyBusNow(configId, notifications), joined));
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
        const delta = await this.applyStore(configId, p, fresh);
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
      case "discuss.channel/unpin": {
        // A direct message hidden: the next post pins it again ({id, is_pinned:true}, then the message)
        const channelId = Number(p.id);
        if (!fresh || !(await this.repo.channel(configId, channelId))) return undefined;
        await this.repo.patchChannel(configId, channelId, { isPinned: false });
        return channelId;
      }
      case "res.users.settings": {
        if (!fresh || !("mute_until_dt" in p)) return undefined;
        // fromBus stamps globalMuteAt: a load that began earlier does not write its older value over it
        await this.repo.applyDelta(configId, { ...emptyDelta(), globalMuteUntil: p.mute_until_dt || null }, { fromBus: true });
        return null;
      }
      case "discuss.channel/joined":
        await this.reload(configId);
        return typeof p.channel?.id === "number" ? p.channel.id : null;
      case "discuss.channel/leave":
      case "discuss.channel/delete": {
        const ids: number[] = (type === "discuss.channel/delete"
          ? [Number(p.id)]
          : (p[CHANNEL_MODEL] ?? []).map((c: any) => Number(c.id))).filter(Number.isInteger);
        // Nothing left to post to: the rows leave the outbox, their texts stay as not sent (see applyDelta);
        // actions the user still had for it leave a notice
        await this.queue.dropTaken(configId, ids);
        // Left by the user with texts unsent: kept, out of membership, until dismissed
        const kept: number[] = [];
        if (type === "discuss.channel/leave") {
          for (const id of ids) if ((await this.repo.channel(configId, id))?.leftUnsent) kept.push(id);
          for (const id of kept) await this.repo.patchChannel(configId, id, { isMember: false });
        }
        await this.repo.applyDelta(configId, { ...emptyDelta(), deletedChannelIds: ids.filter((id) => !kept.includes(id)) });
        await this.sweep(configId);
        return ids.length === 1 ? ids[0] : null;
      }
      case "mail.message/delete": {
        // mail.message.unlink sends it to the partners it notified; a delete in Discuss is an emptying edit instead
        const ids: number[] = (Array.isArray(p.message_ids) ? p.message_ids : []).map(Number).filter(Number.isInteger);
        const channels = new Set<number>();
        for (const id of ids) {
          const cached = await this.repo.message(configId, id);
          if (cached) channels.add(cached.channelId);
        }
        if (channels.size === 0) return undefined;
        await this.repo.applyDelta(configId, { ...emptyDelta(), deletedMessageIds: ids });
        return channels.size === 1 ? [...channels][0] : null;
      }
      case "ir.attachment/delete":
      {
        const id = Number(p.id);
        if (!Number.isInteger(id)) return undefined;
        const channelId = (await this.repo.attachmentChannel(configId, id)) ?? null;
        await this.repo.deleteAttachments(configId, [id]);
        return channelId;
      }
      case "mail.message/inbox":
        return this.applyInbox(configId, p, busId, fresh);
      case "mail.message/toggle_star":
        return this.applyToggleStar(configId, p, fresh);
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
   * not older than the stored one (see ChatRepository.applyDelta). Not
   * `fresh` (at or below counterBusId), a cached channel keeps its pin:
   * the load after that bus id read it, and a replay must not show a
   * hidden direct message again.
   */
  private async applyStore(configId: string, result: any, fresh: boolean): Promise<StoreDelta> {
    const delta = parseStore(result, configId, await this.selfOf(configId));
    const kept: StoreDelta["channels"] = [];
    for (const c of delta.channels) {
      const cached = await this.repo.channel(configId, c.channelId);
      if (cached && !fresh) delete c.isPinned;
      if (c.channelType !== undefined || cached) kept.push(c);
    }
    delta.channels = kept;
    // A replayed starred box (a delete's _cleanup_side_records) is older than the load that set the counter
    if (!fresh) delete delta.starredCounter;
    // The user's reactions still to be sent win over the server's older groups
    await this.queue.exclusive(configId, async () => {
      await this.queue.overlayMessages(configId, delta);
      await this.repo.applyDelta(configId, delta, { fromBus: true });
    });
    return delta;
  }

  /**
   * Reloads the account for a message of a channel it does not hold, at
   * most once per RELOAD_WINDOW_MS: a message inside the window leaves one
   * reload owed for its end, so a burst costs two loads and none is lost.
   * Runs inside a bus delivery, which already holds the account's queue.
   */
  private async reloadForUnknown(configId: string): Promise<void> {
    const now = this.now().getTime();
    const last = this.unknownReloadAt.get(configId);
    if (last === undefined || now - last >= RELOAD_WINDOW_MS) {
      this.unknownReloadAt.set(configId, now);
      await this.reload(configId);
      return;
    }
    if (this.unknownReloadOwed.has(configId)) return;
    this.unknownReloadOwed.set(configId, setTimeout(() => {
      this.unknownReloadOwed.delete(configId);
      this.unknownReloadAt.set(configId, this.now().getTime());
      this.serial(configId, () => this.tracked(configId, () => this.reload(configId)))
        .catch((e) => console.warn("chat: reload for an unknown channel failed", e));
    }, RELOAD_WINDOW_MS - (now - last)));
  }

  /** Loads the account from inside a bus delivery, which already holds its queue. */
  private async reload(configId: string): Promise<void> {
    const src = await this.sourceOf(configId);
    if (src) await this.loadNow(src);
  }

  /**
   * A new message in a channel. A channel the cache holds without self as
   * a member takes nothing; one the cache does not hold reloads the account
   * (reloadForUnknown). A post pins the channel for every member, as Odoo
   * does, so a hidden direct message shows again; a replay (not fresh)
   * leaves the pin as the last load read it. The message settles the
   * pending post whose client uuid is the payload's temporary_id. A
   * message of someone else, newer than the last known one, raises the
   * unread counter by one in any conversation type, the open one included,
   * as the browser's local counter does, unless the payload carries the
   * server's counter or the stored counter is as of this bus id or later.
   * Marking read, and the member record the server sends back, bring it
   * down again; a channel's unread still counts nowhere but in its bold
   * (unreadOf).
   */
  private async applyNewMessage(configId: string, p: any, busId: number, fresh: boolean): Promise<number | null | undefined> {
    const channelId = Number(p.id);
    const known = await this.repo.channel(configId, channelId);
    if (!known) {
      await this.reloadForUnknown(configId);
      return channelId;
    }
    if (!known.isMember) return undefined;
    const delta = await this.applyStore(configId, p.data, fresh);
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
      ...(fresh ? { isPinned: true } : {}),
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
   * Messages the user starred or unstarred, on any device (`fresh` only:
   * the load after a replayed one counted it). Each id's cached flags (the
   * chat message and its mailbox row) take the payload's value, with the
   * stars still queued laid over it (overlayMessages: a waiting op keeps
   * its target and takes the server's flag as its base). starredCounter
   * moves by one per id whose flag shown changed, and per id the phone
   * does not hold (a star from another device): the echo of the phone's
   * own star, shown since it was queued, counts nothing.
   */
  private async applyToggleStar(configId: string, p: any, fresh: boolean): Promise<number | null | undefined> {
    if (!fresh) return undefined;
    const ids: number[] = (Array.isArray(p.message_ids) ? p.message_ids : []).map(Number).filter(Number.isInteger);
    if (ids.length === 0) return undefined;
    const starred = !!p.starred;
    const channels = new Set<number>();
    // One exclusive() task from the flags read to the counter written: a star queued meanwhile comes after it
    await this.queue.exclusive(configId, async () => {
      const before = new Map<number, boolean | null>();
      for (const id of ids) {
        before.set(id, await this.queue.starredOf(configId, id));
        const message = await this.repo.message(configId, id);
        if (message) channels.add(message.channelId);
      }
      const delta: StoreDelta = { ...emptyDelta(), messages: ids.map((messageId) => ({ messageId, starred })) };
      await this.queue.overlayMessages(configId, delta);
      await this.repo.applyDelta(configId, delta, { fromBus: true });
      let change = 0;
      for (const m of delta.messages) {
        const was = before.get(m.messageId);
        if (was === null) change += starred ? 1 : -1;
        else if (was !== m.starred) change += m.starred ? 1 : -1;
      }
      if (change !== 0) {
        const { starredCounter } = await this.repo.sourceState(configId);
        await this.repo.setSourceState({ configId, starredCounter: Math.max(0, starredCounter + change) });
      }
    });
    return channels.size === 1 ? [...channels][0] : null;
  }

  /**
   * A message that needs the user's action, as the browser takes it: the
   * Store applied, its mailbox row flagged needaction (a record's from its
   * partial, a channel mention through mailboxPartialsOf, named by the
   * conversation), the inbox counter one up, and its channel's mentions one
   * up unless they are as of this bus id or later. A replay (not `fresh`)
   * applies the Store without its needaction flags and counts nothing: the
   * load after it holds the count, and the message may be read since.
   */
  private async applyInbox(configId: string, p: any, busId: number, fresh: boolean): Promise<number | null> {
    const payload = fresh || !Array.isArray(p?.["mail.message"])
      ? p
      : { ...p, "mail.message": p["mail.message"].map(({ needaction: _n, ...m }: any) => m) };
    const delta = await this.applyStore(configId, payload, fresh);
    const message = delta.messages.find((m) => m.channelId !== undefined);
    const channelId = message?.channelId ?? null;
    if (!fresh) return channelId;
    await this.queue.exclusive(configId, async () => {
      if (message) {
        const mention = mailboxPartialsOf(delta, [message.messageId], { needaction: true }) ?? [];
        for (const m of mention) {
          if (!m.recordName) m.recordName = (await this.repo.channel(configId, m.threadId!))?.name ?? "";
        }
        await this.repo.applyDelta(configId, { ...emptyDelta(), mailbox: mention });
      }
      const state = await this.repo.sourceState(configId);
      await this.repo.setSourceState({ configId, inboxCounter: state.inboxCounter + 1 });
      const channel = channelId !== null ? await this.repo.channel(configId, channelId) : null;
      if (channel && busId > channel.needactionCounterBusId) {
        await this.repo.patchChannel(configId, channel.channelId, { needactionCounter: channel.needactionCounter + 1 });
      }
    });
    return channelId;
  }

  /**
   * Messages whose needaction the user cleared, on any device, this one
   * included (a replay at or below counterBusId changes nothing). The
   * waiting inbox ops forget them (forgetCleared: the server's count no
   * longer holds them). A message whose mailbox row is absent or still in
   * the inbox counts: its row moves to the history, and its channel (its
   * cached message's, else its row's thread) loses one mention unless the
   * channel's mentions are as of this bus id or later. A row the phone
   * already moved (its own done, counted when queued) counts nothing, so
   * the phone's change and its echo lower the count once. The inbox
   * counter takes the server's value, with the inbox ops still queued laid
   * over it (overlayMessages). All of it in one exclusive() task.
   */
  private async applyMarkAsRead(configId: string, p: any, busId: number, fresh: boolean): Promise<number | null> {
    if (!fresh) return null;
    const ids: number[] = (Array.isArray(p.message_ids) ? p.message_ids : []).filter((id: any): id is number => typeof id === "number");
    const done = new Set(ids);
    const perChannel = new Map<number, number>();
    await this.queue.exclusive(configId, async () => {
      await this.queue.forgetCleared(configId, (id) => done.has(id));
      for (const id of ids) {
        const item = await this.repo.mailboxItem(configId, id);
        if (item && !item.needaction) continue;
        const m = await this.repo.message(configId, id);
        const channelId = m ? m.channelId : item?.threadModel === CHANNEL_MODEL ? item.threadId : null;
        if (item) await this.repo.patchMailbox(configId, id, { needaction: false, history: true });
        if (channelId !== null) perChannel.set(channelId, (perChannel.get(channelId) ?? 0) + 1);
      }
      for (const [channelId, n] of perChannel) {
        const channel = await this.repo.channel(configId, channelId);
        if (channel && busId > channel.needactionCounterBusId) {
          await this.repo.patchChannel(configId, channelId, { needactionCounter: Math.max(0, channel.needactionCounter - n) });
        }
      }
      if (typeof p.needaction_inbox_counter === "number") {
        const delta: StoreDelta = { ...emptyDelta(), inboxCounter: p.needaction_inbox_counter };
        await this.queue.overlayMessages(configId, delta);
        await this.repo.applyDelta(configId, delta);
      }
    });
    return perChannel.size === 1 ? [...perChannel.keys()][0] : null;
  }
}
