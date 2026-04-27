import { Filesystem, Directory } from "@capacitor/filesystem";
import { capacitorFsAdapter } from "./git/capacitorFsAdapter";
import { RepoExtractorService } from "./repoExtractorService";

interface DbLike {
    run(sql: string, params?: unknown[]): Promise<unknown>;
    all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

/**
 * Promotes a read-only Cache extraction to a persistent Documents copy
 * with a baseline git commit. Idempotent: repromoting an already-editable
 * repo is a no-op (returns the existing baseline sha).
 *
 * Triggered explicitly by the UI (Code tool's "Edit" button).
 */
export class RepoEditService {

    constructor(
        private readonly extractor: RepoExtractorService,
        private readonly archiveUrl: string,
        private readonly db: DbLike,
    ) {}

    async isEditable(slug: string): Promise<boolean> {
        const rows = await this.db.all<{ slug: string }>(
            "SELECT slug FROM editable_repos WHERE slug = ? LIMIT 1",
            [slug],
        );
        return rows.length > 0;
    }

    async promoteToEditable(slug: string): Promise<string> {
        if (await this.isEditable(slug)) {
            const rows = await this.db.all<{ baseline_sha: string }>(
                "SELECT baseline_sha FROM editable_repos WHERE slug = ?",
                [slug],
            );
            return rows[0].baseline_sha;
        }

        const cacheBase = await this.extractor.ensureExtracted(slug, this.archiveUrl);
        const docsBase = `repos/${slug}`;

        // Recursive copy Cache → Documents.
        await this._copyTree(cacheBase, docsBase);

        // Lazy-import isomorphic-git so it does not weigh on startup.
        const git = await import("isomorphic-git");

        await git.init({
            fs: capacitorFsAdapter,
            dir: `/${docsBase}`,
        });

        // Stage everything.
        await git.add({
            fs: capacitorFsAdapter,
            dir: `/${docsBase}`,
            filepath: ".",
        });

        const buildId = await this._readBuildId();
        const sha = await git.commit({
            fs: capacitorFsAdapter,
            dir: `/${docsBase}`,
            message: `baseline: shipped via APK build ${buildId}`,
            author: { name: "ERPLibre Mobile", email: "app@local" },
        });

        await this.db.run(
            `INSERT INTO editable_repos (slug, baseline_sha, build_id, promoted_at, head_sha)
             VALUES (?, ?, ?, ?, ?)`,
            [slug, sha, buildId, Date.now(), sha],
        );

        return sha;
    }

    async unpromote(slug: string): Promise<void> {
        if (!(await this.isEditable(slug))) return;
        await Filesystem.rmdir({
            path: `repos/${slug}`,
            directory: Directory.Data,
            recursive: true,
        });
        await this.db.run("DELETE FROM editable_repos WHERE slug = ?", [slug]);
    }

    private async _copyTree(srcRel: string, dstRel: string): Promise<void> {
        // Walk src recursively. Cache is the source.
        const stack: string[] = [""];
        while (stack.length > 0) {
            const rel = stack.pop()!;
            const fullSrc = rel ? `${srcRel}/${rel}` : srcRel;
            const fullDst = rel ? `${dstRel}/${rel}` : dstRel;
            await Filesystem.mkdir({
                path: fullDst,
                directory: Directory.Data,
                recursive: true,
            }).catch(() => {});
            const r = await Filesystem.readdir({
                path: fullSrc,
                directory: Directory.Cache,
            });
            for (const f of r.files) {
                const subRel = rel ? `${rel}/${f.name}` : f.name;
                if (f.type === "directory") {
                    stack.push(subRel);
                } else {
                    if (f.name === ".extracted") continue;
                    const data = (await Filesystem.readFile({
                        path: `${srcRel}/${subRel}`,
                        directory: Directory.Cache,
                    })).data as string; // base64
                    await Filesystem.writeFile({
                        path: `${dstRel}/${subRel}`,
                        directory: Directory.Data,
                        data,
                        recursive: true,
                    });
                }
            }
        }
    }

    private async _readBuildId(): Promise<string> {
        try {
            const r = await fetch("/build_id.json");
            if (r.ok) {
                const j = await r.json();
                return j.buildId ?? "unknown";
            }
        } catch { /* ignore */ }
        return "unknown";
    }
}
