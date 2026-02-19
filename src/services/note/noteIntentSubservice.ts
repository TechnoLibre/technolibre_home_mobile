import { Events } from "../../constants/events";
import { ImageIntent, TextIntent, VideoIntent } from "../../models/intent";
import { NoteEntryPhotoParams, NoteEntryTextParams, NoteEntryVideoParams } from "../../models/note";
import { NoteService } from "./noteService";

const ENV = {
    // @ts-ignore
    TITLE: import.meta.env.VITE_TITLE ?? "TITLE",
    // @ts-ignore
    LABEL_NOTE: import.meta.env.VITE_LABEL_NOTE ?? "Note",
    // @ts-ignore
    LOGO_KEY: import.meta.env.VITE_LOGO_KEY ?? "techno",
    // @ts-ignore
    WEBSITE_URL: import.meta.env.VITE_WEBSITE_URL ?? "https://erplibre.ca",
    // @ts-ignore
    DEBUG_DEV: import.meta.env.VITE_DEBUG_DEV === "true",
};

export class NoteIntentSubservice {
  private _noteService: NoteService;

  constructor(newNoteService: NoteService) {
    this._noteService = newNoteService;
  }

	public async newNoteWithText(intent: TextIntent) {
		const note = this._noteService.getNewNote(this._noteService.getNewId());
		const entry = this._noteService.entry.getNewTextEntry();
		const params = entry.params as NoteEntryTextParams;

		note.title = `Nouvelle ${ENV.LABEL_NOTE}`;
		note.date = (new Date()).toISOString();
		params.text = intent.text;

		note.entries.push(entry);

		await this._noteService.crud.add(note);
		this._noteService.eventBus.trigger(Events.RELOAD_NOTES);
	}

	public async addTextToNote(id: string, intent: TextIntent) {
		let matchingNote = await this._noteService.getMatch(id);

		const entry = this._noteService.entry.getNewTextEntry();

		const params = entry.params as NoteEntryTextParams;
		params.text = intent.text;
		matchingNote.entries.push(entry);

		await this._noteService.crud.edit(id, matchingNote);
		this._noteService.eventBus.trigger(Events.RELOAD_NOTES);
	}

	public async newNoteWithImage(intent: ImageIntent) {
		const note = this._noteService.getNewNote(this._noteService.getNewId());
		const entry = this._noteService.entry.getNewPhotoEntry();
		const params = entry.params as NoteEntryPhotoParams;

		note.title = `Nouvelle ${ENV.LABEL_NOTE}`;
		note.date = (new Date()).toISOString();
		params.path = intent.url;

		note.entries.push(entry);

		await this._noteService.crud.add(note);
		this._noteService.eventBus.trigger(Events.RELOAD_NOTES);
	}

	public async addImageToNote(id: string, intent: ImageIntent) {
		let matchingNote = await this._noteService.getMatch(id);

		const entry = this._noteService.entry.getNewPhotoEntry();

		const params = entry.params as NoteEntryPhotoParams;
		params.path = intent.url;
		matchingNote.entries.push(entry);

		await this._noteService.crud.edit(id, matchingNote);
		this._noteService.eventBus.trigger(Events.RELOAD_NOTES);
	}

	public async newNoteWithVideo(intent: VideoIntent) {
		const note = this._noteService.getNewNote(this._noteService.getNewId());
		const entry = this._noteService.entry.getNewVideoEntry();
		const params = entry.params as NoteEntryVideoParams;

		note.title = `Nouvelle ${ENV.LABEL_NOTE}`;
		note.date = (new Date()).toISOString();
		params.path = intent.url;

		note.entries.push(entry);

		await this._noteService.crud.add(note);
		this._noteService.eventBus.trigger(Events.RELOAD_NOTES);
	}

	public async addVideoToNote(id: string, intent: VideoIntent) {
		let matchingNote = await this._noteService.getMatch(id);

		const entry = this._noteService.entry.getNewVideoEntry();

		const params = entry.params as NoteEntryVideoParams;
		params.path = intent.url;
		matchingNote.entries.push(entry);

		await this._noteService.crud.edit(id, matchingNote);
		this._noteService.eventBus.trigger(Events.RELOAD_NOTES);
	}
}
