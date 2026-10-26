// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

// The suite's Owl stub renders nothing: this file mounts the menu on the real Owl
vi.mock("@odoo/owl", async () => await import("../../node_modules/@odoo/owl/dist/owl.es.js"));

import { mount } from "@odoo/owl";
import { ChatMessageMenuComponent, type MessageCan } from "../components/chat/chat_message_menu_component";

function stubStorage(lang = "fr") {
    const store: Record<string, string> = { app_lang: lang };
    vi.stubGlobal("localStorage", {
        getItem: (k: string) => store[k] ?? null,
        setItem: (k: string, v: string) => { store[k] = v; },
        removeItem: (k: string) => { delete store[k]; },
    });
}

const QUICK = ["👍", "❤️", "😂", "😮", "😢", "🙏"];
const OWN: MessageCan = { react: true, reply: true, copy: true, edit: true, delete: true };
const OTHERS: MessageCan = { react: true, reply: true, copy: true, edit: false, delete: false };

describe("ChatMessageMenuComponent", () => {
    let back: ReturnType<typeof vi.spyOn>;

    async function mounted(can: MessageCan, active: string[] = []) {
        stubStorage();
        back = vi.spyOn(window.history, "back").mockImplementation(() => {});
        const host = document.createElement("div");
        document.body.appendChild(host);
        const props = {
            quick: QUICK, active, can,
            onReact: vi.fn(), onMore: vi.fn(), onReply: vi.fn(), onCopy: vi.fn(),
            onEdit: vi.fn(), onDelete: vi.fn(), onClose: vi.fn(),
        };
        const component = await mount(ChatMessageMenuComponent as any, host, { props, env: {} } as any);
        const app = { destroy: () => (component as any).__owl__.app.destroy() };
        return { host, props, app };
    }

    /** The browser's answer to the back the menu asked: its entry is gone. */
    function popped() {
        const rest = { ...(window.history.state ?? {}) };
        delete rest.chatMenu;
        window.history.replaceState(rest, "");
        window.dispatchEvent(new PopStateEvent("popstate", { state: rest }));
    }

    afterEach(() => {
        back.mockRestore();
        document.body.innerHTML = "";
        window.history.replaceState({}, "");
    });

    it("takes the focus from the button that opened it and gives it back on close", async () => {
        const opener = document.createElement("button");
        document.body.appendChild(opener);
        opener.focus();
        const { host, app } = await mounted(OWN);
        expect(document.activeElement).toBe(host.querySelector(".chat-menu"));
        app.destroy();
        expect(document.activeElement).toBe(opener);
    });

    it("leaves the focus in the composer: its keyboard stays open", async () => {
        const field = document.createElement("textarea");
        document.body.appendChild(field);
        field.focus();
        const { app } = await mounted(OWN);
        expect(document.activeElement).toBe(field);
        app.destroy();
        expect(document.activeElement).toBe(field);
    });

    it("a choice that moves the focus (Reply to the composer) keeps it there", async () => {
        const opener = document.createElement("button");
        const field = document.createElement("textarea");
        document.body.append(opener, field);
        opener.focus();
        const { host, props, app } = await mounted(OWN);
        props.onReply.mockImplementation(() => field.focus());
        host.querySelector<HTMLElement>(".chat-menu__reply")!.click();
        app.destroy();
        expect(document.activeElement).toBe(field);
    });

    it("hides Edit and Delete on another's message, offers them on one's own", async () => {
        const others = await mounted(OTHERS);
        const labels = (h: HTMLElement) => [...h.querySelectorAll(".chat-menu__item")].map((b) => b.textContent);
        expect(labels(others.host)).toEqual(["Répondre", "Copier", "Fermer"]);
        others.app.destroy();
        const own = await mounted(OWN);
        expect(labels(own.host)).toEqual(["Répondre", "Copier", "Modifier", "Supprimer", "Fermer"]);
        const dialog = own.host.querySelector(".chat-menu")!;
        expect(dialog.getAttribute("role")).toBe("dialog");
        expect(dialog.getAttribute("aria-label")).toBe("Actions du message");
        own.app.destroy();
    });

    it("without react, no quick bar; copy alone stays for a notification", async () => {
        const { host, app } = await mounted({ react: false, reply: false, copy: true, edit: false, delete: false });
        expect(host.querySelector(".chat-menu__quick")).toBeNull();
        expect([...host.querySelectorAll(".chat-menu__item")].map((b) => b.textContent)).toEqual(["Copier", "Fermer"]);
        app.destroy();
    });

    it("shows the six quick emojis then « … », the user's own pressed", async () => {
        const { host, app } = await mounted(OWN, ["😂"]);
        const emojis = [...host.querySelectorAll<HTMLElement>(".chat-menu__emoji")];
        expect(emojis.map((b) => b.textContent)).toEqual([...QUICK, "…"]);
        expect(emojis[0].getAttribute("aria-label")).toBe("Réagir avec 👍");
        expect(emojis.map((b) => b.getAttribute("aria-pressed"))).toEqual(["false", "false", "true", "false", "false", "false", null]);
        app.destroy();
    });

    it("a quick emoji reacts, then closes over its history entry once", async () => {
        const { host, props, app } = await mounted(OWN);
        expect(window.history.state?.chatMenu).toBe(true);
        host.querySelectorAll<HTMLElement>(".chat-menu__emoji")[1].click();
        expect(props.onReact).toHaveBeenCalledWith("❤️");
        expect(back).toHaveBeenCalledTimes(1);
        expect(props.onClose).not.toHaveBeenCalled();
        host.querySelector<HTMLElement>(".chat-menu__close")!.click();
        expect(back).toHaveBeenCalledTimes(1);
        popped();
        expect(props.onClose).toHaveBeenCalledTimes(1);
        app.destroy();
    });

    it("« … » asks for the picker, then closes", async () => {
        const { host, props, app } = await mounted(OWN);
        host.querySelector<HTMLElement>(".chat-menu__more")!.click();
        expect(props.onMore).toHaveBeenCalledTimes(1);
        expect(props.onReact).not.toHaveBeenCalled();
        expect(back).toHaveBeenCalledTimes(1);
        app.destroy();
    });

    it("each action calls its prop inside the tap, then closes", async () => {
        const { host, props, app } = await mounted(OWN);
        const item = (cls: string) => host.querySelector<HTMLElement>(".chat-menu__" + cls)!;
        item("copy").click();
        expect(props.onCopy).toHaveBeenCalledTimes(1);
        expect(back).toHaveBeenCalledTimes(1);
        app.destroy();
        for (const [cls, prop] of [["reply", "onReply"], ["edit", "onEdit"], ["delete", "onDelete"]] as const) {
            const m = await mounted(OWN);
            m.host.querySelector<HTMLElement>(".chat-menu__" + cls)!.click();
            expect(m.props[prop]).toHaveBeenCalledTimes(1);
            m.app.destroy();
        }
    });

    it("Android's back closes it; a back from a sheet above it does not", async () => {
        const { props, app } = await mounted(OWN);
        // A sheet above the menu goes back: the entry it lands on carries the menu's mark
        window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
        expect(props.onClose).not.toHaveBeenCalled();
        popped();
        expect(props.onClose).toHaveBeenCalledTimes(1);
        app.destroy();
    });

    it("the shade closes on a tap that started on it, not on the release of the long press", async () => {
        const { host, app } = await mounted(OWN);
        const shade = host.querySelector<HTMLElement>(".chat-sheet")!;
        shade.click();
        expect(back).not.toHaveBeenCalled();
        shade.dispatchEvent(new Event("pointerdown", { bubbles: true }));
        shade.click();
        expect(back).toHaveBeenCalledTimes(1);
        app.destroy();
    });

    it("Escape closes; removed without a back, its entry loses its mark", async () => {
        const { app } = await mounted(OWN);
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
        expect(back).toHaveBeenCalledTimes(1);
        app.destroy();
        const again = await mounted(OWN);
        back.mockClear();
        expect(window.history.state?.chatMenu).toBe(true);
        again.app.destroy();
        expect(window.history.state?.chatMenu).toBeUndefined();
        expect(back).not.toHaveBeenCalled();
    });
});
