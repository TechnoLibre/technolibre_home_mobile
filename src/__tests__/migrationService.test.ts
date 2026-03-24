import { describe, it, expect, beforeEach } from "vitest";
import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";
import { DatabaseService } from "../services/databaseService";
import { getSchemaVersion, setSchemaVersion, runMigrations, versionToDisplay } from "../services/migrationService";

describe("MigrationService — versionToDisplay", () => {
  it("shows YYYY.MM.DD for sequence 01", () => {
    expect(versionToDisplay(2026031801)).toBe("2026.03.18");
  });

  it("appends -N for sequence > 1", () => {
    expect(versionToDisplay(2026031802)).toBe("2026.03.18-2");
    expect(versionToDisplay(2026031899)).toBe("2026.03.18-99");
  });

  it("handles legacy 8-digit YYYYMMDD format", () => {
    expect(versionToDisplay(20260318)).toBe("2026.03.18");
  });

  it("handles version 0 (initial state) gracefully", () => {
    expect(versionToDisplay(0)).toBe("0000.00.00");
  });
});

describe("MigrationService — legacy version upgrade", () => {
  beforeEach(() => {
    SecureStoragePlugin._store.clear();
  });

  it("auto-upgrades 8-digit stored version to 10-digit on read", async () => {
    await SecureStoragePlugin.set({ key: "schema_version", value: "20260318" });
    const version = await getSchemaVersion();
    expect(version).toBe(2026031801);
  });

  it("persists the upgraded version so subsequent reads return the new format", async () => {
    await SecureStoragePlugin.set({ key: "schema_version", value: "20260318" });
    await getSchemaVersion();
    const stored = (await SecureStoragePlugin.get({ key: "schema_version" })).value;
    expect(stored).toBe("2026031801");
  });

  it("does not re-run migration after upgrade if version matches", async () => {
    await SecureStoragePlugin.set({ key: "schema_version", value: "20260318" });
    const db = new DatabaseService();
    await db.initialize();
    const calls: number[] = [];
    await runMigrations(db, [{ version: 2026031801, run: async () => { calls.push(1); } }]);
    expect(calls).toEqual([]);
  });
});

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
