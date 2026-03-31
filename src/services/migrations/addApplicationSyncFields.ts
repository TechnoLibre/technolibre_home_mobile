import { DatabaseService } from "../databaseService";
import { MigrationResult } from "../migrationService";

/**
 * Adds sync configuration columns to the applications table:
 * database, auto_sync, poll_interval_minutes, ntfy_url, ntfy_topic.
 */
export async function addApplicationSyncFields(db: DatabaseService): Promise<MigrationResult> {
  await db.addSyncFieldsToApplications();
  return { counts: {} };
}
