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
	fileId: string;
}

export interface NoteEntryTextParams {
	text: string;
	readonly: boolean;
}

export interface NoteEntryGeolocationParams {
	text: string;
	latitude: number;
	longitude: number;
	timestamp: number;
}

export type NoteEntryType = "audio" | "geolocation" | "text";
export type NoteEntryParams = NoteEntryAudioParams | NoteEntryGeolocationParams | NoteEntryTextParams;

export interface NoteEntry {
	id: string;
	type: NoteEntryType;
	params: NoteEntryParams;
}
