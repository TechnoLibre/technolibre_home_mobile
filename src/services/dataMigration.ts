import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";
import { DatabaseService } from "./databaseService";
import { Application } from "../models/application";
import { Note } from "../models/note";
import { MigrationResult, MigrationEntityCount } from "./migrationService";

/**
 * Migrates data from SecureStorage (old format) to SQLite (new format).
 *
 * Reads applications and notes from SecureStorage, inserts them into
 * the SQLite database, then removes the keys from SecureStorage to
 * prevent duplicate migration on next launch.
 *
 * Safe to call multiple times — skips migration if SecureStorage
 * keys no longer exist.
 */
export async function migrateFromSecureStorage(
  db: DatabaseService
): Promise<MigrationResult> {
  const [applications, notes] = await Promise.all([
    migrateApplications(db),
    migrateNotes(db),
  ]);

  return {
    counts: { applications, notes },
  };
}

async function migrateApplications(db: DatabaseService): Promise<MigrationEntityCount> {
  let apps: Application[];
  try {
    const result = await SecureStoragePlugin.get({ key: "applications" });
    apps = JSON.parse(result.value);
  } catch {
    return { migrated: 0, skipped: 0 };
  }

  let migrated = 0;
  let skipped = 0;

  const existing = await db.getAllApplications();
  for (const app of apps) {
    const alreadyExists = existing.some(
      (a) => a.url === app.url && a.username === app.username
    );
    if (alreadyExists) {
      skipped++;
    } else {
      await db.addApplication(app);
      migrated++;
    }
  }

  await SecureStoragePlugin.remove({ key: "applications" });
  return { migrated, skipped };
}

async function migrateNotes(db: DatabaseService): Promise<MigrationEntityCount> {
  let notes: Note[];
  try {
    const result = await SecureStoragePlugin.get({ key: "notes" });
    notes = JSON.parse(result.value);
  } catch {
    return { migrated: 0, skipped: 0 };
  }

  let migrated = 0;
  let skipped = 0;

  const existing = await db.getAllNotes();
  for (const note of notes) {
    const alreadyExists = existing.some((n) => n.id === note.id);
    if (alreadyExists) {
      skipped++;
    } else {
      await db.addNote(note);
      migrated++;
    }
  }

  await SecureStoragePlugin.remove({ key: "notes" });
  return { migrated, skipped };
}
