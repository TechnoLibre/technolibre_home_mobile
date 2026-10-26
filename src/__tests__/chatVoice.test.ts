import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@capacitor/app", () => ({ App: { addListener: vi.fn() } }));
vi.mock("@capacitor/filesystem", () => ({
    Filesystem: {},
    Directory: { Data: "DATA" },
}));
vi.mock("capacitor-voice-recorder", () => ({ VoiceRecorder: {} }));

import { outgoingPath } from "../services/chat/chatFiles";
import { ChatVoiceRecorder, VOICE_DIR, VOICE_MAX_MS, type VoiceDeps } from "../services/chat/chatVoice";
import { memoryChatFiles } from "../testing/chatFakes";

const FILE_DIR = "f7Kq2Lm9";
const AAC = new Uint8Array([0xff, 0xf1, 0x50, 0x40, 1, 2, 3]);
const MP3 = new Uint8Array([0xff, 0xfb, 0x90, 0xc4, 9, 9]);
const flush = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
};

/**
 * A recorder over memory files: startRecording opens a recording, stopRecording
 * writes it under VOICE_DIR and answers its path as the plugin does (relative to
 * Directory.Data, subDirectory first).
 */
function harness(opts: { granted?: boolean; grant?: boolean; device?: boolean; startFails?: boolean } = {}) {
    const files = memoryChatFiles();
    let granted = opts.granted ?? true;
    let n = 0;
    let listener: ((active: boolean) => void) | null = null;
    const recorder = {
        canDeviceVoiceRecord: vi.fn(async () => ({ value: opts.device ?? true })),
        hasAudioRecordingPermission: vi.fn(async () => ({ value: granted })),
        requestAudioRecordingPermission: vi.fn(async () => {
            granted = opts.grant ?? false;
            return { value: granted };
        }),
        startRecording: vi.fn(async () => {
            if (opts.startFails) throw new Error("Microphone is being used");
            n++;
            return { value: true };
        }),
        stopRecording: vi.fn(async () => {
            const path = `${VOICE_DIR}/recording-${n}.aac`;
            files.put(path, AAC);
            return { value: { msDuration: 3000, mimeType: "audio/aac", path } };
        }),
    };
    const decoded = { numberOfChannels: 1, length: 3, sampleRate: 44100, getChannelData: () => Float32Array.of(0.1, 0.2, 0.3) };
    const deps: VoiceDeps = {
        recorder,
        files,
        read: vi.fn(async (rel: string) => {
            const bytes = files.bytes(rel);
            if (!bytes) throw new Error(`File does not exist: ${rel}`);
            return bytes.slice().buffer;
        }),
        decode: vi.fn(async () => decoded as unknown as AudioBuffer),
        encode: vi.fn(async () => MP3.slice()),
        onAppActive: (fn) => {
            listener = fn;
            return () => {
                listener = null;
            };
        },
    };
    return {
        files,
        recorder,
        deps,
        voice: new ChatVoiceRecorder(deps),
        setApp: (active: boolean) => listener?.(active),
        listening: () => listener !== null,
    };
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-07T10:00:00Z"));
});

afterEach(() => {
    vi.useRealTimers();
});

describe("ChatVoiceRecorder", () => {
    it("stop before 60 s gives an MP3 OutgoingFile with voice true and audio/mpeg", async () => {
        const h = harness();
        expect(await h.voice.start()).toBe("recording");
        expect(h.recorder.startRecording).toHaveBeenCalledWith({ directory: "DATA", subDirectory: VOICE_DIR });
        vi.advanceTimersByTime(3000);
        expect(h.voice.elapsedMs()).toBe(3000);
        expect(h.voice.remainingMs()).toBe(VOICE_MAX_MS - 3000);
        const stopping = h.voice.stop(FILE_DIR);
        vi.advanceTimersByTime(1000);
        expect(h.voice.elapsedMs()).toBe(3000);
        const file = await stopping;
        expect(file).toMatchObject({ mimetype: "audio/mpeg", voice: true, size: MP3.length });
        expect(file.name).toMatch(/^Voice-2026-03-07-\d{1,5}\.mp3$/);
        expect(file.path).toBe(outgoingPath(FILE_DIR, file.localUuid, file.name));
        expect(h.files.bytes(file.path)).toEqual(MP3);
        expect(h.deps.decode).toHaveBeenCalledWith(AAC.buffer);
        expect(h.deps.encode).toHaveBeenCalledWith(Float32Array.of(0.1, 0.2, 0.3), 44100);
        expect(h.files.bytes(`${VOICE_DIR}/recording-1.aac`)).toBeUndefined();
        expect(h.voice.elapsedMs()).toBe(0);
        expect(h.listening()).toBe(false);
        expect(await h.voice.start()).toBe("recording");
    });

    it("60 s stops by itself and calls onAutoStop", async () => {
        const h = harness();
        const onAutoStop = vi.fn();
        h.voice.onAutoStop = onAutoStop;
        await h.voice.start();
        vi.advanceTimersByTime(VOICE_MAX_MS - 1);
        await flush();
        expect(h.recorder.stopRecording).not.toHaveBeenCalled();
        expect(h.voice.remainingMs()).toBe(1);
        vi.advanceTimersByTime(1);
        await flush();
        expect(h.recorder.stopRecording).toHaveBeenCalledTimes(1);
        expect(onAutoStop).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(5000);
        expect(h.voice.elapsedMs()).toBe(VOICE_MAX_MS);
        expect(h.voice.remainingMs()).toBe(0);
        const file = await h.voice.stop(FILE_DIR);
        expect(h.recorder.stopRecording).toHaveBeenCalledTimes(1);
        expect(h.files.bytes(file.path)).toEqual(MP3);
    });

    it("a tap at the auto-stop gives one file from one native stop", async () => {
        const h = harness();
        h.voice.onAutoStop = vi.fn();
        await h.voice.start();
        vi.advanceTimersByTime(VOICE_MAX_MS);
        const [a, b] = await Promise.all([h.voice.stop(FILE_DIR), h.voice.stop(FILE_DIR)]);
        expect(a).toBe(b);
        expect(h.recorder.stopRecording).toHaveBeenCalledTimes(1);
        expect(h.deps.encode).toHaveBeenCalledTimes(1);
    });

    it("discard deletes the recording", async () => {
        const h = harness();
        const onAutoStop = vi.fn();
        h.voice.onAutoStop = onAutoStop;
        await h.voice.start();
        vi.advanceTimersByTime(2000);
        await h.voice.discard();
        expect(h.recorder.stopRecording).toHaveBeenCalledTimes(1);
        expect(await h.files.list(VOICE_DIR)).toEqual([]);
        expect(await h.files.list(`chat/${FILE_DIR}/out`)).toEqual([]);
        expect(h.deps.encode).not.toHaveBeenCalled();
        vi.advanceTimersByTime(VOICE_MAX_MS);
        await flush();
        expect(onAutoStop).not.toHaveBeenCalled();
        expect(h.voice.elapsedMs()).toBe(0);
        await expect(h.voice.stop(FILE_DIR)).rejects.toThrow();
    });

    it("discard after the auto-stop deletes the stopped recording", async () => {
        const h = harness();
        h.voice.onAutoStop = vi.fn();
        await h.voice.start();
        vi.advanceTimersByTime(VOICE_MAX_MS);
        await flush();
        expect(await h.files.list(VOICE_DIR)).toEqual(["recording-1.aac"]);
        await h.voice.discard();
        expect(await h.files.list(VOICE_DIR)).toEqual([]);
    });

    it("discard while the permission is asked never records", async () => {
        const h = harness({ granted: false, grant: true });
        let answer!: (v: { value: boolean }) => void;
        h.recorder.requestAudioRecordingPermission.mockImplementationOnce(
            () => new Promise((r) => { answer = r; }),
        );
        const started = h.voice.start();
        await flush();
        await h.voice.discard();
        answer({ value: true });
        expect(await started).toBe("unavailable");
        expect(h.recorder.startRecording).not.toHaveBeenCalled();
        expect(h.listening()).toBe(false);
    });

    it("permission asked once, denied gives no recording", async () => {
        const h = harness({ granted: false, grant: false });
        expect(await h.voice.start()).toBe("denied");
        expect(h.recorder.requestAudioRecordingPermission).toHaveBeenCalledTimes(1);
        expect(h.recorder.startRecording).not.toHaveBeenCalled();
        expect(h.voice.elapsedMs()).toBe(0);
        await expect(h.voice.stop(FILE_DIR)).rejects.toThrow();

        const ok = harness({ granted: false, grant: true });
        expect(await ok.voice.start()).toBe("recording");
        await ok.voice.discard();
        expect(await ok.voice.start()).toBe("recording");
        expect(ok.recorder.requestAudioRecordingPermission).toHaveBeenCalledTimes(1);
        expect(ok.recorder.hasAudioRecordingPermission).toHaveBeenCalledTimes(2);
    });

    it("a phone that cannot record or a busy microphone gives unavailable", async () => {
        const none = harness({ device: false });
        expect(await none.voice.start()).toBe("unavailable");
        expect(none.recorder.startRecording).not.toHaveBeenCalled();
        const busy = harness({ startFails: true });
        expect(await busy.voice.start()).toBe("unavailable");
        expect(busy.listening()).toBe(false);
        expect(await busy.voice.start()).toBe("unavailable");
    });

    it("background keeps the recording unsent", async () => {
        const h = harness();
        const onAutoStop = vi.fn();
        const onBackground = vi.fn();
        h.voice.onAutoStop = onAutoStop;
        h.voice.onBackground = onBackground;
        await h.voice.start();
        vi.advanceTimersByTime(4000);
        h.setApp(false);
        await flush();
        expect(h.recorder.stopRecording).toHaveBeenCalledTimes(1);
        expect(onBackground).toHaveBeenCalledTimes(1);
        expect(await h.files.list(VOICE_DIR)).toEqual(["recording-1.aac"]);
        vi.advanceTimersByTime(VOICE_MAX_MS);
        await flush();
        expect(onAutoStop).not.toHaveBeenCalled();
        expect(h.voice.elapsedMs()).toBe(4000);
        h.setApp(true);
        const file = await h.voice.stop(FILE_DIR);
        expect(file).toMatchObject({ voice: true, mimetype: "audio/mpeg" });
        expect(h.recorder.stopRecording).toHaveBeenCalledTimes(1);
    });

    it("start clears a recording an earlier process left", async () => {
        const h = harness();
        h.files.put(`${VOICE_DIR}/recording-0.aac`, AAC);
        await h.voice.start();
        expect(await h.files.list(VOICE_DIR)).toEqual([]);
    });

    it("a recording that cannot be decoded leaves no file", async () => {
        const h = harness();
        vi.mocked(h.deps.decode).mockRejectedValueOnce(new Error("Unable to decode audio data"));
        await h.voice.start();
        vi.advanceTimersByTime(1000);
        await expect(h.voice.stop(FILE_DIR)).rejects.toThrow("Unable to decode audio data");
        expect(await h.files.list(VOICE_DIR)).toEqual([]);
        expect(await h.files.list(`chat/${FILE_DIR}/out`)).toEqual([]);
        expect(await h.voice.start()).toBe("recording");
    });
});
