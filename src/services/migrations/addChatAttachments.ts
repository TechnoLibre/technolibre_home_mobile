import { DatabaseService } from "../databaseService";
import { MigrationResult } from "../migrationService";

/**
 * Adds the chat attachments table and the file directory and module level
 * columns of chat_sources. Guarded: a database that already has them is
 * left as it is.
 */
export async function addChatAttachments(db: DatabaseService): Promise<MigrationResult> {
    await db.addChatAttachments();
    return { counts: {} };
}
