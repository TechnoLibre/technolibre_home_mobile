import { DatabaseService } from "../databaseService";
import { MigrationResult } from "../migrationService";

/**
 * Adds what the offline creates need to a database whose lot 2 columns
 * migration already ran without it: the refused-create flag of the
 * channels and the table of temporary ids. It runs the same guarded method
 * as that migration, so the columns and tables already present are left as
 * they are.
 */
export async function addChatCreateFailed(db: DatabaseService): Promise<MigrationResult> {
    await db.addChatLot2Columns();
    return { counts: {} };
}
