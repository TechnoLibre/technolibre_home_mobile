import { registerPlugin } from "@capacitor/core";
import type { PluginListenerHandle } from "@capacitor/core";

export type WhisperModel = "tiny" | "base" | "small" | "medium" | "large-v3-turbo";

export interface WhisperProgressEvent {
    ratio: number;
    text: string;
}

export interface WhisperDownloadProgressEvent {
    ratio: number;
    received: number;
    total: number;
}

interface WhisperPlugin {
    isModelLoaded(): Promise<{ loaded: boolean }>;
    loadModel(opts: { model: WhisperModel }): Promise<void>;
    getModelPath(opts: { model: WhisperModel }): Promise<{ path: string; exists: boolean }>;
    /** Download a model file natively (streaming, no base64 overhead). */
    downloadModel(opts: { model: WhisperModel; url: string }): Promise<{ path: string }>;
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
