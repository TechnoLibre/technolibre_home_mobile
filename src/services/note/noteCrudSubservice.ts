import { NoNoteMatchError } from "../../js/errors";
import { Note } from "../../models/note";
import { NoteService } from "./noteService";

export class NoteCrudSubservice {
	private _noteService: NoteService;

	constructor(newNoteService: NoteService) {
		this._noteService = newNoteService;
	}

	public async add(note: Note): Promise<boolean> {
		try {
			await this._noteService.db.addNote(note);
			this._noteService.invalidateCache();
			return true;
		} catch (error) {
			console.error("Failed to add note:", error);
			return false;
		}
	}

	public async clear(): Promise<boolean> {
		try {
			await this._noteService.db.clearNotes();
			this._noteService.invalidateCache();
			return true;
		} catch (error) {
			console.error("Failed to clear notes:", error);
			return false;
		}
	}

	/**
	 * @throws NoNoteMatchError if the note does not exist.
	 */
	public async delete(noteId: string): Promise<boolean> {
		try {
			const note = await this._noteService.db.getNoteById(noteId);
			if (!note) {
				throw new NoNoteMatchError();
			}

			await this._noteService.db.deleteNote(noteId);
			this._noteService.invalidateCache();
			return true;
		} catch (error) {
			if (error instanceof NoNoteMatchError) {
				throw error;
			}
			console.error("Failed to delete note:", error);
			return false;
		}
	}

	/**
	 * @throws NoNoteMatchError if the note does not exist.
	 */
	public async edit(noteId: string, newNote: Note): Promise<boolean> {
		try {
			const existingNote = await this._noteService.db.getNoteById(noteId);
			if (!existingNote) {
				throw new NoNoteMatchError();
			}

			await this._noteService.db.updateNote(newNote);
			this._noteService.invalidateCache();
			return true;
		} catch (error) {
			if (error instanceof NoNoteMatchError) {
				throw error;
			}
			console.error("Failed to edit note:", error);
			return false;
		}
	}
}
