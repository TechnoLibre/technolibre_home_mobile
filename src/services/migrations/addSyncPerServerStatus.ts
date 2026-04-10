import { DatabaseService } from "../databaseService";
import { MigrationResult } from "../migrationService";

/**
 * Adds sync_per_server_status column to the notes table.
 * Stores a JSON map of { [syncConfigId]: "synced" | "error" } so the
 * note list can display per-server sync success/failure badges.
 */
export async function addSyncPerServerStatus(db: DatabaseService): Promise<MigrationResult> {
  await db.addSyncPerServerStatusColumn();
  return { counts: {} };
}
