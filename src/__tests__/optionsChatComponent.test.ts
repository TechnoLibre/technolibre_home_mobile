// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";

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
        expect(c.state.settings).toEqual({ sendRead: true, sendTyping: true });
    });

    it("toggles persist in options.chat", () => {
        const { c, store } = make();
        c.onToggle("sendRead", { target: { checked: false } });
        expect(chatSettings()).toEqual({ sendRead: false, sendTyping: true });
        expect(JSON.parse(store[CHAT_SETTINGS_KEY])).toEqual({ sendRead: false, sendTyping: true });
        expect(c.state.settings.sendRead).toBe(false);
        c.onToggle("sendTyping", { target: { checked: false } });
        expect(chatSettings()).toEqual({ sendRead: false, sendTyping: false });
        c.onToggle("sendRead", { target: { checked: true } });
        expect(chatSettings()).toEqual({ sendRead: true, sendTyping: false });
    });
});
