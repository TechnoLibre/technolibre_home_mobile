import { DatabaseService } from "../databaseService";
import { MigrationResult } from "../migrationService";

/**
 * Creates the chat cache tables (channels, messages, members, partners and
 * the per-server sync state). They start empty and fill from the first
 * Discuss load.
 */
export async function addChatTables(db: DatabaseService): Promise<MigrationResult> {
    await db.createChatTables();
    return { counts: {} };
}
