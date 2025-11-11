import { ErrorMessages } from "../constants/errorMessages";

export class AppKeyNotFoundError extends Error {
	constructor(message?: string) {
		const errorMessage = message || ErrorMessages.APP_KEY_NOT_FOUND;
		super(errorMessage);
		this.name = "AppKeyNotFoundError";
	}
}

export class NoteKeyNotFoundError extends Error {
	constructor(message?: string) {
		const errorMessage = message || ErrorMessages.NOTE_KEY_NOT_FOUND;
		super(errorMessage);
		this.name = "NoteKeyNotFoundError";
	}
}

export class UndefinedAppListError extends Error {
	constructor(message?: string) {
		const errorMessage = message || ErrorMessages.UNDEFINED_APP_LIST;
		super(errorMessage);
		this.name = "UndefinedAppListError";
	}
}

export class UndefinedNoteListError extends Error {
	constructor(message?: string) {
		const errorMessage = message || ErrorMessages.UNDEFINED_NOTE_LIST;
		super(errorMessage);
		this.name = "UndefinedAppListError";
	}
}

export class NoAppMatchError extends Error {
	constructor(message?: string) {
		const errorMessage = message || ErrorMessages.NO_APP_MATCH;
		super(errorMessage);
		this.name = "NoAppMatchError";
	}
}

export class NoNoteMatchError extends Error {
	constructor(message?: string) {
		const errorMessage = message || ErrorMessages.NO_NOTE_MATCH;
		super(errorMessage);
		this.name = "NoNoteMatchError";
	}
}

export class NoNoteEntryMatchError extends Error {
	constructor(message?: string) {
		const errorMessage = message || ErrorMessages.NO_NOTE_ENTRY_MATCH;
		super(errorMessage);
		this.name = "NoNoteEntryMatchError";
	}
}

export class AppAlreadyExistsError extends Error {
	constructor(message?: string) {
		const errorMessage = message || ErrorMessages.APP_ALREADY_EXISTS;
		super(errorMessage);
		this.name = "AppAlreadyExistsError";
	}
}

export class VideoNotSupportedOnWebError extends Error {
	constructor(message?: string) {
		const errorMessage = message || ErrorMessages.VIDEO_RECORDING_WEB;
		super(errorMessage);
		this.name = "VideoNotSupportedOnWebError";
	}
}
