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
}

export interface NoteEntryDateParams {
	/** La date en format ISO */
	date: string
}

export interface NoteEntryPhotoParams {
	path: string;
	/** Where the image came from. "camera" → re-edit reopens the
	 *  device camera; "gallery" → re-edit reopens the gallery picker.
	 *  Undefined is treated as "camera" for legacy entries created
	 *  before this field existed. */
	source?: "camera" | "gallery";
}

export interface NoteEntryTextParams {
	text: string;
	readonly: boolean;
}

export interface NoteEntryVideoParams {
	path: string;
	thumbnailPath?: string;
	/** Text produced by Whisper transcription, stored on the entry itself. */
	transcription?: string;
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
