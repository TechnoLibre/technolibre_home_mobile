export interface Note {
	id: string;
	title: string;
	date?: string;
}

export interface NoteEntryAudioParams {
	fileId: string;
}

export interface NoteEntryTextParams {
	text: string;
}

export interface NoteEntryTitleParams {
	title: string;
}

export type NoteEntryType = "audio" | "text" | "title";
export type NoteEntryParams = NoteEntryAudioParams | NoteEntryTextParams | NoteEntryTitleParams;

export interface NoteEntry {
	id: string;
	type: NoteEntryType;
	params: NoteEntryParams;
}
