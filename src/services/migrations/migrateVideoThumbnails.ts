import { Capacitor } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";

import { NoteEntryVideoParams } from "../../models/note";
import { DatabaseService } from "../databaseService";
import { MigrationResult } from "../migrationService";
import { generateVideoThumbnail } from "../../utils/videoThumbnailUtils";

export async function migrateVideoThumbnails(db: DatabaseService): Promise<MigrationResult> {
	const notes = await db.getAllNotes();
	let migrated = 0;
	let skipped = 0;

	for (const note of notes) {
		let noteChanged = false;

		for (const entry of note.entries) {
			if (entry.type !== "video") continue;

			const params = entry.params as NoteEntryVideoParams;

			if (!params.path || params.thumbnailPath) {
				skipped++;
				continue;
			}

			try {
				const webUrl = Capacitor.convertFileSrc(params.path);
				const base64 = await generateVideoThumbnail(webUrl);
				const filename = (params.path.split("/").pop() ?? "video.mp4").replace(/\.[^.]+$/, ".jpg");
				const result = await Filesystem.writeFile({
					path: filename,
					data: base64,
					directory: Directory.External,
				});
				params.thumbnailPath = result.uri;
				noteChanged = true;
				migrated++;
			} catch {
				skipped++;
			}
		}

		if (noteChanged) {
			await db.updateNote(note.id, note);
		}
	}

	return { counts: { "Entrées vidéo": { migrated, skipped } } };
}
