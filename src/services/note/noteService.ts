import { v4 as uuidv4, validate, version } from "uuid";
import { Note } from "../../models/note";
import { NoNoteMatchError } from "../../js/errors";
import { EventBus } from "@odoo/owl";
import { NoteIntentSubservice } from "./noteIntentSubservice";
import { NoteEntrySubservice } from "./noteEntrySubservice";
import { NoteCrudSubservice } from "./noteCrudSubservice";
import { DatabaseService } from "../databaseService";

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
	private _db: DatabaseService;

	constructor(newEventBus: EventBus) {
		this._eventBus = newEventBus;
		this._intent = new NoteIntentSubservice(this);
		this._entry = new NoteEntrySubservice(this);
		this._crud = new NoteCrudSubservice(this);
		this._db = DatabaseService.getInstance();
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

	public get db(): DatabaseService {
		return this._db;
	}

	/**
	 * Returns all notes, using in-memory cache when available.
	 */
	public async getNotes(): Promise<Array<Note>> {
		if (this._notes === undefined) {
			this._notes = await this._db.getAllNotes();
		}
		return this._notes;
	}

	/**
	 * Replaces the entire note list (used for reordering).
	 */
	public async setNotes(newNotes: Array<Note>): Promise<boolean> {
		try {
			await this._db.clearNotes();
			for (const note of newNotes) {
				await this._db.addNote(note);
			}
			this._notes = await this._db.getAllNotes();
			return true;
		} catch (error) {
			console.error("setNotes failed:", error);
			return false;
		}
	}

	/**
	 * Returns all notes matching the provided id.
	 */
	public async matches(noteId: string): Promise<Array<Note>> {
		this._notes = await this._db.getAllNotes();
		return this._notes.filter(note => noteId === note.id);
	}

	/**
	 * Returns the note matching the provided id.
	 *
	 * @throws NoNoteMatchError if no note is found.
	 */
	public async getMatch(noteId: string): Promise<Note> {
		const note = await this._db.getNoteById(noteId);

		if (!note) {
			throw new NoNoteMatchError();
		}

		return note;
	}

	/**
	 * Returns all unique tags across all notes, sorted alphabetically.
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

	public getNewId(): string {
		return uuidv4();
	}

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

	public isValidId(noteId: string): boolean {
		return validate(noteId) && version(noteId) === 4;
	}

	/**
	 * Invalidate the in-memory cache to force a fresh read from SQLite.
	 */
	public invalidateCache(): void {
		this._notes = undefined;
	}
}
