import { DatabaseService } from "../databaseService";
import { MigrationResult } from "../migrationService";

/**
 * Adds Odoo sync columns to the notes table.
 *
 * - odoo_id       : Odoo project.task integer ID (null = never pushed)
 * - odoo_url      : Base URL of the Odoo instance used for sync
 * - sync_status   : 'local' | 'pending' | 'synced' | 'conflict' | 'error'
 * - last_synced_at: ISO 8601 datetime of the last successful sync
 */
export async function addSyncColumns(db: DatabaseService): Promise<MigrationResult> {
	await db.addSyncColumnsToNotes();
	return { counts: {} };
}
