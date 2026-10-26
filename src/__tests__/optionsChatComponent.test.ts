// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { EventBus } from "@odoo/owl";

import { OptionsChatComponent } from "../components/options/chat/options_chat_component";
import { chatSettings, CHAT_SETTINGS_KEY } from "../services/chat/chatSettings";

function stubStorage() {
    const store: Record<string, string> = { app_lang: "en" };
    (globalThis as any).localStorage = {
        getItem: (k: string) => store[k] ?? null,
        setItem: (k: string, v: string) => { store[k] = v; },
        removeItem: (k: string) => { delete store[k]; },
    };
    return store;
}

function make() {
    const store = stubStorage();
    const c = new (OptionsChatComponent as any)();
    c.setup();
    return { c, store };
}

afterEach(() => { delete (globalThis as any).localStorage; vi.unstubAllGlobals(); });

describe("OptionsChatComponent", () => {
    it("starts with both options on", () => {
        const { c } = make();
        expect(c.state.settings).toMatchObject({ sendRead: true, sendTyping: true });
    });

    it("toggles persist in options.chat", () => {
        const { c, store } = make();
        c.onToggle("sendRead", { target: { checked: false } });
        expect(chatSettings()).toMatchObject({ sendRead: false, sendTyping: true });
        expect(JSON.parse(store[CHAT_SETTINGS_KEY])).toMatchObject({ sendRead: false, sendTyping: true });
        expect(c.state.settings.sendRead).toBe(false);
        c.onToggle("sendTyping", { target: { checked: false } });
        expect(chatSettings()).toMatchObject({ sendRead: false, sendTyping: false });
        c.onToggle("sendRead", { target: { checked: true } });
        expect(chatSettings()).toMatchObject({ sendRead: true, sendTyping: false });
    });
});

describe("OptionsChatComponent global mute", () => {
    function makeMute(sources: any[], global: string | null = null) {
        stubStorage();
        const c = new (OptionsChatComponent as any)();
        const bus = new EventBus();
        const chat = {
            sources: vi.fn().mockResolvedValue(sources),
            globalMute: vi.fn().mockResolvedValue(undefined),
            repo: { sourceState: vi.fn(async () => ({ globalMuteUntil: global })) },
        };
        c.env = { eventBus: bus };
        Object.defineProperty(c, "chatService", { value: chat });
        c.setup();
        return { c, chat, bus };
    }
    const src = (id: string) => ({ configId: id, label: id, creds: {} });

    it("says unavailable without a server", async () => {
        const { c } = makeMute([]);
        await c.loadSources();
        expect(c.state.mode).toBe("unavailable");
    });

    it("offers the six durations and sets one through globalMute", async () => {
        const { c, chat } = makeMute([src("a")]);
        await c.loadSources();
        expect(c.state.mode).toBe("none");
        expect(c.muteChoices.map((m: any) => m.minutes)).toEqual([15, 60, 180, 480, 1440, -1]);
        await c.onMute(60);
        expect(chat.globalMute).toHaveBeenCalledWith(expect.objectContaining({ configId: "a" }), 60);
        await c.onMute(-1);
        expect(chat.globalMute).toHaveBeenLastCalledWith(expect.anything(), -1);
    });

    it("clears with Réactiver and shows the state", async () => {
        const future = new Date(Date.now() + 3600000).toISOString().slice(0, 19).replace("T", " ");
        const { c, chat } = makeMute([src("a")], future);
        await c.loadSources();
        expect(c.state.muted).toBe(true);
        await c.onUnmute();
        expect(chat.globalMute).toHaveBeenCalledWith(expect.anything(), false);
    });

    it("targets the chosen server among several", async () => {
        const { c, chat } = makeMute([src("a"), src("b")]);
        await c.loadSources();
        expect(c.state.mode).toBe("chips");
        c.onServer("b");
        await c.onMute(15);
        expect(chat.globalMute).toHaveBeenCalledWith(expect.objectContaining({ configId: "b" }), 15);
    });

    it("refreshes on CHAT_CHANGED and stops after unmount", async () => {
        const { c, chat, bus } = makeMute([src("a")]);
        await c.loadSources();
        chat.repo.sourceState.mockClear();
        c._onChanged(new CustomEvent("x", { detail: { configId: "a" } }));
        expect(chat.repo.sourceState).toHaveBeenCalledTimes(1);
        c._onChanged(new CustomEvent("x", { detail: { configId: "z" } }));
        expect(chat.repo.sourceState).toHaveBeenCalledTimes(1);
        expect(bus).toBeDefined();
    });

    it("shows a notice when the call fails", async () => {
        const { c, chat } = makeMute([src("a")]);
        await c.loadSources();
        chat.globalMute.mockRejectedValue(new Error("boom"));
        vi.spyOn(console, "warn").mockImplementation(() => {});
        await c.onMute(15);
        expect(c.state.error).not.toBe("");
        expect(c.state.busy).toBe(false);
    });
});

describe("OptionsChatComponent attachment cache", () => {
    function makeCache(bytes = 0, warning = false) {
        const store = stubStorage();
        const c = new (OptionsChatComponent as any)();
        const attachments = {
            space: vi.fn(async () => bytes),
            warning: vi.fn(async () => warning),
            clear: vi.fn().mockResolvedValue(undefined),
        };
        Object.defineProperty(c, "chatService", { value: { attachments } });
        c.env = { eventBus: new EventBus() };
        c.setup();
        return { c, store, attachments };
    }

    it("defaults: purge off, 2048 MB, no compression question", () => {
        const { c } = makeCache();
        expect(c.state.settings).toMatchObject({ cachePurge: false, cacheLimitMb: 2048, askCompress: false });
    });

    it("shows the total space and the 80 % warning", async () => {
        const { c, attachments } = makeCache(3 * 1024 * 1024, true);
        await c.loadCache();
        expect(attachments.space).toHaveBeenCalledWith();
        expect(c.state.spaceText).toBe("3\u00a0MB");
        expect(c.state.cacheWarn).toBe(true);
    });

    it("the purge switch and the compression question persist", () => {
        const { c, store } = makeCache();
        c.onToggle("cachePurge", { target: { checked: true } });
        c.onToggle("askCompress", { target: { checked: true } });
        expect(JSON.parse(store[CHAT_SETTINGS_KEY])).toMatchObject({ cachePurge: true, askCompress: true });
        expect(c.state.settings.cachePurge).toBe(true);
    });

    it("a valid limit is saved on change and the warning is read again", async () => {
        const { c, store, attachments } = makeCache();
        await c.onLimitChange({ target: { value: "512" } });
        expect(JSON.parse(store[CHAT_SETTINGS_KEY]).cacheLimitMb).toBe(512);
        expect(c.state.settings.cacheLimitMb).toBe(512);
        expect(attachments.warning).toHaveBeenCalled();
    });

    it("a limit is rounded to a whole number of MB and capped", async () => {
        const { c, store } = makeCache();
        await c.onLimitChange({ target: { value: "512.6" } });
        expect(JSON.parse(store[CHAT_SETTINGS_KEY]).cacheLimitMb).toBe(513);
        await c.onLimitChange({ target: { value: "99999999999" } });
        expect(JSON.parse(store[CHAT_SETTINGS_KEY]).cacheLimitMb).toBe(1048576);
        const target = { value: "0.2" };
        await c.onLimitChange({ target });
        expect(JSON.parse(store[CHAT_SETTINGS_KEY]).cacheLimitMb).toBe(1048576);
        expect(target.value).toBe("1048576");
    });

    it("a burst of chat changes reads the space once", async () => {
        vi.useFakeTimers();
        try {
            const { c, attachments } = makeCache();
            const ev = new CustomEvent("chat_changed", { detail: { configId: "x" } });
            for (let i = 0; i < 5; i++) c._onChanged(ev);
            await vi.advanceTimersByTimeAsync(2000);
            expect(attachments.space).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it("a limit of 0, negative or not a number is refused and the input goes back", async () => {
        const { c, store } = makeCache();
        await c.onLimitChange({ target: { value: "512" } });
        for (const bad of ["0", "-5", "abc", ""]) {
            const target = { value: bad };
            await c.onLimitChange({ target });
            expect(target.value).toBe("512");
            expect(JSON.parse(store[CHAT_SETTINGS_KEY]).cacheLimitMb).toBe(512);
        }
    });

    it("Vider tout asks, says unsent files stay, then clears every account", async () => {
        const { c, attachments } = makeCache(1024);
        const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
        await c.onClearAll();
        expect(attachments.clear).not.toHaveBeenCalled();
        await c.onClearAll();
        expect(confirm.mock.calls[0][0]).toMatch(/not sent/);
        expect(attachments.clear).toHaveBeenCalledWith({});
        confirm.mockRestore();
    });
});
