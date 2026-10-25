// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";

import { ChatThreadComponent, typingLine } from "../components/chat/chat_thread_component";
import { EventBus } from "@odoo/owl";

function stubLocale() {
    const store: Record<string, string> = { app_lang: "en" };
    vi.stubGlobal("localStorage", {
        getItem: (k: string) => store[k] ?? null,
        setItem: (k: string, v: string) => { store[k] = v; },
        removeItem: (k: string) => { delete store[k]; },
    });
}

const channel = (p: any = {}) => ({
    configId: "a", channelId: 5, channelType: "chat", name: "x", historyComplete: false,
    correspondentPartnerId: 7, lastMessageId: 12, ...p,
});
const msg = (id: number | null, p: any = {}) => ({
    configId: "a", channelId: 5, messageId: id, clientUuid: id === null ? "u" + Math.random() : null,
    authorPartnerId: 1, body: "<p>hi</p>", date: "2020-01-01 10:00:00", messageType: "comment",
    status: id === null ? "pending" : "sent", outboxOpId: null, writeDate: null, ...p,
});
const member = (partnerId: number, p: any = {}) => ({
    configId: "a", channelId: 5, memberId: partnerId, partnerId, seenMessageId: null,
    fetchedMessageId: null, isTyping: false, typingAt: null, ...p,
});

function fakeChat(messages: any[], members: any[] = [member(1), member(7)], ch: any = channel()) {
    return {
        sources: vi.fn().mockResolvedValue([{ configId: "a", label: "Srv", creds: {} }]),
        messages: vi.fn(async () => messages),
        loadOlder: vi.fn().mockResolvedValue(3),
        loadAll: vi.fn(async (_s: any, _c: number, on?: (n: number) => void) => { on?.(4); return 4; }),
        send: vi.fn().mockResolvedValue(msg(null)),
        markRead: vi.fn().mockResolvedValue(undefined),
        typing: vi.fn().mockResolvedValue(undefined),
        viewing: null as any,
        queue: { flush: vi.fn().mockResolvedValue(undefined) },
        repo: {
            channel: vi.fn(async () => ch),
            members: vi.fn(async () => members),
            partners: vi.fn().mockResolvedValue([
                { partnerId: 7, name: "Alice Roy", imStatus: "online" },
                { partnerId: 8, name: "Bob", imStatus: null },
            ]),
            sourceState: vi.fn().mockResolvedValue({ selfPartnerId: 1 }),
        },
    };
}

function make(chat: any, ops: any[] = []) {
    stubLocale();
    const outbox = { retry: vi.fn().mockResolvedValue(undefined) };
    const c = new (ChatThreadComponent as any)();
    c.env = {
        eventBus: new EventBus(),
        router: { getRouteParams: () => new Map([["source", "a"], ["channelId", "5"]]) },
        databaseService: { getOutboxOpsForConfig: vi.fn().mockResolvedValue(ops) },
        syncService: { outbox },
    };
    Object.defineProperty(c, "chatService", { value: chat });
    c.setup();
    c.outbox = outbox;
    return c;
}

afterEach(() => vi.unstubAllGlobals());

describe("ChatThreadComponent", () => {
    it("send clears the composer and shows the pending bubble", async () => {
        const list: any[] = [msg(10)];
        const chat = fakeChat(list);
        chat.send.mockImplementation(async () => {
            const m = msg(null, { body: "<p>hello</p>" });
            list.push(m);
            return m;
        });
        const c = make(chat);
        await c.open();
        c.state.text = "  hello \n";
        await c.onSend();
        expect(chat.send).toHaveBeenCalledWith(expect.anything(), 5, "hello");
        expect(c.state.text).toBe("");
        expect(c.state.rows.at(-1).meta).toBe("pending");
    });

    it("empty text is not sent", async () => {
        const chat = fakeChat([]);
        const c = make(chat);
        await c.open();
        c.state.text = " \n\t ";
        await c.onSend();
        expect(chat.send).not.toHaveBeenCalled();
    });

    it("seen by all shows double check", async () => {
        const chat = fakeChat(
            [msg(10), msg(11)],
            [member(1), member(7, { seenMessageId: 10 }), member(8, { seenMessageId: 11 })],
        );
        const c = make(chat);
        await c.open();
        expect(c.state.rows.map((r: any) => r.meta)).toEqual(["seen", "sent"]);
    });

    it("a channel never shows seen marks", async () => {
        const chat = fakeChat([msg(10)], [member(1), member(7, { seenMessageId: 10 })], channel({ channelType: "channel" }));
        const c = make(chat);
        await c.open();
        expect(c.state.rows[0].meta).toBe("sent");
    });

    it("typing line names the member", () => {
        stubLocale();
        const now = Date.parse("2020-01-01T10:00:30Z");
        const names = new Map([[7, "Alice"], [8, "Bob"]]);
        const fresh = { isTyping: true, typingAt: "2020-01-01 10:00:00" };
        expect(typingLine([member(1, fresh), member(7, fresh)], 1, names, now)).toBe("Alice is typing…");
        expect(typingLine([member(7, fresh), member(8, fresh)], 1, names, now)).toBe("Alice and Bob are typing…");
        const stale = { isTyping: true, typingAt: "2020-01-01 09:00:00" };
        expect(typingLine([member(7, stale)], 1, names, now)).toBe("");
    });

    it("scroll top loads older", async () => {
        const chat = fakeChat([msg(10)]);
        const c = make(chat);
        await c.open();
        c.scroller = { el: { scrollTop: 0, scrollHeight: 1000, clientHeight: 300 } };
        await c.onScroll();
        expect(chat.loadOlder).toHaveBeenCalledWith(expect.anything(), 5);
    });

    it("reaching bottom marks read", async () => {
        const chat = fakeChat([msg(10)]);
        const c = make(chat);
        await c.open();
        chat.markRead.mockClear();
        c.scroller = { el: { scrollTop: 400, scrollHeight: 1000, clientHeight: 300 } };
        await c.onScroll();
        expect(chat.markRead).not.toHaveBeenCalled();
        c.scroller = { el: { scrollTop: 690, scrollHeight: 1000, clientHeight: 300 } };
        await c.onScroll();
        expect(chat.markRead).toHaveBeenCalledTimes(1);
        expect(chat.loadOlder).not.toHaveBeenCalled();
    });

    it("opening marks the conversation viewed and read, header shows the correspondent", async () => {
        const chat = fakeChat([msg(10)]);
        const c = make(chat);
        await c.open();
        expect(chat.viewing).toEqual({ configId: "a", channelId: 5 });
        expect(chat.markRead).toHaveBeenCalled();
        expect(c.state.title).toBe("Alice Roy");
        expect(c.state.presence).toBe("online");
        expect(c.state.serverLabel).toBe("Srv");
    });

    it("pending behind an unfinished post waits; failed offers retry", async () => {
        const ops = [{ id: "o1", dependsOn: null }, { id: "o2", dependsOn: "o1" }];
        const chat = fakeChat([
            msg(null, { outboxOpId: "o1", status: "failed" }),
            msg(null, { outboxOpId: "o2" }),
        ]);
        const c = make(chat, ops);
        await c.open();
        expect(c.state.rows.map((r: any) => r.meta)).toEqual(["failed", "waiting"]);
        await c.onRetry(c.state.rows[0]);
        expect(c.outbox.retry).toHaveBeenCalledWith("o1");
        expect(chat.queue.flush).toHaveBeenCalled();
    });

    it("load all reports progress", async () => {
        const chat = fakeChat([msg(10)]);
        const c = make(chat);
        await c.open();
        await c.onLoadAll();
        expect(chat.loadAll).toHaveBeenCalled();
        expect(c.state.loadingAll).toBeNull();
    });
});
