import { Component, EventBus } from "@odoo/owl";
import { t } from "../i18n";
import { SimpleRouter } from "./router";
import { AppService } from "../services/appService";
import { NoteService } from "../services/note/noteService";
import { IntentService } from "../services/intentService";
import { DatabaseService } from "../services/databaseService";
import { SyncService } from "../services/syncService";
import { NotificationService } from "../services/notificationService";
import { ServerService } from "../services/serverService";
import { DeploymentService } from "../services/deploymentService";
import { TranscriptionService } from "../services/transcriptionService";
import { TranslationService } from "../services/translationService";
import { ProcessService } from "../services/processService";
import { TagService } from "../services/tagService";
import { Events } from "../constants/events";

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

	public get databaseService(): DatabaseService {
		return this.env.databaseService;
	}

	public get syncService(): SyncService {
		return this.env.syncService;
	}

	public get notificationService(): NotificationService {
		return this.env.notificationService;
	}

	public get serverService(): ServerService {
		return this.env.serverService;
	}

	public get deploymentService(): DeploymentService {
		return this.env.deploymentService;
	}

	public get transcriptionService(): TranscriptionService {
		return this.env.transcriptionService;
	}

	public get translationService(): TranslationService {
		return this.env.translationService;
	}

	public get processService(): ProcessService {
		return this.env.processService;
	}

	public get tagService(): TagService {
		return this.env.tagService;
	}

	/** Translation function — call as `t("key")` in templates and code. */
	public readonly t = t;

	public navigate(url: string): void {
		this.eventBus.dispatchEvent(
			new CustomEvent(Events.ROUTER_NAVIGATION, { detail: { url } })
		);
	}
}
