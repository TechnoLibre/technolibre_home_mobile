// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// vitest.config.ts aliases @odoo/owl to src/__mocks__: hooks are no-ops, so
// setup() then the loaders are called by hand.
import { ChatListComponent } from "../components/chat/chat_list_component";
import { HomeComponent } from "../components/home/home_component";
import { EventBus } from "@odoo/owl";
import { Events } from "../constants/events";

function stubLocale() {
    const store: Record<string, string> = { app_lang: "en" };
    vi.stubGlobal("localStorage", {
        getItem: (k: string) => store[k] ?? null,
        setItem: (k: string, v: string) => { store[k] = v; },
        removeItem: (k: string) => { delete store[k]; },
    });
}

const src = (id: string) => ({ configId: id, label: id, app: {}, creds: {} });
const chan = (configId: string, channelId: number, p: any = {}) => ({
    configId, channelId, channelType: "channel", name: "c" + channelId,
    unreadCounter: 0, needactionCounter: 0, lastInterestDt: "2020-01-01 10:00:00",
    correspondentPartnerId: null, lastMessageId: null, ...p,
});

function fakeChat(ids: string[], channels: any[], unread: Record<string, number> = {}) {
    return {
        sources: vi.fn().mockResolvedValue(ids.map(src)),
        load: vi.fn().mockResolvedValue(undefined),
        conversations: vi.fn(async (cfg?: string[]) =>
            channels.filter((c) => !cfg || cfg.includes(c.configId))),
        unreadTotal: vi.fn(async (cfg?: string[]) =>
            (cfg ?? ids).reduce((s, id) => s + (unread[id] ?? 0), 0)),
        repo: {
            partners: vi.fn().mockResolvedValue([{ partnerId: 7, name: "Alice Roy" }]),
            messages: vi.fn().mockResolvedValue([]),
        },
    };
}

function make(chat: any) {
    stubLocale();
    const c = new (ChatListComponent as any)();
    c.env = { chatService: { ...chat }, eventBus: new EventBus() };
    Object.defineProperty(c, "chatService", { value: chat });
    c.setup();
    return c;
}

afterEach(() => vi.unstubAllGlobals());

describe("ChatListComponent", () => {
    it("mode follows the number of sources", async () => {
        const modes: string[] = [];
        for (const n of [0, 1, 3, 6]) {
            const ids = Array.from({ length: n }, (_, i) => "s" + i);
            const c = make(fakeChat(ids, []));
            await c.loadCache();
            modes.push(c.state.mode);
        }
        expect(modes).toEqual(["unavailable", "none", "chips", "dropdown"]);
    });

    it("rows sorted unread first", async () => {
        const chat = fakeChat(["a"], [
            chan("a", 1, { unreadCounter: 2, needactionCounter: 2 }),
            chan("a", 2),
        ]);
        const c = make(chat);
        await c.loadCache();
        expect(c.state.rows.map((r: any) => r.channelId)).toEqual([1, 2]);
        expect(c.state.rows[0].unread).toBe(2);
        expect(c.state.rows[0].bold).toBe(true);
        expect(c.state.rows[1].bold).toBe(false);
    });

    it("chip filter keeps one server", async () => {
        const chat = fakeChat(["a", "b"], [chan("a", 1), chan("b", 2)]);
        const c = make(chat);
        await c.loadCache();
        expect(c.state.rows.length).toBe(2);
        await c.onFilter("b");
        expect(c.state.rows.map((r: any) => r.configId)).toEqual(["b"]);
        expect(localStorage.getItem("chat.filter")).toBe("b");
        await c.onFilter(null);
        expect(c.state.rows.length).toBe(2);
    });

    it("unavailable mode offers adding a server", async () => {
        const c = make(fakeChat([], []));
        await c.loadCache();
        expect(c.state.mode).toBe("unavailable");
        const nav = vi.fn();
        c.navigate = nav;
        c.onAddServer();
        expect(nav).toHaveBeenCalledWith("/applications/add");
    });

    it("a chat takes the correspondent name and a pending preview", async () => {
        const chat = fakeChat(["a"], [
            chan("a", 1, { channelType: "chat", name: "x", correspondentPartnerId: 7 }),
        ]);
        chat.repo.messages.mockResolvedValue([
            { status: "pending", body: "<p>hello</p>", date: "2020-01-01 10:00:00" },
        ]);
        const c = make(chat);
        await c.loadCache();
        expect(c.state.rows[0].title).toBe("Alice Roy");
        expect(c.state.rows[0].typeIcon).toBe("👤");
        expect(c.state.rows[0].preview).toBe("⏳ hello");
    });

    it("search filters title and preview", async () => {
        const chat = fakeChat(["a"], [chan("a", 1, { name: "Sales" }), chan("a", 2, { name: "Ops" })]);
        const c = make(chat);
        await c.loadCache();
        c.state.query = "sal";
        expect(c.visibleRows().map((r: any) => r.channelId)).toEqual([1]);
    });

    it("tapping a row navigates to the thread", async () => {
        const c = make(fakeChat(["a b"], [chan("a b", 5)]));
        await c.loadCache();
        const nav = vi.fn();
        c.navigate = nav;
        c.onRowClick(c.state.rows[0]);
        expect(nav).toHaveBeenCalledWith("/chat/a%20b/5");
    });
});

describe("HomeComponent chat badge", () => {
    it("home badge shows the unread total", async () => {
        stubLocale();
        const chat = fakeChat(["a", "b"], [], { a: 3, b: 4 });
        const h = new (HomeComponent as any)();
        h.env = { chatService: chat, eventBus: new EventBus() };
        Object.defineProperty(h, "chatService", { value: chat });
        h.setup();
        await h.loadChatUnread();
        expect(h.state.chatUnread).toBe(7);
    });

    it("CHAT_CHANGED refreshes the badge until unmounted", async () => {
        stubLocale();
        const chat = fakeChat(["a"], [], { a: 1 });
        const h = new (HomeComponent as any)();
        const bus = new EventBus();
        h.env = { eventBus: bus };
        Object.defineProperty(h, "chatService", { value: chat });
        h.setup();
        h.watchChat();
        await h.loadChatUnread();
        chat.unreadTotal.mockResolvedValue(9);
        bus.trigger(Events.CHAT_CHANGED);
        await new Promise((r) => setTimeout(r, 0));
        expect(h.state.chatUnread).toBe(9);
        h.unwatchChat();
        chat.unreadTotal.mockResolvedValue(2);
        bus.trigger(Events.CHAT_CHANGED);
        await new Promise((r) => setTimeout(r, 0));
        expect(h.state.chatUnread).toBe(9);
    });
});
