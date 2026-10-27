// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";

// vitest.config.ts aliases @odoo/owl to src/__mocks__: hooks are no-ops, so
// setup() then the loaders are called by hand.
import { ChatMailboxComponent } from "../components/chat/chat_mailbox_component";
import { EventBus } from "@odoo/owl";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function stubLocale() {
    const store: Record<string, string> = { app_lang: "en" };
    vi.stubGlobal("localStorage", {
        getItem: (k: string) => store[k] ?? null,
        setItem: (k: string, v: string) => { store[k] = v; },
        removeItem: (k: string) => { delete store[k]; },
    });
}

const src = (id: string) => ({ configId: id, label: id, app: {}, creds: {} });
const item = (configId: string, messageId: number, p: Record<string, any> = {}) => ({
    configId, messageId, threadModel: "res.partner", threadId: 70, recordName: "Tâche démo", authorPartnerId: 7,
    body: `<p>Texte ${messageId}</p>`, date: "2020-01-01 10:00:00", messageType: "comment",
    needaction: true, starred: false, history: false, ...p,
});

function fakeChat(ids: string[]) {
    return {
        sources: vi.fn().mockResolvedValue(ids.map(src)),
        starred: vi.fn().mockResolvedValue([]),
        refreshStarred: vi.fn().mockResolvedValue({ offline: false, oldestId: null, complete: true }),
        star: vi.fn().mockResolvedValue(undefined),
        markDone: vi.fn().mockResolvedValue(undefined),
        markAllDone: vi.fn().mockResolvedValue(undefined),
        inbox: {
            items: vi.fn().mockResolvedValue([]),
            refresh: vi.fn().mockResolvedValue({ more: false, offline: false, oldestId: null }),
        },
        repo: {
            partners: vi.fn().mockResolvedValue([{ partnerId: 7, name: "Alice Martin" }]),
        },
    };
}

function make(chat: any, path: string) {
    stubLocale();
    window.history.replaceState({}, "", path);
    const c = new (ChatMailboxComponent as any)();
    c.env = { eventBus: new EventBus() };
    Object.defineProperty(c, "chatService", { value: chat });
    c.setup();
    return c;
}

const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", "components", "chat", "chat_mailbox_component.ts"), "utf8");

afterEach(() => vi.unstubAllGlobals());

describe("ChatMailboxComponent", () => {
    it("the starred box lists favourites with unread first and unstars one", async () => {
        const chat: any = fakeChat(["a"]);
        // The service's order: the unread first
        chat.starred.mockResolvedValue([
            item("a", 600, { threadModel: "discuss.channel", threadId: 11, recordName: "Team", starred: true, needaction: false }),
            item("a", 98, { starred: true, needaction: false }),
        ]);
        const c = make(chat, "/chat/starred");
        expect(c.state.box).toBe("starred");
        await c.loadCache();
        expect(c.state.rows.map((r: any) => r.messageId)).toEqual([600, 98]);
        expect(c.state.rows[0]).toMatchObject({ where: "Team", author: "Alice Martin", preview: "Texte 600" });
        expect(c.title()).toBe("Starred");
        await c.refreshOnline();
        expect(chat.refreshStarred).toHaveBeenCalledWith(src("a"));
        await c.onUnstar(c.state.rows[0]);
        expect(chat.star).toHaveBeenCalledWith(src("a"), 600, false, 11);
        await c.onUnstar(c.state.rows[1]);
        expect(chat.star).toHaveBeenLastCalledWith(src("a"), 98, false, null);
        expect(source).toMatch(/t-if="state\.box === 'starred'"[^>]*chat-mailbox__unstar|chat-mailbox__unstar[^>]*t-if="state\.box === 'starred'"/);
    });

    it("the inbox shows each kind, marks one and all read, and tags the server when several", async () => {
        const chat: any = fakeChat(["a", "b"]);
        chat.inbox.items.mockImplementation(async (_ids: string[], box: string) => (box === "inbox" ? [
            item("a", 605, { threadModel: "discuss.channel", threadId: 11, recordName: "#général-test" }),
            item("a", 603, { messageType: "user_notification", authorPartnerId: null }),
            item("b", 602),
        ] : [item("a", 590, { needaction: false, history: true })]));
        const c = make(chat, "/chat/inbox");
        expect(c.state.box).toBe("inbox");
        await c.loadCache();
        expect(chat.inbox.items).toHaveBeenLastCalledWith(["a", "b"], "inbox");
        expect(c.state.rows.map((r: any) => [r.kindIcon, r.where, r.author, r.serverLabel])).toEqual([
            ["💬", "#général-test", "Alice Martin", "a"],
            ["👤", "Tâche démo", "Someone", "a"],
            ["📄", "Tâche démo", "Alice Martin", "b"],
        ]);
        expect(c.title()).toBe("Inbox");
        expect(c.state.accounts.map((a: any) => a.configId)).toEqual(["a", "b"]);
        await c.onMarkRead(c.state.rows[0]);
        expect(chat.markDone).toHaveBeenCalledWith(src("a"), [605]);
        await c.onMarkAll("b");
        expect(chat.markAllDone).toHaveBeenCalledWith(src("b"));
        // The history tab: no mark read there
        await c.onTab("history");
        expect(chat.inbox.items).toHaveBeenLastCalledWith(["a", "b"], "history");
        expect(chat.inbox.refresh).toHaveBeenLastCalledWith(src("b"), "history");
        expect(c.state.rows.map((r: any) => r.messageId)).toEqual([590]);
        expect(source).toMatch(/class="chat-mailbox__mark-all"/);
        expect(source).toMatch(/t\('chat\.inbox_mark_read'\)/);
        expect(source).toMatch(/t\('chat\.inbox_mark_all'\)/);
    });

    it("the next page comes on scroll near the bottom", async () => {
        const chat: any = fakeChat(["a"]);
        chat.inbox.refresh.mockResolvedValue({ more: true, offline: false, oldestId: 571 });
        const c = make(chat, "/chat/inbox");
        await c.loadCache();
        await c.refreshOnline();
        expect(chat.inbox.refresh).toHaveBeenCalledWith(src("a"), "inbox");
        const far = { scrollTop: 0, clientHeight: 500, scrollHeight: 3000 };
        await c.onScroll({ target: far });
        expect(chat.inbox.refresh).toHaveBeenCalledTimes(1);
        await c.onScroll({ target: { ...far, scrollTop: 2400 } });
        expect(chat.inbox.refresh).toHaveBeenLastCalledWith(src("a"), "inbox", 571);
        // The last page: no request more
        chat.inbox.refresh.mockResolvedValue({ more: false, offline: false, oldestId: 541 });
        await c.onScroll({ target: { ...far, scrollTop: 2400 } });
        const calls = chat.inbox.refresh.mock.calls.length;
        await c.onScroll({ target: { ...far, scrollTop: 2400 } });
        expect(chat.inbox.refresh.mock.calls.length).toBe(calls);
    });

    it("offline, the phone's list stays and says so", async () => {
        const chat: any = fakeChat(["a"]);
        chat.inbox.refresh.mockResolvedValue({ more: false, offline: true, oldestId: null });
        const c = make(chat, "/chat/inbox");
        await c.refreshOnline();
        expect(c.state.offline).toBe(true);
        expect(source).toMatch(/t-esc="t\('chat\.mailbox_offline'\)"/);
    });
});
