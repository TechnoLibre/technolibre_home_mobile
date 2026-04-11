import { DatabaseService } from "../databaseService";
import { MigrationResult } from "../migrationService";

/**
 * Creates the server_workspaces table to persist discovered/deployed workspaces.
 */
export async function addServerWorkspacesTable(db: DatabaseService): Promise<MigrationResult> {
    await db.createServerWorkspacesTable();
    return { counts: {} };
}
