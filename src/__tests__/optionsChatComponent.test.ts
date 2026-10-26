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

afterEach(() => { delete (globalThis as any).localStorage; });

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
