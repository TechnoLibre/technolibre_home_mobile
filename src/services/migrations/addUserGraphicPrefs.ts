import { DatabaseService } from "../databaseService";
import { MigrationResult } from "../migrationService";

export async function addUserGraphicPrefs(db: DatabaseService): Promise<MigrationResult> {
  await db.createUserGraphicPrefsTable();
  return { counts: {} };
}
