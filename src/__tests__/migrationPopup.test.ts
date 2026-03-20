import { describe, it, expect, beforeEach, vi } from "vitest";
import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";
import { DatabaseService } from "../services/databaseService";
import { runMigrations } from "../services/migrationService";
import { Dialog } from "@capacitor/dialog";

describe("Migration popup", () => {
  beforeEach(async () => {
    SecureStoragePlugin._store.clear();
    vi.clearAllMocks();
  });

  it("should show a popup when at least one migration runs", async () => {
    const db = new DatabaseService();
    await db.initialize();
    await runMigrations(db, [{ version: 20260318, run: async () => {} }]);
    expect(Dialog.alert).toHaveBeenCalledOnce();
  });

  it("should not show a popup when no migration runs", async () => {
    await SecureStoragePlugin.set({ key: "schema_version", value: "20260318" });
    const db = new DatabaseService();
    await db.initialize();
    await runMigrations(db, [{ version: 20260318, run: async () => {} }]);
    expect(Dialog.alert).not.toHaveBeenCalled();
  });
});
