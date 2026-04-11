import { DatabaseService } from "../databaseService";
import { MigrationResult } from "../migrationService";

/**
 * Creates the processes table that logs transcription and download history.
 */
export async function addProcessesTable(db: DatabaseService): Promise<MigrationResult> {
    await db.createProcessesTable();
    return { counts: {} };
}
