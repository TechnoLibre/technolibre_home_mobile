import { DatabaseService } from "../databaseService";
import { MigrationResult } from "../migrationService";

/**
 * Adds the `result` column to the processes table (transcribed text or
 * download URL), and the `deleteAllProcesses` helper.
 */
export async function addProcessResultColumn(db: DatabaseService): Promise<MigrationResult> {
    await db.addResultColumnToProcesses();
    return { counts: {} };
}
