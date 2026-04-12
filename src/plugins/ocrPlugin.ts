import { registerPlugin } from "@capacitor/core";
import type { PluginListenerHandle } from "@capacitor/core";

export interface TextBlock {
    /** The detected text content. */
    text: string;
    /** Normalised left edge (0–1 of screen width). */
    x: number;
    /** Normalised top edge (0–1 of screen height). */
    y: number;
    /** Normalised width (0–1 of screen width). */
    width: number;
    /** Normalised height (0–1 of screen height). */
    height: number;
}

export interface TextDetectedEvent {
    blocks: TextBlock[];
}

interface OcrPlugin {
    /**
     * Start periodic OCR scanning.
     * Fires "textDetected" events at the given interval.
     */
    startScan(opts?: { intervalMs?: number }): Promise<void>;
    /** Stop scanning. */
    stopScan(): Promise<void>;
    addListener(
        event: "textDetected",
        fn: (data: TextDetectedEvent) => void
    ): Promise<PluginListenerHandle>;
}

export const OcrPlugin = registerPlugin<OcrPlugin>("OcrPlugin");
