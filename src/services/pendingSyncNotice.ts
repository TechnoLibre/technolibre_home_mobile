import { Capacitor } from "@capacitor/core";
import { LocalNotifications } from "@capacitor/local-notifications";
import type { DatabaseService } from "./databaseService";
import { CALENDAR_NOTE } from "./activityCalendarService";
import { CHAT_NOTE, CHAT_POST, CHAT_RECORD_POST } from "./chat/chatOutbox";
import { NoteSyncPlugin } from "../plugins/noteSyncPlugin";
import { t } from "../i18n";

/**
 * What waits for Odoo: notes to send (pending or in error) and calendar
 * changes, notes in conflict, chat messages to send.
 */
export interface PendingCounts {
  pending: number;
  conflicts: number;
  messages: number;
}

/**
 * Counts what waits for the sync: the notes pending or in error, plus the
 * calendar's changes waiting in the outbox for a live server (not those of
 * a server removed since, nor blocked ones, which no sync sends), apart
 * the notes in conflict (they wait for the user, not for the network), and
 * apart the chat posts (replies on records included) waiting in the outbox
 * under the same rule.
 */
export async function pendingCounts(db: DatabaseService): Promise<PendingCounts> {
  const statuses = await db.countNotesBySyncStatus();
  const live = await db.getLiveSyncConfigIds().catch(() => new Set<string>());
  const waiting = async (noteId: string) => (await db.getOutboxOpsForNote(noteId).catch(() => []))
    .filter((op) => live.has(op.configId) && op.status !== "blocked" && op.status !== "incomplete");
  const calendar = (await waiting(CALENDAR_NOTE)).length;
  const messages = (await waiting(CHAT_NOTE)).filter((op) => op.kind === CHAT_POST || op.kind === CHAT_RECORD_POST).length;
  return {
    pending: (statuses.pending ?? 0) + (statuses.error ?? 0) + calendar,
    conflicts: statuses.conflict ?? 0,
    messages,
  };
}

/**
 * The notification's title and text for counts, in the app's language;
 * null when nothing waits.
 */
export function noticeTexts(counts: PendingCounts): { title: string; body: string } | null {
  const notes = counts.pending + counts.conflicts;
  if (notes + counts.messages === 0) return null;
  const parts = [
    ...(counts.pending > 0 ? [t("sync.background_pending", { count: counts.pending })] : []),
    ...(counts.conflicts > 0 ? [t("sync.background_conflicts", { count: counts.conflicts })] : []),
    ...(counts.messages > 0 ? [t("sync.background_messages", { count: counts.messages })] : []),
  ];
  const title = counts.messages === 0 ? "sync.background_title"
    : notes === 0 ? "sync.background_title_messages" : "sync.background_title_both";
  return { title: t(title), body: `${parts.join(" · ")} — ${t("sync.background_open")}` };
}

/**
 * Publishes the counts to the native NoteSyncJob (see NoteSyncPlugin):
 * with foreground false, app closed, it notifies them every 15 minutes
 * while the network is up; foreground true clears the notification. The
 * job knows pending and conflicts only: the chat messages count in its
 * pending, the texts tell them apart. Does nothing off a native platform;
 * a failure only loses the notice.
 */
export async function publishPending(
  db: DatabaseService,
  foreground: boolean,
  plugin: Pick<typeof NoteSyncPlugin, "publish"> = NoteSyncPlugin
): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try {
    const counts = await pendingCounts(db);
    const texts = noticeTexts(counts);
    // Android 13+ shows nothing without the right: asked once, in front, when something waits
    if (foreground && texts) await askNoticePermission();
    await plugin.publish({
      pending: counts.pending + counts.messages,
      conflicts: counts.conflicts,
      foreground,
      ...(texts ?? {}),
    });
  } catch (e) {
    console.warn("[pendingSyncNotice] publish failed:", e);
  }
}

/** localStorage key: the notification right was asked once for the notice. */
const PERMISSION_ASKED_KEY = "sync.notice.permissionAsked";

/** Asks the notification right once, unless it is granted or refused already. */
async function askNoticePermission(): Promise<void> {
  try {
    if (localStorage.getItem(PERMISSION_ASKED_KEY)) return;
    const { display } = await LocalNotifications.checkPermissions();
    if (display === "prompt" || display === "prompt-with-rationale") await LocalNotifications.requestPermissions();
    localStorage.setItem(PERMISSION_ASKED_KEY, "1");
  } catch {
    // Not asked: the notice stays silent until the right is given
  }
}
