import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";
import { Dialog } from "@capacitor/dialog";
import { DatabaseService } from "./databaseService";

const SCHEMA_VERSION_KEY = "schema_version";
const MIGRATION_HISTORY_KEY = "migration_history";

/**
 * Version format: YYYYMMDD (e.g. 20260320 for March 20, 2026).
 * Versions are compared numerically, so they must always increase over time.
 */

export interface MigrationEntityCount {
  migrated: number;
  skipped: number;
}

export interface MigrationResult {
  counts: Record<string, MigrationEntityCount>;
}

export interface MigrationHistoryEntry {
  version: number;
  description: string;
  executedAt: string;   // ISO 8601
  durationMs: number;
  fromVersion: number;
  counts: Record<string, MigrationEntityCount>;
}

export type Migration = {
  version: number;
  description?: string;
  run: (db: DatabaseService) => Promise<MigrationResult | void>;
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

export async function getMigrationHistory(): Promise<MigrationHistoryEntry[]> {
  try {
    const result = await SecureStoragePlugin.get({ key: MIGRATION_HISTORY_KEY });
    return JSON.parse(result.value);
  } catch {
    return [];
  }
}

async function appendMigrationHistory(entry: MigrationHistoryEntry): Promise<void> {
  const history = await getMigrationHistory();
  history.push(entry);
  await SecureStoragePlugin.set({
    key: MIGRATION_HISTORY_KEY,
    value: JSON.stringify(history),
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

  const executedEntries: MigrationHistoryEntry[] = [];

  for (const migration of pending) {
    const fromVersion = await getSchemaVersion();
    const startMs = Date.now();
    await setSchemaVersion(migration.version);

    let result: MigrationResult | void;
    try {
      result = await migration.run(db);
    } catch (error) {
      await setSchemaVersion(fromVersion);
      console.error(`Migration v${migration.version} failed:`, error);
      throw error;
    }

    const durationMs = Date.now() - startMs;
    const counts = (result as MigrationResult)?.counts ?? {};

    const entry: MigrationHistoryEntry = {
      version: migration.version,
      description: migration.description ?? "",
      executedAt: new Date().toISOString(),
      durationMs,
      fromVersion,
      counts,
    };

    await appendMigrationHistory(entry);
    executedEntries.push(entry);
  }

  if (executedEntries.length > 0) {
    const lines: string[] = [];

    for (const entry of executedEntries) {
      if (lines.length > 0) lines.push("");
      lines.push(`v${entry.fromVersion} → v${entry.version}`);
      if (entry.description) lines.push(entry.description);
      lines.push(`Durée : ${entry.durationMs} ms`);

      const countEntries = Object.entries(entry.counts);
      if (countEntries.length > 0) {
        lines.push("");
        lines.push("Données migrées :");
        for (const [entity, c] of countEntries) {
          lines.push(`  ${entity} : ${c.migrated} migrée(s), ${c.skipped} ignorée(s)`);
        }
      }
    }

    await Dialog.alert({
      title: "Mise à jour",
      message: lines.join("\n"),
    });
  }
}
