import { DatabaseService } from "../databaseService";
import { MigrationResult } from "../migrationService";

/**
 * Adds the table of the conversations' draft texts (their draft files are
 * chat_attachments rows in the "draft" state). Guarded: a database that
 * already has it is left as it is.
 */
export async function addChatDrafts(db: DatabaseService): Promise<MigrationResult> {
    await db.addChatDrafts();
    return { counts: {} };
}
