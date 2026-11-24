import { DatabaseService } from "../databaseService";
import { MigrationResult } from "../migrationService";

/**
 * Creates activities_cache: the activities of each server the activity
 * calendar shows, read when online and kept for offline. Starts empty.
 */
export async function addActivitiesCacheTable(db: DatabaseService): Promise<MigrationResult> {
    await db.createActivitiesCacheTable();
    return { counts: {} };
}
