import { DatabaseService } from "../databaseService";
import { MigrationResult } from "../migrationService";

/**
 * Adds the flag of a conversation the user left while texts were still
 * queued, so it stays listed with them until dismissed. Guarded: a
 * database that already has the column is left as it is.
 */
export async function addChatLeftUnsent(db: DatabaseService): Promise<MigrationResult> {
    await db.addChatLeftUnsent();
    return { counts: {} };
}
