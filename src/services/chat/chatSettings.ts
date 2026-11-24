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

/** A battery percentage under which native code climbs the level; 0 climbs never. */
export type ClimbThreshold = 0 | 10 | 15 | 20 | 30 | 40 | 50;

/** The thresholds a setting may hold, in order. */
export const CLIMB_THRESHOLDS: readonly ClimbThreshold[] = [0, 10, 15, 20, 30, 40, 50];

/**
 * Points above a threshold at which native code releases a climb under it
 * (BatteryClimber.MARGIN): climbed under 15 %, the level comes back at 20 %
 * or once plugged in.
 */
export const CLIMB_RELEASE_MARGIN = 5;

/**
 * What a chat push does while a browser of the user is active on the
 * server: ring at once, wait for a read before ringing, or not reach the
 * phone at all.
 */
export type BrowserMode = "ring" | "wait" | "quiet";

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
 * climbAuto, climbOneBelow, climbTwoBelow: native code climbs one level
 * under climbOneBelow % of battery and two under climbTwoBelow %, while
 * climbAuto holds (a threshold 0 is none). browserMode: the BrowserMode
 * the app's device is marked with on every server.
 */
export interface ChatSettings {
  sendRead: boolean;
  sendTyping: boolean;
  cachePurge: boolean;
  cacheLimitMb: number;
  askCompress: boolean;
  listOrder: ListOrder;
  notifyLevel: NotifyLevel;
  climbAuto: boolean;
  climbOneBelow: ClimbThreshold;
  climbTwoBelow: ClimbThreshold;
  browserMode: BrowserMode;
}

export const DEFAULT_CHAT_SETTINGS: ChatSettings = {
  sendRead: true,
  sendTyping: true,
  cachePurge: false,
  cacheLimitMb: DEFAULT_CACHE_LIMIT_MB,
  askCompress: false,
  listOrder: "on_top_first",
  notifyLevel: DEFAULT_NOTIFY_LEVEL,
  climbAuto: true,
  climbOneBelow: 30,
  climbTwoBelow: 15,
  browserMode: "wait",
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

/** A stored threshold: one of CLIMB_THRESHOLDS, else `fallback`. */
function thresholdOf(value: unknown, fallback: ClimbThreshold): ClimbThreshold {
  return CLIMB_THRESHOLDS.includes(value as ClimbThreshold) ? (value as ClimbThreshold) : fallback;
}

const BROWSER_MODES: readonly BrowserMode[] = ["ring", "wait", "quiet"];

/**
 * The settings stored, or the defaults; unreadable storage counts as the
 * defaults. A missing sendRead or sendTyping counts as on, a missing
 * cachePurge or askCompress as off, a level other than 1 to 5 as
 * DEFAULT_NOTIFY_LEVEL. climbAuto is off only when stored false; a
 * threshold or browser mode outside its type reads as its default.
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
      climbAuto: raw.climbAuto !== false,
      climbOneBelow: thresholdOf(raw.climbOneBelow, DEFAULT_CHAT_SETTINGS.climbOneBelow),
      climbTwoBelow: thresholdOf(raw.climbTwoBelow, DEFAULT_CHAT_SETTINGS.climbTwoBelow),
      browserMode: BROWSER_MODES.includes(raw.browserMode) ? raw.browserMode : DEFAULT_CHAT_SETTINGS.browserMode,
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
