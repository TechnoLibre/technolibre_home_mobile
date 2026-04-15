import { Capacitor } from "@capacitor/core";
import type { PluginListenerHandle } from "@capacitor/core";
import { MarianPlugin } from "../plugins/marianPlugin";
import type { MarianDirection, MarianDownloadProgress } from "../plugins/marianPlugin";

export type { MarianDirection, MarianDownloadProgress };

export interface MarianModelState {
    direction:     MarianDirection;
    percent:       number;
    receivedBytes: number;
    totalBytes:    number;
    file:          string;
}

export class MarianService {
    /** Currently active downloads keyed by direction. */
    private _activeDownloads = new Map<MarianDirection, MarianModelState>();
    private _progressSubs    = new Set<(state: MarianModelState | null, direction?: MarianDirection) => void>();

    get activeDownloads(): ReadonlyMap<MarianDirection, MarianModelState> {
        return this._activeDownloads;
    }

    subscribeProgress(
        cb: (state: MarianModelState | null, direction?: MarianDirection) => void
    ): () => void {
        this._progressSubs.add(cb);
        return () => this._progressSubs.delete(cb);
    }

    private _notify(state: MarianModelState | null, direction?: MarianDirection) {
        this._progressSubs.forEach(cb => cb(state, direction));
    }

    async isModelDownloaded(direction: MarianDirection): Promise<boolean> {
        if (!Capacitor.isNativePlatform()) return false;
        try {
            const { exists } = await MarianPlugin.isModelDownloaded({ direction });
            return exists;
        } catch {
            return false;
        }
    }

    async downloadModel(direction: MarianDirection): Promise<void> {
        if (this._activeDownloads.has(direction)) return;
        const initial: MarianModelState = {
            direction, percent: 0, receivedBytes: 0, totalBytes: 0, file: "",
        };
        this._activeDownloads.set(direction, initial);
        this._notify(initial, direction);

        let listener: PluginListenerHandle | null = null;
        try {
            listener = await MarianPlugin.addListener("downloadProgress", (data) => {
                if (data.direction !== direction) return;
                const state: MarianModelState = { ...data };
                this._activeDownloads.set(direction, state);
                this._notify(state, direction);
            });
            await MarianPlugin.downloadModel({ direction });
        } finally {
            if (listener) await listener.remove();
            this._activeDownloads.delete(direction);
            this._notify(null, direction);
        }
    }

    async deleteModel(direction: MarianDirection): Promise<void> {
        if (!Capacitor.isNativePlatform()) return;
        await MarianPlugin.deleteModel({ direction });
    }

    async cancelDownload(): Promise<void> {
        if (!Capacitor.isNativePlatform()) return;
        try { await MarianPlugin.cancelDownload(); } catch { /* ignore */ }
    }

    async translate(text: string, direction: MarianDirection): Promise<string> {
        const { text: translated } = await MarianPlugin.translate({ text, direction });
        return translated;
    }
}
