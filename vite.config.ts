import { defineConfig, Plugin } from "vite";
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

// ── Shared types ──────────────────────────────────────────────────────────────

interface BundleEntry {
    path: string;
    type: "file" | "dir";
}

interface ManifestProject {
    url: string;
    name: string;
    path: string;
    slug: string;
    revision: string;
    archive: string;
    indexUrl: string;
    fileCount: number;
    uncompressedBytes: number;
    compressedBytes: number;
}

// ── Shared helpers ────────────────────────────────────────────────────────────

/**
 * Create a gzipped tar archive of the given source dir.
 * Uses the system `tar` command — fastest path; required at build time.
 */
function createTarGz(srcDir: string, archivePath: string): void {
    try {
        execFileSync("tar", ["-czf", archivePath, "-C", srcDir, "."], {
            stdio: ["ignore", "ignore", "pipe"],
        });
    } catch (e) {
        throw new Error(`tar -czf failed for ${srcDir} → ${archivePath}: ${e}`);
    }
}

/**
 * rmSync with broken-symlink and ENOTEMPTY tolerance. The bundle pipeline
 * has occasionally produced ENOTEMPTY when a previous build left stale
 * symlinks under src/public/repos/{slug}/ — the recursive remove races
 * with the kernel re-tagging dir entries. We retry up to 5 times.
 */
function removeDirRobust(dir: string): void {
    if (!existsSync(dir)) return;
    try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (e) {
        console.warn(`[bundle-warn] removeDirRobust failed once: ${dir} — ${e}`);
        // One more attempt after a small backoff. If this still fails, propagate.
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
    }
}

/** Derive a filesystem-safe slug from a git URL (mirrors CodeService._urlToSlug). */
function urlToSlug(url: string): string {
    return url
        .replace(/^https?:\/\//, "")
        .replace(/^git@/, "")
        .replace(/\.git$/, "")
        .replace(/[/:]/g, "-")
        .replace(/[^a-zA-Z0-9_-]/g, "-")
        .replace(/-+/g, "-")
        .slice(0, 60);
}

/** Names always skipped when traversing any directory. */
const SKIP = new Set([
    ".git",
    "node_modules",
    "dist",
    ".DS_Store",
    "Thumbs.db",
]);

/**
 * Extra directory names skipped only when bundling manifest repos.
 * Prevents binary build artifacts from being packaged into APK assets.
 */
const MANIFEST_SKIP_DIRS = new Set([
    "android", "ios", "build", ".gradle", ".gradle-cache",
    "__pycache__", ".tox", "venv", ".venv", "target", "coverage",
    ".eggs", ".pytest_cache", ".mypy_cache", ".ruff_cache",
    "htmlcov", ".cache", "cmake-build-debug", "cmake-build-release",
    ".idea", ".vscode",
]);

/**
 * Binary file extensions skipped when bundling manifest repos.
 * These files are not viewable as text and would bloat the APK assets.
 */
const BINARY_EXT = new Set([
    ".so", ".o", ".a", ".class", ".jar", ".aar", ".dex", ".bin",
    ".pyc", ".pyo", ".pyd", ".exe", ".dll", ".dylib", ".wasm",
    ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".rar",
    ".apk", ".aab", ".ipa",
    ".pdf", ".ico",
    ".ttf", ".otf", ".woff", ".woff2", ".eot",
    ".db", ".sqlite", ".sqlite3",
    ".lock",
]);

/** Maximum file size (bytes) allowed in a manifest repo bundle. */
const MAX_BUNDLE_FILE_BYTES = 1_048_576; // 1 MB

/**
 * Set BUNDLE_DEBUG=1 to get per-file verbose output during bundling.
 * Useful for diagnosing which files are skipped or cause errors.
 */
const DEBUG = process.env["BUNDLE_DEBUG"] === "1";
const dbg = (...args: unknown[]) => DEBUG && console.log("[bundle-debug]", ...args);

interface CopyStats {
    copied: number;
    skippedName: number;   // SKIP / MANIFEST_SKIP_DIRS / extraSkip
    skippedExclude: number; // outputExclusion hit
    skippedSize: number;   // over maxFileSize
    errors: number;        // stat/copy errors (broken symlinks, perms…)
}

/**
 * Recursively copy srcDir into destDir, recording every entry in index.
 * relBase is the path prefix used inside the index (empty string for root).
 * excludeAbsPaths: resolved absolute paths that must never be entered.
 * maxFileSize: if set, files larger than this (bytes) are skipped.
 * stats: accumulated counters (pass a fresh object at the top-level call).
 */
function copyDirToBundle(
    srcDir: string,
    relBase: string,
    destDir: string,
    index: BundleEntry[],
    extraSkip?: (relBase: string, name: string) => boolean,
    excludeAbsPaths?: Set<string>,
    maxFileSize?: number,
    stats?: CopyStats,
): void {
    let names: string[];
    try {
        names = readdirSync(srcDir).sort();
    } catch (e) {
        console.warn(`[bundle-warn] cannot read dir: ${srcDir} — ${e}`);
        if (stats) stats.errors++;
        return;
    }

    for (const name of names) {
        const relPath = (relBase ? relBase + "/" : "") + name;

        if (SKIP.has(name)) {
            dbg(`skip(global) ${relPath}`);
            if (stats) stats.skippedName++;
            continue;
        }
        if (extraSkip?.(relBase, name)) {
            dbg(`skip(extra)  ${relPath}`);
            if (stats) stats.skippedName++;
            continue;
        }

        const fullSrc = resolve(join(srcDir, name));
        if (excludeAbsPaths) {
            const hit = [...excludeAbsPaths].some(
                (p) => fullSrc === p || fullSrc.startsWith(p + "/"),
            );
            if (hit) {
                dbg(`skip(excl)   ${relPath}`);
                if (stats) stats.skippedExclude++;
                continue;
            }
        }

        const fullDst = join(destDir, relPath);
        let stat;
        try {
            stat = statSync(fullSrc);
        } catch (e) {
            // Broken symlink, permission error, etc.
            console.warn(`[bundle-warn] stat failed: ${fullSrc} — ${e}`);
            if (stats) stats.errors++;
            continue;
        }

        if (stat.isDirectory()) {
            mkdirSync(fullDst, { recursive: true });
            index.push({ path: relPath, type: "dir" });
            dbg(`dir  ${relPath}`);
            copyDirToBundle(fullSrc, relPath, destDir, index, extraSkip, excludeAbsPaths, maxFileSize, stats);
        } else if (stat.isFile()) {
            if (maxFileSize !== undefined && stat.size > maxFileSize) {
                dbg(`skip(size)   ${relPath}  ${(stat.size / 1024).toFixed(0)} KB`);
                if (stats) stats.skippedSize++;
                continue;
            }
            try {
                mkdirSync(dirname(fullDst), { recursive: true });
                copyFileSync(fullSrc, fullDst);
            } catch (e) {
                console.warn(`[bundle-warn] copy failed: ${fullSrc} — ${e}`);
                if (stats) stats.errors++;
                continue;
            }
            dbg(`file ${relPath}  ${(stat.size / 1024).toFixed(0)} KB`);
            index.push({ path: relPath, type: "file" });
            if (stats) stats.copied++;
        }
    }
}

// ── XML manifest parser ───────────────────────────────────────────────────────

function parseManifestXml(xml: string): {
    remotes: Record<string, string>;
    projects: Array<{ name: string; path: string; remote: string; revision: string }>;
} {
    const remotes: Record<string, string> = {};
    for (const m of xml.matchAll(/<remote\s[^>]*>/g)) {
        const name = m[0].match(/\bname="([^"]+)"/)?.[1];
        let fetch = m[0].match(/\bfetch="([^"]+)"/)?.[1];
        if (name && fetch) {
            if (!fetch.endsWith("/")) fetch += "/";
            remotes[name] = fetch;
        }
    }

    const projects: Array<{ name: string; path: string; remote: string; revision: string }> = [];
    for (const m of xml.matchAll(/<project\s[^>]*>/g)) {
        const name = m[0].match(/\bname="([^"]+)"/)?.[1];
        const path = m[0].match(/\bpath="([^"]+)"/)?.[1];
        const remote = m[0].match(/\bremote="([^"]+)"/)?.[1];
        const revision = m[0].match(/\brevision="([^"]+)"/)?.[1] ?? "HEAD";
        if (name && path && remote) projects.push({ name, path, remote, revision });
    }

    return { remotes, projects };
}

// ── Bundle-source plugin ──────────────────────────────────────────────────────
// 1. Copies project source files into src/public/repo/ (the app itself).
// 2. Reads the ERPLibre manifest XML and bundles any locally-present repos
//    into src/public/repos/{slug}/, generating src/public/repos/manifest.json.
//
// The manifest path can be overridden via the ERPLIBRE_MANIFEST_PATH env var.
// Default: ../../.repo/local_manifests/erplibre_manifest.xml
//          (relative to mobile/erplibre_home_mobile/)

function bundleSourcePlugin(): Plugin {
    return {
        name: "bundle-source",
        buildStart() {
            const root = process.cwd(); // mobile/erplibre_home_mobile/

            // ── 1. App source bundle (src/public/repo/) ───────────────────
            const appOutDir = join(root, "src", "public", "repo");
            removeDirRobust(appOutDir);
            mkdirSync(appOutDir, { recursive: true });

            const appIndex: BundleEntry[] = [];
            const appStats: CopyStats = { copied: 0, skippedName: 0, skippedExclude: 0, skippedSize: 0, errors: 0 };
            const appT0 = Date.now();

            // Skip src/public/ to avoid bundling the bundle itself
            const skipPublic = (relBase: string, name: string): boolean =>
                relBase === "src" && name === "public";

            for (const dir of ["src", "doc", "scripts"]) {
                const srcDir = join(root, dir);
                if (!existsSync(srcDir)) continue;
                mkdirSync(join(appOutDir, dir), { recursive: true });
                appIndex.push({ path: dir, type: "dir" });
                copyDirToBundle(srcDir, dir, appOutDir, appIndex, skipPublic, undefined, undefined, appStats);
            }

            const ROOT_SKIP_FILES = new Set(["package-lock.json", "debug.keystore"]);
            const ROOT_PATTERNS = [
                /\.md$/i, /\.ts$/, /\.sh$/, /^LICENSE$/, /^\.gitignore$/, /^capacitor\.config\.json$/,
            ];
            let rootEntries: string[];
            try { rootEntries = readdirSync(root).sort(); }
            catch (e) { console.warn(`[bundle-warn] readdir(${root}) failed: ${e}`); rootEntries = []; }
            for (const name of rootEntries) {
                if (ROOT_SKIP_FILES.has(name)) continue;
                const fullSrc = join(root, name);
                let st;
                try { st = statSync(fullSrc); }
                catch (e) { dbg(`skip(stat) ${name} — ${e}`); continue; }
                if (!st.isFile()) continue;
                if (!ROOT_PATTERNS.some((re) => re.test(name))) continue;
                copyFileSync(fullSrc, join(appOutDir, name));
                appIndex.push({ path: name, type: "file" });
                appStats.copied++;
            }

            writeFileSync(join(appOutDir, "index.json"), JSON.stringify(appIndex, null, 2));
            console.log(
                `[bundle-source] ${appStats.copied} files → src/public/repo/` +
                `  (${Date.now() - appT0} ms` +
                (appStats.errors ? `  ⚠ ${appStats.errors} errors` : "") +
                `)`
            );

            // ── 2. ERPLibre manifest repos (src/public/repos/) ────────────
            const manifestPath = resolve(
                process.env["ERPLIBRE_MANIFEST_PATH"] ??
                    join(root, "../../.repo/local_manifests/erplibre_manifest.xml"),
            );
            const reposOutDir = join(root, "src", "public", "repos");
            removeDirRobust(reposOutDir);
            mkdirSync(reposOutDir, { recursive: true });

            // Paths that must never be entered while walking a manifest project
            // (guards against infinite recursion when a project IS the app itself)
            const outputExclusions = new Set([
                resolve(appOutDir),
                resolve(reposOutDir),
            ]);

            const bundledProjects: ManifestProject[] = [];

            if (!existsSync(manifestPath)) {
                console.log(`[bundle-manifest] manifest not found: ${manifestPath}`);
            } else {
                const xml = readFileSync(manifestPath, "utf-8");
                const { remotes, projects } = parseManifestXml(xml);

                // Workspace root = 3 levels up from the manifest file
                // ({workspace}/.repo/local_manifests/erplibre_manifest.xml)
                const workspaceRoot = resolve(dirname(manifestPath), "../..");

                /** Skip dirs/files that produce binary build artifacts. */
                const manifestExtraSkip = (_relBase: string, name: string): boolean => {
                    if (MANIFEST_SKIP_DIRS.has(name)) return true;
                    const ext = name.match(/(\.[^.]+)$/)?.[1]?.toLowerCase();
                    if (ext && BINARY_EXT.has(ext)) return true;
                    return false;
                };

                for (const proj of projects) {
                    const remoteFetch = remotes[proj.remote] ?? "";
                    const url = remoteFetch + proj.name;
                    const slug = urlToSlug(url);
                    const localPath = join(workspaceRoot, proj.path);

                    if (!existsSync(localPath)) {
                        console.log(`[bundle-manifest] skip (missing): ${localPath}`);
                        continue;
                    }

                    // Stage filtered files in a temp dir, then tar.gz them.
                    const stage = join(
                        tmpdir(),
                        `erplibre-bundle-${slug}-${randomBytes(4).toString("hex")}`,
                    );
                    mkdirSync(stage, { recursive: true });

                    const projIndex: BundleEntry[] = [];
                    const projStats: CopyStats = {
                        copied: 0, skippedName: 0, skippedExclude: 0, skippedSize: 0, errors: 0,
                    };
                    const projT0 = Date.now();
                    copyDirToBundle(
                        localPath, "", stage, projIndex, manifestExtraSkip,
                        outputExclusions, MAX_BUNDLE_FILE_BYTES, projStats,
                    );

                    // Write index.json into the stage so it lands inside the archive.
                    writeFileSync(
                        join(stage, "index.json"),
                        JSON.stringify(projIndex, null, 2),
                    );

                    // Also write a sidecar index.json next to the archive so the
                    // runtime can show the directory tree without unpacking.
                    const indexOutPath = join(reposOutDir, `${slug}.index.json`);
                    writeFileSync(indexOutPath, JSON.stringify(projIndex, null, 2));

                    // Compute uncompressed size.
                    const uncompressedBytes = projIndex
                        .filter((e) => e.type === "file")
                        .reduce((sum, e) => {
                            try {
                                return sum + statSync(join(stage, e.path)).size;
                            } catch {
                                return sum;
                            }
                        }, 0);

                    const archivePath = join(reposOutDir, `${slug}.tar.gz`);
                    createTarGz(stage, archivePath);

                    const compressedBytes = statSync(archivePath).size;

                    // Clean up the stage.
                    removeDirRobust(stage);

                    const name = proj.name.replace(/\.git$/, "");
                    bundledProjects.push({
                        url, name, path: proj.path, slug, revision: proj.revision,
                        archive: `repos/${slug}.tar.gz`,
                        indexUrl: `repos/${slug}.index.json`,
                        fileCount: projStats.copied,
                        uncompressedBytes,
                        compressedBytes,
                    });

                    console.log(
                        `[bundle-manifest] ${slug}.tar.gz: ${projStats.copied} files` +
                        `, ${(uncompressedBytes / 1024).toFixed(0)} KB → ` +
                        `${(compressedBytes / 1024).toFixed(0)} KB` +
                        `  (${Date.now() - projT0} ms)`,
                    );
                }
            }

            writeFileSync(
                join(reposOutDir, "manifest.json"),
                JSON.stringify(bundledProjects, null, 2),
            );
            console.log(`[bundle-manifest] ${bundledProjects.length} repos → src/public/repos/`);
        },
    };
}

// ── Vite config ───────────────────────────────────────────────────────────────

export default defineConfig(({ mode }) => ({
    root: "./src",
    plugins: [bundleSourcePlugin()],
    build: {
        outDir: "../dist",
        minify: "esbuild",
        emptyOutDir: true,
        rollupOptions: {
            output: {
                // Split vendor bundles so the WebView can parse chunks in
                // parallel at startup. Heavy libs are isolated; everything
                // else under node_modules lands in a generic "vendor" chunk.
                manualChunks(id: string) {
                    if (!id.includes("node_modules")) return undefined;
                    if (id.includes("@odoo/owl")) return "owl";
                    if (id.includes("@capacitor-community/sqlite")) return "sqlite";
                    if (id.includes("@capacitor/") || id.includes("@capacitor-community/") ||
                        id.includes("capacitor-") || id.includes("@capawesome") ||
                        id.includes("@capgo")) {
                        return "capacitor";
                    }
                    return "vendor";
                },
            },
        },
    },
    esbuild: {
        drop: mode === "production" ? ["console", "debugger"] : [],
    },
    css: {
        preprocessorOptions: {
            scss: {
                api: "modern",
            },
        },
    },
}));
