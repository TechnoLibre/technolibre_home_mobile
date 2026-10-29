/**
 * The app's sync code, set up as a test drives it: the entry point of the
 * integration tests that run this code against real Odoo servers (they live
 * in ERPLibre, long_test/mobile_sync/, and import nothing else of the app).
 * It runs under Vitest with the mocks of vitest.config.ts: SQLite in memory,
 * secure storage in a Map, the network as __setNetworkStatus sets it.
 *
 * HARNESS_API changes when one of these exports changes in a way a caller
 * must follow; the ERPLibre runner refuses an API it does not know.
 */
import { EventBus } from "@odoo/owl";
import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";
import * as network from "@capacitor/network";
import { DatabaseService } from "../services/databaseService";
import { APP_MIGRATIONS } from "../services/migrations";
import { NoteService } from "../services/note/noteService";
import { SyncService, syncConfigIdOf } from "../services/syncService";
import type { SyncCredentials } from "../services/syncService";
import type { ChatService } from "../services/chat/chatService";
import { displayNameOf } from "../services/chat/chatNames";
import type { BusTransport } from "../services/chat/chatBus";
import type { AttachmentIO } from "../services/attachmentService";
import type { OutgoingFile } from "../models/chat";
import { ChatCapture, type StageRefusal } from "../services/chat/chatCapture";
import type { ChatHttp, HttpAnswer, TransferProgress } from "../services/chat/chatFiles";
import { outgoingPath } from "../services/chat/chatFiles";
import { encodeMp3, voiceName } from "../services/chat/chatMp3";
import type { ChatSource } from "../services/chat/chatSources";
import { CHAT_FILE_CANCELLED, CHAT_FILE_UNSENT, transportError } from "../plugins/chatFilePlugin";
import { memoryChatFiles, type MemoryChatFiles } from "./chatFakes";
import { composeBody, EMPTY_MENTIONS, type Mentions } from "../services/chat/chatCompose";
import { bodyText, foldText, isEmptyMessage } from "../services/chat/chatBody";
import { emojiConversions } from "../services/chat/chatEmoji";
import { mailboxKindOf, type ChatMailboxItem, type MessageTarget } from "../models/chat";
import { htmlTerm, type SearchResults } from "../services/chat/chatSearch";
import { noteForRecord } from "../services/chat/chatInbox";
import type { ChatPush } from "../services/chat/chatPush";
import type { ChatPushActions } from "../services/chat/chatPushActions";
import { chatMarker } from "../services/chat/chatBody";
import { parseNtfyLink, type NtfyLink } from "../services/chat/chatPushLink";
import { decryptWebPush } from "./webPushNode";
import { pollNtfy, pushNodeNative, type NodeSubscription, type NtfyMessage, type PushNodeNative } from "./pushNodeNative";

export { memoryChatFiles };
export type { MemoryChatFiles };
/**
 * The body rules of the chat, for a test to build what a browser sends and
 * to read what the server stores as the app reads it: composeBody (the
 * browser composer's HTML for a text, with emojiConversions), bodyText (the
 * text a browser edit starts from), isEmptyMessage (a message the thread
 * hides, and quotes as deleted).
 */
export { composeBody, EMPTY_MENTIONS, bodyText, isEmptyMessage, emojiConversions };
export type { Mentions, MessageTarget };
/**
 * The finding rules of the chat, for a test to say what the app should
 * find and where it opens: foldText (the text local search compares,
 * case and accents folded), htmlTerm (a term as the server search
 * matches a stored body), mailboxKindOf (an inbox item's kind: mention,
 * record, assignment), noteForRecord (the note an inbox item opens).
 */
export { foldText, htmlTerm, mailboxKindOf, noteForRecord };
export type { ChatMailboxItem, SearchResults };

/**
 * The closed-app chat notifications, for a test to run them against a real
 * ntfy: parseNtfyLink (the setup link the operator's tool prints),
 * pushNodeNative (the phone's native side in Node, its keys at hand),
 * pollNtfy (what a topic holds) and decryptWebPush (a pushed body back to
 * Odoo's JSON), chatMarker (the marker the app and native code end a
 * post with, which their resend searches).
 */
export { parseNtfyLink, decryptWebPush, pollNtfy, pushNodeNative, chatMarker };
export type { NtfyLink, NodeSubscription, NtfyMessage, PushNodeNative };

export const HARNESS_API = 7;

/** Migrations that read what an older install left (secure storage, video files): none on a new database. */
const SKIPPED_MIGRATIONS = new Set([2026031801, 2026032401]);

/** One Odoo server as the app knows it: its application's url, login, password and database. */
export interface SyncTarget {
	url: string;
	username: string;
	password: string;
	database: string;
}

export interface SyncEnv {
	db: DatabaseService;
	sync: SyncService;
	notes: NoteService;
	/** The chat service of sync: it shares sync's rpc client and outbox. */
	chat: ChatService;
	/** Per target, in the order given: its credentials and its sync config id. */
	creds: SyncCredentials[];
	configIds: string[];
	/** The chat's files (Directory.Data in memory), which nodeChatHttp uploads from and downloads into. */
	chatFiles: MemoryChatFiles;
	/** The chat's closed-app notifications (chat.push), over pushNative. */
	push: ChatPush;
	/** The phone's native side of the notifications, in Node; it outlives restartSyncEnv as native code outlives the app. */
	pushNative: PushNodeNative;
	/** The drain of the native actions (chat.pushActions), over pushNative's action store. */
	pushActions: ChatPushActions;
}

/**
 * A new app database, migrated as the app migrates it, with one application
 * per target, and the sync service over it. Nothing is read from a server
 * until a sync runs. chatModule "ignore" makes chat posts take the marker
 * path and uploads Odoo's own route even where the server module is
 * installed. The chat's files live in chatFiles (new and empty when not
 * given) and cross the network through nodeChatHttp over them. The chat's
 * notifications run over a new pushNodeNative: nothing reaches an ntfy
 * until a test applies a link (push.applyLink).
 */
export async function createSyncEnv(
	targets: SyncTarget[],
	opts: { chatModule?: "auto" | "ignore"; chatFiles?: MemoryChatFiles } = {},
): Promise<SyncEnv> {
	const db = new DatabaseService();
	await db.initialize();
	for (const migration of APP_MIGRATIONS) {
		if (!SKIPPED_MIGRATIONS.has(migration.version)) await migration.run(db);
	}
	const creds: SyncCredentials[] = [];
	for (const target of targets) {
		await db.addApplication({
			url: target.url, username: target.username, password: target.password, database: target.database,
			odooVersion: "", autoSync: false, pollIntervalMinutes: 5, ntfyUrl: "", ntfyTopic: "", ntfyToken: "",
		} as any);
		creds.push({ odooUrl: target.url, username: target.username, password: target.password, database: target.database });
	}
	const pushNative = pushNodeNative();
	const sync = new SyncService(db, undefined, undefined, pushNative);
	sync.chat.moduleMode = opts.chatModule ?? "auto";
	const chatFiles = opts.chatFiles ?? memoryChatFiles();
	sync.chat.useFileIO({ files: chatFiles, http: nodeChatHttp(chatFiles) });
	return {
		db,
		sync,
		chat: sync.chat,
		notes: new NoteService(new EventBus(), db),
		creds,
		configIds: creds.map(syncConfigIdOf),
		chatFiles,
		push: sync.chat.push,
		pushNative,
		pushActions: sync.chat.pushActions,
	};
}

/**
 * The app killed and started again over env's database: a new sync service
 * (the chat's module mode and files carried over), then the startup repair
 * the app runs (OutboxService.recoverInterrupted, ChatService.recover). The
 * stored sessions, the network state and the native side of the
 * notifications (pushNative) stay as they were; the old chat service is
 * disposed (its bus and typing timers stop).
 */
export async function restartSyncEnv(env: SyncEnv): Promise<SyncEnv> {
	env.chat.dispose();
	const sync = new SyncService(env.db, undefined, undefined, env.pushNative);
	sync.chat.moduleMode = env.chat.moduleMode;
	sync.chat.useFileIO({ files: env.chatFiles, http: nodeChatHttp(env.chatFiles) });
	await sync.outbox.recoverInterrupted();
	await sync.chat.recover();
	return {
		...env, sync, chat: sync.chat, push: sync.chat.push, pushActions: sync.chat.pushActions,
		notes: new NoteService(new EventBus(), env.db),
	};
}

/**
 * The device's network as the app reads it: off, the chat queues without
 * sending and the outbox waits; back on, nothing is flushed until a caller
 * flushes. resetMocks() turns it back on.
 */
export function setOnline(connected: boolean): void {
	setNetwork({ connected, wifi: connected });
}

/**
 * The device's network, with its kind: wifi false while connected is a
 * mobile network, where « Wi-Fi only » holds the chat's uploads and
 * originals back. Like setOnline, it flushes nothing.
 */
export function setNetwork(state: { connected: boolean; wifi: boolean }): void {
	const connectionType = !state.connected ? "none" : state.wifi ? "wifi" : "cellular";
	(network as any).__setNetworkStatus({ connected: state.connected, connectionType });
}

/**
 * The name a conversation is shown under in the list and the thread
 * (displayNameOf over the cache: its members, the partners, self); lang as
 * the app language ("en" or "fr").
 */
export async function chatTitle(env: SyncEnv, configId: string, channelId: number, lang = "en"): Promise<string> {
	const channel = await env.chat.repo.channel(configId, channelId);
	if (!channel) throw new Error(`No cached conversation ${channelId}`);
	const partners = new Map((await env.chat.repo.partners(configId)).map((p) => [p.partnerId, p]));
	const self = (await env.chat.repo.sourceState(configId)).selfPartnerId;
	return displayNameOf(channel, await env.chat.repo.members(configId, channelId), partners, self, lang);
}

/**
 * A localStorage in memory, as the Vitest node environment has none; allowHttp
 * lets the app call http:// servers (Options › Odoo sync), off by default.
 */
export function installLocalStorage(options: { allowHttp?: boolean } = {}): Storage {
	const items = new Map<string, string>();
	const storage = {
		getItem: (key: string) => items.get(key) ?? null,
		setItem: (key: string, value: string) => { items.set(key, String(value)); },
		removeItem: (key: string) => { items.delete(key); },
		clear: () => items.clear(),
		key: (index: number) => [...items.keys()][index] ?? null,
		get length() { return items.size; },
	} as Storage;
	(globalThis as any).localStorage = storage;
	if (options.allowHttp) storage.setItem("options.sync.allowHttp", "true");
	return storage;
}

/**
 * Files of a note as the device would give them: files maps a path to its
 * content (bytes as they are, a string as UTF-8), a path absent is a file
 * not found; wifi says whether the device is on Wi-Fi, and can be changed
 * on the result.
 */
export function memoryAttachmentIO(
	options: { files?: Record<string, Buffer | Uint8Array | string>; wifi?: boolean } = {},
): AttachmentIO & { wifi: boolean } {
	const files = options.files ?? {};
	const bytesOf = (path: string) => {
		const content = files[path];
		return typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
	};
	return {
		wifi: options.wifi ?? true,
		async size(path: string) {
			return path in files ? bytesOf(path).length : null;
		},
		async read(path: string) {
			if (!(path in files)) throw new Error(`File not found: ${path}`);
			return bytesOf(path).toString("base64");
		},
		async onWifi() {
			return this.wifi;
		},
	};
}

/** Back to a device with nothing stored and on Wi-Fi: sessions forgotten, network reset. */
export function resetMocks(): void {
	(SecureStoragePlugin as any)._store?.clear?.();
	(network as any).__resetNetwork?.();
}

/**
 * A bus transport over Node's global WebSocket (Node 22+), for the long tests
 * that run the chat bus against a real server. The headers (cookie, user
 * agent) go in the second constructor argument, which undici accepts.
 */
export function nodeTransport(): BusTransport {
	let ws: WebSocket | null = null;
	const transport: BusTransport = {
		open(url, headers) {
			ws = new (WebSocket as any)(url, { headers });
			ws!.onopen = () => transport.onOpen();
			ws!.onmessage = (event: MessageEvent) => {
				if (typeof event.data === "string") transport.onMessage(event.data);
			};
			ws!.onclose = (event: CloseEvent) => transport.onClose(event.code, event.reason);
		},
		send: (text) => ws?.send(text),
		close: () => ws?.close(),
		onOpen: () => {},
		onMessage: () => {},
		onClose: () => {},
	};
	return transport;
}

/** Errors of Node's fetch whose request never left: no connection was made. */
const NOT_SENT = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);

/**
 * ChatHttp over Node's fetch, as the native ChatFile plugin behaves: no
 * redirect followed (a 3xx is an answer), headers by lowercase name (the
 * first Set-Cookie only), uploads as multipart/form-data (the fields in order,
 * then "ufile" read from files), downloads written into files whole with
 * their SHA-1 and Content-Type. A request refused before any connection
 * rejects with code UNSENT, one stopped by cancel(id) with code CANCELLED
 * (both typed by transportError); any other failure, a connection cut
 * after the request went included, is a plain Error. Each transfer sends
 * one progress event, once its bytes have all moved.
 */
export function nodeChatHttp(files: MemoryChatFiles): ChatHttp {
	const running = new Map<string, AbortController>();
	const listeners = new Set<(p: TransferProgress) => void>();
	const progress = (id: string, done: number) => {
		for (const fn of listeners) fn({ id, done, total: done });
	};
	const failure = (e: unknown, abort: AbortController): unknown => {
		const message = e instanceof Error ? e.message : String(e);
		const cause = (e as { cause?: { code?: string } } | null)?.cause?.code;
		if (abort.signal.aborted) return transportError(Object.assign(new Error(message), { code: CHAT_FILE_CANCELLED }));
		if (cause && NOT_SENT.has(cause)) return transportError(Object.assign(new Error(`${message}: ${cause}`), { code: CHAT_FILE_UNSENT }));
		return e;
	};
	async function exchange<T>(id: string | null, url: string, init: RequestInit, read: (r: Response) => Promise<T>): Promise<T> {
		const abort = new AbortController();
		if (id) running.set(id, abort);
		try {
			const response = await fetch(url, { ...init, redirect: "manual", signal: abort.signal });
			return await read(response);
		} catch (e) {
			throw failure(e, abort);
		} finally {
			if (id && running.get(id) === abort) running.delete(id);
		}
	}
	const headersOf = (response: Response) => {
		const out: Record<string, string> = {};
		response.headers.forEach((value, name) => {
			out[name.toLowerCase()] = value;
		});
		const cookie = response.headers.getSetCookie?.()[0];
		if (cookie) out["set-cookie"] = cookie;
		return out;
	};
	const text = async (response: Response): Promise<HttpAnswer> =>
		({ status: response.status, headers: headersOf(response), data: await response.text() });
	return {
		getText: (url, headers) => exchange(null, url, { headers }, text),
		async upload(r) {
			const bytes = files.bytes(r.file.uri);
			if (!bytes) {
				throw transportError(Object.assign(new Error(`File does not exist: ${r.file.uri}`), { code: CHAT_FILE_UNSENT }));
			}
			const form = new FormData();
			for (const [name, value] of Object.entries(r.fields)) form.append(name, value);
			form.append("ufile", new Blob([bytes], { type: r.file.mimetype }), r.file.name);
			const answer = await exchange(r.id, r.url, { method: "POST", headers: r.headers, body: form }, text);
			progress(r.id, bytes.length);
			return answer;
		},
		download: (r) => exchange(r.id, r.url, { headers: r.headers }, async (response) => {
			if (response.status < 200 || response.status >= 300) {
				await response.arrayBuffer();
				return { status: response.status, size: 0, sha1: null, mimetype: null };
			}
			const bytes = new Uint8Array(await response.arrayBuffer());
			files.put(r.uri, bytes);
			progress(r.id, bytes.length);
			const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", bytes));
			const type = response.headers.get("content-type");
			return {
				status: response.status,
				size: bytes.length,
				sha1: Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join(""),
				mimetype: type ? type.split(";")[0].trim().toLowerCase() : null,
			};
		}),
		async cancel(id) {
			running.get(id)?.abort();
		},
		onProgress(fn) {
			listeners.add(fn);
			return () => void listeners.delete(fn);
		},
	};
}

/** The stage limit the composer takes while the server's is unknown: Odoo's default. */
const DEFAULT_STAGE_LIMIT = 128 * 1024 * 1024;

/**
 * A picked file staged as the composer stages it once the picker answered
 * (ChatCapture.stage under the account's file directory, against the
 * server's upload limit as the session gives it): the OutgoingFile to send,
 * or the refusal of a file over the limit, nothing written. Images are
 * not converted (that is the phone's ChatFile.toJpeg).
 */
export async function stageChatFile(
	env: SyncEnv,
	src: ChatSource,
	file: { name: string; bytes: Uint8Array; mimetype?: string },
): Promise<OutgoingFile | StageRefusal> {
	const capture = new ChatCapture({
		files: env.chatFiles,
		images: { toJpeg: () => Promise.reject(new Error("no image conversion in the test kit")) },
		removeCaptureTemp: async () => {},
		sweepCaptureTemps: async () => {},
	});
	const picked = new File([file.bytes], file.name, { type: file.mimetype ?? "" });
	const limit = (await env.chat.uploadLimit(src)) ?? DEFAULT_STAGE_LIMIT;
	return capture.stage(await env.chat.fileDirOf(src.configId), picked, { maxUploadSize: limit });
}

/**
 * A voice message as the recorder leaves it: seconds of a 440 Hz tone at
 * 44100 Hz encoded by the app's MP3 encoder (mono, 128 kbit/s), staged
 * under out/ with the recorder's name, mimetype audio/mpeg, voice true.
 */
export async function stageChatVoice(env: SyncEnv, configId: string, seconds = 1): Promise<OutgoingFile> {
	const rate = 44100;
	const samples = new Float32Array(Math.round(seconds * rate));
	for (let i = 0; i < samples.length; i++) samples[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / rate);
	const mp3 = encodeMp3(samples, rate);
	const localUuid = crypto.randomUUID();
	const name = voiceName(new Date());
	const path = outgoingPath(await env.chat.fileDirOf(configId), localUuid, name);
	env.chatFiles.put(path, mp3);
	return { localUuid, path, name, mimetype: "audio/mpeg", size: mp3.length, voice: true };
}
