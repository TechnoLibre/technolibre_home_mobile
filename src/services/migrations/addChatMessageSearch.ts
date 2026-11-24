import { DatabaseService } from "../databaseService";
import { MigrationResult } from "../migrationService";

/**
 * Adds the searchable text, the pin date and the starred flag of the
 * cached messages (chat_messages.search_text, pinned_at, starred) and the
 * starred counter of an account (chat_sources.starred_counter), and
 * creates the search index where SQLite has FTS5; the rows already cached
 * get their search_text after start (DatabaseService.fillChatSearchText).
 * Guarded: a database that already has them, or has no chat tables, is
 * left as it is.
 */
export async function addChatMessageSearch(db: DatabaseService): Promise<MigrationResult> {
    await db.addChatMessageSearch();
    return { counts: {} };
}
