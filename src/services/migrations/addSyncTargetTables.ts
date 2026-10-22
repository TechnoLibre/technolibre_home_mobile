import { DatabaseService } from "../databaseService";
import { MigrationResult } from "../migrationService";

/**
 * Creates remote_records_cache (records of a server kept for offline
 * choices, such as the projects of a new task) and sync_target_prefs (the
 * last choice per server and kind of target). Both start empty: the cache
 * fills on the first online choice.
 */
export async function addSyncTargetTables(db: DatabaseService): Promise<MigrationResult> {
    await db.createRemoteRecordsCacheTable();
    await db.createSyncTargetPrefsTable();
    return { counts: {} };
}
