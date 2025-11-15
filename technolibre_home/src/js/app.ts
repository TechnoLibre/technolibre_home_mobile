import { RootComponent } from "../components/root/root_component";
import { EventBus, mount } from "@odoo/owl";
import { SimpleRouter } from "./router";
import { AppService } from "../services/appService";
import { IntentService } from "../services/intentService";
import { NoteService } from "../services/noteService";
import { Events } from "../constants/events";
import { SendIntent } from "@supernotes/capacitor-send-intent";

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

const router = new SimpleRouter();

const appService = new AppService();
const noteService = new NoteService();
const intentService = new IntentService(eventBus);

const env = { eventBus, router, appService, noteService, intentService };

mount(RootComponent, document.body, { env });
