/** localStorage key of the chat settings. */
export const CHAT_SETTINGS_KEY = "options.chat";

/** Size of the attachment cache the purge keeps under, in MB, unless the user sets another. */
export const DEFAULT_CACHE_LIMIT_MB = 2048;

/**
 * The order of the conversation list: the ones kept on top first, or the
 * ones with a counted unread first.
 */
export type ListOrder = "on_top_first" | "unread_first";

/**
 * How the closed-app notifications run: 1 and 2 realtime (a permanent
 * service), 3 a check every 15 minutes, 4 every hour, 5 off.
 */
export type NotifyLevel = 1 | 2 | 3 | 4 | 5;

/** The level of an install that never chose one: every 15 minutes, no permanent service. */
export const DEFAULT_NOTIFY_LEVEL: NotifyLevel = 3;

/**
 * What the chat tells the server about the user: sendRead marks
 * conversations read and fetched, sendTyping announces typing. Posting a
 * message marks its conversation read whatever sendRead holds.
 *
 * The attachment cache: cachePurge lets the purge remove cached files once
 * the chat's files pass cacheLimitMb (MB); askCompress asks before
 * sending a photo whether to compress it.
 *
 * notifyLevel: the level of the closed-app notifications (NotifyLevel).
 */
export interface ChatSettings {
  sendRead: boolean;
  sendTyping: boolean;
  cachePurge: boolean;
  cacheLimitMb: number;
  askCompress: boolean;
  listOrder: ListOrder;
  notifyLevel: NotifyLevel;
}

export const DEFAULT_CHAT_SETTINGS: ChatSettings = {
  sendRead: true,
  sendTyping: true,
  cachePurge: false,
  cacheLimitMb: DEFAULT_CACHE_LIMIT_MB,
  askCompress: false,
  listOrder: "on_top_first",
  notifyLevel: DEFAULT_NOTIFY_LEVEL,
};

/** A limit in MB: a finite number above 0, else the default. */
function limitOf(value: unknown): number {
  const mb = value === null || value === undefined ? NaN : Number(value);
  return Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_CACHE_LIMIT_MB;
}

/** A stored level: an integer from 1 to 5, else the default. */
function levelOf(value: unknown): NotifyLevel {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 5
    ? (value as NotifyLevel)
    : DEFAULT_NOTIFY_LEVEL;
}

/**
 * The settings stored, or the defaults; unreadable storage counts as the
 * defaults. A missing sendRead or sendTyping counts as on, a missing
 * cachePurge or askCompress as off, a level other than 1 to 5 as
 * DEFAULT_NOTIFY_LEVEL.
 */
export function chatSettings(): ChatSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(CHAT_SETTINGS_KEY) ?? "null");
    if (!raw || typeof raw !== "object") return DEFAULT_CHAT_SETTINGS;
    return {
      sendRead: raw.sendRead !== false,
      sendTyping: raw.sendTyping !== false,
      cachePurge: raw.cachePurge === true,
      cacheLimitMb: limitOf(raw.cacheLimitMb),
      askCompress: raw.askCompress === true,
      listOrder: raw.listOrder === "unread_first" ? "unread_first" : "on_top_first",
      notifyLevel: levelOf(raw.notifyLevel),
    };
  } catch {
    return DEFAULT_CHAT_SETTINGS;
  }
}

export function setChatSettings(settings: ChatSettings): void {
  try {
    localStorage.setItem(CHAT_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Not kept: the defaults apply next time
  }
}
