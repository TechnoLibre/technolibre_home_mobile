import type {
  ChatChannel,
  ChatMember,
  ChatMessage,
  ChatPartner,
} from "../../models/chat";

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
  messages: (Partial<ChatMessage> & { messageId: number })[];
  partners: ChatPartner[];
  inboxCounter: number | null;
  selfPartnerId: number | null;
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

/** The persona of a member as a partner id; null for a guest or a missing persona. */
function personaPartnerId(persona: any): number | null {
  return persona && persona.type === "partner" ? relId(persona) : null;
}

/** The channel id of a `{id, model}` thread; null when it is another model. */
function channelOfThread(thread: any): number | null {
  return thread && thread.model === CHANNEL_MODEL ? relId(thread) : null;
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
    partners: [],
    inboxCounter: null,
    selfPartnerId,
  };

  if (store.self && store.self.type === "partner" && relId(store.self) !== null) {
    delta.selfPartnerId = selfPartnerId ?? relId(store.self);
  }
  if (store.inbox && typeof store.inbox.counter === "number") {
    delta.inboxCounter = store.inbox.counter;
  }
  const self = delta.selfPartnerId;

  const partnerNames = new Map<number, string>();
  for (const p of res["res.partner"] || []) {
    if (typeof p.id !== "number" || p._DELETE || typeof p.name !== "string") {
      continue;
    }
    partnerNames.set(p.id, p.name);
    delta.partners.push({
      configId,
      partnerId: p.id,
      name: p.name,
      imStatus: typeof p.im_status === "string" ? p.im_status : null,
    });
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

  const lastByChannel = new Map<number, number>();
  for (const m of res["mail.message"] || []) {
    if (typeof m.id !== "number" || m._DELETE) continue;
    let channelId: number | null = null;
    if ("thread" in m) {
      channelId = channelOfThread(m.thread);
      if (channelId === null) continue;
    } else if (m.model === CHANNEL_MODEL && typeof m.res_id === "number") {
      channelId = m.res_id;
    } else if ("model" in m && m.model !== CHANNEL_MODEL) {
      continue;
    }
    const msg: Partial<ChatMessage> & { messageId: number } = { messageId: m.id };
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
    delta.messages.push(msg);
  }
  for (const [channelId, last] of lastByChannel) {
    if (channels.has(channelId)) channels.get(channelId)!.lastMessageId = last;
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

/** Combines two deltas as if `b` was applied after `a`. */
export function mergeDeltas(a: StoreDelta, b: StoreDelta): StoreDelta {
  return {
    channels: mergeBy(a.channels, b.channels, "channelId"),
    deletedChannelIds: union(a.deletedChannelIds, b.deletedChannelIds),
    members: mergeBy(a.members, b.members, "memberId"),
    deletedMemberIds: union(a.deletedMemberIds, b.deletedMemberIds),
    messages: mergeBy(a.messages, b.messages, "messageId"),
    partners: mergeBy(a.partners, b.partners, "partnerId"),
    inboxCounter: b.inboxCounter ?? a.inboxCounter,
    selfPartnerId: b.selfPartnerId ?? a.selfPartnerId,
  };
}
