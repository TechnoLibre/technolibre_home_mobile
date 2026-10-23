import { Capacitor } from "@capacitor/core";
import { LocalNotifications } from "@capacitor/local-notifications";
import type { DatabaseService } from "./databaseService";
import { CALENDAR_NOTE } from "./activityCalendarService";
import { NoteSyncPlugin } from "../plugins/noteSyncPlugin";
import { t } from "../i18n";

/** What waits for the Odoo sync: notes to send (pending or in error), notes in conflict. */
export interface PendingCounts {
  pending: number;
  conflicts: number;
}

/**
 * Counts what waits for the sync: the notes pending or in error, plus the
 * calendar's changes waiting in the outbox for a live server (not those of
 * a server removed since, nor blocked ones, which no sync sends), and apart
 * the notes in conflict (they wait for the user, not for the network).
 */
export async function pendingCounts(db: DatabaseService): Promise<PendingCounts> {
  const statuses = await db.countNotesBySyncStatus();
  const live = await db.getLiveSyncConfigIds().catch(() => new Set<string>());
  const calendar = (await db.getOutboxOpsForNote(CALENDAR_NOTE).catch(() => []))
    .filter((op) => live.has(op.configId) && op.status !== "blocked" && op.status !== "incomplete").length;
  return {
    pending: (statuses.pending ?? 0) + (statuses.error ?? 0) + calendar,
    conflicts: statuses.conflict ?? 0,
  };
}

/**
 * The notification's title and text for counts, in the app's language;
 * null when nothing waits.
 */
export function noticeTexts(counts: PendingCounts): { title: string; body: string } | null {
  if (counts.pending + counts.conflicts === 0) return null;
  const parts = [
    ...(counts.pending > 0 ? [t("sync.background_pending", { count: counts.pending })] : []),
    ...(counts.conflicts > 0 ? [t("sync.background_conflicts", { count: counts.conflicts })] : []),
  ];
  return { title: t("sync.background_title"), body: `${parts.join(" · ")} — ${t("sync.background_open")}` };
}

/**
 * Publishes the counts to the native NoteSyncJob (see NoteSyncPlugin):
 * with foreground false, app closed, it notifies them every 15 minutes
 * while the network is up; foreground true clears the notification. Does
 * nothing off a native platform; a failure only loses the notice.
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
    await plugin.publish({ ...counts, foreground, ...(texts ?? {}) });
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
