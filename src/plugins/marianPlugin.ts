import { registerPlugin } from "@capacitor/core";
import type { PluginListenerHandle } from "@capacitor/core";

/** "fr-en" = French → English, "en-fr" = English → French. */
export type MarianDirection = "fr-en" | "en-fr";

/**
 * Model variant: direction + size tier.
 *   tiny  — quantized (int8), fastest, smallest, lower quality (~82 MB)
 *   base  — full precision (float32), balanced                 (~182 MB)
 *   large — TC-Big quantized, best quality, slowest            (~300 MB)
 */
export type MarianModel =
    | "fr-en-tiny" | "fr-en-base" | "fr-en-large"
    | "en-fr-tiny" | "en-fr-base" | "en-fr-large";

export interface MarianModelInfo {
    model:       MarianModel;
    direction:   MarianDirection;
    /** Translation quality: 1 (low) – 5 (high). */
    quality:     number;
    /** Inference speed: 1 (slow) – 5 (fast). */
    speed:       number;
    /** Human-readable download size. */
    size:        string;
    /** Approximate download size in MB. */
    sizeMb:      number;
    /** True for the recommended default per direction. */
    recommended: boolean;
}

/** Static metadata for all available model variants. */
export const MARIAN_MODELS: MarianModelInfo[] = [
    // FR → EN
    { model: "fr-en-tiny",  direction: "fr-en", quality: 2, speed: 5, size: "~82 MB",  sizeMb: 82,  recommended: false },
    { model: "fr-en-base",  direction: "fr-en", quality: 3, speed: 3, size: "~182 MB", sizeMb: 182, recommended: true  },
    { model: "fr-en-large", direction: "fr-en", quality: 4, speed: 2, size: "~300 MB", sizeMb: 300, recommended: false },
    // EN → FR
    { model: "en-fr-tiny",  direction: "en-fr", quality: 2, speed: 5, size: "~82 MB",  sizeMb: 82,  recommended: false },
    { model: "en-fr-base",  direction: "en-fr", quality: 3, speed: 3, size: "~182 MB", sizeMb: 182, recommended: true  },
    { model: "en-fr-large", direction: "en-fr", quality: 4, speed: 2, size: "~300 MB", sizeMb: 300, recommended: false },
];

export interface MarianDownloadProgress {
    model:         MarianModel;
    file:          string;
    percent:       number;
    receivedBytes: number;
    totalBytes:    number;
}

interface MarianPlugin {
    /** Returns true when all 4 model files are present for the given variant. */
    isModelDownloaded(opts: { model: MarianModel }): Promise<{ exists: boolean }>;
    /** Download all model files for the given variant. Fires "downloadProgress" events. */
    downloadModel(opts: { model: MarianModel }): Promise<void>;
    /** Translate text using the on-device MarianMT model variant. */
    translate(opts: { text: string; model: MarianModel }): Promise<{ text: string }>;
    /** Delete all model files for the given variant. */
    deleteModel(opts: { model: MarianModel }): Promise<void>;
    /** Cancel any in-progress download. */
    cancelDownload(): Promise<void>;
    addListener(
        event: "downloadProgress",
        fn: (data: MarianDownloadProgress) => void
    ): Promise<PluginListenerHandle>;
}

export const MarianPlugin = registerPlugin<MarianPlugin>("MarianPlugin");
