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

export class ErrorMessages {
	public static APP_KEY_NOT_FOUND: string = "Échec de la récupération des applications du stockage local.";

	public static NOTE_KEY_NOT_FOUND: string = "Échec de la récupération des notes du stockage local.";

	public static UNDEFINED_APP_LIST: string = "Liste d'applications non existante dans le stockage local.";

	public static UNDEFINED_NOTE_LIST: string = "Liste de notes non existante dans le stockage local.";

	public static NO_APP_MATCH: string = "Aucune application ne correspond aux données saisies.";

	public static NO_NOTE_MATCH: string = "Aucune note ne correspond aux données saisies.";

	public static NO_NOTE_ENTRY_MATCH: string = "Aucune entrée de note ne correspond aux données saisies.";

	public static APP_ALREADY_EXISTS: string = "Une application avec cet identifiant existe déjà.";

	public static BIOMETRIC_AUTH: string = "Échec de l'authentification biométrique.";

	public static APP_DELETE: string = "Échec de la suppression de l'application du stockage local.";

	public static NOTE_DELETE: string = "Échec de la suppression de la note du stockage local.";

	public static APP_SAVE: string = "Échec de la sauvegarde de l'application dans le stockage local.";

	public static EMPTY_FIELDS: string = "Tous les champs de texte doivent être remplis.";

	public static VOICE_RECORDING_INCOMPATIBLE: string = "Appareil incompatible pour l'enregistrement de messages vocaux.";

	public static VOICE_RECORDING_PERMISSIONS: string = "Permissions manquantes pour enregistrer un message vocal.";

	public static VOICE_RECORDING_GENERIC: string = "Échec de la tentative d'enregistrement de message vocal.";
}
