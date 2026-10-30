// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The suite's Owl stub renders nothing: this file mounts the screen on the real Owl
vi.mock("@odoo/owl", async () => await import("../../node_modules/@odoo/owl/dist/owl.es.js"));
vi.mock("@capacitor/app", () => ({ App: { addListener: vi.fn(async () => ({ remove: vi.fn(async () => {}) })) } }));

import { mount } from "@odoo/owl";
import { OptionsChatNotificationsComponent } from "../components/options/chat_notifications/options_chat_notifications_component";
import { fakeChatPushNative } from "../__mocks__/chatPushNative";

const A = "https://odoo.exemple.test|alice|demo";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scss = (path: string): string => readFileSync(resolve(ROOT, path), "utf8");

/** The declarations of the first rule whose selector is exactly `selector`, "" when absent. */
function rule(css: string, selector: string): string {
    const at = css.indexOf(`${selector} {`);
    if (at < 0) return "";
    return css.slice(css.indexOf("{", at) + 1, css.indexOf("}", at));
}

function stubStorage() {
    const store: Record<string, string> = { app_lang: "fr" };
    vi.stubGlobal("localStorage", {
        getItem: (k: string) => store[k] ?? null,
        setItem: (k: string, v: string) => { store[k] = v; },
        removeItem: (k: string) => { delete store[k]; },
    });
}

async function mounted() {
    stubStorage();
    const native = fakeChatPushNative();
    const row = {
        configId: A, ntfyUrl: "https://ntfy.exemple.test", odooNtfyUrl: null, registeredAt: null, lockScreen: "hidden_locked",
        filter: "all", inboxNotify: true, inboxMentions: false, quietOn: false, quietFrom: 1320, quietTo: 420,
    };
    const chat = {
        push: { native, registrationError: () => null, markOwed: () => false },
        sources: vi.fn().mockResolvedValue([{ configId: A, label: "odoo.exemple.test" }]),
        repo: { pushRows: vi.fn(async () => [row]) },
        features: vi.fn(async () => ({ appPush: true, pushFlags: true })),
    };
    const host = document.createElement("div");
    document.body.appendChild(host);
    const component: any = await mount(OptionsChatNotificationsComponent as any, host, { env: { syncService: { chat } } } as any);
    await component.load();
    host.querySelector<HTMLElement>(".options-sync__header")!.click();
    // Owl renders on the next animation frame
    for (let i = 0; i < 50 && !host.querySelector(".chat-notifications__card"); i++) await new Promise((r) => setTimeout(r, 10));
    return { host, destroy: () => component.__owl__.app.destroy() };
}

afterEach(() => {
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
});

describe("chat notification options at phone width", () => {
    it("every choice row of the screen is a wrapping row, none the chat's scrolling chips", async () => {
        const { host, destroy } = await mounted();
        const rows = [...host.querySelectorAll<HTMLElement>("[role=radiogroup] .chat-new__chip")].map((b) => b.parentElement!);
        const groups = [...new Set(rows)];
        // the browser mode, the lock screen and the filter
        expect(groups).toHaveLength(3);
        for (const g of groups) {
            expect(g.classList.contains("chat-notifications__choices")).toBe(true);
            expect(g.classList.contains("chat-new__chips")).toBe(false);
        }
        const browser = groups[0];
        expect([...browser.querySelectorAll(".chat-new__chip")].map((b) => b.textContent)).toContain("Ne pas envoyer au téléphone");
        // the account's actions (scan, paste, remove) wrap the same way
        const actions = host.querySelector(".chat-notifications__card .chat-notifications__choices:not([role])");
        expect(actions).not.toBeNull();
        expect(host.querySelector("#options-chat-notifications__body .chat-new__chips")).toBeNull();
        destroy();
    });

    it("the rows wrap and their labels break inside the chip, nothing cuts them", () => {
        const css = scss("components/options/chat_notifications/options_chat_notifications_component.scss");
        const row = rule(css, ".chat-notifications__choices");
        expect(row).toMatch(/display:\s*flex/);
        expect(row).toMatch(/flex-wrap:\s*wrap/);
        const chip = rule(css, ".chat-notifications__choices .chat-new__chip");
        expect(chip).toMatch(/white-space:\s*normal/);
        expect(chip).toMatch(/max-width:\s*100%/);
        for (const decl of [row, chip]) {
            expect(decl).not.toMatch(/nowrap|overflow(-x)?:\s*(hidden|auto|scroll)|text-overflow/);
        }
        // the chip rule outranks .chat-new__chip (nowrap), whichever sheet comes last
        expect(rule(scss("components/chat/chat_new_component.scss"), ".chat-new__chip,\n.chat-new__tab")).toMatch(/nowrap/);
        // the levels, already one per line, keep their full-width buttons with a wrapping description
        const level = rule(css, ".chat-notifications__level");
        expect(level).toMatch(/flex-direction:\s*column/);
        expect(level).not.toMatch(/nowrap|overflow/);
    });
});
