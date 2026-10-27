import type { Migration } from "../migrationService";
import { migrateFromSecureStorage } from "../dataMigration";
import { migrateVideoThumbnails } from "./migrateVideoThumbnails";
import { addSyncColumns } from "./addSyncColumns";
import { addSyncConfigId } from "./addSyncConfigId";
import { addReminderCreatedAt } from "./addReminderCreatedAt";
import { addApplicationSyncFields } from "./addApplicationSyncFields";
import { addUserGraphicPrefs } from "./addUserGraphicPrefs";
import { addSelectedSyncConfigIds } from "./addSelectedSyncConfigIds";
import { addOdooVersionToApplications } from "./addOdooVersionToApplications";
import { addSyncPerServerStatus } from "./addSyncPerServerStatus";
import { addServersTable } from "./addServersTable";
import { addServerWorkspacesTable } from "./addServerWorkspacesTable";
import { addNotePriority } from "./addNotePriority";
import { addProcessesTable } from "./addProcessesTable";
import { addProcessResultColumn } from "./addProcessResultColumn";
import { addProcessDebugLogColumn } from "./addProcessDebugLogColumn";
import { addTagsTable } from "./addTagsTable";
import { addNtfyTokenColumn } from "./addNtfyTokenColumn";
import { encryptExistingCredentials } from "./encryptExistingCredentials";
import { addEditableReposTable } from "./addEditableReposTable";
import { addNoteLinksTable } from "./addNoteLinksTable";
import { addSyncOutboxTable } from "./addSyncOutboxTable";
import { addNoteLinkParams } from "./addNoteLinkParams";
import { addActivitiesCacheTable } from "./addActivitiesCacheTable";
import { addSyncTargetTables } from "./addSyncTargetTables";
import { addChatTables } from "./addChatTables";
import { addChatLot2Columns } from "./addChatLot2Columns";
import { addChatCreateFailed } from "./addChatCreateFailed";
import { addChatLeftUnsent } from "./addChatLeftUnsent";
import { addChatAttachments } from "./addChatAttachments";
import { addChatDrafts } from "./addChatDrafts";
import { addChatDraftOrigin } from "./addChatDraftOrigin";
import { addChatActions } from "./addChatActions";
import { addChatDraftModes } from "./addChatDraftModes";
import { addChatMessageSearch } from "./addChatMessageSearch";
import { addChatMailbox } from "./addChatMailbox";
import { addChatOnTop } from "./addChatOnTop";
import { addChatRecordThreads } from "./addChatRecordThreads";
import { addChatAvatars } from "./addChatAvatars";

/**
 * The app's database migrations, in version order: runMigrations runs at
 * start the ones above the stored schema version. The test kit
 * (src/testing/syncTestKit.ts) builds a database from the same list.
 */
export const APP_MIGRATIONS: Migration[] = [
	{
		version: 2026031801,
		description: "Migration de SecureStorage vers SQLite",
		run: migrateFromSecureStorage,
	},
	{
		version: 2026032401,
		description: "Génération des thumbnails vidéo manquants",
		run: migrateVideoThumbnails,
	},
	{
		version: 2026033001,
		description: "Ajout des colonnes de synchronisation Odoo",
		run: addSyncColumns,
	},
	{
		version: 2026033101,
		description: "Ajout sync_config_id sur les notes",
		run: addSyncConfigId,
	},
	{
		version: 2026033102,
		description: "Ajout created_at sur les rappels",
		run: addReminderCreatedAt,
	},
	{
		version: 2026040801,
		description: "Ajout des champs de synchronisation sur les applications",
		run: addApplicationSyncFields,
	},
	{
		version: 2026040802,
		description: "Création de la table des préférences graphiques utilisateur",
		run: addUserGraphicPrefs,
	},
	{
		version: 2026040803,
		description: "Ajout selected_sync_config_ids sur les notes",
		run: addSelectedSyncConfigIds,
	},
	{
		version: 2026040901,
		description: "Ajout de la version Odoo détectée sur les applications",
		run: addOdooVersionToApplications,
	},
	{
		version: 2026041001,
		description: "Ajout du statut de synchronisation par serveur sur les notes",
		run: addSyncPerServerStatus,
	},
	{
		version: 2026041101,
		description: "Création de la table des serveurs SSH",
		run: addServersTable,
	},
	{
		version: 2026041102,
		description: "Création de la table des workspaces par serveur",
		run: addServerWorkspacesTable,
	},
	{
		version: 2026041103,
		description: "Ajout de la priorité (matrice d'Eisenhower) sur les notes",
		run: addNotePriority,
	},
	{
		version: 2026041104,
		description: "Création de la table de l'historique des processus",
		run: addProcessesTable,
	},
	{
		version: 2026041105,
		description: "Ajout de la colonne result sur la table des processus",
		run: addProcessResultColumn,
	},
	{
		version: 2026041106,
		description: "Ajout de la colonne debug_log sur la table des processus",
		run: addProcessDebugLogColumn,
	},
	{
		version: 2026041201,
		description: "Création de la table des tags et migration des tags existants",
		// A second run after a stop between the tag rows and the notes' rewrite would make each tag twice
		versionFirst: true,
		run: addTagsTable,
	},
	{
		version: 2026041401,
		description: "Ajout de la colonne ntfy_token pour l'authentification NTFY",
		run: addNtfyTokenColumn,
	},
	{
		version: 2026041402,
		description: "Chiffrement AES-256-GCM des credentials existants",
		run: encryptExistingCredentials,
	},
	{
		version: 2026042601,
		description: "Table editable_repos pour les repos promus en mode édition",
		run: addEditableReposTable,
	},
	{
		version: 2026102201,
		description: "Table note_links : un record distant par note et par serveur",
		// A second run after a stop past the backfill would no longer see the global « pending » to convert
		versionFirst: true,
		run: addNoteLinksTable,
	},
	{
		version: 2026102202,
		description: "Tables sync_outbox et server_capabilities : file d'opérations et sondes par serveur",
		run: addSyncOutboxTable,
	},
	{
		version: 2026102203,
		description: "Tables remote_records_cache et sync_target_prefs : records en cache et cibles retenues par serveur",
		run: addSyncTargetTables,
	},
	{
		version: 2026102301,
		description: "Colonne note_links.params_json : record visé, type, échéance et assigné d'une activité",
		run: addNoteLinkParams,
	},
	{
		version: 2026102302,
		description: "Table activities_cache : activités du calendrier, gardées hors ligne",
		run: addActivitiesCacheTable,
	},
	{
		version: 2026102501,
		description: "Tables du clavardage",
		run: addChatTables,
	},
	{
		version: 2026102601,
		description: "Clavardage : colonnes de gestion des conversations",
		run: addChatLot2Columns,
	},
	{
		version: 2026102602,
		description: "Clavardage : création refusée et identifiants temporaires",
		run: addChatCreateFailed,
	},
	{
		version: 2026102603,
		description: "Clavardage : conversations quittées avec des messages non envoyés",
		run: addChatLeftUnsent,
	},
	{
		version: 2026102604,
		description: "Clavardage : pièces jointes et leur cache",
		run: addChatAttachments,
	},
	{
		version: 2026102605,
		description: "Clavardage : brouillons",
		run: addChatDrafts,
	},
	{
		version: 2026102606,
		description: "Clavardage : origine des fichiers du brouillon",
		run: addChatDraftOrigin,
	},
	{
		version: 2026102607,
		description: "Clavardage : réactions, réponses et destinataires des messages",
		run: addChatActions,
	},
	{
		version: 2026102608,
		description: "Clavardage : réponse, modification et mentions du brouillon",
		run: addChatDraftModes,
	},
	{
		version: 2026102701,
		description: "Clavardage : texte de recherche, épingle et favori des messages",
		run: addChatMessageSearch,
	},
	{
		version: 2026102702,
		description: "Clavardage : boîte de réception, historique et favoris",
		run: addChatMailbox,
	},
	{
		version: 2026102703,
		description: "Clavardage : conversations épinglées en haut de la liste",
		run: addChatOnTop,
	},
	{
		version: 2026102704,
		description: "Clavardage : fichiers et brouillons des réponses aux enregistrements",
		run: addChatRecordThreads,
	},
	{
		version: 2026102705,
		description: "Clavardage : nom et avatar des auteurs",
		run: addChatAvatars,
	},
];
