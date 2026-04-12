import { Capacitor } from "@capacitor/core";
import type { PluginListenerHandle } from "@capacitor/core";
import { DatabaseService } from "./databaseService";
import { WhisperPlugin, WhisperModel } from "../plugins/whisperPlugin";
import type { ProcessService } from "./processService";

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
};

export const MODEL_SIZES: Record<WhisperModel, string> = {
    tiny:              "~75 Mo",
    base:              "~142 Mo",
    small:             "~244 Mo",
    medium:            "~769 Mo",
    "large-v3-turbo":  "~874 Mo",
};

export const MODEL_LABELS: Record<WhisperModel, string> = {
    tiny:              "Tiny (~75 Mo) — très rapide",
    base:              "Base (~142 Mo) — recommandé",
    small:             "Small (~244 Mo) — précis",
    medium:            "Medium (~769 Mo) — très précis",
    "large-v3-turbo":  "Large-v3-turbo (~874 Mo) — meilleur",
};

// ---------------------------------------------------------------------------
// TranscriptionService
// ---------------------------------------------------------------------------

export interface DownloadProgress {
    model: WhisperModel;
    percent: number;
}

export class TranscriptionService {
    private db: DatabaseService;
    private _processService: ProcessService | null;

    /** Non-null while a download is running — survives component remounts. */
    private _activeDownload: DownloadProgress | null = null;
    private _progressSubs = new Set<(info: DownloadProgress | null) => void>();

    /** Audio paths currently being transcribed. */
    private _activeTranscriptions = new Set<string>();
    /** Current transcription progress (0–100) per audio path. */
    private _transcriptionProgress = new Map<string, number>();
    private _transcriptionSubs = new Map<string, Set<() => void>>();
    private _transcriptionProgressSubs = new Map<string, Set<(percent: number) => void>>();

    constructor(db: DatabaseService, processService?: ProcessService) {
        this.db = db;
        this._processService = processService ?? null;
    }

    /** Current download progress, or null if idle. */
    get activeDownload(): DownloadProgress | null {
        return this._activeDownload;
    }

    /**
     * Subscribe to download progress updates.
     * The callback receives the current progress, or null when the download
     * finishes (success or error). Returns an unsubscribe function.
     */
    subscribeProgress(cb: (info: DownloadProgress | null) => void): () => void {
        this._progressSubs.add(cb);
        return () => this._progressSubs.delete(cb);
    }

    private _notifyProgress(info: DownloadProgress | null) {
        this._progressSubs.forEach(cb => cb(info));
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
        const valid: WhisperModel[] = ["tiny", "base", "small", "medium", "large-v3-turbo"];
        return valid.includes(val as WhisperModel) ? (val as WhisperModel) : "tiny";
    }

    async setSelectedModel(model: WhisperModel): Promise<void> {
        await this.db.setUserGraphicPref("whisper_model", model);
    }

    // ── Model management ─────────────────────────────────────────────────────

    async isModelDownloaded(model: WhisperModel): Promise<boolean> {
        // A download in progress creates the file immediately (FileOutputStream),
        // so file.exists() returns true even for an incomplete binary.
        // Treat an actively downloading model as not yet available.
        if (this._activeDownload?.model === model) return false;
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
    async downloadModel(model: WhisperModel): Promise<void> {
        const url = MODEL_URLS[model];
        this._activeDownload = { model, percent: 0 };
        this._notifyProgress(this._activeDownload);

        const processId = this._processService?.addDownload(model, url);

        let listener: PluginListenerHandle | null = null;
        try {
            listener = await WhisperPlugin.addListener("downloadProgress", (data) => {
                const percent = Math.round(data.ratio * 100);
                this._activeDownload = { model, percent };
                this._notifyProgress(this._activeDownload);
                if (processId) this._processService?.updateProgress(processId, percent);
            });
            await WhisperPlugin.downloadModel({ model, url });
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
            this._activeDownload = null;
            this._notifyProgress(null);
        }
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
     * @param rawPath    Original path before any JS normalisation — logged in
     *                   the debug panel, has no effect on behaviour.
     */
    async transcribe(
        audioPath: string,
        lang = "fr",
        noteId?: string,
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
