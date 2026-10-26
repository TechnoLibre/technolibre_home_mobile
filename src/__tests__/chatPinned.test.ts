// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

// The suite's Owl stub renders nothing: this file mounts the panel on the real Owl
vi.mock("@odoo/owl", async () => await import("../../node_modules/@odoo/owl/dist/owl.es.js"));

import { mount } from "@odoo/owl";
import { ChatPinnedComponent, type PinnedItem } from "../components/chat/chat_pinned_component";

function stubStorage(lang = "fr") {
    const store: Record<string, string> = { app_lang: lang };
    vi.stubGlobal("localStorage", {
        getItem: (k: string) => store[k] ?? null,
        setItem: (k: string, v: string) => { store[k] = v; },
        removeItem: (k: string) => { delete store[k]; },
    });
}

const ITEMS: PinnedItem[] = [
    { key: "m600", author: "Alice Martin", snippet: "Réunion demain à 9 h", date: "10:02", unread: true },
    { key: "m590", author: "Bob Démo", snippet: "Le compte rendu est en pièce jointe", date: "hier", unread: false },
];

describe("ChatPinnedComponent", () => {
    let back: ReturnType<typeof vi.spyOn>;

    async function mounted(items: PinnedItem[], offline = false) {
        stubStorage();
        back = vi.spyOn(window.history, "back").mockImplementation(() => {});
        const host = document.createElement("div");
        document.body.appendChild(host);
        const props = { items, offline, onOpen: vi.fn(), onClose: vi.fn() };
        const component = await mount(ChatPinnedComponent as any, host, { props, env: {} } as any);
        const app = { destroy: () => (component as any).__owl__.app.destroy() };
        return { host, props, app };
    }

    afterEach(() => {
        back.mockRestore();
        document.body.innerHTML = "";
        window.history.replaceState({}, "");
        vi.unstubAllGlobals();
    });

    it("lists the pinned messages, the unread ones marked", async () => {
        const { host, app } = await mounted(ITEMS);
        const panel = host.querySelector(".chat-pinned")!;
        expect(panel.getAttribute("role")).toBe("dialog");
        expect(panel.getAttribute("aria-label")).toBe("Messages épinglés");
        expect(host.querySelector(".chat-pinned__title")!.textContent).toBe("Messages épinglés");
        const rows = [...host.querySelectorAll<HTMLElement>(".chat-pinned__item")];
        expect(rows.map((r) => [
            r.querySelector(".chat-pinned__author")!.textContent,
            r.querySelector(".chat-pinned__date")!.textContent,
            r.querySelector(".chat-pinned__snippet")!.textContent,
            r.classList.contains("chat-pinned__item--unread"),
        ])).toEqual([
            ["Alice Martin", "10:02", "Réunion demain à 9 h", true],
            ["Bob Démo", "hier", "Le compte rendu est en pièce jointe", false],
        ]);
        expect(rows[0].querySelector(".chat-pinned__unread")!.textContent).toBe("Non lu");
        expect(rows[1].querySelector(".chat-pinned__unread")).toBeNull();
        expect(host.querySelector(".chat-pinned__offline")).toBeNull();
        expect(host.querySelector(".chat-pinned__none")).toBeNull();
        app.destroy();
    });

    it("a tap opens the message, then closes over its history entry", async () => {
        const { host, props, app } = await mounted(ITEMS);
        host.querySelectorAll<HTMLElement>(".chat-pinned__item")[1].click();
        expect(props.onOpen).toHaveBeenCalledWith("m590");
        expect(back).toHaveBeenCalledTimes(1);
        // Android's back: its entry gone, the panel is closed
        const rest = { ...(window.history.state ?? {}) };
        delete rest.chatPinned;
        window.history.replaceState(rest, "");
        window.dispatchEvent(new PopStateEvent("popstate", { state: rest }));
        expect(props.onClose).toHaveBeenCalledTimes(1);
        app.destroy();
    });

    it("says when nothing is pinned, and when the list is the phone's alone", async () => {
        const { host, app } = await mounted([], true);
        expect(host.querySelector(".chat-pinned__none")!.textContent).toBe("Aucun message épinglé.");
        expect(host.querySelector(".chat-pinned__offline")!.textContent).toBe("Hors ligne : la liste gardée sur le téléphone.");
        host.querySelector<HTMLElement>(".chat-menu__close")!.click();
        expect(back).toHaveBeenCalledTimes(1);
        app.destroy();
    });

    it("Escape closes it", async () => {
        const { app } = await mounted(ITEMS);
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
        expect(back).toHaveBeenCalledTimes(1);
        app.destroy();
    });
});
