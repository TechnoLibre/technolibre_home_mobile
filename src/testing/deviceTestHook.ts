/**
 * window.__erplibreTest: what ERPLibre's device tests
 * (long_test/mobile_sync_device.py) call through the WebView's devtools to
 * set the app up and read it back; the screens themselves are driven by
 * touches. app.ts installs it in a development build only (vite --mode
 * development): a production build has neither the object nor this module.
 *
 * DEVICE_HOOK_API changes when one of these functions changes in a way a
 * caller must follow; the ERPLibre runner refuses an API it does not know.
 */
import type { EventBus } from "@odoo/owl";
import { Events } from "../constants/events";
import type { Note } from "../models/note";
import { syncConfigIdFor } from "../models/syncConfig";
import type { AppService } from "../services/appService";
import type { DatabaseService } from "../services/databaseService";
import type { NoteService } from "../services/note/noteService";
import type { NotificationService } from "../services/notificationService";
import { SyncService } from "../services/syncService";

export const DEVICE_HOOK_API = 2;

/** The services of app.ts the hook uses. */
export interface DeviceHookEnv {
	eventBus: EventBus;
	appService: AppService;
	noteService: NoteService;
	databaseService: DatabaseService;
	syncService: SyncService;
	notificationService: NotificationService;
}

/** One Odoo server as a device test gives it. */
export interface DeviceTarget {
	url: string;
	username: string;
	password: string;
	database: string;
}

async function chatSourceOf(env: DeviceHookEnv, configId: string) {
	const src = (await env.syncService.chat.sources()).find((s) => s.configId === configId);
	if (!src) throw new Error(`No chat source for ${configId}`);
	return src;
}

export function deviceTestHook(env: DeviceHookEnv) {
	return {
		api: DEVICE_HOOK_API,
		/**
		 * Adds the application of target, without automatic sync (the test
		 * syncs when it means to), http allowed; returns its sync config id.
		 */
		async addApplication(target: DeviceTarget): Promise<string> {
			localStorage.setItem("options.sync.allowHttp", "true");
			await env.appService.add({
				...target, odooVersion: "", autoSync: false, pollIntervalMinutes: 5, ntfyUrl: "", ntfyTopic: "", ntfyToken: "",
			});
			await env.notificationService.reload();
			return syncConfigIdFor(target.url, target.username, target.database);
		},
		async addNote(note: Note): Promise<void> {
			await env.noteService.crud.add(note);
		},
		/** Shows the screen of url, as a tap on a link does ("/note/<id>"). */
		open(url: string): void {
			env.eventBus.trigger(Events.ROUTER_NAVIGATION, { url });
		},
		/** Sends the note as a task of projectId (null: personal) to the server of configId, as a tap would. */
		async sendAsTask(noteId: string, configId: string, projectId: number | null): Promise<void> {
			const app = (await env.appService.getApps())
				.find((a) => syncConfigIdFor(a.url, a.username, a.database) === configId);
			if (!app) throw new Error(`No application for ${configId}`);
			await env.syncService.setTarget(noteId, configId, "task", { projectId });
			await env.syncService.pushNote(SyncService.credentialsFrom(app, app.database), noteId, { userInitiated: true });
		},
		/** syncAll on every application, in turn: their errors, by sync config id. */
		async syncAll(): Promise<Record<string, string[]>> {
			const errors: Record<string, string[]> = {};
			for (const app of await env.appService.getApps()) {
				const creds = SyncService.credentialsFrom(app, app.database);
				errors[syncConfigIdFor(app.url, app.username, app.database)] = (await env.syncService.syncAll(creds)).errors;
			}
			return errors;
		},
		/** The chat sources (Odoo 18 applications): their config id and label. */
		async chatSources(): Promise<{ configId: string; label: string }[]> {
			return (await env.syncService.chat.sources()).map(({ configId, label }) => ({ configId, label }));
		},
		/** Fills the chat cache of configId from the server (conversations and their latest messages). */
		async chatLoad(configId: string): Promise<void> {
			await env.syncService.chat.load(await chatSourceOf(env, configId));
		},
		/** Posts text in the channel as the composer does; returns the pending message's clientUuid. */
		async chatSend(configId: string, channelId: number, text: string): Promise<string> {
			const message = await env.syncService.chat.send(await chatSourceOf(env, configId), channelId, text);
			return message.clientUuid as string;
		},
		/** The cached messages of the channel, oldest first. */
		chatMessages(configId: string, channelId: number) {
			return env.syncService.chat.messages(configId, channelId);
		},
		note(id: string) {
			return env.databaseService.getNoteById(id);
		},
		links(noteId: string) {
			return env.databaseService.getNoteLinks(noteId);
		},
	};
}
