import { DatabaseService } from "../databaseService";
import { MigrationResult } from "../migrationService";

/**
 * Migration 2026102602: adds what the offline creates need to a database
 * where migration 2026102601 ran before it carried them: the
 * refused-create flag of the channels and the table of temporary ids. It
 * runs the same guarded method as that migration, so the columns and
 * tables already present are left as they are.
 */
export async function addChatCreateFailed(db: DatabaseService): Promise<MigrationResult> {
    await db.addChatLot2Columns();
    return { counts: {} };
}
