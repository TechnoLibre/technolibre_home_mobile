import { Component, EventBus } from "@odoo/owl";
import { SimpleRouter } from "./router";
import { AppService } from "../services/appService";
import { NoteService } from "../services/note/noteService";
import { IntentService } from "../services/intentService";

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

	public get intentService(): IntentService {
		return this.env.intentService;
	}

	public get noteService(): NoteService {
		return this.env.noteService;
	}
}
