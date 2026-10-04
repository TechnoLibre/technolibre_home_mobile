import { describe, it, expect, beforeEach, vi } from "vitest";
import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";
import { DatabaseService } from "../services/databaseService";
import { runMigrations } from "../services/migrationService";
import { Dialog } from "@capacitor/dialog";

describe("Migration summary", () => {
  beforeEach(async () => {
    SecureStoragePlugin._store.clear();
    vi.clearAllMocks();
  });

  it("hands the summary to the reporter when at least one migration runs", async () => {
    const db = new DatabaseService();
    await db.initialize();
    const vus: string[] = [];
    await runMigrations(
      db,
      [{ version: 2026031801, description: "Essai", run: async () => {} }],
      (resume) => vus.push(resume),
    );
    expect(vus).toHaveLength(1);
    expect(vus[0]).toContain("2026.03.18.01");
    expect(vus[0]).toContain("Essai");
  });

  it("says nothing when no migration runs", async () => {
    await SecureStoragePlugin.set({ key: "schema_version", value: "2026031801" });
    const db = new DatabaseService();
    await db.initialize();
    const vus: string[] = [];
    await runMigrations(
      db,
      [{ version: 2026031801, run: async () => {} }],
      (resume) => vus.push(resume),
    );
    expect(vus).toHaveLength(0);
  });

  it("never waits for a tap", async () => {
    // Une boite modale levee au demarrage se place derriere l'ecran de
    // lancement : personne ne peut la toucher, et le demarrage attend sans
    // fin un geste impossible.
    const db = new DatabaseService();
    await db.initialize();
    await runMigrations(db, [{ version: 2026031801, run: async () => {} }]);
    expect(Dialog.alert).not.toHaveBeenCalled();
  });

  it("runs without a reporter", async () => {
    const db = new DatabaseService();
    await db.initialize();
    await expect(
      runMigrations(db, [{ version: 2026031801, run: async () => {} }]),
    ).resolves.toBeUndefined();
  });
});
