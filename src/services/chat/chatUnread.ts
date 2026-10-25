import type { ChatChannel } from "../../models/chat";

/** Epoch milliseconds of an Odoo "YYYY-MM-DD HH:MM:SS" UTC string ("muted forever" is year 9999). */
function utcMs(odooDt: string): number {
  return Date.parse(odooDt.replace(" ", "T") + "Z");
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

/** Muted until a date still ahead of `now`, or by the "no_notif" setting. */
export function isMuted(c: ChatChannel, now: Date): boolean {
  if (c.customNotifications === "no_notif") return true;
  if (!c.muteUntilDt) return false;
  const until = utcMs(c.muteUntilDt);
  return Number.isFinite(until) && until > now.getTime();
}

/** Messages the tile and chips show: the inbox counters plus every conversation not muted. */
export function totalUnread(channels: ChatChannel[], inboxCounters: number[], now: Date): number {
  let total = inboxCounters.reduce((sum, n) => sum + n, 0);
  for (const c of channels) if (!isMuted(c, now)) total += unreadOf(c);
  return total;
}

/**
 * Conversations with a counted unread first, each group by last_interest_dt
 * descending (none last). Returns a new array; ties keep their input order.
 */
export function sortConversations(channels: ChatChannel[]): ChatChannel[] {
  const key = (c: ChatChannel) => c.lastInterestDt ?? "";
  return [...channels].sort((a, b) => {
    const ua = unreadOf(a) > 0 ? 0 : 1;
    const ub = unreadOf(b) > 0 ? 0 : 1;
    if (ua !== ub) return ua - ub;
    return key(a) < key(b) ? 1 : key(a) > key(b) ? -1 : 0;
  });
}
