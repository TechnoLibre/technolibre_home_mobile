/**
 * In-memory fake of ChatPushNative for unit tests. Every call is recorded
 * in `calls` (method and argument, in order) and acts on plain state the
 * test can read or preset: the mirror, the ntfy servers, subscriptions,
 * session copies, pending endpoints and shown tags. `failNext` makes the
 * next call of a method reject the way the bridge does; `emitPushOpen`
 * plays a notification tap to the pushOpen listeners, `emitActions` adds
 * native actions to the drain and tells the actions listeners.
 */
import type { PluginListenerHandle } from "@capacitor/core";
import type { ChatPushEvents, ChatPushNative, NativeAction, PushHealth, PushSettingsMirror } from "../plugins/chatPushPlugin";

export interface FakeChatPushNative extends ChatPushNative {
    calls: { method: string; args: unknown }[];
    realtime: boolean;
    settings: PushSettingsMirror | null;
    ntfys: Map<string, { token: string; prefix: string; cacheSeconds: number }>;
    /** The refusal reason the next setNtfy answers (null: accepted). */
    ntfyRefusal: string | null;
    subscriptions: Map<string, { ntfyUrl: string; topic: string; p256dh: string; auth: string }>;
    sessions: Map<string, { odooUrl: string; database: string; sessionId: string }>;
    pending: { configId: string; endpoint: string }[];
    shownTags: string[];
    /** When a shown tag was posted, epoch ms; a tag absent from it was posted at 0. */
    shownAt: Map<string, number>;
    launchUrl: string | null;
    qrText: string | null;
    exempt: boolean;
    notificationsAllowed: boolean;
    /** Fields merged over the default health status() answers. */
    health: Partial<PushHealth>;
    /** The actions the drain serves until acked, oldest first. */
    nativeActions: NativeAction[];
    /** The next call of method rejects with "ChatPushPlugin.<method>: <message>". */
    failNext(method: keyof ChatPushNative, message?: string): void;
    emitPushOpen(url: string): void;
    /** Appends actions to the drain, then fires the actions event. */
    emitActions(actions: NativeAction[]): void;
    /** Calls of one method, their arguments in order. */
    callsOf(method: keyof ChatPushNative): unknown[];
}

export function fakeChatPushNative(): FakeChatPushNative {
    const failures = new Map<string, string>();
    const listeners: { [E in keyof ChatPushEvents]: Set<(ev: ChatPushEvents[E]) => void> } = {
        pushOpen: new Set(),
        actions: new Set(),
    };
    let topicSeq = 0;

    const record = async (method: keyof ChatPushNative, args?: unknown): Promise<void> => {
        fake.calls.push({ method, args });
        const msg = failures.get(method);
        if (msg !== undefined) {
            failures.delete(method);
            throw new Error(`ChatPushPlugin.${method}: ${msg}`);
        }
    };

    const fake: FakeChatPushNative = {
        calls: [],
        realtime: true,
        settings: null,
        ntfys: new Map(),
        ntfyRefusal: null,
        subscriptions: new Map(),
        sessions: new Map(),
        pending: [],
        shownTags: [],
        shownAt: new Map(),
        launchUrl: null,
        qrText: null,
        exempt: false,
        notificationsAllowed: true,
        health: {},
        nativeActions: [],

        failNext(method, message = "refused") {
            failures.set(method, message);
        },
        emitPushOpen(url) {
            for (const fn of listeners.pushOpen) fn({ url });
        },
        emitActions(actions) {
            fake.nativeActions.push(...actions);
            for (const fn of listeners.actions) fn({});
        },
        callsOf(method) {
            return fake.calls.filter((c) => c.method === method).map((c) => c.args);
        },

        async capabilities() {
            await record("capabilities");
            return { realtime: fake.realtime };
        },
        async publishSettings(o) {
            await record("publishSettings", o);
            fake.settings = o;
            // A tag is "<kind>:<configId>[:...]" and a config id holds ":" itself ("https://...")
            const ids = o.accounts.map((a) => a.configId);
            fake.shownTags = fake.shownTags.filter((t) => {
                const rest = t.slice(t.indexOf(":") + 1);
                return ids.some((id) => rest === id || rest.startsWith(id + ":"));
            });
        },
        async setNtfy(o) {
            await record("setNtfy", o);
            if (fake.ntfyRefusal !== null) return { ok: false, reason: fake.ntfyRefusal };
            fake.ntfys.set(o.url, { token: o.token, prefix: o.prefix, cacheSeconds: o.cacheSeconds });
            return { ok: true, reason: null };
        },
        async removeNtfy(o) {
            await record("removeNtfy", o);
            fake.ntfys.delete(o.url);
        },
        async subscribe(o) {
            await record("subscribe", o);
            const server = fake.ntfys.get(o.ntfyUrl);
            if (!server) throw new Error("ChatPushPlugin.subscribe: subscribe failed");
            const known = fake.subscriptions.get(o.configId);
            if (known && !o.renew && known.ntfyUrl === o.ntfyUrl && known.topic.startsWith(server.prefix)) {
                return { topic: known.topic, p256dh: known.p256dh, auth: known.auth };
            }
            topicSeq += 1;
            const sub = {
                ntfyUrl: o.ntfyUrl,
                topic: `${server.prefix}fake${topicSeq}`,
                p256dh: `pub${topicSeq}`,
                auth: `auth${topicSeq}`,
            };
            fake.subscriptions.set(o.configId, sub);
            return { topic: sub.topic, p256dh: sub.p256dh, auth: sub.auth };
        },
        async unsubscribe(o) {
            await record("unsubscribe", o);
            if (o.pendingEndpoint) fake.pending.push({ configId: o.configId, endpoint: o.pendingEndpoint });
            fake.subscriptions.delete(o.configId);
        },
        async mirrorSession(o) {
            await record("mirrorSession", o);
            fake.sessions.set(o.configId, { odooUrl: o.odooUrl, database: o.database, sessionId: o.sessionId });
        },
        async forgetSession(o) {
            await record("forgetSession", o);
            fake.sessions.delete(o.configId);
        },
        async status() {
            await record("status");
            return {
                at: 0,
                level: fake.settings?.level ?? 3,
                effectiveLevel: fake.settings?.level ?? 3,
                mode: "poll_15",
                realtimeBuild: fake.realtime,
                serviceAlive: false,
                ntfys: [],
                accounts: [],
                undecryptable: 0,
                faults: 0,
                notificationsAllowed: fake.notificationsAllowed,
                batteryExempt: fake.exempt,
                ...fake.health,
            };
        },
        async checkNow() {
            await record("checkNow");
        },
        async clear(o) {
            await record("clear", o);
            const all = o.channelId === undefined && !o.inbox && !o.summary;
            const oneRecord = o.model !== undefined && o.resId !== undefined;
            fake.shownTags = fake.shownTags.filter((t) => {
                if (o.before !== undefined && (fake.shownAt.get(t) ?? 0) > o.before) return true;
                if (o.channelId !== undefined && t === `chat:${o.configId}:${o.channelId}`) return false;
                if (o.inbox && oneRecord) {
                    if (t === `inbox:${o.configId}:${o.model}:${o.resId}`) return false;
                } else if ((o.inbox || all) && t.startsWith(`inbox:${o.configId}:`)) {
                    return false;
                }
                if ((o.summary || all) && t === `summary:${o.configId}`) return false;
                if (all && t.startsWith(`chat:${o.configId}:`)) return false;
                return true;
            });
        },
        async shown() {
            await record("shown");
            return fake.shownTags.map((tag) => ({ tag }));
        },
        async takeLaunchUrl() {
            await record("takeLaunchUrl");
            const url = fake.launchUrl;
            fake.launchUrl = null;
            return { url };
        },
        async decodeQr(o) {
            await record("decodeQr", o);
            return { text: fake.qrText };
        },
        async batteryExempt() {
            await record("batteryExempt");
            return { exempt: fake.exempt };
        },
        async requestBatteryExemption() {
            await record("requestBatteryExemption");
        },
        async actions() {
            await record("actions");
            return [...fake.nativeActions];
        },
        async ackActions(o) {
            await record("ackActions", o);
            fake.nativeActions = fake.nativeActions.filter((a) => !o.ids.includes(a.id));
        },
        async addListener(event, fn): Promise<PluginListenerHandle> {
            const set = listeners[event] as Set<typeof fn>;
            set.add(fn);
            return { remove: async () => { set.delete(fn); } };
        },
    };
    return fake;
}
