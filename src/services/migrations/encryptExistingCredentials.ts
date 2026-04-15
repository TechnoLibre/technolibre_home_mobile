import { DatabaseService } from "../databaseService";
import { MigrationResult } from "../migrationService";
import { encryptCredential, isEncrypted } from "../../utils/cryptoUtils";

/**
 * Encrypts existing plaintext credentials in applications and servers tables
 * using AES-256-GCM secondary encryption.
 */
export async function encryptExistingCredentials(db: DatabaseService): Promise<MigrationResult> {
  let encrypted = 0;

  // Encrypt application passwords and NTFY tokens
  const apps = await db.rawQuery("SELECT url, username, password, ntfy_token FROM applications");
  for (const row of apps) {
    const updates: string[] = [];
    const values: string[] = [];

    if (row.password && !isEncrypted(row.password)) {
      updates.push("password = ?");
      values.push(await encryptCredential(row.password));
      encrypted++;
    }
    if (row.ntfy_token && !isEncrypted(row.ntfy_token)) {
      updates.push("ntfy_token = ?");
      values.push(await encryptCredential(row.ntfy_token));
      encrypted++;
    }

    if (updates.length > 0) {
      values.push(row.url, row.username);
      await db.rawRun(
        `UPDATE applications SET ${updates.join(", ")} WHERE url = ? AND username = ?`,
        values
      );
    }
  }

  // Encrypt server passwords, private keys, and passphrases
  const servers = await db.rawQuery("SELECT host, username, password, private_key, passphrase FROM servers");
  for (const row of servers) {
    const updates: string[] = [];
    const values: string[] = [];

    if (row.password && !isEncrypted(row.password)) {
      updates.push("password = ?");
      values.push(await encryptCredential(row.password));
      encrypted++;
    }
    if (row.private_key && !isEncrypted(row.private_key)) {
      updates.push("private_key = ?");
      values.push(await encryptCredential(row.private_key));
      encrypted++;
    }
    if (row.passphrase && !isEncrypted(row.passphrase)) {
      updates.push("passphrase = ?");
      values.push(await encryptCredential(row.passphrase));
      encrypted++;
    }

    if (updates.length > 0) {
      values.push(row.host, row.username);
      await db.rawRun(
        `UPDATE servers SET ${updates.join(", ")} WHERE host = ? AND username = ?`,
        values
      );
    }
  }

  return { counts: { encrypted } };
}
