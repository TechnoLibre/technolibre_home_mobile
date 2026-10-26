// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@capacitor/app", () => ({ App: { addListener: vi.fn() } }));
vi.mock("@capacitor/camera", () => ({ Camera: {} }));
vi.mock("@capacitor/filesystem", () => ({ Filesystem: {}, Directory: { Data: "DATA", External: "EXTERNAL" } }));
vi.mock("capacitor-voice-recorder", () => ({ VoiceRecorder: {} }));

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
    ChatAttachmentsComponent,
    PROGRESS_POLL_MS,
    ThreadAttachments,
    WAIT_POLL_MS,
    attachmentKind,
    viewSig,
    type ThreadAttachmentDeps,
} from "../components/chat/chat_attachments_component";
import { ChatImageViewerComponent } from "../components/chat/chat_image_viewer_component";
import { ChatAttachmentCache } from "../services/chat/chatAttachmentCache";
import type { ChatAttachment } from "../models/chat";

function stubLocale(lang = "en") {
    const store: Record<string, string> = { app_lang: lang };
    vi.stubGlobal("localStorage", {
        getItem: (k: string) => store[k] ?? null,
        setItem: (k: string, v: string) => { store[k] = v; },
        removeItem: (k: string) => { delete store[k]; },
    });
}

const flush = async () => {
    for (let i = 0; i < 30; i++) await Promise.resolve();
};

const SRC: any = { configId: "a", label: "Srv", app: {}, creds: { url: "https://odoo.example.test" } };

const att = (id: number | null, p: Partial<ChatAttachment> = {}): ChatAttachment => ({
    configId: "a", channelId: 5, messageId: id === null ? null : 100 + id, attachmentId: id,
    localUuid: id === null ? "lu" + Math.random().toString(36).slice(2) : null, postClientUuid: null,
    seq: 0, name: "f" + id + ".jpg", mimetype: "image/jpeg", size: 2048, checksum: "c" + id, voice: false,
    thumbPath: null, thumbBytes: 0, originalPath: null, originalBytes: 0, state: "posted", error: null,
    lastOpenedAt: null, createdAt: "2026-10-26T10:00:00Z", ...p,
});

/** A cache that answers as told and records its calls. */
function fakeCache() {
    const progress = new Map<number, { done: number; total: number | null }>();
    const waiting = new Set<number>();
    const failed = new Set<number>();
    const cache = {
        preview: vi.fn(async (_s: any, a: ChatAttachment): Promise<string | null> => "chat/d/thumbs/" + a.attachmentId),
        retryPreview: vi.fn(async (_s: any, a: ChatAttachment): Promise<string | null> => {
            failed.delete(a.attachmentId!);
            return "chat/d/thumbs/" + a.attachmentId;
        }),
        previewFailed: vi.fn((a: any) => failed.has(a.attachmentId)),
        open: vi.fn(async (_s: any, a: ChatAttachment, _o?: any): Promise<any> =>
            ({ kind: "ready", path: a.originalPath ?? "chat/d/files/" + a.attachmentId + "/" + a.name })),
        downloadProgress: vi.fn((a: any) => progress.get(a.attachmentId) ?? null),
        cancel: vi.fn(async (_a: any) => {}),
        waitingWifi: vi.fn((a: any) => waiting.has(a.attachmentId)),
    };
    return { cache, progress, waiting, failed };
}

function harness(over: Partial<ThreadAttachmentDeps> = {}) {
    const fc = fakeCache();
    const uploads = new Map<string, { done: number; total: number }>();
    const deps: ThreadAttachmentDeps = {
        cache: () => fc.cache as any,
        files: () => ({
            webUrl: async (rel: string) => "http://localhost/_capacitor_file_/data/" + rel,
            uri: async (rel: string) => "file:///data/user/0/app/files/" + rel,
        }),
        uploadProgress: (u: string) => uploads.get(u) ?? null,
        openWith: vi.fn(async () => {}),
        onTick: vi.fn(),
        ...over,
    };
    const ta = new ThreadAttachments(deps);
    ta.source = SRC;
    return { ta, deps, uploads, ...fc };
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe("attachmentKind", () => {
    it("splits images, voice and other audio, and other files by mimetype and the voice flag", () => {
        expect(attachmentKind(att(1, { mimetype: "image/jpeg" }))).toBe("image");
        expect(attachmentKind(att(2, { mimetype: "image/png" }))).toBe("image");
        expect(attachmentKind(att(3, { mimetype: "audio/mpeg", voice: true }))).toBe("voice");
        expect(attachmentKind(att(4, { mimetype: "audio/ogg" }))).toBe("voice");
        // The web view cannot show a HEIC: it opens as a file
        expect(attachmentKind(att(5, { mimetype: "image/heic" }))).toBe("file");
        expect(attachmentKind(att(6, { mimetype: "application/pdf" }))).toBe("file");
    });
});

describe("ThreadAttachments", () => {
    it("views carry name, size, kind, the voice badge and a stable key", async () => {
        stubLocale();
        const { ta } = harness();
        await ta.load(new Map([["m1", [
            att(1), att(2, { name: "Voice-2026-10-26-1.mp3", mimetype: "audio/mpeg", voice: true }),
            att(3, { name: "song.ogg", mimetype: "audio/ogg" }), att(4, { name: "report.pdf", mimetype: "application/pdf" }),
        ]]]), { pendingRows: new Set(), heldUploads: new Set() });
        expect(ta.views("m1").map((v) => [v.key, v.kind, v.voice, v.name, v.size, v.state])).toEqual([
            ["a1", "image", false, "f1.jpg", 2048, "remote"],
            ["a2", "voice", true, "Voice-2026-10-26-1.mp3", 2048, "remote"],
            ["a3", "voice", false, "song.ogg", 2048, "remote"],
            ["a4", "file", false, "report.pdf", 2048, "remote"],
        ]);
        expect(ta.views("m9")).toEqual([]);
    });

    it("asks previews only for the rows on screen", async () => {
        stubLocale();
        const { ta, cache, deps } = harness();
        await ta.load(new Map([["m1", [att(1), att(2)]], ["m2", [att(3)]]]), { pendingRows: new Set(), heldUploads: new Set() });
        expect(cache.preview).not.toHaveBeenCalled();
        ta.seen("m1");
        await flush();
        expect(cache.preview.mock.calls.map((c) => c[1].attachmentId)).toEqual([1, 2]);
        expect(ta.views("m1").map((v) => [v.state, v.src])).toEqual([
            ["ready", "http://localhost/_capacitor_file_/data/chat/d/thumbs/1"],
            ["ready", "http://localhost/_capacitor_file_/data/chat/d/thumbs/2"],
        ]);
        expect(ta.views("m2")[0].state).toBe("remote");
        expect(deps.onTick).toHaveBeenCalled();
        // Seen again: nothing asked twice
        ta.seen("m1");
        await flush();
        expect(cache.preview).toHaveBeenCalledTimes(2);
    });

    it("previews of visible rows go two at a time through the cache", async () => {
        stubLocale();
        const downloads: string[] = [];
        const transfer: any = {
            download: vi.fn((_c: any, r: any) => {
                downloads.push(r.urlPath);
                return new Promise(() => {});
            }),
        };
        const rows = [att(1), att(2), att(3)];
        const repo: any = {
            attachment: vi.fn(async (_c: string, id: number) => rows.find((r) => r.attachmentId === id) ?? null),
            fileDirOf: vi.fn(async () => "d"),
            clearFiles: vi.fn(async () => {}),
            setPreview: vi.fn(async () => {}),
        };
        const files: any = { size: vi.fn(async () => null), remove: vi.fn(async () => {}) };
        const real = new ChatAttachmentCache(repo, files, transfer, async () => true, async () => []);
        const { ta } = harness({ cache: () => real });
        await ta.load(new Map([["m1", [rows[0], rows[1]]], ["m2", [rows[2]]]]), { pendingRows: new Set(), heldUploads: new Set() });
        ta.seen("m1");
        ta.seen("m2");
        await flush();
        expect(downloads).toHaveLength(2);
        expect(downloads.every((u) => /^\/web\/image\/\d\/512x512\?/.test(u))).toBe(true);
    });

    it("an image of the phone still on its way shows its own file and asks the server nothing", async () => {
        stubLocale();
        const { ta, cache } = harness();
        const own = att(null, { localUuid: "lu1", state: "queued", originalPath: "chat/d/out/lu1/IMG_1.jpg", name: "IMG_1.jpg" });
        await ta.load(new Map([["uP", [own]]]), { pendingRows: new Set(["uP"]), heldUploads: new Set() });
        ta.seen("uP");
        await flush();
        expect(cache.preview).not.toHaveBeenCalled();
        const [v] = ta.views("uP");
        expect([v.key, v.state, v.src, v.outgoing]).toEqual(
            ["llu1", "uploading", "http://localhost/_capacitor_file_/data/chat/d/out/lu1/IMG_1.jpg", true]);
    });

    it("upload progress, Wi-Fi hold and refusal of a file on its way", async () => {
        stubLocale();
        const { ta, uploads } = harness();
        const a = att(null, { localUuid: "lu1", state: "queued", originalPath: "chat/d/out/lu1/a.jpg" });
        const b = att(null, { localUuid: "lu2", state: "queued", originalPath: "chat/d/out/lu2/b.pdf", mimetype: "application/pdf" });
        const c = att(null, { localUuid: "lu3", state: "refused", error: "too_big", originalPath: "chat/d/out/lu3/c.pdf", mimetype: "application/pdf" });
        await ta.load(new Map([["uP", [a, b, c]]]), { pendingRows: new Set(["uP"]), heldUploads: new Set(["lu2"]) });
        uploads.set("lu1", { done: 512, total: 2048 });
        expect(ta.views("uP").map((v) => [v.state, v.progress, v.error])).toEqual([
            ["uploading", 25, null],
            ["waiting_wifi", null, null],
            ["refused", null, "Not sent: over the server's limit"],
        ]);
        expect(ta.heldForWifi("uP")).toBe(true);
        expect(ta.heldForWifi("m1")).toBe(false);
    });

    it("the files of a failed post are shown from the phone, with no transfer state", async () => {
        stubLocale();
        const { ta } = harness();
        const a = att(null, { localUuid: "lu1", state: "queued", originalPath: "chat/d/out/lu1/a.jpg" });
        await ta.load(new Map([["uF", [a]]]), { pendingRows: new Set(), heldUploads: new Set() });
        expect(ta.views("uF")[0].state).toBe("ready");
    });

    it("the signature changes with state, progress or src, not otherwise", async () => {
        stubLocale();
        const { ta, uploads } = harness();
        const a = att(null, { localUuid: "lu1", state: "queued", originalPath: "chat/d/out/lu1/a.jpg" });
        await ta.load(new Map([["uP", [a]]]), { pendingRows: new Set(["uP"]), heldUploads: new Set() });
        const s0 = viewSig(ta.views("uP"));
        expect(viewSig(ta.views("uP"))).toBe(s0);
        uploads.set("lu1", { done: 100, total: 1000 });
        const s1 = viewSig(ta.views("uP"));
        expect(s1).not.toBe(s0);
        // Same percent: same signature
        uploads.set("lu1", { done: 101, total: 1000 });
        expect(viewSig(ta.views("uP"))).toBe(s1);
        uploads.set("lu1", { done: 500, total: 1000 });
        expect(viewSig(ta.views("uP"))).not.toBe(s1);
    });

    it("a failed preview is a tap-to-retry placeholder", async () => {
        stubLocale();
        const { ta, cache, failed } = harness();
        failed.add(1);
        await ta.load(new Map([["m1", [att(1)]]]), { pendingRows: new Set(), heldUploads: new Set() });
        ta.seen("m1");
        await flush();
        expect(cache.preview).not.toHaveBeenCalled();
        expect(ta.views("m1")[0].state).toBe("failed_preview");
        await ta.retryPreview("a1");
        await flush();
        expect(cache.retryPreview).toHaveBeenCalledTimes(1);
        expect(ta.views("m1")[0].state).toBe("ready");
    });

    it("download progress shows on the file and cancel stops it without an error", async () => {
        stubLocale();
        const { ta, cache, progress } = harness();
        const pdf = att(4, { name: "report.pdf", mimetype: "application/pdf" });
        await ta.load(new Map([["m1", [pdf]]]), { pendingRows: new Set(), heldUploads: new Set() });
        let finish!: (r: any) => void;
        cache.open.mockImplementationOnce(() => new Promise((r) => { finish = r; }));
        const opening = ta.openFile("a4");
        expect(ta.views("m1")[0].state).toBe("downloading");
        progress.set(4, { done: 50, total: 200 });
        expect(ta.views("m1")[0].progress).toBe(25);
        await ta.cancel("a4");
        expect(cache.cancel).toHaveBeenCalledWith(expect.objectContaining({ configId: "a", attachmentId: 4 }));
        progress.delete(4);
        finish({ kind: "failed" });
        await opening;
        expect(ta.views("m1")[0]).toMatchObject({ state: "remote", error: null });
    });

    it("a file opens through « open with » with its mimetype", async () => {
        stubLocale();
        const { ta, deps } = harness();
        await ta.load(new Map([["m1", [att(4, { name: "report.pdf", mimetype: "application/pdf" })]]]),
            { pendingRows: new Set(), heldUploads: new Set() });
        await ta.openFile("a4");
        expect(deps.openWith).toHaveBeenCalledWith("file:///data/user/0/app/files/chat/d/files/4/report.pdf", "application/pdf");
        expect(ta.views("m1")[0]).toMatchObject({ state: "ready", src: "http://localhost/_capacitor_file_/data/chat/d/files/4/report.pdf" });
    });

    it("a file no app opens, one gone from the server or a failed download says so", async () => {
        stubLocale();
        const { ta, deps, cache } = harness();
        await ta.load(new Map([["m1", [att(4, { mimetype: "application/x-thing" }), att(5, { mimetype: "application/pdf" }),
            att(6, { mimetype: "application/pdf" })]]]), { pendingRows: new Set(), heldUploads: new Set() });
        (deps.openWith as any).mockRejectedValueOnce(Object.assign(new Error("none"), { code: "NO_APP" }));
        await ta.openFile("a4");
        cache.open.mockResolvedValueOnce({ kind: "gone" });
        await ta.openFile("a5");
        cache.open.mockResolvedValueOnce({ kind: "failed" });
        await ta.openFile("a6");
        expect(ta.views("m1").map((v) => v.error)).toEqual([
            "No app on the phone opens this file.",
            "This file is no longer on the server.",
            "The file could not be downloaded.",
        ]);
    });

    it("« download anyway » takes a held voice or file now on mobile data, that one only", async () => {
        stubLocale();
        const { ta, cache, waiting, deps } = harness();
        const voice = att(2, { name: "Voice-2026-10-26-1.mp3", mimetype: "audio/mpeg", voice: true });
        const pdf = att(4, { name: "report.pdf", mimetype: "application/pdf" });
        const other = att(7, { name: "notes.pdf", mimetype: "application/pdf" });
        await ta.load(new Map([["m1", [voice, pdf, other]]]), { pendingRows: new Set(), heldUploads: new Set() });
        cache.open.mockImplementation(async (_s: any, a: ChatAttachment, o: any = {}) => {
            if (!o.anyNetwork) {
                waiting.add(a.attachmentId!);
                return { kind: "waiting_wifi" };
            }
            waiting.delete(a.attachmentId!);
            return { kind: "ready", path: "chat/d/files/" + a.attachmentId + "/" + a.name };
        });
        await ta.openFile("a4");
        await ta.openFile("a7");
        expect((await ta.open("a2")).kind).toBe("waiting_wifi");
        expect(ta.views("m1").map((v) => v.state)).toEqual(["waiting_wifi", "waiting_wifi", "waiting_wifi"]);
        expect(deps.openWith).not.toHaveBeenCalled();

        await ta.openFile("a4", { anyNetwork: true });
        const played = await ta.open("a2", { anyNetwork: true });
        expect(played).toMatchObject({ kind: "ready", url: "http://localhost/_capacitor_file_/data/chat/d/files/2/Voice-2026-10-26-1.mp3" });
        const forced = cache.open.mock.calls.filter((c) => c[2]?.anyNetwork).map((c) => c[1].attachmentId);
        expect(forced).toEqual([4, 2]);
        expect(deps.openWith).toHaveBeenCalledTimes(1);
        expect(ta.views("m1").map((v) => v.state)).toEqual(["ready", "ready", "waiting_wifi"]);
    });

    it("polls fast while a transfer runs, slowly while a file waits, not at all otherwise", async () => {
        stubLocale();
        vi.useFakeTimers();
        const { ta, deps, uploads } = harness();
        const a = att(null, { localUuid: "lu1", state: "queued", originalPath: "chat/d/out/lu1/a.jpg" });
        await ta.load(new Map([["m1", [att(1, { thumbPath: "chat/d/thumbs/1" })]]]), { pendingRows: new Set(), heldUploads: new Set() });
        ta.watch();
        vi.advanceTimersByTime(5000);
        expect(deps.onTick).not.toHaveBeenCalled();

        await ta.load(new Map([["uP", [a]]]), { pendingRows: new Set(["uP"]), heldUploads: new Set() });
        ta.watch();
        vi.advanceTimersByTime(PROGRESS_POLL_MS);
        expect(deps.onTick).not.toHaveBeenCalled();
        vi.advanceTimersByTime(WAIT_POLL_MS - PROGRESS_POLL_MS);
        expect(deps.onTick).toHaveBeenCalledTimes(1);

        uploads.set("lu1", { done: 1, total: 10 });
        ta.watch();
        vi.advanceTimersByTime(PROGRESS_POLL_MS);
        expect(deps.onTick).toHaveBeenCalledTimes(2);
        ta.dispose();
        vi.advanceTimersByTime(5000);
        expect(deps.onTick).toHaveBeenCalledTimes(2);
    });

    it("a download that ends while polled asks the thread to read the cache again", async () => {
        stubLocale();
        vi.useFakeTimers();
        const onReload = vi.fn();
        const { ta, progress } = harness({ onReload });
        await ta.load(new Map([["m1", [att(4, { mimetype: "application/pdf" })]]]), { pendingRows: new Set(), heldUploads: new Set() });
        progress.set(4, { done: 1, total: 10 });
        ta.views("m1");
        ta.watch();
        progress.delete(4);
        ta.views("m1");
        ta.watch();
        expect(onReload).toHaveBeenCalledTimes(1);
    });

    it("the rows are watched on screen with an IntersectionObserver, or seen at once without one", async () => {
        stubLocale();
        const observed: Element[] = [];
        let fire!: (entries: any[]) => void;
        class IO {
            constructor(cb: (e: any[]) => void) { fire = cb; }
            observe(el: Element) { observed.push(el); }
            unobserve() {}
            disconnect() {}
        }
        vi.stubGlobal("IntersectionObserver", IO);
        const { ta, cache } = harness();
        await ta.load(new Map([["m1", [att(1)]]]), { pendingRows: new Set(), heldUploads: new Set() });
        const el = document.createElement("div");
        ta.observe(el, "m1");
        await flush();
        expect(observed).toEqual([el]);
        expect(cache.preview).not.toHaveBeenCalled();
        fire([{ target: el, isIntersecting: true }]);
        await flush();
        expect(cache.preview).toHaveBeenCalledTimes(1);
        vi.unstubAllGlobals();
        stubLocale();

        const h2 = harness();
        await h2.ta.load(new Map([["m1", [att(1)]]]), { pendingRows: new Set(), heldUploads: new Set() });
        h2.ta.observe(document.createElement("div"), "m1");
        await flush();
        expect(h2.cache.preview).toHaveBeenCalledTimes(1);
    });
});

describe("ThreadAttachments visibility root", () => {
    it("the observer watches within the thread's scroll element, so its margin preloads", async () => {
        stubLocale();
        let options: any;
        class IO {
            constructor(_cb: any, o: any) { options = o; }
            observe() {}
            unobserve() {}
            disconnect() {}
        }
        vi.stubGlobal("IntersectionObserver", IO);
        const scroller = document.createElement("div");
        const { ta } = harness({ root: () => scroller });
        await ta.load(new Map([["m1", [att(1)]]]), { pendingRows: new Set(), heldUploads: new Set() });
        ta.observe(document.createElement("div"), "m1");
        expect(options).toMatchObject({ root: scroller, rootMargin: "100px" });
    });
});

describe("ChatImageViewerComponent", () => {
    function viewer(h: ReturnType<typeof harness>) {
        const v = new (ChatImageViewerComponent as any)();
        const onClose = vi.fn();
        v.props = { ta: h.ta, attKey: "a1", onClose };
        v.setup();
        return { v, onClose };
    }

    it("shows the preview at once, then the original", async () => {
        stubLocale();
        const h = harness();
        await h.ta.load(new Map([["m1", [att(1, { thumbPath: "chat/d/thumbs/1" })]]]), { pendingRows: new Set(), heldUploads: new Set() });
        const { v } = viewer(h);
        expect(v.state.url).toBe("http://localhost/_capacitor_file_/data/chat/d/thumbs/1");
        await v.load();
        expect(v.state.stage).toBe("ready");
        expect(v.state.url).toBe("http://localhost/_capacitor_file_/data/chat/d/files/1/f1.jpg");
    });

    it("an original held for Wi-Fi waits, « download anyway » takes that one now", async () => {
        stubLocale();
        const h = harness();
        await h.ta.load(new Map([["m1", [att(1, { thumbPath: "chat/d/thumbs/1" }), att(2)]]]), { pendingRows: new Set(), heldUploads: new Set() });
        h.cache.open.mockImplementation(async (_s: any, a: ChatAttachment, o: any = {}) =>
            o.anyNetwork ? { kind: "ready", path: "chat/d/files/" + a.attachmentId + "/" + a.name } : { kind: "waiting_wifi" });
        const { v, onClose } = viewer(h);
        await v.load();
        expect(v.state.stage).toBe("waiting_wifi");
        expect(v.state.url).toBe("http://localhost/_capacitor_file_/data/chat/d/thumbs/1");
        await v.onAnyway();
        expect(h.cache.open.mock.calls.map((c) => [c[1].attachmentId, !!c[2]?.anyNetwork])).toEqual([[1, false], [1, true]]);
        expect(v.state).toMatchObject({ stage: "ready", url: "http://localhost/_capacitor_file_/data/chat/d/files/1/f1.jpg" });
        v.onClose();
        expect(onClose).toHaveBeenCalled();
    });

    it("a held original shows once Wi-Fi lets it go, with no tap", async () => {
        stubLocale();
        vi.useFakeTimers();
        const h = harness();
        await h.ta.load(new Map([["m1", [att(1, { thumbPath: "chat/d/thumbs/1" })]]]), { pendingRows: new Set(), heldUploads: new Set() });
        h.cache.open.mockImplementation(async () => {
            if (h.waiting.has(1)) return { kind: "waiting_wifi" };
            return { kind: "ready", path: "chat/d/files/1/f1.jpg" };
        });
        h.waiting.add(1);
        const { v } = viewer(h);
        v.onOpened();
        await vi.advanceTimersByTimeAsync(0);
        expect(v.state.stage).toBe("waiting_wifi");
        // The cache's resumeWaiting takes it: the hold ends
        h.waiting.delete(1);
        await vi.advanceTimersByTimeAsync(PROGRESS_POLL_MS * 2);
        expect(v.state).toMatchObject({ stage: "ready", url: "http://localhost/_capacitor_file_/data/chat/d/files/1/f1.jpg" });
        expect(h.cache.open.mock.calls.every((c) => !c[2]?.anyNetwork)).toBe(true);
        v.onClosing();
    });

    it("Android back closes the viewer through its own history entry; ✕ pops that entry", async () => {
        stubLocale();
        const h = harness();
        await h.ta.load(new Map([["m1", [att(1, { thumbPath: "chat/d/thumbs/1" })]]]), { pendingRows: new Set(), heldUploads: new Set() });
        const push = vi.spyOn(window.history, "pushState");
        const back = vi.spyOn(window.history, "back").mockImplementation(() => {
            window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
        });
        const before = window.location.pathname;
        const { v, onClose } = viewer(h);
        v.onOpened();
        expect(push).toHaveBeenCalledTimes(1);
        // Same URL: the entry is the viewer's, the route does not move
        expect(window.location.pathname).toBe(before);
        expect(window.history.state?.chatViewer).toBe(true);
        window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
        expect(onClose).toHaveBeenCalledTimes(1);
        v.onClosing();

        const second = viewer(h);
        second.v.onOpened();
        second.v.onClose();
        expect(back).toHaveBeenCalledTimes(1);
        expect(second.onClose).toHaveBeenCalledTimes(1);
        second.v.onClosing();
        // Closed: a later back is not the viewer's
        window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
        expect(second.onClose).toHaveBeenCalledTimes(1);
        push.mockRestore();
        back.mockRestore();
    });

    it("a double tap on ✕ goes back once", async () => {
        stubLocale();
        const h = harness();
        await h.ta.load(new Map([["m1", [att(1, { thumbPath: "chat/d/thumbs/1" })]]]), { pendingRows: new Set(), heldUploads: new Set() });
        let pops = 0;
        const back = vi.spyOn(window.history, "back").mockImplementation(() => {
            pops += 1;
            // The popstate comes later, as in a browser
            setTimeout(() => window.dispatchEvent(new PopStateEvent("popstate", { state: null })), 0);
        });
        const { v, onClose } = viewer(h);
        v.onOpened();
        v.onClose();
        v.onClose();
        await new Promise((r) => setTimeout(r, 5));
        expect(pops).toBe(1);
        expect(onClose).toHaveBeenCalledTimes(1);
        v.onClosing();
        back.mockRestore();
    });

    it("a viewer removed with its entry still current drops its mark from it", async () => {
        stubLocale();
        const h = harness();
        await h.ta.load(new Map([["m1", [att(1, { thumbPath: "chat/d/thumbs/1" })]]]), { pendingRows: new Set(), heldUploads: new Set() });
        window.history.replaceState({ kept: 1 }, "");
        const { v } = viewer(h);
        v.onOpened();
        expect(window.history.state).toEqual({ kept: 1, chatViewer: true });
        v.onClosing();
        expect(window.history.state).toEqual({ kept: 1 });
        // Removed after the screen moved on: the new entry is left alone
        const w = viewer(h);
        w.v.onOpened();
        window.history.pushState({ route: "next" }, "");
        w.v.onClosing();
        expect(window.history.state).toEqual({ route: "next" });
    });

    it("the poll runs only while the original is asked or held", async () => {
        stubLocale();
        vi.useFakeTimers();
        const h = harness();
        await h.ta.load(new Map([["m1", [att(1, { thumbPath: "chat/d/thumbs/1" })]]]), { pendingRows: new Set(), heldUploads: new Set() });
        const { v } = viewer(h);
        const views = vi.spyOn(h.ta, "view");
        v.onOpened();
        await vi.advanceTimersByTimeAsync(0);
        expect(v.state.stage).toBe("ready");
        views.mockClear();
        await vi.advanceTimersByTimeAsync(PROGRESS_POLL_MS * 4);
        expect(views).not.toHaveBeenCalled();
        h.cache.open.mockResolvedValueOnce({ kind: "waiting_wifi" });
        await v.load();
        await vi.advanceTimersByTimeAsync(PROGRESS_POLL_MS);
        expect(views).toHaveBeenCalled();
        v.onClosing();
    });

    it("an original gone from the server says so and keeps the preview", async () => {
        stubLocale();
        const h = harness();
        await h.ta.load(new Map([["m1", [att(1, { thumbPath: "chat/d/thumbs/1" })]]]), { pendingRows: new Set(), heldUploads: new Set() });
        h.cache.open.mockResolvedValueOnce({ kind: "gone" });
        const { v } = viewer(h);
        await v.load();
        expect(v.state.stage).toBe("gone");
        expect(v.state.url).toBe("http://localhost/_capacitor_file_/data/chat/d/thumbs/1");
    });
});

describe("ChatAttachmentsComponent", () => {
    function comp(h: ReturnType<typeof harness>, rowKey = "m1") {
        const c = new (ChatAttachmentsComponent as any)();
        const onImage = vi.fn();
        c.props = { row: { key: rowKey, attachments: h.ta.views(rowKey) }, ta: h.ta, onImage };
        c.setup();
        return { c, onImage };
    }

    it("a tap on an image opens the viewer, on a failed preview retries it", async () => {
        stubLocale();
        const h = harness();
        h.failed.add(2);
        await h.ta.load(new Map([["m1", [att(1, { thumbPath: "chat/d/thumbs/1" }), att(2)]]]), { pendingRows: new Set(), heldUploads: new Set() });
        const { c, onImage } = comp(h);
        const [one, two] = h.ta.views("m1");
        c.onImage(one);
        expect(onImage).toHaveBeenCalledWith("a1");
        c.onImage(two);
        await flush();
        expect(h.cache.retryPreview).toHaveBeenCalledTimes(1);
        expect(onImage).toHaveBeenCalledTimes(1);
    });

    it("« download anyway » on a held voice plays it, on a held file opens it", async () => {
        stubLocale();
        const h = harness();
        const voice = att(2, { name: "Voice-2026-10-26-1.mp3", mimetype: "audio/mpeg", voice: true });
        const pdf = att(4, { name: "report.pdf", mimetype: "application/pdf" });
        await h.ta.load(new Map([["m1", [voice, pdf]]]), { pendingRows: new Set(), heldUploads: new Set() });
        const { c } = comp(h);
        const audio: any = { src: "", play: vi.fn(async () => {}), pause: vi.fn(), paused: true };
        audio.getAttribute = () => audio.src || null;
        c.audioOf = () => audio;
        const [v, f] = h.ta.views("m1");
        await c.onAnyway(v);
        await c.onAnyway(f);
        expect(h.cache.open.mock.calls.map((x) => [x[1].attachmentId, x[2]])).toEqual([[2, { anyNetwork: true }], [4, { anyNetwork: true }]]);
        expect(audio.src).toBe("http://localhost/_capacitor_file_/data/chat/d/files/2/Voice-2026-10-26-1.mp3");
        expect(audio.play).toHaveBeenCalled();
        expect(h.deps.openWith).toHaveBeenCalledWith("file:///data/user/0/app/files/chat/d/files/4/report.pdf", "application/pdf");
    });

    it("the player sets the audio's source once, and reads « playing » from the audio itself", async () => {
        stubLocale();
        const h = harness();
        const voice = att(2, { name: "Voice-2026-10-26-1.mp3", mimetype: "audio/mpeg", voice: true });
        await h.ta.load(new Map([["m1", [voice]]]), { pendingRows: new Set(), heldUploads: new Set() });
        const { c } = comp(h);
        const audio: any = document.createElement("audio");
        audio.play = vi.fn(async () => {});
        Object.defineProperty(audio, "paused", { get: () => !c.player.playing.a2 });
        c.audioOf = () => audio;
        const sets: string[] = [];
        const native = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "src")!;
        Object.defineProperty(audio, "src", {
            get: () => native.get!.call(audio),
            set: (u: string) => { sets.push(u); native.set!.call(audio, u); },
        });
        await c.onToggle(h.ta.views("m1")[0]);
        expect(sets).toEqual(["http://localhost/_capacitor_file_/data/chat/d/files/2/Voice-2026-10-26-1.mp3"]);
        expect(audio.play).toHaveBeenCalledTimes(1);
        // The tap alone is not playback
        expect(c.player.playing.a2).toBeFalsy();
        c.onAudio({ type: "play", target: audio }, "a2");
        expect(c.player.playing.a2).toBeFalsy();
        c.onAudio({ type: "playing", target: audio }, "a2");
        expect(c.player.playing.a2).toBe(true);
        // A render after the open finds the source there and leaves it
        c.props.row = { key: "m1", attachments: h.ta.views("m1") };
        c.syncSources();
        expect(sets).toHaveLength(1);
        c.onAudio({ type: "error", target: audio }, "a2");
        expect(c.player.playing.a2).toBe(false);
    });

    it("a voice already on the phone gets its source after a render, for its duration", async () => {
        stubLocale();
        const h = harness();
        const voice = att(2, { mimetype: "audio/mpeg", voice: true, originalPath: "chat/d/files/2/v.mp3" });
        await h.ta.load(new Map([["m1", [voice]]]), { pendingRows: new Set(), heldUploads: new Set() });
        const { c } = comp(h);
        const audio: any = document.createElement("audio");
        c.audioOf = () => audio;
        c.syncSources();
        expect(audio.getAttribute("src")).toBe("http://localhost/_capacitor_file_/data/chat/d/files/2/v.mp3");
        const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", "components", "chat", "chat_attachments_component.ts"), "utf8");
        const tag = source.slice(source.indexOf("<audio"));
        expect(tag.slice(0, tag.indexOf("/>"))).not.toContain("t-att-src");
    });

    it("the play button names the voice message or the file", async () => {
        stubLocale();
        const h = harness();
        await h.ta.load(new Map([["m1", [
            att(2, { mimetype: "audio/mpeg", voice: true }), att(3, { name: "song.ogg", mimetype: "audio/ogg" }),
        ]]]), { pendingRows: new Set(), heldUploads: new Set() });
        const { c } = comp(h);
        const [v, a] = h.ta.views("m1");
        expect(c.playLabel(v)).toBe("Play the voice message");
        expect(c.playLabel(a)).toBe("Play song.ogg");
        c.player.playing.a3 = true;
        expect(c.playLabel(a)).toBe("Pause song.ogg");
        stubLocale("fr");
        expect(c.playLabel(v)).toBe("Lire le message vocal");
    });

    it("the player shows the position over the duration; a voice not on the phone shows no time yet", () => {
        stubLocale();
        const h = harness();
        const { c } = comp(h);
        const here = { key: "a2", src: "http://localhost/v.mp3" };
        const remote = { key: "a2", src: null };
        expect(c.clockText(here)).toBe("0:00");
        expect(c.clockText(remote)).toBe("–:––");
        c.player.duration.a2 = 47.4;
        c.player.position.a2 = 12.2;
        expect(c.clockText(here)).toBe("0:12 / 0:47");
        expect(c.clockText(remote)).toBe("0:12 / 0:47");
    });

    it("an image tile's label says its state after its name", async () => {
        stubLocale();
        const h = harness();
        await h.ta.load(new Map([["m1", [att(1, { thumbPath: "chat/d/thumbs/1" })]]]), { pendingRows: new Set(), heldUploads: new Set() });
        const { c } = comp(h);
        const v = h.ta.views("m1")[0];
        expect(c.tileLabel(v)).toBe(v.name);
        expect(c.tileLabel({ ...v, state: "waiting_wifi" })).toBe(v.name + " — Waiting for Wi-Fi");
        expect(c.tileLabel({ ...v, state: "downloading", progress: 40 })).toBe(v.name + " — downloading, 40%");
        expect(c.tileLabel({ ...v, state: "uploading", progress: null })).toBe(v.name + " — sending");
        expect(c.tileLabel({ ...v, state: "refused", error: "Not sent: over the server's limit" }))
            .toBe(v.name + " — Not sent: over the server's limit");
        expect(c.tileLabel({ ...v, state: "failed_preview" })).toBe(v.name + ": preview not loaded, tap to try again");
        const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", "components", "chat", "chat_attachments_component.ts"), "utf8");
        expect(source).toContain('t-att-aria-label="tileLabel(v)"');
    });

    it("audio the web view cannot play says so and offers « open with », a voice message only says so", async () => {
        stubLocale();
        const h = harness();
        await h.ta.load(new Map([["m1", [
            att(2, { mimetype: "audio/mpeg", voice: true, originalPath: "chat/d/files/2/v.mp3" }),
            att(3, { name: "song.xyz", mimetype: "audio/x-unknown", originalPath: "chat/d/files/3/song.xyz" }),
        ]]]), { pendingRows: new Set(), heldUploads: new Set() });
        const { c } = comp(h);
        const audio: any = document.createElement("audio");
        audio.setAttribute("src", "http://localhost/_capacitor_file_/data/chat/d/files/3/song.xyz");
        c.onAudio({ type: "error", target: audio }, "a3");
        const failing: any = document.createElement("audio");
        failing.play = vi.fn(async () => { throw Object.assign(new Error("no"), { name: "NotSupportedError" }); });
        c.audioOf = () => failing;
        await c.play(h.ta.views("m1")[0], false);
        const [voice, song] = h.ta.views("m1");
        expect(song.error).toBe("This file cannot be played here.");
        expect(voice.error).toBe("This file cannot be played here.");
        expect(c.canOpenWith(song)).toBe(true);
        expect(c.canOpenWith(voice)).toBe(false);
        c.onFile(song);
        await flush();
        expect(h.deps.openWith).toHaveBeenCalledWith("file:///data/user/0/app/files/chat/d/files/3/song.xyz", "audio/x-unknown");
        const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", "components", "chat", "chat_attachments_component.ts"), "utf8");
        expect(source).toMatch(/t-if="canOpenWith\(v\)"[^>]*t-on-click="\(\) => this\.onFile\(v\)"[^>]*t-esc="t\('chat\.open_with'\)"/);
    });

    it("the template keeps Owl's syntax: no ${} and the grid follows the count", () => {
        const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", "components", "chat", "chat_attachments_component.ts"), "utf8");
        const tpl = source.slice(source.indexOf("static template = xml`"));
        expect(tpl.slice(0, tpl.indexOf("`;"))).not.toContain("${");
        expect(tpl).toContain("chat-att__grid--single");
        expect(tpl).toContain("<audio");
        const viewerSource = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", "components", "chat", "chat_image_viewer_component.ts"), "utf8");
        const vtpl = viewerSource.slice(viewerSource.indexOf("static template = xml`"));
        expect(vtpl.slice(0, vtpl.indexOf("`;"))).not.toContain("${");
    });
});
