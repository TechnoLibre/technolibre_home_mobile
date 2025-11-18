import { v4 as uuidv4, validate, version } from "uuid";
import { Note } from "../../models/note";
import { StorageConstants } from "../../constants/storage";
import { StorageGetResult, StorageUtils } from "../../utils/storageUtils";
import { NoNoteMatchError, NoteKeyNotFoundError, UndefinedNoteListError } from "../../js/errors";
import { EventBus } from "@odoo/owl";
import { NoteIntentSubservice } from "./noteIntentSubservice";
import { NoteEntrySubservice } from "./noteEntrySubservice";
import { NoteCrudSubservice } from "./noteCrudSubservice";

export interface GetNoteListResult {
	noteList: Array<Note>;
}

export interface GetMatchesResult extends GetNoteListResult {
	matches: Array<Note>;
}

export class NoteService {
	private _notes?: Array<Note>;
	private _eventBus: EventBus;
	private _intent: NoteIntentSubservice;
	private _entry: NoteEntrySubservice;
	private _crud: NoteCrudSubservice;

	constructor(newEventBus: EventBus) {
		this._eventBus = newEventBus;
		this._intent = new NoteIntentSubservice(this);
		this._entry = new NoteEntrySubservice(this);
		this._crud = new NoteCrudSubservice(this);
	}

	public get notes(): Array<Note> | undefined {
		return this._notes;
	}

	public set notes(newNotes: Array<Note>) {
		this._notes = newNotes;
	}

	public get eventBus(): EventBus {
		return this._eventBus;
	}

	public get intent(): NoteIntentSubservice {
		return this._intent;
	}

	public get entry(): NoteEntrySubservice {
		return this._entry;
	}

	public get crud(): NoteCrudSubservice {
		return this._crud;
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
	 * Sets the note list.
	 * 
	 * @param newNotes - The new note list
	 */
	public async setNotes(newNotes: Array<Note>): Promise<boolean> {
		const result = await this.saveNoteListToStorage(newNotes);

		if (!result.value) {
			return false;
		}

		this._notes = await this.getNotesFromStorage();

		return true;
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
		this._notes = await this.getNotesFromStorage();

		return this._notes.filter(note => noteId === note.id);
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
	 * Returns all tags.
	 *
	 * @returns The list of all tags
	 *
	 * @throws NoteKeyNotFoundError
	 * Thrown if the notes key is not found in the secure storage.
	 *
	 * @throws UndefinedNoteListError
	 * Thrown if the list of notes is undefined.
	 */
	public async getTags(): Promise<Array<string>> {
		const tags: Set<string> = new Set<string>();
		const notes = await this.getNotes();
		for (const note of notes) {
			for (const tag of note.tags) {
				tags.add(tag);
			}
		}
		return Array.from(tags).sort();
	}

	/**
	 * Returns a new unique id.
	 *
	 * @returns a new v4 UUID
	 */
	public getNewId(): string {
		return uuidv4();
	}

	/**
	 * Returns a new note.
	 *
	 * @param noteId - The id of the note
	 *
	 * @returns a new (empty) note
	 */
	public getNewNote(noteId?: string): Note {
		return {
			id: noteId || "",
			title: "",
			done: false,
			archived: false,
			pinned: false,
			tags: [],
			entries: []
		};
	}

	/**
	 * Returns whether or not the provided id is valid.
	 *
	 * @param noteId - The id to validate
	 *
	 * @returns True if the id is valid, otherwise false
	 */
	public isValidId(noteId: string): boolean {
		return validate(noteId) && version(noteId) === 4;
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
			StorageConstants.NOTES_STORAGE_KEY
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
	public async saveNoteListToStorage(noteList: Array<Note>): Promise<{ value: boolean }> {
		return StorageUtils.setKeyValuePair(StorageConstants.NOTES_STORAGE_KEY, noteList);
	}
}
