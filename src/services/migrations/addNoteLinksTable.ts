import { v4 as uuidv4 } from "uuid";
import { DatabaseService } from "../databaseService";
import { MigrationResult } from "../migrationService";

/**
 * Creates the note_links table — one row per (note, sync target, remote
 * record) — and the sync_pull_cursors table, then moves the sync state of
 * older versions onto them:
 * - stored "url|username" ids gain the application's database;
 * - each note's single odoo_id/odoo_url binding becomes a link where its
 *   database is unambiguous, its other targets are queued;
 * - a note left "pending" by the global flag alone becomes pending for each
 *   server it targets;
 * - every note's global status is re-derived.
 *
 * A single odoo_id per note cannot tell servers apart: pushing to a second
 * server would write() the first server's id there. Links are scoped to a
 * "url|username|database" target instead. The legacy columns are kept but
 * no longer written.
 */
export async function addNoteLinksTable(db: DatabaseService): Promise<MigrationResult> {
    await db.createNoteLinksTable();
    await db.createSyncPullCursorsTable();
    const ids = await db.addDatabaseToLegacySyncConfigIds();
    // Read before the backfill queues anything, and converted after it, so
    // the backfill still sees the legacy "synced" entries and the
    // conversion sees the links it wrote.
    const legacyPending = await db.getLegacyPendingNoteIds();
    const links = await db.backfillNoteLinksFromLegacyColumns(() => uuidv4());
    const pending = await db.convertLegacyPendingToPerServer(legacyPending);
    await db.refreshAllNoteSyncStatuses();
    return {
        counts: {
            sync_config_ids: { migrated: ids, skipped: 0 },
            note_links: { migrated: links, skipped: 0 },
            pending_notes: { migrated: pending, skipped: 0 },
        },
    };
}
