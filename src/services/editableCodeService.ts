import { Filesystem, Directory } from "@capacitor/filesystem";
import { capacitorFsAdapter } from "./git/capacitorFsAdapter";
import { GitStatus, GitCommit } from "../models/gitTypes";
import { DirEntry } from "./codeService";

export class EditableCodeService {
    private readonly _docsBase: string;

    constructor(public readonly slug: string) {
        this._docsBase = `repos/${slug}`;
    }

    async listDir(dirPath: string): Promise<DirEntry[]> {
        const path = dirPath ? `${this._docsBase}/${dirPath}` : this._docsBase;
        const r = await Filesystem.readdir({ path, directory: Directory.Data });
        return r.files
            .filter((f) => f.name !== ".git")
            .map((f) => ({
                name: f.name,
                type: f.type === "directory" ? "dir" : "file",
                path: dirPath ? `${dirPath}/${f.name}` : f.name,
            }));
    }

    async readFile(filepath: string): Promise<string> {
        const r = await Filesystem.readFile({
            path: `${this._docsBase}/${filepath}`,
            directory: Directory.Data,
        });
        const data = r.data as string;
        return new TextDecoder().decode(_b64ToBytes(data));
    }

    async writeFile(filepath: string, content: string): Promise<void> {
        const bytes = new TextEncoder().encode(content);
        await Filesystem.writeFile({
            path: `${this._docsBase}/${filepath}`,
            directory: Directory.Data,
            data: _bytesToB64(bytes),
            recursive: true,
        });
    }

    async deleteFile(filepath: string): Promise<void> {
        await Filesystem.deleteFile({
            path: `${this._docsBase}/${filepath}`,
            directory: Directory.Data,
        });
    }

    async status(): Promise<GitStatus> {
        const git = await import("isomorphic-git");
        const matrix = await git.statusMatrix({
            fs: capacitorFsAdapter,
            dir: `/${this._docsBase}`,
        });
        const status: GitStatus = { modified: [], untracked: [], staged: [], deleted: [] };
        for (const [filepath, head, wd, stage] of matrix) {
            if (head === 0 && wd === 2) status.untracked.push(filepath);
            else if (head === 1 && wd === 0) status.deleted.push(filepath);
            else if (head === 1 && wd === 2 && stage === 2) status.staged.push(filepath);
            else if (head === 1 && wd === 2) status.modified.push(filepath);
        }
        return status;
    }

    async diff(filepath?: string): Promise<string> {
        // isomorphic-git doesn't have a built-in unified diff; we compute it
        // from headTree vs workdir manually for the requested file (or all).
        const git = await import("isomorphic-git");
        const status = await this.status();
        const targets = filepath
            ? [filepath]
            : [...status.modified, ...status.staged, ...status.deleted, ...status.untracked];

        const out: string[] = [];
        for (const fp of targets) {
            try {
                const headOid = await git.resolveRef({
                    fs: capacitorFsAdapter,
                    dir: `/${this._docsBase}`,
                    ref: "HEAD",
                });
                const headBlob = await git.readBlob({
                    fs: capacitorFsAdapter,
                    dir: `/${this._docsBase}`,
                    oid: headOid,
                    filepath: fp,
                }).then((b) => new TextDecoder().decode(b.blob)).catch(() => "");
                const workBlob = await this.readFile(fp).catch(() => "");
                if (headBlob !== workBlob) {
                    out.push(`--- a/${fp}`);
                    out.push(`+++ b/${fp}`);
                    out.push(...simpleLineDiff(headBlob, workBlob));
                }
            } catch { /* ignore per-file errors */ }
        }
        return out.join("\n");
    }

    async log(opts?: { limit?: number }): Promise<GitCommit[]> {
        const git = await import("isomorphic-git");
        const log = await git.log({
            fs: capacitorFsAdapter,
            dir: `/${this._docsBase}`,
            depth: opts?.limit ?? 50,
        });
        return log.map((e) => ({
            sha: e.oid,
            message: e.commit.message.trim(),
            author: { name: e.commit.author.name, email: e.commit.author.email },
            date: new Date(e.commit.author.timestamp * 1000).toISOString(),
            parentShas: e.commit.parent ?? [],
        }));
    }

    async commit(message: string): Promise<string> {
        const git = await import("isomorphic-git");
        await git.add({
            fs: capacitorFsAdapter,
            dir: `/${this._docsBase}`,
            filepath: ".",
        });
        return git.commit({
            fs: capacitorFsAdapter,
            dir: `/${this._docsBase}`,
            message,
            author: { name: "ERPLibre Mobile", email: "app@local" },
        });
    }

    async resetFile(filepath: string): Promise<void> {
        const git = await import("isomorphic-git");
        await git.checkout({
            fs: capacitorFsAdapter,
            dir: `/${this._docsBase}`,
            ref: "HEAD",
            filepaths: [filepath],
            force: true,
        });
    }

    async resetAll(): Promise<void> {
        const git = await import("isomorphic-git");
        await git.checkout({
            fs: capacitorFsAdapter,
            dir: `/${this._docsBase}`,
            ref: "HEAD",
            force: true,
        });
        // Drop untracked files manually.
        const status = await this.status();
        for (const fp of status.untracked) {
            await this.deleteFile(fp).catch(() => {});
        }
    }
}

function _bytesToB64(bytes: Uint8Array): string {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
}
function _b64ToBytes(b64: string): Uint8Array {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

/** Minimal line diff (no Myers — just full-file replacement when texts differ). */
function simpleLineDiff(a: string, b: string): string[] {
    const out: string[] = [];
    if (!a && b) {
        for (const l of b.split("\n")) out.push(`+${l}`);
        return out;
    }
    if (a && !b) {
        for (const l of a.split("\n")) out.push(`-${l}`);
        return out;
    }
    const aLines = a.split("\n");
    const bLines = b.split("\n");
    const max = Math.max(aLines.length, bLines.length);
    for (let i = 0; i < max; i++) {
        const al = aLines[i];
        const bl = bLines[i];
        if (al === bl) {
            out.push(` ${al}`);
        } else {
            if (al !== undefined) out.push(`-${al}`);
            if (bl !== undefined) out.push(`+${bl}`);
        }
    }
    return out;
}
