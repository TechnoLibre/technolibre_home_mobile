import { DatabaseService } from "../databaseService";
import { MigrationResult } from "../migrationService";

/**
 * Creates the servers table for SSH deployment configuration.
 */
export async function addServersTable(db: DatabaseService): Promise<MigrationResult> {
    await db.createServersTable();
    return { counts: {} };
}
