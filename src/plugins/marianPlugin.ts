import { registerPlugin } from "@capacitor/core";
import type { PluginListenerHandle } from "@capacitor/core";

/** "fr-en" = French → English, "en-fr" = English → French. */
export type MarianDirection = "fr-en" | "en-fr";

export interface MarianDownloadProgress {
    direction:     MarianDirection;
    file:          string;
    percent:       number;
    receivedBytes: number;
    totalBytes:    number;
}

interface MarianPlugin {
    /** Returns true when all 4 model files (encoder, decoder, source.spm, target.spm) are present. */
    isModelDownloaded(opts: { direction: MarianDirection }): Promise<{ exists: boolean }>;
    /** Download all model files for the given direction. Fires "downloadProgress" events. */
    downloadModel(opts: { direction: MarianDirection }): Promise<void>;
    /** Translate text using the on-device MarianMT model. */
    translate(opts: { text: string; direction: MarianDirection }): Promise<{ text: string }>;
    /** Delete all model files for the given direction. */
    deleteModel(opts: { direction: MarianDirection }): Promise<void>;
    /** Cancel any in-progress download. */
    cancelDownload(): Promise<void>;
    addListener(
        event: "downloadProgress",
        fn: (data: MarianDownloadProgress) => void
    ): Promise<PluginListenerHandle>;
}

export const MarianPlugin = registerPlugin<MarianPlugin>("MarianPlugin");
