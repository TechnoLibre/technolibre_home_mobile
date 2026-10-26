import { App } from "@capacitor/app";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { VoiceRecorder, type VoiceRecorderPlugin } from "capacitor-voice-recorder";
import { v4 as uuidv4 } from "uuid";
import type { OutgoingFile } from "../../models/chat";
import type { ChatFiles } from "./chatFiles";
import { deviceChatFiles, outgoingPath } from "./chatFiles";
import { mixToMono, voiceName } from "./chatMp3";
import type { Mp3Job, Mp3Result } from "./chatMp3Worker";

/** Longest voice message, as Odoo's own recorder: at this length the recording stops by itself. */
export const VOICE_MAX_MS = 60000;

/**
 * Where the recorder writes its AAC, relative to Directory.Data. A uuid
 * (an account's fileDir) is never "voice", so no account directory is
 * this one. It only ever holds the recording under way: start() empties
 * it.
 */
export const VOICE_DIR = "chat/voice";

const VOICE_MIMETYPE = "audio/mpeg";

/** Rate the recorder captures at (capacitor-voice-recorder's CustomMediaRecorder), kept by the decoder. */
const RECORD_RATE = 44100;

export type VoiceStart = "recording" | "denied" | "unavailable";

type Recorder = Pick<
    VoiceRecorderPlugin,
    "canDeviceVoiceRecord" | "hasAudioRecordingPermission" | "requestAudioRecordingPermission"
    | "startRecording" | "stopRecording"
>;

export interface VoiceDeps {
    recorder: Recorder;
    files: ChatFiles;
    /** The bytes of a file, by its path relative to Directory.Data. */
    read: (rel: string) => Promise<ArrayBuffer>;
    /** The audio of an encoded file, as the web view decodes it. */
    decode: (bytes: ArrayBuffer) => Promise<AudioBuffer>;
    /** Mono samples as an MP3 (chatMp3.encodeMp3), off the UI thread. */
    encode: (samples: Float32Array, sampleRate: number) => Promise<Uint8Array>;
    /** Follows the app's foreground state (true: active); returns the unsubscribe. */
    onAppActive: (fn: (active: boolean) => void) => () => void;
}

/** Bytes of a Data file through @capacitor/filesystem (base64 on the phone, a Blob on the web). */
async function readDataFile(rel: string): Promise<ArrayBuffer> {
    const { data } = await Filesystem.readFile({ path: rel, directory: Directory.Data });
    if (data instanceof Blob) return data.arrayBuffer();
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
}

/**
 * Decodes at the recorder's own rate, so nothing is resampled; an offline
 * context opens no audio output and needs no user gesture.
 */
function decodeInWebView(bytes: ArrayBuffer): Promise<AudioBuffer> {
    return new OfflineAudioContext(1, 1, RECORD_RATE).decodeAudioData(bytes);
}

/** encodeMp3 in a worker of its own (chatMp3Worker.ts), ended once it answers; the samples are transferred. */
export function encodeInWorker(samples: Float32Array, sampleRate: number): Promise<Uint8Array> {
    const worker = new Worker(new URL("./chatMp3Worker.ts", import.meta.url), { type: "module" });
    return new Promise<Uint8Array>((resolve, reject) => {
        worker.onmessage = (event: MessageEvent<Mp3Result>) => {
            const result = event.data;
            if ("mp3" in result) resolve(result.mp3);
            else reject(new Error(result.error));
        };
        worker.onerror = (event) => reject(new Error(event.message || "MP3 worker failed"));
        const job: Mp3Job = { samples, sampleRate };
        worker.postMessage(job, [samples.buffer as ArrayBuffer]);
    }).finally(() => worker.terminate());
}

function followAppState(fn: (active: boolean) => void): () => void {
    const handle = App.addListener("appStateChange", ({ isActive }) => fn(isActive));
    return () => void handle.then((h) => h.remove()).catch(() => {});
}

type State = "idle" | "starting" | "recording" | "halted" | "finishing";

/**
 * One voice message at a time for the chat composer: records AAC through
 * capacitor-voice-recorder into VOICE_DIR, then stop() turns it into the
 * MP3 Odoo's own recorder sends (mono, 128 kbit/s, `Voice-<date>-<n>.mp3`,
 * audio/mpeg) staged under the account's `out/<localUuid>/` for the
 * outbox, the AAC deleted.
 *
 * The recording stops by itself at VOICE_MAX_MS and calls onAutoStop, and
 * when the app goes to the background and calls onBackground; in both
 * cases the AAC is kept and the elapsed time frozen until stop() or
 * discard(). The microphone is only held while the app is in front.
 */
export class ChatVoiceRecorder {
    /** Called once the recording has stopped at VOICE_MAX_MS: the composer then calls stop() and sends. */
    onAutoStop: (() => void) | null = null;
    /** Called once the recording has stopped because the app left the foreground: stop() keeps it unsent. */
    onBackground: (() => void) | null = null;

    private readonly deps: VoiceDeps;
    private state: State = "idle";
    /** Bumped by every discard and reset: a step of an older recording sees it changed and stops there. */
    private epoch = 0;
    private startedAt = 0;
    private frozenMs: number | null = null;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private unfollow: (() => void) | null = null;
    /**
     * The native stop, shared by whoever stops first (tap, 60 s,
     * background): the AAC's path relative to Directory.Data, null when
     * the plugin names none.
     */
    private halting: Promise<string | null> | null = null;
    private finishing: Promise<OutgoingFile> | null = null;

    constructor(deps: Partial<VoiceDeps> = {}) {
        this.deps = {
            recorder: VoiceRecorder,
            files: deviceChatFiles,
            read: readDataFile,
            decode: decodeInWebView,
            encode: encodeInWorker,
            onAppActive: followAppState,
            ...deps,
        };
    }

    /**
     * Starts recording. The microphone permission is asked only while it
     * is not granted: "denied" when the user refuses. "unavailable" when
     * the phone cannot record, the microphone is busy, or discard() ran
     * meanwhile. A leftover recording in VOICE_DIR is deleted first.
     * Throws while another recording is under way.
     */
    async start(): Promise<VoiceStart> {
        if (this.state !== "idle") throw new Error("A voice recording is already under way.");
        this.state = "starting";
        const epoch = this.epoch;
        const { recorder, files } = this.deps;
        const gone = () => epoch !== this.epoch;
        try {
            if (!(await recorder.canDeviceVoiceRecord()).value) return this.giveUp(epoch, "unavailable");
            let granted = (await recorder.hasAudioRecordingPermission()).value;
            if (!granted && !gone()) granted = (await recorder.requestAudioRecordingPermission()).value;
            if (gone()) return "unavailable";
            if (!granted) return this.giveUp(epoch, "denied");
            await files.removeDir(VOICE_DIR).catch(() => {});
            if (gone()) return "unavailable";
            await recorder.startRecording({ directory: Directory.Data, subDirectory: VOICE_DIR });
        } catch {
            return this.giveUp(epoch, "unavailable");
        }
        if (gone()) {
            // Discarded while the native start ran: that recording is stopped and deleted
            await recorder.stopRecording()
                .then((r) => r.value.path && files.remove(r.value.path))
                .catch(() => {});
            return "unavailable";
        }
        this.state = "recording";
        this.startedAt = Date.now();
        this.timer = setTimeout(() => this.haltAndTell(() => this.onAutoStop), VOICE_MAX_MS);
        this.unfollow = this.deps.onAppActive((active) => {
            if (!active && this.state === "recording") this.haltAndTell(() => this.onBackground);
        });
        return "recording";
    }

    /** Time recorded, ms: frozen once the recording has stopped, 0 when there is none. */
    elapsedMs(): number {
        if (this.frozenMs !== null) return this.frozenMs;
        if (this.state !== "recording") return 0;
        return Math.min(Date.now() - this.startedAt, VOICE_MAX_MS);
    }

    /** Time left before the recording stops by itself, ms. */
    remainingMs(): number {
        return Math.max(0, VOICE_MAX_MS - this.elapsedMs());
    }

    /**
     * Stops the recording if it still runs and gives it as an MP3 staged
     * at `out/<localUuid>/<Voice-…>.mp3` of fileDir. Calls made while one
     * runs get the same file. Whatever the outcome the AAC is deleted and
     * the recorder is free again; on a failure nothing is left in out/.
     * Throws when there is no recording.
     */
    stop(fileDir: string): Promise<OutgoingFile> {
        if (this.finishing) return this.finishing;
        if (this.state !== "recording" && this.state !== "halted") {
            return Promise.reject(new Error("No voice recording to stop."));
        }
        // Halted first, so the elapsed time freezes at its value while recording
        const halting = this.halt();
        this.state = "finishing";
        this.finishing = this.finish(fileDir, halting);
        return this.finishing;
    }

    /**
     * Stops and deletes the recording: nothing is staged. A stop() already
     * converting is not undone, as its caller is sending it: discard()
     * waits for it and leaves its file to that caller.
     */
    async discard(): Promise<void> {
        if (this.finishing) {
            await this.finishing.catch(() => {});
            return;
        }
        if (this.state === "idle") return;
        if (this.state === "starting") {
            this.reset();
            return;
        }
        const halting = this.halt();
        this.reset();
        const aac = await halting.catch(() => null);
        if (aac) await this.deps.files.remove(aac).catch(() => {});
    }

    /** start()'s answer once it ends without recording, the recorder freed unless discard() already did. */
    private giveUp(epoch: number, answer: VoiceStart): VoiceStart {
        if (epoch === this.epoch) this.reset();
        return answer;
    }

    /** The native stop, once: the timer and the app-state listener end, the elapsed time freezes. */
    private halt(): Promise<string | null> {
        if (!this.halting) {
            this.frozenMs = this.elapsedMs();
            this.endWatch();
            if (this.state === "recording") this.state = "halted";
            this.halting = this.deps.recorder.stopRecording().then((r) => r.value.path ?? null);
        }
        return this.halting;
    }

    /** halt(), then the callback hook picks, unless stop() or discard() took over meanwhile. */
    private haltAndTell(hook: () => (() => void) | null): void {
        const epoch = this.epoch;
        const tell = () => {
            if (epoch === this.epoch && this.state === "halted") hook()?.();
        };
        this.halt().then(tell, tell);
    }

    private async finish(fileDir: string, halting: Promise<string | null>): Promise<OutgoingFile> {
        const { files } = this.deps;
        let aac: string | null = null;
        let staged: string | null = null;
        try {
            aac = await halting;
            if (!aac) throw new Error("The voice recording is empty.");
            const audio = await this.deps.decode(await this.deps.read(aac));
            const mp3 = await this.deps.encode(mixToMono(audio), audio.sampleRate);
            const localUuid = uuidv4();
            const name = voiceName(new Date());
            staged = outgoingPath(fileDir, localUuid, name);
            const size = await files.writeBlob(staged, new Blob([mp3 as BlobPart], { type: VOICE_MIMETYPE }));
            const file: OutgoingFile = { localUuid, path: staged, name, mimetype: VOICE_MIMETYPE, size, voice: true };
            staged = null;
            return file;
        } finally {
            if (staged) await files.removeDir(staged.slice(0, staged.lastIndexOf("/"))).catch(() => {});
            if (aac) await files.remove(aac).catch(() => {});
            this.reset();
        }
    }

    private endWatch(): void {
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = null;
        this.unfollow?.();
        this.unfollow = null;
    }

    /** Back to idle; any step of the recording before sees a new epoch. */
    private reset(): void {
        this.endWatch();
        this.epoch++;
        this.state = "idle";
        this.frozenMs = null;
        this.halting = null;
        this.finishing = null;
    }
}
