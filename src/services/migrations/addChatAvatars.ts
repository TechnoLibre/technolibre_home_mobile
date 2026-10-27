import { DatabaseService } from "../databaseService";
import { MigrationResult } from "../migrationService";

/**
 * Creates the table of the authors' cached avatars and adds the partner's
 * write date (its avatar's cache key) and the message's note flag.
 * Guarded: a table or a column already there is left as it is.
 */
export async function addChatAvatars(db: DatabaseService): Promise<MigrationResult> {
    await db.addChatAvatars();
    return { counts: {} };
}
