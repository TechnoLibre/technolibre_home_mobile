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
        notices: vi.fn().mockResolvedValue([]),
        repo: {
            partners: vi.fn().mockResolvedValue([{ partnerId: 7, name: "Alice Roy" }]),
            messages: vi.fn().mockResolvedValue([]),
            lastMessages: vi.fn().mockResolvedValue(new Map()),
            attachmentsOf: vi.fn(async (): Promise<Map<string, any[]>> => new Map()),
            pendingMessages: vi.fn().mockResolvedValue(new Map()),
            membersBySource: vi.fn().mockResolvedValue(new Map()),
            sourceState: vi.fn().mockResolvedValue({ selfPartnerId: 3 }),
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

    it("a refused conversation is listed as such and can be dismissed", async () => {
        const chat: any = fakeChat(["a"], [
            chan("a", -7, { name: "Secret", createFailed: true }), chan("a", 30, { createFailed: true }),
            chan("a", 31, { leftUnsent: true }), chan("a", 2),
        ]);
        chat.discardCreate = vi.fn().mockResolvedValue(undefined);
        const c = make(chat);
        await c.loadCache();
        expect(c.state.rows.map((r: any) => r.failed)).toEqual(["create", "join", "left", ""]);
        expect(c.failedText(c.state.rows[2])).toBe("Conversation left");
        await c.onDismiss(c.state.rows[0]);
        expect(chat.discardCreate).toHaveBeenCalledWith("a", -7);
        expect(chat.conversations).toHaveBeenCalledTimes(2);
    });

    it("a file not sent is named in its notice, with the server's limit when known", async () => {
        const chat: any = fakeChat(["a"], [chan("a", 5, { name: "Team" })]);
        const file = (name: string, reason: string, limit: number | null) => ({
            id: name, configId: "a", kind: "chat.file_refused", channelId: 5, reason: "refused", error: "", count: 1, label: "",
            file: { name, reason, limit },
        });
        chat.notices = vi.fn().mockResolvedValue([
            file("a.jpg", "too_big", 134217728), file("b.jpg", "too_big", null), file("c.jpg", "missing", null),
            file("d.jpg", "refused", null), file("e.jpg", "not_found", null),
        ]);
        const c = make(chat);
        await c.loadCache();
        expect(c.state.notices.map((n: any) => n.text)).toEqual([
            "Team — file “a.jpg” not sent: over the server's limit of 128 MB.",
            "Team — file “b.jpg” not sent: the server found it too big.",
            "Team — file “c.jpg” not sent: it is no longer on the phone.",
            "Team — file “d.jpg” not sent: refused by the server.",
            "Team — file “e.jpg” not sent: the server cannot find the conversation.",
        ]);
    });

    it("an action the outbox gave up on is shown until dismissed", async () => {
        const chat: any = fakeChat(["a", "b"], [chan("a", 5, { name: "Team" })]);
        chat.notices = vi.fn().mockResolvedValue([
            { id: "op1", configId: "a", kind: "chat.rename", channelId: 5, reason: "refused", error: "no", count: 1, label: "" },
            { id: "op2", configId: "b", kind: "chat.dropped", channelId: 9, reason: "vanished", error: "", count: 3, label: "Gone" },
        ]);
        chat.dismissNotice = vi.fn().mockResolvedValue(undefined);
        const c = make(chat);
        await c.loadCache();
        expect(chat.notices).toHaveBeenCalledWith(["a", "b"]);
        expect(c.state.notices.map((n: any) => [n.serverLabel, n.text])).toEqual([
            ["a", "Team — Renaming: refused by the server."],
            ["b", "Gone — conversation removed — 3 actions cancelled"],
        ]);
        await c.onDismissNotice(c.state.notices[0]);
        expect(chat.dismissNotice).toHaveBeenCalledWith("a", "op1");
        // Filtered on one server, every server's notices still show
        await c.onFilter("a");
        expect(chat.notices).toHaveBeenLastCalledWith(["a", "b"]);
        expect(c.state.notices).toHaveLength(2);
    });

    it("a dropped notice says one action or several, capitalised without a name", async () => {
        const chat: any = fakeChat(["a"], []);
        chat.notices = vi.fn().mockResolvedValue([
            { id: "op1", configId: "a", kind: "chat.dropped", channelId: 9, reason: "vanished", error: "", count: 1, label: "" },
            { id: "op2", configId: "a", kind: "chat.dropped", channelId: 8, reason: "vanished", error: "", count: 2, label: "" },
        ]);
        const c = make(chat);
        await c.loadCache();
        expect(c.state.notices.map((n: any) => n.text)).toEqual([
            "Conversation removed — 1 action cancelled",
            "Conversation removed — 2 actions cancelled",
        ]);
    });

    it("a failed dismissal shows a notice and does not reject", async () => {
        const chat: any = fakeChat(["a"], [chan("a", -7, { createFailed: true })]);
        chat.discardCreate = vi.fn().mockRejectedValue(new Error("db"));
        chat.dismissNotice = vi.fn().mockRejectedValue(new Error("db"));
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const c = make(chat);
        await c.loadCache();
        await expect(c.onDismiss(c.state.rows[0])).resolves.toBeUndefined();
        expect(c.state.error).toBe("Could not do it. Try again.");
        c.state.error = "";
        await expect(c.onDismissNotice({ id: "x", configId: "a", serverLabel: "a", text: "" })).resolves.toBeUndefined();
        expect(c.state.error).toBe("Could not do it. Try again.");
    });

    it("the new conversation button is offered to an internal user, or before the first read", async () => {
        const cases: [any, boolean][] = [
            [{ selfPartnerId: 3, loadedAt: null, isInternalUser: false }, true],
            [{ selfPartnerId: 3, loadedAt: "2026-10-25T10:00:00Z", isInternalUser: true }, true],
            [{ selfPartnerId: 3, loadedAt: "2026-10-25T10:00:00Z", isInternalUser: false }, false],
        ];
        for (const [st, shown] of cases) {
            const chat: any = fakeChat(["a"], []);
            chat.repo.sourceState = vi.fn().mockResolvedValue(st);
            const c = make(chat);
            await c.loadCache();
            expect(c.state.canCreate, JSON.stringify(st)).toBe(shown);
        }
    });

    it("a create a lost answer left undecided is marked in its row", async () => {
        const chat: any = fakeChat(["a"], [chan("a", -4, { createOpId: "op1" }), chan("a", -5, { createOpId: "op2" })]);
        const c = make(chat);
        c.env.databaseService = { getOutboxOpsForConfig: vi.fn().mockResolvedValue([
            { id: "op1", status: "blocked", params: { blockedReason: "ambiguous" } },
            { id: "op2", status: "pending", params: {} },
        ]) };
        await c.loadCache();
        expect(c.state.rows.map((r: any) => [r.channelId, r.ambiguous])).toEqual([[-4, true], [-5, false]]);
    });

    it("rows keep the service order (unread first) and flag bold", async () => {
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
        chat.repo.lastMessages.mockResolvedValue(
            new Map([[1, { status: "sent", body: "<p>old</p>", date: "2020-01-01 09:00:00" }]]),
        );
        chat.repo.pendingMessages.mockResolvedValue(
            new Map([[1, [{ status: "pending", body: "<p>hello</p>", date: "2020-01-01 10:00:00" }]]]),
        );
        const c = make(chat);
        await c.loadCache();
        expect(chat.repo.messages).not.toHaveBeenCalled();
        expect(c.state.rows[0].title).toBe("Alice Roy");
        expect(c.state.rows[0].typeIcon).toBe("👤");
        expect(c.state.rows[0].preview).toBe("⏳ hello");
    });

    it("a message with only files previews them by icon and name", async () => {
        const chat = fakeChat(["a"], [chan("a", 1, { name: "Team" }), chan("a", 2, { name: "Pair" }), chan("a", 3)]);
        chat.repo.lastMessages.mockResolvedValue(new Map([
            [1, { messageId: 40, clientUuid: null, messageType: "comment", status: "sent", body: "", date: "2020-01-01 09:00:00" }],
            [3, { messageId: 41, clientUuid: null, messageType: "comment", status: "sent", body: "<p>words</p>", date: "2020-01-01 09:00:00" }],
        ]));
        chat.repo.pendingMessages.mockResolvedValue(new Map([[2, [{
            messageId: null, clientUuid: "P1", messageType: "comment", status: "pending", body: "<!-- erplibre-mobile:P1 -->", date: "2020-01-01 10:00:00",
        }]]]));
        chat.repo.attachmentsOf.mockImplementation(async (_c: string, channelId: number) => channelId === 1
            ? new Map([["m40", [{ name: "IMG_1.jpg", mimetype: "image/jpeg", voice: false }, { name: "b.pdf", mimetype: "application/pdf", voice: false }]]])
            : new Map([["uP1", [{ name: "Voice-2026-10-26-1.mp3", mimetype: "audio/mpeg", voice: true }]]]));
        const c = make(chat);
        await c.loadCache();
        expect(c.state.rows.map((r: any) => r.preview)).toEqual(["🖼️ IMG_1.jpg, 📎 b.pdf", "⏳ 🎤 Voice message", "words"]);
        expect(chat.repo.attachmentsOf.mock.calls).toEqual([["a", 1, [40], []], ["a", 2, [], ["P1"]]]);
    });

    it("the files of several conversations are read side by side, none for a message that is not a post", async () => {
        const chat = fakeChat(["a"], [chan("a", 1), chan("a", 2), chan("a", 3)]);
        chat.repo.lastMessages.mockResolvedValue(new Map([
            [1, { messageId: 40, clientUuid: null, status: "sent", messageType: "comment", body: "", date: "2020-01-01 09:00:00" }],
            [2, { messageId: 41, clientUuid: null, status: "sent", messageType: "comment", body: "", date: "2020-01-01 09:00:00" }],
            [3, { messageId: 42, clientUuid: null, status: "sent", messageType: "notification", body: "", date: "2020-01-01 09:00:00" }],
        ]));
        let started = 0;
        let release!: () => void;
        const gate = new Promise<void>((r) => { release = r; });
        chat.repo.attachmentsOf.mockImplementation(async (_c: string, channelId: number) => {
            started += 1;
            await gate;
            return new Map([["m" + (39 + channelId), [{ name: "f" + channelId + ".pdf", mimetype: "application/pdf", voice: false }]]]);
        });
        const c = make(chat);
        const loading = c.loadCache();
        for (let i = 0; i < 20; i++) await Promise.resolve();
        expect(started).toBe(2);
        release();
        await loading;
        expect(c.state.rows.map((r: any) => r.preview)).toEqual(["📎 f1.pdf", "📎 f2.pdf", ""]);
        expect(chat.repo.attachmentsOf).toHaveBeenCalledTimes(2);
    });

    it("a stale build for All never overwrites the chip B rows", async () => {
        const chat = fakeChat(["a", "b"], [chan("a", 1), chan("b", 2)]);
        let release!: () => void;
        const gate = new Promise<void>((r) => { release = r; });
        const orig = chat.conversations.getMockImplementation()!;
        chat.conversations.mockImplementationOnce(async (cfg?: string[]) => {
            await gate;
            return orig(cfg);
        });
        const c = make(chat);
        const first = c.loadCache();
        const second = c.onFilter("b");
        release();
        await Promise.all([first, second]);
        expect(c.state.rows.map((r: any) => r.configId)).toEqual(["b"]);
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

describe("ChatListComponent cache warning", () => {
    it("is read at each build, not at each render, and opens the options", async () => {
        const chat: any = fakeChat(["a"], [chan("a", 1)]);
        chat.attachments = { warning: vi.fn().mockResolvedValue(true) };
        const c = make(chat);
        await c.loadCache();
        expect(c.state.cacheWarn).toBe(true);
        expect(chat.attachments.warning).toHaveBeenCalledTimes(1);
        c.visibleRows();
        c.visibleRows();
        expect(chat.attachments.warning).toHaveBeenCalledTimes(1);
        c.navigate = vi.fn();
        c.onCacheWarning();
        expect(c.navigate).toHaveBeenCalledWith("/options#chat");
        chat.attachments.warning.mockResolvedValue(false);
        await c.loadCache();
        expect(c.state.cacheWarn).toBe(false);
    });

    it("a failing read hides the warning", async () => {
        const chat: any = fakeChat(["a"], [chan("a", 1)]);
        chat.attachments = { warning: vi.fn().mockRejectedValue(new Error("db")) };
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const c = make(chat);
        await c.loadCache();
        expect(c.state.cacheWarn).toBe(false);
    });
});
