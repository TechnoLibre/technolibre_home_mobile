import { getCurrentLocale } from "../../i18n";

/** The mute durations offered, in minutes; -1 lasts until the user turns it back on. */
export const MUTE_CHOICES: { minutes: number; label: string }[] = [
  { minutes: 15, label: "chat.mute_15m" },
  { minutes: 60, label: "chat.mute_1h" },
  { minutes: 180, label: "chat.mute_3h" },
  { minutes: 480, label: "chat.mute_8h" },
  { minutes: 1440, label: "chat.mute_24h" },
  { minutes: -1, label: "chat.mute_forever" },
];

/** Epoch ms of an Odoo "YYYY-MM-DD HH:MM:SS" UTC date; NaN when unreadable. */
function utcMs(dt: string): number {
  return Date.parse(dt.replace(" ", "T") + "Z");
}

/**
 * How a mute end reads: "until <date>", or "until turned back on" for a date
 * two or more years away, as Odoo's mute display; null when not ahead of
 * `now`. `dated` is the sentence with a `{date}` placeholder.
 */
export function muteText(dt: string | null, now: Date, dated: string, forever: string): string | null {
  if (!dt) return null;
  const ms = utcMs(dt);
  if (!Number.isFinite(ms) || ms <= now.getTime()) return null;
  if (new Date(ms).getUTCFullYear() >= now.getUTCFullYear() + 2) return forever;
  return dated.replace("{date}", new Date(ms).toLocaleString(getCurrentLocale(), { dateStyle: "medium", timeStyle: "short" }));
}
