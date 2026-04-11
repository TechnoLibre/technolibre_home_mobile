import { DatabaseService } from "../databaseService";
import { MigrationResult } from "../migrationService";

/**
 * Adds selected_sync_config_ids column to the notes table.
 * Stores the user's last sync server selection as a JSON array,
 * so the picker remembers which servers were chosen across restarts.
 */
export async function addSelectedSyncConfigIds(db: DatabaseService): Promise<MigrationResult> {
  await db.addSelectedSyncConfigIdsColumn();
  return { counts: {} };
}
