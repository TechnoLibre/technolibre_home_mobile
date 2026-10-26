// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

// The suite's Owl stub renders nothing: this file mounts the picker on the real Owl
vi.mock("@odoo/owl", async () => await import("../../node_modules/@odoo/owl/dist/owl.es.js"));

import { mount } from "@odoo/owl";
import { ChatEmojiPickerComponent } from "../components/chat/chat_emoji_picker_component";

function stubStorage(lang = "en") {
    const store: Record<string, string> = { app_lang: lang };
    vi.stubGlobal("localStorage", {
        getItem: (k: string) => store[k] ?? null,
        setItem: (k: string, v: string) => { store[k] = v; },
        removeItem: (k: string) => { delete store[k]; },
    });
}

describe("ChatEmojiPickerComponent mounted", () => {
    async function mounted(lang = "en") {
        stubStorage(lang);
        const host = document.createElement("div");
        document.body.appendChild(host);
        const props = { onPick: vi.fn(), onClose: vi.fn() };
        const component = await mount(ChatEmojiPickerComponent as any, host, { props, env: {} } as any);
        const app = { destroy: () => (component as any).__owl__.app.destroy() };
        return { host, props, app };
    }

    afterEach(() => { document.body.innerHTML = ""; });

    it("first render draws one section; the others follow; labels are in the UI language", async () => {
        const { host, app } = await mounted("fr");
        await vi.waitFor(() => expect(host.querySelector(".chat-emoji__tab")).not.toBeNull());
        const grids = () => host.querySelectorAll(".chat-emoji__sections .chat-emoji__grid").length;
        expect(grids()).toBeLessThan(8);
        expect(host.querySelector(".chat-emoji__close")!.getAttribute("aria-label")).toBe("Fermer les émojis");
        expect(host.querySelector(".chat-emoji__item")!.getAttribute("aria-label")).toBe("visage rieur");
        await vi.waitFor(() => expect(grids()).toBe(8));
        app.destroy();
    });

    it("a search shows the found emojis, clearing it redraws one section at once, not all", async () => {
        const { host, app } = await mounted("fr");
        await vi.waitFor(() => expect(host.querySelectorAll(".chat-emoji__sections .chat-emoji__grid").length).toBe(8));
        const input = host.querySelector<HTMLInputElement>(".chat-emoji__search")!;
        input.value = "rieur";
        input.dispatchEvent(new Event("input"));
        await vi.waitFor(() => expect(host.querySelector(".chat-emoji__sections")).toBeNull());
        expect([...host.querySelectorAll(".chat-emoji__item")].map((e) => e.textContent)).toContain("😀");
        input.value = "";
        input.dispatchEvent(new Event("input"));
        await vi.waitFor(() => expect(host.querySelector(".chat-emoji__sections")).not.toBeNull());
        expect(host.querySelectorAll(".chat-emoji__sections .chat-emoji__grid").length).toBeLessThan(8);
        await vi.waitFor(() => expect(host.querySelectorAll(".chat-emoji__sections .chat-emoji__grid").length).toBe(8));
        app.destroy();
    });

    it("a tab draws every section", async () => {
        const { host, app } = await mounted();
        await vi.waitFor(() => expect(host.querySelector(".chat-emoji__tab")).not.toBeNull());
        const tabs = host.querySelectorAll<HTMLElement>(".chat-emoji__tab");
        tabs[tabs.length - 1].click();
        await vi.waitFor(() => expect(host.querySelectorAll(".chat-emoji__sections .chat-emoji__grid").length).toBe(8));
        app.destroy();
    });

    it("Escape and ✕ go back over the picker's entry once; its popstate closes", async () => {
        const { host, props, app } = await mounted();
        const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
        host.querySelector<HTMLElement>(".chat-emoji__close")!.click();
        expect(back).toHaveBeenCalledTimes(1);
        expect(props.onClose).not.toHaveBeenCalled();
        // The browser lands on the entry under the picker's
        window.history.replaceState({}, "");
        window.dispatchEvent(new PopStateEvent("popstate"));
        expect(props.onClose).toHaveBeenCalledTimes(1);
        back.mockRestore();
        app.destroy();
    });

    it("a back from a sheet opened above it leaves it open", async () => {
        const { props, app } = await mounted();
        // A sheet above it goes back: the entry now current is the picker's own, mark included
        expect(window.history.state?.chatEmoji).toBe(true);
        window.dispatchEvent(new PopStateEvent("popstate"));
        expect(props.onClose).not.toHaveBeenCalled();
        window.history.replaceState({}, "");
        window.dispatchEvent(new PopStateEvent("popstate"));
        expect(props.onClose).toHaveBeenCalledTimes(1);
        app.destroy();
    });
});
