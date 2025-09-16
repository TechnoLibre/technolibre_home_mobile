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

	public async getNotes(): Promise<Array<Note>> {
		if (this._notes === undefined) {
			this._notes = await this.getNotesFromStorage();
		}
		return this._notes;
	}

	public async add(note: Note): Promise<boolean> {
		const noteList = await this.getNotes();
		noteList.push(note);

		const saveResult = await this.saveNoteListToStorage(noteList);

		if (saveResult.value) {
			this._notes = noteList;
		}

		return saveResult.value;
	}

	public async clear() {
		const newNoteList = [];

		const saveResult = await this.saveNoteListToStorage(newNoteList);

		if (saveResult.value) {
			this._notes = newNoteList;
		}

		return saveResult.value;
	}

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

	public async matches(noteId: string): Promise<Array<Note>> {
		const noteList: Array<Note> = await this.getNotesFromStorage();

		return noteList.filter(note => noteId === note.id);
	}

	public async getMatch(noteId: string): Promise<Note> {
		const matches = await this.matches(noteId);

		if (matches.length === 0) {
			throw new NoNoteMatchError();
		}

		return matches[0];
	}

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

	private async saveNoteListToStorage(noteList: Array<Note>): Promise<{ value: boolean }> {
		return StorageUtils.setKeyValuePair(Constants.NOTES_STORAGE_KEY, noteList);
	}

	public isMatchResultValid(result: Partial<GetMatchesResult>): result is GetMatchesResult {
		return result.noteList !== undefined && result.matches !== undefined;
	}

	public isMatchResultEmpty(result: GetMatchesResult): boolean {
		return result.noteList?.length === 0 || result.matches?.length === 0;
	}

	private async setNotes() {
		this._notes = await this.getNotes();
	}

	private equals(noteOne: Note, noteTwo: Note): boolean {
		return noteOne.id === noteTwo.id && noteOne.title === noteTwo.title && noteOne.date === noteTwo.date;
	}

	private indexOf(noteList: Array<Note>, note: Note): number {
		for (let i = 0; i < noteList.length; i++) {
			if (this.equals(noteList[i], note)) {
				return i;
			}
		}

		return -1;
	}
}
