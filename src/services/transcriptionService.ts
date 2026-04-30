import { Capacitor } from "@capacitor/core";
import type { PluginListenerHandle } from "@capacitor/core";
import { DatabaseService } from "./databaseService";
import { WhisperPlugin, WhisperModel } from "../plugins/whisperPlugin";
import type { ProcessService } from "./processService";
import { Events } from "../constants/events";

interface EventBusLike {
    trigger(name: string, payload: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// Model metadata
// ---------------------------------------------------------------------------

const HF = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

const MODEL_URLS: Record<WhisperModel, string> = {
    tiny:              `${HF}/ggml-tiny.bin`,
    base:              `${HF}/ggml-base.bin`,
    small:             `${HF}/ggml-small.bin`,
    medium:            `${HF}/ggml-medium.bin`,
    "large-v3-turbo":  `${HF}/ggml-large-v3-turbo.bin`,
    "distil-large-v3": `${HF}/ggml-distil-large-v3.bin`,
};

export const MODEL_SIZES: Record<WhisperModel, string> = {
    tiny:              "~75 Mo",
    base:              "~142 Mo",
    small:             "~244 Mo",
    medium:            "~769 Mo",
    "large-v3-turbo":  "~874 Mo",
    "distil-large-v3": "~756 Mo",
};

export const MODEL_LABELS: Record<WhisperModel, string> = {
    tiny:              "Tiny (~75 Mo) — très rapide",
    base:              "Base (~142 Mo) — recommandé",
    small:             "Small (~244 Mo) — précis",
    medium:            "Medium (~769 Mo) — très précis",
    "large-v3-turbo":  "Large-v3-turbo (~874 Mo) — meilleur",
    "distil-large-v3": "Distil-large-v3 (~756 Mo) — anglais uniquement",
};

// ---------------------------------------------------------------------------
// TranscriptionService
// ---------------------------------------------------------------------------

export interface DownloadProgress {
    model:            WhisperModel;
    percent:          number;
    mode:             "wakelock" | "foreground";
    receivedBytes:    number;
    totalBytes:       number;
    speedBytesPerSec: number;
}

export class TranscriptionService {
    private db: DatabaseService;
    private _processService: ProcessService | null;
    private _eventBus: EventBusLike | null;

    /** Per-model download progress — survives component remounts. */
    private _activeDownloads = new Map<WhisperModel, DownloadProgress>();
    private _progressSubs = new Set<(info: DownloadProgress | null, model?: WhisperModel) => void>();

    /** Audio paths currently being transcribed. */
    private _activeTranscriptions = new Set<string>();
    /** Current transcription progress (0–100) per audio path. */
    private _transcriptionProgress = new Map<string, number>();
    private _transcriptionSubs = new Map<string, Set<() => void>>();
    private _transcriptionProgressSubs = new Map<string, Set<(percent: number) => void>>();

    constructor(
        db: DatabaseService,
        processService?: ProcessService,
        eventBus?: EventBusLike,
    ) {
        this.db = db;
        this._processService = processService ?? null;
        this._eventBus = eventBus ?? null;
    }

    /** All currently active downloads (read-only). */
    get activeDownloads(): ReadonlyMap<WhisperModel, DownloadProgress> {
        return this._activeDownloads;
    }

    /**
     * Current download progress (first active download), or null if idle.
     * Kept for backward compatibility with reconnect logic.
     */
    get activeDownload(): DownloadProgress | null {
        const first = this._activeDownloads.values().next();
        return first.done ? null : first.value;
    }

    /**
     * Subscribe to download progress updates.
     * The callback receives the current progress (or null on finish) and the
     * model key. Returns an unsubscribe function.
     */
    subscribeProgress(cb: (info: DownloadProgress | null, model?: WhisperModel) => void): () => void {
        this._progressSubs.add(cb);
        return () => this._progressSubs.delete(cb);
    }

    private _notifyProgress(info: DownloadProgress | null, model?: WhisperModel) {
        this._progressSubs.forEach(cb => cb(info, model));
    }

    // ── Transcription state (for reconnection across navigation) ─────────────

    /** True while the given audio file is being transcribed. */
    isTranscribing(audioPath: string): boolean {
        return this._activeTranscriptions.has(audioPath);
    }

    /**
     * Subscribe to be notified when transcription of `audioPath` completes
     * (success or error). The callback fires once then is removed automatically.
     * Returns an unsubscribe function to cancel early (e.g. onWillDestroy).
     */
    subscribeTranscription(audioPath: string, cb: () => void): () => void {
        if (!this._transcriptionSubs.has(audioPath)) {
            this._transcriptionSubs.set(audioPath, new Set());
        }
        this._transcriptionSubs.get(audioPath)!.add(cb);
        return () => {
            this._transcriptionSubs.get(audioPath)?.delete(cb);
        };
    }

    /** Current transcription progress for `audioPath` (0 if not running). */
    getTranscriptionProgress(audioPath: string): number {
        return this._transcriptionProgress.get(audioPath) ?? 0;
    }

    /**
     * Subscribe to transcription progress updates for a specific audio path.
     * Callback receives percent (0–100). Returns an unsubscribe function.
     */
    subscribeTranscriptionProgress(
        audioPath: string,
        cb: (percent: number) => void
    ): () => void {
        if (!this._transcriptionProgressSubs.has(audioPath)) {
            this._transcriptionProgressSubs.set(audioPath, new Set());
        }
        this._transcriptionProgressSubs.get(audioPath)!.add(cb);
        return () => {
            this._transcriptionProgressSubs.get(audioPath)?.delete(cb);
        };
    }

    private _notifyTranscriptionProgress(audioPath: string, percent: number): void {
        this._transcriptionProgressSubs.get(audioPath)?.forEach(cb => cb(percent));
    }

    private _notifyTranscriptionDone(audioPath: string): void {
        const subs = this._transcriptionSubs.get(audioPath);
        if (subs) {
            subs.forEach(cb => cb());
            subs.clear();
        }
        this._transcriptionSubs.delete(audioPath);
    }

    // ── Settings ─────────────────────────────────────────────────────────────

    async isEnabled(): Promise<boolean> {
        const val = await this.db.getUserGraphicPref("whisper_enabled");
        return val === "true";
    }

    async setEnabled(enabled: boolean): Promise<void> {
        await this.db.setUserGraphicPref("whisper_enabled", enabled ? "true" : "false");
    }

    async getSelectedModel(): Promise<WhisperModel> {
        const val = await this.db.getUserGraphicPref("whisper_model");
        const valid: WhisperModel[] = ["tiny", "base", "small", "medium", "large-v3-turbo", "distil-large-v3"];
        return valid.includes(val as WhisperModel) ? (val as WhisperModel) : "tiny";
    }

    async setSelectedModel(model: WhisperModel): Promise<void> {
        await this.db.setUserGraphicPref("whisper_model", model);
    }

    async getDownloadMode(): Promise<"wakelock" | "foreground"> {
        const val = await this.db.getUserGraphicPref("whisper_download_mode");
        return val === "foreground" ? "foreground" : "wakelock";
    }

    async setDownloadMode(mode: "wakelock" | "foreground"): Promise<void> {
        await this.db.setUserGraphicPref("whisper_download_mode", mode);
    }

    // ── Model management ─────────────────────────────────────────────────────

    async isModelDownloaded(model: WhisperModel): Promise<boolean> {
        // A download in progress creates the file immediately (FileOutputStream),
        // so file.exists() returns true even for an incomplete binary.
        // Treat an actively downloading model as not yet available.
        if (this._activeDownloads.has(model)) return false;
        if (!Capacitor.isNativePlatform()) return false;
        try {
            const { exists } = await WhisperPlugin.getModelPath({ model });
            return exists;
        } catch {
            return false;
        }
    }

    /**
     * Download the GGML model binary from HuggingFace.
     *
     * Uses a native Java HttpURLConnection to stream the file directly to
     * disk in 64 KB chunks — avoids the base64 / in-memory overhead that
     * caused OOM and file corruption when done in the WebView JS engine.
     *
     * Progress is tracked on the service itself (`activeDownload`) so that
     * components that remount mid-download can reconnect via `subscribeProgress`.
     */
    async downloadModel(
        model: WhisperModel,
        mode: "wakelock" | "foreground" = "wakelock"
    ): Promise<void> {
        if (this._activeDownloads.has(model)) return; // already downloading this model
        // If foreground mode is requested but another foreground download is already
        // running, fall back to wakelock (Android supports only one foreground
        // service at a time; wakelock downloads run in parallel without limit).
        const hasForeground = [...this._activeDownloads.values()].some(d => d.mode === "foreground");
        const effectiveMode: "wakelock" | "foreground" = (mode === "foreground" && hasForeground) ? "wakelock" : mode;
        const url = MODEL_URLS[model];
        const initial: DownloadProgress = { model, percent: 0, mode: effectiveMode, receivedBytes: 0, totalBytes: 0, speedBytesPerSec: 0 };
        this._activeDownloads.set(model, initial);
        this._notifyProgress(initial, model);

        const processId = this._processService?.addDownload(model, url, effectiveMode);

        let listener: PluginListenerHandle | null = null;
        let lastReceived = 0;
        let lastTime = Date.now();

        try {
            listener = await WhisperPlugin.addListener("downloadProgress", (data) => {
                if (data.model !== model) return; // ignore other models' events
                const now = Date.now();
                const dt = (now - lastTime) / 1000;
                const prevSpeed = this._activeDownloads.get(model)?.speedBytesPerSec ?? 0;
                const speed = dt > 0.1 ? (data.received - lastReceived) / dt : prevSpeed;
                lastReceived = data.received;
                lastTime = now;
                const percent = Math.round(data.ratio * 100);
                const progress: DownloadProgress = {
                    model, percent, mode: effectiveMode,
                    receivedBytes: data.received,
                    totalBytes: data.total,
                    speedBytesPerSec: Math.max(0, speed),
                };
                this._activeDownloads.set(model, progress);
                this._notifyProgress(progress, model);
                if (processId) this._processService?.updateProgress(processId, percent);
            });
            if (effectiveMode === "foreground") {
                await WhisperPlugin.downloadModelForeground({ model, url });
            } else {
                await WhisperPlugin.downloadModel({ model, url });
            }
            if (processId) await this._processService?.completeProcess(processId);
        } catch (e) {
            if (processId) {
                await this._processService?.completeProcess(
                    processId,
                    e instanceof Error ? e.message : String(e)
                );
            }
            throw e;
        } finally {
            if (listener) await listener.remove();
            this._activeDownloads.delete(model);
            this._notifyProgress(null, model);
        }
    }

    /**
     * Reconnect to a foreground service download that is still running but
     * whose JS state was lost (e.g. after Activity recreation).
     *
     * If the service reports an active download and _activeDownload is null,
     * this starts a fire-and-forget downloadModel() call that re-attaches to
     * the running service thread (Java side detects the re-attach and does NOT
     * start a second thread).
     *
     * Returns true if a reconnection was initiated.
     */
    async maybeReconnectForeground(): Promise<boolean> {
        if (!Capacitor.isNativePlatform()) return false;
        if (this._activeDownloads.size > 0) return true;
        try {
            const { downloading, model } = await WhisperPlugin.getServiceStatus();
            if (!downloading || !model || !(model in MODEL_URLS)) return false;
            // Fire-and-forget: downloadModel sets _activeDownload synchronously
            // before its first await, so subscribers are notified immediately.
            this.downloadModel(model as WhisperModel, "foreground").catch(() => {
                // Ignore — cancelled/error clears _activeDownload via finally
            });
            return true;
        } catch {
            return false;
        }
    }

    /** Cancel a specific download (or all downloads if no model given). */
    async cancelDownload(model?: WhisperModel): Promise<void> {
        if (!Capacitor.isNativePlatform()) return;
        try {
            await WhisperPlugin.cancelDownload(model ? { model } : undefined);
        } catch { /* ignore */ }
    }

    async deleteModel(model: WhisperModel): Promise<void> {
        await WhisperPlugin.deleteModel({ model });
    }

    // ── Transcription ─────────────────────────────────────────────────────────

    /**
     * Transcribe an audio or video file.
     *
     * @param audioPath  Native absolute path, or path relative to Directory.Data
     *                   for audio recordings produced by VoiceRecorder.
     * @param lang       BCP-47 language code (default "fr")
     * @param noteId     ID of the note that owns this entry (for navigation)
     * @param entryId    ID of the audio entry inside the note. When set together
     *                   with the eventBus injected at construction, the service
     *                   fires SET_ENTRY_TRANSCRIPTION on success — survives the
     *                   audio component being unmounted (user navigated away).
     * @param rawPath    Original path before any JS normalisation — logged in
     *                   the debug panel, has no effect on behaviour.
     */
    async transcribe(
        audioPath: string,
        lang = "fr",
        noteId?: string,
        entryId?: string,
        rawPath?: string,
    ): Promise<string> {
        if (!Capacitor.isNativePlatform()) {
            throw new Error("La transcription n'est disponible que sur Android.");
        }

        this._activeTranscriptions.add(audioPath);
        this._transcriptionProgress.set(audioPath, 0);
        const label = audioPath.split("/").pop() ?? audioPath;
        const processId = this._processService?.addTranscription(label, noteId);

        const dbg = (msg: string) => {
            if (processId) this._processService?.appendDebugLog(processId, msg);
        };

        dbg(`Chemin JS reçu    : ${rawPath ?? audioPath}`);
        dbg(`Chemin natif      : ${audioPath}`);
        dbg(`Langue            : ${lang}`);

        let progressListener: PluginListenerHandle | null = null;
        try {
            // Listen for Whisper segment-by-segment progress (ratio 0→1).
            progressListener = await WhisperPlugin.addListener("progress", (data) => {
                const percent = Math.round(data.ratio * 100);
                this._transcriptionProgress.set(audioPath, percent);
                this._notifyTranscriptionProgress(audioPath, percent);
                if (processId) this._processService?.updateProgress(processId, percent);
                dbg(`[Java] ${String(percent).padStart(3)}%  ${data.text}`);
            });

            const model = await this.getSelectedModel();
            dbg(`Modèle sélectionné: ${model}`);

            const { loaded } = await WhisperPlugin.isModelLoaded();
            dbg(`Modèle en mémoire : ${loaded ? "oui" : "non"}`);

            if (!loaded) {
                dbg("Chargement du modèle…");
                await WhisperPlugin.loadModel({ model });
                dbg("Modèle chargé");
            }

            dbg("Appel WhisperPlugin.transcribe()…");
            const { text } = await WhisperPlugin.transcribe({ audioPath, lang });
            const preview = text.trim().slice(0, 80);
            dbg(`Résultat (${text.trim().length} car.) : ${preview}${text.trim().length > 80 ? "…" : ""}`);

            if (processId) await this._processService?.completeProcess(processId, undefined, text);

            // Fire-and-forget completion event — survives the audio
            // component being unmounted (user navigated to another
            // route while transcription was in flight). A boot-time
            // listener on noteService writes the text back to the
            // entry so the user sees it on next visit.
            if (this._eventBus && entryId) {
                this._eventBus.trigger(Events.SET_ENTRY_TRANSCRIPTION, {
                    entryId, text, noteId, audioPath,
                });
            }

            return text;
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            dbg(`ERREUR : ${msg}`);
            if (processId) {
                await this._processService?.completeProcess(processId, msg);
            }
            throw e;
        } finally {
            if (progressListener) await progressListener.remove();
            this._transcriptionProgress.delete(audioPath);
            this._transcriptionProgressSubs.delete(audioPath);
            this._activeTranscriptions.delete(audioPath);
            this._notifyTranscriptionDone(audioPath);
        }
    }

}
