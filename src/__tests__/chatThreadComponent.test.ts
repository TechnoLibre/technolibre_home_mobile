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
import { __clearPluginMocks, __setPluginMock } from "@capacitor/core";
import { App } from "@capacitor/app";
import { Dialog } from "@capacitor/dialog";
import { LONG_PRESS_MS } from "../components/chat/chatLongPress";

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
        draft: vi.fn(async (_c: string, _ch: number): Promise<any> => ({ text: "", files: [], lost: [] })),
        saveDraftText: vi.fn(async (_c: string, _ch: number, _t: string) => {}),
        keepDraftFile: vi.fn(async () => {}),
        sendStarted: vi.fn((_c: string, _ch: number) => vi.fn()),
        dropDraftFile: vi.fn(async () => {}),
        reactions: vi.fn(async (_c: string, _ch: number, _keys: string[]): Promise<Map<string, any[]>> => new Map()),
        react: vi.fn(async () => {}),
        deleteMessage: vi.fn(async () => {}),
        editDraftOf: vi.fn(async (_c: string, _ch: number, _t: any): Promise<any> => ({ text: "hi", mentions: { partners: [], channels: [] } })),
        editMessage: vi.fn(async (_s: any, _ch: number, _t: any, _text: string, _m: any, opts?: any) => { opts?.onQueued?.(); }),
        saveDraftReply: vi.fn(async (_c: string, _ch: number, _t: any) => {}),
        saveDraftEdit: vi.fn(async (_c: string, _ch: number, _e: any) => {}),
        saveDraftMentions: vi.fn(async (_c: string, _ch: number, _m: any) => {}),
        requestResume: vi.fn((_c: string, _id: string) => {}),
        takeResume: vi.fn(async (_c: string, _ch: number): Promise<any> => null),
        notices: vi.fn(async (_ids?: string[]): Promise<any[]> => []),
        dismissNotice: vi.fn(async (_c: string, _id: string) => {}),
        startDirect: vi.fn(async (_s: any, _p: number, _o?: any) => ({ configId: "a", channelId: 40 })),
        join: vi.fn(async (_s: any, id: number, _n?: string, _o?: any) => ({ configId: "a", channelId: id })),
        queue: {
            flush: vi.fn().mockResolvedValue(undefined),
            files: {
                webUrl: async (rel: string) => "http://localhost/_capacitor_file_/data/" + rel,
                uri: async (rel: string) => "file:///data/user/0/app/files/" + rel,
            },
            uploadProgress: vi.fn((_u: string): any => null),
        },
        attachments: {
            preview: vi.fn(async (_s: any, a: any) => "chat/d/thumbs/" + a.attachmentId),
            retryPreview: vi.fn(async () => null),
            previewFailed: vi.fn(() => false),
            open: vi.fn(async (_s: any, a: any) => ({ kind: "ready", path: "chat/d/files/" + a.attachmentId + "/" + a.name })),
            downloadProgress: vi.fn(() => null),
            cancel: vi.fn(async () => {}),
            waitingWifi: vi.fn(() => false),
        },
        repo: {
            attachmentsOf: vi.fn(async (): Promise<Map<string, any[]>> => new Map()),
            channel: vi.fn(async (_c?: string, _id?: number): Promise<any> => ch),
            messageOf: vi.fn(async (_c: string, _t: any): Promise<any> => null),
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

/** A draft row of chat_attachments for a staged file, as ChatService.draft gives it. */
const draftRow = (f: any, seq: number, origin: string | null = null) => ({
    configId: "a", channelId: 5, messageId: null, attachmentId: null, localUuid: f.localUuid, postClientUuid: null,
    seq, name: f.name, mimetype: f.mimetype, size: f.size, checksum: null, voice: f.voice, thumbPath: null, thumbBytes: 0,
    originalPath: f.path, originalBytes: f.size, state: "draft", error: null, lastOpenedAt: null, createdAt: "2026-10-26T10:00:00Z",
    origin,
});

/** A row of chat_attachments as ChatRepository.attachmentsOf gives it. */
const fileRow = (id: number | null, p: any = {}) => ({
    configId: "a", channelId: 5, messageId: id === null ? null : 10, attachmentId: id, localUuid: null,
    postClientUuid: null, seq: 0, name: "IMG_" + id + ".jpg", mimetype: "image/jpeg", size: 2048,
    checksum: "c" + id, voice: false, thumbPath: null, thumbBytes: 0, originalPath: null, originalBytes: 0,
    state: "posted", error: null, lastOpenedAt: null, createdAt: "2026-10-26T10:00:00Z", ...p,
});

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
        expect(chat.send).toHaveBeenCalledWith(expect.anything(), 5, "hello", [], expect.objectContaining({ draftText: "  hello \n" }));
        expect(c.state.text).toBe("");
        expect(c.state.rows.at(-1).meta).toBe("pending");
    });

    it("open renders the cached messages and marks read without waiting for the draft", async () => {
        const chat = fakeChat([msg(10), msg(11)]);
        let answer!: (d: any) => void;
        chat.draft.mockImplementationOnce(() => new Promise((r) => { answer = r; }));
        const c = make(chat);
        const opening = c.open();
        await vi.waitFor(() => expect(c.state.rows).toHaveLength(2));
        await vi.waitFor(() => expect(chat.markRead).toHaveBeenCalled());
        answer({ text: "later", files: [], lost: [] });
        await opening;
        expect(c.state.text).toBe("later");
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
        expect(chat.send).toHaveBeenCalledWith(expect.anything(), 40, "next", [], expect.objectContaining({ draftText: "next" }));
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
        expect(chat.send).toHaveBeenCalledWith(expect.anything(), 5, "", [photo], expect.objectContaining({ draftText: "" }));
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

    it("a refused send puts the text back in the composer and the draft, and the chips still in the draft", async () => {
        const chat = fakeChat([msg(10)]);
        chat.send.mockRejectedValueOnce(new Error("disk"));
        const c = make(chat);
        const a = fakeAttachments(c);
        await c.open();
        const kept = outFile("a.jpg");
        const given = outFile("b.jpg");
        a.chip(kept, "camera");
        a.chip(given);
        // The outbox left a.jpg in the draft; b.jpg is no longer one
        chat.draft.mockResolvedValueOnce({ text: "look", files: [draftRow(kept, 0, "camera")], lost: [] });
        c.state.text = "look";
        await c.onSend();
        expect(c.state.text).toBe("look");
        // Stored at the tap; a post that was not queued never removed it
        expect(chat.saveDraftText.mock.calls.map((x: any[]) => x[2])).toEqual(["look"]);
        expect(c.attachState.chips.map((x: any) => [x.file.name, x.origin])).toEqual([["a.jpg", "camera"]]);
        expect(c.state.error).toBe("Could not send the message. Try again.");
    });

    it("the composer is locked from the tap until the post is queued, the compress question included", async () => {
        const chat = fakeChat([msg(10)]);
        const c = make(chat);
        const a = fakeAttachments(c, { askCompress: true });
        await c.open();
        a.chip(outFile("IMG_1.jpg"), "camera");
        let duringQuestion: boolean | null = null;
        a.confirm.mockImplementation(async () => { duringQuestion = c.state.sending; return true; });
        let afterQueued: boolean | null = null;
        chat.send.mockImplementationOnce(async (_s: any, _ch: number, _t: string, _f: any, opts: any) => {
            expect(c.state.sending).toBe(true);
            opts.onQueued();
            afterQueued = c.state.sending;
            return msg(null);
        });
        c.state.text = "look";
        const sending = c.onSend();
        expect(c.state.sending).toBe(true);
        // A second tap while it runs sends nothing
        await c.onSend();
        await sending;
        expect(duringQuestion).toBe(true);
        expect(afterQueued).toBe(false);
        expect(chat.send).toHaveBeenCalledTimes(1);
        expect(c.state.sending).toBe(false);
        const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", "components", "chat", "chat_thread_component.ts"), "utf8");
        for (const cls of ["chat-thread__attach", "chat-thread__mic", "chat-thread__send"]) {
            const tag = source.slice(source.indexOf('class="' + cls + '"'));
            expect(tag.slice(0, tag.indexOf(">")), cls).toMatch(/t-att-disabled="[^"]*state\.sending/);
        }
        // A disabled or read-only field emptied at the tap makes Android close the keyboard: input is refused instead
        const input = source.slice(source.indexOf('class="chat-thread__input"'));
        expect(input.slice(0, input.indexOf("/>"))).toMatch(/t-on-beforeinput="onBeforeInput"/);
        expect(input.slice(0, input.indexOf("/>"))).not.toMatch(/t-att-(disabled|readonly)/);
    });

    it("the emoji button inserts at the caret and the draft holds it", async () => {
        const chat = fakeChat([msg(10)]);
        const c = make(chat);
        await c.open();
        const field = { value: "helloworld", selectionStart: 5, selectionEnd: 5, setSelectionRange: vi.fn() };
        c.input = { el: field };
        c.state.text = "helloworld";
        c.onEmoji("😀");
        expect(c.state.text).toBe("hello😀world");
        expect(field.setSelectionRange).toHaveBeenCalledWith(7, 7);
        await c.draftText.flush();
        expect(chat.saveDraftText).toHaveBeenLastCalledWith("a", 5, "hello😀world");
    });

    it("an emoji replaces the selected text", async () => {
        const c = make(fakeChat([msg(10)]));
        await c.open();
        c.input = { el: { value: "abcdef", selectionStart: 1, selectionEnd: 4, setSelectionRange: vi.fn() } };
        c.state.text = "abcdef";
        c.onEmoji("🙏");
        expect(c.state.text).toBe("a🙏ef");
    });

    it("an emoji is refused while a send runs, as typing is", async () => {
        const chat = fakeChat([msg(10)]);
        const c = make(chat);
        await c.open();
        let release!: () => void;
        chat.send.mockImplementationOnce(async (_s: any, _ch: number, _t: string, _f: any, opts: any) => {
            await new Promise<void>((r) => { release = r; });
            opts.onQueued();
            return msg(null);
        });
        c.state.text = "first";
        c.state.emoji = true;
        const sending = c.onSend();
        await vi.waitFor(() => expect(release).toBeTypeOf("function"));
        expect(c.state.emoji).toBe(false);
        c.onEmoji("😀");
        expect(c.state.text).toBe("");
        release();
        await sending;
        const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", "components", "chat", "chat_thread_component.ts"), "utf8");
        const tag = source.slice(source.indexOf('class="chat-thread__emoji"'));
        expect(tag.slice(0, tag.indexOf(">"))).toMatch(/t-att-disabled="[^"]*state\.sending/);
        expect(tag.slice(0, tag.indexOf(">"))).toMatch(/t-on-mousedown\.prevent/);
    });

    it("the emoji button toggles the picker", async () => {
        const c = make(fakeChat([msg(10)]));
        await c.open();
        expect(c.state.emoji).toBe(false);
        c.toggleEmoji();
        expect(c.state.emoji).toBe(true);
        c.toggleEmoji();
        expect(c.state.emoji).toBe(false);
    });

    it("typing while a send runs changes nothing: the field shows the composer's text again", async () => {
        const chat = fakeChat([msg(10)]);
        const c = make(chat);
        await c.open();
        let release!: () => void;
        chat.send.mockImplementationOnce(async (_s: any, _ch: number, _t: string, _f: any, opts: any) => {
            await new Promise<void>((r) => { release = r; });
            opts.onQueued();
            return msg(null);
        });
        c.state.text = "first";
        const sending = c.onSend();
        await vi.waitFor(() => expect(release).toBeTypeOf("function"));
        const before = { cancelable: true, preventDefault: vi.fn() };
        c.onBeforeInput(before as any);
        expect(before.preventDefault).toHaveBeenCalled();
        const field = { value: "x" };
        c.onInput({ target: field } as any);
        expect(c.state.text).toBe("");
        expect(field.value).toBe("");
        expect(chat.typing).not.toHaveBeenCalledWith(expect.anything(), 5, true);
        release();
        await sending;
        const after = { cancelable: true, preventDefault: vi.fn() };
        c.onBeforeInput(after as any);
        expect(after.preventDefault).not.toHaveBeenCalled();
        c.onInput({ target: { value: "next" } } as any);
        expect(c.state.text).toBe("next");
    });

    it("a send with files shows its bubble at once, « Preparing the photos… », until the post is queued", async () => {
        const chat = fakeChat([msg(10)]);
        const c = make(chat);
        const a = fakeAttachments(c, { askCompress: true });
        await c.open();
        const photo = outFile("IMG_1.jpg");
        const doc = outFile("plan.pdf", { mimetype: "application/pdf" });
        a.chip(photo, "camera");
        a.chip(doc, "file");
        let answer!: (yes: boolean) => void;
        a.confirm.mockImplementation(() => new Promise<boolean>((r) => { answer = r; }));
        let atQueue: any = "unset";
        chat.send.mockImplementationOnce(async (_s: any, _ch: number, _t: string, _f: any, opts: any) => {
            atQueue = c.state.preparing ? c.state.preparing.label : null;
            opts.onQueued();
            return msg(null);
        });
        c.state.text = "look";
        const sending = c.onSend();
        expect(c.state.preparing).toMatchObject({
            text: "look", label: "Preparing the photos…",
            files: [{ name: "IMG_1.jpg", image: true }, { name: "plan.pdf", image: false, url: null }],
        });
        // Still shown while the question waits, the photo by its staged file
        await vi.waitFor(() => expect(answer).toBeTypeOf("function"));
        await vi.waitFor(() => expect(c.state.preparing.files[0].url).toBe("http://localhost/_capacitor_file_/data/" + photo.path));
        expect(c.state.preparing).toMatchObject({ text: "look", label: "Preparing the photos…" });
        answer(true);
        await sending;
        expect(atQueue).toBe("Preparing the photos…");
        expect(c.state.preparing).toBeNull();
        const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", "components", "chat", "chat_thread_component.ts"), "utf8");
        expect(source).toMatch(/class="chat-thread__preparing" role="status" t-esc="state\.preparing\.label"/);
    });

    it("the preparing bubble shows small thumbnails, not full-size originals", async () => {
        const chat = fakeChat([msg(10)]);
        const c = make(chat);
        const a = fakeAttachments(c, { askCompress: true });
        await c.open();
        const photos = [1, 2, 3, 4, 5].map((i) => outFile(`IMG_${i}.jpg`));
        for (const p of photos) a.chip(p, "gallery");
        let answer!: (yes: boolean) => void;
        a.confirm.mockImplementation(() => new Promise<boolean>((r) => { answer = r; }));
        chat.send.mockImplementationOnce(async (_s: any, _ch: number, _t: string, _f: any, opts: any) => {
            opts.onQueued();
            return msg(null);
        });
        const sending = c.onSend();
        await vi.waitFor(() => expect(answer).toBeTypeOf("function"));
        await vi.waitFor(() => expect(c.state.preparing.files[2].url).not.toBeNull());
        // A staged photo is a full-size original: only the first ones are decoded, the others named
        expect(c.state.preparing.files.map((f: any) => [f.name, f.url !== null])).toEqual([
            ["IMG_1.jpg", true], ["IMG_2.jpg", true], ["IMG_3.jpg", true], ["IMG_4.jpg", false], ["IMG_5.jpg", false],
        ]);
        answer(true);
        await sending;
        const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", "components", "chat", "chat_thread_component.ts"), "utf8");
        const img = source.match(/<img t-if="file\.url" class="chat-thread__preparing-image"[^>]*>/)?.[0] ?? "";
        expect(img).toMatch(/ decoding="async"/);
        expect(img).toMatch(/ width="64" height="64"/);
    });

    it("a send of other files says « Preparing the files… »; a text alone shows no such bubble; a refusal takes it away", async () => {
        const chat = fakeChat([msg(10)]);
        const c = make(chat);
        const a = fakeAttachments(c);
        await c.open();
        a.chip(outFile("plan.pdf", { mimetype: "application/pdf" }), "file");
        chat.send.mockRejectedValueOnce(new Error("disk"));
        const refused = c.onSend();
        expect(c.state.preparing).toMatchObject({ text: "", label: "Preparing the files…" });
        await refused;
        expect(c.state.preparing).toBeNull();
        c.state.text = "plain";
        const plain = c.onSend();
        expect(c.state.preparing).toBeNull();
        await plain;
    });

    it("a send holds its conversation's draft from the tap until the post is queued, or refused", async () => {
        const chat = fakeChat([msg(10)]);
        const c = make(chat);
        await c.open();
        let endedAtQueue: number | null = null;
        chat.send.mockImplementationOnce(async (_s: any, _ch: number, _t: string, _f: any, opts: any) => {
            opts.onQueued();
            endedAtQueue = chat.sendStarted.mock.results[0].value.mock.calls.length;
            return msg(null);
        });
        c.state.text = "one";
        const sending = c.onSend();
        expect(chat.sendStarted).toHaveBeenCalledWith("a", 5);
        expect(chat.sendStarted.mock.results[0].value).not.toHaveBeenCalled();
        await sending;
        expect(endedAtQueue).toBe(1);
        chat.send.mockRejectedValueOnce(new Error("disk"));
        c.state.text = "two";
        await c.onSend();
        expect(chat.sendStarted.mock.results[1].value).toHaveBeenCalled();
    });

    it("a failure after the post was queued puts back neither its text nor its chips", async () => {
        const chat = fakeChat([msg(10)]);
        const c = make(chat);
        const a = fakeAttachments(c);
        await c.open();
        a.chip(outFile("a.jpg"));
        chat.send.mockImplementationOnce(async (_s: any, _ch: number, _t: string, _f: any, opts: any) => {
            opts.onQueued();
            throw new Error("the flush after it failed");
        });
        const reads = chat.draft.mock.calls.length;
        c.state.text = "queued already";
        await c.onSend();
        expect(c.state.text).toBe("");
        expect(c.state.error).toBe("");
        expect(c.attachState.chips).toEqual([]);
        expect(chat.draft.mock.calls.length).toBe(reads);
    });

    it("a refused send leaves the composer open again with its text and the draft as it was", async () => {
        const chat = fakeChat([msg(10)]);
        chat.send.mockRejectedValueOnce(new Error("disk"));
        const c = make(chat);
        await c.open();
        c.state.text = "first\nsecond";
        await c.onSend();
        expect(c.state.text).toBe("first\nsecond");
        expect(c.state.inputRows).toBe(2);
        expect(c.state.sending).toBe(false);
        expect(chat.saveDraftText.mock.calls).toEqual([["a", 5, "first\nsecond"]]);
    });

    it("a send stores its text in the draft at the tap and leaves its removal to the post", async () => {
        vi.useFakeTimers();
        try {
            const chat = fakeChat([msg(10)]);
            const c = make(chat);
            fakeAttachments(c);
            await c.open();
            c.onInput({ target: { value: "sent at once " } } as any);
            const sending = c.onSend();
            // Stored before the compress question: a kill there keeps the text
            expect(chat.saveDraftText.mock.calls).toEqual([["a", 5, "sent at once "]]);
            expect(c.state.text).toBe("");
            await sending;
            vi.advanceTimersByTime(1000);
            // The outbox removes exactly that text; the composer never writes ""
            expect(chat.send).toHaveBeenCalledWith(expect.anything(), 5, "sent at once", [], expect.objectContaining({ draftText: "sent at once " }));
            expect(chat.saveDraftText.mock.calls).toEqual([["a", 5, "sent at once "]]);
        } finally {
            vi.useRealTimers();
        }
    });

    it("text typed before the draft is read joins the stored text instead of replacing it", async () => {
        const chat = fakeChat([msg(10)]);
        let answer!: (d: any) => void;
        chat.draft.mockImplementationOnce(() => new Promise((r) => { answer = r; }));
        const c = make(chat);
        const opening = c.open();
        await vi.waitFor(() => expect(chat.draft).toHaveBeenCalled());
        c.onInput({ target: { value: "typed early" } } as any);
        answer({ text: "stored", files: [], lost: [] });
        await opening;
        expect(c.state.text).toBe("stored\ntyped early");
        expect(chat.saveDraftText.mock.calls).toEqual([["a", 5, "stored\ntyped early"]]);
    });

    it("the stored text typed again before the read, blanks around aside, is not doubled", async () => {
        const chat = fakeChat([msg(10)]);
        let answer!: (d: any) => void;
        chat.draft.mockImplementationOnce(() => new Promise((r) => { answer = r; }));
        const c = make(chat);
        const opening = c.open();
        await vi.waitFor(() => expect(chat.draft).toHaveBeenCalled());
        c.onInput({ target: { value: "hello  " } } as any);
        answer({ text: "hello", files: [], lost: [] });
        await opening;
        expect(c.state.text).toBe("hello  ");
    });

    it("opening shows the draft: its text, its files as chips in order, the lost ones named", async () => {
        const chat = fakeChat([msg(10)]);
        const photo = outFile("IMG_20261026_101500.jpg");
        const voice = outFile("Voice-2026-10-26-9.mp3", { mimetype: "audio/mpeg", voice: true });
        chat.draft.mockResolvedValue({ text: "line one\nline two", files: [draftRow(photo, 0, "camera"), draftRow(voice, 1)], lost: ["gone.pdf"] });
        const c = make(chat);
        fakeAttachments(c);
        await c.open();
        expect(chat.draft).toHaveBeenCalledWith("a", 5);
        expect(c.state.text).toBe("line one\nline two");
        expect(c.state.inputRows).toBe(2);
        expect(c.attachState.chips.map((x: any) => [x.file.name, x.file.path, x.origin, x.seq])).toEqual([
            [photo.name, photo.path, "camera", 0], [voice.name, voice.path, "voice", 1],
        ]);
        expect(c.attach.hasVoiceChip()).toBe(true);
        expect(c.attachState.notices).toEqual(["“gone.pdf” was no longer on the phone: it was taken out of the draft."]);
    });

    it("typing stores the draft text after a pause, and at once when the screen closes or the app leaves the front", async () => {
        vi.useFakeTimers();
        try {
            const chat = fakeChat([msg(10)]);
            const c = make(chat);
            await c.open();
            c.onInput({ target: { value: "hel" } } as any);
            c.onInput({ target: { value: "hello" } } as any);
            expect(chat.saveDraftText).not.toHaveBeenCalled();
            vi.advanceTimersByTime(500);
            expect(chat.saveDraftText.mock.calls).toEqual([["a", 5, "hello"]]);
            c.onInput({ target: { value: "hello wor" } } as any);
            const listener = (App.addListener as any).mock.calls.filter((x: any[]) => x[0] === "appStateChange").at(-1)[1];
            listener({ isActive: false });
            expect(chat.saveDraftText.mock.calls.at(-1)).toEqual(["a", 5, "hello wor"]);
            c.onInput({ target: { value: "hello world" } } as any);
            c.teardown();
            expect(chat.saveDraftText.mock.calls.at(-1)).toEqual(["a", 5, "hello world"]);
        } finally {
            vi.useRealTimers();
        }
    });

    it("the composer keeps its files in the conversation's draft", async () => {
        const chat = fakeChat([msg(10)]);
        const c = make(chat);
        await c.open();
        const f = outFile("a.jpg");
        await c.attach.deps.draft.keep(f, 3, "camera");
        await c.attach.deps.draft.drop(f);
        expect(chat.keepDraftFile).toHaveBeenCalledWith("a", 5, f, 3, "camera");
        expect(chat.dropDraftFile).toHaveBeenCalledWith("a", f);
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
        expect(chat.send).toHaveBeenCalledWith(expect.anything(), 5, "listen", [photo, a.voice], expect.objectContaining({ draftText: "listen" }));
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
        expect(chat.send).toHaveBeenCalledWith(expect.anything(), 5, "", [expect.objectContaining({ name: "IMG_1.jpg", size: 10 })], expect.objectContaining({ draftText: "" }));
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

    it("leaving the screen keeps the recording under way as a draft voice file", async () => {
        const chat = fakeChat([msg(10)]);
        const c = make(chat);
        const a = fakeAttachments(c);
        await c.open();
        await c.attach.start();
        await c.attach.mic();
        c.teardown();
        await vi.waitFor(() => expect(chat.keepDraftFile).toHaveBeenCalledWith("a", 5, a.voice, 0, "voice"));
        expect(a.recorder.discard).not.toHaveBeenCalled();
        expect(chat.send).not.toHaveBeenCalled();
        expect(a.recorder.onAutoStop).toBeNull();
    });

    // ─── Attachments ──────────────────────────────────────────────────────

    it("a message's files reach its row; previews wait until the row is on screen", async () => {
        const chat = fakeChat([msg(10, { body: "" }), msg(11)]);
        chat.repo.attachmentsOf.mockResolvedValue(new Map([["m10", [fileRow(31), fileRow(32, { name: "a.pdf", mimetype: "application/pdf" })]]]));
        const c = make(chat);
        await c.open();
        expect(chat.repo.attachmentsOf).toHaveBeenCalledWith("a", 5, [10, 11], []);
        expect(c.state.rows.map((r: any) => r.attachments.map((v: any) => [v.key, v.kind, v.state]))).toEqual([
            [["a31", "image", "remote"], ["a32", "file", "remote"]],
            [],
        ]);
        // An attachment-only message has no text bubble
        expect(c.state.rows.map((r: any) => r.hasBody)).toEqual([false, true]);
        expect(chat.attachments.preview).not.toHaveBeenCalled();
        c.attachments.seen("m10");
        await new Promise((r) => setTimeout(r, 0));
        expect(chat.attachments.preview).toHaveBeenCalledTimes(1);
        c.teardown();
    });

    it("a queued post whose upload waits for Wi-Fi reads « waiting for Wi-Fi »", async () => {
        const pending = msg(null, { clientUuid: "P1", outboxOpId: "op9", body: "<p>look</p>" });
        const chat = fakeChat([msg(10), pending]);
        chat.repo.attachmentsOf.mockResolvedValue(new Map([["uP1", [
            fileRow(null, { localUuid: "lu1", state: "queued", postClientUuid: "P1", originalPath: "chat/d/out/lu1/IMG_1.jpg" }),
        ]]]));
        const c = make(chat, [
            { id: "op9", kind: "chat.post", dependsOn: "op8", status: "queued", params: {} },
            { id: "op8", kind: "chat.upload", dependsOn: null, status: "queued", params: { localUuid: "lu1", heldFor: "wifi" } },
        ]);
        await c.open();
        expect(chat.repo.attachmentsOf).toHaveBeenCalledWith("a", 5, [10], ["P1"]);
        const row = c.state.rows[1];
        expect(row.meta).toBe("waiting_wifi");
        expect(row.attachments.map((v: any) => [v.state, v.src])).toEqual([
            ["waiting_wifi", "http://localhost/_capacitor_file_/data/chat/d/out/lu1/IMG_1.jpg"],
        ]);
        c.teardown();
    });

    it("a progress tick renders again only the rows whose files changed", async () => {
        const pending = msg(null, { clientUuid: "P1", outboxOpId: "op9" });
        const chat = fakeChat([msg(10), pending]);
        chat.repo.attachmentsOf.mockResolvedValue(new Map([["uP1", [
            fileRow(null, { localUuid: "lu1", state: "queued", postClientUuid: "P1", originalPath: "chat/d/out/lu1/IMG_1.jpg" }),
        ]]]));
        const c = make(chat, [{ id: "op9", kind: "chat.post", dependsOn: null, status: "queued", params: {} }]);
        await c.open();
        const before = c.state.rows;
        c.retick();
        expect(c.state.rows).toBe(before);
        chat.queue.uploadProgress.mockImplementation(() => ({ done: 500, total: 1000 }));
        c.retick();
        expect(c.state.rows).not.toBe(before);
        expect(c.state.rows[0]).toBe(before[0]);
        expect(c.state.rows[1].attachments[0]).toMatchObject({ state: "uploading", progress: 50 });
        c.teardown();
    });

    it("a tap on an image opens the viewer; closing it empties it", async () => {
        const chat = fakeChat([msg(10)]);
        chat.repo.attachmentsOf.mockResolvedValue(new Map([["m10", [fileRow(31)]]]));
        const c = make(chat);
        await c.open();
        c.openImage("a31");
        expect(c.state.viewer).toBe("a31");
        c.closeViewer();
        expect(c.state.viewer).toBeNull();
        const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", "components", "chat", "chat_thread_component.ts"), "utf8");
        expect(source).toMatch(/<ChatAttachmentsComponent t-if="row.attachments.length" row="row" ta="attachments"/);
        expect(source).toMatch(/<ChatImageViewerComponent t-if="state.viewer"/);
        c.teardown();
    });

    it("a post with files waits for an earlier post, not for its own uploads", async () => {
        const first = msg(null, { clientUuid: "P1", outboxOpId: "op1" });
        const second = msg(null, { clientUuid: "P2", outboxOpId: "op9" });
        const chat = fakeChat([first, second]);
        const ops = [
            { id: "op9", kind: "chat.post", dependsOn: "op8", status: "queued", params: {} },
            { id: "op8", kind: "chat.upload", dependsOn: null, status: "queued", params: { localUuid: "lu1" } },
        ];
        const c = make(chat, ops);
        await c.open();
        expect(c.state.rows.map((r: any) => r.meta)).toEqual(["pending", "pending"]);
        ops[1].dependsOn = "op1";
        ops.push({ id: "op1", kind: "chat.post", dependsOn: null, status: "queued", params: {} });
        await c.refresh();
        expect(c.state.rows.map((r: any) => r.meta)).toEqual(["pending", "waiting"]);
        c.teardown();
    });

    it("a file goes to the native « open with » with its mimetype and the chooser's title", async () => {
        const openWith = vi.fn(async () => {});
        __setPluginMock("ChatFile", { openWith });
        const chat = fakeChat([msg(10)]);
        chat.repo.attachmentsOf.mockResolvedValue(new Map([["m10", [fileRow(32, { name: "a.pdf", mimetype: "application/pdf" })]]]));
        const c = make(chat);
        await c.open();
        await c.attachments.openFile("a32");
        expect(openWith).toHaveBeenCalledWith({
            uri: "file:///data/user/0/app/files/chat/d/files/32/a.pdf", mimetype: "application/pdf", title: "Open with",
        });
        __clearPluginMocks();
        c.teardown();
    });
});

/** A reaction group as ChatService.reactions gives it. */
const reaction = (content: string, p: any = {}) => ({
    configId: "a", channelId: 5, messageKey: "m10", messageId: 10, content, count: 1,
    selfReacted: false, partnerIds: [7], guestCount: 0, sequence: 1, ...p,
});

describe("ChatThreadComponent message actions", () => {
    afterEach(() => {
        vi.useRealTimers();
        (Dialog.confirm as any).mockReset?.();
        (Dialog.confirm as any).mockResolvedValue?.({ value: true });
    });

    const press = (x = 10, y = 10) => ({ button: 0, clientX: x, clientY: y });

    it("a long press on a bubble opens its menu; a short one or a scroll does not", async () => {
        const chat = fakeChat([msg(10), msg(11, { authorPartnerId: 7 })]);
        const c = make(chat);
        await c.open();
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const [mine, theirs] = c.state.rows;
        c.onPressDown(theirs, press());
        vi.advanceTimersByTime(LONG_PRESS_MS - 100);
        c.onPressUp();
        vi.advanceTimersByTime(LONG_PRESS_MS);
        expect(c.state.actions).toBeNull();
        c.onPressDown(theirs, press());
        await c.onScroll();
        vi.advanceTimersByTime(LONG_PRESS_MS);
        expect(c.state.actions).toBeNull();
        c.onPressDown(mine, press());
        vi.advanceTimersByTime(LONG_PRESS_MS);
        expect(c.state.actions).toBe("m10");
        c.teardown();
    });

    it("the click ending a long press is swallowed, a plain tap goes through", async () => {
        const c = make(fakeChat([msg(10)]));
        await c.open();
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const ev = () => ({ stopPropagation: vi.fn(), preventDefault: vi.fn() });
        c.onPressDown(c.state.rows[0], press());
        c.onPressUp();
        const tap = ev();
        c.onBubbleClick(tap);
        expect(tap.stopPropagation).not.toHaveBeenCalled();
        c.onPressDown(c.state.rows[0], press());
        vi.advanceTimersByTime(LONG_PRESS_MS);
        c.onPressUp();
        const end = ev();
        c.onBubbleClick(end);
        expect(end.stopPropagation).toHaveBeenCalled();
        expect(end.preventDefault).toHaveBeenCalled();
        c.teardown();
    });

    it("the bubble keeps scrolling and selection: no preventDefault on its press, its contextmenu prevented", () => {
        const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", "components", "chat", "chat_thread_component.ts"), "utf8");
        const bubble = source.slice(source.indexOf('class="chat-thread__bubble"'), source.indexOf('<div t-if="row.hasBody"'));
        expect(bubble).toMatch(/t-on-pointerdown="\(ev\) => this.onPressDown\(row, ev\)"/);
        expect(bubble).not.toMatch(/t-on-pointerdown\.prevent/);
        expect(bubble).toMatch(/t-on-contextmenu\.prevent=""/);
        expect(bubble).toMatch(/t-on-click\.capture="onBubbleClick"/);
    });

    it("what the menu offers follows Odoo: another's message no edit or delete, a notification copy only", async () => {
        const chat = fakeChat([
            msg(10),
            msg(11, { authorPartnerId: 7 }),
            msg(12, { messageType: "notification", authorPartnerId: 7 }),
            msg(13, { body: "" }),
            msg(null, { clientUuid: "F1", status: "failed", outboxOpId: "op1" }),
        ]);
        chat.repo.attachmentsOf.mockResolvedValue(new Map([["m13", [fileRow(31)]]]));
        const c = make(chat);
        await c.open();
        expect(c.state.rows.map((r: any) => r.can)).toEqual([
            { react: true, reply: true, copy: true, edit: true, delete: true },
            { react: true, reply: true, copy: true, edit: false, delete: false },
            { react: false, reply: false, copy: true, edit: false, delete: false },
            { react: true, reply: true, copy: false, edit: true, delete: true },
            { react: false, reply: false, copy: true, edit: false, delete: true },
        ]);
        expect(c.state.rows[0].target).toEqual({ messageId: 10, clientUuid: null });
        expect(c.state.rows[4].target).toEqual({ messageId: null, clientUuid: "F1" });
        c.openActions("m11");
        expect(c.menuCan()).toMatchObject({ react: true, copy: true, edit: false, delete: false });
        c.teardown();
    });

    it("a quick emoji reacts: on when the user has not, off when they have", async () => {
        const chat = fakeChat([msg(10)]);
        chat.reactions.mockResolvedValue(new Map([["m10", [reaction("👍", { selfReacted: true, partnerIds: [1] })]]]));
        const c = make(chat);
        await c.open();
        expect(chat.reactions).toHaveBeenCalledWith("a", 5, ["m10"]);
        c.openActions("m10");
        expect(c.activeOf()).toEqual(["👍"]);
        await c.onMenuReact("😂");
        await c.onMenuReact("👍");
        expect(chat.react.mock.calls).toEqual([
            [expect.objectContaining({ configId: "a" }), 5, { messageId: 10, clientUuid: null }, "😂", true],
            [expect.objectContaining({ configId: "a" }), 5, { messageId: 10, clientUuid: null }, "👍", false],
        ]);
        c.closeActions();
        expect(c.state.actions).toBeNull();
        c.teardown();
    });

    it("« … » opens the picker once the menu is gone, and a pick reacts instead of typing", async () => {
        const chat = fakeChat([msg(10)]);
        chat.reactions.mockResolvedValue(new Map([["m10", [reaction("👍", { selfReacted: true, partnerIds: [1] })]]]));
        const c = make(chat);
        await c.open();
        c.openActions("m10");
        c.onMenuMore();
        expect(c.state.emoji).toBe(false);
        c.closeActions();
        expect(c.state.emoji).toBe(true);
        expect(c.state.reactTo).toBe("m10");
        c.onEmoji("🎉");
        expect(chat.react).toHaveBeenCalledWith(expect.anything(), 5, { messageId: 10, clientUuid: null }, "🎉", true);
        expect(c.state.text).toBe("");
        expect(c.state.emoji).toBe(false);
        expect(c.state.reactTo).toBeNull();
        // A pick of a reaction the user already has leaves it, as Odoo's picker does
        c.openActions("m10");
        c.onMenuMore();
        c.closeActions();
        c.onEmoji("👍");
        expect(chat.react).toHaveBeenCalledTimes(1);
        // The composer's 😊 still types
        c.toggleEmoji();
        c.onEmoji("😀");
        expect(c.state.text).toBe("😀");
        const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", "components", "chat", "chat_thread_component.ts"), "utf8");
        expect(source).toMatch(/<ChatEmojiPickerComponent t-if="state.emoji" countUse="!state.reactTo"/);
        c.teardown();
    });

    it("copy writes the body's text and shows « Copied » for 1.5 s; a refusal says so", async () => {
        const body = '<p>one<br>two <a href="/odoo/res.partner/7" class="o_mail_redirect" data-oe-id="7" data-oe-model="res.partner">@Alice Martin</a></p>';
        const writeText = vi.fn(async (_t: string) => {});
        vi.stubGlobal("navigator", { clipboard: { writeText } });
        const c = make(fakeChat([msg(10, { body })]));
        await c.open();
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        c.openActions("m10");
        await c.onMenuCopy();
        expect(writeText).toHaveBeenCalledWith("one\ntwo @Alice Martin");
        expect(c.state.flash).toBe("Copied");
        vi.advanceTimersByTime(1499);
        expect(c.state.flash).toBe("Copied");
        vi.advanceTimersByTime(1);
        expect(c.state.flash).toBe("");
        writeText.mockRejectedValueOnce(new Error("denied"));
        await c.onMenuCopy();
        expect(c.state.flash).toBe("Could not copy the text");
        vi.stubGlobal("navigator", {});
        await c.onMenuCopy();
        expect(c.state.flash).toBe("Could not copy the text");
        c.teardown();
    });

    it("delete asks first and deletes only on yes", async () => {
        const chat = fakeChat([msg(10)]);
        const c = make(chat);
        await c.open();
        (Dialog.confirm as any).mockResolvedValueOnce({ value: false });
        c.openActions("m10");
        await c.onMenuDelete();
        expect(Dialog.confirm).toHaveBeenCalledWith(expect.objectContaining({ message: "Delete this message?" }));
        expect(chat.deleteMessage).not.toHaveBeenCalled();
        (Dialog.confirm as any).mockResolvedValueOnce({ value: true });
        c.openActions("m10");
        await c.onMenuDelete();
        expect(chat.deleteMessage).toHaveBeenCalledWith(expect.objectContaining({ configId: "a" }), 5, { messageId: 10, clientUuid: null });
        c.teardown();
    });

    it("a chip tap removes an own reaction and adds another's", async () => {
        const chat = fakeChat([msg(10)]);
        chat.reactions.mockResolvedValue(new Map([["m10", [
            reaction("👍", { count: 2, selfReacted: true, partnerIds: [1, 7] }),
            reaction("😂", { sequence: 2 }),
        ]]]));
        const c = make(chat);
        await c.open();
        const row = c.state.rows[0];
        expect(row.reactions.map((r: any) => [r.content, r.count, r.self])).toEqual([["👍", 2, true], ["😂", 1, false]]);
        await c.onChip(row, "👍");
        await c.onChip(row, "😂");
        expect(chat.react.mock.calls.map((a: any[]) => [a[3], a[4]])).toEqual([["👍", false], ["😂", true]]);
        c.teardown();
    });

    it("a chip long press lists who reacted by name, guests counted", async () => {
        const chat = fakeChat([msg(10)]);
        chat.reactions.mockResolvedValue(new Map([["m10", [reaction("😂", { count: 3, partnerIds: [7, 8], guestCount: 1 })]]]));
        const c = make(chat);
        await c.open();
        c.onWho(c.state.rows[0], "😂");
        expect(c.state.who).toEqual({ content: "😂", count: 3, self: false, names: ["Alice Roy", "Bob", "Guest"] });
        c.closeWho();
        expect(c.state.who).toBeNull();
        c.teardown();
    });

    it("the user's own reaction names them even when the partners cache does not", async () => {
        const chat = fakeChat([msg(10)]);
        chat.reactions.mockResolvedValue(new Map([["m10", [reaction("👍", { count: 2, selfReacted: true, partnerIds: [1, 7] })]]]));
        const c = make(chat);
        await c.open();
        expect(c.state.rows[0].reactions[0].names).toEqual(["You", "Alice Roy"]);
        c.teardown();
    });

    it("each bubble has a focusable « Message actions » control that opens its menu without a long press", async () => {
        const chat = fakeChat([msg(10), msg(12, { messageType: "notification", body: "" })]);
        chat.repo.attachmentsOf.mockResolvedValue(new Map([["m12", [fileRow(32)]]]));
        const c = make(chat);
        await c.open();
        expect(c.state.rows.map((r: any) => c.offers(r))).toEqual([true, false]);
        c.openActions("m10");
        expect(c.state.actions).toBe("m10");
        const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", "components", "chat", "chat_thread_component.ts"), "utf8");
        expect(source).toMatch(/<button t-if="offers\(row\)" type="button" class="chat-thread__actions" aria-haspopup="dialog"\s+t-att-aria-label="t\('chat.message_actions'\)" t-on-click="\(\) => this.openActions\(row.key\)"/);
        c.teardown();
    });

    it("a reaction change repaints the row", async () => {
        const chat = fakeChat([msg(10)]);
        const c = make(chat);
        await c.open();
        const before = c.state.rows;
        expect(before[0].reactions).toEqual([]);
        chat.reactions.mockResolvedValue(new Map([["m10", [reaction("👍")]]]));
        await c.refresh();
        expect(c.state.rows).not.toBe(before);
        expect(c.state.rows[0].reactions).toHaveLength(1);
        c.teardown();
    });
});

describe("ChatThreadComponent edited, deleted and quoted messages", () => {
    afterEach(() => {
        vi.useRealTimers();
        (Dialog.confirm as any).mockReset?.();
        (Dialog.confirm as any).mockResolvedValue?.({ value: true });
    });

    const EDITED = '<span class="o-mail-Message-edited"></span>';
    const keys = (c: any) => c.state.rows.map((r: any) => r.key);
    /** The rendered body of a row as DOM, for a tap on one of its anchors. */
    const bodyOf = (row: any) => {
        const div = document.createElement("div");
        div.innerHTML = String(row.html);
        return div;
    };
    const tap = (target: Element) => ({ target, preventDefault: vi.fn() });

    it("an edited message shows « (modifié) »", async () => {
        const c = make(fakeChat([msg(10, { body: "<p>hi</p>" + EDITED }), msg(11)]));
        localStorage.setItem("app_lang", "fr");
        await c.open();
        expect(String(c.state.rows[0].html)).toBe('<p>hi</p><em class="chat-msg__edited"> (modifié)</em>');
        expect(String(c.state.rows[1].html)).not.toContain("chat-msg__edited");
        c.teardown();
    });

    it("a deleted message is hidden", async () => {
        const chat = fakeChat([
            msg(10), msg(11, { body: "" }), msg(12, { body: "<p></p>" + EDITED }), msg(13, { body: "" }), msg(14, { body: EDITED }),
        ]);
        chat.repo.attachmentsOf.mockResolvedValue(new Map([["m13", [fileRow(31)]], ["m14", [fileRow(32)]]]));
        const c = make(chat);
        await c.open();
        // An emptied body with a file stays, as the browser's; an edited mark alone shows no text bubble
        expect(keys(c)).toEqual(["m10", "m13", "m14"]);
        expect(c.state.rows[2].hasBody).toBe(false);
        c.teardown();
    });

    it("a queued delete hides the row at once", async () => {
        const chat = fakeChat([
            msg(10), msg(11, { body: "" }), msg(12, { body: "" }),
            msg(null, { clientUuid: "P1", body: "", outboxOpId: "post1" }),
        ]);
        chat.repo.attachmentsOf.mockResolvedValue(new Map([
            ["m11", [fileRow(31)]], ["m12", [fileRow(32)]], ["uP1", [fileRow(null, { localUuid: "l1", postClientUuid: "P1" })]],
        ]));
        const ops = [
            { id: "post1", kind: "chat.post", status: "running", dependsOn: null, params: {} },
            { id: "d1", kind: "chat.delete", status: "pending", dependsOn: null, params: { channelId: 5, messageId: 11, clientUuid: null } },
            { id: "d2", kind: "chat.delete", status: "pending", dependsOn: "post1", params: { channelId: 5, messageId: null, clientUuid: "P1" } },
            // Refused: the server's body is shown again
            { id: "d3", kind: "chat.delete", status: "blocked", dependsOn: null, params: { channelId: 5, messageId: 12, clientUuid: null } },
        ];
        const c = make(chat, ops);
        await c.open();
        expect(keys(c)).toEqual(["m10", "m12"]);
        c.teardown();
    });

    it("quote of a parent with text", async () => {
        const list = [
            msg(5, { authorPartnerId: 8, body: "<p>old</p>" }),
            msg(20, { authorPartnerId: 7, body: "<p>Bonjour <b>à tous</b></p>" + EDITED }),
            msg(21, { parentId: 20 }),
            msg(22, { parentId: 5 }),
            msg(23, { parentId: 3 }),
            msg(null, { clientUuid: "P1", body: "<p>first</p>", outboxOpId: "o1" }),
            msg(null, { clientUuid: "P2", parentClientUuid: "P1", outboxOpId: "o2" }),
        ];
        const chat = fakeChat(list, undefined, channel({ oldestLoadedId: 20 }));
        chat.repo.messageOf.mockImplementation(async (_c: string, t: any) => t.messageId === 3 ? msg(3, { authorPartnerId: 1, body: "<p>mine</p>" }) : null);
        const c = make(chat);
        await c.open();
        // The parent cached below the loaded history is quoted, never shown as a row
        expect(keys(c)).toEqual(["m20", "m21", "m22", "m23", "uP1", "uP2"]);
        const quote = (key: string) => c.state.rows.find((r: any) => r.key === key).quote;
        expect(quote("m20")).toBeNull();
        expect(quote("m21")).toEqual({ key: "m20", author: "Alice Roy", text: "Bonjour à tous", edited: true, state: "text" });
        expect(quote("m22")).toEqual({ key: "m5", author: "Bob", text: "old", edited: false, state: "text" });
        expect(quote("m23")).toEqual({ key: "m3", author: "You", text: "mine", edited: false, state: "text" });
        expect(quote("uP2")).toEqual({ key: "uP1", author: "You", text: "first", edited: false, state: "text" });
        expect(chat.repo.messageOf).toHaveBeenCalledTimes(1);
        c.teardown();
    });

    it("quote of an emptied parent", async () => {
        const list = [
            msg(10, { body: "" }),
            msg(11, { parentId: 10 }),
            msg(12, { body: "" }),
            msg(13, { parentId: 12 }),
            msg(14, { parentId: 4 }),
            msg(null, { clientUuid: "P2", parentClientUuid: "GONE", outboxOpId: "o2" }),
        ];
        const chat = fakeChat(list, undefined, channel({ historyComplete: true }));
        chat.repo.attachmentsOf.mockResolvedValue(new Map([["m12", [fileRow(32)]]]));
        const ops = [
            { id: "o2", kind: "chat.post", status: "pending", dependsOn: null, params: {} },
            { id: "d1", kind: "chat.delete", status: "pending", dependsOn: null, params: { channelId: 5, messageId: 12, clientUuid: null } },
        ];
        const c = make(chat, ops);
        localStorage.setItem("app_lang", "fr");
        await c.open();
        const deleted = { key: null, author: "", text: "Message d'origine supprimé", edited: false, state: "deleted" };
        // Emptied, emptied by a queued delete (its file still there), removed from a complete history, a queued parent dropped
        expect(c.state.rows.map((r: any) => r.quote)).toEqual([deleted, deleted, deleted, deleted]);
        c.teardown();
    });

    it("quote of attachments only", async () => {
        const chat = fakeChat([msg(10, { authorPartnerId: 7, body: "<p></p>" }), msg(11, { parentId: 10 })]);
        chat.repo.attachmentsOf.mockResolvedValue(new Map([["m10", [fileRow(31)]]]));
        const c = make(chat);
        await c.open();
        expect(c.state.rows[1].quote).toEqual({
            key: "m10", author: "Alice Roy", text: "Tap to see the attachments", edited: false, state: "attachments",
        });
        c.teardown();
    });

    it("tap on a quote scrolls to its row", async () => {
        const c = make(fakeChat([msg(10), msg(11, { parentId: 10 })]));
        await c.open();
        const el = document.createElement("div");
        const bubbles = ["m10", "m11"].map((k) => {
            const b = document.createElement("div");
            b.className = "chat-thread__bubble";
            b.dataset.key = k;
            (b as any).scrollIntoView = vi.fn();
            el.appendChild(b);
            return b;
        });
        c.scroller = { el };
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        c.onQuote(c.state.rows[1]);
        expect((bubbles[0] as any).scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ block: "center" }));
        expect((bubbles[1] as any).scrollIntoView).not.toHaveBeenCalled();
        expect(c.state.highlight).toBe("m10");
        vi.advanceTimersByTime(1000);
        expect(c.state.highlight).toBeNull();
        c.teardown();
    });

    it("tap on a quote of an unloaded parent", async () => {
        const list = [msg(5), msg(20), msg(21, { parentId: 5 }), msg(22, { parentId: 3 })];
        const c = make(fakeChat(list, undefined, channel({ oldestLoadedId: 20 })));
        await c.open();
        const el = document.createElement("div");
        c.scroller = { el };
        // Never loaded: a neutral quote that cannot be tapped
        expect(c.state.rows[2].quote).toEqual({ key: null, author: "", text: "Original message", edited: false, state: "text" });
        c.onQuote(c.state.rows[2]);
        // Cached but not rendered: nothing to scroll to
        expect(c.state.rows[1].quote.key).toBe("m5");
        c.onQuote(c.state.rows[1]);
        expect(c.state.highlight).toBeNull();
        c.teardown();
    });

    it("a quote change repaints the row", async () => {
        const list = [msg(5, { body: "<p>one</p>" }), msg(20), msg(21, { parentId: 5 })];
        const c = make(fakeChat(list, undefined, channel({ oldestLoadedId: 20 })));
        await c.open();
        const before = c.state.rows;
        list[0] = msg(5, { body: "<p>two</p>" + EDITED });
        await c.refresh();
        expect(c.state.rows).not.toBe(before);
        expect(c.state.rows[1].quote).toMatchObject({ text: "two", edited: true });
        c.teardown();
    });

    it("a mention tap opens the direct message", async () => {
        const mention = (id: number, name: string) =>
            `<a href="/odoo/res.partner/${id}" class="o_mail_redirect" data-oe-id="${id}" data-oe-model="res.partner" target="_blank">@${name}</a>`;
        const chat = fakeChat([msg(10, { body: "<p>" + mention(7, "Alice Roy") + " " + mention(1, "Me") + "</p>" })]);
        const c = make(chat);
        c.navigate = vi.fn();
        await c.open();
        const body = bodyOf(c.state.rows[0]);
        const [alice, me] = Array.from(body.querySelectorAll("a"));
        expect(me.className).toBe("chat-msg__mention chat-msg__mention--self");
        await c.onBodyClick(tap(me));
        expect(chat.startDirect).not.toHaveBeenCalled();
        const ev = tap(alice);
        await c.onBodyClick(ev);
        expect(ev.preventDefault).toHaveBeenCalled();
        expect(chat.startDirect).toHaveBeenCalledWith(expect.objectContaining({ configId: "a" }), 7, { background: true });
        expect(c.navigate).toHaveBeenCalledWith("/chat/a/40");
        // Plain text of the body opens nothing
        await c.onBodyClick(tap(body.querySelector("p")!));
        expect(chat.startDirect).toHaveBeenCalledTimes(1);
        c.teardown();
    });

    it("a channel link of a non-member asks to join", async () => {
        const link = (id: number, name: string) =>
            `<a href="/odoo/discuss.channel/${id}" class="o_channel_redirect" data-oe-id="${id}" data-oe-model="discuss.channel">#${name}</a>`;
        const chat = fakeChat([msg(10, { body: "<p>" + link(9, "général-test") + " " + link(6, "équipe-test") + "</p>" })]);
        chat.repo.channel.mockImplementation(async (_c?: string, id?: number) =>
            id === 6 ? channel({ channelId: 6, channelType: "channel", isMember: true }) : id === 9 ? null : channel());
        const c = make(chat);
        c.navigate = vi.fn();
        await c.open();
        const [other, member] = Array.from(bodyOf(c.state.rows[0]).querySelectorAll("a"));
        await c.onBodyClick(tap(member));
        expect(Dialog.confirm).not.toHaveBeenCalled();
        expect(c.navigate).toHaveBeenLastCalledWith("/chat/a/6");
        (Dialog.confirm as any).mockResolvedValueOnce({ value: false });
        await c.onBodyClick(tap(other));
        expect(Dialog.confirm).toHaveBeenCalledWith(expect.objectContaining({ message: "Join the channel #général-test?" }));
        expect(chat.join).not.toHaveBeenCalled();
        await c.onBodyClick(tap(other));
        expect(chat.join).toHaveBeenCalledWith(expect.objectContaining({ configId: "a" }), 9, "général-test", { background: true });
        expect(c.navigate).toHaveBeenLastCalledWith("/chat/a/9");
        c.teardown();
    });
});

describe("ChatThreadComponent composer modes", () => {
    afterEach(() => {
        vi.useRealTimers();
        (Dialog.confirm as any).mockReset?.();
        (Dialog.confirm as any).mockResolvedValue?.({ value: true });
    });

    const NONE = { partners: [], channels: [] };
    const BOB = { partners: [{ id: 8, name: "Bob" }], channels: [] };
    const M10 = { messageId: 10, clientUuid: null };
    const theirs = () => msg(11, { authorPartnerId: 7, body: "<p>can you come?</p>" });

    it("Reply and Edit are offered in the thread for an own comment, and act", async () => {
        const chat = fakeChat([msg(10, { body: "<p>mine</p>" }), theirs()]);
        chat.editDraftOf.mockResolvedValue({ text: "mine", mentions: BOB });
        const c = make(chat);
        await c.open();
        c.openActions("m10");
        expect(c.menuCan()).toMatchObject({ reply: true, edit: true });
        c.onMenuReply();
        c.closeActions();
        await vi.waitFor(() => expect(c.state.mode).toEqual({ kind: "reply", target: M10 }));
        expect(chat.saveDraftReply).toHaveBeenCalledWith("a", 5, M10);
        expect(c.state.banner).toMatchObject({ author: "You", text: "mine" });
        c.openActions("m11");
        expect(c.menuCan()).toMatchObject({ reply: true, edit: false });
        c.openActions("m10");
        c.state.actions = null;
        c.openActions("m10");
        c.onMenuEdit();
        c.closeActions();
        await vi.waitFor(() => expect(c.state.mode).toEqual({ kind: "edit", target: M10 }));
        expect(chat.editDraftOf).toHaveBeenCalledWith("a", 5, M10);
        expect(c.state.text).toBe("mine");
        expect(chat.saveDraftEdit).toHaveBeenCalledWith("a", 5, { target: M10, text: "mine" });
        expect(chat.saveDraftMentions).toHaveBeenCalledWith("a", 5, BOB);
        c.teardown();
    });

    it("a reply target survives leaving and reopening", async () => {
        const chat = fakeChat([msg(10), theirs()]);
        const first = make(chat);
        await first.open();
        await first.startReply({ messageId: 11, clientUuid: null });
        first.teardown();
        expect(chat.saveDraftReply).toHaveBeenCalledWith("a", 5, { messageId: 11, clientUuid: null });
        chat.draft.mockResolvedValue({ text: "on my way", files: [], lost: [], replyTo: { messageId: 11, clientUuid: null }, edit: null, mentions: NONE });
        const again = make(chat);
        await again.open();
        expect(again.state.mode).toEqual({ kind: "reply", target: { messageId: 11, clientUuid: null } });
        expect(again.state.banner).toMatchObject({ author: "Alice Roy", text: "can you come?" });
        expect(again.state.text).toBe("on my way");
        // ✕ ends the reply, the text stays
        again.onCancelMode();
        expect(again.state.mode).toEqual({ kind: "new" });
        expect(again.state.banner).toBeNull();
        expect(again.state.text).toBe("on my way");
        expect(chat.saveDraftReply).toHaveBeenLastCalledWith("a", 5, null);
        again.teardown();
    });

    it("send in reply mode passes replyTo and clears the banner", async () => {
        const chat = fakeChat([msg(10), theirs()]);
        chat.draft.mockResolvedValue({ text: "", files: [], lost: [], replyTo: { messageId: 11, clientUuid: null }, edit: null, mentions: BOB });
        const c = make(chat);
        await c.open();
        let atCall: any = null;
        chat.send.mockImplementationOnce(async (_s: any, _ch: number, _t: string, _f: any, opts: any) => {
            atCall = { mode: c.state.mode, banner: c.state.banner };
            opts.onQueued();
            return msg(null);
        });
        c.state.text = "on my way @Bob ";
        await c.onSend();
        expect(chat.send).toHaveBeenCalledWith(expect.anything(), 5, "on my way @Bob", [], expect.objectContaining({
            draftText: "on my way @Bob ", replyTo: { messageId: 11, clientUuid: null }, mentions: BOB,
        }));
        // Cleared in the first step, with the text; the outbox takes them out of the draft with the post
        expect(atCall).toEqual({ mode: { kind: "new" }, banner: null });
        expect(chat.saveDraftReply).not.toHaveBeenCalled();
        // A send refused before its post is queued puts the reply back
        chat.send.mockRejectedValueOnce(new Error("disk"));
        await c.startReply({ messageId: 11, clientUuid: null });
        c.state.text = "second";
        await c.onSend();
        expect(c.state.mode).toEqual({ kind: "reply", target: { messageId: 11, clientUuid: null } });
        expect(c.state.banner).toMatchObject({ text: "can you come?" });
        expect(c.state.text).toBe("second");
        c.teardown();
    });

    it("the edit text survives a restart and the new-message text is kept", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const chat = fakeChat([msg(10, { body: "<p>before</p>" })]);
        chat.draft.mockResolvedValue({
            text: "half a new message", files: [], lost: [], replyTo: null, edit: { target: M10, text: "after, almost" }, mentions: NONE,
        });
        const c = make(chat);
        await c.open();
        expect(c.state.mode).toEqual({ kind: "edit", target: M10 });
        expect(c.state.text).toBe("after, almost");
        expect(c.state.banner).toMatchObject({ text: "before" });
        // Typing goes to the edit, never into the new message's text
        c.onInput({ target: { value: "after, done" } } as any);
        vi.advanceTimersByTime(500);
        expect(chat.saveDraftEdit.mock.calls).toEqual([["a", 5, { target: M10, text: "after, done" }]]);
        expect(chat.saveDraftText).not.toHaveBeenCalled();
        expect(chat.typing).not.toHaveBeenCalledWith(expect.anything(), 5, true);
        // ✕ ends the edit and gives the new message back
        c.onInput({ target: { value: "after, done!" } } as any);
        c.onCancelMode();
        vi.advanceTimersByTime(1000);
        expect(c.state.mode).toEqual({ kind: "new" });
        expect(c.state.text).toBe("half a new message");
        expect(chat.saveDraftEdit.mock.calls.slice(1)).toEqual([["a", 5, null]]);
        expect(chat.saveDraftText).not.toHaveBeenCalled();
        c.teardown();
    });

    it("Edit keeps the new message typed, stored at once, under the edit", async () => {
        const chat = fakeChat([msg(10)]);
        const c = make(chat);
        await c.open();
        c.onInput({ target: { value: "not sent yet" } } as any);
        await c.startEdit(M10);
        expect(chat.saveDraftText.mock.calls).toEqual([["a", 5, "not sent yet"]]);
        expect(c.state.text).toBe("hi");
        c.onCancelMode();
        expect(c.state.text).toBe("not sent yet");
        c.teardown();
    });

    it("send in edit mode edits the message and goes back to the kept text", async () => {
        const chat = fakeChat([msg(10, { body: "<p>hi</p>" })]);
        chat.draft.mockResolvedValue({
            text: "kept", files: [], lost: [], replyTo: { messageId: 10, clientUuid: null }, edit: { target: M10, text: "hi there " }, mentions: BOB,
        });
        let sendingAtCall: boolean | null = null;
        chat.editMessage.mockImplementationOnce(async (_s: any, _ch: number, _t: any, _x: string, _m: any, opts: any) => {
            sendingAtCall = c.state.sending;
            opts.onQueued();
        });
        const c = make(chat);
        await c.open();
        await c.onSend();
        expect(sendingAtCall).toBe(true);
        expect(chat.editMessage).toHaveBeenCalledWith(expect.objectContaining({ configId: "a" }), 5, M10, "hi there", BOB,
            expect.objectContaining({ fromDraft: true }));
        // Stored at the tap; the service ends the draft's edit once queued
        expect(chat.saveDraftEdit.mock.calls).toEqual([["a", 5, { target: M10, text: "hi there " }]]);
        expect(c.state.mode).toEqual({ kind: "reply", target: M10 });
        expect(c.state.text).toBe("kept");
        expect(c.state.sending).toBe(false);
        expect(chat.send).not.toHaveBeenCalled();
        // A refused edit stays in the composer
        chat.editMessage.mockRejectedValueOnce(new Error("not cached"));
        await c.startEdit(M10);
        c.state.text = "again";
        await c.onSend();
        expect(c.state.mode).toEqual({ kind: "edit", target: M10 });
        expect(c.state.text).toBe("again");
        expect(c.state.error).not.toBe("");
        c.teardown();
    });

    it("an emptied edit asks to delete", async () => {
        const chat = fakeChat([msg(10), msg(12, { body: "<p>caption</p>" })]);
        chat.repo.attachmentsOf.mockImplementation(async (_c: string, _ch: number, ids: number[]) =>
            new Map(ids.includes(12) ? [["m12", [fileRow(31, { messageId: 12 })]]] : []));
        chat.repo.messageOf.mockImplementation(async (_c: string, t: any) => t.messageId === 12 ? msg(12) : msg(10));
        const c = make(chat);
        await c.open();
        await c.startEdit(M10);
        c.state.text = "  ";
        (Dialog.confirm as any).mockResolvedValueOnce({ value: false });
        await c.onSend();
        expect(Dialog.confirm).toHaveBeenCalledWith(expect.objectContaining({ message: "Delete this message?" }));
        expect(chat.deleteMessage).not.toHaveBeenCalled();
        expect(c.state.mode).toEqual({ kind: "edit", target: M10 });
        (Dialog.confirm as any).mockResolvedValueOnce({ value: true });
        await c.onSend();
        expect(chat.deleteMessage).toHaveBeenCalledWith(expect.objectContaining({ configId: "a" }), 5, M10);
        expect(chat.editMessage).not.toHaveBeenCalled();
        expect(c.state.mode).toEqual({ kind: "new" });
        expect(chat.saveDraftEdit).toHaveBeenLastCalledWith("a", 5, null);
        // A message with files takes the empty text as its edit, as the browser's
        (Dialog.confirm as any).mockClear();
        await c.startEdit({ messageId: 12, clientUuid: null });
        c.state.text = "";
        await c.onSend();
        expect(Dialog.confirm).not.toHaveBeenCalled();
        expect(chat.editMessage).toHaveBeenCalledWith(expect.anything(), 5, { messageId: 12, clientUuid: null }, "", expect.anything(),
            expect.anything());
        c.teardown();
    });

    it("Reprendre of a changed edit opens edit mode with the text", async () => {
        const chat = fakeChat([msg(10, { body: "<p>browser</p>" })]);
        chat.repo.messageOf.mockResolvedValue(msg(10, { body: "<p>browser</p>" }));
        chat.takeResume.mockResolvedValueOnce({ target: M10, text: "late", mentions: BOB, deleted: false });
        const c = make(chat);
        await c.open();
        expect(chat.takeResume).toHaveBeenCalledWith("a", 5);
        expect(c.state.mode).toEqual({ kind: "edit", target: M10 });
        expect(c.state.text).toBe("late");
        expect(c.state.banner).toMatchObject({ text: "browser" });
        expect(chat.editDraftOf).not.toHaveBeenCalled();
        expect(chat.saveDraftEdit).toHaveBeenCalledWith("a", 5, { target: M10, text: "late" });
        c.teardown();
    });

    it("the thread's refused-edit notices offer « Reprendre » and « Ignorer »", async () => {
        const chat = fakeChat([msg(10)]);
        const edit = { target: M10, text: "late", mentions: NONE, deleted: false };
        chat.notices.mockResolvedValue([
            { id: "n1", configId: "a", kind: "chat.edit", channelId: 5, reason: "changed", error: "", count: 1, label: "", edit },
            { id: "n2", configId: "a", kind: "chat.edit", channelId: 6, reason: "changed", error: "", count: 1, label: "", edit },
            { id: "n3", configId: "a", kind: "chat.mute", channelId: 5, reason: "refused", error: "", count: 1, label: "" },
        ]);
        chat.repo.messageOf.mockResolvedValue(msg(10));
        const c = make(chat);
        await c.open();
        expect(c.state.resumes).toEqual([{ id: "n1", text: "Edit not sent: the message changed meanwhile." }]);
        chat.takeResume.mockResolvedValueOnce(edit);
        await c.onResume(c.state.resumes[0]);
        expect(chat.requestResume).toHaveBeenCalledWith("a", "n1");
        expect(c.state.mode).toEqual({ kind: "edit", target: M10 });
        expect(c.state.text).toBe("late");
        await c.onIgnore({ id: "n1" });
        expect(chat.dismissNotice).toHaveBeenCalledWith("a", "n1");
        c.teardown();
    });

    it("Reprendre of a deleted message puts the text in the draft", async () => {
        const chat = fakeChat([msg(10)]);
        chat.draft.mockResolvedValue({ text: "typed", files: [], lost: [], replyTo: null, edit: null, mentions: NONE });
        // The emptied row may still be cached: deleted is deleted
        chat.repo.messageOf.mockResolvedValue(msg(9, { body: "" }));
        chat.takeResume.mockResolvedValueOnce({ target: { messageId: 9, clientUuid: null }, text: "late @Bob", mentions: BOB, deleted: true });
        const c = make(chat);
        await c.open();
        expect(c.state.mode).toEqual({ kind: "new" });
        expect(c.state.text).toBe("typed\nlate @Bob");
        expect(chat.saveDraftText).toHaveBeenLastCalledWith("a", 5, "typed\nlate @Bob");
        expect(chat.saveDraftMentions).toHaveBeenLastCalledWith("a", 5, BOB);
        expect(chat.saveDraftEdit).not.toHaveBeenCalled();
        c.teardown();
    });

    it("the mode banner shows the quote and ✕; a quote with nothing to reach is out of the tab order", () => {
        const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", "components", "chat", "chat_thread_component.ts"), "utf8");
        const quote = source.slice(source.indexOf('class="chat-thread__quote"'));
        expect(quote.slice(0, quote.indexOf(">"))).toMatch(/t-att-tabindex="row\.quote\.key \? null : '-1'"/);
        expect(source).toMatch(/<ChatComposerBannerComponent t-if="state\.mode\.kind !== 'new'" mode="state\.mode" quote="state\.banner" onCancel\.bind="onCancelMode"\/>/);
    });

    it("📎 and 🎤 are off while editing: an edit takes no new file", async () => {
        const chat = fakeChat([msg(10)]);
        const c = make(chat);
        await c.open();
        await c.startEdit(M10);
        expect(await c.onSend([outFile("Voice-1.mp3", { voice: true })])).toBe(false);
        const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", "components", "chat", "chat_thread_component.ts"), "utf8");
        for (const cls of ["chat-thread__attach", "chat-thread__mic"]) {
            const tag = source.slice(source.indexOf('class="' + cls + '"'));
            expect(tag.slice(0, tag.indexOf(">")), cls).toMatch(/t-att-disabled="[^"]*state\.mode\.kind === 'edit'/);
        }
        c.teardown();
    });
});
