import { registerPlugin } from "@capacitor/core";
import type { PluginListenerHandle } from "@capacitor/core";

export type WhisperModel = "tiny" | "base" | "small" | "medium" | "large-v3-turbo" | "distil-large-v3";

export interface WhisperProgressEvent {
    ratio: number;
    text: string;
}

export interface WhisperDownloadProgressEvent {
    model: string;
    ratio: number;
    received: number;
    total: number;
}

interface WhisperPlugin {
    isModelLoaded(): Promise<{ loaded: boolean }>;
    loadModel(opts: { model: WhisperModel }): Promise<void>;
    getModelPath(opts: { model: WhisperModel }): Promise<{ path: string; exists: boolean }>;
    /**
     * Download a model using WakeLock + HTTP Range resume.
     * The CPU/network stay active while the screen is off.
     * If interrupted, the .partial file is kept so the next call resumes.
     */
    downloadModel(opts: { model: WhisperModel; url: string }): Promise<{ path: string }>;
    /**
     * Download a model using an Android Foreground Service with a persistent
     * notification (including an "Annuler" button). Resolves when complete.
     * Recommended for files ≥ 1 GB.
     */
    downloadModelForeground(opts: { model: WhisperModel; url: string }): Promise<{ path: string }>;
    /**
     * Returns the foreground download service status.
     * Used to reconnect the JS layer to a running service after Activity
     * recreation (when _activeDownload was reset to null).
     */
    getServiceStatus(): Promise<{ downloading: boolean; model: string }>;
    /**
     * Cancel any in-progress download (WakeLock or Foreground Service).
     * The .partial file is kept so the next attempt can resume via Range.
     * If model is provided, only that model's download is cancelled.
     */
    cancelDownload(opts?: { model?: WhisperModel }): Promise<void>;
    transcribe(opts: { audioPath: string; lang?: string }): Promise<{ text: string }>;
    unloadModel(): Promise<void>;
    /** Delete the model file from disk, unloading it from memory first if needed. */
    deleteModel(opts: { model: WhisperModel }): Promise<void>;
    addListener(
        event: "progress",
        fn: (data: WhisperProgressEvent) => void
    ): Promise<PluginListenerHandle>;
    addListener(
        event: "downloadProgress",
        fn: (data: WhisperDownloadProgressEvent) => void
    ): Promise<PluginListenerHandle>;
}

export const WhisperPlugin = registerPlugin<WhisperPlugin>("WhisperPlugin");
