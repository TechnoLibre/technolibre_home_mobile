import type { ChatChannel } from "../../models/chat";
import type { ListOrder } from "./chatSettings";

/** Epoch milliseconds of an Odoo "YYYY-MM-DD HH:MM:SS" UTC string ("muted forever" is year 9999). */
function utcMs(odooDt: string): number {
  return Date.parse(odooDt.replace(" ", "T") + "Z");
}

/** Whether an Odoo date is set and still ahead of `now`. */
function ahead(dt: string | null | undefined, now: Date): boolean {
  if (!dt) return false;
  const until = utcMs(dt);
  return Number.isFinite(until) && until > now.getTime();
}

/**
 * Messages a conversation counts as unread: a chat or group counts every
 * unread message, a channel only the ones that mention the user.
 */
export function unreadOf(c: ChatChannel): number {
  return c.channelType === "channel" ? c.needactionCounter : c.unreadCounter;
}

/** Unread messages exist, counted or not: a channel with unread but no mention is bold, not counted. */
export function isBold(c: ChatChannel): boolean {
  return c.unreadCounter > 0 || c.needactionCounter > 0;
}

/**
 * Muted until a date still ahead of `now`, the conversation's own or the
 * account-wide one (`globalMuteUntil`), as Odoo's Thread.isMuted: the
 * "no_notif" setting only silences notifications, the conversation still
 * counts.
 */
export function isMuted(c: ChatChannel, now: Date, globalMuteUntil?: string | null): boolean {
  return ahead(c.muteUntilDt, now) || ahead(globalMuteUntil, now);
}

/** Messages the tile and chips show: the inbox counters plus every conversation not muted. */
export function totalUnread(
  channels: ChatChannel[],
  inboxCounters: number[],
  now: Date,
  globalMuteUntil?: string | null,
): number {
  let total = inboxCounters.reduce((sum, n) => sum + n, 0);
  for (const c of channels) if (!isMuted(c, now, globalMuteUntil)) total += unreadOf(c);
  return total;
}

/**
 * Sorts the list. Inside every group the rule is a counted unread first,
 * then last_interest_dt descending (none last). `on_top_first`: the
 * conversations kept on top, then the others. `unread_first`: the counted
 * unread ones (on top or not), then the read ones kept on top, then the
 * other read ones. Returns a new array; ties keep their input order.
 */
export function sortConversations(channels: ChatChannel[], order: ListOrder = "on_top_first"): ChatChannel[] {
  const key = (c: ChatChannel) => c.lastInterestDt ?? "";
  const unread = (c: ChatChannel) => (unreadOf(c) > 0 ? 0 : 1);
  const top = (c: ChatChannel) => (c.onTop ? 0 : 1);
  const group = (c: ChatChannel) => (order === "unread_first" ? (unread(c) === 0 ? 0 : 1 + top(c)) : top(c));
  return [...channels].sort((a, b) => {
    const ga = group(a);
    const gb = group(b);
    if (ga !== gb) return ga - gb;
    const ua = unread(a);
    const ub = unread(b);
    if (ua !== ub) return ua - ub;
    return key(a) < key(b) ? 1 : key(a) > key(b) ? -1 : 0;
  });
}
