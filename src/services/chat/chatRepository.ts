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

/** The keys of a row that carry a value: not null, "" or 0 (a column the source never filled). */
function meaningful<T extends object>(p: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(p) as (keyof T)[]) {
    const v = p[k];
    if (v !== undefined && v !== null && v !== "" && v !== 0) out[k] = v;
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
    };
  }

  /**
   * Applies a store delta: upserts first, then deletions, so a record both
   * upserted and deleted in one delta ends deleted. A channel deletion takes
   * its members and server messages with it; the messages it still had to
   * post stay, as failed and detached from the outbox, so the text typed is
   * not lost (the conversation screen shows them). Channel counters follow
   * gateCounter; `fromBus` says the delta comes from a bus delivery, where
   * a counter without its bus id is not taken.
   */
  async applyDelta(configId: string, d: StoreDelta, opts: { fromBus?: boolean } = {}): Promise<void> {
    for (const p of d.channels) await this.upsertChannel(configId, p, !!opts.fromBus);
    for (const p of d.members) await this.upsertMember(configId, p);
    for (const p of d.messages) await this.upsertMessage(configId, p);
    for (const p of d.partners) await this.upsertPartner(configId, p);
    for (const id of d.deletedMemberIds) await this.del("chat_members", { id: key(configId, id) });
    for (const id of d.deletedChannelIds) {
      await this.del("chat_channels", { id: key(configId, id) });
      for (const r of await this.rows("chat_messages", { config_id: configId, channel_id: id })) {
        const m = messageFromRow(r);
        if (m.messageId !== null) await this.del("chat_messages", { id: r.id });
        else await this.put("chat_messages", this.messageRow({ ...m, status: "failed", outboxOpId: null }));
      }
      await this.del("chat_members", { config_id: configId, channel_id: id });
    }
    const state: Partial<ChatSourceState> = {};
    if (d.inboxCounter !== null) state.inboxCounter = d.inboxCounter;
    if (d.selfPartnerId !== null) state.selfPartnerId = d.selfPartnerId;
    if (d.globalMuteUntil !== undefined) {
      state.globalMuteUntil = d.globalMuteUntil;
      if (opts.fromBus) state.globalMuteAt = this.now();
    }
    if (Object.keys(state).length > 0) await this.setSourceState({ ...state, configId });
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
    };
    const next: ChatMessage = { ...fresh, ...defined(p), configId };
    if (!base && p.status === undefined) next.status = "sent";
    await this.put("chat_messages", this.messageRow(next));
  }

  /**
   * The one final state of a queued post that reached the server: a single
   * sent row, client uuid kept, no outbox op. The queued row supplies what the
   * user typed; the server's row overlays only the values it really carries,
   * so a bus record without a body never blanks the text.
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
    return rows.map(channelFromRow);
  }

  async channel(configId: string, channelId: number): Promise<ChatChannel | null> {
    const row = await this.row("chat_channels", key(configId, channelId));
    return row ? channelFromRow(row) : null;
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
   * gave it: its messages, its members, and the channelId of every outbox
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
   * sent included: the user dismissed it.
   */
  async dropChannel(configId: string, channelId: number): Promise<void> {
    for (const t of ["chat_channels", "chat_messages", "chat_members"]) {
      await this.del(t, { config_id: configId, channel_id: channelId });
    }
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

  /** A message the server knows, by its id; null when it is not cached. */
  async message(configId: string, messageId: number): Promise<ChatMessage | null> {
    const row = await this.row("chat_messages", key(configId, `m${messageId}`));
    return row ? messageFromRow(row) : null;
  }

  /**
   * The last server message of each given channel, by primary key (one
   * lookup per channel, no history scan). A channel without a known last
   * message, or whose last message is not cached, has no entry.
   */
  async lastMessages(configId: string, channels: ChatChannel[]): Promise<Map<number, ChatMessage>> {
    const found = await Promise.all(
      channels.map(async (c) => (c.lastMessageId == null ? null : await this.message(configId, c.lastMessageId))),
    );
    const out = new Map<number, ChatMessage>();
    channels.forEach((c, i) => {
      const m = found[i];
      if (m) out.set(c.channelId, m);
    });
    return out;
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

  /** Removes every cached row of one account, leaving the others. */
  async dropSource(configId: string): Promise<void> {
    for (const t of ["chat_channels", "chat_messages", "chat_members", "chat_partners", "chat_temp_ids", "chat_sources"]) {
      await this.del(t, { config_id: configId });
    }
  }
}
