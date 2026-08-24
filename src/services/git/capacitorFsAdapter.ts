import { Filesystem, Directory } from "@capacitor/filesystem";

/**
 * isomorphic-git expects a Node-fs-shaped object with promise-returning
 * methods. We map each call onto @capacitor/filesystem against the
 * Documents directory.
 *
 * Paths from isomorphic-git are absolute-looking ("/repos/{slug}/foo");
 * the adapter strips the leading "/" and uses Directory.Data.
 *
 * Symlinks are unsupported; readlink/symlink throw ENOSYS — none of the
 * targeted git ops (init, add, commit, status, diff, log, reset) need
 * them when the working tree contains no symlinks (which is the case for
 * source code repos in this project).
 */
export interface FsStat {
    type: "file" | "dir" | "symlink";
    mode: number;
    size: number;
    mtimeMs: number;
    ino: number;
    uid: number;
    gid: number;
    isFile: () => boolean;
    isDirectory: () => boolean;
    isSymbolicLink: () => boolean;
}

function strip(p: string): string {
    return p.replace(/^\/+/, "");
}

function bytesToBase64(bytes: Uint8Array): string {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

export const capacitorFsAdapter = {
    promises: {
        async readFile(
            path: string,
            opts?: { encoding?: string },
        ): Promise<Uint8Array | string> {
            const r = await Filesystem.readFile({
                path: strip(path),
                directory: Directory.Data,
            });
            const data = r.data as string;
            if (opts?.encoding === "utf8") {
                return new TextDecoder().decode(base64ToBytes(data));
            }
            return base64ToBytes(data);
        },

        async writeFile(
            path: string,
            data: Uint8Array | string,
            _opts?: { encoding?: string; mode?: number },
        ): Promise<void> {
            const bytes = typeof data === "string"
                ? new TextEncoder().encode(data)
                : data;
            await Filesystem.writeFile({
                path: strip(path),
                directory: Directory.Data,
                data: bytesToBase64(bytes),
                recursive: true,
            });
        },

        async unlink(path: string): Promise<void> {
            await Filesystem.deleteFile({
                path: strip(path),
                directory: Directory.Data,
            });
        },

        async readdir(path: string): Promise<string[]> {
            const r = await Filesystem.readdir({
                path: strip(path),
                directory: Directory.Data,
            });
            return r.files.map((f) => f.name);
        },

        async mkdir(path: string, opts?: { recursive?: boolean }): Promise<void> {
            await Filesystem.mkdir({
                path: strip(path),
                directory: Directory.Data,
                recursive: opts?.recursive ?? true,
            });
        },

        async rmdir(path: string): Promise<void> {
            await Filesystem.rmdir({
                path: strip(path),
                directory: Directory.Data,
                recursive: true,
            });
        },

        async stat(path: string): Promise<FsStat> {
            const r = await Filesystem.stat({
                path: strip(path),
                directory: Directory.Data,
            });
            const isFile = r.type === "file";
            const isDir = r.type === "directory";
            return {
                type: isFile ? "file" : isDir ? "dir" : "symlink",
                mode: 0o644,
                size: r.size,
                mtimeMs: r.mtime,
                ino: 0,
                uid: 0,
                gid: 0,
                isFile: () => isFile,
                isDirectory: () => isDir,
                isSymbolicLink: () => false,
            };
        },

        async lstat(path: string): Promise<FsStat> {
            return this.stat(path);
        },

        async readlink(_path: string): Promise<string> {
            throw Object.assign(new Error("ENOSYS: symlinks unsupported"), { code: "ENOSYS" });
        },

        async symlink(_t: string, _p: string): Promise<void> {
            throw Object.assign(new Error("ENOSYS: symlinks unsupported"), { code: "ENOSYS" });
        },
    },
};
