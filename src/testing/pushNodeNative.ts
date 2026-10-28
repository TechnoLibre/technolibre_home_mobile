/**
 * ChatPushNative in Node, for the tests that run the app's ChatPush against
 * a real ntfy and a real Odoo: what the phone's native side does that the
 * server sees, done for real (the token checked on the ntfy, P-256 key
 * pairs and auth secrets drawn, topics drawn as R4 says), and the rest
 * (notifications, the permanent service, QR decoding) kept as plain state.
 * The private keys stay in this process: keysOf hands them to the test,
 * which decrypts what Odoo pushed (decryptWebPush, pollNtfy).
 */
import type { PluginListenerHandle } from "@capacitor/core";
import { generateKeyPairSync, randomBytes, randomInt, type KeyObject } from "node:crypto";
import type { ChatPushNative, PushHealth, PushSettingsMirror } from "../plugins/chatPushPlugin";

/** One account's subscription as native code keeps it, its private key included. */
export interface NodeSubscription {
	ntfyUrl: string;
	prefix: string;
	topic: string;
	privateKey: KeyObject;
	/** The uncompressed public point, 65 bytes. */
	publicKey: Uint8Array;
	/** The auth secret, 16 bytes. */
	auth: Uint8Array;
}

export interface PushNodeNative extends ChatPushNative {
	/** Every call, method and argument, in order. */
	calls: { method: string; args: unknown }[];
	settings: PushSettingsMirror | null;
	ntfys: Map<string, { token: string; prefix: string; cacheSeconds: number }>;
	subscriptions: Map<string, NodeSubscription>;
	sessions: Map<string, { odooUrl: string; database: string; sessionId: string }>;
	/** Endpoints unsubscribe left for native code to unregister. */
	pending: { configId: string; endpoint: string }[];
	shownTags: string[];
	/** The account's subscription keys and topic; throws when it has none. */
	keysOf(configId: string): { privateKey: KeyObject; publicKey: Uint8Array; auth: Uint8Array; topic: string };
}

const TOPIC_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
/** What a topic adds to its prefix (R4): 22 of [a-z0-9]. */
const TOPIC_RANDOM = 22;

function randomTopic(prefix: string): string {
	let out = prefix;
	for (let i = 0; i < TOPIC_RANDOM; i++) out += TOPIC_ALPHABET[randomInt(TOPIC_ALPHABET.length)];
	return out;
}

/** A new P-256 key pair and auth secret, as WebPushKeys draws them. */
function drawKeys(): Pick<NodeSubscription, "privateKey" | "publicKey" | "auth"> {
	const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
	const jwk = publicKey.export({ format: "jwk" });
	const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]);
	return { privateKey, publicKey: new Uint8Array(point), auth: new Uint8Array(randomBytes(16)) };
}

/**
 * The read check native code runs before storing an ntfy: the token reads
 * `<prefix>check` (a poll, nothing waits). Answers the refusal kind, null
 * when it may read.
 */
async function readCheck(url: string, token: string, prefix: string): Promise<string | null> {
	let status: number;
	try {
		const response = await fetch(`${url}/${prefix}check/json?poll=1&since=all`, {
			headers: { Authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(10000),
		});
		await response.arrayBuffer();
		status = response.status;
	} catch {
		return "unreachable";
	}
	if (status === 200) return null;
	if (status === 401) return "unauthorized";
	if (status === 403) return "forbidden";
	if (status === 429) return "rate_limited";
	return "protocol";
}

export function pushNodeNative(): PushNodeNative {
	const listeners = new Set<(ev: { url: string }) => void>();
	const record = (method: string, args?: unknown) => {
		native.calls.push({ method, args });
	};
	const fail = (method: string, message: string) => new Error(`ChatPushPlugin.${method}: ${message}`);
	const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

	const native: PushNodeNative = {
		calls: [],
		settings: null,
		ntfys: new Map(),
		subscriptions: new Map(),
		sessions: new Map(),
		pending: [],
		shownTags: [],

		keysOf(configId) {
			const sub = native.subscriptions.get(configId);
			if (!sub) throw new Error(`no subscription for ${configId}`);
			return { privateKey: sub.privateKey, publicKey: sub.publicKey, auth: sub.auth, topic: sub.topic };
		},

		async capabilities() {
			record("capabilities");
			return { realtime: true };
		},
		async publishSettings(o) {
			record("publishSettings", o);
			native.settings = o;
			const ids = o.accounts.map((a) => a.configId);
			native.shownTags = native.shownTags.filter((t) => {
				const rest = t.slice(t.indexOf(":") + 1);
				return ids.some((id) => rest === id || rest.startsWith(id + ":"));
			});
		},
		async setNtfy(o) {
			record("setNtfy", { ...o, token: "<token>" });
			if (/^http:/i.test(o.url) && !native.settings?.allowHttp) return { ok: false, reason: "http_refused" };
			const reason = await readCheck(o.url, o.token, o.prefix);
			if (reason) return { ok: false, reason };
			native.ntfys.set(o.url, { token: o.token, prefix: o.prefix, cacheSeconds: o.cacheSeconds });
			return { ok: true, reason: null };
		},
		async removeNtfy(o) {
			record("removeNtfy", o);
			native.ntfys.delete(o.url);
		},
		async subscribe(o) {
			record("subscribe", o);
			const server = native.ntfys.get(o.ntfyUrl);
			if (!server) throw fail("subscribe", "unknown ntfy");
			let sub = native.subscriptions.get(o.configId);
			if (!sub || o.renew || sub.ntfyUrl !== o.ntfyUrl || sub.prefix !== server.prefix) {
				sub = { ntfyUrl: o.ntfyUrl, prefix: server.prefix, topic: randomTopic(server.prefix), ...drawKeys() };
				native.subscriptions.set(o.configId, sub);
			}
			return { topic: sub.topic, p256dh: b64url(sub.publicKey), auth: b64url(sub.auth) };
		},
		async unsubscribe(o) {
			record("unsubscribe", o);
			if (o.pendingEndpoint) native.pending.push({ configId: o.configId, endpoint: o.pendingEndpoint });
			native.subscriptions.delete(o.configId);
		},
		async mirrorSession(o) {
			record("mirrorSession", { ...o, sessionId: "<session>" });
			native.sessions.set(o.configId, { odooUrl: o.odooUrl, database: o.database, sessionId: o.sessionId });
		},
		async forgetSession(o) {
			record("forgetSession", o);
			native.sessions.delete(o.configId);
		},
		async status(): Promise<PushHealth> {
			record("status");
			const level = native.settings?.level ?? 3;
			return {
				at: Date.now(),
				level,
				effectiveLevel: level,
				mode: level <= 2 ? "realtime" : level === 3 ? "poll_15" : level === 4 ? "poll_60" : "off",
				realtimeBuild: true,
				serviceAlive: false,
				ntfys: [...native.ntfys.keys()].map((url) => ({
					url,
					state: "polling",
					reason: null,
					lastContactAt: 0,
					configIds: [...native.subscriptions].filter(([, s]) => s.ntfyUrl === url).map(([id]) => id),
				})),
				accounts: [],
				undecryptable: 0,
				faults: 0,
				notificationsAllowed: true,
				batteryExempt: true,
			};
		},
		async checkNow() {
			record("checkNow");
		},
		async clear(o) {
			record("clear", o);
			const all = o.channelId === undefined && !o.inbox && !o.summary;
			native.shownTags = native.shownTags.filter((t) => {
				if (o.channelId !== undefined && t === `chat:${o.configId}:${o.channelId}`) return false;
				if ((o.inbox || all) && t.startsWith(`inbox:${o.configId}:`)) return false;
				if ((o.summary || all) && t === `summary:${o.configId}`) return false;
				if (all && t.startsWith(`chat:${o.configId}:`)) return false;
				return true;
			});
		},
		async shown() {
			record("shown");
			return native.shownTags.map((tag) => ({ tag }));
		},
		async takeLaunchUrl() {
			record("takeLaunchUrl");
			return { url: null };
		},
		async decodeQr(o) {
			record("decodeQr", o);
			return { text: null };
		},
		async batteryExempt() {
			record("batteryExempt");
			return { exempt: true };
		},
		async requestBatteryExemption() {
			record("requestBatteryExemption");
		},
		async addListener(_event, fn): Promise<PluginListenerHandle> {
			listeners.add(fn);
			return { remove: async () => void listeners.delete(fn) };
		},
	};
	return native;
}

/** One message of an ntfy topic, its body as bytes (base64 decoded when ntfy says so). */
export interface NtfyMessage {
	id: string;
	topic: string;
	time: number;
	body: Uint8Array;
}

/**
 * The messages of the topics on the ntfy since `since` ("all", a message
 * id or a unix time), read as the token (a poll: ntfy answers what it
 * holds and closes). A refusal rejects with an Error carrying the HTTP
 * status.
 */
export async function pollNtfy(ntfy: { url: string; token: string }, topics: string[], since: string): Promise<NtfyMessage[]> {
	const response = await fetch(`${ntfy.url}/${topics.join(",")}/json?poll=1&since=${encodeURIComponent(since)}`, {
		headers: { Authorization: `Bearer ${ntfy.token}` },
		signal: AbortSignal.timeout(15000),
	});
	const text = await response.text();
	if (response.status !== 200) {
		throw Object.assign(new Error(`ntfy answered ${response.status} for ${topics.length} topic(s)`), { status: response.status });
	}
	const out: NtfyMessage[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		const event = JSON.parse(line);
		if (event.event !== "message") continue;
		const raw = String(event.message ?? "");
		const body = event.encoding === "base64" ? Buffer.from(raw, "base64") : Buffer.from(raw, "utf8");
		out.push({ id: event.id, topic: event.topic, time: event.time ?? 0, body: new Uint8Array(body) });
	}
	return out;
}
