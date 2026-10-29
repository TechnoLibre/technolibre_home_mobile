import { Capacitor, registerPlugin } from "@capacitor/core";
import type { PluginListenerHandle } from "@capacitor/core";

/** What a server's notifications show on the lock screen. */
export type PushLockScreen = "hidden_locked" | "never" | "always";

/** One account as the native side sees it: label, lock-screen choice, mirrored conversations. */
export interface PushAccountMirror {
    configId: string;
    label: string;
    lockScreen: PushLockScreen;
    channels: { id: number; name: string; type: string }[];
}

export interface PushSettingsMirror {
    /** 1 (realtime) to 5 (off). */
    level: number;
    allowHttp: boolean;
    /** The notification texts in the app's language; a missing key falls back to French. */
    strings: Record<string, string>;
    accounts: PushAccountMirror[];
}

export interface PushHealthNtfy {
    url: string;
    state: "connected" | "connecting" | "polling" | "error" | "off";
    /** The ntfy failure kind in lower case (unauthorized, unreachable...), or null. */
    reason: string | null;
    lastContactAt: number;
    configIds: string[];
}

export interface PushHealthAccount {
    configId: string;
    via: "ntfy" | "odoo";
    state: "ok" | "waiting" | "error" | "session_expired" | "no_session";
    reason: string | null;
    lastCheckAt: number;
}

/** The engine's HealthSnapshot JSON, plus the two Android permissions that decide whether it can work. */
export type PushHealth = {
    at: number;
    level: number;
    effectiveLevel: number;
    mode: "realtime" | "poll_15" | "poll_60" | "off";
    realtimeBuild: boolean;
    serviceAlive: boolean;
    ntfys: PushHealthNtfy[];
    accounts: PushHealthAccount[];
    /** Messages whose body did not decrypt or did not parse. */
    undecryptable: number;
    /** Messages lost to a fault of the phone (cipher, sealed key, drawing). */
    faults: number;
    notificationsAllowed: boolean;
    batteryExempt: boolean;
};

/**
 * A notification action that native code ended (done) or hands to the app
 * (handoff, reason session_expired | refused | ambiguous | stale), as the
 * drain returns it. text is the reply typed in the notification ("" for the
 * other kinds), content the reaction; messageId is null when unknown,
 * sentAt when no send may have reached Odoo; plainSent is true once a send
 * went without the module's uuid; answer is Odoo's Store answer, if kept.
 */
export interface NativeAction {
    id: string;
    configId: string;
    kind: "reply" | "read" | "mute" | "react";
    state: "done" | "handoff";
    reason: string | null;
    channelId: number;
    messageId: number | null;
    clientUuid: string;
    text: string;
    content: string;
    createdAt: number;
    sentAt: number | null;
    plainSent: boolean;
    answer: string | null;
}

/** The plugin's events and what each carries. */
export interface ChatPushEvents {
    /** A notification tap while the app runs; kept until a listener takes it. */
    pushOpen: { url: string };
    /** A notification action ran natively; nothing carried, the app drains with actions(). */
    actions: Record<string, never>;
}

/**
 * The native side of the closed-app chat notifications (ChatPushPlugin).
 * Calls that change state run in the order they are made. A rejection is
 * an Error whose message starts with "ChatPushPlugin.<method>:".
 *
 * Ordering: the engine forgets the session copy of an account absent from
 * the last publishSettings unless the copy was mirrored after it. So an
 * unsubscribe with a pendingEndpoint comes before the publishSettings that
 * drops the account, and a new account's publishSettings comes after its
 * mirrorSession and before (or as) the next state-changing call.
 */
export interface ChatPushNative {
    /** Whether this build carries the permanent realtime service (levels 1 and 2). */
    capabilities(): Promise<{ realtime: boolean }>;
    /**
     * Replaces the whole mirror (level, cleartext, strings, accounts):
     * channels follow the accounts, a removed account loses its
     * notifications. Comes before setNtfy for an http ntfy (allowHttp).
     */
    publishSettings(o: PushSettingsMirror): Promise<void>;
    /**
     * Checks that the token may read "<prefix>check" on the server, then
     * stores it; nothing is stored when ok is false. reason is the refusal
     * kind (unauthorized, forbidden, unreachable, http_refused, protocol...).
     */
    setNtfy(o: { url: string; token: string; prefix: string; cacheSeconds: number }): Promise<{ ok: boolean; reason: string | null }>;
    /** Forgets the server; its accounts are unsubscribed separately. */
    removeNtfy(o: { url: string }): Promise<void>;
    /**
     * The account's Web Push subscription on a stored ntfy (base64url keys),
     * kept unless renew or its server or prefix changed. Rejects for an
     * unknown server.
     */
    subscribe(o: { configId: string; ntfyUrl: string; renew: boolean }): Promise<{ topic: string; p256dh: string; auth: string }>;
    /**
     * Drops the subscription. A pendingEndpoint is queued for unregistering
     * from Odoo and keeps the account's session copy until it is sent: call
     * it before the publishSettings that drops the account.
     */
    unsubscribe(o: { configId: string; pendingEndpoint: string | null }): Promise<void>;
    /** Stores the account's session copy (sealed) and lifts its expired mark; publish a new account next. */
    mirrorSession(o: { configId: string; odooUrl: string; database: string; sessionId: string }): Promise<void>;
    forgetSession(o: { configId: string }): Promise<void>;
    status(): Promise<PushHealth>;
    /** One run of the periodic job now; resolves once it is done. */
    checkNow(): Promise<void>;
    /**
     * Removes the account's notifications: the conversation channelId,
     * every inbox one (inbox), only the record's with model and resId, the
     * summary (summary); with none of them, all three kinds. The status
     * notification stays. With before (epoch ms), only those posted at or
     * before it go.
     */
    clear(o: {
        configId: string;
        channelId?: number;
        inbox?: boolean;
        model?: string;
        resId?: number;
        summary?: boolean;
        before?: number;
    }): Promise<void>;
    /** The tags of the chat notifications shown ("chat:<configId>:<id>", "inbox:...", "summary:...", "status:..."). */
    shown(): Promise<{ tag: string }[]>;
    /** The app path of the notification tap that launched the app, once; null afterwards. */
    takeLaunchUrl(): Promise<{ url: string | null }>;
    /** The text of the first QR code in the image file (path or file:/content: URI), or null. */
    decodeQr(o: { path: string }): Promise<{ text: string | null }>;
    batteryExempt(): Promise<{ exempt: boolean }>;
    /** Opens the system list of battery-optimisation exemptions. */
    requestBatteryExemption(): Promise<void>;
    /** The notification actions native code ended or hands over, oldest first; they stay until acked. */
    actions(): Promise<NativeAction[]>;
    /** Forgets the drained actions of ids (a pending one stays native code's); the handoff notifications follow. */
    ackActions(o: { ids: string[] }): Promise<void>;
    /** pushOpen: a notification tap (kept until taken); actions: a native action ran (not kept). */
    addListener<E extends keyof ChatPushEvents>(event: E, fn: (ev: ChatPushEvents[E]) => void): Promise<PluginListenerHandle>;
}

/** The plugin as Capacitor registers it: shown() and actions() answer an object, since a native call resolves one. */
export type ChatPushPluginApi = Omit<ChatPushNative, "shown" | "actions"> & {
    shown(): Promise<{ tags: { tag: string }[] }>;
    actions(): Promise<{ actions: NativeAction[] }>;
};

function failure(method: string, e: unknown): Error {
    const msg = e instanceof Error ? e.message : String(e);
    const err = new Error(`ChatPushPlugin.${method}: ${msg}`);
    const code = (e as { code?: unknown } | null)?.code;
    if (code !== undefined) (err as Error & { code?: unknown }).code = code;
    return err;
}

async function bridged<T>(method: string, run: () => Promise<T>): Promise<T> {
    try {
        return await run();
    } catch (e: unknown) {
        throw failure(method, e);
    }
}

/** ChatPushNative over a registered plugin; exported for the tests. */
export function createChatPushNative(p: ChatPushPluginApi): ChatPushNative {
    const done = async (method: string, run: () => Promise<unknown>): Promise<void> => {
        await bridged(method, run);
    };
    return {
        capabilities: () => bridged("capabilities", () => p.capabilities()),
        publishSettings: (o) => done("publishSettings", () => p.publishSettings(o)),
        setNtfy: (o) => bridged("setNtfy", () => p.setNtfy(o)),
        removeNtfy: (o) => done("removeNtfy", () => p.removeNtfy(o)),
        subscribe: (o) => bridged("subscribe", () => p.subscribe(o)),
        unsubscribe: (o) => done("unsubscribe", () => p.unsubscribe(o)),
        mirrorSession: (o) => done("mirrorSession", () => p.mirrorSession(o)),
        forgetSession: (o) => done("forgetSession", () => p.forgetSession(o)),
        status: () => bridged("status", () => p.status()),
        checkNow: () => done("checkNow", () => p.checkNow()),
        clear: (o) => done("clear", () => p.clear(o)),
        shown: async () => (await bridged("shown", () => p.shown())).tags ?? [],
        takeLaunchUrl: () => bridged("takeLaunchUrl", () => p.takeLaunchUrl()),
        decodeQr: (o) => bridged("decodeQr", () => p.decodeQr(o)),
        batteryExempt: () => bridged("batteryExempt", () => p.batteryExempt()),
        requestBatteryExemption: () => done("requestBatteryExemption", () => p.requestBatteryExemption()),
        actions: async () => (await bridged("actions", () => p.actions())).actions ?? [],
        ackActions: (o) => done("ackActions", () => p.ackActions(o)),
        addListener: (event, fn) => p.addListener(event, fn),
    };
}

/** The native chat push, or null off a native platform (browser, tests). */
export const chatPushNative: ChatPushNative | null = Capacitor.isNativePlatform()
    ? createChatPushNative(registerPlugin<ChatPushPluginApi>("ChatPushPlugin"))
    : null;
