import { DatabaseService } from "../databaseService";
import { MigrationResult } from "../migrationService";

/**
 * Creates the editable_repos table tracking which manifest repos have been
 * promoted to a persistent, git-backed editable copy in Documents.
 *
 * Used by RepoEditService.promoteToEditable / isEditable / unpromote.
 */
export async function addEditableReposTable(db: DatabaseService): Promise<MigrationResult> {
    await db.createEditableReposTable();
    return { counts: {} };
}
