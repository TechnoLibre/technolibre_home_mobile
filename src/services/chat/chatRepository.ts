import { v4 as uuidv4 } from "uuid";
import type { DatabaseService } from "../databaseService";
import type {
  ChatAttachment,
  ChatChannel,
  ChatMailboxItem,
  ChatMember,
  ChatMessage,
  ChatPartner,
  ChatReaction,
  ChatSourceState,
  MessageTarget,
  OutgoingFile,
} from "../../models/chat";
import { messageKeyOf, sameTarget } from "../../models/chat";
import { EMPTY_MENTIONS, type Mentions } from "./chatCompose";
import type { StoreDelta } from "./chatStore";
import { foldText, isEmptyBody, isEmptyMessage, searchTextOf } from "./chatBody";
import { likePattern, matchesTerm, termWords } from "./chatSearch";

type Row = Record<string, any>;

const bool = (v: any): boolean => v === 1 || v === true;
const flag = (v: boolean): number => (v ? 1 : 0);

/** The key of a row: `configId#<local key>`, so accounts never share a row. */
const key = (configId: string, local: string | number): string => `${configId}#${local}`;

/** The model of Discuss conversations: a channel message's thread in the mailbox. */
const CHANNEL_MODEL = "discuss.channel";

/** The key of a server attachment's row, as clearFiles takes it. */
export const attachmentKey = (configId: string, attachmentId: number): string => key(configId, `a${attachmentId}`);

function defined<T extends object>(p: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(p) as (keyof T)[]) {
    if (p[k] !== undefined) out[k] = p[k];
  }
  return out;
}

/** The keys of a row that carry a value: not null, "", 0 or [] (a column the source never filled). */
function meaningful<T extends object>(p: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(p) as (keyof T)[]) {
    const v = p[k];
    if (v !== undefined && v !== null && v !== "" && v !== 0 && !(Array.isArray(v) && v.length === 0)) out[k] = v;
  }
  return out;
}

/** A JSON object from a column; null for null or a value that does not parse as an object. */
function parseJson<T>(v: any): T | null {
  if (typeof v !== "string") return null;
  try {
    const out = JSON.parse(v);
    return out !== null && typeof out === "object" ? (out as T) : null;
  } catch {
    return null;
  }
}

/** Picks from a column: EMPTY_MENTIONS unless both lists are arrays, so a malformed row never reaches a builder. */
function mentionsOf(v: any): Mentions {
  const m = parseJson<Record<string, unknown>>(v);
  return m && Array.isArray(m.partners) && Array.isArray(m.channels) ? (m as unknown as Mentions) : EMPTY_MENTIONS;
}

/** A message target from a column: null unless it is an object. */
function storedTarget(v: any): MessageTarget | null {
  const t = parseJson<MessageTarget>(v);
  return t && !Array.isArray(t) ? t : null;
}

/**
 * What a conversation's composer keeps (ChatRepository.draftOf): the text
 * of a new message with its files and the message it answers, an edit in
 * progress, and the people and channels picked in either text.
 */
export interface ChatDraft {
  text: string;
  files: ChatAttachment[];
  replyTo: MessageTarget | null;
  edit: { target: MessageTarget; text: string } | null;
  mentions: Mentions;
}

/** The chat_drafts columns a draft write changes; the JSON ones as stored. */
type DraftRow = {
  text: string;
  reply_to: string | null;
  edit_of: string | null;
  edit_text: string | null;
  mentions: string | null;
};

/** A JSON list of ids from a column; [] for null or a value that is not one. */
function idList(v: any): number[] {
  if (typeof v !== "string") return [];
  try {
    const out = JSON.parse(v);
    return Array.isArray(out) ? out.filter((x) => typeof x === "number") : [];
  } catch {
    return [];
  }
}

function maxOf(a: number | null | undefined, b: number | null | undefined): number | null {
  if (a == null) return b ?? null;
  if (b == null) return a;
  return Math.max(a, b);
}

function minOf(a: number | null | undefined, b: number | null | undefined): number | null {
  if (a == null) return b ?? null;
  if (b == null) return a;
  return Math.min(a, b);
}

type CounterKey = "unreadCounter" | "needactionCounter";
type MarkKey = "unreadCounterBusId" | "needactionCounterBusId";

/**
 * Decides whether a server counter of a channel partial replaces the
 * stored one. An authoritative read (/mail/data, a request's answer) is
 * always taken, its bus id too even below the stored mark: the server's
 * bus ids start again from 0 when its bus table is emptied or the database
 * is replaced, and a read is the server's present state. From the bus, a
 * counter is taken only with a bus id at or above the stored mark, which
 * then follows it; an older one, or one without a bus id, is dropped. A
 * bus id without its counter moves nothing.
 */
function gateCounter(
  patch: Partial<ChatChannel>,
  base: ChatChannel,
  counter: CounterKey,
  mark: MarkKey,
  fromBus: boolean,
): void {
  const busId = patch[mark];
  if (patch[counter] === undefined) {
    delete patch[mark];
  } else if (fromBus && (busId === undefined || busId < base[mark])) {
    delete patch[counter];
    delete patch[mark];
  }
}

function channelFromRow(r: Row): ChatChannel {
  return {
    configId: r.config_id,
    channelId: r.channel_id,
    channelType: r.channel_type,
    name: r.name,
    description: r.description,
    lastInterestDt: r.last_interest_dt ?? null,
    unreadCounter: r.unread_counter,
    needactionCounter: r.needaction_counter,
    newMessageSeparator: r.new_message_separator,
    seenMessageId: r.seen_message_id ?? null,
    muteUntilDt: r.mute_until_dt ?? null,
    customNotifications: r.custom_notifications ?? null,
    isMember: bool(r.is_member),
    localPinned: bool(r.local_pinned),
    lastMessageId: r.last_message_id ?? null,
    oldestLoadedId: r.oldest_loaded_id ?? null,
    historyComplete: bool(r.history_complete),
    correspondentPartnerId: r.correspondent_partner_id ?? null,
    unreadCounterBusId: r.unread_counter_bus_id ?? 0,
    needactionCounterBusId: r.needaction_counter_bus_id ?? 0,
    isPinned: r.is_pinned == null ? true : bool(r.is_pinned),
    isEditable: r.is_editable == null ? null : bool(r.is_editable),
    customChannelName: r.custom_channel_name ?? null,
    memberCount: r.member_count ?? null,
    groupPublicId: r.group_public_id ?? null,
    authorizedGroupFullName: r.authorized_group_full_name ?? null,
    createUid: r.create_uid ?? null,
    groupBasedSubscription: bool(r.group_based_subscription),
    parentChannelId: r.parent_channel_id ?? null,
    createOpId: r.create_op_id ?? null,
    createFailed: bool(r.create_failed),
    leftUnsent: bool(r.left_unsent),
  };
}

function messageFromRow(r: Row): ChatMessage {
  return {
    configId: r.config_id,
    channelId: r.channel_id,
    messageId: r.message_id ?? null,
    clientUuid: r.client_uuid ?? null,
    authorPartnerId: r.author_partner_id ?? null,
    body: r.body,
    date: r.date,
    messageType: r.message_type,
    status: r.status,
    outboxOpId: r.outbox_op_id ?? null,
    writeDate: r.write_date ?? null,
    parentId: r.parent_id ?? null,
    parentClientUuid: r.parent_client_uuid ?? null,
    recipientIds: idList(r.recipient_ids),
    pinnedAt: r.pinned_at ?? null,
    starred: bool(r.starred),
  };
}

function reactionFromRow(r: Row): ChatReaction {
  return {
    configId: r.config_id,
    channelId: r.channel_id,
    messageKey: r.message_key,
    messageId: r.message_id ?? null,
    content: r.content,
    count: r.count,
    selfReacted: bool(r.self_reacted),
    partnerIds: idList(r.partner_ids),
    guestCount: r.guest_count ?? 0,
    sequence: r.sequence,
  };
}

function reactionRow(r: ChatReaction): Row {
  return {
    id: key(r.configId, `${r.messageKey}#${r.content}`),
    config_id: r.configId,
    channel_id: r.channelId,
    message_key: r.messageKey,
    message_id: r.messageId,
    content: r.content,
    count: r.count,
    self_reacted: flag(r.selfReacted),
    partner_ids: JSON.stringify(r.partnerIds),
    guest_count: r.guestCount,
    sequence: r.sequence,
  };
}

function attachmentFromRow(r: Row): ChatAttachment {
  return {
    configId: r.config_id,
    channelId: r.channel_id,
    messageId: r.message_id ?? null,
    attachmentId: r.attachment_id ?? null,
    localUuid: r.local_uuid ?? null,
    postClientUuid: r.post_client_uuid ?? null,
    seq: r.seq ?? 0,
    name: r.name,
    mimetype: r.mimetype,
    size: r.size ?? 0,
    checksum: r.checksum ?? null,
    voice: bool(r.voice),
    thumbPath: r.thumb_path ?? null,
    thumbBytes: r.thumb_bytes ?? 0,
    originalPath: r.original_path ?? null,
    originalBytes: r.original_bytes ?? 0,
    state: r.state,
    error: r.error ?? null,
    lastOpenedAt: r.last_opened_at ?? null,
    createdAt: r.created_at,
    origin: r.origin ?? null,
  };
}

/** The paths of the files an attachment row holds on the phone. */
function pathsOf(a: ChatAttachment): string[] {
  return [a.thumbPath, a.originalPath].filter((p): p is string => !!p);
}

/** Files by `seq`, then by server id: the order they were picked in. */
function bySeq(a: ChatAttachment, b: ChatAttachment): number {
  return a.seq - b.seq || (a.attachmentId ?? 0) - (b.attachmentId ?? 0);
}

function memberFromRow(r: Row): ChatMember {
  return {
    configId: r.config_id,
    channelId: r.channel_id,
    memberId: r.member_id,
    partnerId: r.partner_id,
    seenMessageId: r.seen_message_id ?? null,
    fetchedMessageId: r.fetched_message_id ?? null,
    isTyping: bool(r.is_typing),
    typingAt: r.typing_at ?? null,
    createDate: r.create_date ?? null,
  };
}

function sourceFromRow(r: Row): ChatSourceState {
  return {
    configId: r.config_id,
    selfPartnerId: r.self_partner_id ?? null,
    lastBusId: r.last_bus_id,
    busSeenAt: r.bus_seen_at ?? null,
    wsVersion: r.ws_version ?? null,
    isSystem: bool(r.is_system),
    moduleState: r.module_state,
    inboxCounter: r.inbox_counter,
    loadedAt: r.loaded_at ?? null,
    counterBusId: r.counter_bus_id ?? 0,
    internalUserGroupId: r.internal_user_group_id ?? null,
    globalMuteUntil: r.global_mute_until ?? null,
    globalMuteAt: r.global_mute_at ?? null,
    isInternalUser: bool(r.is_internal_user),
    fileDir: r.file_dir ?? null,
    moduleLevel: r.module_level ?? null,
    starredCounter: r.starred_counter ?? 0,
    notificationType: r.notification_type === "email" || r.notification_type === "inbox" ? r.notification_type : null,
  };
}

function mailboxFromRow(r: Row): ChatMailboxItem {
  return {
    configId: r.config_id,
    messageId: r.message_id,
    threadModel: r.thread_model,
    threadId: r.thread_id,
    recordName: r.record_name ?? "",
    authorPartnerId: r.author_partner_id ?? null,
    body: r.body ?? "",
    date: r.date ?? null,
    messageType: r.message_type ?? "",
    needaction: bool(r.needaction),
    starred: bool(r.starred),
    history: bool(r.history),
  };
}

/** The shortest word the trigram index of chat_search_fts can look up. */
const TRIGRAM = 3;

/** A message with a server id sorts by it; a pending one (no id) sorts last, by date. */
function byThread(a: ChatMessage, b: ChatMessage): number {
  if (a.messageId !== null && b.messageId !== null) return a.messageId - b.messageId;
  if (a.messageId !== null) return -1;
  if (b.messageId !== null) return 1;
  return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
}

/**
 * SQLite cache of the chat: channels, messages, members, partners and the
 * per-source sync state. A store delta carries partial records, so every
 * upsert reads the stored row, overlays the keys the partial carries and
 * writes the whole row back. Most queries are equality lookups, ordered
 * and paged here; the aggregates, adoptOutgoing and the searches
 * (searchMessages, searchMailbox) run in SQLite.
 */
export class ChatRepository {
  /**
   * Called with the file paths of rows this repository dropped, so whoever
   * owns the files can delete them. A no-op until wired.
   */
  onFilesReleased: (paths: string[]) => void | Promise<void> = () => {};

  /** `clock` stamps the rows' updated_at (the service's clock, a test's). */
  constructor(private db: DatabaseService, private clock: () => Date = () => new Date()) {}

  private async release(paths: string[]): Promise<void> {
    if (paths.length > 0) await this.onFilesReleased(paths);
  }

  private now(): string {
    return this.clock().toISOString();
  }

  private async rows(table: string, where: Row): Promise<Row[]> {
    const cols = Object.keys(where);
    const sql = `SELECT * FROM ${table} WHERE ${cols.map((c) => `${c} = ?`).join(" AND ")}`;
    return this.db.rawQuery(sql, cols.map((c) => where[c]));
  }

  private async row(table: string, id: string): Promise<Row | null> {
    return (await this.rows(table, { id }))[0] ?? null;
  }

  private async put(table: string, row: Row): Promise<void> {
    const cols = Object.keys(row);
    await this.db.rawRun(
      `INSERT OR REPLACE INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
      cols.map((c) => row[c]),
    );
  }

  private async del(table: string, where: Row): Promise<void> {
    const cols = Object.keys(where);
    await this.db.rawRun(
      `DELETE FROM ${table} WHERE ${cols.map((c) => `${c} = ?`).join(" AND ")}`,
      cols.map((c) => where[c]),
    );
  }

  private channelRow(c: ChatChannel): Row {
    return {
      id: key(c.configId, c.channelId),
      config_id: c.configId,
      channel_id: c.channelId,
      channel_type: c.channelType,
      name: c.name,
      description: c.description,
      last_interest_dt: c.lastInterestDt,
      unread_counter: c.unreadCounter,
      needaction_counter: c.needactionCounter,
      new_message_separator: c.newMessageSeparator,
      seen_message_id: c.seenMessageId,
      mute_until_dt: c.muteUntilDt,
      custom_notifications: c.customNotifications,
      is_member: flag(c.isMember),
      local_pinned: flag(c.localPinned),
      last_message_id: c.lastMessageId,
      oldest_loaded_id: c.oldestLoadedId,
      history_complete: flag(c.historyComplete),
      correspondent_partner_id: c.correspondentPartnerId,
      updated_at: this.now(),
      unread_counter_bus_id: c.unreadCounterBusId,
      needaction_counter_bus_id: c.needactionCounterBusId,
      is_pinned: flag(c.isPinned),
      is_editable: c.isEditable === null ? null : flag(c.isEditable),
      custom_channel_name: c.customChannelName,
      member_count: c.memberCount,
      group_public_id: c.groupPublicId,
      authorized_group_full_name: c.authorizedGroupFullName,
      create_uid: c.createUid,
      group_based_subscription: flag(c.groupBasedSubscription),
      parent_channel_id: c.parentChannelId,
      create_op_id: c.createOpId,
      create_failed: flag(c.createFailed),
      left_unsent: flag(c.leftUnsent),
    };
  }

  /**
   * The row of a message. Every message write goes through here, so
   * search_text always holds the folded text of the body it is written with.
   */
  private messageRow(m: ChatMessage): Row {
    return {
      id: key(m.configId, messageKeyOf(m)),
      config_id: m.configId,
      channel_id: m.channelId,
      message_id: m.messageId,
      client_uuid: m.clientUuid,
      author_partner_id: m.authorPartnerId,
      body: m.body,
      date: m.date,
      message_type: m.messageType,
      status: m.status,
      outbox_op_id: m.outboxOpId,
      write_date: m.writeDate,
      parent_id: m.parentId ?? null,
      parent_client_uuid: m.parentClientUuid ?? null,
      recipient_ids: JSON.stringify(m.recipientIds ?? []),
      search_text: searchTextOf(m.body),
      pinned_at: m.pinnedAt ?? null,
      starred: flag(!!m.starred),
    };
  }

  /**
   * The row of a mailbox item. Every write of chat_mailbox goes through
   * here, so search_text always holds the folded record name and body text
   * it is written with.
   */
  private mailboxRow(i: ChatMailboxItem): Row {
    return {
      id: key(i.configId, `m${i.messageId}`),
      config_id: i.configId,
      message_id: i.messageId,
      thread_model: i.threadModel,
      thread_id: i.threadId,
      record_name: i.recordName,
      author_partner_id: i.authorPartnerId,
      body: i.body,
      date: i.date,
      message_type: i.messageType,
      needaction: flag(i.needaction),
      starred: flag(i.starred),
      history: flag(i.history),
      search_text: `${foldText(i.recordName)} ${searchTextOf(i.body)}`,
    };
  }

  private attachmentRow(a: ChatAttachment): Row {
    // A file still on its way to a message keeps its local key even once the server gave it an id
    const local = a.localUuid !== null && a.state !== "posted" ? `l${a.localUuid}` : `a${a.attachmentId}`;
    return {
      id: key(a.configId, local),
      config_id: a.configId,
      channel_id: a.channelId,
      message_id: a.messageId,
      attachment_id: a.attachmentId,
      local_uuid: a.localUuid,
      post_client_uuid: a.postClientUuid,
      seq: a.seq,
      name: a.name,
      mimetype: a.mimetype,
      size: a.size,
      checksum: a.checksum,
      voice: flag(a.voice),
      thumb_path: a.thumbPath,
      thumb_bytes: a.thumbBytes,
      original_path: a.originalPath,
      original_bytes: a.originalBytes,
      state: a.state,
      error: a.error,
      last_opened_at: a.lastOpenedAt,
      created_at: a.createdAt,
      origin: a.origin ?? null,
    };
  }

  private memberRow(m: ChatMember): Row {
    return {
      id: key(m.configId, m.memberId),
      config_id: m.configId,
      channel_id: m.channelId,
      member_id: m.memberId,
      partner_id: m.partnerId,
      seen_message_id: m.seenMessageId,
      fetched_message_id: m.fetchedMessageId,
      is_typing: flag(m.isTyping),
      typing_at: m.typingAt,
      create_date: m.createDate,
    };
  }

  private sourceRow(s: ChatSourceState): Row {
    return {
      config_id: s.configId,
      self_partner_id: s.selfPartnerId,
      last_bus_id: s.lastBusId,
      bus_seen_at: s.busSeenAt,
      ws_version: s.wsVersion,
      is_system: flag(s.isSystem),
      module_state: s.moduleState,
      inbox_counter: s.inboxCounter,
      loaded_at: s.loadedAt,
      counter_bus_id: s.counterBusId,
      internal_user_group_id: s.internalUserGroupId,
      global_mute_until: s.globalMuteUntil,
      global_mute_at: s.globalMuteAt,
      is_internal_user: flag(s.isInternalUser),
      file_dir: s.fileDir,
      module_level: s.moduleLevel,
      starred_counter: s.starredCounter,
      notification_type: s.notificationType,
    };
  }

  /**
   * Applies a store delta: upserts first, then deletions, so a record both
   * upserted and deleted in one delta ends deleted. A channel deletion takes
   * its members and server messages with it; the messages it still had to
   * post stay, as failed and detached from the outbox, so the text typed is
   * not lost (the conversation screen shows them). Channel counters follow
   * gateCounter; `fromBus` says the delta comes from a bus delivery, where
   * a counter without its bus id is not taken. Attachment rows take the
   * server's fields only; a message listing attachment ids claims those rows
   * and releases the ones it no longer lists, and a deleted channel drops its
   * rows (its draft included) but the files still waiting to be sent.
   * Reactions follow the messages: a full set drops the message's groups it
   * does not name, a group replaces its own, a deletion removes one; a group
   * of a message not cached is not stored. A deleted message goes with its
   * reactions and its server files; a deleted channel drops its reactions.
   * A channel's pinned list (pinnedSets) unpins its cached messages it
   * does not name, after the messages are written.
   */
  async applyDelta(configId: string, d: StoreDelta, opts: { fromBus?: boolean } = {}): Promise<void> {
    for (const p of d.channels) await this.upsertChannel(configId, p, !!opts.fromBus);
    for (const p of d.members) await this.upsertMember(configId, p);
    for (const { attachmentIds: _ids, ...p } of d.messages) await this.upsertMessage(configId, p);
    for (const p of d.partners) await this.upsertPartner(configId, p);
    // Linking first gives a record without `thread` the channel of the message that lists it
    for (const m of d.messages) {
      if (m.attachmentIds) await this.linkAttachments(configId, m.messageId, m.attachmentIds, m.channelId);
    }
    for (const p of d.attachments) await this.upsertAttachment(configId, p);
    await this.applyReactions(configId, d);
    for (const p of d.mailbox ?? []) await this.upsertMailbox(configId, p);
    // A message's starred flag also moves its mailbox row: a bus Store carries {id, starred} without the thread
    for (const m of d.messages) {
      if (m.starred !== undefined) await this.starBox(configId, m.messageId, m.starred, await this.message(configId, m.messageId));
    }
    for (const set of d.pinnedSets ?? []) await this.keepPinned(configId, set.channelId, set.messageIds);
    if (d.deletedAttachmentIds.length > 0) await this.deleteAttachments(configId, d.deletedAttachmentIds);
    for (const id of d.deletedMessageIds ?? []) await this.deleteMessage(configId, id);
    for (const id of d.deletedMemberIds) await this.del("chat_members", { id: key(configId, id) });
    for (const id of d.deletedChannelIds) {
      await this.del("chat_channels", { id: key(configId, id) });
      for (const r of await this.rows("chat_messages", { config_id: configId, channel_id: id })) {
        const m = messageFromRow(r);
        if (m.messageId !== null) await this.del("chat_messages", { id: r.id });
        else await this.put("chat_messages", this.messageRow({ ...m, status: "failed", outboxOpId: null }));
      }
      await this.del("chat_members", { config_id: configId, channel_id: id });
      await this.del("chat_reactions", { config_id: configId, channel_id: id });
      await this.del("chat_on_top", { id: key(configId, id) });
      // Its draft goes with it
      const dropped = (await this.rows("chat_attachments", { config_id: configId, channel_id: id }))
        .filter((r) => r.state !== "queued" && r.state !== "uploaded");
      for (const r of dropped) await this.del("chat_attachments", { id: r.id });
      await this.release(dropped.flatMap((r) => pathsOf(attachmentFromRow(r))));
      await this.del("chat_drafts", { config_id: configId, channel_id: id });
    }
    const state: Partial<ChatSourceState> = {};
    if (d.inboxCounter !== null) state.inboxCounter = d.inboxCounter;
    if (d.starredCounter != null) state.starredCounter = d.starredCounter;
    if (d.selfPartnerId !== null) state.selfPartnerId = d.selfPartnerId;
    if (d.globalMuteUntil !== undefined) {
      state.globalMuteUntil = d.globalMuteUntil;
      if (opts.fromBus) state.globalMuteAt = this.now();
    }
    if (Object.keys(state).length > 0) await this.setSourceState({ ...state, configId });
  }

  /** The cached messages of a channel pinned and not among `messageIds` lose pinnedAt. */
  private async keepPinned(configId: string, channelId: number, messageIds: number[]): Promise<void> {
    const kept = new Set(messageIds);
    for (const m of await this.pinnedMessages(configId, channelId)) {
      if (!kept.has(m.messageId!)) await this.put("chat_messages", this.messageRow({ ...m, pinnedAt: null }));
    }
  }

  /** The reaction parts of a delta, in the order mergeDeltas assumes: sets, groups, deletions. */
  private async applyReactions(configId: string, d: StoreDelta): Promise<void> {
    for (const set of d.reactionSets ?? []) {
      const kept = new Set(set.contents);
      for (const r of await this.rows("chat_reactions", { config_id: configId, message_key: `m${set.messageId}` })) {
        if (!kept.has(r.content)) await this.del("chat_reactions", { id: r.id });
      }
    }
    for (const g of d.reactions ?? []) {
      const message = await this.message(configId, g.messageId);
      if (!message) continue;
      await this.putReaction({ ...g, configId, channelId: message.channelId, messageKey: `m${g.messageId}` });
    }
    for (const r of d.deletedReactions ?? []) await this.dropReaction(configId, `m${r.messageId}`, r.content);
  }

  /**
   * Drops a message the server deleted: its row, its reactions and the
   * server files it lists, those files released. Files of the phone (draft
   * or given to a post) are keyed `l<uuid>` and never match.
   */
  private async deleteMessage(configId: string, messageId: number): Promise<void> {
    await this.del("chat_messages", { id: key(configId, `m${messageId}`) });
    await this.del("chat_mailbox", { id: key(configId, `m${messageId}`) });
    await this.del("chat_reactions", { config_id: configId, message_key: `m${messageId}` });
    const dropped = (await this.rows("chat_attachments", { config_id: configId, message_id: messageId }))
      .filter((r) => String(r.id).startsWith(key(configId, "a")));
    for (const r of dropped) await this.del("chat_attachments", { id: r.id });
    await this.release(dropped.flatMap((r) => pathsOf(attachmentFromRow(r))));
  }

  /**
   * Moves the reactions of a queued message (`u<clientUuid>`) to its server
   * key (`m<messageId>`). The moved group replaces one the server already
   * wrote under that key: it holds what the user did and has not sent yet.
   */
  private async rekeyReactions(configId: string, clientUuid: string, messageId: number): Promise<void> {
    for (const r of await this.rows("chat_reactions", { config_id: configId, message_key: `u${clientUuid}` })) {
      await this.del("chat_reactions", { id: r.id });
      await this.putReaction({ ...reactionFromRow(r), messageKey: `m${messageId}`, messageId });
    }
  }

  private async upsertChannel(
    configId: string,
    p: Partial<ChatChannel> & { channelId: number },
    fromBus: boolean,
  ): Promise<void> {
    const stored = await this.row("chat_channels", key(configId, p.channelId));
    const base: ChatChannel = stored
      ? channelFromRow(stored)
      : {
          configId,
          channelId: p.channelId,
          channelType: "channel",
          name: "",
          description: "",
          lastInterestDt: null,
          unreadCounter: 0,
          needactionCounter: 0,
          newMessageSeparator: 0,
          seenMessageId: null,
          muteUntilDt: null,
          customNotifications: null,
          isMember: false,
          localPinned: false,
          lastMessageId: null,
          oldestLoadedId: null,
          historyComplete: false,
          correspondentPartnerId: null,
          unreadCounterBusId: 0,
          needactionCounterBusId: 0,
          isPinned: true,
          isEditable: null,
          customChannelName: null,
          memberCount: null,
          groupPublicId: null,
          authorizedGroupFullName: null,
          createUid: null,
          groupBasedSubscription: false,
          parentChannelId: null,
          createOpId: null,
          createFailed: false,
          leftUnsent: false,
        };
    const patch = defined(p);
    // A name sent blank is a source that never filled it, except for a group, renamed back to its members' names
    if (patch.name === "" && base.name !== "" && (patch.channelType ?? base.channelType) !== "group") {
      delete patch.name;
    }
    gateCounter(patch, base, "unreadCounter", "unreadCounterBusId", fromBus);
    gateCounter(patch, base, "needactionCounter", "needactionCounterBusId", fromBus);
    const next: ChatChannel = { ...base, ...patch, configId };
    next.lastMessageId = maxOf(base.lastMessageId, patch.lastMessageId);
    next.oldestLoadedId = minOf(base.oldestLoadedId, patch.oldestLoadedId);
    await this.put("chat_channels", this.channelRow(next));
  }

  /**
   * Overlays the server's fields of an attachment (channel, name, type,
   * size, checksum, voice) on its `a<id>` row; the paths, bytes, state and
   * last-opened time of local work are never touched. A row never seen needs
   * a channel, from the record or from `fallbackChannel`; without one it is
   * not stored.
   */
  private async upsertAttachment(
    configId: string,
    p: Partial<ChatAttachment> & { attachmentId: number },
    fallbackChannel?: number,
  ): Promise<void> {
    const id = key(configId, `a${p.attachmentId}`);
    const stored = await this.row("chat_attachments", id);
    const channelId = p.channelId ?? fallbackChannel;
    if (!stored && channelId === undefined) return;
    const base: ChatAttachment = stored
      ? attachmentFromRow(stored)
      : {
          configId,
          channelId: channelId!,
          messageId: null,
          attachmentId: p.attachmentId,
          localUuid: null,
          postClientUuid: null,
          seq: 0,
          name: "",
          mimetype: "",
          size: 0,
          checksum: null,
          voice: false,
          thumbPath: null,
          thumbBytes: 0,
          originalPath: null,
          originalBytes: 0,
          state: "posted",
          error: null,
          lastOpenedAt: null,
          createdAt: this.now(),
        };
    const server = defined({
      channelId: p.channelId,
      name: p.name,
      mimetype: p.mimetype,
      size: p.size,
      checksum: p.checksum,
      voice: p.voice,
    });
    await this.put("chat_attachments", this.attachmentRow({ ...base, ...server, configId }));
  }

  /**
   * Makes `ids` (in order) the attachments of a message: each row gets the
   * message id and its position, a row never received is created empty when
   * the channel is known (its record fills it in later), and a server row of
   * the message that is not listed any more is dropped with its files.
   */
  private async linkAttachments(
    configId: string,
    messageId: number,
    ids: number[],
    channelId?: number,
  ): Promise<void> {
    const channel = channelId ?? (await this.message(configId, messageId))?.channelId;
    for (const [seq, attachmentId] of ids.entries()) {
      await this.upsertAttachment(configId, { attachmentId }, channel);
      const row = await this.row("chat_attachments", key(configId, `a${attachmentId}`));
      if (!row) continue;
      await this.put("chat_attachments", {
        ...row,
        message_id: messageId,
        seq,
        channel_id: channel ?? row.channel_id,
      });
    }
    const dropped = (await this.rows("chat_attachments", { config_id: configId, message_id: messageId }))
      .filter((r) => String(r.id).startsWith(key(configId, "a")) && !ids.includes(r.attachment_id));
    for (const r of dropped) await this.del("chat_attachments", { id: r.id });
    await this.release(dropped.flatMap((r) => pathsOf(attachmentFromRow(r))));
  }

  private async upsertMember(configId: string, p: Partial<ChatMember> & { memberId: number }): Promise<void> {
    const stored = await this.row("chat_members", key(configId, p.memberId));
    const base: ChatMember = stored
      ? memberFromRow(stored)
      : {
          configId,
          channelId: 0,
          memberId: p.memberId,
          partnerId: 0,
          seenMessageId: null,
          fetchedMessageId: null,
          isTyping: false,
          typingAt: null,
          createDate: null,
        };
    await this.put("chat_members", this.memberRow({ ...base, ...defined(p), configId }));
  }

  /**
   * A partner record overlays only the keys it carries: one without
   * `im_status` keeps the stored presence, one without `name` updates the
   * other keys of a known partner. A partner never seen and nameless is
   * stored with an empty name, which displayNameOf skips.
   */
  private async upsertPartner(configId: string, p: StoreDelta["partners"][number]): Promise<void> {
    const stored = (await this.rows("chat_partners", { id: key(configId, p.partnerId) }))[0];
    await this.put("chat_partners", {
      id: key(configId, p.partnerId),
      config_id: configId,
      partner_id: p.partnerId,
      name: p.name ?? stored?.name ?? "",
      im_status: p.imStatus !== undefined ? p.imStatus : (stored?.im_status ?? null),
    });
  }

  private async upsertMessage(configId: string, p: Partial<ChatMessage> & { messageId: number }): Promise<void> {
    const id = key(configId, `m${p.messageId}`);
    const stored = await this.row("chat_messages", id);
    let base: ChatMessage | null = stored ? messageFromRow(stored) : null;
    // A bus echo of a queued post carries its client uuid: the queued row settles into it
    if (p.clientUuid) {
      const queued = await this.row("chat_messages", key(configId, `u${p.clientUuid}`));
      if (queued) {
        const merged = this.mergeSettled(messageFromRow(queued), base, p, configId, p.messageId, p.clientUuid);
        await this.del("chat_messages", { id: queued.id });
        await this.put("chat_messages", this.messageRow(merged));
        await this.rekeyReactions(configId, p.clientUuid, p.messageId);
        return;
      }
    }
    // A bus partial of a message never cached, without its channel (a reaction, an edit): nothing to show it in
    if (!base && p.channelId === undefined) return;
    const fresh: ChatMessage = base ?? {
      configId,
      channelId: p.channelId ?? 0,
      messageId: p.messageId,
      clientUuid: null,
      authorPartnerId: null,
      body: "",
      date: "",
      messageType: "comment",
      status: "sent",
      outboxOpId: null,
      writeDate: null,
      parentId: null,
      parentClientUuid: null,
      recipientIds: [],
    };
    const next: ChatMessage = { ...fresh, ...defined(p), configId };
    if (!base && p.status === undefined) next.status = "sent";
    await this.put("chat_messages", this.messageRow(next));
  }

  /**
   * Stores a mailbox partial over the row of the same message: the keys it
   * carries replace the stored ones, the others stay, so a partial with
   * only a flag keeps the body. A message not stored yet needs its thread
   * (the row's NOT NULL columns); without it the partial is dropped.
   */
  private async upsertMailbox(configId: string, p: Partial<ChatMailboxItem> & { messageId: number }): Promise<void> {
    const stored = await this.row("chat_mailbox", key(configId, `m${p.messageId}`));
    const base: ChatMailboxItem | null = stored ? mailboxFromRow(stored) : null;
    if (!base && (p.threadModel === undefined || p.threadId === undefined)) return;
    const fresh: ChatMailboxItem = base ?? {
      configId,
      messageId: p.messageId,
      threadModel: p.threadModel!,
      threadId: p.threadId!,
      recordName: "",
      authorPartnerId: null,
      body: "",
      date: null,
      messageType: "",
      needaction: false,
      starred: false,
      history: false,
    };
    await this.put("chat_mailbox", this.mailboxRow({ ...fresh, ...defined(p), configId }));
  }

  /**
   * The cached items of a box of the account, newest message id first:
   * the inbox (needaction), the history (history) or the starred ones.
   */
  async mailboxItems(configId: string, box: "inbox" | "history" | "starred"): Promise<ChatMailboxItem[]> {
    const column = box === "inbox" ? "needaction" : box;
    const rows = await this.rows("chat_mailbox", { config_id: configId, [column]: 1 });
    return rows.map(mailboxFromRow).sort((a, b) => b.messageId - a.messageId);
  }

  /**
   * The cached mailbox items of the account whose search_text (record
   * name and text) holds the words of `term` in order (likePattern),
   * whatever their boxes: inbox, history and starred alike. Newest message
   * first, at most `limit`; a term without a word finds nothing.
   */
  async searchMailbox(configId: string, term: string, limit = 50): Promise<ChatMailboxItem[]> {
    if (termWords(term).length === 0) return [];
    const rows = await this.db.rawQuery(
      "SELECT * FROM chat_mailbox WHERE config_id = ? AND search_text LIKE ? ESCAPE '\\' ORDER BY message_id DESC LIMIT ?",
      [configId, likePattern(term), limit],
    );
    return rows.map(mailboxFromRow);
  }

  /** One cached mailbox item; null when the message is not in the cache. */
  async mailboxItem(configId: string, messageId: number): Promise<ChatMailboxItem | null> {
    const row = await this.row("chat_mailbox", key(configId, `m${messageId}`));
    return row ? mailboxFromRow(row) : null;
  }

  /** Changes some fields of a cached mailbox item, the others kept; an uncached message is left alone. */
  async patchMailbox(configId: string, messageId: number, patch: Partial<ChatMailboxItem>): Promise<void> {
    const { configId: _c, messageId: _m, ...fields } = patch;
    await this.upsertMailbox(configId, { ...fields, messageId });
  }

  /**
   * The one final state of a queued post that reached the server: a single
   * sent row, client uuid kept, no outbox op. The queued row supplies what the
   * user typed; the server's row overlays only the values it really carries,
   * so a bus record without a body never blanks the text. A patch that
   * carries the server's parent (`parentId`, null for none) replaces the
   * queued one, its client uuid included.
   */
  private mergeSettled(
    queued: ChatMessage | null,
    echoed: ChatMessage | null,
    patch: Partial<ChatMessage>,
    configId: string,
    messageId: number,
    clientUuid: string,
  ): ChatMessage {
    return {
      ...(queued ?? {}),
      ...(echoed ? meaningful(echoed) : {}),
      ...(patch.parentId !== undefined ? { parentClientUuid: null } : {}),
      ...defined(patch),
      configId,
      messageId,
      clientUuid,
      status: "sent",
      outboxOpId: null,
    } as ChatMessage;
  }

  /** Every channel of one account, or of all accounts without an argument. */
  async channels(configId?: string): Promise<ChatChannel[]> {
    const rows = configId
      ? await this.rows("chat_channels", { config_id: configId })
      : await this.db.rawQuery("SELECT * FROM chat_channels");
    const onTopRows = configId
      ? await this.rows("chat_on_top", { config_id: configId })
      : await this.db.rawQuery("SELECT * FROM chat_on_top");
    const onTop = new Set(onTopRows.map((r) => r.id as string));
    return rows.map((r) => ({ ...channelFromRow(r), onTop: onTop.has(r.id as string) }));
  }

  async channel(configId: string, channelId: number): Promise<ChatChannel | null> {
    const row = await this.row("chat_channels", key(configId, channelId));
    if (!row) return null;
    return { ...channelFromRow(row), onTop: (await this.row("chat_on_top", key(configId, channelId))) !== null };
  }

  /**
   * Keeps a conversation on top of the list, or not. Repeating the same
   * choice changes nothing; `now` stamps the row when it is added.
   */
  async setOnTop(configId: string, channelId: number, on: boolean, now: Date): Promise<void> {
    const id = key(configId, channelId);
    if (!on) {
      await this.del("chat_on_top", { id });
      return;
    }
    if (await this.row("chat_on_top", id)) return;
    await this.put("chat_on_top", { id, config_id: configId, channel_id: channelId, since: now.toISOString() });
  }

  /**
   * A temporary channel id for a conversation created on the phone: the
   * negative of the clock in milliseconds, lowered by one while a cached
   * channel or a cached message of the account already uses it (the
   * messages of a refused create stay after their channel is gone), or a
   * settled create stored a pair for it (that pair would name the new
   * conversation's server id).
   */
  async newTemporaryId(configId: string, now: Date): Promise<number> {
    let id = -Math.max(1, now.getTime());
    for (;;) {
      const used = (await this.rows("chat_channels", { config_id: configId, channel_id: id })).length > 0
        || (await this.rows("chat_messages", { config_id: configId, channel_id: id })).length > 0
        || (await this.realIdOf(configId, id)) !== null;
      if (!used) return id;
      id--;
    }
  }

  /**
   * Moves a conversation created under a temporary id to the id the server
   * gave it: its messages, their reactions, its files and its draft, its members, and the channelId of every outbox
   * row of the account that still names the temporary id. The server's row
   * (written by the create answer or by the bus before it) wins for every
   * server field; without one the temporary row is re-keyed. Placeholder
   * members (negative ids, written before the server knew the conversation)
   * go when the server's members are cached, and move otherwise. createOpId
   * is cleared. Equal ids only clear createOpId (a hidden direct message
   * pinned again keeps its id).
   */
  async swapChannelId(configId: string, tempId: number, realId: number): Promise<void> {
    if (tempId === realId) {
      await this.patchChannel(configId, realId, { createOpId: null });
      return;
    }
    const temp = await this.channel(configId, tempId);
    const real = await this.channel(configId, realId);
    await this.db.rawRun(
      "UPDATE chat_messages SET channel_id = ? WHERE config_id = ? AND channel_id = ?",
      [realId, configId, tempId],
    );
    await this.db.rawRun(
      "UPDATE chat_attachments SET channel_id = ? WHERE config_id = ? AND channel_id = ?",
      [realId, configId, tempId],
    );
    await this.db.rawRun(
      "UPDATE chat_reactions SET channel_id = ? WHERE config_id = ? AND channel_id = ?",
      [realId, configId, tempId],
    );
    await this.moveDraftText(configId, tempId, realId);
    await this.moveOnTop(configId, tempId, realId);
    if ((await this.members(configId, realId)).length > 0) {
      await this.db.rawRun(
        "DELETE FROM chat_members WHERE config_id = ? AND channel_id = ? AND member_id < 0",
        [configId, tempId],
      );
    }
    await this.db.rawRun(
      "UPDATE chat_members SET channel_id = ? WHERE config_id = ? AND channel_id = ?",
      [realId, configId, tempId],
    );
    if (temp) {
      const merged: ChatChannel = real
        ? { ...real, isMember: real.isMember || temp.isMember, localPinned: real.localPinned || temp.localPinned }
        : { ...temp, channelId: realId };
      await this.del("chat_channels", { id: key(configId, tempId) });
      await this.put("chat_channels", this.channelRow({ ...merged, createOpId: null }));
    } else if (real) {
      await this.patchChannel(configId, realId, { createOpId: null });
    }
    for (const op of await this.db.getOutboxOpsForConfig(configId)) {
      if (op.params.channelId !== tempId) continue;
      await this.db.updateOutboxOp(op.id, {
        params: { ...op.params, channelId: realId },
        updatedAt: this.now(),
      });
    }
  }

  /** Moves the on-top row of a temporary id to the server id; the earlier row of the server id is replaced. */
  private async moveOnTop(configId: string, tempId: number, realId: number): Promise<void> {
    const row = await this.row("chat_on_top", key(configId, tempId));
    if (!row) return;
    await this.del("chat_on_top", { id: key(configId, tempId) });
    await this.put("chat_on_top", { ...row, id: key(configId, realId), channel_id: realId });
  }

  /** Records the server id a create gave to a temporary id (see chat_temp_ids). */
  async rememberRealId(configId: string, tempId: number, realId: number): Promise<void> {
    await this.put("chat_temp_ids", { id: key(configId, tempId), config_id: configId, temp_id: tempId, real_id: realId });
  }

  /** The server id a settled create gave to `tempId`, or null. */
  async realIdOf(configId: string, tempId: number): Promise<number | null> {
    return (await this.row("chat_temp_ids", key(configId, tempId)))?.real_id ?? null;
  }

  /** Every server id a create of this phone settled on, for the account. */
  async adoptedIds(configId: string): Promise<Set<number>> {
    return new Set((await this.rows("chat_temp_ids", { config_id: configId })).map((r) => r.real_id as number));
  }

  /**
   * Removes a conversation and everything cached of it, the texts it never
   * sent and its draft included: the user dismissed it.
   */
  async dropChannel(configId: string, channelId: number): Promise<void> {
    for (const t of ["chat_channels", "chat_messages", "chat_members", "chat_drafts", "chat_reactions", "chat_on_top"]) {
      await this.del(t, { config_id: configId, channel_id: channelId });
    }
    await this.dropAttachmentRows({ config_id: configId, channel_id: channelId });
  }

  /** Deletes the attachment rows matching `where` and releases their files. */
  private async dropAttachmentRows(where: Row): Promise<void> {
    const rows = (await this.rows("chat_attachments", where)).map(attachmentFromRow);
    await this.del("chat_attachments", where);
    await this.release(rows.flatMap(pathsOf));
  }

  /** Overlays the given keys on a cached channel; nothing happens for an unknown channel. */
  async patchChannel(configId: string, channelId: number, p: Partial<ChatChannel>): Promise<void> {
    const row = await this.row("chat_channels", key(configId, channelId));
    if (!row) return;
    await this.put("chat_channels", this.channelRow({ ...channelFromRow(row), ...defined(p), configId, channelId }));
  }

  /**
   * The messages of a channel, oldest first, queued ones (no server id) last.
   * `beforeId` keeps the server messages below that id and drops the queued
   * ones; `limit` keeps the newest server messages of what remains.
   */
  async messages(
    configId: string,
    channelId: number,
    opts: { beforeId?: number; limit?: number } = {},
  ): Promise<ChatMessage[]> {
    const all = (await this.rows("chat_messages", { config_id: configId, channel_id: channelId })).map(messageFromRow);
    const sent = all.filter((m) => m.messageId !== null).sort(byThread);
    const queued = all.filter((m) => m.messageId === null).sort(byThread);
    let kept = sent;
    if (opts.beforeId !== undefined) kept = kept.filter((m) => m.messageId! < opts.beforeId!);
    if (opts.limit !== undefined) kept = kept.slice(Math.max(0, kept.length - opts.limit));
    return opts.beforeId !== undefined ? kept : [...kept, ...queued];
  }

  /** Stores a message the outbox still has to post, under its client uuid. */
  async putPending(m: ChatMessage): Promise<void> {
    await this.put("chat_messages", this.messageRow({ ...m, messageId: null }));
  }

  /**
   * Gives a queued message its server id. A row the bus already wrote under
   * that id wins for the server fields; the two collapse to one sent row.
   */
  async settlePending(
    configId: string,
    clientUuid: string,
    messageId: number,
    patch: Partial<ChatMessage> = {},
  ): Promise<void> {
    const queuedId = key(configId, `u${clientUuid}`);
    const queued = await this.row("chat_messages", queuedId);
    const echoed = await this.row("chat_messages", key(configId, `m${messageId}`));
    if (!queued && !echoed) return;
    const merged = this.mergeSettled(
      queued ? messageFromRow(queued) : null,
      echoed ? messageFromRow(echoed) : null,
      patch,
      configId,
      messageId,
      clientUuid,
    );
    if (queued) await this.del("chat_messages", { id: queuedId });
    await this.put("chat_messages", this.messageRow(merged));
    await this.rekeyReactions(configId, clientUuid, messageId);
  }

  /** Turns every queued message of a channel into a failed one, detached from the outbox. */
  async failPending(configId: string, channelId: number): Promise<void> {
    for (const r of await this.rows("chat_messages", { config_id: configId, channel_id: channelId })) {
      const m = messageFromRow(r);
      if (m.messageId === null && m.status === "pending") {
        await this.put("chat_messages", this.messageRow({ ...m, status: "failed", outboxOpId: null }));
      }
    }
  }

  /**
   * Turns one queued message into a failed one detached from the outbox
   * (its op was cancelled): no retry can reach a row that is gone.
   */
  async failQueued(configId: string, clientUuid: string): Promise<void> {
    const queued = await this.row("chat_messages", key(configId, `u${clientUuid}`));
    if (!queued) return;
    await this.put("chat_messages", this.messageRow({ ...messageFromRow(queued), status: "failed", outboxOpId: null }));
  }

  /** Removes the cached member rows of one person in one channel. */
  async dropMember(configId: string, channelId: number, partnerId: number): Promise<void> {
    await this.del("chat_members", { config_id: configId, channel_id: channelId, partner_id: partnerId });
  }

  /** Flags a queued message as given up on. The row has no error column: the outbox keeps the reason. */
  async markFailed(configId: string, clientUuid: string, _error: string): Promise<void> {
    const queued = await this.row("chat_messages", key(configId, `u${clientUuid}`));
    if (!queued) return;
    await this.put("chat_messages", this.messageRow({ ...messageFromRow(queued), status: "failed" }));
  }

  /**
   * The cached messages of the account whose search_text holds the words
   * of `term` in order (likePattern), a failed post left out, newest
   * first (one date: the row written last first), at most `limit`; a
   * term without a word finds nothing. With the FTS5 index
   * (chatSearchEngine "fts5"), each word of TRIGRAM characters or more is
   * a quoted phrase of the MATCH (inner quotes doubled), all of them
   * required, which narrows the rows to a superset of the LIKE's; the LIKE
   * in the same query and matchesTerm keep exactly the LIKE's rows, so
   * the limit counts the same rows either way. Shorter words alone take
   * the LIKE, and so does a MATCH that fails. The term reaches SQL only
   * as bound parameters.
   */
  async searchMessages(configId: string, term: string, limit = 50): Promise<ChatMessage[]> {
    const words = termWords(term);
    if (words.length === 0) return [];
    const pattern = likePattern(term);
    const indexed = words.filter((w) => Array.from(w).length >= TRIGRAM);
    if (indexed.length > 0 && (await this.db.chatSearchEngine()) === "fts5") {
      const match = indexed.map((w) => '"' + w.replace(/"/g, '""') + '"').join(" ");
      try {
        const rows = await this.db.rawQuery(
          "SELECT * FROM chat_messages WHERE rowid IN (SELECT rowid FROM chat_search_fts WHERE chat_search_fts MATCH ?) AND config_id = ? AND status != ? AND search_text LIKE ? ESCAPE '\\' ORDER BY date DESC, rowid DESC LIMIT ?",
          [match, configId, "failed", pattern, limit],
        );
        return rows.filter((r) => matchesTerm(r.search_text ?? "", term)).map(messageFromRow);
      } catch (e) {
        console.warn(`[chat] search index query failed, LIKE used: ${e instanceof Error ? e.message : e}`);
      }
    }
    const rows = await this.db.rawQuery(
      "SELECT * FROM chat_messages WHERE config_id = ? AND status != ? AND search_text LIKE ? ESCAPE '\\' ORDER BY date DESC, rowid DESC LIMIT ?",
      [configId, "failed", pattern, limit],
    );
    return rows.map(messageFromRow);
  }

  /**
   * Sets the starred flag of a cached message and of its row in the
   * starred box (starBox); a message cached in neither is left alone.
   */
  async setStarred(configId: string, messageId: number, on: boolean): Promise<void> {
    const stored = await this.message(configId, messageId);
    if (stored) await this.put("chat_messages", this.messageRow({ ...stored, starred: on }));
    await this.starBox(configId, messageId, on, stored);
  }

  /**
   * The starred flag of a message's mailbox row: an existing row (any
   * model) takes it, its other flags kept; without one, a cached channel
   * message (`message`) gets a row when starred, its thread the channel
   * and its record name the channel's, so the starred box lists it.
   */
  private async starBox(configId: string, messageId: number, on: boolean, message: ChatMessage | null): Promise<void> {
    if (await this.row("chat_mailbox", key(configId, `m${messageId}`))) {
      await this.upsertMailbox(configId, { messageId, starred: on });
      return;
    }
    if (!on || !message) return;
    await this.upsertMailbox(configId, {
      messageId,
      threadModel: CHANNEL_MODEL,
      threadId: message.channelId,
      recordName: (await this.channel(configId, message.channelId))?.name ?? "",
      authorPartnerId: message.authorPartnerId,
      body: message.body,
      date: message.date || null,
      messageType: message.messageType,
      starred: true,
    });
  }

  /** The cached messages of a channel that carry pinnedAt, in no order; the server's only (a pin needs an id). */
  async pinnedMessages(configId: string, channelId: number): Promise<ChatMessage[]> {
    return (await this.rows("chat_messages", { config_id: configId, channel_id: channelId }))
      .map(messageFromRow)
      .filter((m) => m.messageId !== null && !!m.pinnedAt);
  }

  /** A message the server knows, by its id; null when it is not cached. */
  async message(configId: string, messageId: number): Promise<ChatMessage | null> {
    const row = await this.row("chat_messages", key(configId, `m${messageId}`));
    return row ? messageFromRow(row) : null;
  }

  /**
   * A message by the client uuid of its post: the queued row, or the sent
   * row a settle left (it keeps the uuid); the sent one when both exist.
   * Null when neither is cached.
   */
  async messageByClientUuid(configId: string, clientUuid: string): Promise<ChatMessage | null> {
    const found = (await this.rows("chat_messages", { config_id: configId, client_uuid: clientUuid })).map(messageFromRow);
    return found.find((m) => m.messageId !== null) ?? found[0] ?? null;
  }

  /** The message an action names: by server id, else (no id, or one not cached) by client uuid. */
  async messageOf(configId: string, target: MessageTarget): Promise<ChatMessage | null> {
    const byId = target.messageId !== null ? await this.message(configId, target.messageId) : null;
    if (byId || target.clientUuid === null) return byId;
    return this.messageByClientUuid(configId, target.clientUuid);
  }

  /** Removes a queued message (`u<clientUuid>`) and its reactions; its outbox op and files are the caller's. */
  async dropQueued(configId: string, clientUuid: string): Promise<void> {
    await this.del("chat_messages", { id: key(configId, `u${clientUuid}`) });
    await this.del("chat_reactions", { config_id: configId, message_key: `u${clientUuid}` });
  }

  /**
   * The reaction groups of the given message keys (see messageKeyOf) of a
   * channel, in one read; each list by `sequence`, a key without a group
   * has no entry.
   */
  async reactionsOf(configId: string, channelId: number, keys: string[]): Promise<Map<string, ChatReaction[]>> {
    const wanted = new Set(keys);
    const out = new Map<string, ChatReaction[]>();
    const all = (await this.rows("chat_reactions", { config_id: configId, channel_id: channelId }))
      .map(reactionFromRow)
      .filter((r) => wanted.has(r.messageKey))
      .sort((a, b) => a.sequence - b.sequence);
    for (const r of all) out.set(r.messageKey, [...(out.get(r.messageKey) ?? []), r]);
    return out;
  }

  /** Writes one reaction group, replacing the stored one of its (message key, content). */
  async putReaction(r: ChatReaction): Promise<void> {
    await this.put("chat_reactions", reactionRow(r));
  }

  /** Removes one reaction group of a message key; nothing happens when it is absent. */
  async dropReaction(configId: string, messageKey: string, content: string): Promise<void> {
    await this.del("chat_reactions", { id: key(configId, `${messageKey}#${content}`) });
  }

  /**
   * The newest non-empty server message of each given channel, as Odoo's
   * `newestPersistentNotEmptyOfAllMessage`: the last one by primary key
   * (one lookup per channel). One with an empty body is looked up once
   * more for a file (a photo without a caption stands too); only when it
   * has none is the channel's history read for the newest one with text
   * or a file (isEmptyMessage).
   * The messages of `skip` (server ids) count as empty: the ones whose
   * delete is queued. A channel without a known last message, whose last
   * message is not cached, or with no non-empty message cached has no
   * entry.
   */
  async lastMessages(configId: string, channels: ChatChannel[], skip: Set<number> = new Set()): Promise<Map<number, ChatMessage>> {
    const found = await Promise.all(channels.map(async (c) => {
      const m = c.lastMessageId == null ? null : await this.message(configId, c.lastMessageId);
      if (!m) return null;
      if (!skip.has(m.messageId!) && (!isEmptyBody(m.body) || (await this.hasFiles(configId, m.messageId!)))) return m;
      return this.newestNotEmpty(configId, c.channelId, skip);
    }));
    const out = new Map<number, ChatMessage>();
    channels.forEach((c, i) => {
      const m = found[i];
      if (m) out.set(c.channelId, m);
    });
    return out;
  }

  /** Whether a cached server message has a cached file, in one lookup by its id. */
  private async hasFiles(configId: string, messageId: number): Promise<boolean> {
    const sql = "SELECT 1 FROM chat_attachments WHERE config_id = ? AND message_id = ? LIMIT 1";
    return (await this.db.rawQuery(sql, [configId, messageId])).length > 0;
  }

  /** The newest server message of a channel with text or a file, outside `skip`; null when none is cached. */
  private async newestNotEmpty(configId: string, channelId: number, skip: Set<number>): Promise<ChatMessage | null> {
    const [rows, files] = await Promise.all([
      this.rows("chat_messages", { config_id: configId, channel_id: channelId }),
      this.rows("chat_attachments", { config_id: configId, channel_id: channelId }),
    ]);
    const withFiles = new Set(files.map((r) => r.message_id).filter((id) => id != null));
    const sent = rows.map(messageFromRow).filter((m) => m.messageId !== null).sort((a, b) => b.messageId! - a.messageId!);
    return sent.find((m) => !skip.has(m.messageId!) && !isEmptyMessage(m.body, withFiles.has(m.messageId) ? 1 : 0)) ?? null;
  }

  /** The queued messages of an account grouped by channel, each group oldest first. */
  async pendingMessages(configId: string): Promise<Map<number, ChatMessage[]>> {
    const rows = await this.rows("chat_messages", { config_id: configId, status: "pending" });
    const out = new Map<number, ChatMessage[]>();
    for (const m of rows.map(messageFromRow).sort(byThread)) {
      out.set(m.channelId, [...(out.get(m.channelId) ?? []), m]);
    }
    return out;
  }

  async members(configId: string, channelId: number): Promise<ChatMember[]> {
    return (await this.rows("chat_members", { config_id: configId, channel_id: channelId })).map(memberFromRow);
  }

  /** Every member of an account grouped by channel, in one read; each group in member-id order. */
  async membersBySource(configId: string): Promise<Map<number, ChatMember[]>> {
    const out = new Map<number, ChatMember[]>();
    const all = (await this.rows("chat_members", { config_id: configId }))
      .map(memberFromRow)
      .sort((a, b) => a.memberId - b.memberId);
    for (const m of all) out.set(m.channelId, [...(out.get(m.channelId) ?? []), m]);
    return out;
  }

  async partners(configId: string): Promise<ChatPartner[]> {
    return (await this.rows("chat_partners", { config_id: configId })).map((r) => ({
      configId: r.config_id,
      partnerId: r.partner_id,
      name: r.name,
      imStatus: r.im_status ?? null,
    }));
  }

  /** The sync state of one account; defaults while nothing is stored. */
  async sourceState(configId: string): Promise<ChatSourceState> {
    const row = (await this.rows("chat_sources", { config_id: configId }))[0];
    if (row) return sourceFromRow(row);
    return {
      configId,
      selfPartnerId: null,
      lastBusId: 0,
      busSeenAt: null,
      wsVersion: null,
      isSystem: false,
      moduleState: "unknown",
      inboxCounter: 0,
      loadedAt: null,
      counterBusId: 0,
      internalUserGroupId: null,
      globalMuteUntil: null,
      globalMuteAt: null,
      isInternalUser: false,
      fileDir: null,
      moduleLevel: null,
      starredCounter: 0,
      notificationType: null,
    };
  }

  /** Whether a sync state was ever stored for the account, i.e. it was once a chat source. */
  async hasSourceState(configId: string): Promise<boolean> {
    return (await this.rows("chat_sources", { config_id: configId })).length > 0;
  }

  async setSourceState(s: Partial<ChatSourceState> & { configId: string }): Promise<void> {
    const base = await this.sourceState(s.configId);
    await this.put("chat_sources", this.sourceRow({ ...base, ...defined(s) }));
  }

  /** In-flight fileDirOf calls, so two concurrent first calls share one id. */
  private fileDirs = new Map<string, Promise<string>>();

  /**
   * The account's directory name under chat/: a random id made on first use
   * and stored with the sync state, so it follows a renamed account and
   * names nothing about it.
   */
  fileDirOf(configId: string): Promise<string> {
    let pending = this.fileDirs.get(configId);
    if (!pending) {
      pending = this.makeFileDir(configId).finally(() => this.fileDirs.delete(configId));
      this.fileDirs.set(configId, pending);
    }
    return pending;
  }

  private async makeFileDir(configId: string): Promise<string> {
    const state = await this.sourceState(configId);
    if (state.fileDir) return state.fileDir;
    const fileDir = uuidv4();
    await this.setSourceState({ configId, fileDir });
    return fileDir;
  }

  private async attachmentByKey(configId: string, local: string): Promise<ChatAttachment | null> {
    const row = await this.row("chat_attachments", key(configId, local));
    return row ? attachmentFromRow(row) : null;
  }

  /** Overlays `patch` on the row of a local file (`l<uuid>`); nothing happens for an unknown one. */
  private async patchLocal(configId: string, localUuid: string, patch: Partial<ChatAttachment>): Promise<void> {
    const row = await this.attachmentByKey(configId, `l${localUuid}`);
    if (!row) return;
    await this.put("chat_attachments", this.attachmentRow({ ...row, ...defined(patch) }));
  }

  /** Overlays `patch` on the row of a server attachment (`a<id>`); nothing happens for an unknown one. */
  private async patchServer(configId: string, attachmentId: number, patch: Partial<ChatAttachment>): Promise<void> {
    const row = await this.attachmentByKey(configId, `a${attachmentId}`);
    if (!row) return;
    await this.put("chat_attachments", this.attachmentRow({ ...row, ...defined(patch) }));
  }

  /** Stores the files of a post waiting to be sent, each under its local uuid. */
  async putOutgoing(rows: ChatAttachment[]): Promise<void> {
    for (const a of rows) await this.put("chat_attachments", this.attachmentRow(a));
  }

  /** The files of a queued post, in pick order. */
  async outgoingOf(configId: string, postClientUuid: string): Promise<ChatAttachment[]> {
    const rows = await this.rows("chat_attachments", { config_id: configId, post_client_uuid: postClientUuid });
    return rows.map(attachmentFromRow).sort(bySeq);
  }

  /**
   * The server accepted the file as a pending attachment: it now has an id
   * and its real fields. Only a row still "queued" is written, in one
   * statement: a row refused meanwhile (a leave) keeps its refusal.
   */
  async setUploaded(
    configId: string,
    localUuid: string,
    s: { attachmentId: number; checksum: string; size: number; mimetype: string; name: string },
  ): Promise<void> {
    await this.db.rawRun(
      "UPDATE chat_attachments SET state = ?, error = ?, attachment_id = ?, checksum = ?, size = ?, mimetype = ?, name = ? "
        + "WHERE id = ? AND state = ?",
      ["uploaded", null, s.attachmentId, s.checksum, s.size, s.mimetype, s.name, key(configId, `l${localUuid}`), "queued"],
    );
  }

  /** The server refused the file; it stays, with the reason, until the user dismisses it. */
  async setRefused(configId: string, localUuid: string, reason: string): Promise<void> {
    await this.patchLocal(configId, localUuid, { state: "refused", error: reason });
  }

  /** The row of a file of the phone (`l<uuid>`), or null. */
  async outgoingFile(configId: string, localUuid: string): Promise<ChatAttachment | null> {
    return this.attachmentByKey(configId, `l${localUuid}`);
  }

  /** Server ids of the account's files uploaded and not yet posted ("uploaded" rows). */
  async uploadedIds(configId: string): Promise<Set<number>> {
    return new Set((await this.rows("chat_attachments", { config_id: configId, state: "uploaded" }))
      .map((r) => r.attachment_id as number | null)
      .filter((id): id is number => typeof id === "number"));
  }

  /**
   * Puts a file back in the queue to be uploaded again (refused, or lost by
   * the server): its server id is forgotten, so no settle adopts it.
   */
  async requeueUpload(configId: string, localUuid: string): Promise<void> {
    await this.patchLocal(configId, localUuid, { state: "queued", error: null, attachmentId: null });
  }

  /**
   * Settles the uploaded files of a post that got its message id: each row
   * is re-keyed `a<id>`, state posted, no longer tied to the queued post.
   * A row the bus already wrote for that id (the echo can come first) takes
   * the phone's paths, bytes and position and keeps the server's fields.
   * Files not uploaded stay as they are. Returns the settled rows in order.
   */
  async adoptOutgoing(configId: string, postClientUuid: string, messageId: number): Promise<ChatAttachment[]> {
    const out: ChatAttachment[] = [];
    for (const local of await this.outgoingOf(configId, postClientUuid)) {
      if (local.attachmentId === null) continue;
      const bus = await this.attachmentByKey(configId, `a${local.attachmentId}`);
      const merged: ChatAttachment = {
        ...local,
        name: bus?.name || local.name,
        mimetype: bus?.mimetype || local.mimetype,
        size: bus?.size || local.size,
        checksum: bus?.checksum ?? local.checksum,
        voice: local.voice || !!bus?.voice,
        thumbPath: bus?.thumbPath ?? local.thumbPath,
        thumbBytes: bus?.thumbPath ? bus.thumbBytes : local.thumbBytes,
        lastOpenedAt: bus?.lastOpenedAt ?? local.lastOpenedAt,
        messageId,
        postClientUuid: null,
        state: "posted",
        error: null,
      };
      // One statement, so no interruption leaves both rows: the local row takes the `a<id>` key and
      // REPLACE removes the row the bus wrote under it. The one non-equality statement of this class.
      const r = this.attachmentRow(merged);
      await this.db.rawRun(
        "UPDATE OR REPLACE chat_attachments SET id = ?, message_id = ?, post_client_uuid = ?, state = ?, "
          + "error = ?, name = ?, mimetype = ?, size = ?, checksum = ?, voice = ?, thumb_path = ?, "
          + "thumb_bytes = ?, last_opened_at = ? WHERE id = ?",
        [r.id, r.message_id, null, "posted", null, r.name, r.mimetype, r.size, r.checksum, r.voice, r.thumb_path, r.thumb_bytes,
          r.last_opened_at, key(configId, `l${local.localUuid}`)],
      );
      out.push(merged);
    }
    return out;
  }

  /**
   * The files of the given messages and queued posts of a channel, in one
   * read: keys `m<messageId>` for server messages, `u<postClientUuid>` for
   * posts still queued; each group in pick order, a message without files
   * has no entry.
   */
  async attachmentsOf(
    configId: string,
    channelId: number,
    messageIds: number[],
    postClientUuids: string[],
  ): Promise<Map<string, ChatAttachment[]>> {
    const wantedMessages = new Set(messageIds);
    const wantedPosts = new Set(postClientUuids);
    const out = new Map<string, ChatAttachment[]>();
    const all = (await this.rows("chat_attachments", { config_id: configId, channel_id: channelId }))
      .map(attachmentFromRow)
      .sort(bySeq);
    for (const a of all) {
      let k: string | null = null;
      if (a.messageId !== null && wantedMessages.has(a.messageId)) k = `m${a.messageId}`;
      else if (a.messageId === null && a.postClientUuid && wantedPosts.has(a.postClientUuid)) k = `u${a.postClientUuid}`;
      if (k) out.set(k, [...(out.get(k) ?? []), a]);
    }
    return out;
  }

  /** Every attachment row of the account, whatever its state, in pick order. */
  async sourceAttachments(configId: string): Promise<ChatAttachment[]> {
    return (await this.rows("chat_attachments", { config_id: configId })).map(attachmentFromRow).sort(bySeq);
  }

  /** The row of a server attachment (`a<id>`), or null when it is not cached. */
  async attachment(configId: string, attachmentId: number): Promise<ChatAttachment | null> {
    return this.attachmentByKey(configId, `a${attachmentId}`);
  }

  /** Records the cached preview of a server attachment. */
  async setPreview(configId: string, attachmentId: number, path: string, bytes: number): Promise<void> {
    await this.patchServer(configId, attachmentId, { thumbPath: path, thumbBytes: bytes });
  }

  /** Records the cached original of a server attachment. */
  async setOriginal(configId: string, attachmentId: number, path: string, bytes: number): Promise<void> {
    await this.patchServer(configId, attachmentId, { originalPath: path, originalBytes: bytes });
  }

  /** Stamps the time the user last opened an attachment (the purge orders by it). */
  async touchOpened(configId: string, attachmentId: number, at: string): Promise<void> {
    await this.patchServer(configId, attachmentId, { lastOpenedAt: at });
  }

  /** Bytes cached on the phone (previews plus originals), for one channel, one account or all. */
  async attachmentBytes(configId?: string, channelId?: number): Promise<number> {
    const conds: string[] = [];
    const params: unknown[] = [];
    if (configId !== undefined) { conds.push("config_id = ?"); params.push(configId); }
    if (channelId !== undefined) { conds.push("channel_id = ?"); params.push(channelId); }
    // One aggregate in SQLite, not the rows summed here
    const rows = await this.db.rawQuery(
      "SELECT COALESCE(SUM(COALESCE(thumb_bytes, 0) + COALESCE(original_bytes, 0)), 0) AS bytes FROM chat_attachments"
        + (conds.length > 0 ? " WHERE " + conds.join(" AND ") : ""),
      params,
    );
    return Number(rows[0]?.bytes ?? 0);
  }

  /**
   * The server attachments that hold a cached file, least recently opened
   * first (`COALESCE(last_opened_at, created_at)`): the purge order. A file
   * still waiting to be sent is not among them.
   */
  async cachedRows(): Promise<ChatAttachment[]> {
    const used = (a: ChatAttachment) => a.lastOpenedAt ?? a.createdAt;
    return (await this.db.rawQuery("SELECT * FROM chat_attachments"))
      .map(attachmentFromRow)
      .filter((a) => a.state === "posted" && (a.thumbBytes > 0 || a.originalBytes > 0))
      .sort((a, b) => (used(a) < used(b) ? -1 : used(a) > used(b) ? 1 : 0));
  }

  /** Forgets the cached original, the preview or both of the rows with these keys, and releases the files; a row not posted (its file waits to be sent) is left alone. */
  async clearFiles(keys: string[], what: "original" | "preview" | "both"): Promise<void> {
    const released: string[] = [];
    for (const id of keys) {
      const row = await this.row("chat_attachments", id);
      if (!row) continue;
      const a = attachmentFromRow(row);
      // A file an outbox op still reads is never cleared
      if (a.state !== "posted") continue;
      if ((what === "original" || what === "both") && a.originalPath) {
        released.push(a.originalPath);
        a.originalPath = null;
        a.originalBytes = 0;
      }
      if ((what === "preview" || what === "both") && a.thumbPath) {
        released.push(a.thumbPath);
        a.thumbPath = null;
        a.thumbBytes = 0;
      }
      await this.put("chat_attachments", this.attachmentRow(a));
    }
    await this.release(released);
  }

  /** The channel a cached server attachment belongs to; undefined when it is not cached. */
  async attachmentChannel(configId: string, attachmentId: number): Promise<number | undefined> {
    return (await this.attachmentByKey(configId, `a${attachmentId}`))?.channelId;
  }

  /** The account's files of the phone given to a post (`l<uuid>` rows: queued, uploaded or refused; not drafts), in no order. */
  async outgoingRows(configId: string): Promise<ChatAttachment[]> {
    const prefix = key(configId, "l");
    return (await this.rows("chat_attachments", { config_id: configId }))
      .filter((r) => String(r.id).startsWith(prefix) && r.state !== "draft")
      .map(attachmentFromRow);
  }

  /** Local uuids of every attachment row of the account that has one, whatever its state. */
  async localUuids(configId: string): Promise<Set<string>> {
    return new Set((await this.rows("chat_attachments", { config_id: configId }))
      .map((r) => r.local_uuid as string | null)
      .filter((u): u is string => !!u));
  }

  /** Client uuids of the account's messages without a server id (queued or failed). */
  async queuedMessageUuids(configId: string): Promise<Set<string>> {
    return new Set((await this.rows("chat_messages", { config_id: configId }))
      .filter((r) => r.message_id == null && r.client_uuid)
      .map((r) => r.client_uuid as string));
  }

  /**
   * Forgets the file of rows of the phone by local uuid, the rows kept (a
   * refused file still named beside its text), and returns the paths
   * without releasing them, as deleteOutgoing does. A row that is a draft
   * when it is read (a rejected send gave it back) keeps its file.
   */
  async releaseOutgoing(configId: string, localUuids: string[]): Promise<string[]> {
    const paths: string[] = [];
    for (const uuid of localUuids) {
      const row = await this.attachmentByKey(configId, `l${uuid}`);
      if (!row?.originalPath || row.state === "draft") continue;
      paths.push(row.originalPath);
      await this.put("chat_attachments", this.attachmentRow({ ...row, originalPath: null, originalBytes: 0 }));
    }
    return paths;
  }

  /** Drops server attachments by id (the server deleted them), releases and returns their file paths. */
  async deleteAttachments(configId: string, ids: number[]): Promise<string[]> {
    const paths: string[] = [];
    for (const id of ids) {
      const row = await this.attachmentByKey(configId, `a${id}`);
      if (!row) continue;
      paths.push(...pathsOf(row));
      await this.del("chat_attachments", { id: key(configId, `a${id}`) });
    }
    await this.release(paths);
    return paths;
  }

  /**
   * Drops files of the phone by local uuid and returns their paths without
   * releasing them: the outbox deletes the files it owns itself. A row that
   * is a draft when it is read stays with its file: a draft file is dropped
   * only by removeDraftFile.
   */
  async deleteOutgoing(configId: string, localUuids: string[]): Promise<string[]> {
    const paths: string[] = [];
    for (const uuid of localUuids) {
      const row = await this.attachmentByKey(configId, `l${uuid}`);
      if (!row || row.state === "draft") continue;
      paths.push(...pathsOf(row));
      await this.del("chat_attachments", { id: key(configId, `l${uuid}`) });
    }
    return paths;
  }

  /** Removes every cached row of one account, its drafts included, leaving the others. */
  async dropSource(configId: string): Promise<void> {
    await this.dropAttachmentRows({ config_id: configId });
    for (const t of ["chat_channels", "chat_messages", "chat_members", "chat_partners", "chat_temp_ids", "chat_drafts", "chat_reactions", "chat_mailbox", "chat_on_top", "chat_sources"]) {
      await this.del(t, { config_id: configId });
    }
  }

  // ─── Drafts ───────────────────────────────────────────────────────────────

  /** A conversation's draft files (`l<uuid>` rows in the "draft" state), in chip order. */
  private async draftFiles(configId: string, channelId: number): Promise<ChatAttachment[]> {
    return (await this.rows("chat_attachments", { config_id: configId, channel_id: channelId, state: "draft" }))
      .map(attachmentFromRow)
      .sort(bySeq);
  }

  /**
   * What a conversation's composer keeps: the text typed and the draft
   * files in chip order, the message the text answers (replyTo), the edit
   * in progress (its message and text) and the people and channels picked
   * in either text; empty for none. A stored value that does not read as
   * JSON counts as none.
   */
  async draftOf(configId: string, channelId: number): Promise<ChatDraft> {
    const row = await this.row("chat_drafts", key(configId, channelId));
    const editOf = storedTarget(row?.edit_of);
    return {
      text: row?.text ?? "",
      files: await this.draftFiles(configId, channelId),
      replyTo: storedTarget(row?.reply_to),
      edit: editOf ? { target: editOf, text: row?.edit_text ?? "" } : null,
      mentions: mentionsOf(row?.mentions),
    };
  }

  /**
   * Writes some fields of a conversation's draft row, the others kept. A
   * row left with no text, no reply target, no edit, no picks and no draft
   * file is deleted. Picks alone keep the row: they may be stored before
   * the text they belong to (a pick in an empty composer, an edit's picks
   * before the edit).
   */
  private async patchDraft(configId: string, channelId: number, patch: Partial<DraftRow>): Promise<void> {
    const id = key(configId, channelId);
    const row = await this.row("chat_drafts", id);
    const next: DraftRow = {
      text: row?.text ?? "",
      reply_to: row?.reply_to ?? null,
      edit_of: row?.edit_of ?? null,
      edit_text: row?.edit_text ?? null,
      mentions: row?.mentions ?? null,
      ...patch,
    };
    if (next.text === "" && next.reply_to === null && next.edit_of === null && next.mentions === null
      && (await this.draftFiles(configId, channelId)).length === 0) {
      if (row) await this.del("chat_drafts", { id });
      return;
    }
    await this.put("chat_drafts", { id, config_id: configId, channel_id: channelId, ...next, updated_at: this.now() });
  }

  /** Stores the draft text of a conversation; an empty text with nothing else in the draft deletes its row. */
  async putDraftText(configId: string, channelId: number, text: string): Promise<void> {
    await this.patchDraft(configId, channelId, { text });
  }

  /** Stores the message a conversation's draft text answers; null for none. */
  async putDraftReply(configId: string, channelId: number, target: MessageTarget | null): Promise<void> {
    await this.patchDraft(configId, channelId, { reply_to: target ? JSON.stringify(target) : null });
  }

  /** Stores the edit in progress of a conversation's composer, its message and its text; null ends it. */
  async putDraftEdit(configId: string, channelId: number, edit: { target: MessageTarget; text: string } | null): Promise<void> {
    await this.patchDraft(configId, channelId, {
      edit_of: edit ? JSON.stringify(edit.target) : null,
      edit_text: edit ? edit.text : null,
    });
  }

  /** Ends the edit in progress of a conversation's draft when it is still the edit of `target`. */
  async removeDraftEdit(configId: string, channelId: number, target: MessageTarget): Promise<void> {
    const editOf = storedTarget((await this.row("chat_drafts", key(configId, channelId)))?.edit_of);
    if (editOf && sameTarget(editOf, target)) await this.putDraftEdit(configId, channelId, null);
  }

  /** Stores the people and channels picked in a conversation's composer; none stores null. */
  async putDraftMentions(configId: string, channelId: number, mentions: Mentions): Promise<void> {
    const none = mentions.partners.length === 0 && mentions.channels.length === 0;
    await this.patchDraft(configId, channelId, { mentions: none ? null : JSON.stringify(mentions) });
  }

  /**
   * Empties a conversation's draft text when it is still `text` (blanks
   * around aside): the text a post took. Its reply target goes with it
   * when it names `replyTo` (the post's parent), and so do the picks while
   * no edit is in progress. A draft typed on since is left, and so is one
   * stored after `notAfter` (an ISO time, the post's): the same text typed
   * again once the post was queued.
   */
  async removeDraftText(
    configId: string,
    channelId: number,
    text: string,
    notAfter?: string,
    replyTo?: MessageTarget | null,
  ): Promise<void> {
    const row = await this.row("chat_drafts", key(configId, channelId));
    if (!row || (row.text ?? "").trim() !== text.trim()) return;
    if (notAfter !== undefined && row.updated_at > notAfter) return;
    const stored = storedTarget(row.reply_to);
    const answered = !!stored && !!replyTo && sameTarget(stored, replyTo);
    if (!row.text && !answered) return;
    await this.patchDraft(configId, channelId, {
      text: "",
      ...(answered ? { reply_to: null } : {}),
      ...(row.edit_of ? {} : { mentions: null }),
    });
  }

  /** Deletes a conversation's draft row left with no text, no reply target, no edit and no picks once no draft file is left. */
  private async tidyDraft(configId: string, channelId: number): Promise<void> {
    const row = await this.row("chat_drafts", key(configId, channelId));
    if (row && !row.text && !row.reply_to && !row.edit_of && !row.mentions && (await this.draftFiles(configId, channelId)).length === 0) {
      await this.del("chat_drafts", { id: row.id });
    }
  }

  /**
   * Stores a file of a conversation's composer as a draft row (`l<uuid>`,
   * no post). A row of that uuid already given to a post is left as it is:
   * a late write never takes a queued file back.
   */
  async putDraftFile(a: ChatAttachment): Promise<void> {
    const stored = a.localUuid ? await this.attachmentByKey(a.configId, `l${a.localUuid}`) : null;
    if (stored && stored.state !== "draft") return;
    await this.put("chat_attachments", this.attachmentRow({
      ...a, messageId: null, attachmentId: null, postClientUuid: null, state: "draft", error: null,
    }));
  }

  /**
   * Drops a draft file's row and returns its paths without releasing them
   * (the caller deletes the staged file); a row that is not a draft stays
   * and gives none.
   */
  async removeDraftFile(configId: string, localUuid: string): Promise<string[]> {
    const row = await this.attachmentByKey(configId, `l${localUuid}`);
    if (!row || row.state !== "draft") return [];
    await this.del("chat_attachments", { id: key(configId, `l${localUuid}`) });
    await this.tidyDraft(configId, row.channelId);
    return pathsOf(row);
  }

  /**
   * Gives draft files to a post, each at its position among the post's
   * files: one UPDATE per row of its `l<uuid>` key, still a draft, so the
   * row, its uuid and its staged file stay the same (a compressed photo
   * brings its new path and size). `state` is "refused" (error "channel")
   * for a conversation that cannot take a post.
   */
  async queueDrafts(
    configId: string,
    channelId: number,
    postClientUuid: string,
    files: { file: OutgoingFile; seq: number }[],
    state: "queued" | "refused",
  ): Promise<void> {
    for (const { file: f, seq } of files) {
      await this.db.rawRun(
        "UPDATE chat_attachments SET state = ?, error = ?, post_client_uuid = ?, seq = ?, channel_id = ?, name = ?, "
          + "mimetype = ?, size = ?, original_path = ?, original_bytes = ? WHERE id = ? AND state = ?",
        [state, state === "refused" ? "channel" : null, postClientUuid, seq, channelId, f.name, f.mimetype, f.size,
          f.path, f.size, key(configId, `l${f.localUuid}`), "draft"],
      );
    }
    await this.tidyDraft(configId, channelId);
  }

  /** Gives the files of a post that was never queued back to the draft of their conversation. */
  async backToDraft(configId: string, localUuids: string[]): Promise<void> {
    for (const uuid of localUuids) {
      await this.db.rawRun(
        "UPDATE chat_attachments SET state = ?, error = ?, post_client_uuid = ?, attachment_id = ? WHERE id = ?",
        ["draft", null, null, null, key(configId, `l${uuid}`)],
      );
    }
  }

  /**
   * Moves the draft of a temporary id (its text, reply target, edit and
   * picks) to the server's id; a draft already there stays unless the moved
   * one has words, a reply target or an edit.
   */
  private async moveDraftText(configId: string, tempId: number, realId: number): Promise<void> {
    const temp = await this.row("chat_drafts", key(configId, tempId));
    if (!temp) return;
    await this.del("chat_drafts", { id: temp.id });
    if (temp.text || temp.reply_to || temp.edit_of || !(await this.row("chat_drafts", key(configId, realId)))) {
      await this.put("chat_drafts", { ...temp, id: key(configId, realId), channel_id: realId });
    }
  }

  /** Per conversation of the account with a draft: its text, how many files it keeps, and whether an edit is in progress. */
  async draftSummaries(configId: string): Promise<Map<number, { text: string; files: number; editing: boolean }>> {
    const out = new Map<number, { text: string; files: number; editing: boolean }>();
    for (const r of await this.rows("chat_drafts", { config_id: configId })) {
      if (r.text || r.edit_of) out.set(r.channel_id, { text: r.text ?? "", files: 0, editing: !!r.edit_of });
    }
    for (const r of await this.rows("chat_attachments", { config_id: configId, state: "draft" })) {
      const d = out.get(r.channel_id) ?? { text: "", files: 0, editing: false };
      d.files++;
      out.set(r.channel_id, d);
    }
    return out;
  }

  /** Keys `configId#channelId` of the conversations with a draft (text or files), of one account or all. */
  async draftChannels(configId?: string): Promise<Set<string>> {
    const texts = configId ? await this.rows("chat_drafts", { config_id: configId }) : await this.db.rawQuery("SELECT * FROM chat_drafts");
    const files = configId
      ? await this.rows("chat_attachments", { config_id: configId, state: "draft" })
      : await this.rows("chat_attachments", { state: "draft" });
    return new Set([
      ...texts.filter((r) => r.text).map((r) => key(r.config_id, r.channel_id)),
      ...files.map((r) => key(r.config_id, r.channel_id)),
    ]);
  }

  /** How many draft files the account keeps on the phone. */
  async draftFileCount(configId: string): Promise<number> {
    return (await this.rows("chat_attachments", { config_id: configId, state: "draft" })).length;
  }
}
