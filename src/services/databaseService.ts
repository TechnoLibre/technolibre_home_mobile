import { CapacitorSQLite, SQLiteConnection, SQLiteDBConnection } from "@capacitor-community/sqlite";
import { Capacitor } from "@capacitor/core";
import { Application, ApplicationID } from "../models/application";
import { Note, NoteEntry } from "../models/note";

const DB_NAME = "erplibre_mobile";
const DB_VERSION = 1;

const CREATE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS applications (
  url TEXT NOT NULL,
  username TEXT NOT NULL,
  password TEXT NOT NULL,
  PRIMARY KEY (url, username)
);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  date TEXT,
  done INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS note_tags (
  note_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (note_id, tag),
  FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS note_entries (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL,
  type TEXT NOT NULL,
  params TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
);
`;

/**
 * Singleton service that manages the encrypted SQLite database.
 */
export class DatabaseService {
	private static _instance: DatabaseService;
	private _db: SQLiteDBConnection | null = null;
	private _sqlite: SQLiteConnection;
	private _initialized: boolean = false;

	private constructor() {
		this._sqlite = new SQLiteConnection(CapacitorSQLite);
	}

	public static getInstance(): DatabaseService {
		if (!DatabaseService._instance) {
			DatabaseService._instance = new DatabaseService();
		}
		return DatabaseService._instance;
	}

	/**
	 * Initialize the database connection and create tables.
	 * Must be called once at app startup.
	 */
	public async initialize(): Promise<void> {
		if (this._initialized) {
			return;
		}

		const platform = Capacitor.getPlatform();

		if (platform !== "web") {
			const isSecretStored = await this._sqlite.isSecretStored();
			if (!isSecretStored.result) {
				const passphrase = this.generatePassphrase();
				await this._sqlite.setEncryptionSecret(passphrase);
			}
		}

		const encrypted = platform !== "web";
		const mode = encrypted ? "secret" : "no-encryption";

		this._db = await this._sqlite.createConnection(
			DB_NAME,
			encrypted,
			mode,
			DB_VERSION,
			false
		);

		await this._db.open();
		await this._db.execute("PRAGMA foreign_keys = ON;", false);
		await this._db.execute(CREATE_TABLES_SQL, false);

		this._initialized = true;
	}

	/**
	 * Generate a random 256-bit passphrase for SQLCipher encryption.
	 */
	private generatePassphrase(): string {
		const array = new Uint8Array(32);
		crypto.getRandomValues(array);
		return Array.from(array, (byte) => byte.toString(16).padStart(2, "0")).join("");
	}

	private getDb(): SQLiteDBConnection {
		if (!this._db) {
			throw new Error("Database not initialized. Call initialize() first.");
		}
		return this._db;
	}

	// =========================================================================
	// Applications
	// =========================================================================

	public async getAllApplications(): Promise<Array<Application>> {
		const db = this.getDb();
		const result = await db.query("SELECT url, username, password FROM applications;");
		return (result.values || []) as Array<Application>;
	}

	public async addApplication(app: Application): Promise<void> {
		const db = this.getDb();
		await db.run(
			"INSERT INTO applications (url, username, password) VALUES (?, ?, ?);",
			[app.url, app.username, app.password]
		);
	}

	public async deleteApplication(appID: ApplicationID): Promise<void> {
		const db = this.getDb();
		await db.run(
			"DELETE FROM applications WHERE url = ? AND username = ?;",
			[appID.url, appID.username]
		);
	}

	public async updateApplication(oldID: ApplicationID, newApp: Application): Promise<void> {
		const db = this.getDb();
		await db.run(
			"UPDATE applications SET url = ?, username = ?, password = ? WHERE url = ? AND username = ?;",
			[newApp.url, newApp.username, newApp.password, oldID.url, oldID.username]
		);
	}

	public async findApplications(appID: ApplicationID): Promise<Array<Application>> {
		const db = this.getDb();
		const result = await db.query(
			"SELECT url, username, password FROM applications WHERE url = ? AND username = ?;",
			[appID.url, appID.username]
		);
		return (result.values || []) as Array<Application>;
	}

	public async clearApplications(): Promise<void> {
		const db = this.getDb();
		await db.run("DELETE FROM applications;");
	}

	// =========================================================================
	// Notes
	// =========================================================================

	/**
	 * Fetch all notes with their tags and entries.
	 * Assembles data from the notes, note_tags, and note_entries tables.
	 */
	public async getAllNotes(): Promise<Array<Note>> {
		const db = this.getDb();

		const notesResult = await db.query("SELECT id, title, date, done, archived, pinned FROM notes;");
		const rawNotes = notesResult.values || [];

		if (rawNotes.length === 0) {
			return [];
		}

		const tagsResult = await db.query("SELECT note_id, tag FROM note_tags;");
		const rawTags = tagsResult.values || [];

		const entriesResult = await db.query(
			"SELECT id, note_id, type, params, sort_order FROM note_entries ORDER BY sort_order;"
		);
		const rawEntries = entriesResult.values || [];

		// Group tags by note_id
		const tagsByNoteId: Record<string, string[]> = {};
		for (const row of rawTags) {
			if (!tagsByNoteId[row.note_id]) {
				tagsByNoteId[row.note_id] = [];
			}
			tagsByNoteId[row.note_id].push(row.tag);
		}

		// Group entries by note_id
		const entriesByNoteId: Record<string, NoteEntry[]> = {};
		for (const row of rawEntries) {
			if (!entriesByNoteId[row.note_id]) {
				entriesByNoteId[row.note_id] = [];
			}
			entriesByNoteId[row.note_id].push({
				id: row.id,
				type: row.type,
				params: JSON.parse(row.params),
			});
		}

		return rawNotes.map((row: any) => ({
			id: row.id,
			title: row.title,
			date: row.date || undefined,
			done: row.done === 1,
			archived: row.archived === 1,
			pinned: row.pinned === 1,
			tags: tagsByNoteId[row.id] || [],
			entries: entriesByNoteId[row.id] || [],
		}));
	}

	public async getNoteById(noteId: string): Promise<Note | null> {
		const db = this.getDb();

		const noteResult = await db.query(
			"SELECT id, title, date, done, archived, pinned FROM notes WHERE id = ?;",
			[noteId]
		);
		const rawNotes = noteResult.values || [];

		if (rawNotes.length === 0) {
			return null;
		}

		const row = rawNotes[0];

		const tagsResult = await db.query(
			"SELECT tag FROM note_tags WHERE note_id = ?;",
			[noteId]
		);
		const tags = (tagsResult.values || []).map((r: any) => r.tag);

		const entriesResult = await db.query(
			"SELECT id, type, params FROM note_entries WHERE note_id = ? ORDER BY sort_order;",
			[noteId]
		);
		const entries: NoteEntry[] = (entriesResult.values || []).map((r: any) => ({
			id: r.id,
			type: r.type,
			params: JSON.parse(r.params),
		}));

		return {
			id: row.id,
			title: row.title,
			date: row.date || undefined,
			done: row.done === 1,
			archived: row.archived === 1,
			pinned: row.pinned === 1,
			tags,
			entries,
		};
	}

	/**
	 * Insert a note with its tags and entries in a single transaction.
	 */
	public async addNote(note: Note): Promise<void> {
		const db = this.getDb();

		await db.beginTransaction();
		try {
			await db.run(
				"INSERT INTO notes (id, title, date, done, archived, pinned) VALUES (?, ?, ?, ?, ?, ?);",
				[note.id, note.title, note.date || null, note.done ? 1 : 0, note.archived ? 1 : 0, note.pinned ? 1 : 0],
				false
			);

			for (const tag of note.tags) {
				await db.run(
					"INSERT INTO note_tags (note_id, tag) VALUES (?, ?);",
					[note.id, tag],
					false
				);
			}

			for (let i = 0; i < note.entries.length; i++) {
				const entry = note.entries[i];
				await db.run(
					"INSERT INTO note_entries (id, note_id, type, params, sort_order) VALUES (?, ?, ?, ?, ?);",
					[entry.id, note.id, entry.type, JSON.stringify(entry.params), i],
					false
				);
			}

			await db.commitTransaction();
		} catch (error) {
			await db.rollbackTransaction();
			throw error;
		}
	}

	/**
	 * Update a note by replacing its tags and entries within a transaction.
	 */
	public async updateNote(note: Note): Promise<void> {
		const db = this.getDb();

		await db.beginTransaction();
		try {
			await db.run(
				"UPDATE notes SET title = ?, date = ?, done = ?, archived = ?, pinned = ? WHERE id = ?;",
				[note.title, note.date || null, note.done ? 1 : 0, note.archived ? 1 : 0, note.pinned ? 1 : 0, note.id],
				false
			);

			await db.run("DELETE FROM note_tags WHERE note_id = ?;", [note.id], false);
			for (const tag of note.tags) {
				await db.run(
					"INSERT INTO note_tags (note_id, tag) VALUES (?, ?);",
					[note.id, tag],
					false
				);
			}

			await db.run("DELETE FROM note_entries WHERE note_id = ?;", [note.id], false);
			for (let i = 0; i < note.entries.length; i++) {
				const entry = note.entries[i];
				await db.run(
					"INSERT INTO note_entries (id, note_id, type, params, sort_order) VALUES (?, ?, ?, ?, ?);",
					[entry.id, note.id, entry.type, JSON.stringify(entry.params), i],
					false
				);
			}

			await db.commitTransaction();
		} catch (error) {
			await db.rollbackTransaction();
			throw error;
		}
	}

	/**
	 * Delete a note. Tags and entries are removed via ON DELETE CASCADE.
	 */
	public async deleteNote(noteId: string): Promise<void> {
		const db = this.getDb();
		await db.run("DELETE FROM notes WHERE id = ?;", [noteId]);
	}

	public async clearNotes(): Promise<void> {
		const db = this.getDb();
		await db.run("DELETE FROM notes;");
	}
}
