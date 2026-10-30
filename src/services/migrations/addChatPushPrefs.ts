import { DatabaseService } from "../databaseService";
import { MigrationResult } from "../migrationService";

/**
 * Adds each account's push preferences to chat_push (phone filter, inbox
 * switches, quiet hours) and Odoo's general channel setting to
 * chat_sources. Existing rows take the defaults: everything shown, no
 * quiet hours, the channel setting unknown until the next load.
 */
export async function addChatPushPrefs(db: DatabaseService): Promise<MigrationResult> {
    await db.addChatPushPrefs();
    return { counts: {} };
}
