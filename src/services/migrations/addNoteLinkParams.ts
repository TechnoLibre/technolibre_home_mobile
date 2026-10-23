import { DatabaseService } from "../databaseService";
import { MigrationResult } from "../migrationService";

/**
 * Adds note_links.params_json: what an activity link stands for beyond its
 * mail.activity id (the record it is on, its type, deadline and user).
 * Existing links get none, as "create" links need none.
 */
export async function addNoteLinkParams(db: DatabaseService): Promise<MigrationResult> {
    await db.addParamsToNoteLinks();
    return { counts: {} };
}
