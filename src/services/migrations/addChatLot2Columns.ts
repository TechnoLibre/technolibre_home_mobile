import { DatabaseService } from "../databaseService";
import { MigrationResult } from "../migrationService";

/**
 * Adds the lot 2 columns to the chat cache tables of a lot 1 database:
 * pin, edit, naming, access-group and membership data of the channels, the
 * member creation date, and the session's group and global mute. Nothing
 * happens for the columns a fresh install already has.
 */
export async function addChatLot2Columns(db: DatabaseService): Promise<MigrationResult> {
    await db.addChatLot2Columns();
    return { counts: {} };
}
