import { NoNoteMatchError } from "../../js/errors";
import { Note } from "../../models/note";
import { NoteService } from "./noteService";
import { mergeLocalEdit } from "./noteEditMerge";

export class NoteCrudSubservice {
	private _noteService: NoteService;

	constructor(newNoteService: NoteService) {
		this._noteService = newNoteService;
	}

	/**
	 * Adds a note.
	 *
	 * @param note - The note to add
	 *
	 * @returns True if the addition succeeded, otherwise false
	 */
	public async add(note: Note): Promise<boolean> {
		await this._noteService.db.addNote(note);
		return true;
	}

	/**
	 * Clears the list of notes.
	 */
	public async clear(): Promise<boolean> {
		const notes = await this._noteService.getNotes();
		for (const note of notes) {
			await this._noteService.db.deleteNote(note.id);
		}
		return true;
	}

	/**
	 * Deletes a note.
	 *
	 * @param noteId - The id of the target note
	 *
	 * @returns True if the deletion succeeded, otherwise false
	 *
	 * @throws NoNoteMatchError
	 * Thrown if the list of matches is empty.
	 */
	public async delete(noteId: string): Promise<boolean> {
		const matches: Array<Note> = await this._noteService.matches(noteId);

		const matchingNote = matches?.[0];

		if (!matchingNote) {
			throw new NoNoteMatchError();
		}

		await this._noteService.db.deleteNote(matchingNote.id);
		return true;
	}

	/**
	 * Edits a note.
	 *
	 * @param noteId - The id of the target note
	 *
	 * @param newNote - The new version of the target note
	 *
	 * @returns True if the edit succeeded, otherwise false
	 *
	 * @throws NoNoteMatchError
	 * Thrown if the list of matches is empty.
	 */
	public async edit(noteId: string, newNote: Note): Promise<boolean> {
		const matches: Array<Note> = await this._noteService.matches(noteId);

		const noteToEdit = matches?.[0];

		if (!noteToEdit) {
			throw new NoNoteMatchError();
		}

		// Saved under the note's sync lock, together with the pending mark for
		// each server it is linked on: a push or pull settling at the same
		// time either sees this edit or runs after it.
		const db = this._noteService.db;
		try {
			const configIds = await db.getLiveLinkConfigIds(noteId);
			await db.updateNotePerServerStatus(noteId, async (perServer) => {
				await db.updateNote(noteId, Object.assign({}, newNote));
				for (const id of configIds) perServer[id] = "pending";
			});
			if (configIds.length > 0) await db.refreshNoteSyncStatus(noteId);
		} catch {
			// Sync tables not yet migrated: save the note alone
			await db.updateNote(noteId, Object.assign({}, newNote));
		}

		return true;
	}

	/**
	 * Saves an editor's note over the stored one, merged three ways under
	 * the note's sync lock (see mergeLocalEdit): since is the note as the
	 * editor last read or wrote it, so what a pull wrote meanwhile is kept
	 * wherever the editor changed nothing. Marks the note pending on its
	 * servers as edit does. Returns copies taken as it wrote: the editor's
	 * note then (mine) and the note written (saved), which the editor may
	 * have gone on changing since.
	 *
	 * @throws NoNoteMatchError
	 * Thrown if the note is not stored.
	 */
	public async editSince(noteId: string, mine: Note, since: Note): Promise<{ mine: Note; saved: Note }> {
		const db = this._noteService.db;
		let result: { mine: Note; saved: Note } | null = null;
		const write = async () => {
			const stored = await db.getNoteById(noteId);
			if (!stored) throw new NoNoteMatchError();
			const saved = mergeLocalEdit(since, mine, stored);
			result = { mine: JSON.parse(JSON.stringify(mine)), saved: JSON.parse(JSON.stringify(saved)) };
			await db.updateNote(noteId, Object.assign({}, saved));
		};
		try {
			const configIds = await db.getLiveLinkConfigIds(noteId);
			await db.updateNotePerServerStatus(noteId, async (perServer) => {
				await write();
				for (const id of configIds) perServer[id] = "pending";
			});
			if (configIds.length > 0) await db.refreshNoteSyncStatus(noteId);
		} catch (e: unknown) {
			if (e instanceof NoNoteMatchError) throw e;
			// Sync tables not yet migrated: save the note alone
			await write();
		}
		return result!;
	}
}
