export interface Note {
	id: string;
	title: string;
	date?: string;
	entries: Array<NoteEntry>;
}

export interface NoteEntryAudioParams {
	fileId: string;
}

export interface NoteEntryTextParams {
	text: string;
}

export type NoteEntryType = "audio" | "text";
export type NoteEntryParams = NoteEntryAudioParams | NoteEntryTextParams;

export interface NoteEntry {
	id: string;
	type: NoteEntryType;
	params: NoteEntryParams;
}
