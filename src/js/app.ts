import { RootComponent } from "../components/root/root_component";
import { EventBus, mount } from "@odoo/owl";
import { SplashScreen } from "@capacitor/splash-screen";
import { SimpleRouter } from "./router";
import { AppService } from "../services/appService";
import { IntentService } from "../services/intentService";
import { NoteService } from "../services/note/noteService";
import { DatabaseService } from "../services/databaseService";
import { runMigrations } from "../services/migrationService";
import { migrateFromSecureStorage } from "../services/dataMigration";
import { migrateVideoThumbnails } from "../services/migrations/migrateVideoThumbnails";
import { addSyncColumns } from "../services/migrations/addSyncColumns";
import { addSyncConfigId } from "../services/migrations/addSyncConfigId";
import { addReminderCreatedAt } from "../services/migrations/addReminderCreatedAt";
import { addApplicationSyncFields } from "../services/migrations/addApplicationSyncFields";
import { addUserGraphicPrefs } from "../services/migrations/addUserGraphicPrefs";
import { addSelectedSyncConfigIds } from "../services/migrations/addSelectedSyncConfigIds";
import { addOdooVersionToApplications } from "../services/migrations/addOdooVersionToApplications";
import { addSyncPerServerStatus } from "../services/migrations/addSyncPerServerStatus";
import { addServersTable } from "../services/migrations/addServersTable";
import { addServerWorkspacesTable } from "../services/migrations/addServerWorkspacesTable";
import { addNotePriority } from "../services/migrations/addNotePriority";
import { addProcessesTable } from "../services/migrations/addProcessesTable";
import { addProcessResultColumn } from "../services/migrations/addProcessResultColumn";
import { addProcessDebugLogColumn } from "../services/migrations/addProcessDebugLogColumn";
import { addTagsTable } from "../services/migrations/addTagsTable";
import { TagService } from "../services/tagService";
import { ServerService } from "../services/serverService";
import { DeploymentService } from "../services/deploymentService";
import { TranscriptionService } from "../services/transcriptionService";
import { ProcessService } from "../services/processService";
import { DEFAULT_GRAPHIC_PREFS, FONT_SIZE_STEPS, applyGraphicPrefs } from "../models/graphicPrefs";
import type { FontFamily, ColorTheme } from "../models/graphicPrefs";
import { SyncService } from "../services/syncService";
import { NotificationService } from "../services/notificationService";
import { ReminderService } from "../services/reminderService";
import { BiometryUtils } from "../utils/biometryUtils";
import { Events } from "../constants/events";

const eventBus = new EventBus();

eventBus.addEventListener(Events.ROUTER_NAVIGATION, (event: any) => {
	window.history.pushState({}, "", event?.detail?.url);
});

eventBus.addEventListener(Events.OPEN_CAMERA, (_event: any) => {
	document.body.classList.add("transparent");
});

eventBus.addEventListener(Events.CLOSE_CAMERA, (_event: any) => {
	document.body.classList.remove("transparent");
});

function setBootStep(msg: string) {
	console.log(`[boot] ${msg}`);
	const el = document.getElementById("boot-step");
	if (el) el.textContent = msg;
}

function hideBootScreen() {
	const el = document.getElementById("boot-screen");
	if (el) el.remove();
}

async function startApp() {
	await SplashScreen.hide();

	const router = new SimpleRouter();

	setBootStep("Vérification biométrique…");
	const authenticated = await BiometryUtils.authenticateForDatabase();
	if (!authenticated) {
		setBootStep("Authentification biométrique échouée. Relancez l'application.");
		return;
	}

	setBootStep("Lecture clé de chiffrement…");
	const db = new DatabaseService();

	await db.initialize(setBootStep);

	setBootStep("Vérification migrations…");
	await runMigrations(db, [
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
			run: addTagsTable,
		},
	]);

	setBootStep("Chargement des préférences graphiques…");
	{
		const fontFamily = await db.getUserGraphicPref("font_family") as FontFamily | null;
		const fontSizeScale = await db.getUserGraphicPref("font_size_scale");
		const colorTheme = await db.getUserGraphicPref("color_theme") as ColorTheme | null;
		const reduceMotionRaw = await db.getUserGraphicPref("reduce_motion");
		applyGraphicPrefs({
			fontFamily: fontFamily ?? DEFAULT_GRAPHIC_PREFS.fontFamily,
			fontSizeScale: fontSizeScale ? parseFloat(fontSizeScale) : DEFAULT_GRAPHIC_PREFS.fontSizeScale,
			colorTheme: colorTheme ?? DEFAULT_GRAPHIC_PREFS.colorTheme,
			reduceMotion: reduceMotionRaw === "true",
		});
	}

	setBootStep("Initialisation des services…");
	const appService = new AppService(db);
	const tagService = new TagService(db);
	const noteService = new NoteService(eventBus, db);
	const intentService = new IntentService(eventBus);
	const syncService = new SyncService(db);
	const reminderService = new ReminderService(db);
	const notificationService = new NotificationService(syncService, appService, eventBus);
	const serverService = new ServerService(db);
	const deploymentService = new DeploymentService(serverService);
	const processService = new ProcessService(db);
	await processService.initialize();
	const transcriptionService = new TranscriptionService(db, processService);
	notificationService.start();

	// Re-schedule any reminders whose notification batch is expiring
	reminderService.rebatchExpiring().catch((e) =>
		console.warn("[boot] rebatchExpiring failed:", e)
	);

	const env = { eventBus, router, appService, tagService, noteService, intentService, databaseService: db, syncService, notificationService, serverService, deploymentService, transcriptionService, processService };

	setBootStep("Montage de l'interface…");
	await mount(RootComponent, document.body, { env });
	hideBootScreen();
}

startApp().catch((error) => {
	console.error("Failed to start app:", error);
	setBootStep(`Erreur : ${error?.message ?? error}`);
});