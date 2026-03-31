import { DatabaseService } from "../databaseService";
import { MigrationResult } from "../migrationService";

/**
 * Adds sync_config_id column to the notes table.
 * Links each note to a specific SyncConfig (multi-server support).
 */
export async function addSyncConfigId(db: DatabaseService): Promise<MigrationResult> {
  await db.addSyncConfigIdColumn();
  return { counts: {} };
}
