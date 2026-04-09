import { DatabaseService } from "../databaseService";
import { MigrationResult } from "../migrationService";

/**
 * Adds the odoo_version column to the applications table.
 * Populated by the Autocomplete button; empty string when not yet detected.
 */
export async function addOdooVersionToApplications(db: DatabaseService): Promise<MigrationResult> {
  await db.addOdooVersionToApplications();
  return { counts: {} };
}
