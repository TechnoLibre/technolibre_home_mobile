import { DatabaseService } from "../databaseService";
import { MigrationResult } from "../migrationService";

/**
 * Creates the sync_outbox table (operations waiting to reach a server)
 * and the server_capabilities table (what each server allows per model),
 * and adds note_links.client_uuid for tables created before it existed.
 * Nothing is copied: a note still waiting for its first push keeps its
 * per-server "pending" status, and its creation is queued at that push.
 */
export async function addSyncOutboxTable(db: DatabaseService): Promise<MigrationResult> {
    await db.createSyncOutboxTable();
    await db.createServerCapabilitiesTable();
    await db.addClientUuidToNoteLinks();
    return { counts: {} };
}
