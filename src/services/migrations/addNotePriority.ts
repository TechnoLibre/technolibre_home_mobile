import { DatabaseService } from "../databaseService";
import { MigrationResult } from "../migrationService";

/**
 * Adds priority column to the notes table.
 * Stores 1–4 (Eisenhower quadrant) or NULL for no priority.
 */
export async function addNotePriority(db: DatabaseService): Promise<MigrationResult> {
  await db.addPriorityToNotes();
  return { counts: {} };
}
