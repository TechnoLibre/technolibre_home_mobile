// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

// The suite's Owl stub renders nothing: this file mounts the list on the real Owl
vi.mock("@odoo/owl", async () => await import("../../node_modules/@odoo/owl/dist/owl.es.js"));

import { mount } from "@odoo/owl";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ChatSuggestionsComponent } from "../components/chat/chat_suggestions_component";

function stubStorage(lang = "fr") {
    const store: Record<string, string> = { app_lang: lang };
    vi.stubGlobal("localStorage", {
        getItem: (k: string) => store[k] ?? null,
        setItem: (k: string, v: string) => { store[k] = v; },
        removeItem: (k: string) => { delete store[k]; },
    });
}

describe("ChatSuggestionsComponent", () => {
    async function mounted(props: Record<string, unknown>) {
        stubStorage();
        const host = document.createElement("div");
        document.body.appendChild(host);
        const component = await mount(ChatSuggestionsComponent as any, host, { props, env: {}, dev: true } as any);
        return { host, destroy: () => (component as any).__owl__.app.destroy() };
    }

    afterEach(() => {
        document.body.innerHTML = "";
        vi.unstubAllGlobals();
    });

    it("lists people, channels under their parent and @everyone; a tap picks without taking the focus", async () => {
        const onPick = vi.fn();
        const items = [
            { kind: "partner", id: 7, name: "Alice Roy" },
            { kind: "channel", id: 4, name: "sous-fil", parentName: "général-test" },
            { kind: "special", label: "everyone" },
        ];
        const b = await mounted({ items, onPick });
        const list = b.host.querySelector(".chat-suggest")!;
        expect(list.getAttribute("aria-label")).toBe("Suggestions");
        const buttons = [...b.host.querySelectorAll<HTMLButtonElement>(".chat-suggest__item")];
        expect(buttons.map((x) => x.querySelector(".chat-suggest__name")!.textContent)).toEqual([
            "@Alice Roy", "#général-test > sous-fil", "@everyone",
        ]);
        expect(buttons[2].querySelector(".chat-suggest__note")!.textContent).toBe("Notifier tout le monde");
        const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
        buttons[0].dispatchEvent(down);
        expect(down.defaultPrevented).toBe(true);
        buttons[1].click();
        expect(onPick).toHaveBeenCalledWith(items[1]);
        b.destroy();
    });

    it("the list scrolls inside a capped height, so the field stays in view", () => {
        const scss = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", "components", "chat", "chat_suggestions_component.scss"), "utf8");
        expect(scss).toMatch(/max-height:/);
        expect(scss).toMatch(/overflow-y: auto/);
        const all = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", "css", "components.scss"), "utf8");
        expect(all).toMatch(/@use "\.\.\/components\/chat\/chat_suggestions_component\.scss";/);
    });
});
