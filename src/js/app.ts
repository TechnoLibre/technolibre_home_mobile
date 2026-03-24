import { RootComponent } from "../components/root/root_component";
import { EventBus, mount } from "@odoo/owl";
import { SimpleRouter } from "./router";
import { AppService } from "../services/appService";
import { IntentService } from "../services/intentService";
import { NoteService } from "../services/note/noteService";
import { DatabaseService } from "../services/databaseService";
import { runMigrations } from "../services/migrationService";
import { migrateFromSecureStorage } from "../services/dataMigration";
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
	const router = new SimpleRouter();

	setBootStep("Lecture clé de chiffrement…");
	const db = new DatabaseService();

	await db.initialize(setBootStep);

	setBootStep("Vérification migrations…");
	await runMigrations(db, [
		{
			version: 20260318,
			description: "Migration de SecureStorage vers SQLite",
			run: migrateFromSecureStorage,
		},
	]);

	setBootStep("Initialisation des services…");
	const appService = new AppService(db);
	const noteService = new NoteService(eventBus, db);
	const intentService = new IntentService(eventBus);

	const env = { eventBus, router, appService, noteService, intentService, databaseService: db };

	setBootStep("Montage de l'interface…");
	await mount(RootComponent, document.body, { env });
	hideBootScreen();
}

startApp().catch((error) => {
	console.error("Failed to start app:", error);
	setBootStep(`Erreur : ${error?.message ?? error}`);
});