import type {
  ChatAttachment,
  ChatChannel,
  ChatMailboxItem,
  ChatMember,
  ChatMessage,
  ChatPartner,
  ChatReaction,
} from "../../models/chat";

/** A reaction group as the server sends it: the full group of one (message, content). */
export type ReactionGroup = Omit<ChatReaction, "configId" | "channelId" | "messageKey"> & { messageId: number };

/**
 * Normalized partial cache records read from an Odoo 18 Discuss "Store"
 * (the `/mail/data` result, a messages page, a post response or the payload
 * of a bus `mail.record/insert`). A partial holds only the keys the source
 * record carried, so applying it updates and never blanks a field.
 */
export interface StoreDelta {
  channels: (Partial<ChatChannel> & { channelId: number })[];
  deletedChannelIds: number[];
  members: (Partial<ChatMember> & { memberId: number })[];
  deletedMemberIds: number[];
  /** `attachmentIds`: the files the message lists, in order; kept on the attachment rows, not on the message. */
  messages: (Partial<ChatMessage> & { messageId: number; attachmentIds?: number[] })[];
  attachments: (Partial<ChatAttachment> & { attachmentId: number })[];
  deletedAttachmentIds: number[];
  partners: (Partial<ChatPartner> & { partnerId: number })[];
  inboxCounter: number | null;
  /** The number of starred messages (`Store.starred.counter`); absent or null when the Store has none. */
  starredCounter?: number | null;
  selfPartnerId: number | null;
  /** The account-wide mute end when the Store carries `settings`: a date, or null when unmuted. */
  globalMuteUntil?: string | null;
  /** Reaction groups (`MessageReactions`), each replacing the stored group of its (message, content). */
  reactions?: ReactionGroup[];
  /** A message's full list of reaction contents (a plain `reactions` list): its groups not named go. */
  reactionSets?: { messageId: number; contents: string[] }[];
  /** Groups whose last reaction was removed (`["DELETE", ...]` on a message's `reactions`). */
  deletedReactions?: { messageId: number; content: string }[];
  /** Messages the server deleted (bus `mail.message/delete`). */
  deletedMessageIds?: number[];
  /**
   * A channel's full list of pinned messages (/discuss/channel/pinned_messages):
   * its cached messages not named lose pinnedAt.
   */
  pinnedSets?: { channelId: number; messageIds: number[] }[];
  /**
   * Messages of the inbox, history and starred boxes: those of a record
   * (any model but the channels'), whose thread is known. A partial holds
   * only the keys the source carried.
   */
  mailbox?: (Partial<ChatMailboxItem> & { messageId: number })[];
}

const CHANNEL_MODEL = "discuss.channel";

/** Copies `src[from]` to `dst[to]` when the key exists, mapping the value. */
function copy(
  dst: any,
  src: any,
  from: string,
  to: string,
  map: (v: any) => any = (v) => v,
): void {
  if (from in src) dst[to] = map(src[from]);
}

/** Id of a relation value: a bare int, or `{id, ...}`; null for `false`. */
function relId(v: any): number | null {
  if (typeof v === "number") return v;
  if (v && typeof v === "object" && typeof v.id === "number") return v.id;
  return null;
}

/** Ids of a list relation given as a plain list or as `[["MODE", [...]]]` commands. */
function commandIds(v: any, mode: string): number[] {
  if (!Array.isArray(v)) return [];
  const out: number[] = [];
  for (const cmd of v) {
    if (Array.isArray(cmd) && cmd[0] === mode && Array.isArray(cmd[1])) {
      for (const x of cmd[1]) {
        const id = relId(x);
        if (id !== null) out.push(id);
      }
    }
  }
  return out;
}

/** `{message, content}` of a reaction relation value; null when either is missing. */
function reactionRef(v: any): { messageId: number; content: string } | null {
  const messageId = v && typeof v === "object" ? relId(v.message) : null;
  return messageId !== null && typeof v.content === "string" ? { messageId, content: v.content } : null;
}

/**
 * Reads a message's `reactions` value: a plain list is the message's full
 * set of contents, `["DELETE", x]` removes groups (`x` one `{message,
 * content}` or a list of them), `["ADD", ...]` names groups whose records
 * come in `MessageReactions`.
 */
function readReactions(messageId: number, v: any, delta: StoreDelta): void {
  if (!Array.isArray(v)) return;
  const commands = v.filter((x) => Array.isArray(x) && typeof x[0] === "string");
  if (commands.length === 0) {
    const contents = v.map(reactionRef).filter((r): r is NonNullable<typeof r> => r !== null).map((r) => r.content);
    delta.reactionSets!.push({ messageId, contents });
    return;
  }
  for (const [mode, refs] of commands) {
    if (mode !== "DELETE") continue;
    for (const ref of Array.isArray(refs) ? refs : [refs]) {
      const r = reactionRef(ref);
      if (r) delta.deletedReactions!.push(r);
    }
  }
}

/** The persona of a member as a partner id; null for a guest or a missing persona. */
function personaPartnerId(persona: any): number | null {
  return persona && persona.type === "partner" ? relId(persona) : null;
}

/** The channel id of a `{id, model}` thread; null when it is another model. */
function channelOfThread(thread: any): number | null {
  return thread && thread.model === CHANNEL_MODEL ? relId(thread) : null;
}

/**
 * The record a message belongs to, from its `thread` (`{id, model}`) or,
 * without one, its `model` and `res_id`; null for a message with neither.
 */
function recordOfMessage(m: any): { model: string; id: number } | null {
  const thread = m.thread;
  if (thread && typeof thread === "object") {
    const id = relId(thread);
    return typeof thread.model === "string" && id !== null ? { model: thread.model, id } : null;
  }
  if (typeof m.model === "string" && m.model && typeof m.res_id === "number") {
    return { model: m.model, id: m.res_id };
  }
  return null;
}

/** The mailbox partial of a message of a record: the keys the source carried, its thread always. */
function mailboxPartial(
  m: any,
  record: { model: string; id: number },
  threadNames: Map<string, string>,
): NonNullable<StoreDelta["mailbox"]>[number] {
  const out: NonNullable<StoreDelta["mailbox"]>[number] = {
    messageId: m.id,
    threadModel: record.model,
    threadId: record.id,
  };
  const name = threadNames.get(`${record.model}#${record.id}`) ?? (typeof m.record_name === "string" ? m.record_name : "");
  if (name) out.recordName = name;
  if ("author" in m) out.authorPartnerId = m.author && m.author.type === "partner" ? relId(m.author) : null;
  copy(out, m, "body", "body", (v) => (v === false || v == null ? "" : String(v)));
  copy(out, m, "date", "date", (v) => v || null);
  copy(out, m, "message_type", "messageType");
  copy(out, m, "needaction", "needaction", (v) => !!v);
  copy(out, m, "starred", "starred", (v) => !!v);
  return out;
}

/**
 * The mailbox partials of the channel messages a mailbox page carries:
 * `parseStore` keeps them in `messages`, and the boxes show them too. `ids`
 * are the page's message ids, `flags` what the box says of them (needaction,
 * history, starred); a channel's name stands for the record name when the
 * delta carries it. Messages of records are already partials of the delta.
 */
export function mailboxPartialsOf(
  delta: StoreDelta,
  ids: number[],
  flags: Partial<ChatMailboxItem>,
): StoreDelta["mailbox"] {
  const wanted = new Set(ids);
  const names = new Map(delta.channels.map((c) => [c.channelId, c.name]));
  const out: NonNullable<StoreDelta["mailbox"]> = [];
  for (const m of delta.messages) {
    if (!wanted.has(m.messageId) || m.channelId === undefined) continue;
    const row: NonNullable<StoreDelta["mailbox"]>[number] = {
      messageId: m.messageId,
      threadModel: CHANNEL_MODEL,
      threadId: m.channelId,
    };
    const name = names.get(m.channelId);
    if (name) row.recordName = name;
    for (const k of ["authorPartnerId", "body", "date", "messageType"] as const) {
      if (m[k] !== undefined) (row as any)[k] = m[k];
    }
    out.push({ ...row, ...flagsOf(flags) });
  }
  return out;
}

/** The flags of a box that carry a value. */
function flagsOf(flags: Partial<ChatMailboxItem>): Partial<ChatMailboxItem> {
  const out: Partial<ChatMailboxItem> = {};
  for (const k of ["needaction", "starred", "history"] as const) {
    if (flags[k] !== undefined) out[k] = flags[k];
  }
  return out;
}

/**
 * Reads a Store result into partial cache records. `selfPartnerId` is the
 * known partner of the account; when null, `Store.self` supplies it.
 */
export function parseStore(
  result: any,
  configId: string,
  selfPartnerId: number | null,
): StoreDelta {
  const res = result && typeof result === "object" ? result : {};
  const store = res.Store && typeof res.Store === "object" ? res.Store : {};
  const delta: StoreDelta = {
    channels: [],
    deletedChannelIds: [],
    members: [],
    deletedMemberIds: [],
    messages: [],
    attachments: [],
    deletedAttachmentIds: [],
    partners: [],
    inboxCounter: null,
    selfPartnerId,
    reactions: [],
    reactionSets: [],
    deletedReactions: [],
    mailbox: [],
  };

  if (store.self && store.self.type === "partner" && relId(store.self) !== null) {
    delta.selfPartnerId = selfPartnerId ?? relId(store.self);
  }
  if (store.inbox && typeof store.inbox.counter === "number") {
    delta.inboxCounter = store.inbox.counter;
  }
  if (store.starred && typeof store.starred.counter === "number") {
    delta.starredCounter = store.starred.counter;
  }
  if (store.settings && typeof store.settings === "object" && "mute_until_dt" in store.settings) {
    delta.globalMuteUntil = store.settings.mute_until_dt || null;
  }
  const self = delta.selfPartnerId;

  const partnerNames = new Map<number, string>();
  for (const p of res["res.partner"] || []) {
    if (typeof p.id !== "number" || p._DELETE) continue;
    const row: StoreDelta["partners"][number] = { configId, partnerId: p.id };
    if (typeof p.name === "string") {
      row.name = p.name;
      partnerNames.set(p.id, p.name);
    }
    if ("im_status" in p) row.imStatus = typeof p.im_status === "string" ? p.im_status : null;
    delta.partners.push(row);
  }

  const channels = new Map<number, Partial<ChatChannel> & { channelId: number }>();
  const channelOf = (channelId: number) => {
    let c = channels.get(channelId);
    if (!c) {
      c = { channelId };
      channels.set(channelId, c);
    }
    return c;
  };

  // Members: rows of every kind, plus the self member's counters on its channel.
  const memberRows = new Map<number, any>();
  for (const m of res["discuss.channel.member"] || []) {
    if (typeof m.id === "number") memberRows.set(m.id, m);
  }
  const correspondents = new Map<number, number>();

  const applySelfMember = (channelId: number, m: any) => {
    const c = channelOf(channelId);
    c.isMember = true;
    copy(c, m, "message_unread_counter", "unreadCounter");
    copy(c, m, "message_unread_counter_bus_id", "unreadCounterBusId");
    copy(c, m, "new_message_separator", "newMessageSeparator");
    copy(c, m, "seen_message_id", "seenMessageId", (v) => relId(v));
  };

  for (const m of memberRows.values()) {
    if (m._DELETE) {
      delta.deletedMemberIds.push(m.id);
      continue;
    }
    const row: Partial<ChatMember> & { memberId: number } = { memberId: m.id };
    const channelId = "thread" in m ? channelOfThread(m.thread) : null;
    if (channelId !== null) row.channelId = channelId;
    const partnerId = "persona" in m ? personaPartnerId(m.persona) : null;
    if (partnerId !== null) row.partnerId = partnerId;
    copy(row, m, "seen_message_id", "seenMessageId", (v) => relId(v));
    copy(row, m, "fetched_message_id", "fetchedMessageId", (v) => relId(v));
    copy(row, m, "isTyping", "isTyping", (v) => !!v);
    copy(row, m, "is_typing_dt", "typingAt", (v) => v || null);
    copy(row, m, "create_date", "createDate", (v) => v || null);
    delta.members.push(row);

    if (channelId === null || partnerId === null) continue;
    if (self !== null && partnerId === self) {
      applySelfMember(channelId, m);
    } else if (!correspondents.has(channelId)) {
      correspondents.set(channelId, partnerId);
    }
  }

  for (const rec of res[CHANNEL_MODEL] || []) {
    if (typeof rec.id !== "number") continue;
    if (rec._DELETE) {
      delta.deletedChannelIds.push(rec.id);
      continue;
    }
    const c = channelOf(rec.id);
    copy(c, rec, "channel_type", "channelType");
    copy(c, rec, "name", "name", (v) => v || "");
    copy(c, rec, "description", "description", (v) => v || "");
    copy(c, rec, "last_interest_dt", "lastInterestDt", (v) => v || null);
    copy(c, rec, "message_needaction_counter", "needactionCounter");
    copy(c, rec, "message_needaction_counter_bus_id", "needactionCounterBusId");
    copy(c, rec, "mute_until_dt", "muteUntilDt", (v) => v || null);
    copy(c, rec, "custom_notifications", "customNotifications", (v) => v || null);
    copy(c, rec, "is_pinned", "isPinned", (v) => !!v);
    copy(c, rec, "is_editable", "isEditable", (v) => (v == null ? null : !!v));
    copy(c, rec, "custom_channel_name", "customChannelName", (v) => v || null);
    copy(c, rec, "memberCount", "memberCount", (v) => (typeof v === "number" ? v : null));
    copy(c, rec, "group_public_id", "groupPublicId", (v) => relId(v));
    copy(c, rec, "authorizedGroupFullName", "authorizedGroupFullName", (v) => v || null);
    copy(c, rec, "create_uid", "createUid", (v) => relId(v));
    copy(c, rec, "group_based_subscription", "groupBasedSubscription", (v) => !!v);
    copy(c, rec, "parent_channel_id", "parentChannelId", (v) => relId(v));
    delta.deletedMemberIds.push(...commandIds(rec.channelMembers, "DELETE"));

    // selfMember: a member id (row sent in the same result), an inline row, or false.
    if ("selfMember" in rec) {
      const sm = rec.selfMember;
      if (!sm) {
        c.isMember = false;
      } else if (typeof sm === "number") {
        const row = memberRows.get(sm);
        if (row) applySelfMember(rec.id, row);
        else c.isMember = true;
      } else if (typeof sm === "object") {
        applySelfMember(rec.id, sm);
      }
    }
  }

  // Chat extras: the other partner of a chat, and its name as the fallback.
  for (const c of channels.values()) {
    const other = correspondents.get(c.channelId);
    if (other === undefined) continue;
    if (c.channelType === "chat") {
      c.correspondentPartnerId = other;
      if (!c.name && partnerNames.has(other)) c.name = partnerNames.get(other)!;
    }
  }

  // Record names: the `mail.thread` entries a page lists, by model and id
  const threadNames = new Map<string, string>();
  for (const t of res["mail.thread"] || []) {
    if (t && typeof t.id === "number" && typeof t.model === "string" && typeof t.name === "string" && t.name) {
      threadNames.set(`${t.model}#${t.id}`, t.name);
    }
  }

  const lastByChannel = new Map<number, number>();
  for (const m of res["mail.message"] || []) {
    if (typeof m.id !== "number" || m._DELETE) continue;
    let channelId: number | null = null;
    const record = recordOfMessage(m);
    if (record && record.model !== CHANNEL_MODEL) {
      delta.mailbox!.push(mailboxPartial(m, record, threadNames));
      continue;
    }
    if ("thread" in m) {
      channelId = channelOfThread(m.thread);
      if (channelId === null) continue;
    } else if (m.model === CHANNEL_MODEL && typeof m.res_id === "number") {
      channelId = m.res_id;
    } else if ("model" in m && m.model !== CHANNEL_MODEL) {
      continue;
    }
    const msg: StoreDelta["messages"][number] = { messageId: m.id };
    if (channelId !== null) {
      msg.channelId = channelId;
      lastByChannel.set(channelId, Math.max(lastByChannel.get(channelId) ?? 0, m.id));
    }
    if ("author" in m) {
      msg.authorPartnerId =
        m.author && m.author.type === "partner" ? relId(m.author) : null;
    }
    copy(msg, m, "body", "body", (v) => (v === false || v == null ? "" : String(v)));
    copy(msg, m, "date", "date");
    copy(msg, m, "message_type", "messageType");
    copy(msg, m, "write_date", "writeDate", (v) => v || null);
    copy(msg, m, "attachment_ids", "attachmentIds", (v) =>
      (Array.isArray(v) ? v : []).map((x: any) => relId(x)).filter((x: number | null): x is number => x !== null),
    );
    copy(msg, m, "parentMessage", "parentId", (v) => relId(v));
    copy(msg, m, "recipients", "recipientIds", (v) =>
      (Array.isArray(v) ? v : []).map(personaPartnerId).filter((x: number | null): x is number => x !== null),
    );
    copy(msg, m, "pinned_at", "pinnedAt", (v) => v || null);
    copy(msg, m, "starred", "starred", (v) => !!v);
    if ("reactions" in m) readReactions(m.id, m.reactions, delta);
    delta.messages.push(msg);
  }

  // Reaction groups (mail_message_reaction.py _to_store): personas are guests then partners
  for (const g of res.MessageReactions || []) {
    const ref = reactionRef(g);
    if (!ref) continue;
    if (g._DELETE) {
      delta.deletedReactions!.push(ref);
      continue;
    }
    const personas: any[] = Array.isArray(g.personas) ? g.personas : [];
    const partnerIds = personas.map(personaPartnerId).filter((x): x is number => x !== null);
    delta.reactions!.push({
      ...ref,
      count: typeof g.count === "number" ? g.count : personas.length,
      selfReacted: self !== null && partnerIds.includes(self),
      partnerIds,
      guestCount: personas.filter((x) => x && x.type === "guest").length,
      sequence: typeof g.sequence === "number" ? g.sequence : 0,
    });
  }
  for (const [channelId, last] of lastByChannel) {
    if (channels.has(channelId)) channels.get(channelId)!.lastMessageId = last;
  }

  // A record with a `thread` of another model is no chat file; one without keeps what the source carried
  for (const a of res["ir.attachment"] || []) {
    if (typeof a.id !== "number") continue;
    if (a._DELETE) {
      delta.deletedAttachmentIds.push(a.id);
      continue;
    }
    const row: StoreDelta["attachments"][number] = { attachmentId: a.id };
    if ("thread" in a) {
      const channelId = channelOfThread(a.thread);
      if (channelId === null) continue;
      row.channelId = channelId;
    }
    copy(row, a, "checksum", "checksum", (v) => v || null);
    copy(row, a, "mimetype", "mimetype", (v) => v || "");
    copy(row, a, "name", "name", (v) => v || "");
    copy(row, a, "size", "size", (v) => (typeof v === "number" ? v : 0));
    copy(row, a, "voice", "voice", (v) => !!v);
    delta.attachments.push(row);
  }

  delta.channels = [...channels.values()];
  return delta;
}

/** Merges records by `key`; for the same key the later record's fields win. */
function mergeBy<T extends object>(a: T[], b: T[], key: keyof T): T[] {
  const out = new Map<unknown, T>();
  for (const r of [...a, ...b]) {
    const k = r[key];
    out.set(k, { ...(out.get(k) || {}), ...r } as T);
  }
  return [...out.values()];
}

function union(a: number[], b: number[]): number[] {
  return [...new Set([...a, ...b])];
}

const reactionKey = (r: { messageId: number; content: string }): string => `${r.messageId}#${r.content}`;

/**
 * The reaction parts of `a` then `b` as one delta, applied by applyDelta as
 * sets, then groups, then deletions. A set of `b` drops the groups of `a` it
 * does not name; a group of `b` cancels a deletion of `a` and a deletion
 * of `b` an earlier group, so the groups and the deletions never share a
 * (message, content).
 */
function mergeReactions(
  a: StoreDelta,
  b: StoreDelta,
): Pick<StoreDelta, "reactions" | "reactionSets" | "deletedReactions"> {
  const laterSets = new Map((b.reactionSets ?? []).map((s) => [s.messageId, new Set(s.contents)]));
  const laterGroups = new Set((b.reactions ?? []).map(reactionKey));
  const laterDeleted = new Set((b.deletedReactions ?? []).map(reactionKey));
  const named = (r: { messageId: number; content: string }) => laterSets.get(r.messageId)?.has(r.content) ?? true;
  const groups = new Map<string, ReactionGroup>();
  for (const r of a.reactions ?? []) {
    if (named(r) && !laterDeleted.has(reactionKey(r))) groups.set(reactionKey(r), r);
  }
  for (const r of b.reactions ?? []) groups.set(reactionKey(r), r);
  const deleted = new Map<string, { messageId: number; content: string }>();
  for (const r of [...(a.deletedReactions ?? []), ...(b.deletedReactions ?? [])]) {
    if (!laterGroups.has(reactionKey(r))) deleted.set(reactionKey(r), r);
  }
  return {
    reactions: [...groups.values()],
    reactionSets: mergeBy(a.reactionSets ?? [], b.reactionSets ?? [], "messageId"),
    deletedReactions: [...deleted.values()],
  };
}

/** Combines two deltas as if `b` was applied after `a`. */
export function mergeDeltas(a: StoreDelta, b: StoreDelta): StoreDelta {
  return {
    channels: mergeBy(a.channels, b.channels, "channelId"),
    deletedChannelIds: union(a.deletedChannelIds, b.deletedChannelIds),
    members: mergeBy(a.members, b.members, "memberId"),
    deletedMemberIds: union(a.deletedMemberIds, b.deletedMemberIds),
    messages: mergeBy(a.messages, b.messages, "messageId"),
    attachments: mergeBy(a.attachments, b.attachments, "attachmentId"),
    deletedAttachmentIds: union(a.deletedAttachmentIds, b.deletedAttachmentIds),
    partners: mergeBy(a.partners, b.partners, "partnerId"),
    inboxCounter: b.inboxCounter ?? a.inboxCounter,
    starredCounter: b.starredCounter ?? a.starredCounter,
    selfPartnerId: b.selfPartnerId ?? a.selfPartnerId,
    globalMuteUntil: b.globalMuteUntil !== undefined ? b.globalMuteUntil : a.globalMuteUntil,
    ...mergeReactions(a, b),
    deletedMessageIds: union(a.deletedMessageIds ?? [], b.deletedMessageIds ?? []),
    pinnedSets: mergeBy(a.pinnedSets ?? [], b.pinnedSets ?? [], "channelId"),
    mailbox: mergeBy(a.mailbox ?? [], b.mailbox ?? [], "messageId"),
  };
}
