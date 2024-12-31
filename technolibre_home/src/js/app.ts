import { RootComponent } from "../components/root/root_component";
import { EventBus, mount } from "@odoo/owl";
import { Constants } from "./constants";
import { SimpleRouter } from "./router";
import { AppService } from "./appService";

const eventBus = new EventBus();

eventBus.addEventListener(Constants.ROUTER_NAVIGATION_EVENT_NAME, (event: any) => {
	window.history.pushState({}, "", event?.detail?.url);
});

const router = new SimpleRouter();

const appService = new AppService();

const env = { eventBus, router, appService };

mount(RootComponent, document.body, { env });
