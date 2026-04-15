import { Capacitor } from "@capacitor/core";
import type { PluginListenerHandle } from "@capacitor/core";
import { MarianPlugin } from "../plugins/marianPlugin";
import type { MarianModel, MarianDownloadProgress } from "../plugins/marianPlugin";

export type { MarianModel, MarianDownloadProgress };

export interface MarianModelState {
    model:         MarianModel;
    percent:       number;
    receivedBytes: number;
    totalBytes:    number;
    file:          string;
}

export class MarianService {
    /** Currently active downloads keyed by model variant. */
    private _activeDownloads = new Map<MarianModel, MarianModelState>();
    private _progressSubs    = new Set<(state: MarianModelState | null, model?: MarianModel) => void>();

    get activeDownloads(): ReadonlyMap<MarianModel, MarianModelState> {
        return this._activeDownloads;
    }

    subscribeProgress(
        cb: (state: MarianModelState | null, model?: MarianModel) => void
    ): () => void {
        this._progressSubs.add(cb);
        return () => this._progressSubs.delete(cb);
    }

    private _notify(state: MarianModelState | null, model?: MarianModel) {
        this._progressSubs.forEach(cb => cb(state, model));
    }

    async isModelDownloaded(model: MarianModel): Promise<boolean> {
        if (!Capacitor.isNativePlatform()) return false;
        try {
            const { exists } = await MarianPlugin.isModelDownloaded({ model });
            return exists;
        } catch {
            return false;
        }
    }

    async downloadModel(model: MarianModel): Promise<void> {
        if (this._activeDownloads.has(model)) return;
        const initial: MarianModelState = {
            model, percent: 0, receivedBytes: 0, totalBytes: 0, file: "",
        };
        this._activeDownloads.set(model, initial);
        this._notify(initial, model);

        let listener: PluginListenerHandle | null = null;
        try {
            listener = await MarianPlugin.addListener("downloadProgress", (data) => {
                if (data.model !== model) return;
                const state: MarianModelState = { ...data };
                this._activeDownloads.set(model, state);
                this._notify(state, model);
            });
            await MarianPlugin.downloadModel({ model });
        } finally {
            if (listener) await listener.remove();
            this._activeDownloads.delete(model);
            this._notify(null, model);
        }
    }

    async deleteModel(model: MarianModel): Promise<void> {
        if (!Capacitor.isNativePlatform()) return;
        await MarianPlugin.deleteModel({ model });
    }

    async cancelDownload(): Promise<void> {
        if (!Capacitor.isNativePlatform()) return;
        try { await MarianPlugin.cancelDownload(); } catch { /* ignore */ }
    }

    async translate(text: string, model: MarianModel): Promise<string> {
        const { text: translated } = await MarianPlugin.translate({ text, model });
        return translated;
    }
}
