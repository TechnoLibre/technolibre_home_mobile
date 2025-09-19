import { Note } from "../components/notes/types";
import { StorageGetResult, StorageUtils } from "../utils/storageUtils";
import { Constants } from "./constants";
import { NoNoteMatchError, NoteKeyNotFoundError, UndefinedNoteListError } from "./errors";

export interface GetNoteListResult {
	noteList: Array<Note>;
}

export interface GetMatchesResult extends GetNoteListResult {
	matches: Array<Note>;
}

export class NoteService {
	private _notes?: Array<Note>;

	constructor() {
		this.setNotes();
	}

	/**
	 * Returns all of the current notes.
	 *
	 * @returns The current list of notes
	 *
	 * @throws NoteKeyNotFoundError
	 * Thrown if the notes key is not found in the secure storage.
	 *
	 * @throws UndefinedNoteListError
	 * Thrown if the list of notes is undefined.
	 */
	public async getNotes(): Promise<Array<Note>> {
		if (this._notes === undefined) {
			this._notes = await this.getNotesFromStorage();
		}
		return this._notes;
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
		const noteList = await this.getNotes();
		noteList.push(note);

		const saveResult = await this.saveNoteListToStorage(noteList);

		if (saveResult.value) {
			this._notes = noteList;
		}

		return saveResult.value;
	}

	/**
	 * Clears the list of notes.
	 */
	public async clear() {
		const newNoteList = [];

		const saveResult = await this.saveNoteListToStorage(newNoteList);

		if (saveResult.value) {
			this._notes = newNoteList;
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
		const matches: Array<Note> = await this.matches(noteId);

		const matchingNote = matches?.[0];

		if (!matchingNote) {
			throw new NoNoteMatchError();
		}

		const noteList: Array<Note> = await this.getNotes();

		const newNoteList = noteList.filter(note => note.id !== matchingNote.id);

		const saveResult = await this.saveNoteListToStorage(newNoteList);

		if (saveResult.value) {
			this._notes = newNoteList;
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
		const noteIDMatches: Array<Note> = await this.matches(noteId);

		const noteToEdit = noteIDMatches?.[0];

		if (!noteToEdit) {
			throw new NoNoteMatchError();
		}

		const noteList = await this.getNotes();
		const editIndex = this.indexOf(noteList, noteToEdit);

		if (editIndex === -1) {
			throw new NoNoteMatchError();
		}

		noteList[editIndex] = Object.assign({}, newNote);

		const saveResult = await this.saveNoteListToStorage(noteList);

		if (saveResult.value) {
			this._notes = noteList;
		}

		return saveResult.value;
	}

	/**
	 * Returns all the notes that match the provided note id.
	 *
	 * @param noteId - The id of the target note
	 *
	 * @returns The list of notes that match the provided note id
	 *
	 * @throws NoteKeyNotFoundError
	 * Thrown if the notes key is not found in the secure storage.
	 *
	 * @throws UndefinedNoteListError
	 * Thrown if the list of notes is undefined.
	 */
	public async matches(noteId: string): Promise<Array<Note>> {
		const noteList: Array<Note> = await this.getNotesFromStorage();

		return noteList.filter(note => noteId === note.id);
	}

	/**
	 * Returns the note that matches the provided note id.
	 *
	 * @param noteId - The id of the target note
	 *
	 * @returns The note that matches the provided note id
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
	public async getMatch(noteId: string): Promise<Note> {
		const matches = await this.matches(noteId);

		if (matches.length === 0) {
			throw new NoNoteMatchError();
		}

		return matches[0];
	}

	/**
	 * Returns all the notes from the local storage.
	 *
	 * @returns The list of notes from the device's secure storage
	 *
	 * @throws NoteKeyNotFoundError
	 * Thrown if the notes key is not found in the secure storage.
	 *
	 * @throws UndefinedNoteListError
	 * Thrown if the list of notes is undefined.
	 */
	private async getNotesFromStorage(): Promise<Array<Note>> {
		const storageGetResult: StorageGetResult<Array<Note>> = await StorageUtils.getValueByKey<Array<Note>>(
			Constants.NOTES_STORAGE_KEY
		);

		if (!storageGetResult.keyExists) {
			throw new NoteKeyNotFoundError();
		}

		if (storageGetResult.value === undefined) {
			throw new UndefinedNoteListError();
		}

		return storageGetResult.value;
	}

	/**
	 * Saves the provided note list to the local storage.
	 *
	 * @param noteList - The list of notes to save to the device's secure storage
	 *
	 * @returns True if the save succeeded, otherwise false
	 */
	private async saveNoteListToStorage(noteList: Array<Note>): Promise<{ value: boolean }> {
		return StorageUtils.setKeyValuePair(Constants.NOTES_STORAGE_KEY, noteList);
	}

	public isMatchResultValid(result: Partial<GetMatchesResult>): result is GetMatchesResult {
		return result.noteList !== undefined && result.matches !== undefined;
	}

	public isMatchResultEmpty(result: GetMatchesResult): boolean {
		return result.noteList?.length === 0 || result.matches?.length === 0;
	}

	/**
	 * Gives the list of notes their initial value.
	 *
	 * @throws NoteKeyNotFoundError
	 * Thrown if the notes key is not found in the secure storage.
	 *
	 * @throws UndefinedNoteListError
	 * Thrown if the list of notes is undefined.
	 */
	private async setNotes() {
		this._notes = await this.getNotes();
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
