import { DatabaseService } from "../databaseService";
import { MigrationResult } from "../migrationService";

/**
 * Adds the reply target, the edit in progress and the mention picks of a
 * conversation's draft (chat_drafts.reply_to, edit_of, edit_text,
 * mentions). Guarded: a database that already has them, or has no drafts
 * table yet, is left as it is.
 */
export async function addChatDraftModes(db: DatabaseService): Promise<MigrationResult> {
    await db.addChatDraftModes();
    return { counts: {} };
}
