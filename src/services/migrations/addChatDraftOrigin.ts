import { DatabaseService } from "../databaseService";
import { MigrationResult } from "../migrationService";

/**
 * Adds the origin column of chat_attachments (camera, gallery, file or
 * voice: where a draft file was taken). Guarded: a database that already
 * has it, or has no chat tables yet, is left as it is.
 */
export async function addChatDraftOrigin(db: DatabaseService): Promise<MigrationResult> {
    await db.addChatDraftOrigin();
    return { counts: {} };
}
