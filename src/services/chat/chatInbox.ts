import { mailboxKindOf, type ChatMailboxItem } from "../../models/chat";
import { openRecordInApp } from "../../utils/openRecordInApp";
import type { NoteLink } from "../databaseService";
import { RequestNotSentError, type OdooRpcClient } from "../odoo/odooRpcClient";
import type { ChatRepository } from "./chatRepository";
import type { ChatSource } from "./chatSources";
import { mailboxPartialsOf, parseStore, type StoreDelta } from "./chatStore";

/** How many messages a page of the inbox or the history asks for. */
export const INBOX_PAGE = 30;

const CHANNEL_MODEL = "discuss.channel";

/** The two boxes of Odoo's inbox screen: what waits for the user, and what the user read. */
export type InboxBox = "inbox" | "history";

/** What a page read: whether an older page may exist, whether the server was out of reach, its smallest id (the `before` of the next page). */
export interface InboxPage {
  more: boolean;
  offline: boolean;
  oldestId: number | null;
}

/** The outbox's part of a page: its exclusive() queue, the overlay of the queued ops, the inbox ops waiting. */
export interface InboxQueue {
  exclusive<T>(configId: string, task: () => Promise<T>): Promise<T>;
  overlayMessages(configId: string, delta: StoreDelta): Promise<void>;
  inboxWaiting(configId: string): Promise<{ covers: (messageId: number) => boolean }>;
  forgetCleared(configId: string, done: (messageId: number) => boolean): Promise<void>;
}

/**
 * The note of the phone that stands for a record (model, resId) of the
 * account: among its live links (remoteState "ok"), a "create" link names
 * the record by its own model and id, a "message" or an "activity" link by
 * the record it is on (params.resModel, params.resId). A create link comes
 * first, else the newest createdAt; null when no link names the record.
 */
export function noteForRecord(links: NoteLink[], configId: string, model: string, resId: number): NoteLink | null {
  const recordOf = (l: NoteLink) => (l.kind === "create"
    ? { model: l.model, resId: l.resId }
    : { model: l.params?.resModel, resId: l.params?.resId });
  const matching = links.filter((l) => {
    if (l.configId !== configId || l.remoteState !== "ok") return false;
    const r = recordOf(l);
    return r.model === model && r.resId === resId;
  });
  if (matching.length === 0) return null;
  return matching.find((l) => l.kind === "create")
    ?? [...matching].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))[0];
}

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
 * Odoo's inbox on the phone: the messages that wait for the user's action
 * (channel mentions, followed records' messages, assignments) and the
 * history of those read, cached in chat_mailbox. The pages come from the
 * read-only routes /mail/inbox/messages and /mail/history/messages: reading
 * them marks nothing read. Reading is the outbox's chat.inbox_done and
 * chat.inbox_all. ChatService points the hooks (serial, queue, erasedSince,
 * changed, noteLinks) at its own; their defaults run a page alone.
 */
export class ChatInbox {
  /** Runs a page in the account's queue of server writers (ChatService.serial). */
  serial: <T>(configId: string, task: () => Promise<T>) => Promise<T> = (_configId, task) => task();
  /** The outbox's part of a page; without one, nothing queued is laid over it. */
  queue: InboxQueue = {
    exclusive: (_configId, task) => task(),
    overlayMessages: async () => {},
    inboxWaiting: async () => ({ covers: () => false }),
    forgetCleared: async () => {},
  };
  /** A probe for the account's erasure, taken before the request (ChatService.erasedSince). */
  erasedSince: (configId: string) => () => boolean = () => () => false;
  /** Called once a page was written or failed: the screens rebuild. */
  changed: (configId: string) => void = () => {};
  /** The account's note links (DatabaseService.getNoteLinksForConfig); without one, no item has a note. */
  noteLinks: (configId: string) => Promise<NoteLink[]> = async () => [];

  constructor(
    private repo: ChatRepository,
    private rpc: OdooRpcClient,
    private isOnline: () => Promise<boolean>,
  ) {}

  /**
   * Reads a page of a box (INBOX_PAGE messages below `before`) into the
   * cache, in the account's queue of server writers. Every message the
   * page lists becomes a mailbox row flagged for its box (an inbox one
   * needaction, a history one history), a record's as its partial, a
   * channel message through mailboxPartialsOf, its name the Store's or the
   * cached channel's; a channel message also gets its chat_messages row
   * when its conversation is cached. The overlay of the queued ops
   * (overlayMessages: an inbox item a done waits for shows in the history)
   * and the write run in one exclusive() task. An inbox page proves its id
   * range, from its smallest id (from 0 when it is shorter than asked) up
   * to `before`: a cached inbox row there it does not list, with no inbox
   * op covering it, moves to the history, and the waiting ops forget the
   * ids it does not list (the server holds them read). A history page
   * makes them forget the ids it lists. Counters are left to the load and
   * the bus. Offline, or when the request never left, nothing is read and
   * `offline` says so; another failure rejects.
   */
  async refresh(src: ChatSource, box: InboxBox, before?: number): Promise<InboxPage> {
    const { configId, creds } = src;
    const none = (offline: boolean): InboxPage => ({ more: false, offline, oldestId: null });
    if (!(await this.isOnline())) return none(true);
    try {
      return await this.serial(configId, async () => {
        const erased = this.erasedSince(configId);
        const route = box === "inbox" ? "/mail/inbox/messages" : "/mail/history/messages";
        const result = await this.rpc.callWithAuth(creds, (sessionId) =>
          this.rpc.jsonRoute(creds.odooUrl, sessionId, route, { limit: INBOX_PAGE, ...(before !== undefined ? { before } : {}) }));
        if (erased()) return none(false);
        const parsed = parseStore(result?.data, configId, (await this.repo.sourceState(configId)).selfPartnerId);
        const ids: number[] = (Array.isArray(result?.messages) ? result.messages : [])
          .map((v: any) => (typeof v === "number" ? v : v?.id))
          .filter((v: any): v is number => typeof v === "number");
        const listed = new Set(ids);
        const flags: Partial<ChatMailboxItem> = box === "inbox" ? { needaction: true, history: false } : { needaction: false, history: true };
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
            ...(parsed.mailbox ?? []).filter((m) => listed.has(m.messageId)).map((m) => ({ ...m, ...flags })),
            ...(mailboxPartialsOf(parsed, ids, flags) ?? []),
          ],
        };
        // A channel the Store does not name: its cached name stands for the record name
        for (const m of delta.mailbox!) {
          if (m.threadModel !== CHANNEL_MODEL || m.recordName) continue;
          const name = (await this.repo.channel(configId, m.threadId!))?.name;
          if (name) m.recordName = name;
        }
        const complete = ids.length < INBOX_PAGE;
        const low = complete ? 0 : Math.min(...ids);
        const inRange = (id: number) => id >= low && (before === undefined || id < before);
        await this.queue.exclusive(configId, async () => {
          await this.queue.overlayMessages(configId, delta);
          await this.repo.applyDelta(configId, delta);
          if (box === "history") {
            await this.queue.forgetCleared(configId, (id) => listed.has(id));
            return;
          }
          // The range the page proves: nothing in the inbox there but what it lists
          const { covers } = await this.queue.inboxWaiting(configId);
          for (const item of await this.repo.mailboxItems(configId, "inbox")) {
            const id = item.messageId;
            if (inRange(id) && !listed.has(id) && !covers(id)) {
              await this.repo.patchMailbox(configId, id, { needaction: false, history: true });
            }
          }
          await this.queue.forgetCleared(configId, (id) => inRange(id) && !listed.has(id));
        });
        return { more: !complete, offline: false, oldestId: ids.length > 0 ? Math.min(...ids) : null };
      }).finally(() => this.changed(configId));
    } catch (e: unknown) {
      if (e instanceof RequestNotSentError) return none(true);
      throw e;
    }
  }

  /**
   * The cached items of a box of the given accounts: the newest date
   * first, then the newest id (an item without a date last).
   */
  async items(configIds: string[], box: InboxBox): Promise<ChatMailboxItem[]> {
    const all: ChatMailboxItem[] = [];
    for (const configId of configIds) all.push(...(await this.repo.mailboxItems(configId, box)));
    return all.sort((a, b) => {
      const da = a.date ?? "";
      const db = b.date ?? "";
      return da === db ? b.messageId - a.messageId : da < db ? 1 : -1;
    });
  }

  /** The newest message id in the account's inbox on the phone, the bound of « Tout marquer comme lu »; null when the inbox is empty. */
  async maxShown(configId: string): Promise<number | null> {
    const items = await this.repo.mailboxItems(configId, "inbox");
    return items.length > 0 ? Math.max(...items.map((i) => i.messageId)) : null;
  }

  /**
   * Opens an item, the same from the inbox, the history, the starred box
   * and the search. A mention of a conversation the phone holds opens its
   * thread at the message (`navigate`, /chat/<configId>/<channelId>?m=<id>).
   * A followed record's message or an assignment opens the phone's note
   * linked to the record (noteForRecord, /note/<noteId>). Anything else —
   * a record with no note, a mention whose conversation the phone dropped —
   * opens Odoo's /mail/message/<id> in the web view (openRecordInApp, its
   * http policy and login kept), which Odoo redirects to the record with
   * the message highlighted, or to Discuss when the record is out of the
   * user's reach. Nothing is marked read.
   */
  async openItem(src: ChatSource, item: ChatMailboxItem, navigate: (url: string) => void): Promise<void> {
    const { configId } = src;
    const kind = mailboxKindOf(item);
    if (kind === "mention" && (await this.repo.channel(configId, item.threadId))) {
      navigate("/chat/" + encodeURIComponent(configId) + "/" + item.threadId + "?m=" + item.messageId);
      return;
    }
    if (kind !== "mention") {
      const note = noteForRecord(await this.noteLinks(configId), configId, item.threadModel, item.threadId);
      if (note) {
        navigate("/note/" + encodeURIComponent(note.noteId));
        return;
      }
    }
    await openRecordInApp({
      label: item.recordName || src.label,
      appUrl: src.app.url,
      username: src.app.username,
      password: src.app.password,
      model: item.threadModel,
      resId: item.threadId,
      path: "/mail/message/" + item.messageId,
    });
  }
}
