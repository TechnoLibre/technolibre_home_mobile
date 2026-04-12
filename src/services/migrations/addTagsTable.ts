import { v4 as uuidv4 } from "uuid";
import { DatabaseService } from "../databaseService";
import { MigrationResult } from "../migrationService";

// UUID v4 pattern — used to distinguish existing IDs from legacy name strings
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Creates the tags table and migrates existing string tags on notes to tag object IDs.
 *
 * Before this migration notes.tags contained plain strings (tag names).
 * After, they contain UUID v4 IDs referencing the new `tags` table.
 */
export async function addTagsTable(db: DatabaseService): Promise<MigrationResult> {
    await db.createTagsTable();

    const notes = await db.getAllNotes();

    // Collect unique legacy tag names (skip values that are already UUIDs)
    const nameToId = new Map<string, string>();
    for (const note of notes) {
        for (const value of note.tags) {
            if (!UUID_V4_RE.test(value) && !nameToId.has(value)) {
                nameToId.set(value, uuidv4());
            }
        }
    }

    // Insert one tag record per unique name
    for (const [name, id] of nameToId) {
        await db.addTag({ id, name, color: "#6b7280" });
    }

    // Rewrite each note's tags array to use IDs
    let migrated = 0;
    for (const note of notes) {
        const newTagIds = note.tags.map((value) =>
            UUID_V4_RE.test(value) ? value : (nameToId.get(value) ?? value)
        );
        const changed = newTagIds.some((id, i) => id !== note.tags[i]);
        if (changed) {
            await db.updateNote(note.id, { ...note, tags: newTagIds });
            migrated++;
        }
    }

    return {
        counts: {
            tags: { migrated: nameToId.size, skipped: 0 },
            notes: { migrated, skipped: notes.length - migrated },
        },
    };
}
