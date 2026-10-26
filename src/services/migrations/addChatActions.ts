import { DatabaseService } from "../databaseService";
import { MigrationResult } from "../migrationService";

/**
 * Adds the reactions table and the reply and mention columns of
 * chat_messages (parent_id, parent_client_uuid, recipient_ids). Guarded: a
 * database that already has them is left as it is.
 */
export async function addChatActions(db: DatabaseService): Promise<MigrationResult> {
    await db.addChatActions();
    return { counts: {} };
}
