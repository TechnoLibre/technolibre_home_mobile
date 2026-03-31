import { DatabaseService } from "../databaseService";
import { MigrationResult } from "../migrationService";

/**
 * Adds created_at column to the reminders table.
 */
export async function addReminderCreatedAt(db: DatabaseService): Promise<MigrationResult> {
  await db.addCreatedAtToReminders();
  return { counts: {} };
}
