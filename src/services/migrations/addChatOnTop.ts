import { DatabaseService } from "../databaseService";
import { MigrationResult } from "../migrationService";

/**
 * Creates the table of the conversations kept on top of the list
 * (chat_on_top), local to the phone. Guarded: a database that already has
 * it is left as it is.
 */
export async function addChatOnTop(db: DatabaseService): Promise<MigrationResult> {
    await db.addChatOnTop();
    return { counts: {} };
}
