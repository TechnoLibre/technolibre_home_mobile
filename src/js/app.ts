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

async function startApp() {
	const router = new SimpleRouter();

	const db = new DatabaseService();
	await db.initialize();
	await runMigrations(db, [
		{
			version: 20260318,
			description: "Migration de SecureStorage vers SQLite",
			run: migrateFromSecureStorage,
		},
	]);

	const appService = new AppService(db);
	const noteService = new NoteService(eventBus, db);
	const intentService = new IntentService(eventBus);

	const env = { eventBus, router, appService, noteService, intentService, databaseService: db };

	await mount(RootComponent, document.body, { env });
}

startApp().catch((error) => {
	console.error("Failed to start app:", error);
});