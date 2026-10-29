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
import { Capacitor } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { Events } from "../constants/events";
import type { Note } from "../models/note";
import { syncConfigIdFor } from "../models/syncConfig";
import type { AppService } from "../services/appService";
import type { DatabaseService } from "../services/databaseService";
import type { NoteService } from "../services/note/noteService";
import type { NotificationService } from "../services/notificationService";
import { SyncService } from "../services/syncService";
import { ChatCapture } from "../services/chat/chatCapture";
import {
	messageKeyOf, type ChatAttachment, type ChatPushRow, type LockScreen, type ChatMailboxItem, type ChatMessage, type ChatReaction, type MessageTarget,
	type OutgoingFile,
} from "../models/chat";
import { EMPTY_MENTIONS, type Mentions } from "../services/chat/chatCompose";
import type { SearchResults, ServerResults } from "../services/chat/chatSearch";
import type { ChatSource } from "../services/chat/chatSources";
import { parseNtfyLink } from "../services/chat/chatPushLink";
import type { NotifyLevel } from "../services/chat/chatSettings";
import type { ChatPushNative, NativeAction, PushHealth } from "../plugins/chatPushPlugin";
import type { DrainResult } from "../services/chat/chatPushActions";

export const DEVICE_HOOK_API = 8;

/** The stage limit the composer takes while the server's is unknown: Odoo's default. */
const DEFAULT_STAGE_LIMIT = 128 * 1024 * 1024;

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

/** A message the server holds, as an action names it. */
function sent(messageId: number): MessageTarget {
	return { messageId, clientUuid: null };
}

async function chatSourceOf(env: DeviceHookEnv, configId: string) {
	const src = (await env.syncService.chat.sources()).find((s) => s.configId === configId);
	if (!src) throw new Error(`No chat source for ${configId}`);
	return src;
}

/** The native side of the chat notifications; throws off a native build. */
function pushNativeOf(env: DeviceHookEnv): ChatPushNative {
	const native = env.syncService.chat.push.native;
	if (!native) throw new Error("No native chat push in this build");
	return native;
}

/** The cached mailbox row of a message (inbox, history or starred); throws when the phone holds none. */
async function mailboxItemOf(env: DeviceHookEnv, configId: string, messageId: number): Promise<ChatMailboxItem> {
	const item = await env.syncService.chat.repo.mailboxItem(configId, messageId);
	if (!item) throw new Error(`No mailbox item ${messageId} for ${configId}`);
	return item;
}

/**
 * The file at path (relative to Directory.Data, put there by the test)
 * as the composer stages it once the picker answered: read as the web
 * view's File, staged by ChatCapture.stage under the account's directory
 * against the server's limit. A file over the limit throws.
 */
async function stagedFile(env: DeviceHookEnv, src: ChatSource, path: string, name: string, mimetype: string): Promise<OutgoingFile> {
	const chat = env.syncService.chat;
	const { uri } = await Filesystem.getUri({ path, directory: Directory.Data });
	const blob = await (await fetch(Capacitor.convertFileSrc(uri))).blob();
	const file = new File([blob], name, { type: mimetype });
	const limit = (await chat.uploadLimit(src)) ?? DEFAULT_STAGE_LIMIT;
	const staged = await new ChatCapture().stage(await chat.fileDirOf(src.configId), file, { maxUploadSize: limit });
	if ("refused" in staged) throw new Error(`${name} refused: over the ${staged.limit}-byte limit`);
	return staged;
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
		/**
		 * Posts text in the channel as the composer does, with the people and
		 * channels picked (mentions) and as a reply to the message replyTo
		 * (a server id) when given; returns the pending message's clientUuid.
		 */
		async chatSend(
			configId: string,
			channelId: number,
			text: string,
			opts: { replyTo?: number; mentions?: Mentions } = {},
		): Promise<string> {
			const message = await env.syncService.chat.send(await chatSourceOf(env, configId), channelId, text, [], {
				mentions: opts.mentions ?? EMPTY_MENTIONS,
				replyTo: opts.replyTo != null ? sent(opts.replyTo) : null,
			});
			return message.clientUuid as string;
		},
		/** Turns the user's own reaction content on the message messageId on (on) or off, as a tap does. */
		async chatReact(configId: string, channelId: number, messageId: number, content: string, on: boolean): Promise<void> {
			await env.syncService.chat.react(await chatSourceOf(env, configId), channelId, sent(messageId), content, on);
		},
		/** Edits the user's own message messageId to text, the picks of its current body kept (editDraftOf). */
		async chatEdit(configId: string, channelId: number, messageId: number, text: string): Promise<void> {
			const chat = env.syncService.chat;
			const draft = await chat.editDraftOf(configId, channelId, sent(messageId));
			await chat.editMessage(await chatSourceOf(env, configId), channelId, sent(messageId), text, draft?.mentions ?? EMPTY_MENTIONS);
		},
		/** Deletes the user's own message messageId, as the menu's Delete once confirmed. */
		async chatDelete(configId: string, channelId: number, messageId: number): Promise<void> {
			await env.syncService.chat.deleteMessage(await chatSourceOf(env, configId), channelId, sent(messageId));
		},
		/** The cached reaction groups of the channel's cached messages, by message key (m<id>, u<uuid>). */
		async chatReactions(configId: string, channelId: number): Promise<Record<string, ChatReaction[]>> {
			const chat = env.syncService.chat;
			const keys = (await chat.messages(configId, channelId)).map(messageKeyOf);
			return Object.fromEntries(await chat.reactions(configId, channelId, keys));
		},
		/**
		 * Creates a group with these people (self added by Odoo) as the new
		 * conversation screen does; returns its id, the server's once the
		 * create settled (online), else the temporary one.
		 */
		async chatNewGroup(configId: string, partnerIds: number[], name = ""): Promise<number> {
			return (await env.syncService.chat.createGroup(await chatSourceOf(env, configId), partnerIds, name)).channelId;
		},
		/** Shows the information screen of the conversation (members, name, mute, leave). */
		chatOpenInfo(configId: string, channelId: number): void {
			env.eventBus.trigger(Events.ROUTER_NAVIGATION, { url: `/chat/${encodeURIComponent(configId)}/${channelId}/info` });
		},
		/** The cached messages of the channel, oldest first. */
		chatMessages(configId: string, channelId: number) {
			return env.syncService.chat.messages(configId, channelId);
		},
		/**
		 * Sends the file at path (relative to Directory.Data, put there by
		 * the test) as the composer does once the picker answered: read as
		 * the web view's File, staged by ChatCapture.stage against the
		 * server's limit, then sent alone through ChatService.send. Returns
		 * the pending message's clientUuid; a file over the limit throws.
		 */
		async chatSendFile(configId: string, channelId: number, path: string, name: string, mimetype: string): Promise<string> {
			const src = await chatSourceOf(env, configId);
			const staged = await stagedFile(env, src, path, name, mimetype);
			const message = await env.syncService.chat.send(src, channelId, "", [staged]);
			return message.clientUuid as string;
		},
		/** The attachment rows of the channel's cached messages and queued posts, oldest message first. */
		async chatAttachments(configId: string, channelId: number): Promise<ChatAttachment[]> {
			const chat = env.syncService.chat;
			const messages = await chat.messages(configId, channelId);
			const ids = messages.map((m) => m.messageId).filter((id): id is number => typeof id === "number");
			const uuids = messages.map((m) => m.clientUuid).filter((u): u is string => !!u);
			const groups = await chat.repo.attachmentsOf(configId, channelId, ids, uuids);
			return messages.flatMap((m) =>
				[...(groups.get(`m${m.messageId}`) ?? []), ...(m.clientUuid ? groups.get(`u${m.clientUuid}`) ?? [] : [])]);
		},
		/** Bytes the chat's files take on the phone: the account's, or every account's. */
		chatSpace(configId?: string): Promise<number> {
			return env.syncService.chat.attachments.space(configId);
		},
		/**
		 * The phone's answer to a term over every chat source, as the
		 * list's search shows it before the servers answer
		 * (ChatSearch.local: cache only, nothing marked read).
		 */
		async chatSearch(term: string): Promise<SearchResults> {
			const chat = env.syncService.chat;
			return chat.search.local((await chat.sources()).map((s) => s.configId), term);
		},
		/** The first page of the server's matches for a term on configId (ChatSearch.server: nothing marked read). */
		async chatSearchServer(configId: string, term: string): Promise<ServerResults> {
			return env.syncService.chat.search.server(await chatSourceOf(env, configId), term);
		},
		/** Shows the conversation opened at the message, as a tap on a search hit does (`?m=<id>`). */
		chatOpenAt(configId: string, channelId: number, messageId: number): void {
			env.eventBus.trigger(Events.ROUTER_NAVIGATION, {
				url: `/chat/${encodeURIComponent(configId)}/${channelId}?m=${messageId}`,
			});
		},
		/** How message search runs on the phone's database: "fts5" (the FTS5 trigram index) or "like". */
		chatSearchEngine(): Promise<"fts5" | "like"> {
			return env.databaseService.chatSearchEngine();
		},
		/**
		 * SQLite's integrity check of the FTS5 search index (an
		 * `integrity-check` command, which raises when the index and
		 * chat_messages disagree): "ok", the error's message, or "like"
		 * when the database has no index to check.
		 */
		async chatSearchIntegrity(): Promise<string> {
			if ((await env.databaseService.chatSearchEngine()) !== "fts5") return "like";
			try {
				await env.databaseService.rawRun("INSERT INTO chat_search_fts(chat_search_fts) VALUES ('integrity-check')");
				return "ok";
			} catch (e) {
				return e instanceof Error ? e.message : String(e);
			}
		},
		/** Pins the sent message messageId in its channel (on) or unpins it, as the menu's Épingler once confirmed. */
		async chatPin(configId: string, channelId: number, messageId: number, on: boolean): Promise<void> {
			await env.syncService.chat.pin(await chatSourceOf(env, configId), channelId, sent(messageId), on);
		},
		/** The channel's pinned messages as « Messages épinglés » lists them (the server's list read first when online). */
		async chatPinned(configId: string, channelId: number): Promise<{ messages: ChatMessage[]; offline: boolean }> {
			return env.syncService.chat.pinnedMessages(await chatSourceOf(env, configId), channelId);
		},
		/** Stars the message messageId (on) or unstars it, as the menu's Favori; its conversation from the cache, if any. */
		async chatStar(configId: string, messageId: number, on: boolean): Promise<void> {
			const chat = env.syncService.chat;
			const cached = await chat.repo.message(configId, messageId);
			await chat.star(await chatSourceOf(env, configId), messageId, on, cached?.channelId ?? null);
		},
		/** The starred messages of configId as the starred box shows them, its first page read from the server first. */
		async chatStarred(configId: string): Promise<ChatMailboxItem[]> {
			const chat = env.syncService.chat;
			await chat.refreshStarred(await chatSourceOf(env, configId));
			return chat.starred([configId]);
		},
		/** The inbox items of configId as the inbox tab shows them, its first page read from the server first. */
		async chatInbox(configId: string): Promise<ChatMailboxItem[]> {
			const chat = env.syncService.chat;
			await chat.inbox.refresh(await chatSourceOf(env, configId), "inbox");
			return chat.inbox.items([configId], "inbox");
		},
		/** Marks the inbox item messageId read, as its « Marquer comme lu ». */
		async chatMarkDone(configId: string, messageId: number): Promise<void> {
			await env.syncService.chat.markDone(await chatSourceOf(env, configId), [messageId]);
		},
		/**
		 * Replies to the inbox item messageId in its record's chatter, as the
		 * reply composer's ➤: an internal note unless note is false, with the
		 * file at path (relative to Directory.Data, staged as chatSendFile
		 * stages it) when given. Returns the reply's client uuid.
		 */
		async chatReplyOnRecord(
			configId: string,
			messageId: number,
			text: string,
			opts: { note?: boolean; path?: string; name?: string; mimetype?: string } = {},
		): Promise<string> {
			const src = await chatSourceOf(env, configId);
			const item = await mailboxItemOf(env, configId, messageId);
			const files = opts.path
				? [await stagedFile(env, src, opts.path, opts.name ?? opts.path.split("/").pop()!, opts.mimetype ?? "")]
				: [];
			const op = await env.syncService.chat.replyOnRecord(src, item, text, EMPTY_MENTIONS, files, opts.note ?? true);
			return op.clientUuid;
		},
		/**
		 * Keeps the file at path (relative to Directory.Data) as a draft file
		 * of the reply composer of the inbox item messageId, as a pick does
		 * once the picker answered: the composer opened on that record shows
		 * it as a chip, and its ➤ sends it.
		 */
		async chatRecordDraftFile(configId: string, messageId: number, path: string, name: string, mimetype: string): Promise<void> {
			const chat = env.syncService.chat;
			const src = await chatSourceOf(env, configId);
			const item = await mailboxItemOf(env, configId, messageId);
			const staged = await stagedFile(env, src, path, name, mimetype);
			const thread = { model: item.threadModel, resId: item.threadId, recordName: item.recordName };
			await chat.keepRecordDraftFile(configId, thread, staged, 0, null);
		},
		/** The user's Odoo notification type of configId as the phone last read it: "email", "inbox", or null unknown. */
		async chatNotificationType(configId: string): Promise<"email" | "inbox" | null> {
			return (await env.syncService.chat.repo.sourceState(configId)).notificationType;
		},
		/**
		 * Applies the setup link (the text the QR carries) to the account,
		 * as the notification settings do once it is pasted
		 * (ChatPush.applyLink); a link that does not parse answers
		 * reason "invalid_link" and changes nothing.
		 */
		async chatPushApply(configId: string, link: string): Promise<{ ok: boolean; reason: string | null; registered: string[] }> {
			const parsed = parseNtfyLink(link);
			if (!parsed) return { ok: false, reason: "invalid_link", registered: [] };
			return env.syncService.chat.push.applyLink([configId], parsed);
		},
		/** Sets the notification level (1 realtime to 5 off), as the settings' choice. */
		chatPushLevel(level: NotifyLevel): Promise<void> {
			return env.syncService.chat.push.setLevel(level);
		},
		/** What the account's notifications show on the lock screen, as the settings' choice. */
		chatPushLockScreen(configId: string, mode: LockScreen): Promise<void> {
			return env.syncService.chat.push.setLockScreen(configId, mode);
		},
		/** Takes the account off its ntfy, as the settings' « Retirer ». */
		chatPushRemove(configId: string): Promise<void> {
			return env.syncService.chat.push.removeNtfy(configId);
		},
		/** The native engine's health, as the status panel reads it. */
		chatPushStatus(): Promise<PushHealth> {
			return pushNativeOf(env).status();
		},
		/** One run of the periodic job now (ntfy poll, Odoo-direct summary); resolves once it is done. */
		chatPushCheckNow(): Promise<void> {
			return pushNativeOf(env).checkNow();
		},
		/** The notification actions native code ended or hands over, not drained yet (ChatPushPlugin.actions). */
		chatPushActions(): Promise<NativeAction[]> {
			return pushNativeOf(env).actions();
		},
		/** One drain of the native actions into the cache and the outbox, as a start or resume runs it. */
		chatPushDrain(): Promise<DrainResult> {
			return env.syncService.chat.pushActions.drain();
		},
		/**
		 * Replaces native code's copy of the account's session by the session
		 * id « invalide », which Odoo does not know: the next native action
		 * finds the session dead. The app's own session is left as it is.
		 * The push work already queued (a copy of the real session after a
		 * load) settles first, so it does not write over the broken copy;
		 * a later foreground session copies the real one again.
		 */
		async chatPushBreakSession(configId: string): Promise<void> {
			const { creds } = await chatSourceOf(env, configId);
			await env.syncService.chat.push.idle();
			await pushNativeOf(env).mirrorSession({ configId, odooUrl: creds.odooUrl, database: creds.database, sessionId: "invalide" });
		},
		/** The account's chat_push row (ntfy, topic, endpoint, lock screen), null when it has none. */
		async chatPushRow(configId: string): Promise<ChatPushRow | null> {
			return (await env.syncService.chat.repo.pushRows()).find((r) => r.configId === configId) ?? null;
		},
		note(id: string) {
			return env.databaseService.getNoteById(id);
		},
		links(noteId: string) {
			return env.databaseService.getNoteLinks(noteId);
		},
	};
}
