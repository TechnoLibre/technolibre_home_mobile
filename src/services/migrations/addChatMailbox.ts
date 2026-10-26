import { DatabaseService } from "../databaseService";
import { MigrationResult } from "../migrationService";

/**
 * Creates the mailbox cache (chat_mailbox: the messages of the inbox,
 * history and starred boxes) and adds the notification type of an account
 * (chat_sources.notification_type). Guarded: a database that already has
 * them, or has no chat_sources, is left as it is.
 */
export async function addChatMailbox(db: DatabaseService): Promise<MigrationResult> {
    await db.addChatMailbox();
    return { counts: {} };
}
