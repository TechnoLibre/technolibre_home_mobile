import { describe, it, expect, beforeEach } from "vitest";
import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";
import { DatabaseService } from "../services/databaseService";
import { getSchemaVersion, setSchemaVersion, runMigrations } from "../services/migrationService";

describe("MigrationService — version storage", () => {
  beforeEach(() => {
    SecureStoragePlugin._store.clear();
  });

  it("should return 0 when no version has been stored", async () => {
    const version = await getSchemaVersion();
    expect(version).toBe(0);
  });

  it("should return the version after it has been set", async () => {
    await setSchemaVersion(2);
    const version = await getSchemaVersion();
    expect(version).toBe(2);
  });

  it("should overwrite the version when set again", async () => {
    await setSchemaVersion(1);
    await setSchemaVersion(3);
    const version = await getSchemaVersion();
    expect(version).toBe(3);
  });
});

describe("MigrationService — migration runner", () => {
  let db: DatabaseService;

  beforeEach(async () => {
    SecureStoragePlugin._store.clear();
    db = new DatabaseService();
    await db.initialize();
  });

  it("should run all migrations when starting from version 0", async () => {
    const calls: number[] = [];
    const migrations = [
      { version: 1, run: async () => { calls.push(1); } },
      { version: 2, run: async () => { calls.push(2); } },
    ];
    await runMigrations(db, migrations);
    expect(calls).toEqual([1, 2]);
    expect(await getSchemaVersion()).toBe(2);
  });

  it("should only run missing migrations when already at version 1", async () => {
    await setSchemaVersion(1);
    const calls: number[] = [];
    const migrations = [
      { version: 1, run: async () => { calls.push(1); } },
      { version: 2, run: async () => { calls.push(2); } },
    ];
    await runMigrations(db, migrations);
    expect(calls).toEqual([2]);
    expect(await getSchemaVersion()).toBe(2);
  });

  it("should do nothing when already up to date", async () => {
    await setSchemaVersion(2);
    const calls: number[] = [];
    const migrations = [
      { version: 1, run: async () => { calls.push(1); } },
      { version: 2, run: async () => { calls.push(2); } },
    ];
    await runMigrations(db, migrations);
    expect(calls).toEqual([]);
    expect(await getSchemaVersion()).toBe(2);
  });

  it("should run migrations in order even if defined out of order", async () => {
    const calls: number[] = [];
    const migrations = [
      { version: 3, run: async () => { calls.push(3); } },
      { version: 1, run: async () => { calls.push(1); } },
      { version: 2, run: async () => { calls.push(2); } },
    ];
    await runMigrations(db, migrations);
    expect(calls).toEqual([1, 2, 3]);
  });

  it("should update the version after each migration step", async () => {
    const versions: number[] = [];
    const migrations = [
      { version: 1, run: async () => { versions.push(await getSchemaVersion()); } },
      { version: 2, run: async () => { versions.push(await getSchemaVersion()); } },
    ];
    await runMigrations(db, migrations);
    expect(versions).toEqual([1, 2]);
  });
});
