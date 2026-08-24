import { Filesystem, Directory, Encoding } from "@capacitor/filesystem";
import { BundleEntry } from "../models/manifestProject";
import { DirEntry } from "./codeService";
import { RepoExtractorService } from "./repoExtractorService";

/**
 * Read-only code reader that uses the source bundle embedded at build time.
 *
 * Two backends:
 *   - "/repo" continues to be served as loose files via fetch (the app's own
 *     source — small, loaded lazily from public assets).
 *   - "/repos/{slug}" is now backed by a tar.gz extracted into Cache by
 *     RepoExtractorService on first access.
 */
export class BundleCodeService {
    private _index: BundleEntry[] = [];
    private _loaded = false;

    /** Resolved Cache-relative base path once initialize() has run for archive mode. */
    private _cacheBase: string | null = null;

    constructor(
        private readonly _baseUrl: string = "/repo",
        private readonly _archiveSpec?: { archiveUrl: string; indexUrl: string; slug: string },
        private readonly _extractor?: RepoExtractorService,
    ) {}

    async initialize(): Promise<void> {
        if (this._archiveSpec && this._extractor) {
            // Archive mode (manifest repo)
            // 1. Pre-fetch the sidecar index.json so we can list dirs without unpacking.
            const idxRes = await fetch(this._archiveSpec.indexUrl);
            if (!idxRes.ok) {
                throw new Error(
                    `Manifest index introuvable: ${this._archiveSpec.indexUrl}. Recompilez l'app.`,
                );
            }
            this._index = await idxRes.json();
            // 2. Trigger extraction (or short-circuit on sentinel).
            this._cacheBase = await this._extractor.ensureExtracted(
                this._archiveSpec.slug,
                this._archiveSpec.archiveUrl,
            );
        } else {
            // Loose-files mode (app's own source)
            const res = await fetch(`${this._baseUrl}/index.json`);
            if (!res.ok) {
                throw new Error(
                    "Bundle source introuvable. Recompilez l'app (npm run build).",
                );
            }
            this._index = await res.json();
        }
        this._loaded = true;
    }

    /**
     * List direct children of a directory path.
     * @param dirPath Relative path from bundle root, e.g. "" | "src" | "src/js"
     */
    async listDir(dirPath: string): Promise<DirEntry[]> {
        if (!this._loaded) await this.initialize();

        return this._index
            .filter((entry) => {
                const parentPath = entry.path.includes("/")
                    ? entry.path.slice(0, entry.path.lastIndexOf("/"))
                    : "";
                return parentPath === dirPath;
            })
            .map((entry) => ({
                name: entry.path.split("/").pop() ?? entry.path,
                type: entry.type,
                path: entry.path,
            }));
    }

    /**
     * Fetch file content from the bundle.
     * @param filePath Relative path, e.g. "src/js/app.ts"
     */
    async readFile(filePath: string): Promise<string> {
        if (!this._loaded) await this.initialize();
        if (this._cacheBase) {
            const r = await Filesystem.readFile({
                path: `${this._cacheBase}/${filePath}`,
                directory: Directory.Cache,
                encoding: Encoding.UTF8,
            });
            const data = r.data;
            if (typeof data !== "string") {
                throw new Error(`Filesystem.readFile returned non-string for ${filePath}`);
            }
            return data;
        }
        const res = await fetch(`${this._baseUrl}/${filePath}`);
        if (!res.ok) {
            throw new Error(`Fichier introuvable dans le bundle: ${filePath}`);
        }
        return res.text();
    }

    /**
     * Returns the absolute URL for a file in this bundle (for <img src> etc.)
     */
    getFileUrl(filePath: string): string {
        if (this._cacheBase) {
            return `cache:///${this._cacheBase}/${filePath}`;
        }
        return `${this._baseUrl}/${filePath}`;
    }
}
