import { RootComponent } from "../components/root/root_component";
import { EventBus, mount } from "@odoo/owl";
import { SimpleRouter } from "./router";
import { AppService } from "../services/appService";
import { IntentService } from "../services/intentService";
import { NoteService } from "../services/note/noteService";
import { DatabaseService } from "../services/databaseService";
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
	const appService = new AppService();

	const db = new DatabaseService();
	await db.initialize();
	await migrateFromSecureStorage(db);

	const noteService = new NoteService(eventBus, db);
	const intentService = new IntentService(eventBus);

	const env = { eventBus, router, appService, noteService, intentService };

	await mount(RootComponent, document.body, { env });
}

startApp().catch((error) => {
	console.error("Failed to start app:", error);
});