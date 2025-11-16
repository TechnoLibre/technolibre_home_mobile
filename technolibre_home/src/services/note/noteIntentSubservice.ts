import { Events } from "../../constants/events";
import { ImageIntent, TextIntent, VideoIntent } from "../../models/intent";
import { NoteEntryPhotoParams, NoteEntryTextParams, NoteEntryVideoParams } from "../../models/note";
import { NoteService } from "./noteService";

export class NoteIntentSubservice {
  private _noteService: NoteService;

  constructor(newNoteService: NoteService) {
    this._noteService = newNoteService;
  }
  
  /**
	 * Creates a new note with a text entry.
	 * 
	 * @param intent - The text intent
	 */
	public async newNoteWithText(intent: TextIntent) {
		if (!this._noteService.notes) {
			return;
		}

		const note = this._noteService.getNewNote(this._noteService.getNewId());
		const entry = this._noteService.entry.getNewTextEntry();
		const params = entry.params as NoteEntryTextParams;

		note.title = "Nouvelle note";
		params.text = intent.text;

		note.entries.push(entry);
		this._noteService.notes.push(note);

		await this._noteService.saveNoteListToStorage(this._noteService.notes);
		this._noteService.eventBus.trigger(Events.RELOAD_NOTES);
	}

	/**
	 * Adds a text entry to a note.
	 * 
	 * @param id - The note's id
	 * 
	 * @param intent - The text intent
	 */
	public async addTextToNote(id: string, intent: TextIntent) {
		if (!this._noteService.notes) {
			return;
		}

		let matchingNote = await this._noteService.getMatch(id);

		const entry = this._noteService.entry.getNewTextEntry();

		const params = entry.params as NoteEntryTextParams;
		params.text = intent.text;
		matchingNote.entries.push(entry);

		await this._noteService.saveNoteListToStorage(this._noteService.notes);
		this._noteService.eventBus.trigger(Events.RELOAD_NOTES);
	}

	/**
	 * Creates a new note with a photo entry.
	 * 
	 * @param intent - The image intent
	 */
	public async newNoteWithImage(intent: ImageIntent) {
		if (!this._noteService.notes) {
			return;
		}

		const note = this._noteService.getNewNote(this._noteService.getNewId());
		const entry = this._noteService.entry.getNewPhotoEntry();
		const params = entry.params as NoteEntryPhotoParams;

		note.title = "Nouvelle note";
		params.path = intent.url;

		note.entries.push(entry);
		this._noteService.notes.push(note);

		await this._noteService.saveNoteListToStorage(this._noteService.notes);
		this._noteService.eventBus.trigger(Events.RELOAD_NOTES);
	}

	/**
	 * Adds an image entry to a note.
	 * 
	 * @param id - The note's id
	 * 
	 * @param intent - The image intent
	 */
	public async addImageToNote(id: string, intent: ImageIntent) {
		if (!this._noteService.notes) {
			return;
		}

		let matchingNote = await this._noteService.getMatch(id);

		const entry = this._noteService.entry.getNewPhotoEntry();

		const params = entry.params as NoteEntryPhotoParams;
		params.path = intent.url;
		matchingNote.entries.push(entry);

		await this._noteService.saveNoteListToStorage(this._noteService.notes);
		this._noteService.eventBus.trigger(Events.RELOAD_NOTES);
	}

	/**
	 * Creates a new note with a video entry.
	 * 
	 * @param intent - The video intent
	 */
	public async newNoteWithVideo(intent: VideoIntent) {
		if (!this._noteService.notes) {
			return;
		}

		const note = this._noteService.getNewNote(this._noteService.getNewId());
		const entry = this._noteService.entry.getNewVideoEntry();
		const params = entry.params as NoteEntryVideoParams;

		note.title = "Nouvelle note";
		params.path = intent.url;

		note.entries.push(entry);
		this._noteService.notes.push(note);

		await this._noteService.saveNoteListToStorage(this._noteService.notes);
		this._noteService.eventBus.trigger(Events.RELOAD_NOTES);
	}

	/**
	 * Adds a video entry to a note.
	 * 
	 * @param id - The note's id
	 * 
	 * @param intent - The video intent
	 */
	public async addVideoToNote(id: string, intent: VideoIntent) {
		if (!this._noteService.notes) {
			return;
		}

		let matchingNote = await this._noteService.getMatch(id);

		const entry = this._noteService.entry.getNewVideoEntry();

		const params = entry.params as NoteEntryVideoParams;
		params.path = intent.url;
		matchingNote.entries.push(entry);

		await this._noteService.saveNoteListToStorage(this._noteService.notes);
		this._noteService.eventBus.trigger(Events.RELOAD_NOTES);
	}
}