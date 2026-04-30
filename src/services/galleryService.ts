import { DatabaseService } from "./databaseService";
import type { Note, NoteEntryPhotoParams } from "../models/note";

/**
 * Aggregated metadata for a single image referenced anywhere in the
 * notes database. The path is whatever the entry stored — usually a
 * `file://` URI on Android or a base64 data URL on web.
 */
export interface GalleryImage {
    noteId:    string;
    noteTitle: string;
    entryId:   string;
    path:      string;
    /** ISO timestamp from the parent note (used for sort). */
    noteDate:  string;
}

/**
 * Read-only view across every photo entry in every note. The
 * gallery page renders this list as a mosaic / fullscreen carousel
 * and the streamdeck paints its keys against it. No mutation API —
 * editing an image still goes through the usual note editor.
 */
export class GalleryService {
    constructor(private readonly db: DatabaseService) {}

    /** Returns every photo entry across the notes database, newest
     *  note first. Empty paths are filtered out — those are entries
     *  whose user has not yet recorded the image. */
    async getAllImages(): Promise<GalleryImage[]> {
        const notes: Note[] = await this.db.getAllNotes();
        const out: GalleryImage[] = [];
        for (const n of notes) {
            for (const e of n.entries ?? []) {
                if (e.type !== "photo") continue;
                const params = e.params as NoteEntryPhotoParams;
                if (!params?.path) continue;
                out.push({
                    noteId:    n.id,
                    noteTitle: n.title || "",
                    entryId:   e.id,
                    path:      params.path,
                    noteDate:  n.date ?? "",
                });
            }
        }
        out.sort((a, b) => (b.noteDate || "").localeCompare(a.noteDate || ""));
        return out;
    }
}
