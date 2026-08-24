import { DatabaseService } from "../databaseService";
import { MigrationResult } from "../migrationService";

/**
 * Adds ntfy_token column to applications table for authenticated NTFY connections.
 */
export async function addNtfyTokenColumn(db: DatabaseService): Promise<MigrationResult> {
  await db.addNtfyTokenColumn();
  return { counts: {} };
}
