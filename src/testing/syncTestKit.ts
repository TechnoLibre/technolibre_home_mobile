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
import type { BusTransport } from "../services/chat/chatBus";
import type { AttachmentIO } from "../services/attachmentService";

export const HARNESS_API = 2;

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
}

/**
 * A new app database, migrated as the app migrates it, with one application
 * per target, and the sync service over it. Nothing is read from a server
 * until a sync runs. chatModule "ignore" makes chat posts take the marker
 * path even where the server module is installed.
 */
export async function createSyncEnv(
	targets: SyncTarget[],
	opts: { chatModule?: "auto" | "ignore" } = {},
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
	const sync = new SyncService(db);
	sync.chat.moduleMode = opts.chatModule ?? "auto";
	return {
		db,
		sync,
		chat: sync.chat,
		notes: new NoteService(new EventBus(), db),
		creds,
		configIds: creds.map(syncConfigIdOf),
	};
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
 * content (a string, sent as UTF-8), a path absent is a file not found; wifi
 * says whether the device is on Wi-Fi, and can be changed on the result.
 */
export function memoryAttachmentIO(options: { files?: Record<string, string>; wifi?: boolean } = {}): AttachmentIO & { wifi: boolean } {
	const files = options.files ?? {};
	return {
		wifi: options.wifi ?? true,
		async size(path: string) {
			return path in files ? Buffer.byteLength(files[path], "utf8") : null;
		},
		async read(path: string) {
			if (!(path in files)) throw new Error(`File not found: ${path}`);
			return Buffer.from(files[path], "utf8").toString("base64");
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
