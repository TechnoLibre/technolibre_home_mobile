export interface Note {
	id: string;
	title: string;
	date?: string;
	done: boolean;
	archived: boolean;
	pinned: boolean;
	priority?: 1 | 2 | 3 | 4;
	tags: Array<string>;
	entries: Array<NoteEntry>;
}

export interface NoteEntryAudioParams {
	path: string;
	/** Text produced by Whisper transcription, stored on the entry itself. */
	transcription?: string;
	/** Translation of the transcription text. */
	transcriptionTranslation?: string;
	/** Target language of the transcription translation ("fr" | "en"). */
	transcriptionTranslationLang?: string;
}

export interface NoteEntryDateParams {
	/** La date en format ISO */
	date: string
}

export interface NoteEntryPhotoParams {
	path: string;
}

export interface NoteEntryTextParams {
	text: string;
	readonly: boolean;
	/** Translation of the text content. */
	translation?: string;
	/** Target language of the translation ("fr" | "en"). */
	translationLang?: string;
}

export interface NoteEntryVideoParams {
	path: string;
	thumbnailPath?: string;
	/** Text produced by Whisper transcription, stored on the entry itself. */
	transcription?: string;
	/** Translation of the transcription text. */
	transcriptionTranslation?: string;
	/** Target language of the transcription translation ("fr" | "en"). */
	transcriptionTranslationLang?: string;
}

export interface NoteEntryGeolocationParams {
	text: string;
	latitude: number;
	longitude: number;
	timestamp: number;
}

export type NoteEntryType = "audio" | "date" | "geolocation" | "photo" | "text" | "video";
export type NoteEntryParams = NoteEntryAudioParams |
	NoteEntryDateParams |
	NoteEntryGeolocationParams |
	NoteEntryPhotoParams |
	NoteEntryTextParams |
	NoteEntryVideoParams;

export interface NoteEntry {
	id: string;
	type: NoteEntryType;
	params: NoteEntryParams;
}
