import type { ChatPushRow } from "../../models/chat";
import type { ChatPushNative, PushHealth } from "../../plugins/chatPushPlugin";
import { t } from "../../i18n";

/*
 * Opening the app from a chat notification, and reading the native health
 * snapshot as « is the phone listening ». allowedOpenUrl mirrors
 * ChatPushOpen.allowedPath (Java) rule for rule: the two stay equal, and
 * the cases of its JUnit test are replayed in chatPushOpen.test.ts.
 */

/** A path segment as encodeURIComponent writes it: unreserved characters and %XX escapes. */
const SEGMENT = "((?:[A-Za-z0-9._~!'()*-]|%[0-9A-Fa-f]{2})+)";
const MODEL = "[a-z][a-z0-9_]*(?:\\.[a-z0-9_]+)*";
const LIST = /^\/chat$/;
const INBOX = new RegExp(`^/chat/inbox\\?s=${SEGMENT}&thread=${MODEL},[0-9]+$`);
const CHANNEL = new RegExp(`^/chat/${SEGMENT}/([0-9]+)$`);
/**
 * The app's configId once decoded, "<url>|<username>|<database>": an
 * http(s) URL, a login that may be empty or hold spaces, a database; no
 * part holds a "|" or a control character, and only the login a space.
 * Whitespace is the ASCII set Java's \s names, not JS's wider one.
 */
const WS = " \\t\\n\\x0B\\f\\r";
const CTRL = "\\x00-\\x1f\\x7f";
const CONFIG_ID = new RegExp(`^https?://[^|${WS}${CTRL}]+\\|[^|${CTRL}]*\\|[^|${WS}${CTRL}]+$`);

/** Percent-decodes a segment as UTF-8; null on a malformed escape or bytes that are not UTF-8. */
function strictDecode(segment: string): string | null {
  const bytes: number[] = [];
  for (let i = 0; i < segment.length; i++) {
    const c = segment.charCodeAt(i);
    if (c !== 0x25) {
      if (c > 0x7e) return null;
      bytes.push(c);
      continue;
    }
    if (i + 2 >= segment.length) return null;
    const hi = parseInt(segment[i + 1], 16);
    const lo = parseInt(segment[i + 2], 16);
    if (Number.isNaN(hi) || Number.isNaN(lo)) return null;
    bytes.push(hi * 16 + lo);
    i += 2;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    return null;
  }
}

/** The configId a segment names, or null unless it decodes to the CONFIG_ID shape. */
function configIdOf(segment: string): string | null {
  const id = strictDecode(segment);
  return id !== null && CONFIG_ID.test(id) ? id : null;
}

/**
 * Whether url is one of the app paths a notification opens: "/chat",
 * "/chat/inbox?s=<configId>&thread=<model>,<resId>" or
 * "/chat/<configId>/<channelId>", the configId written by
 * encodeURIComponent. Anything else (another scheme, "//host", another
 * route, extra segments or parameters, a malformed escape) is refused.
 */
export function allowedOpenUrl(url: string | null | undefined): boolean {
  if (typeof url !== "string") return false;
  if (LIST.test(url)) return true;
  const m = INBOX.exec(url) ?? CHANNEL.exec(url);
  return m !== null && configIdOf(m[1]) !== null;
}

/** The conversation an allowed "/chat/<configId>/<channelId>" url opens, or null for any other url. */
export function threadOfUrl(url: string): { configId: string; channelId: number } | null {
  const m = CHANNEL.exec(url);
  if (!m) return null;
  const configId = configIdOf(m[1]);
  return configId === null ? null : { configId, channelId: Number(m[2]) };
}

/**
 * Opens an app path a notification tap carried: an allowed url navigates
 * (a conversation's notifications are cleared at once), any other is
 * ignored. Answers whether it navigated.
 */
export function openFromPush(url: string | null | undefined, native: ChatPushNative | null, navigate: (url: string) => void): boolean {
  if (!allowedOpenUrl(url)) return false;
  const thread = threadOfUrl(url as string);
  if (thread && native) {
    native.clear(thread).catch((e: unknown) => console.warn("[chat push] clear failed:", e instanceof Error ? e.message : String(e)));
  }
  navigate(url as string);
  return true;
}

/**
 * Follows the taps of the notifications: the one that launched the app
 * (read once) and those that arrive while it runs. Call once the routes
 * are mounted. Answers a function that stops listening.
 */
export async function wirePushOpen(native: ChatPushNative | null, navigate: (url: string) => void): Promise<() => void> {
  if (!native) return () => {};
  const handle = await native.addListener("pushOpen", (ev) => {
    openFromPush(ev.url, native, navigate);
  });
  try {
    const { url } = await native.takeLaunchUrl();
    openFromPush(url, native, navigate);
  } catch (e) {
    console.warn("[chat push] launch url unreadable:", e instanceof Error ? e.message : String(e));
  }
  return () => void handle.remove();
}

/** One reason the phone does not listen: the account it concerns (null: the phone) and a reason key. */
export interface ListeningAlarm {
  configId: string | null;
  reason: string;
}

export interface Listening {
  /** The level is 5: nothing is meant to ring. */
  off: boolean;
  alarms: ListeningAlarm[];
  /** Reason keys that weaken listening without stopping it. */
  warnings: string[];
}

/**
 * What the native health says about listening. Level 5 is off. Otherwise
 * an alarm for each of: notifications not allowed; levels 1 and 2 with the
 * permanent service dead; an account in error, with an expired session or
 * with none; an ntfy in error. Levels 1 and 2 without the battery
 * exemption only warn. The reason of an alarm is the native key
 * (unauthorized, unreachable, http_refused...) or one of
 * notifications_denied, service_dead, no_session.
 */
export function listeningOf(h: PushHealth, rows: ChatPushRow[]): Listening {
  if (h.level === 5) return { off: true, alarms: [], warnings: [] };
  const alarms: ListeningAlarm[] = [];
  const add = (configId: string | null, reason: string): void => {
    if (!alarms.some((a) => a.configId === configId && a.reason === reason)) alarms.push({ configId, reason });
  };
  if (!h.notificationsAllowed) add(null, "notifications_denied");
  if (h.level <= 2 && !h.serviceAlive) add(null, "service_dead");
  for (const a of h.accounts) {
    if (a.state === "error" || a.state === "session_expired" || a.state === "no_session") {
      add(a.configId, a.reason ?? (a.state === "error" ? "unreachable" : a.state));
    }
  }
  for (const n of h.ntfys) {
    if (n.state !== "error") continue;
    const owner = rows.find((r) => r.ntfyUrl === n.url)?.configId ?? n.configIds[0] ?? null;
    add(owner, n.reason ?? "unreachable");
  }
  const warnings = h.level <= 2 && !h.batteryExempt ? ["battery_not_exempt"] : [];
  return { off: false, alarms, warnings };
}

/** The reason keys native code answers, each with a chat.push_reason_<key> text. */
const NATIVE_REASONS = new Set([
  "unauthorized", "forbidden", "unreachable", "odoo_unreachable", "rate_limited",
  "http_refused", "cleartext_blocked", "session_expired", "protocol",
]);
/** The reason keys of the phone's own, each with a chat.push_why_<key> text. */
const PHONE_REASONS = new Set(["notifications_denied", "service_dead", "no_session", "not_found", "battery_not_exempt"]);

/** A reason key in words; a key nobody knows reads as an unexpected answer. */
export function reasonText(reason: string | null): string {
  if (reason === null) return t("chat.push_why_unknown");
  if (NATIVE_REASONS.has(reason)) return t("chat.push_reason_" + reason);
  if (PHONE_REASONS.has(reason)) return t("chat.push_why_" + reason);
  return t("chat.push_why_unknown");
}
