// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("@capacitor/app", () => ({ App: { addListener: vi.fn() } }));
vi.mock("@capacitor/camera", () => ({ Camera: {} }));
vi.mock("@capacitor/filesystem", () => ({ Filesystem: {}, Directory: { Data: "DATA", External: "EXTERNAL" } }));
vi.mock("capacitor-voice-recorder", () => ({ VoiceRecorder: {} }));

// vitest.config.ts aliases @odoo/owl to src/__mocks__: hooks are no-ops, so
// setup() then open() and teardown() are called by hand.
import { ChatRecordReplyComponent } from "../components/chat/chat_record_reply_component";
import { EventBus } from "@odoo/owl";
import { App } from "@capacitor/app";

function stubLocale(lang = "en") {
    const store: Record<string, string> = { app_lang: lang };
    vi.stubGlobal("localStorage", {
        getItem: (k: string) => store[k] ?? null,
        setItem: (k: string, v: string) => { store[k] = v; },
        removeItem: (k: string) => { delete store[k]; },
    });
}

const flush = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
};

const SRC = { configId: "a", label: "Srv", app: {}, creds: {} };
const ITEM = {
    configId: "a", messageId: 602, threadModel: "project.task", threadId: 70, recordName: "Tâche démo", authorPartnerId: 7,
    body: "<p>Peux-tu regarder ?</p>", date: "2026-10-26 09:00:00", messageType: "comment",
    needaction: true, starred: false, history: false,
};
const THREAD = { model: "project.task", resId: 70, recordName: "Tâche démo" };
const EMPTY = { partners: [], channels: [] };

const outFile = (name: string, p: any = {}) => ({
    localUuid: "lu-" + name, path: "chat/q3Zt8Wn1/out/lu-" + name + "/" + name, name,
    mimetype: "image/jpeg", size: 1000, voice: false, ...p,
});

/** A draft row of chat_attachments for a staged file of the record's composer, as ChatService.recordDraft gives it. */
const draftRow = (f: any, seq: number, origin: string | null = null) => ({
    configId: "a", channelId: 0, messageId: null, attachmentId: null, localUuid: f.localUuid, postClientUuid: null,
    seq, name: f.name, mimetype: f.mimetype, size: f.size, checksum: null, voice: f.voice, thumbPath: null, thumbBytes: 0,
    originalPath: f.path, originalBytes: f.size, state: "draft", error: null, lastOpenedAt: null, createdAt: "2026-10-26T10:00:00Z",
    origin, threadModel: "project.task", threadId: 70,
});

/** A ChatService whose record drafts live in `store`, as the database keeps them across screens and restarts. */
function fakeChat(store = { text: "", mentions: EMPTY as any, files: [] as any[] }) {
    const ended = vi.fn();
    return {
        store,
        ended,
        recordDraft: vi.fn(async (_c: string, _t: any) => ({ text: store.text, mentions: store.mentions, files: store.files, lost: [] })),
        saveRecordDraftText: vi.fn(async (_c: string, _t: any, text: string) => { store.text = text; }),
        saveRecordDraftMentions: vi.fn(async (_c: string, _t: any, m: any) => { store.mentions = m; }),
        keepRecordDraftFile: vi.fn(async (_c: string, _t: any, f: any, seq: number, origin: string | null) => {
            store.files = [...store.files.filter((r) => r.localUuid !== f.localUuid), draftRow(f, seq, origin)];
        }),
        dropDraftFile: vi.fn(async (_c: string, f: any) => { store.files = store.files.filter((r) => r.localUuid !== f.localUuid); }),
        recordSendStarted: vi.fn((_c: string, _t: any) => ended),
        replyOnRecord: vi.fn(async (..._args: any[]) => ({ id: "op1" })),
        fileDirOf: vi.fn(async () => "q3Zt8Wn1"),
        uploadLimit: vi.fn(async () => 1 << 20),
        mentions: {
            local: vi.fn(async (_s: any, _ch: any, _q: any): Promise<any[]> => []),
            forRecord: vi.fn(async (_s: any, _q: any): Promise<any[]> => []),
        },
    };
}

function make(chat: any) {
    stubLocale();
    const c = new (ChatRecordReplyComponent as any)();
    c.env = { eventBus: new EventBus() };
    c.props = { src: SRC, item: ITEM, onDone: vi.fn(), onCancel: vi.fn() };
    Object.defineProperty(c, "chatService", { value: chat });
    c.setup();
    return c;
}

/** The composer's attachments over fakes: a recorder that records until stop gives a voice file, a confirm answering `answer`. */
function fakeAttachments(c: any, answer = true) {
    const voice = outFile("Voice-2026-10-26-317.mp3", { mimetype: "audio/mpeg", voice: true });
    const recorder = {
        onAutoStop: null, onBackground: null,
        start: vi.fn(async () => "recording"),
        remainingMs: vi.fn(() => 60000),
        stop: vi.fn(async () => voice),
        discard: vi.fn(async () => {}),
    };
    const capture = { pickFiles: vi.fn(async () => []), stage: vi.fn(), compress: vi.fn(async (f: any) => f) };
    const confirm = vi.fn(async (_m: string, _l?: any) => answer);
    Object.assign(c.attach.deps, { recorder, capture, confirm, askCompress: () => false });
    return { recorder, confirm, voice };
}

/** Types `value` in the field, the caret at its end. */
const type = (c: any, value: string) => c.onInput({ target: { value, selectionStart: value.length } });

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe("ChatRecordReplyComponent", () => {
    it("the reply composer sends text, a mention and a photo as a note", async () => {
        const chat = fakeChat();
        const c = make(chat);
        fakeAttachments(c);
        await c.open();
        expect(chat.recordDraft).toHaveBeenCalledWith("a", THREAD);
        type(c, "Bonjour @Al");
        c.onSuggestion({ kind: "partner", id: 7, name: "Alice Martin" });
        expect(c.state.text).toBe("Bonjour @Alice Martin ");
        expect(chat.saveRecordDraftMentions).toHaveBeenLastCalledWith("a", THREAD, { partners: [{ id: 7, name: "Alice Martin" }], channels: [] });
        const photo = outFile("photo.jpg");
        c.attachState.chips.push({ key: "k1", file: photo, origin: "gallery", seq: 0 });
        expect(await c.onSend()).toBe(true);
        expect(chat.recordSendStarted).toHaveBeenCalledWith("a", THREAD);
        expect(chat.replyOnRecord).toHaveBeenCalledWith(
            SRC, ITEM, "Bonjour @Alice Martin", { partners: [{ id: 7, name: "Alice Martin" }], channels: [] }, [photo], true,
            "Bonjour @Alice Martin ",
        );
        // Stored at the tap, so a kill before the queue keeps it; the outbox takes it out of the draft
        expect(chat.saveRecordDraftText).toHaveBeenCalledWith("a", THREAD, "Bonjour @Alice Martin ");
        expect(chat.ended).toHaveBeenCalled();
        expect(c.state.text).toBe("");
        expect(c.attachState.chips).toEqual([]);
        expect(c.props.onDone).toHaveBeenCalled();
        // Nothing to send: nothing queued
        const again = make(fakeChat());
        await again.open();
        expect(await again.onSend()).toBe(false);
    });

    it("a reply refused before its queue gives the text and the picks back, with the error", async () => {
        const chat = fakeChat();
        chat.replyOnRecord.mockRejectedValueOnce(new Error("disk full"));
        const c = make(chat);
        fakeAttachments(c);
        await c.open();
        type(c, "Gardé");
        await c.onSend();
        expect(c.state.text).toBe("Gardé");
        expect(c.state.error).toBe("Could not send the message. Try again.");
        expect(c.props.onDone).not.toHaveBeenCalled();
        expect(chat.ended).toHaveBeenCalled();
    });

    it("declining the confirmation keeps the note", async () => {
        const chat = fakeChat();
        const c = make(chat);
        const { confirm } = fakeAttachments(c, false);
        await c.open();
        type(c, "Pour les abonnés");
        expect(c.state.asMessage).toBe(false);
        await c.onToggleMessage();
        expect(confirm).toHaveBeenCalledWith(
            "The followers of Tâche démo will receive this message, most of them by email.",
            { title: "Message to followers", ok: "Send as a message", cancel: "Keep a note" },
        );
        expect(c.state.asMessage).toBe(false);
        expect(c.state.text).toBe("Pour les abonnés");
        // Yes: the text and the files go as a message; off again asks nothing
        confirm.mockResolvedValueOnce(true);
        await c.onToggleMessage();
        expect(c.state.asMessage).toBe(true);
        await c.onToggleMessage();
        expect(c.state.asMessage).toBe(false);
        expect(confirm).toHaveBeenCalledTimes(2);
        confirm.mockResolvedValueOnce(true);
        await c.onToggleMessage();
        c.attachState.chips.push({ key: "k1", file: outFile("plan.jpg"), origin: "file", seq: 0 });
        await c.onSend();
        expect(chat.replyOnRecord).toHaveBeenLastCalledWith(SRC, ITEM, "Pour les abonnés", EMPTY, [outFile("plan.jpg")], false, "Pour les abonnés");
    });

    it("a failed send keeps the « message » choice", async () => {
        const chat = fakeChat();
        chat.replyOnRecord.mockRejectedValueOnce(new Error("disk full"));
        const c = make(chat);
        fakeAttachments(c, true);
        await c.open();
        await c.onToggleMessage();
        type(c, "Aux abonnés");
        await c.onSend();
        expect(c.state.error).toBe("Could not send the message. Try again.");
        expect(c.state.asMessage).toBe(true);
        await c.onSend();
        expect(chat.replyOnRecord).toHaveBeenLastCalledWith(SRC, ITEM, "Aux abonnés", EMPTY, [], false, "Aux abonnés");
    });

    it("✕ and Android's back close the composer over its history entry, the draft kept", async () => {
        const chat = fakeChat();
        const c = make(chat);
        fakeAttachments(c);
        window.history.replaceState({}, "", "/chat/inbox");
        await c.open();
        expect(window.history.state).toMatchObject({ chatReply: true });
        type(c, "À garder");
        c.close();
        c.close();
        await vi.waitFor(() => expect(c.props.onCancel).toHaveBeenCalledTimes(1));
        expect(window.history.state?.chatReply).toBeUndefined();
        // The inbox takes the composer away: the text waiting is stored
        c.teardown();
        expect(chat.store.text).toBe("À garder");
        // Android's back goes over the entry the same way
        const back = make(chat);
        fakeAttachments(back);
        await back.open();
        expect(back.state.text).toBe("À garder");
        window.history.back();
        await vi.waitFor(() => expect(back.props.onCancel).toHaveBeenCalled());
        back.teardown();
        expect(window.location.pathname).toBe("/chat/inbox");
    });

    it("the draft of a reply survives leaving the inbox and a restart", async () => {
        const chat = fakeChat();
        const c = make(chat);
        fakeAttachments(c);
        await c.open();
        type(c, "Pas fini @Al");
        c.onSuggestion({ kind: "partner", id: 7, name: "Alice Martin" });
        type(c, "Pas fini @Alice Martin et");
        const photo = outFile("photo.jpg");
        await c.attach.deps.draft.keep(photo, 0, "camera");
        expect(chat.keepRecordDraftFile).toHaveBeenCalledWith("a", THREAD, photo, 0, "camera");
        // The app goes to the background: the text waiting is stored
        const [[, onState]] = (App.addListener as any).mock.calls.slice(-1);
        onState({ isActive: false });
        expect(chat.store.text).toBe("Pas fini @Alice Martin et");
        type(c, "Pas fini @Alice Martin et puis");
        // Leaving the inbox: the screen goes, the text waiting is stored
        c.teardown();
        expect(chat.store.text).toBe("Pas fini @Alice Martin et puis");
        // A restart: a new composer over the same database
        const back = make(chat);
        fakeAttachments(back);
        await back.open();
        expect(back.state.text).toBe("Pas fini @Alice Martin et puis");
        expect(back.attachState.chips.map((k: any) => [k.file.name, k.origin])).toEqual([["photo.jpg", "camera"]]);
        expect(back.picks).toEqual([{ kind: "partner", id: 7, text: "@Alice Martin", start: 9 }]);
        await back.onSend();
        expect(chat.replyOnRecord).toHaveBeenLastCalledWith(
            SRC, ITEM, "Pas fini @Alice Martin et puis", { partners: [{ id: 7, name: "Alice Martin" }], channels: [] },
            [photo], true, "Pas fini @Alice Martin et puis",
        );
    });

    it("@ in a reply suggests from the people cache, then the server's chatter suggestions", async () => {
        vi.useFakeTimers();
        const chat = fakeChat();
        chat.mentions.local.mockResolvedValue([{ kind: "partner", id: 5, name: "Élodie" }]);
        chat.mentions.forRecord.mockResolvedValue([{ kind: "partner", id: 5, name: "Élodie" }, { kind: "partner", id: 9, name: "Elise Server" }]);
        const c = make(chat);
        fakeAttachments(c);
        await c.open();
        type(c, "Vu @el");
        const q = { kind: "@", term: "el", start: 3 };
        expect(chat.mentions.local).toHaveBeenCalledWith(SRC, null, q);
        await flush();
        expect(c.state.suggestions.map((s: any) => s.name)).toEqual(["Élodie"]);
        expect(chat.mentions.forRecord).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(250);
        expect(chat.mentions.forRecord).toHaveBeenCalledWith(SRC, q);
        await flush();
        expect(c.state.suggestions.map((s: any) => s.name)).toEqual(["Élodie", "Elise Server"]);
        expect(c.suggestionsLive()).toBe("Suggestions shown: 2");
        // A word that is no query closes the list
        type(c, "Vu @el ");
        expect(c.state.suggestions).toEqual([]);
    });

    it("a voice message records and sends with the reply", async () => {
        const chat = fakeChat();
        const c = make(chat);
        const { recorder, voice } = fakeAttachments(c);
        await c.open();
        type(c, "Écoute");
        await c.attach.mic();
        expect(recorder.start).toHaveBeenCalled();
        expect(c.attachState.voice).toBe("recording");
        await c.attach.mic();
        await flush();
        // A draft file first, so a refused reply keeps it
        expect(chat.keepRecordDraftFile).toHaveBeenCalledWith("a", THREAD, voice, 0, "voice");
        expect(chat.replyOnRecord).toHaveBeenCalledWith(SRC, ITEM, "Écoute", EMPTY, [voice], true, "Écoute");
    });
});
