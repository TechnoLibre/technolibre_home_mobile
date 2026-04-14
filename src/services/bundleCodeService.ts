import { DirEntry } from "./codeService";

interface BundleEntry {
    path: string;
    type: "file" | "dir";
}

/**
 * Read-only code reader that uses the source bundle embedded at build time.
 * The default base URL "/repo" serves the app's own source (src/public/repo/).
 * Pass "/repos/{slug}" to browse a manifest repo (src/public/repos/{slug}/).
 * No SSH connection required.
 */
export class BundleCodeService {
    private _index: BundleEntry[] = [];
    private _loaded = false;

    constructor(private readonly _baseUrl: string = "/repo") {}

    async initialize(): Promise<void> {
        const res = await fetch(`${this._baseUrl}/index.json`);
        if (!res.ok) {
            throw new Error(
                "Bundle source introuvable. Recompilez l'app (npm run build).",
            );
        }
        this._index = await res.json();
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
                type: entry.type as "file" | "dir",
                path: entry.path,
            }));
    }

    /**
     * Fetch file content from the bundle.
     * @param filePath Relative path, e.g. "src/js/app.ts"
     */
    async readFile(filePath: string): Promise<string> {
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
        return `${this._baseUrl}/${filePath}`;
    }
}
