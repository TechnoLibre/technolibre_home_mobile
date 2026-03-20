import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";
import { Dialog } from "@capacitor/dialog";
import { DatabaseService } from "./databaseService";

const SCHEMA_VERSION_KEY = "schema_version";

/**
 * Version format: YYYYMMDD (e.g. 20260320 for March 20, 2026).
 * Versions are compared numerically, so they must always increase over time.
 */
export type Migration = {
  version: number;
  run: (db: DatabaseService) => Promise<void>;
};

export async function getSchemaVersion(): Promise<number> {
  try {
    const result = await SecureStoragePlugin.get({ key: SCHEMA_VERSION_KEY });
    return parseInt(result.value, 10);
  } catch {
    return 0;
  }
}

export async function setSchemaVersion(version: number): Promise<void> {
  await SecureStoragePlugin.set({
    key: SCHEMA_VERSION_KEY,
    value: String(version),
  });
}

export async function runMigrations(
  db: DatabaseService,
  migrations: Migration[]
): Promise<void> {
  const currentVersion = await getSchemaVersion();

  const pending = migrations
    .filter((m) => m.version > currentVersion)
    .sort((a, b) => a.version - b.version);

  for (const migration of pending) {
    const previousVersion = await getSchemaVersion();
    await setSchemaVersion(migration.version);
    try {
      await migration.run(db);
    } catch (error) {
      await setSchemaVersion(previousVersion);
      console.error(`Migration v${migration.version} failed:`, error);
      throw error;
    }
  }

  if (pending.length > 0) {
    await Dialog.alert({
      title: "Mise à jour",
      message: "La migration des données est terminée.",
    });
  }
}
