// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@capacitor/app", () => ({ App: { addListener: vi.fn() } }));
vi.mock("@capacitor/camera", () => ({ Camera: {} }));
vi.mock("@capacitor/filesystem", () => ({ Filesystem: {}, Directory: { Data: "DATA", External: "EXTERNAL" } }));
vi.mock("capacitor-voice-recorder", () => ({ VoiceRecorder: {} }));

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
    ComposerAttach,
    countdownLine,
    limitLine,
    newComposerAttachState,
    type ComposerAttachDeps,
} from "../components/chat/chat_composer_attach_component";
import { outgoingPath } from "../services/chat/chatFiles";
import { formatBytes } from "../utils/formatBytes";
import type { OutgoingFile } from "../models/chat";
import { memoryChatFiles } from "../testing/chatFakes";
import { VOICE_MAX_MS } from "../services/chat/chatVoice";

const FILE_DIR = "q3Zt8Wn1";
const LIMIT = 2 * 1024 * 1024;

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

let uuid = 0;

/** A staged file as ChatCapture.stage writes it, its bytes in files. */
function stagedOf(files: ReturnType<typeof memoryChatFiles>, name: string, size: number, mimetype: string): OutgoingFile {
    const localUuid = "uuid-" + ++uuid;
    const path = outgoingPath(FILE_DIR, localUuid, name);
    files.put(path, new Uint8Array(size));
    return { localUuid, path, name, mimetype, size, voice: false };
}

function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
}

/**
 * The controller over fakes: picks answer the files given to pickNext,
 * stage writes them to memory files (or answers what stageAs returns), the
 * recorder records until stop() gives a voice file.
 */
function harness(opts: { askCompress?: boolean; limit?: number | null; confirm?: boolean } = {}) {
    const files = memoryChatFiles();
    const order: string[] = [];
    let picked: File[] = [];
    const capture = {
        pickFiles: vi.fn(async (_input: HTMLInputElement, kind: string) => {
            order.push("pick " + kind);
            return picked;
        }),
        stage: vi.fn(async (_dir: string, file: File, o: { maxUploadSize: number }): Promise<any> => {
            order.push("stage " + file.name);
            if (file.size + 65536 > o.maxUploadSize) return { refused: "too_big", limit: o.maxUploadSize };
            return stagedOf(files, file.name, file.size, file.type || "application/octet-stream");
        }),
        compress: vi.fn(async (f: OutgoingFile) => ({ ...f, name: f.name.replace(/\.\w+$/, ".jpg"), size: 100, mimetype: "image/jpeg" })),
    };
    let remaining = VOICE_MAX_MS;
    const recorder = {
        onAutoStop: null as (() => void) | null,
        onBackground: null as (() => void) | null,
        start: vi.fn(async () => "recording" as const),
        remainingMs: vi.fn(() => remaining),
        stop: vi.fn(async (dir: string) => {
            const file = stagedOf(files, "Voice-2026-10-26-4821.mp3", 4000, "audio/mpeg");
            expect(dir).toBe(FILE_DIR);
            return { ...file, voice: true };
        }),
        discard: vi.fn(async () => {}),
    };
    const send = vi.fn(async (_extra: OutgoingFile[]) => {});
    const confirm = vi.fn(async (_message: string) => opts.confirm ?? true);
    const deps: ComposerAttachDeps = {
        capture,
        recorder,
        files,
        fileDir: async () => FILE_DIR,
        uploadLimit: async () => (opts.limit === undefined ? LIMIT : opts.limit),
        askCompress: () => opts.askCompress ?? false,
        confirm,
        send,
    };
    const state = newComposerAttachState();
    const attach = new ComposerAttach(state, deps);
    return {
        attach, state, files, capture, recorder, send, confirm, order,
        pickNext: (list: File[]) => { picked = list; },
        setRemaining: (ms: number) => { remaining = ms; },
        input: document.createElement("input"),
    };
}

const file = (name: string, size: number, type = "image/jpeg") => new File([new Uint8Array(size)], name, { type });

beforeEach(() => stubLocale());
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe("ComposerAttach", () => {
    it("the sheet names the server's limit before anything is sent", async () => {
        const h = harness();
        await h.attach.start();
        h.attach.toggleSheet();
        expect(h.state.sheet).toBe(true);
        expect(limitLine(h.state.limit)).toBe("Server limit: 2 MB per file");
        h.attach.toggleSheet();
        expect(h.state.sheet).toBe(false);
    });

    it("an unknown limit is not shown", async () => {
        const h = harness({ limit: null });
        await h.attach.start();
        expect(limitLine(h.state.limit)).toBe("");
    });

    it("the sheet offers camera, gallery and file, with the limit under them", () => {
        const source = readFileSync(
            resolve(dirname(fileURLToPath(import.meta.url)), "..", "components", "chat", "chat_composer_attach_component.ts"),
            "utf8",
        );
        const sheet = source.slice(source.indexOf("chat-attach__sheet"));
        const at = (s: string) => sheet.indexOf(s);
        expect(at("onPick('camera')")).toBeGreaterThan(0);
        expect(at("onPick('gallery')")).toBeGreaterThan(at("onPick('camera')"));
        expect(at("onPick('file')")).toBeGreaterThan(at("onPick('gallery')"));
        expect(at("limitText()")).toBeGreaterThan(at("onPick('file')"));
        // Read through this component's own proxy, so a change re-renders it (see the class)
        expect(sheet.slice(0, sheet.indexOf("</div>`;"))).not.toMatch(/attach\.(limitText|timerText|sizeText)/);
    });

    it("a pick opens the picker within the tap, then stages the files one after another", async () => {
        const h = harness();
        await h.attach.start();
        h.state.sheet = true;
        const gate = deferred<void>();
        const stage = h.capture.stage.getMockImplementation()!;
        let running = 0;
        let most = 0;
        h.capture.stage.mockImplementation(async (...args) => {
            running++;
            most = Math.max(most, running);
            if (args[1].name === "a.jpg") await gate.promise;
            try {
                return await stage(...args);
            } finally {
                running--;
            }
        });
        h.pickNext([file("a.jpg", 10), file("b.jpg", 20)]);
        const picking = h.attach.pick(h.input, "gallery");
        expect(h.capture.pickFiles).toHaveBeenCalledWith(h.input, "gallery");
        expect(h.state.sheet).toBe(false);
        await flush();
        // b.jpg waits for a.jpg, held at the gate
        expect(h.capture.stage).toHaveBeenCalledTimes(1);
        gate.resolve();
        await picking;
        expect(most).toBe(1);
        expect(h.order).toEqual(["pick gallery", "stage a.jpg", "stage b.jpg"]);
        expect(h.capture.stage).toHaveBeenCalledWith(FILE_DIR, expect.any(File), { maxUploadSize: LIMIT });
        expect(h.state.chips.map((c) => [c.file.name, c.origin])).toEqual([["a.jpg", "gallery"], ["b.jpg", "gallery"]]);
        expect(h.state.staging).toBe(0);
    });

    it("a chip shows its size and its ✕ deletes the staged file", async () => {
        const h = harness();
        await h.attach.start();
        h.pickNext([file("report.pdf", 17507, "application/pdf")]);
        await h.attach.pick(h.input, "file");
        const [chip] = h.state.chips;
        expect(formatBytes(chip.file.size, "en")).toBe("17 KB");
        expect(h.files.bytes(chip.file.path)).toBeDefined();
        await h.attach.remove(chip);
        expect(h.state.chips).toEqual([]);
        expect(h.files.bytes(chip.file.path)).toBeUndefined();
    });

    it("a file over the limit is refused with the limit named, the others still staged", async () => {
        const h = harness();
        await h.attach.start();
        h.pickNext([file("film.mp4", 3 * 1024 * 1024, "video/mp4"), file("ok.jpg", 10)]);
        await h.attach.pick(h.input, "file");
        expect(h.state.chips.map((c) => c.file.name)).toEqual(["ok.jpg"]);
        expect(h.state.notices).toEqual(["“film.mp4” is over the server's limit of 2 MB: it cannot be sent."]);
    });

    it("a HEIC that could not be converted is kept with a notice", async () => {
        const h = harness();
        await h.attach.start();
        h.pickNext([file("beach.heic", 10, "image/heic")]);
        await h.attach.pick(h.input, "gallery");
        expect(h.state.chips.map((c) => c.file.mimetype)).toEqual(["image/heic"]);
        expect(h.state.notices).toEqual(["“beach.heic” could not be converted: the recipient may not be able to open it."]);
    });

    it("a file that cannot be staged is named, the others still staged", async () => {
        const h = harness();
        await h.attach.start();
        const stage = h.capture.stage.getMockImplementation()!;
        h.capture.stage.mockImplementation(async (...args) => {
            if (args[1].name === "bad.txt") throw new Error("disk full");
            return stage(...args);
        });
        h.pickNext([file("bad.txt", 5, "text/plain"), file("good.txt", 5, "text/plain")]);
        await h.attach.pick(h.input, "file");
        expect(h.state.chips.map((c) => c.file.name)).toEqual(["good.txt"]);
        expect(h.state.notices).toEqual(["“bad.txt” could not be attached."]);
    });

    it("a dismissed picker adds nothing", async () => {
        const h = harness();
        await h.attach.start();
        h.pickNext([]);
        await h.attach.pick(h.input, "camera");
        expect(h.capture.stage).not.toHaveBeenCalled();
        expect(h.state.chips).toEqual([]);
    });

    it("take empties the chips at once and gives their files in pick order", async () => {
        const h = harness();
        await h.attach.start();
        h.pickNext([file("a.jpg", 1), file("b.jpg", 2)]);
        await h.attach.pick(h.input, "gallery");
        const taken = h.attach.take();
        expect(taken.map((c) => c.file.name)).toEqual(["a.jpg", "b.jpg"]);
        expect(h.state.chips).toEqual([]);
    });

    it("a send's take clears the notices of the picks before it", async () => {
        const h = harness();
        await h.attach.start();
        h.pickNext([file("film.mp4", 3 * 1024 * 1024, "video/mp4"), file("ok.jpg", 10)]);
        await h.attach.pick(h.input, "file");
        expect(h.state.notices).toHaveLength(1);
        h.attach.take();
        expect(h.state.notices).toEqual([]);
    });

    it("compress is asked only with the setting on and a camera or gallery photo", async () => {
        const off = harness({ askCompress: false });
        await off.attach.start();
        off.pickNext([file("a.jpg", 10)]);
        await off.attach.pick(off.input, "camera");
        expect((await off.attach.prepare(off.attach.take())).map((f) => f.size)).toEqual([10]);
        expect(off.confirm).not.toHaveBeenCalled();

        const anyFile = harness({ askCompress: true });
        await anyFile.attach.start();
        anyFile.pickNext([file("scan.jpg", 10)]);
        await anyFile.attach.pick(anyFile.input, "file");
        await anyFile.attach.prepare(anyFile.attach.take());
        expect(anyFile.confirm).not.toHaveBeenCalled();
        expect(anyFile.capture.compress).not.toHaveBeenCalled();

        const yes = harness({ askCompress: true, confirm: true });
        await yes.attach.start();
        yes.pickNext([file("shot.png", 10, "image/png")]);
        await yes.attach.pick(yes.input, "gallery");
        yes.pickNext([file("notes.pdf", 10, "application/pdf")]);
        await yes.attach.pick(yes.input, "file");
        const sent = await yes.attach.prepare(yes.attach.take());
        expect(yes.confirm).toHaveBeenCalledWith("Compress the photos before sending? They are reduced to 1920 px.");
        expect(yes.capture.compress).toHaveBeenCalledTimes(1);
        expect(sent.map((f) => [f.name, f.size])).toEqual([["shot.jpg", 100], ["notes.pdf", 10]]);

        const no = harness({ askCompress: true, confirm: false });
        await no.attach.start();
        no.pickNext([file("shot.jpg", 10)]);
        await no.attach.pick(no.input, "camera");
        expect((await no.attach.prepare(no.attach.take())).map((f) => f.size)).toEqual([10]);
        expect(no.capture.compress).not.toHaveBeenCalled();
    });

    it("the mic starts, the timer counts down, a second tap stops and sends", async () => {
        vi.useFakeTimers();
        const h = harness();
        await h.attach.start();
        await h.attach.mic();
        expect(h.state.voice).toBe("recording");
        expect(countdownLine(h.state.remainingMs)).toBe("1:00 left");
        h.setRemaining(42_300);
        vi.advanceTimersByTime(500);
        expect(countdownLine(h.state.remainingMs)).toBe("0:43 left");
        const sending = h.attach.mic();
        expect(h.state.voice).toBe("preparing");
        expect(h.attach.busy()).toBe(true);
        await sending;
        expect(h.recorder.stop).toHaveBeenCalledTimes(1);
        expect(h.send).toHaveBeenCalledTimes(1);
        expect(h.send.mock.calls[0][0].map((f: OutgoingFile) => [f.name, f.voice])).toEqual([["Voice-2026-10-26-4821.mp3", true]]);
        expect(h.state.voice).toBe("idle");
        expect(h.attach.busy()).toBe(false);
    });

    it("the voice goes idle before it is sent, so the send is not refused as busy", async () => {
        const h = harness();
        await h.attach.start();
        await h.attach.mic();
        let seen = "";
        h.send.mockImplementation(async () => { seen = h.state.voice; });
        await h.attach.mic();
        expect(seen).toBe("idle");
    });

    it("✕ discards the recording and sends nothing", async () => {
        const h = harness();
        await h.attach.start();
        await h.attach.mic();
        await h.attach.discardVoice();
        expect(h.recorder.discard).toHaveBeenCalledTimes(1);
        expect(h.recorder.stop).not.toHaveBeenCalled();
        expect(h.send).not.toHaveBeenCalled();
        expect(h.state.voice).toBe("idle");
    });

    it("the 60 s auto-stop sends", async () => {
        const h = harness();
        await h.attach.start();
        await h.attach.mic();
        h.recorder.onAutoStop!();
        await flush();
        expect(h.recorder.stop).toHaveBeenCalledTimes(1);
        expect(h.send).toHaveBeenCalledTimes(1);
    });

    it("the app going to the background keeps the recording as an unsent voice chip, and the mic hides", async () => {
        const h = harness();
        await h.attach.start();
        await h.attach.mic();
        expect(h.attach.hasVoiceChip()).toBe(false);
        h.recorder.onBackground!();
        await flush();
        expect(h.send).not.toHaveBeenCalled();
        expect(h.state.voice).toBe("idle");
        expect(h.state.chips.map((c) => [c.file.name, c.origin])).toEqual([["Voice-2026-10-26-4821.mp3", "voice"]]);
        expect(h.attach.hasVoiceChip()).toBe(true);
        await h.attach.remove(h.state.chips[0]);
        expect(h.attach.hasVoiceChip()).toBe(false);
    });

    it("a refused microphone or a phone that cannot record says so", async () => {
        const h = harness();
        await h.attach.start();
        h.recorder.start.mockResolvedValueOnce("denied" as any);
        await h.attach.mic();
        expect(h.state.voice).toBe("idle");
        expect(h.state.notices).toEqual(["The microphone is not allowed for this app."]);
        h.recorder.start.mockResolvedValueOnce("unavailable" as any);
        await h.attach.mic();
        expect(h.state.notices).toEqual(["The microphone cannot be used now."]);
    });

    it("a recording that cannot be prepared says so and sends nothing", async () => {
        const h = harness();
        await h.attach.start();
        await h.attach.mic();
        h.recorder.stop.mockRejectedValueOnce(new Error("decode"));
        await h.attach.mic();
        expect(h.send).not.toHaveBeenCalled();
        expect(h.state.voice).toBe("idle");
        expect(h.state.notices).toEqual(["The voice message could not be prepared."]);
    });

    it("a recorder still held by a recording nobody stopped is discarded and started again", async () => {
        const h = harness();
        await h.attach.start();
        h.recorder.start.mockRejectedValueOnce(new Error("A voice recording is already under way."));
        await h.attach.mic();
        expect(h.recorder.discard).toHaveBeenCalledTimes(1);
        expect(h.recorder.start).toHaveBeenCalledTimes(2);
        expect(h.state.voice).toBe("recording");
    });

    it("dispose discards the recording, deletes the unsent chips' files and lets go of the recorder", async () => {
        const h = harness();
        await h.attach.start();
        h.pickNext([file("a.jpg", 10)]);
        await h.attach.pick(h.input, "camera");
        const path = h.state.chips[0].file.path;
        await h.attach.mic();
        await h.attach.dispose();
        expect(h.recorder.discard).toHaveBeenCalledTimes(1);
        expect(h.files.bytes(path)).toBeUndefined();
        expect(h.recorder.onAutoStop).toBeNull();
        expect(h.recorder.onBackground).toBeNull();
    });

    it("dispose leaves the recorder's callbacks to a composer that took it over", async () => {
        const first = harness();
        await first.attach.start();
        const other = () => {};
        first.recorder.onAutoStop = other;
        await first.attach.dispose();
        expect(first.recorder.onAutoStop).toBe(other);
        expect(first.recorder.discard).not.toHaveBeenCalled();
    });

    it("a file staged after dispose is deleted, not shown", async () => {
        const h = harness();
        await h.attach.start();
        const gate = deferred<void>();
        const stage = h.capture.stage.getMockImplementation()!;
        let staged: OutgoingFile | null = null;
        h.capture.stage.mockImplementation(async (...args) => {
            await gate.promise;
            staged = await stage(...args);
            return staged;
        });
        h.pickNext([file("late.jpg", 10)]);
        const picking = h.attach.pick(h.input, "gallery");
        await flush();
        await h.attach.dispose();
        gate.resolve();
        await picking;
        expect(h.state.chips).toEqual([]);
        expect(h.files.bytes(staged!.path)).toBeUndefined();
    });
});
