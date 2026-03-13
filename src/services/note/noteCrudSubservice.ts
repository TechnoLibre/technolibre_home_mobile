import { NoNoteMatchError } from "../../js/errors";
import { Note } from "../../models/note";
import { NoteService } from "./noteService";

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

		await this._noteService.db.updateNote(noteId, Object.assign({}, newNote));
		return true;
	}
}
