import { Capacitor } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";

/** A text answer of the file transport: the first value of each header, lowercase names. */
export interface HttpAnswer {
    status: number;
    headers: Record<string, string>;
    data: string;
}

/**
 * A multipart POST: the fields in their order, then one part "ufile" read
 * from file.uri (a file inside the app's chat directory) under file.name.
 */
export interface UploadRequest {
    /**
     * Transfer id, for cancel() and the progress events. Unique per
     * transfer: the native side refuses an id a running transfer holds,
     * and frees it before the transfer settles.
     */
    id: string;
    url: string;
    headers: Record<string, string>;
    fields: Record<string, string>;
    file: { uri: string; name: string; mimetype: string };
}

/** A GET streamed to uri (a file inside the app's chat directory). */
export interface DownloadRequest {
    /** As UploadRequest.id. */
    id: string;
    url: string;
    headers: Record<string, string>;
    uri: string;
}

/**
 * A download's outcome. On a 2xx the file is complete at its uri; any other
 * status writes nothing and leaves sha1 and mimetype null.
 */
export interface DownloadAnswer {
    status: number;
    size: number;
    /** SHA-1 of the bytes written, hex: Odoo's ir.attachment checksum. */
    sha1: string | null;
    /** Content-Type without its parameters. */
    mimetype: string | null;
}

/** Bytes moved so far by transfer id; total is null when the server sends no length. */
export interface TransferProgress {
    id: string;
    done: number;
    total: number | null;
}

/**
 * Streamed HTTP for chat files: the native ChatFile plugin on the phone,
 * fakeChatHttp in tests. A request that never reached the server rejects
 * with RequestNotSentError; the answer of any status resolves.
 */
export interface ChatHttp {
    getText(url: string, headers: Record<string, string>): Promise<HttpAnswer>;
    upload(r: UploadRequest): Promise<HttpAnswer>;
    download(r: DownloadRequest): Promise<DownloadAnswer>;
    cancel(id: string): Promise<void>;
    /** Subscribes to every transfer's progress; returns the unsubscribe. */
    onProgress(fn: (p: TransferProgress) => void): () => void;
}

/**
 * The app's chat files, by path relative to Directory.Data (see the
 * layout helpers below). Every method takes such a relative path.
 */
export interface ChatFiles {
    /** The file: URI of rel, as the native transfer takes it. */
    uri(rel: string): Promise<string>;
    /** A URL the web view can load rel from. */
    webUrl(rel: string): Promise<string>;
    /** Size in bytes, null when rel does not exist. */
    size(rel: string): Promise<number | null>;
    /** Writes blob to rel (parents made), replacing it; returns the bytes written. */
    writeBlob(rel: string, blob: Blob): Promise<number>;
    /** Copies a file outside the chat directory (a file: or content: URI, an absolute path) to rel; returns its size. */
    copyFrom(source: string, rel: string): Promise<number>;
    /** Moves from onto to, making to's directory. */
    rename(from: string, to: string): Promise<void>;
    /** Deletes rel; a missing file is not an error. */
    remove(rel: string): Promise<void>;
    /** Deletes the directory rel and all it holds; a missing one is not an error. */
    removeDir(rel: string): Promise<void>;
    /** The names of the entries directly in the directory rel; none for a missing one. */
    list(rel: string): Promise<string[]>;
}

/**
 * Bytes per writeBlob chunk. A multiple of 3, so each chunk's base64 has no
 * padding and the appended pieces decode as one file; the chunk is the most
 * of a picked file that is ever in JS memory at once.
 */
export const WRITE_CHUNK_BYTES = 768 * 1024;

const MAX_NAME_CHARS = 120;
/** Byte bound under the 255-byte name limit of Android file systems, for names in multi-byte scripts. */
const MAX_NAME_BYTES = 240;
const encoder = new TextEncoder();

/**
 * A file name safe to store: path separators become "_", control
 * characters go, no leading dot, at most 120 characters and 240 UTF-8
 * bytes with the extension kept; "file" when nothing is left.
 */
export function safeFileName(name: string): string {
    let clean = Array.from(String(name ?? ""))
        .filter((c) => c.charCodeAt(0) >= 0x20 && c !== "\u007f")
        .join("")
        .replace(/[/\\]/g, "_")
        .trim()
        .replace(/^\.+/, "")
        .trim();
    if (!clean) return "file";
    const dot = clean.lastIndexOf(".");
    const ext = dot > 0 && clean.length - dot <= 16 ? clean.slice(dot) : "";
    let stem = Array.from(clean.slice(0, clean.length - ext.length));
    const fits = () =>
        stem.length + ext.length <= MAX_NAME_CHARS && encoder.encode(stem.join("") + ext).length <= MAX_NAME_BYTES;
    while (stem.length && !fits()) stem = stem.slice(0, -1);
    clean = stem.join("") + ext;
    return clean.replace(/^\.+/, "") || "file";
}

/** A path segment made by the app (a random id, a uuid): letters, digits, "-" and "_" only. */
function segment(value: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`invalid chat file segment: ${value}`);
    return value;
}

function attachmentSegment(id: number): string {
    if (!Number.isInteger(id) || id <= 0) throw new Error(`invalid attachment id: ${id}`);
    return String(id);
}

/** An account's chat directory: `chat/<fileDir>`, fileDir being the random id the source keeps. */
export function sourceDir(fileDir: string): string {
    return `chat/${segment(fileDir)}`;
}

/** A file waiting to be sent, owned by the outbox: `out/<localUuid>/<name>`. */
export function outgoingPath(fileDir: string, localUuid: string, name: string): string {
    return `${sourceDir(fileDir)}/out/${segment(localUuid)}/${safeFileName(name)}`;
}

/** A cached original: `files/<attachmentId>/<name>`. */
export function originalPath(fileDir: string, attachmentId: number, name: string): string {
    return `${sourceDir(fileDir)}/files/${attachmentSegment(attachmentId)}/${safeFileName(name)}`;
}

/** A cached preview: `thumbs/<attachmentId>`. */
export function previewPath(fileDir: string, attachmentId: number): string {
    return `${sourceDir(fileDir)}/thumbs/${attachmentSegment(attachmentId)}`;
}

/**
 * A cached avatar without its extension: `avatars/<partnerId>_<key>`, the
 * key's letters and digits only, so a new key names a new file (the web
 * view never shows the old one from its own cache).
 */
export function avatarBasePath(fileDir: string, partnerId: number, uniqueKey: string): string {
    if (!Number.isInteger(partnerId) || partnerId <= 0) throw new Error(`invalid partner id: ${partnerId}`);
    return `${sourceDir(fileDir)}/avatars/${partnerId}_${uniqueKey.replace(/[^A-Za-z0-9]/g, "") || "0"}`;
}

/**
 * The directory a chat file owns alone: `out/<localUuid>/` of a file to
 * send, `files/<attachmentId>/` of an original; null for a preview, whose
 * thumbs/ directory every preview shares.
 */
export function ownDirOf(rel: string): string | null {
    return /\/(out|files)\/[^/]+\/[^/]+$/.test(rel) ? rel.slice(0, rel.lastIndexOf("/")) : null;
}

/**
 * Deletes a chat file and the directory it owns alone (ownDirOf); a
 * missing one is not an error. A path outside chat/ is refused: only the
 * chat's own files are deleted this way.
 */
export async function removeChatFile(files: ChatFiles, rel: string): Promise<void> {
    if (!rel.startsWith("chat/")) throw new Error(`not a chat file: ${rel}`);
    await files.remove(rel);
    const dir = ownDirOf(rel);
    if (dir) await files.removeDir(dir);
}

/** Base64 of bytes, built in slices so String.fromCharCode never gets too many arguments. */
function toBase64(bytes: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
}

/** Makes the directory that holds rel; one already there is fine. */
async function makeParent(rel: string): Promise<void> {
    const i = rel.lastIndexOf("/");
    if (i <= 0) return;
    await Filesystem.mkdir({ path: rel.slice(0, i), directory: Directory.Data, recursive: true }).catch(() => {
        /* already there: the next call fails on its own if it is not */
    });
}

/** A failed delete is an error only while rel still exists. */
async function unlessGone(rel: string, error: unknown): Promise<void> {
    const still = await Filesystem.stat({ path: rel, directory: Directory.Data }).then(() => true, () => false);
    if (still) throw error;
}

/** The file: URI of Directory.Data, asked of the phone once (again after a failure). */
let webRoot: Promise<string> | null = null;

function dataRoot(): Promise<string> {
    if (!webRoot) {
        const asked = Filesystem.getUri({ path: "", directory: Directory.Data }).then((r) => r.uri.replace(/\/+$/, ""));
        webRoot = asked;
        asked.catch(() => {
            if (webRoot === asked) webRoot = null;
        });
    }
    return webRoot;
}

/** Forgets the cached data root, so the next webUrl asks the phone again. */
export function resetWebRoot(): void {
    webRoot = null;
}

/** ChatFiles over @capacitor/filesystem, under Directory.Data. */
export const deviceChatFiles: ChatFiles = {
    async uri(rel) {
        return (await Filesystem.getUri({ path: rel, directory: Directory.Data })).uri;
    },

    /** Built from the data root and rel, each segment percent-encoded: one bridge call for the whole app. */
    async webUrl(rel) {
        const path = rel.split("/").map(encodeURIComponent).join("/");
        return Capacitor.convertFileSrc((await dataRoot()) + "/" + path);
    },

    async size(rel) {
        try {
            return (await Filesystem.stat({ path: rel, directory: Directory.Data })).size;
        } catch {
            return null;
        }
    },

    async writeBlob(rel, blob) {
        // The first chunk creates (or truncates) the file, the others append
        let offset = 0;
        do {
            const end = Math.min(offset + WRITE_CHUNK_BYTES, blob.size);
            const data = toBase64(new Uint8Array(await blob.slice(offset, end).arrayBuffer()));
            if (offset === 0) {
                await Filesystem.writeFile({ path: rel, data, directory: Directory.Data, recursive: true });
            } else {
                await Filesystem.appendFile({ path: rel, data, directory: Directory.Data });
            }
            offset = end;
        } while (offset < blob.size);
        return blob.size;
    },

    async copyFrom(source, rel) {
        await makeParent(rel);
        await Filesystem.copy({ from: source, to: rel, toDirectory: Directory.Data });
        return (await Filesystem.stat({ path: rel, directory: Directory.Data })).size;
    },

    async rename(from, to) {
        await makeParent(to);
        await Filesystem.rename({ from, to, directory: Directory.Data, toDirectory: Directory.Data });
    },

    async remove(rel) {
        await Filesystem.deleteFile({ path: rel, directory: Directory.Data }).catch((e) => unlessGone(rel, e));
    },

    async removeDir(rel) {
        await Filesystem.rmdir({ path: rel, directory: Directory.Data, recursive: true })
            .catch((e) => unlessGone(rel, e));
    },

    async list(rel) {
        try {
            return (await Filesystem.readdir({ path: rel, directory: Directory.Data })).files.map((f) => f.name);
        } catch (e) {
            await unlessGone(rel, e);
            return [];
        }
    },
};
