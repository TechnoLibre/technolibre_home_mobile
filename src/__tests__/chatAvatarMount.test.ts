// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

// The suite's Owl stub renders nothing: this file mounts the avatar on the real Owl
vi.mock("@odoo/owl", async () => await import("../../node_modules/@odoo/owl/dist/owl.es.js"));

import { mount } from "@odoo/owl";
import { ChatAvatarComponent, ThreadAvatars } from "../components/chat/chat_avatar_component";

const flush = async () => {
    for (let i = 0; i < 30; i++) await Promise.resolve();
};

describe("ChatAvatarComponent mounted", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        document.body.innerHTML = "";
    });

    async function mounted(avatar: string | null) {
        const avatars = new ThreadAvatars({
            avatars: () => ({ fetch: vi.fn(async () => null) }),
            cached: async () => [],
            files: () => ({ webUrl: async (rel: string) => "http://localhost/" + rel }),
            onTick: vi.fn(),
        });
        const observe = vi.spyOn(avatars, "observe");
        const broken = vi.spyOn(avatars, "broken");
        const host = document.createElement("div");
        document.body.appendChild(host);
        const author = { partnerId: 7, name: "Alice Martin", initials: "AM", hue: 120, avatar };
        const component: any = await mount(ChatAvatarComponent as any, host, { props: { author, avatars }, env: {} } as any);
        return { host, observe, broken, component };
    }

    it("initials on the partner's hue, hidden from readers, followed on screen", async () => {
        const { host, observe } = await mounted(null);
        const el = host.querySelector(".chat-thread__author-avatar") as HTMLElement;
        expect(el.getAttribute("aria-hidden")).toBe("true");
        expect(el.textContent!.trim()).toBe("AM");
        expect(el.getAttribute("style")).toContain("hsl(120");
        expect(host.querySelector("img")).toBeNull();
        expect(observe).toHaveBeenCalledWith(el, 7);
    });

    it("the image once cached; an image that does not display reports its partner", async () => {
        const { host, broken } = await mounted("http://localhost/chat/d/avatars/7_1.svg");
        const img = host.querySelector("img.chat-thread__author-img") as HTMLImageElement;
        expect(img.getAttribute("src")).toBe("http://localhost/chat/d/avatars/7_1.svg");
        expect(img.getAttribute("alt")).toBe("");
        img.dispatchEvent(new Event("error"));
        await flush();
        expect(broken).toHaveBeenCalledWith(7);
    });
});
