import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";
import { Dialog } from "@capacitor/dialog";
import { DatabaseService } from "./databaseService";

const SCHEMA_VERSION_KEY = "schema_version";
const MIGRATION_HISTORY_KEY = "migration_history";

/**
 * Version format: YYYYMMDDNN (10 digits).
 * YYYY = year, MM = month, DD = day, NN = sequence (01-99).
 * Example: 2026031801 = first migration of March 18, 2026.
 *          2026031802 = second migration of the same day.
 * Versions are compared numerically, so they always increase.
 */

/**
 * Converts a version number to a human-readable string.
 * Handles both legacy YYYYMMDD (8 digits) and current YYYYMMDDNN (10 digits).
 *
 * 2026031801 → "2026.03.18"
 * 2026031802 → "2026.03.18-2"
 * 20260318   → "2026.03.18"  (legacy, treated as sequence 01)
 * 0          → "0000.00.00"
 */
export function versionToDisplay(version: number): string {
  if (version === 0) return "0000.00.00";
  const s = String(version);
  if (s.length === 8) {
    // Legacy YYYYMMDD format
    return `${s.slice(0, 4)}.${s.slice(4, 6)}.${s.slice(6, 8)}`;
  }
  // Current YYYYMMDDNN format (10 digits)
  const padded = s.padStart(10, "0");
  const year = padded.slice(0, 4);
  const month = padded.slice(4, 6);
  const day = padded.slice(6, 8);
  const seq = parseInt(padded.slice(8, 10), 10);
  return seq > 1 ? `${year}.${month}.${day}-${seq}` : `${year}.${month}.${day}`;
}

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
    const stored = parseInt(result.value, 10);
    // Auto-upgrade legacy 8-digit YYYYMMDD format to 10-digit YYYYMMDDNN.
    // 20260318 → 2026031801 (appended sequence "01").
    // This prevents re-running migrations on existing installs after the format change.
    if (String(stored).length === 8) {
      const upgraded = stored * 100 + 1;
      await setSchemaVersion(upgraded);
      return upgraded;
    }
    return stored;
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
      lines.push(`v${versionToDisplay(entry.fromVersion)} → v${versionToDisplay(entry.version)}`);
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
