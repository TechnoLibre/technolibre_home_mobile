import { DatabaseService } from "../databaseService";
import { MigrationResult } from "../migrationService";

/**
 * Creates chat_push, the closed-app notifications of each account (its
 * ntfy, Web Push subscription, Odoo registration and lock-screen
 * choice). It starts empty: an account has no ntfy until a link is
 * applied.
 */
export async function addChatPush(db: DatabaseService): Promise<MigrationResult> {
    await db.addChatPush();
    return { counts: {} };
}
