import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";
import { DatabaseService } from "./databaseService";
import { Application } from "../models/application";
import { Note } from "../models/note";

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
): Promise<void> {
  await migrateApplications(db);
  await migrateNotes(db);
}

async function migrateApplications(db: DatabaseService): Promise<void> {
  let apps: Application[];
  try {
    const result = await SecureStoragePlugin.get({ key: "applications" });
    apps = JSON.parse(result.value);
  } catch {
    return;
  }

  for (const app of apps) {
    const existing = await db.getAllApplications();
    const alreadyExists = existing.some(
      (a) => a.url === app.url && a.username === app.username
    );
    if (!alreadyExists) {
      await db.addApplication(app);
    }
  }

  await SecureStoragePlugin.remove({ key: "applications" });
}

async function migrateNotes(db: DatabaseService): Promise<void> {
  let notes: Note[];
  try {
    const result = await SecureStoragePlugin.get({ key: "notes" });
    notes = JSON.parse(result.value);
  } catch {
    return;
  }

  for (const note of notes) {
    const existing = await db.getAllNotes();
    const alreadyExists = existing.some((n) => n.id === note.id);
    if (!alreadyExists) {
      await db.addNote(note);
    }
  }

  await SecureStoragePlugin.remove({ key: "notes" });
}
