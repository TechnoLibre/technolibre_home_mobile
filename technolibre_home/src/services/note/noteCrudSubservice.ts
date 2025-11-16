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
	 *
	 * @throws NoteKeyNotFoundError
	 * Thrown if the notes key is not found in the secure storage.
	 *
	 * @throws UndefinedNoteListError
	 * Thrown if the list of notes is undefined.
	 */
	public async add(note: Note): Promise<boolean> {
		const noteList = await this._noteService.getNotes();
		noteList.push(note);

		const saveResult = await this._noteService.saveNoteListToStorage(noteList);

		if (saveResult.value) {
			this._noteService.notes = noteList;
		}

		return saveResult.value;
	}

	/**
	 * Clears the list of notes.
	 */
	public async clear() {
		const newNoteList: Note[] = [];

		const saveResult = await this._noteService.saveNoteListToStorage(newNoteList);

		if (saveResult.value) {
			this._noteService.notes = newNoteList;
		}

		return saveResult.value;
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
	 *
	 * @throws NoteKeyNotFoundError
	 * Thrown if the notes key is not found in the secure storage.
	 *
	 * @throws UndefinedNoteListError
	 * Thrown if the list of notes is undefined.
	 */
	public async delete(noteId: string): Promise<boolean> {
		const matches: Array<Note> = await this._noteService.matches(noteId);

		const matchingNote = matches?.[0];

		if (!matchingNote) {
			throw new NoNoteMatchError();
		}

		const noteList: Array<Note> = await this._noteService.getNotes();

		const newNoteList = noteList.filter(note => note.id !== matchingNote.id);

		const saveResult = await this._noteService.saveNoteListToStorage(newNoteList);

		if (saveResult.value) {
			this._noteService.notes = newNoteList;
		}

		return saveResult.value;
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
	 *
	 * @throws NoteKeyNotFoundError
	 * Thrown if the notes key is not found in the secure storage.
	 *
	 * @throws UndefinedNoteListError
	 * Thrown if the list of notes is undefined.
	 */
	public async edit(noteId: string, newNote: Note): Promise<boolean> {
		const noteIDMatches: Array<Note> = await this._noteService.matches(noteId);

		const noteToEdit = noteIDMatches?.[0];

		if (!noteToEdit) {
			throw new NoNoteMatchError();
		}

		const noteList = await this._noteService.getNotes();
		const editIndex = this.indexOf(noteList, noteToEdit);

		if (editIndex === -1) {
			throw new NoNoteMatchError();
		}

		noteList[editIndex] = Object.assign({}, newNote);

		const saveResult = await this._noteService.saveNoteListToStorage(noteList);

		if (saveResult.value) {
			this._noteService.notes = noteList;
		}

		return saveResult.value;
	}

	/**
	 * Determines the equality of two notes.
	 *
	 * @param noteOne - The first note to compare
	 *
	 * @param noteTwo - The second note to compare
	 *
	 * @returns True if the two notes are equal, otherwise false
	 */
	private equals(noteOne: Note, noteTwo: Note): boolean {
		return noteOne.id === noteTwo.id && noteOne.title === noteTwo.title && noteOne.date === noteTwo.date;
	}

	/**
	 * Returns the index of the matching note in the note list.
	 * If no match is found, returns -1.
	 *
	 * @param noteList - The list of notes to search
	 *
	 * @param note - The note to look for
	 *
	 * @returns The index of the note in the list
	 */
	private indexOf(noteList: Array<Note>, note: Note): number {
		for (let i = 0; i < noteList.length; i++) {
			if (this.equals(noteList[i], note)) {
				return i;
			}
		}

		return -1;
	}
}