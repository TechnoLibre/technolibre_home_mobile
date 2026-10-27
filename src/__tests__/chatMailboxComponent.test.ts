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
        pendingRecordReplies: vi.fn(async (_c: string): Promise<Map<number, any[]>> => new Map()),
        inbox: {
            items: vi.fn().mockResolvedValue([]),
            refresh: vi.fn().mockResolvedValue({ more: false, offline: false, oldestId: null }),
            openItem: vi.fn(async (_src: any, i: any, navigate: (url: string) => void) => navigate("/note/n-" + i.messageId)),
        },
        isOnline: vi.fn().mockResolvedValue(true),
        switchToInbox: vi.fn().mockResolvedValue("done"),
        openPreferences: vi.fn().mockResolvedValue(undefined),
        repo: {
            partners: vi.fn().mockResolvedValue([{ partnerId: 7, name: "Alice Martin" }]),
            sourceState: vi.fn(async (_c: string) => ({ notificationType: null as string | null })),
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

    it("a tapped item opens through ChatInbox.openItem, in the inbox and the starred box alike", async () => {
        const chat: any = fakeChat(["a"]);
        const task = item("a", 603);
        chat.inbox.items.mockResolvedValue([task]);
        chat.starred.mockResolvedValue([{ ...task, starred: true, needaction: false }]);
        for (const path of ["/chat/inbox", "/chat/starred"]) {
            const c = make(chat, path);
            c.navigate = vi.fn();
            await c.loadCache();
            await c.onOpen(c.state.rows[0]);
            expect(chat.inbox.openItem).toHaveBeenLastCalledWith(src("a"), expect.objectContaining({ configId: "a", messageId: 603 }), expect.any(Function));
            expect(c.navigate).toHaveBeenCalledWith("/note/n-603");
        }
        // Opening marks nothing read
        expect(chat.markDone).not.toHaveBeenCalled();
        // A failure shows the action error, the list kept
        const c = make(chat, "/chat/inbox");
        await c.loadCache();
        chat.inbox.openItem.mockRejectedValueOnce(new Error("no table"));
        await c.onOpen(c.state.rows[0]);
        expect(c.state.error).toBe("Could not do it. Try again.");
        expect(source).toMatch(/class="chat-mailbox__item"[^>]*t-on-click="\(\) => this\.onOpen\(row\)"/);
        expect(source).toMatch(/chat-mailbox__mark"[^>]*\n?[^>]*t-on-click\.stop=/);
    });

    it("no reply is offered on an assignment", async () => {
        const chat: any = fakeChat(["a"]);
        chat.inbox.items.mockResolvedValue([
            item("a", 605, { threadModel: "discuss.channel", threadId: 11, recordName: "#général-test" }),
            item("a", 603, { messageType: "user_notification", authorPartnerId: null }),
            item("a", 602),
        ]);
        const c = make(chat, "/chat/inbox");
        await c.loadCache();
        // A mention is answered in its conversation, an assignment not at all, as the browser
        expect(c.state.rows.map((r: any) => [r.messageId, r.canReply])).toEqual([[605, false], [603, false], [602, true]]);
        c.onReply(c.state.rows[2]);
        expect(c.state.reply).toMatchObject({ messageId: 602 });
        expect(c.replySource()).toEqual(src("a"));
        c.onReply(c.state.rows[1]);
        expect(c.state.reply).toMatchObject({ messageId: 602 });
        // Sent: the composer closes and the list is read again
        chat.inbox.items.mockClear();
        await c.onReplyDone();
        expect(c.state.reply).toBeNull();
        expect(chat.inbox.items).toHaveBeenCalled();
        c.onReply(c.state.rows[2]);
        c.onReplyCancel();
        expect(c.state.reply).toBeNull();
        // The history tab of the inbox offers it too, as the browser's history
        chat.inbox.items.mockImplementation(async (_ids: string[], box: string) =>
            box === "history" ? [item("a", 590, { needaction: false, history: true })] : []);
        await c.onTab("history");
        expect(c.state.rows.map((r: any) => [r.messageId, r.canReply])).toEqual([[590, true]]);
        // The starred box offers none
        chat.starred.mockResolvedValue([{ ...item("a", 602), starred: true }]);
        const starred = make(chat, "/chat/starred");
        await starred.loadCache();
        expect(starred.state.rows[0].canReply).toBe(false);
        expect(source).toMatch(/t-if="row\.canReply"[^>]*t-on-click\.stop="\(\) => this\.onReply\(row\)"/);
        expect(source).toMatch(/<ChatRecordReplyComponent t-if="state\.reply"/);
    });

    it("a reply waiting to be sent shows under its item with ⏳ and its file count", async () => {
        const chat: any = fakeChat(["a"]);
        chat.inbox.items.mockResolvedValue([item("a", 602), item("a", 601)]);
        chat.pendingRecordReplies.mockResolvedValue(new Map([[602, [
            { text: "Merci, je regarde", note: true, files: 2 },
            { text: "", note: false, files: 1 },
            { text: "Vu", note: true, files: 0 },
        ]]]));
        const c = make(chat, "/chat/inbox");
        await c.loadCache();
        expect(chat.pendingRecordReplies).toHaveBeenCalledWith("a");
        expect(c.state.rows.map((r: any) => r.pending)).toEqual([
            ["⏳ Note waiting to be sent — Merci, je regarde · 📎 2 files", "⏳ Message waiting to be sent · 📎 1 file", "⏳ Note waiting to be sent — Vu"],
            [],
        ]);
        expect(source).toMatch(/t-foreach="row\.pending"/);
    });

    describe("email notifications", () => {
        const emailFor = (chat: any, ...ids: string[]) =>
            chat.repo.sourceState.mockImplementation(async (c: string) => ({ notificationType: ids.includes(c) ? "email" : "inbox" }));

        it("an email user's inbox shows the notice and the button, an inbox user's nothing", async () => {
            const chat: any = fakeChat(["a", "b"]);
            emailFor(chat, "a");
            const c = make(chat, "/chat/inbox");
            await c.loadCache();
            // Even with nothing in the inbox
            expect(c.state.rows).toEqual([]);
            expect(c.state.notices.map((n: any) => n.configId)).toEqual(["a"]);
            expect(c.state.networkOff).toBe(false);
            expect(source).toMatch(/t\('chat\.inbox_email_notice'\)/);
            expect(source).toMatch(/t\('chat\.inbox_switch'\)/);
            expect(source).toMatch(/t\('chat\.inbox_switch_hint'\)/);
            // The starred box carries none
            const starred = make(chat, "/chat/starred");
            await starred.loadCache();
            expect(starred.state.notices).toEqual([]);
        });

        it("the switch asks the service, and the notice goes once the type is read back", async () => {
            const chat: any = fakeChat(["a"]);
            emailFor(chat, "a");
            chat.switchToInbox.mockImplementation(async () => { emailFor(chat); return "done"; });
            const c = make(chat, "/chat/inbox");
            await c.loadCache();
            await c.onSwitch("a");
            expect(chat.switchToInbox).toHaveBeenCalledWith(src("a"));
            expect(c.state.notices).toEqual([]);
            expect(c.state.error).toBe("");
        });

        it("offline the button is disabled and says why; an offline answer says the same", async () => {
            const chat: any = fakeChat(["a"]);
            emailFor(chat, "a");
            chat.isOnline.mockResolvedValue(false);
            const c = make(chat, "/chat/inbox");
            await c.loadCache();
            expect(c.state.networkOff).toBe(true);
            await c.onSwitch("a");
            expect(chat.switchToInbox).not.toHaveBeenCalled();
            expect(source).toMatch(/t-att-disabled="state\.networkOff[^"]*"/);
            expect(source).toMatch(/t\('chat\.inbox_switch_offline'\)/);
            chat.isOnline.mockResolvedValue(true);
            chat.switchToInbox.mockResolvedValue("offline");
            await c.loadCache();
            expect(c.state.networkOff).toBe(false);
            await c.onSwitch("a");
            expect(c.state.answers.a).toBe("offline");
            expect(c.state.notices.map((n: any) => n.configId)).toEqual(["a"]);
        });

        it("a second tap while the switch runs sends nothing", async () => {
            const chat: any = fakeChat(["a"]);
            emailFor(chat, "a");
            let release!: (v: string) => void;
            chat.switchToInbox.mockImplementation(() => new Promise((r) => { release = r; }));
            const c = make(chat, "/chat/inbox");
            await c.loadCache();
            const first = c.onSwitch("a");
            expect(c.state.switching.a).toBe(true);
            await c.onSwitch("a");
            expect(chat.switchToInbox).toHaveBeenCalledTimes(1);
            expect(source).toMatch(/t-att-disabled="state\.networkOff or state\.switching\[n\.configId\]"/);
            release("done");
            await first;
            expect(c.state.switching.a).toBeFalsy();
        });

        it("a refusal offers the preferences", async () => {
            const chat: any = fakeChat(["a", "b"]);
            emailFor(chat, "a", "b");
            chat.switchToInbox.mockResolvedValue("refused");
            const c = make(chat, "/chat/inbox");
            await c.loadCache();
            await c.onSwitch("b");
            expect(c.state.answers).toEqual({ b: "refused" });
            expect(source).toMatch(/t\('chat\.inbox_switch_refused'\)/);
            await c.onPreferences("b");
            expect(chat.openPreferences).toHaveBeenCalledWith(src("b"));
            expect(chat.openPreferences).toHaveBeenCalledTimes(1);
        });
    });
});
