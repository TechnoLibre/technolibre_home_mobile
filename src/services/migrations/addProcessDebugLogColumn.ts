import { DatabaseService } from "../databaseService";
import { MigrationResult } from "../migrationService";

/**
 * Adds the `debug_log` column to the processes table.
 * The column stores a JSON array of timestamped diagnostic messages
 * accumulated during transcription, persisted once at completion.
 */
export async function addProcessDebugLogColumn(db: DatabaseService): Promise<MigrationResult> {
    await db.addDebugLogColumnToProcesses();
    return { counts: {} };
}
