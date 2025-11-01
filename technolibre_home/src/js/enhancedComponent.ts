import { Component, EventBus } from "@odoo/owl";
import { SimpleRouter } from "./router";
import { AppService } from "../services/appService";
import { NoteService } from "../services/noteService";

export abstract class EnhancedComponent extends Component {
	public state: any = undefined;

	public get router(): SimpleRouter {
		return this.env.router;
	}

	public get eventBus(): EventBus {
		return this.env.eventBus;
	}

	public get appService(): AppService {
		return this.env.appService;
	}

	public get noteService(): NoteService {
		return this.env.noteService;
	}
}
