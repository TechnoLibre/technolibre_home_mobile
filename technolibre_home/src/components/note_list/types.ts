export interface Note {
	id: string;
	title: string;
	date?: string;
	done: boolean;
	archived: boolean;
	pinned: boolean;
	tags: Array<string>;
	entries: Array<NoteEntry>;
}

export interface NoteEntryAudioParams {
	path: string
}

export interface NoteEntryDateParams {
	/** La date en format ISO */
	date: string
}

export interface NoteEntryTextParams {
	text: string;
	readonly: boolean;
}

export interface NoteEntryVideoParams {
	path: string
}

export interface NoteEntryGeolocationParams {
	text: string;
	latitude: number;
	longitude: number;
	timestamp: number;
}

export type NoteEntryType = "audio" | "date" | "geolocation" | "text" | "video";
export type NoteEntryParams = NoteEntryAudioParams |
	NoteEntryDateParams |
	NoteEntryGeolocationParams |
	NoteEntryTextParams |
	NoteEntryVideoParams;

export interface NoteEntry {
	id: string;
	type: NoteEntryType;
	params: NoteEntryParams;
}
