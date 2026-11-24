// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

// The suite's Owl stub renders nothing: this file mounts the chips on the real Owl
vi.mock("@odoo/owl", async () => await import("../../node_modules/@odoo/owl/dist/owl.es.js"));

import { mount } from "@odoo/owl";
import {
    ChatReactionsComponent,
    ChatReactionWhoComponent,
    reactionViews,
    type ReactionView,
} from "../components/chat/chat_reactions_component";
import { LONG_PRESS_MS } from "../components/chat/chatLongPress";

function stubStorage(lang = "fr") {
    const store: Record<string, string> = { app_lang: lang };
    vi.stubGlobal("localStorage", {
        getItem: (k: string) => store[k] ?? null,
        setItem: (k: string, v: string) => { store[k] = v; },
        removeItem: (k: string) => { delete store[k]; },
    });
}

const group = (content: string, p: any = {}) => ({
    configId: "a", channelId: 5, messageKey: "m10", messageId: 10, content, count: 1,
    selfReacted: false, partnerIds: [7], guestCount: 0, sequence: 1, ...p,
});

function pointer(type: string, x = 0, y = 0) {
    const ev = new Event(type, { bubbles: true }) as any;
    ev.clientX = x;
    ev.clientY = y;
    ev.button = 0;
    return ev;
}

describe("reactionViews", () => {
    it("names the partners by their cached name, an unnamed one as someone, then each guest", () => {
        stubStorage();
        const names = new Map([[7, "Alice Martin"], [1, "Moi Test"]]);
        expect(reactionViews([
            group("👍", { count: 4, selfReacted: true, partnerIds: [1, 7, 9], guestCount: 1 }),
        ], names)).toEqual([
            { content: "👍", count: 4, self: true, names: ["Moi Test", "Alice Martin", "Quelqu'un", "Invité"] },
        ]);
    });
});

describe("reactionViews and the user", () => {
    it("names the user by the cached name, else « Vous », and puts them in when the group says they reacted", () => {
        stubStorage();
        const names = new Map([[7, "Alice Martin"]]);
        expect(reactionViews([
            group("👍", { count: 2, selfReacted: true, partnerIds: [1, 7] }),
            group("😂", { count: 2, selfReacted: true, partnerIds: [7] }),
        ], names, 1).map((v) => v.names)).toEqual([["Vous", "Alice Martin"], ["Vous", "Alice Martin"]]);
        expect(reactionViews([group("👍", { selfReacted: true, partnerIds: [1] })], new Map([[1, "Moi Test"]]), 1)[0].names)
            .toEqual(["Moi Test"]);
    });
});

describe("ChatReactionsComponent", () => {
    async function mounted(reactions: ReactionView[]) {
        stubStorage();
        const host = document.createElement("div");
        document.body.appendChild(host);
        const outer = vi.fn();
        host.addEventListener("pointerdown", outer);
        const props = { reactions, onToggle: vi.fn(), onWho: vi.fn() };
        const component = await mount(ChatReactionsComponent as any, host, { props, env: {} } as any);
        const app = { destroy: () => (component as any).__owl__.app.destroy() };
        return { host, props, app, outer };
    }

    afterEach(() => {
        vi.useRealTimers();
        document.body.innerHTML = "";
    });

    const own: ReactionView = { content: "👍", count: 2, self: true, names: ["Moi Test", "Alice Martin"] };
    const theirs: ReactionView = { content: "😂", count: 1, self: false, names: ["Alice Martin"] };

    it("shows each chip with its emoji and count, labelled with whether the user reacted", async () => {
        const { host, app } = await mounted([own, theirs]);
        const chips = [...host.querySelectorAll<HTMLElement>(".chat-reactions__chip")];
        expect(chips.map((c) => c.textContent!.replace(/\s+/g, ""))).toEqual(["👍2", "😂1"]);
        expect(chips.map((c) => c.getAttribute("aria-label"))).toEqual(["👍 : 2, dont vous", "😂 : 1"]);
        expect(chips.map((c) => c.getAttribute("aria-pressed"))).toEqual(["true", "false"]);
        expect(chips[0].classList.contains("chat-reactions__chip--self")).toBe(true);
        app.destroy();
    });

    it("a tap toggles: the own reaction and another's are both handed to onToggle", async () => {
        const { host, props, app } = await mounted([own, theirs]);
        const chips = host.querySelectorAll<HTMLElement>(".chat-reactions__chip");
        chips[0].click();
        chips[1].click();
        expect(props.onToggle.mock.calls).toEqual([["👍"], ["😂"]]);
        expect(props.onWho).not.toHaveBeenCalled();
        app.destroy();
    });

    it("a long press asks who reacted, its release toggles nothing, and the bubble never hears it", async () => {
        const { host, props, app, outer } = await mounted([own, theirs]);
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const chip = host.querySelectorAll<HTMLElement>(".chat-reactions__chip")[1];
        chip.dispatchEvent(pointer("pointerdown", 5, 5));
        vi.advanceTimersByTime(LONG_PRESS_MS);
        expect(props.onWho).toHaveBeenCalledWith("😂");
        chip.dispatchEvent(pointer("pointerup", 5, 5));
        chip.click();
        expect(props.onToggle).not.toHaveBeenCalled();
        expect(outer).not.toHaveBeenCalled();
        chip.click();
        expect(props.onToggle).toHaveBeenCalledWith("😂");
        app.destroy();
    });
});

describe("ChatReactionWhoComponent", () => {
    afterEach(() => {
        document.body.innerHTML = "";
        window.history.replaceState({}, "");
    });

    it("lists who reacted in a dialog; back closes it over its own history entry", async () => {
        stubStorage();
        const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
        const host = document.createElement("div");
        document.body.appendChild(host);
        const props = { reaction: { content: "👍", count: 3, self: false, names: ["Alice Martin", "Bob Test", "Invité"] }, onClose: vi.fn() };
        const component = await mount(ChatReactionWhoComponent as any, host, { props, env: {} } as any);
        const dialog = host.querySelector(".chat-who")!;
        expect(dialog.getAttribute("role")).toBe("dialog");
        expect(dialog.getAttribute("aria-label")).toBe("Qui a réagi avec 👍");
        expect([...host.querySelectorAll(".chat-who__names li")].map((li) => li.textContent)).toEqual(["Alice Martin", "Bob Test", "Invité"]);
        expect(window.history.state?.chatWho).toBe(true);
        host.querySelector<HTMLElement>(".chat-menu__close")!.click();
        expect(back).toHaveBeenCalledTimes(1);
        window.history.replaceState({}, "");
        window.dispatchEvent(new PopStateEvent("popstate", { state: {} }));
        expect(props.onClose).toHaveBeenCalledTimes(1);
        back.mockRestore();
        (component as any).__owl__.app.destroy();
    });

    it("gives the focus back to the chip that opened it on close", async () => {
        stubStorage();
        const chip = document.createElement("button");
        document.body.appendChild(chip);
        chip.focus();
        const host = document.createElement("div");
        document.body.appendChild(host);
        const props = { reaction: { content: "👍", count: 1, self: false, names: ["Alice Martin"] }, onClose: vi.fn() };
        const component = await mount(ChatReactionWhoComponent as any, host, { props, env: {} } as any);
        expect(document.activeElement).toBe(host.querySelector(".chat-who"));
        (component as any).__owl__.app.destroy();
        expect(document.activeElement).toBe(chip);
    });
});
