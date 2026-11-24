// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

// The suite's Owl stub renders nothing: this file mounts the reply composer on the real Owl
vi.mock("@odoo/owl", async () => await import("../../node_modules/@odoo/owl/dist/owl.es.js"));
vi.mock("@capacitor/app", () => ({ App: { addListener: vi.fn() } }));
vi.mock("@capacitor/camera", () => ({ Camera: {} }));
vi.mock("@capacitor/filesystem", () => ({ Filesystem: {}, Directory: { Data: "DATA", External: "EXTERNAL" } }));
vi.mock("capacitor-voice-recorder", () => ({ VoiceRecorder: {} }));

import { EventBus, mount } from "@odoo/owl";
import { ChatRecordReplyComponent } from "../components/chat/chat_record_reply_component";

function stubStorage(lang = "en") {
    const store: Record<string, string> = { app_lang: lang };
    vi.stubGlobal("localStorage", {
        getItem: (k: string) => store[k] ?? null,
        setItem: (k: string, v: string) => { store[k] = v; },
        removeItem: (k: string) => { delete store[k]; },
    });
}

const SRC = { configId: "a", label: "Srv", app: {}, creds: {} };
const ITEM = {
    configId: "a", messageId: 602, threadModel: "project.task", threadId: 70, recordName: "Tâche démo", authorPartnerId: 7,
    body: "<p>Peux-tu regarder ?</p>", date: "2026-10-26 09:00:00", messageType: "comment",
    needaction: true, starred: false, history: false,
};

function fakeChat() {
    return {
        recordDraft: vi.fn(async () => ({ text: "", mentions: { partners: [], channels: [] }, files: [], lost: [] })),
        saveRecordDraftText: vi.fn(async () => {}),
        saveRecordDraftMentions: vi.fn(async () => {}),
        keepRecordDraftFile: vi.fn(async () => {}),
        dropDraftFile: vi.fn(async () => {}),
        recordSendStarted: vi.fn(() => vi.fn()),
        replyOnRecord: vi.fn(async () => ({ id: "op1" })),
        fileDirOf: vi.fn(async () => "q3Zt8Wn1"),
        uploadLimit: vi.fn(async () => 1 << 20),
        mentions: { local: vi.fn(async () => []), forRecord: vi.fn(async () => []) },
    };
}

describe("ChatRecordReplyComponent mounted", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        document.body.innerHTML = "";
    });

    it("shows the composer's pieces, the note switch asks before a message, the mic records", async () => {
        stubStorage();
        const host = document.createElement("div");
        document.body.appendChild(host);
        const chat = fakeChat();
        const props = { src: SRC, item: ITEM, onDone: vi.fn(), onCancel: vi.fn() };
        const c: any = await mount(ChatRecordReplyComponent as any, host, {
            props, env: { eventBus: new EventBus(), syncService: { chat } },
        } as any);
        const confirm = vi.fn(async () => true);
        const recorder = {
            onAutoStop: null, onBackground: null, start: vi.fn(async () => "recording"),
            remainingMs: vi.fn(() => 60000), stop: vi.fn(), discard: vi.fn(async () => {}),
        };
        Object.assign(c.attach.deps, { confirm, recorder });
        await vi.waitFor(() => expect(host.querySelector<HTMLButtonElement>(".chat-thread__mic")!.disabled).toBe(false));
        expect(host.querySelector(".chat-reply__title")!.textContent).toBe("Reply on Tâche démo");
        // The conversation's attachment area sits in the composer
        expect(host.querySelector(".chat-reply .chat-attach")).not.toBeNull();
        const field = host.querySelector<HTMLTextAreaElement>(".chat-reply__input")!;
        expect(field.placeholder).toBe("Log an internal note…");
        const toggle = host.querySelector<HTMLButtonElement>(".chat-reply__switch")!;
        expect(toggle.getAttribute("role")).toBe("switch");
        expect(toggle.getAttribute("aria-checked")).toBe("false");
        expect(toggle.textContent).toContain("Send as a message to followers");
        toggle.click();
        await vi.waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
        expect(confirm).toHaveBeenCalledTimes(1);
        expect(field.placeholder).toBe("Send a message to followers…");
        host.querySelector<HTMLButtonElement>(".chat-thread__mic")!.click();
        await vi.waitFor(() => expect(host.querySelector(".chat-thread__mic--on")).not.toBeNull());
        expect(recorder.start).toHaveBeenCalled();
        expect(host.querySelector(".chat-attach__voice")).not.toBeNull();
        c.__owl__.app.destroy();
    });
});
