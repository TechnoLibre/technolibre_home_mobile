import { describe, it, expect, vi } from "vitest";
import { chatPushNative, createChatPushNative } from "../plugins/chatPushPlugin";
import { fakeChatPushNative } from "../__mocks__/chatPushNative";
import type { ChatPushNative, ChatPushPluginApi, NativeAction, PushHealth } from "../plugins/chatPushPlugin";

const health: PushHealth = {
    at: 1_000, level: 3, effectiveLevel: 3, mode: "poll_15", realtimeBuild: true, serviceAlive: false,
    ntfys: [{ url: "https://ntfy.exemple.test", state: "polling", reason: null, lastContactAt: 900, configIds: ["a"] }],
    accounts: [{ configId: "a", via: "ntfy", state: "ok", reason: null, lastCheckAt: 0 }],
    undecryptable: 0, faults: 0, notificationsAllowed: true, batteryExempt: false,
};

const action: NativeAction = {
    id: "act1", configId: "a", kind: "reply", state: "handoff", reason: "session_expired", channelId: 4,
    messageId: 12, clientUuid: "c1", text: "vu", content: "", createdAt: 1_000, sentAt: null, plainSent: false,
    answer: null,
};

/** Every bridge method: its arguments (or none), what the native side answers, and what the bridge returns. */
const CASES: [keyof ChatPushNative, unknown, unknown, unknown?][] = [
    ["capabilities", undefined, { realtime: true }],
    ["publishSettings", {
        level: 3, allowHttp: false, strings: { new_message: "Nouveau message" },
        accounts: [{ configId: "a", label: "Serveur Alice", lockScreen: "hidden_locked",
            channels: [{ id: 4, name: "Bruno Tremblay", type: "chat" }] }],
    }, undefined],
    ["setNtfy", { url: "https://ntfy.exemple.test", token: "tk_qwertyzx", prefix: "upab12cd34", cacheSeconds: 43_200 },
        { ok: false, reason: "unauthorized" }],
    ["removeNtfy", { url: "https://ntfy.exemple.test" }, undefined],
    ["subscribe", { configId: "a", ntfyUrl: "https://ntfy.exemple.test", renew: false },
        { topic: "upab12cd34abc", p256dh: "BPub", auth: "QXV0aA" }],
    ["unsubscribe", { configId: "a", pendingEndpoint: "https://ntfy.exemple.test/upab12cd34abc" }, undefined],
    ["mirrorSession", { configId: "a", odooUrl: "https://odoo.exemple.test", database: "base", sessionId: "s" }, undefined],
    ["forgetSession", { configId: "a" }, undefined],
    ["status", undefined, health],
    ["checkNow", undefined, undefined],
    ["clear", { configId: "a", channelId: 4 }, undefined],
    ["shown", undefined, { tags: [{ tag: "chat:a:4" }] }, [{ tag: "chat:a:4" }]],
    ["takeLaunchUrl", undefined, { url: "/chat/a/4" }],
    ["decodeQr", { path: "/data/files/qr.jpg" }, { text: "ntfy://x" }],
    ["batteryExempt", undefined, { exempt: true }],
    ["requestBatteryExemption", undefined, undefined],
    ["actions", undefined, { actions: [action] }, [action]],
    ["ackActions", { ids: ["act1"] }, undefined],
];

function fakePlugin(): Record<string, ReturnType<typeof vi.fn>> {
    const p: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const [name] of CASES) p[name] = vi.fn();
    p.addListener = vi.fn(async () => ({ remove: async () => {} }));
    return p;
}

describe("chatPushPlugin bridge", () => {
    it("forwards every method's arguments and returns the native answer", async () => {
        const plugin = fakePlugin();
        const bridge = createChatPushNative(plugin as unknown as ChatPushPluginApi);
        for (const [name, args, answer, bridged] of CASES) {
            plugin[name].mockResolvedValue(answer ?? {});
            const call = (bridge[name] as (o?: unknown) => Promise<unknown>)(args);
            await expect(call, name).resolves.toEqual(bridged ?? answer);
            if (args === undefined) expect(plugin[name], name).toHaveBeenCalledWith();
            else expect(plugin[name], name).toHaveBeenCalledWith(args);
        }
    });

    it("maps a rejected call to an Error naming the method", async () => {
        const plugin = fakePlugin();
        const bridge = createChatPushNative(plugin as unknown as ChatPushPluginApi);
        for (const [name, args] of CASES) {
            plugin[name].mockRejectedValue(Object.assign(new Error("refused"), { code: "X" }));
            const call = (bridge[name] as (o?: unknown) => Promise<unknown>)(args);
            await expect(call, name).rejects.toBeInstanceOf(Error);
            await expect(call, name).rejects.toThrow(`ChatPushPlugin.${name}: refused`);
        }
        plugin.status.mockRejectedValue("plain string");
        await expect(bridge.status()).rejects.toThrow("ChatPushPlugin.status: plain string");
    });

    it("forwards the pushOpen listener", async () => {
        const plugin = fakePlugin();
        const bridge = createChatPushNative(plugin as unknown as ChatPushPluginApi);
        const fn = vi.fn();
        await bridge.addListener("pushOpen", fn);
        expect(plugin.addListener).toHaveBeenCalledWith("pushOpen", fn);
    });

    it("forwards the actions event to its listener", async () => {
        const plugin = fakePlugin();
        const bridge = createChatPushNative(plugin as unknown as ChatPushPluginApi);
        const fn = vi.fn();
        await bridge.addListener("actions", fn);
        expect(plugin.addListener).toHaveBeenCalledWith("actions", fn);
        const [, registered] = plugin.addListener.mock.calls[0] as [string, () => void];
        registered();
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it("the fake serves, acks and announces the native actions", async () => {
        const fake = fakeChatPushNative();
        const onActions = vi.fn();
        const onOpen = vi.fn();
        await fake.addListener("actions", onActions);
        await fake.addListener("pushOpen", onOpen);
        fake.emitActions([action, { ...action, id: "act2", state: "done", reason: null }]);
        expect(onActions).toHaveBeenCalledTimes(1);
        expect(onOpen).not.toHaveBeenCalled();
        expect((await fake.actions()).map((a) => a.id)).toEqual(["act1", "act2"]);
        await fake.ackActions({ ids: ["act1"] });
        expect((await fake.actions()).map((a) => a.id)).toEqual(["act2"]);
        expect(fake.callsOf("ackActions")).toEqual([{ ids: ["act1"] }]);
        fake.emitPushOpen("/chat");
        expect(onOpen).toHaveBeenCalledWith({ url: "/chat" });
        expect(onActions).toHaveBeenCalledTimes(1);
    });

    it("is null off a native platform", () => {
        expect(chatPushNative).toBeNull();
    });
});
