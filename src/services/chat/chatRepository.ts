import type { DatabaseService } from "../databaseService";
import type {
  ChatChannel,
  ChatMember,
  ChatMessage,
  ChatPartner,
  ChatSourceState,
} from "../../models/chat";
import type { StoreDelta } from "./chatStore";

type Row = Record<string, any>;

const bool = (v: any): boolean => v === 1 || v === true;
const flag = (v: boolean): number => (v ? 1 : 0);

/** The key of a row: `configId#<local key>`, so accounts never share a row. */
const key = (configId: string, local: string | number): string => `${configId}#${local}`;

function defined<T extends object>(p: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(p) as (keyof T)[]) {
    if (p[k] !== undefined) out[k] = p[k];
  }
  return out;
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
  };
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
  };
}

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
 * writes the whole row back. Queries are equality-only; ordering and paging
 * happen here.
 */
export class ChatRepository {
  constructor(private db: DatabaseService) {}

  private now(): string {
    return new Date().toISOString();
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
    };
  }

  private messageRow(m: ChatMessage): Row {
    const local = m.messageId !== null ? `m${m.messageId}` : `u${m.clientUuid}`;
    return {
      id: key(m.configId, local),
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
    };
  }

  /**
   * Applies a store delta: upserts first, then deletions, so a record both
   * upserted and deleted in one delta ends deleted. A channel deletion takes
   * its messages and members with it.
   */
  async applyDelta(configId: string, d: StoreDelta): Promise<void> {
    for (const p of d.channels) await this.upsertChannel(configId, p);
    for (const p of d.members) await this.upsertMember(configId, p);
    for (const p of d.messages) await this.upsertMessage(configId, p);
    for (const p of d.partners) {
      await this.put("chat_partners", {
        id: key(configId, p.partnerId),
        config_id: configId,
        partner_id: p.partnerId,
        name: p.name,
        im_status: p.imStatus,
      });
    }
    for (const id of d.deletedMemberIds) await this.del("chat_members", { id: key(configId, id) });
    for (const id of d.deletedChannelIds) {
      await this.del("chat_channels", { id: key(configId, id) });
      await this.del("chat_messages", { config_id: configId, channel_id: id });
      await this.del("chat_members", { config_id: configId, channel_id: id });
    }
    const state: Partial<ChatSourceState> = {};
    if (d.inboxCounter !== null) state.inboxCounter = d.inboxCounter;
    if (d.selfPartnerId !== null) state.selfPartnerId = d.selfPartnerId;
    if (Object.keys(state).length > 0) await this.setSourceState({ ...state, configId });
  }

  private async upsertChannel(configId: string, p: Partial<ChatChannel> & { channelId: number }): Promise<void> {
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
        };
    const patch = defined(p);
    if (patch.name === "" && base.name !== "") delete patch.name;
    const next: ChatChannel = { ...base, ...patch, configId };
    next.lastMessageId = maxOf(base.lastMessageId, patch.lastMessageId);
    next.oldestLoadedId = minOf(base.oldestLoadedId, patch.oldestLoadedId);
    await this.put("chat_channels", this.channelRow(next));
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
        };
    await this.put("chat_members", this.memberRow({ ...base, ...defined(p), configId }));
  }

  private async upsertMessage(configId: string, p: Partial<ChatMessage> & { messageId: number }): Promise<void> {
    const id = key(configId, `m${p.messageId}`);
    let base: ChatMessage | null = null;
    const stored = await this.row("chat_messages", id);
    if (stored) base = messageFromRow(stored);
    // A bus echo of a queued post carries its client uuid: the queued row folds into it
    if (p.clientUuid) {
      const queued = await this.row("chat_messages", key(configId, `u${p.clientUuid}`));
      if (queued) {
        base = { ...messageFromRow(queued), ...(base ? defined(base) : {}) };
        await this.del("chat_messages", { id: queued.id });
      }
    }
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
    };
    const next: ChatMessage = { ...fresh, ...defined(p), configId };
    if (!base && p.status === undefined) next.status = "sent";
    if (base && base.messageId === null) next.status = p.status ?? "sent";
    await this.put("chat_messages", this.messageRow(next));
  }

  /** Every channel of one account, or of all accounts without an argument. */
  async channels(configId?: string): Promise<ChatChannel[]> {
    const rows = configId
      ? await this.rows("chat_channels", { config_id: configId })
      : await this.db.rawQuery("SELECT * FROM chat_channels");
    return rows.map(channelFromRow);
  }

  async channel(configId: string, channelId: number): Promise<ChatChannel | null> {
    const row = await this.row("chat_channels", key(configId, channelId));
    return row ? channelFromRow(row) : null;
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
    const merged: ChatMessage = {
      ...(queued ? messageFromRow(queued) : {}),
      ...(echoed ? defined(messageFromRow(echoed)) : {}),
      ...defined(patch),
      configId,
      messageId,
      clientUuid,
      status: "sent",
      outboxOpId: null,
    } as ChatMessage;
    if (queued) await this.del("chat_messages", { id: queuedId });
    await this.put("chat_messages", this.messageRow(merged));
  }

  /** Flags a queued message as given up on. The row has no error column: the outbox keeps the reason. */
  async markFailed(configId: string, clientUuid: string, _error: string): Promise<void> {
    const queued = await this.row("chat_messages", key(configId, `u${clientUuid}`));
    if (!queued) return;
    await this.put("chat_messages", this.messageRow({ ...messageFromRow(queued), status: "failed" }));
  }

  async members(configId: string, channelId: number): Promise<ChatMember[]> {
    return (await this.rows("chat_members", { config_id: configId, channel_id: channelId })).map(memberFromRow);
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
    };
  }

  async setSourceState(s: Partial<ChatSourceState> & { configId: string }): Promise<void> {
    const base = await this.sourceState(s.configId);
    await this.put("chat_sources", this.sourceRow({ ...base, ...defined(s) }));
  }

  /** Removes every cached row of one account, leaving the others. */
  async dropSource(configId: string): Promise<void> {
    for (const t of ["chat_channels", "chat_messages", "chat_members", "chat_partners", "chat_sources"]) {
      await this.del(t, { config_id: configId });
    }
  }
}
