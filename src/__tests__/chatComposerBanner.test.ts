// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

// The suite's Owl stub renders nothing: this file mounts the banner on the real Owl
vi.mock("@odoo/owl", async () => await import("../../node_modules/@odoo/owl/dist/owl.es.js"));

import { mount } from "@odoo/owl";
import { ChatComposerBannerComponent } from "../components/chat/chat_composer_banner_component";

function stubStorage(lang = "fr") {
    const store: Record<string, string> = { app_lang: lang };
    vi.stubGlobal("localStorage", {
        getItem: (k: string) => store[k] ?? null,
        setItem: (k: string, v: string) => { store[k] = v; },
        removeItem: (k: string) => { delete store[k]; },
    });
}

const TARGET = { messageId: 10, clientUuid: null };

describe("ChatComposerBannerComponent", () => {
    async function mounted(props: Record<string, unknown>) {
        stubStorage();
        const host = document.createElement("div");
        document.body.appendChild(host);
        const component = await mount(ChatComposerBannerComponent as any, host, { props, env: {}, dev: true } as any);
        return { host, destroy: () => (component as any).__owl__.app.destroy() };
    }

    afterEach(() => {
        document.body.innerHTML = "";
        vi.unstubAllGlobals();
    });

    it("a reply names the author and quotes the start of the message; ✕ cancels", async () => {
        const onCancel = vi.fn();
        const quote = { key: "m10", author: "Alice Martin", text: "On se voit demain ?", edited: false, state: "text" };
        const b = await mounted({ mode: { kind: "reply", target: TARGET }, quote, onCancel });
        expect(b.host.querySelector(".chat-banner__title")!.textContent).toBe("Réponse à Alice Martin");
        expect(b.host.querySelector(".chat-banner__quote")!.textContent).toBe("On se voit demain ?");
        const cancel = b.host.querySelector<HTMLButtonElement>(".chat-banner__cancel")!;
        expect(cancel.getAttribute("aria-label")).toBe("Annuler la réponse");
        cancel.click();
        expect(onCancel).toHaveBeenCalledTimes(1);
        b.destroy();
    });

    it("an edit says so, with or without a quote", async () => {
        const b = await mounted({ mode: { kind: "edit", target: TARGET }, quote: null, onCancel: vi.fn() });
        expect(b.host.querySelector(".chat-banner__title")!.textContent).toBe("Modification du message");
        expect(b.host.querySelector(".chat-banner__quote")).toBeNull();
        expect(b.host.querySelector(".chat-banner__cancel")!.getAttribute("aria-label")).toBe("Annuler la modification");
        b.destroy();
    });
});
