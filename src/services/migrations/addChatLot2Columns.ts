import { DatabaseService } from "../databaseService";
import { MigrationResult } from "../migrationService";

/**
 * Migration 2026102601: adds the conversation management columns to the
 * chat cache tables of migration 2026102501: pin, edit, naming,
 * access-group and membership data of the channels, the member creation
 * date, and the session's group and global mute. Nothing happens for the
 * columns a fresh install already has.
 */
export async function addChatLot2Columns(db: DatabaseService): Promise<MigrationResult> {
    await db.addChatLot2Columns();
    return { counts: {} };
}
