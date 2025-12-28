export const ErrorMessages: Record<string, string> = {
	APP_KEY_NOT_FOUND: "Échec de la récupération des applications du stockage local.",
	NOTE_KEY_NOT_FOUND: "Échec de la récupération des notes du stockage local.",
	UNDEFINED_APP_LIST: "Liste d'applications non existante dans le stockage local.",
	UNDEFINED_NOTE_LIST: "Liste de notes non existante dans le stockage local.",
	NO_APP_MATCH: "Aucune application ne correspond aux données saisies.",
	NO_NOTE_MATCH: "Aucune note ne correspond aux données saisies.",
	NO_NOTE_ENTRY_MATCH: "Aucune entrée de note ne correspond aux données saisies.",
	APP_ALREADY_EXISTS: "Une application avec cet identifiant existe déjà.",
	BIOMETRIC_AUTH: "Échec de l'authentification biométrique.",
	APP_DELETE: "Échec de la suppression de l'application du stockage local.",
	NOTE_DELETE: "Échec de la suppression de la note du stockage local.",
	APP_SAVE: "Échec de la sauvegarde de l'application dans le stockage local.",
	EMPTY_FIELDS: "Tous les champs de texte doivent être remplis.",
	VOICE_RECORDING_INCOMPATIBLE: "Appareil incompatible pour l'enregistrement de messages vocaux.",
	VOICE_RECORDING_PERMISSIONS: "Permissions manquantes pour enregistrer un message vocal.",
	VOICE_RECORDING_GENERIC: "Échec de la tentative d'enregistrement de message vocal.",
	VIDEO_RECORDING_WEB: "Les enregistrements vidéo ne sont pas supportés sur la version web."
}
