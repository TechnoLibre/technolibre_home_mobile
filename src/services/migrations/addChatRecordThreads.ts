import { DatabaseService } from "../databaseService";
import { MigrationResult } from "../migrationService";

/**
 * Adds the record a reply's files and draft belong to (thread_model,
 * thread_id) to chat_attachments and chat_drafts. Guarded: a column a
 * table already has is left as it is.
 */
export async function addChatRecordThreads(db: DatabaseService): Promise<MigrationResult> {
    await db.addChatRecordThreads();
    return { counts: {} };
}
