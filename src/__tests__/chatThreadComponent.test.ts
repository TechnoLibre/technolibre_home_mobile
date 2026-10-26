// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("@capacitor/app", () => ({ App: { addListener: vi.fn() } }));
vi.mock("@capacitor/camera", () => ({ Camera: {} }));
vi.mock("@capacitor/filesystem", () => ({ Filesystem: {}, Directory: { Data: "DATA", External: "EXTERNAL" } }));
vi.mock("capacitor-voice-recorder", () => ({ VoiceRecorder: {} }));

import { ChatThreadComponent, THREAD_PAGE, THREAD_WINDOW, typingLine } from "../components/chat/chat_thread_component";
import { EventBus } from "@odoo/owl";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Events } from "../constants/events";

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

/** ChatRepository.messages over a list: beforeId keeps older server rows only, limit the newest of them. */
function cached(list: any[], opts: { beforeId?: number; limit?: number } = {}) {
    let sent = list.filter((m) => m.messageId !== null);
    if (opts.beforeId !== undefined) sent = sent.filter((m) => m.messageId < opts.beforeId!);
    if (opts.limit !== undefined) sent = sent.slice(Math.max(0, sent.length - opts.limit));
    return opts.beforeId !== undefined ? sent : [...sent, ...list.filter((m) => m.messageId === null)];
}

function fakeChat(messages: any[], members: any[] = [member(1), member(7)], ch: any = channel()) {
    return {
        sources: vi.fn().mockResolvedValue([{ configId: "a", label: "Srv", creds: {} }]),
        messages: vi.fn(async (_c: string, _ch: number, opts?: any) => cached(messages, opts)),
        loadOlder: vi.fn().mockResolvedValue(3),
        loadAll: vi.fn(async (_s: any, _c: number, on?: (n: number) => void) => { on?.(4); return 4; }),
        send: vi.fn().mockResolvedValue(msg(null)),
        markRead: vi.fn().mockResolvedValue(undefined),
        typing: vi.fn().mockResolvedValue(undefined),
        realIdOf: vi.fn(async (): Promise<number | null> => null),
        discardCreate: vi.fn().mockResolvedValue(undefined),
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

function make(chat: any, ops: any[] = [], channelId = "5") {
    stubLocale();
    const outbox = { retry: vi.fn().mockResolvedValue(undefined) };
    const c = new (ChatThreadComponent as any)();
    c.env = {
        eventBus: new EventBus(),
        router: { getRouteParams: () => new Map([["source", "a"], ["channelId", channelId]]) },
        databaseService: { getOutboxOpsForConfig: vi.fn().mockResolvedValue(ops) },
        syncService: { outbox },
    };
    Object.defineProperty(c, "chatService", { value: chat });
    c.setup();
    c.outbox = outbox;
    return c;
}


const outFile = (name: string, p: any = {}) => ({
    localUuid: "lu-" + name, path: "chat/q3Zt8Wn1/out/lu-" + name + "/" + name, name,
    mimetype: "image/jpeg", size: 1000, voice: false, ...p,
});

/** The composer's attachments over fakes: a recorder that records until stop gives a voice file. */
function fakeAttachments(c: any, opts: { askCompress?: boolean } = {}) {
    const voice = outFile("Voice-2026-10-26-317.mp3", { mimetype: "audio/mpeg", voice: true });
    const recorder = {
        onAutoStop: null, onBackground: null,
        start: vi.fn(async () => "recording"),
        remainingMs: vi.fn(() => 60000),
        stop: vi.fn(async () => voice),
        discard: vi.fn(async () => {}),
    };
    const capture = {
        pickFiles: vi.fn(async () => []),
        stage: vi.fn(),
        compress: vi.fn(async (f: any) => ({ ...f, size: 10 })),
    };
    const confirm = vi.fn(async () => true);
    const files = { removeDir: vi.fn(async () => {}) };
    Object.assign(c.attach.deps, {
        recorder, capture, confirm, files,
        fileDir: async () => "q3Zt8Wn1",
        uploadLimit: async () => 1 << 20,
        askCompress: () => opts.askCompress ?? false,
    });
    const chip = (file: any, origin = "gallery") => c.attachState.chips.push({ key: "k" + file.name, file, origin });
    return { recorder, capture, confirm, files, voice, chip };
}

afterEach(() => vi.unstubAllGlobals());

describe("ChatThreadComponent", () => {
    it("the header opens the information screen of the conversation, temporary id included", async () => {
        const c = make(fakeChat([msg(10)]), [], "-3");
        c.navigate = vi.fn();
        c.state.menu = true;
        c.onInfo();
        expect(c.navigate).toHaveBeenCalledWith("/chat/a/-3/info");
        expect(c.state.menu).toBe(false);
    });

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
        expect(chat.send).toHaveBeenCalledWith(expect.anything(), 5, "hello", []);
        expect(c.state.text).toBe("");
        expect(c.state.rows.at(-1).meta).toBe("pending");
    });

    it("a send stops the typing notice at once", async () => {
        const chat = fakeChat([]);
        const c = make(chat);
        await c.open();
        c.state.text = "hello";
        await c.onSend();
        expect(chat.typing).toHaveBeenCalledWith(expect.anything(), 5, false);
    });

    it("a conversation gone with unsent messages shows them as not sent, with the notice", async () => {
        const chat = fakeChat([msg(null, { status: "failed", outboxOpId: null, body: "<p>late</p>" })]);
        chat.repo.channel.mockResolvedValue(null);
        const c = make(chat);
        await c.open();
        expect(c.state.found).toBe(false);
        expect(c.state.rows.map((r: any) => [r.meta, r.opId])).toEqual([["failed", null]]);
        expect(String(c.state.rows[0].html)).toContain("late");
    });

    it("a conversation created meanwhile moves the screen to the server's id", async () => {
        const chat = fakeChat([msg(30, { channelId: 40 })]);
        chat.repo.channel.mockImplementation(async (_c: string, id: number) => (id === 40 ? channel({ channelId: 40 }) : null));
        chat.realIdOf.mockImplementation(async () => 40);
        window.history.replaceState({}, "", "/chat/a/-7");
        const replace = vi.spyOn(window.history, "replaceState");
        replace.mockClear();
        const c = make(chat, [], "-7");
        await c.open();
        expect(chat.realIdOf).toHaveBeenCalledWith("a", -7);
        expect(replace).toHaveBeenCalledWith({}, "", "/chat/a/40");
        expect(c.state.found).toBe(true);
        expect(chat.messages).toHaveBeenCalledWith("a", 40, expect.anything());
        c.state.text = "next";
        await c.onSend();
        expect(chat.send).toHaveBeenCalledWith(expect.anything(), 40, "next", []);
    });

    it("a screen no longer on the temporary route moves without touching the history", async () => {
        const chat = fakeChat([]);
        chat.repo.channel.mockImplementation(async (_c: string, id: number) => (id === 40 ? channel({ channelId: 40 }) : null));
        chat.realIdOf.mockImplementation(async () => 40);
        window.history.replaceState({}, "", "/chat");
        const replace = vi.spyOn(window.history, "replaceState");
        replace.mockClear();
        const c = make(chat, [], "-7");
        await c.open();
        expect(replace).not.toHaveBeenCalled();
        // Torn down while the mapping is read: nothing moves
        const d = make(chat, [], "-7");
        d.teardown();
        await d.refresh();
        expect(d.channelId).toBe(-7);
    });

    it("a conversation whose create was refused says so, keeps its texts, and can be dismissed", async () => {
        const chat = fakeChat(
            [msg(null, { channelId: -7, status: "failed", outboxOpId: null, body: "<p>kept</p>" })],
            [member(1)],
            channel({ channelId: -7, createFailed: true }),
        );
        const c = make(chat, [], "-7");
        await c.open();
        expect(c.state.found).toBe(true);
        expect(c.state.failedCreate).toBe("create");
        expect(c.state.rows.map((r: any) => [r.meta, r.opId])).toEqual([["failed", null]]);
        expect(String(c.state.rows[0].html)).toContain("kept");
        const nav: string[] = [];
        c.env.eventBus.addEventListener(Events.ROUTER_NAVIGATION, (ev: any) => nav.push(ev.detail.url));
        await c.onDismiss();
        expect(chat.discardCreate).toHaveBeenCalledWith("a", -7);
        expect(nav).toEqual(["/chat"]);
        // A dismissal that fails stays here with a notice
        chat.discardCreate.mockRejectedValueOnce(new Error("db"));
        vi.spyOn(console, "warn").mockImplementation(() => {});
        await expect(c.onDismiss()).resolves.toBeUndefined();
        expect(c.state.error).toBe("Could not do it. Try again.");
        expect(nav).toEqual(["/chat"]);
        // A refused join reads as such
        const j = make(fakeChat([], [member(1)], channel({ channelId: 30, createFailed: true })), [], "30");
        await j.open();
        expect(j.state.failedCreate).toBe("join");
    });

    it("a conversation left with texts unsent says so in a banner and on each of them", async () => {
        const chat = fakeChat(
            [msg(12), msg(null, { status: "failed", outboxOpId: null, body: "<p>late</p>" })],
            [member(1), member(7)],
            channel({ channelType: "group", isMember: false, leftUnsent: true }),
        );
        const c = make(chat, [], "5");
        await c.open();
        expect(c.state.failedCreate).toBe("left");
        expect(c.state.rows.map((r: any) => r.meta)).toEqual(["sent", "left"]);
    });

    it("posts waiting for an ambiguous create show it", async () => {
        const chat = fakeChat([msg(null, { channelId: -7, outboxOpId: "p1" })], [member(1)], channel({ channelId: -7, createOpId: "c1" }));
        const ops = [
            { id: "c1", dependsOn: null, status: "blocked", params: { blockedReason: "ambiguous" } },
            { id: "p1", dependsOn: "c1", status: "queued", params: {} },
        ];
        const c = make(chat, ops, "-7");
        await c.open();
        expect(c.state.rows.map((r: any) => r.meta)).toEqual(["ambiguous"]);
        // Not ambiguous: the post waits for the create, and says so
        ops[0].params = {};
        ops[0].status = "failed";
        await c.refresh();
        expect(c.state.rows.map((r: any) => r.meta)).toEqual(["waiting_create"]);
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
        c.scroller = { el: { scrollTop: 400, scrollHeight: 1000, clientHeight: 300 } };
        await c.onScroll();
        c.scroller = { el: { scrollTop: 690, scrollHeight: 1000, clientHeight: 300 } };
        await c.onScroll();
        expect(chat.markRead).toHaveBeenCalledTimes(1);
        expect(chat.loadOlder).not.toHaveBeenCalled();
    });

    it("opening marks the conversation read, header shows the correspondent", async () => {
        const chat = fakeChat([msg(10)]);
        const c = make(chat);
        await c.open();
        expect(chat.markRead).toHaveBeenCalledTimes(1);
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

    it("markRead fires once for many bottom scrolls, again after a new message", async () => {
        const chat = fakeChat([msg(10)]);
        const ch = channel();
        chat.repo.channel.mockImplementation(async () => ch);
        const c = make(chat);
        await c.open();
        c.scroller = { el: { scrollTop: 690, scrollHeight: 1000, clientHeight: 300 } };
        for (let i = 0; i < 5; i++) await c.onScroll();
        expect(chat.markRead).toHaveBeenCalledTimes(1);
        ch.lastMessageId = 13;
        await c.onScroll();
        await c.onScroll();
        expect(chat.markRead).toHaveBeenCalledTimes(2);
    });

    it("a markRead arriving during an in-flight markRead runs once more after it", async () => {
        const chat = fakeChat([msg(10)]);
        const ch = channel({ lastMessageId: 10 });
        chat.repo.channel.mockImplementation(async () => ch);
        const c = make(chat);
        await c.open();
        expect(chat.markRead).toHaveBeenCalledTimes(1);
        await vi.waitFor(() => expect(c._marking).toBe(false));
        let release!: () => void;
        chat.markRead.mockImplementationOnce(() => new Promise<void>((r) => { release = r; }));
        ch.lastMessageId = 11;
        const first = c.markRead();
        await vi.waitFor(() => expect(chat.markRead).toHaveBeenCalledTimes(2));
        // A message lands while the call is in flight: asked twice, rerun once
        ch.lastMessageId = 12;
        await c.markRead();
        await c.markRead();
        expect(chat.markRead).toHaveBeenCalledTimes(2);
        release();
        await first;
        expect(chat.markRead).toHaveBeenCalledTimes(3);
    });

    it("a failed markRead is retried on the next bottom scroll", async () => {
        const chat = fakeChat([msg(10)]);
        chat.markRead.mockRejectedValueOnce(new Error("x"));
        const c = make(chat);
        await c.open();
        c.scroller = { el: { scrollTop: 690, scrollHeight: 1000, clientHeight: 300 } };
        await c.onScroll();
        expect(chat.markRead).toHaveBeenCalledTimes(2);
    });

    it("unmount stops the typing notice; unmount before open marks nothing", async () => {
        const chat = fakeChat([msg(10)]);
        const c = make(chat);
        await c.open();
        c.teardown();
        expect(chat.typing).toHaveBeenCalledWith(expect.anything(), 5, false);
        const chat2 = fakeChat([msg(10)]);
        const d = make(chat2);
        const opening = d.open();
        d.teardown();
        await opening;
        expect(chat2.markRead).not.toHaveBeenCalled();
    });

    it("a new message arriving with the bottom in view marks read, once per message", async () => {
        const list: any[] = [msg(10)];
        const ch = channel({ lastMessageId: 10 });
        const chat = fakeChat(list, undefined, ch);
        const c = make(chat);
        await c.open();
        expect(chat.markRead).toHaveBeenCalledTimes(1);
        c.scroller = { el: { scrollTop: 700, scrollHeight: 1000, clientHeight: 300 } };
        list.push(msg(11));
        ch.lastMessageId = 11;
        await c.refresh();
        await vi.waitFor(() => expect(chat.markRead).toHaveBeenCalledTimes(2));
        // A refresh that changes no row sends nothing more
        await c.refresh();
        expect(chat.markRead).toHaveBeenCalledTimes(2);
        // Scrolled up, a new message waits for the bottom
        c.scroller = { el: { scrollTop: 0, scrollHeight: 1000, clientHeight: 300 } };
        list.push(msg(12));
        ch.lastMessageId = 12;
        await c.refresh();
        await new Promise((r) => setTimeout(r, 0));
        expect(chat.markRead).toHaveBeenCalledTimes(2);
    });

    it("double tap sends once", async () => {
        const chat = fakeChat([]);
        const c = make(chat);
        await c.open();
        c.state.text = "hello";
        await Promise.all([c.onSend(), c.onSend()]);
        expect(chat.send).toHaveBeenCalledTimes(1);
    });

    it("a failed send restores the text and shows the error", async () => {
        const chat = fakeChat([]);
        chat.send.mockRejectedValue(new Error("x"));
        const c = make(chat);
        await c.open();
        c.state.text = "hello";
        await c.onSend();
        expect(c.state.text).toBe("hello");
        expect(c.state.error).not.toBe("");
    });

    it("refreshes on CHAT_CHANGED for this conversation only", async () => {
        vi.useFakeTimers();
        try {
            const c = make(fakeChat([msg(10)]));
            const spy = vi.spyOn(c, "refresh").mockResolvedValue(undefined);
            c.eventBus.addEventListener(Events.CHAT_CHANGED, c._onChanged);
            c.eventBus.trigger(Events.CHAT_CHANGED, { configId: "a", channelId: 6 });
            c.eventBus.trigger(Events.CHAT_CHANGED, { configId: "b", channelId: 5 });
            vi.advanceTimersByTime(500);
            expect(spy).not.toHaveBeenCalled();
            c.eventBus.trigger(Events.CHAT_CHANGED, { configId: "a", channelId: 5 });
            c.eventBus.trigger(Events.CHAT_CHANGED, { configId: "a", channelId: null });
            vi.advanceTimersByTime(500);
            expect(spy).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it("a hostile body renders sanitised and is rendered once per version", async () => {
        const chat = fakeChat([msg(10, { body: '<p>x</p><img src=x onerror="alert(1)"><script>alert(1)</script>' })]);
        const c = make(chat);
        await c.open();
        const html = String(c.state.rows[0].html);
        expect(html).not.toMatch(/onerror|<script|<img/i);
        const first = c.state.rows[0].html;
        await c.refresh();
        expect(c.state.rows[0].html).toBe(first);
    });

    it("the typing line expires on its own", async () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(new Date("2020-01-01T10:00:30Z"));
            const chat = fakeChat([msg(10)], [member(1), member(7, { isTyping: true, typingAt: "2020-01-01 10:00:00" })]);
            const c = make(chat);
            await c.open();
            expect(c.state.typing).toContain("Alice");
            vi.advanceTimersByTime(31000);
            expect(c.state.typing).toBe("");
            c.teardown();
        } finally {
            vi.useRealTimers();
        }
    });

    it("an edited message is re-rendered, with or without a write date", async () => {
        const list: any[] = [msg(10, { body: "<p>one</p>", writeDate: "2020-01-01 10:00:00" })];
        const c = make(fakeChat(list));
        await c.open();
        expect(String(c.state.rows[0].html)).toContain("one");
        list[0] = msg(10, { body: "<p>two</p>", writeDate: "2020-01-01 11:00:00" });
        await c.refresh();
        expect(String(c.state.rows[0].html)).toContain("two");
        list[0] = msg(10, { body: "<p>three</p>", writeDate: "2020-01-01 11:00:00" });
        await c.refresh();
        expect(String(c.state.rows[0].html)).toContain("three");
    });

    it("renders the newest rows of a long history, then more from the cache before the server", async () => {
        const list = Array.from({ length: THREAD_WINDOW + THREAD_PAGE + 20 }, (_, i) => msg(i + 1));
        list.push(msg(null, { outboxOpId: "o1" }));
        const chat = fakeChat(list, undefined, channel({ lastMessageId: list.length - 1 }));
        const c = make(chat, [{ id: "o1", dependsOn: null }]);
        await c.open();
        expect(c.state.rows).toHaveLength(THREAD_WINDOW + 1);
        expect(c.state.rows[0].key).toBe("m" + (list.length - 1 - THREAD_WINDOW + 1));
        expect(c.state.rows.at(-1).meta).toBe("pending");
        c.scroller = { el: { scrollTop: 0, scrollHeight: 1000, clientHeight: 300 } };
        await c.onScroll();
        expect(c.state.rows).toHaveLength(THREAD_WINDOW + THREAD_PAGE + 1);
        expect(chat.loadOlder).not.toHaveBeenCalled();
        await c.onScroll();
        expect(c.state.rows).toHaveLength(list.length);
        expect(chat.loadOlder).not.toHaveBeenCalled();
        // The cache is exhausted: the next scroll to the top asks the server
        await c.onScroll();
        expect(chat.loadOlder).toHaveBeenCalledTimes(1);
    });

    it("rows the server pages in are rendered on top of the window", async () => {
        const list = Array.from({ length: THREAD_WINDOW }, (_, i) => msg(i + 100));
        const chat = fakeChat(list, undefined, channel({ lastMessageId: THREAD_WINDOW + 99 }));
        chat.loadOlder.mockImplementation(async () => {
            list.unshift(...Array.from({ length: 30 }, (_, i) => msg(i + 70)));
            return 30;
        });
        const c = make(chat);
        await c.open();
        c.scroller = { el: { scrollTop: 0, scrollHeight: 1000, clientHeight: 300 } };
        await c.onScroll();
        expect(chat.loadOlder).toHaveBeenCalledTimes(1);
        expect(c.state.rows).toHaveLength(THREAD_WINDOW + 30);
        expect(c.state.rows[0].key).toBe("m70");
    });

    it("the short-history stop is lifted when a newer message arrives", async () => {
        const ch = channel();
        const chat = fakeChat([msg(10)], undefined, ch);
        const c = make(chat);
        await c.open();
        c._noMore = true;
        ch.lastMessageId = 20;
        await c.refresh();
        expect(c._noMore).toBe(false);
    });

    it("the layout takes the router cell: the messages flex between header and composer, no viewport height", () => {
        const sheet = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", "components", "chat", "chat_thread_component.scss"), "utf8");
        const rule = (sel: string) => sheet.match(new RegExp(sel.replace(".", "\\.") + "\\s*\\{([^}]*)\\}"))?.[1] ?? "";
        expect(rule("#chat-thread")).toMatch(/height:\s*100%/);
        expect(rule("#chat-thread")).toMatch(/min-height:\s*0/);
        expect(rule(".chat-thread__scroll")).toMatch(/flex:\s*1 1 0/);
        expect(rule(".chat-thread__scroll")).toMatch(/min-height:\s*0/);
        // A height computed from the viewport ignores the navbar and the keyboard
        expect(sheet).not.toMatch(/\d+vh/);
    });

    it("send with files only takes the chips at once and sends them with no text", async () => {
        const chat = fakeChat([msg(10)]);
        const c = make(chat);
        const a = fakeAttachments(c);
        await c.open();
        const photo = outFile("IMG_20261026_101500.jpg");
        a.chip(photo);
        const sending = c.onSend();
        expect(c.attachState.chips).toEqual([]);
        await sending;
        expect(chat.send).toHaveBeenCalledWith(expect.anything(), 5, "", [photo]);
    });

    it("nothing to send leaves the composer as it is", async () => {
        const chat = fakeChat([msg(10)]);
        const c = make(chat);
        fakeAttachments(c);
        await c.open();
        c.state.text = "  ";
        await c.onSend();
        expect(chat.send).not.toHaveBeenCalled();
    });

    it("a refused send puts the text back but not the chips, whose files the outbox deleted", async () => {
        const chat = fakeChat([msg(10)]);
        chat.send.mockRejectedValueOnce(new Error("disk"));
        const c = make(chat);
        const a = fakeAttachments(c);
        await c.open();
        a.chip(outFile("a.jpg"));
        c.state.text = "look";
        await c.onSend();
        expect(c.state.text).toBe("look");
        expect(c.attachState.chips).toEqual([]);
        expect(c.state.error).toBe("Could not send the message. Try again.");
    });

    it("the mic's second tap sends the typed text, the chips and the voice message", async () => {
        const chat = fakeChat([msg(10)]);
        const c = make(chat);
        const a = fakeAttachments(c);
        await c.open();
        const photo = outFile("a.jpg");
        a.chip(photo);
        c.state.text = "listen";
        await c.attach.mic();
        expect(chat.send).not.toHaveBeenCalled();
        await c.attach.mic();
        expect(chat.send).toHaveBeenCalledWith(expect.anything(), 5, "listen", [photo, a.voice]);
        expect(c.state.text).toBe("");
    });

    it("no send leaves while a voice message is prepared", async () => {
        const chat = fakeChat([msg(10)]);
        const c = make(chat);
        fakeAttachments(c);
        await c.open();
        c.attachState.voice = "preparing";
        c.state.text = "after";
        await c.onSend();
        expect(chat.send).not.toHaveBeenCalled();
        expect(c.state.text).toBe("after");
    });

    it("compress is asked through the thread's send, and the reduced photo goes", async () => {
        const chat = fakeChat([msg(10)]);
        const c = make(chat);
        const a = fakeAttachments(c, { askCompress: true });
        await c.open();
        a.chip(outFile("IMG_1.jpg"), "camera");
        await c.onSend();
        expect(a.confirm).toHaveBeenCalledTimes(1);
        expect(chat.send).toHaveBeenCalledWith(expect.anything(), 5, "", [expect.objectContaining({ name: "IMG_1.jpg", size: 10 })]);
    });

    it("the mic and 📎 wait for the conversation's source, the recorder hooked once it is known", async () => {
        const chat = fakeChat([msg(10)]);
        const c = make(chat);
        const a = fakeAttachments(c);
        expect(c.attachState.ready).toBe(false);
        await c.open();
        expect(c.attachState.ready).toBe(true);
        expect(a.recorder.onAutoStop).not.toBeNull();
        const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", "components", "chat", "chat_thread_component.ts"), "utf8");
        for (const cls of ["chat-thread__attach", "chat-thread__mic"]) {
            const tag = source.slice(source.indexOf('class="' + cls + '"'));
            expect(tag.slice(0, tag.indexOf(">")), cls).toMatch(/t-att-disabled="!attachState.ready or /);
        }
    });

    it("a conversation whose source is unknown keeps the mic and 📎 off", async () => {
        const chat = fakeChat([msg(10)]);
        chat.sources.mockResolvedValue([]);
        const c = make(chat);
        const a = fakeAttachments(c);
        await c.open();
        expect(c.attachState.ready).toBe(false);
        expect(a.recorder.onAutoStop).toBeNull();
    });

    it("leaving the screen discards the recording under way", async () => {
        const chat = fakeChat([msg(10)]);
        const c = make(chat);
        const a = fakeAttachments(c);
        await c.open();
        await c.attach.start();
        await c.attach.mic();
        c.teardown();
        await Promise.resolve();
        expect(a.recorder.discard).toHaveBeenCalledTimes(1);
        expect(a.recorder.onAutoStop).toBeNull();
    });
});
