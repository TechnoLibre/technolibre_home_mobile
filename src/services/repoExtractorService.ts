import { Filesystem, Directory } from "@capacitor/filesystem";
import { gunzipStream } from "../utils/decompressGzip";
import { parseTarStream, TarEntry } from "../utils/tarParser";

export class BundleNotShippedError extends Error {
    constructor(slug: string, status?: number) {
        super(`Bundle archive missing for ${slug}` + (status ? ` (HTTP ${status})` : ""));
    }
}

export class BundleCorruptError extends Error {
    constructor(slug: string, cause: unknown) {
        super(`Bundle archive corrupt for ${slug}: ${cause}`);
    }
}

export interface ExtractProgress {
    slug: string;
    written: number;
    total?: number;
    currentPath: string;
}

type ExtractListener = (p: ExtractProgress) => void;

/**
 * Extracts repo archives shipped under public assets into the device's
 * Capacitor Cache directory on first use. Subsequent calls for the same
 * slug short-circuit on a `.extracted` sentinel file.
 *
 * Cache layout:
 *   Cache/repos/{slug}/.extracted
 *   Cache/repos/{slug}/index.json
 *   Cache/repos/{slug}/<original tree>
 */
export class RepoExtractorService {
    private inflight = new Map<string, Promise<string>>();
    private listeners = new Set<ExtractListener>();

    onProgress(fn: ExtractListener): () => void {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    async ensureExtracted(slug: string, archiveUrl: string): Promise<string> {
        const cached = this.inflight.get(slug);
        if (cached) return cached;
        const p = this._doExtract(slug, archiveUrl).finally(() => {
            this.inflight.delete(slug);
        });
        this.inflight.set(slug, p);
        return p;
    }

    private async _doExtract(slug: string, archiveUrl: string): Promise<string> {
        const baseRel = `repos/${slug}`;
        const sentinelRel = `${baseRel}/.extracted`;

        // Sentinel hit — already extracted.
        try {
            await Filesystem.stat({ path: sentinelRel, directory: Directory.Cache });
            return baseRel;
        } catch {
            // not extracted yet, fall through
        }

        // Fetch archive.
        const res = await fetch(archiveUrl);
        if (!res.ok || !res.body) {
            throw new BundleNotShippedError(slug, res.status);
        }

        try {
            await Filesystem.mkdir({
                path: baseRel,
                directory: Directory.Cache,
                recursive: true,
            });
        } catch {
            // already exists or parent issue — proceed anyway
        }

        const ungz = gunzipStream(res.body);
        let written = 0;
        try {
            for await (const entry of parseTarStream(ungz)) {
                await this._writeEntry(slug, baseRel, entry);
                written++;
                this._emitProgress({ slug, written, currentPath: entry.name });
            }
        } catch (e) {
            throw new BundleCorruptError(slug, e);
        }

        // Sentinel.
        await Filesystem.writeFile({
            path: sentinelRel,
            directory: Directory.Cache,
            data: btoa(`extracted_at=${Date.now()}`),
        });

        return baseRel;
    }

    private async _writeEntry(_slug: string, baseRel: string, entry: TarEntry): Promise<void> {
        const fullPath = `${baseRel}/${entry.name}`;
        if (entry.isDirectory) {
            try {
                await Filesystem.mkdir({
                    path: fullPath,
                    directory: Directory.Cache,
                    recursive: true,
                });
            } catch {
                /* ignore */
            }
            return;
        }
        if (!entry.isFile || !entry.content) return;

        // Ensure parent dir exists.
        const lastSlash = fullPath.lastIndexOf("/");
        if (lastSlash > 0) {
            try {
                await Filesystem.mkdir({
                    path: fullPath.slice(0, lastSlash),
                    directory: Directory.Cache,
                    recursive: true,
                });
            } catch {
                /* ignore */
            }
        }

        await Filesystem.writeFile({
            path: fullPath,
            directory: Directory.Cache,
            data: bytesToBase64(entry.content),
        });
    }

    private _emitProgress(p: ExtractProgress): void {
        for (const fn of this.listeners) {
            try { fn(p); } catch { /* listener errors don't break extraction */ }
        }
    }

    /** Re-extract from scratch — use after deciding the cached copy is bad. */
    async forceReextract(slug: string, archiveUrl: string): Promise<string> {
        const baseRel = `repos/${slug}`;
        try {
            await Filesystem.rmdir({
                path: baseRel,
                directory: Directory.Cache,
                recursive: true,
            });
        } catch { /* maybe didn't exist */ }
        return this.ensureExtracted(slug, archiveUrl);
    }
}

function bytesToBase64(bytes: Uint8Array): string {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
}
