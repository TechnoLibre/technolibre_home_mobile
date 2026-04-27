/**
 * Shape of a single project entry in src/public/repos/manifest.json.
 *
 * Produced at build time by bundleSourcePlugin in vite.config.ts.
 * Consumed at runtime by RepoExtractorService and BundleCodeService.
 */
export interface ManifestProject {
    /** Origin URL (https or ssh) — display only. */
    url: string;

    /** Human-readable name (e.g. "OCA/web-api"). */
    name: string;

    /** Workspace-relative path where the source lived at build time. */
    path: string;

    /** Filesystem-safe slug used as archive base name and as Documents/repos/{slug}/. */
    slug: string;

    /** Git revision recorded in the manifest XML. */
    revision: string;

    /** Public asset path of the gzipped tar archive, e.g. "repos/github-com-OCA-web-api.tar.gz". */
    archive: string;

    /** Public asset path of the JSON file index, e.g. "repos/github-com-OCA-web-api.index.json". */
    indexUrl: string;

    fileCount: number;
    uncompressedBytes: number;
    compressedBytes: number;
}

export interface BundleEntry {
    path: string;
    type: "file" | "dir";
    size?: number;
}
