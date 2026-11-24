import { Camera } from "@capacitor/camera";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { v4 as uuidv4 } from "uuid";
import type { OutgoingFile } from "../../models/chat";
import { ChatFile } from "../../plugins/chatFilePlugin";
import type { ChatFiles } from "./chatFiles";
import { deviceChatFiles, outgoingPath, safeFileName } from "./chatFiles";
import { UPLOAD_SLACK_BYTES } from "./chatTransfer";

/** Where a pick comes from: the camera, the photo gallery, any file. */
export type PickKind = "camera" | "gallery" | "file";

/** A JPEG made from the image at from (file: URIs inside the chat directory). */
export interface JpegRequest {
    from: string;
    to: string;
    /** Long side bound in pixels; 0 keeps the size. */
    maxPx: number;
    /** JPEG quality, 0 to 100. */
    quality: number;
}

/** The JPEG written: bytes and pixel size. */
export interface JpegAnswer {
    size: number;
    width: number;
    height: number;
}

/** Image conversion: the native ChatFile plugin on the phone, a fake in tests. */
export interface ChatImages {
    toJpeg(req: JpegRequest): Promise<JpegAnswer>;
}

/** A staged file refused because the server would refuse it. */
export interface StageRefusal {
    refused: "too_big";
    /** The session's upload limit, in bytes. */
    limit: number;
}

type CameraPermissions = Pick<typeof Camera, "checkPermissions" | "requestPermissions">;

export interface CaptureDeps {
    files: ChatFiles;
    images: ChatImages;
    camera: CameraPermissions;
    /** Deletes the camera's own copy of a shot, by its file name. */
    removeCaptureTemp: (name: string) => Promise<void>;
    /** Deletes the chooser's empty files last modified before the given time (ms). */
    sweepCaptureTemps: (before: number) => Promise<void>;
}

/** Quality of the JPEG a HEIC/HEIF becomes, whatever the compression setting. */
export const HEIC_JPEG_QUALITY = 92;
/** Long side and quality of a compressed photo, as Odoo's own reduction. */
export const COMPRESS_MAX_PX = 1920;
export const COMPRESS_QUALITY = 80;

/**
 * Age under which a chooser file is left alone by the sweep: the file of
 * the shot being taken is created just after the click.
 */
export const CAPTURE_SWEEP_MARGIN_MS = 2000;

/** The name Capacitor's camera chooser gives its file (File.createTempFile). */
const CAPTURE_TEMP = /^JPEG_\d{8}_\d{6}_\d+\.jpg$/;

/** Images compress() converts; any other file passes unchanged. */
const COMPRESSIBLE = new Set(["image/jpeg", "image/png", "image/heic", "image/heif"]);

const MIMETYPES: Record<string, string> = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp",
    heic: "image/heic", heif: "image/heif", pdf: "application/pdf", txt: "text/plain", csv: "text/csv",
    mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", ogg: "audio/ogg", mp4: "video/mp4",
    zip: "application/zip", odt: "application/vnd.oasis.opendocument.text",
    ods: "application/vnd.oasis.opendocument.spreadsheet",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/**
 * The name the camera's chooser gives its temporary file
 * (`JPEG_<yyyyMMdd_HHmmss>_<digits>.jpg`), by the renamed File the pick
 * returns; stage() deletes that copy once the shot is staged. Module-wide,
 * as the File may be staged by another ChatCapture than the one that
 * picked it.
 */
const captureTemps = new WeakMap<File, string>();

function extensionOf(name: string): string {
    const dot = name.lastIndexOf(".");
    return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function stemOf(name: string): string {
    const dot = name.lastIndexOf(".");
    return dot > 0 ? name.slice(0, dot) : name;
}

/** The file's own type, else the one of its extension, else application/octet-stream. */
function mimetypeOf(file: File): string {
    return file.type || MIMETYPES[extensionOf(file.name)] || "application/octet-stream";
}

function isHeic(mimetype: string): boolean {
    return /^image\/hei[cf]/.test(mimetype);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** `IMG_<yyyyMMdd_HHmmss>.jpg` in local time, the camera apps' own pattern. */
export function cameraName(at: Date): string {
    const day = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}`;
    return `IMG_${day}_${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}.jpg`;
}

/** The directory part of a relative path. */
function dirOf(rel: string): string {
    return rel.slice(0, rel.lastIndexOf("/"));
}

/** Picks the input applies for kind: accept, capture and multiple. */
function configure(input: HTMLInputElement, kind: PickKind): void {
    input.type = "file";
    input.value = "";
    if (kind === "file") input.removeAttribute("accept");
    else input.setAttribute("accept", "image/*");
    if (kind === "camera") input.setAttribute("capture", "environment");
    else input.removeAttribute("capture");
    input.multiple = kind !== "camera";
}

/**
 * Deletes a shot the WebView's camera chooser left in the app's external
 * Pictures directory (Capacitor's BridgeWebChromeClient writes it there
 * through ACTION_IMAGE_CAPTURE and never removes it).
 */
async function removeDeviceCaptureTemp(name: string): Promise<void> {
    await Filesystem.deleteFile({ path: `Pictures/${name}`, directory: Directory.External });
}

/**
 * Deletes the empty chooser files (`JPEG_<date>_<time>_<digits>.jpg`, 0
 * bytes) last modified before `before` in the app's external Pictures
 * directory: what a cancelled camera shot leaves. A file with bytes is
 * never touched. Errors are swallowed: a missing directory is the usual
 * case.
 */
export async function sweepDeviceCaptureTemps(before: number): Promise<void> {
    let entries: { name: string; type: string; size: number; mtime: number }[];
    try {
        entries = (await Filesystem.readdir({ path: "Pictures", directory: Directory.External })).files;
    } catch {
        return;
    }
    for (const f of entries) {
        if (f.type !== "file" || f.size !== 0 || !(f.mtime < before) || !CAPTURE_TEMP.test(f.name)) continue;
        await Filesystem.deleteFile({ path: `Pictures/${f.name}`, directory: Directory.External }).catch(() => {});
    }
}

/**
 * Capture for the chat composer: picks through the WebView's own
 * `<input type=file>` (its camera chooser hands over the camera app's
 * file untouched, its pickers the chosen files' bytes), then stages each
 * pick under the account's `out/<localUuid>/` for the outbox.
 */
export class ChatCapture {
    private readonly deps: CaptureDeps;

    constructor(deps: Partial<CaptureDeps> = {}) {
        this.deps = {
            files: deviceChatFiles,
            images: ChatFile,
            camera: Camera,
            removeCaptureTemp: removeDeviceCaptureTemp,
            sweepCaptureTemps: sweepDeviceCaptureTemps,
            ...deps,
        };
    }

    /**
     * True when the camera may be used, asking the user only when it is
     * not granted yet. pickFiles() does not call it: answering the
     * system's dialog takes the page out of its tap's gesture (about 5 s
     * in Chromium), after which the WebView opens no picker and reports
     * nothing. It is for a caller that asks ahead, outside a pick.
     */
    async ensureCameraPermission(): Promise<boolean> {
        const granted = (s: string) => s === "granted" || s === "limited";
        if (granted((await this.deps.camera.checkPermissions()).camera)) return true;
        return granted((await this.deps.camera.requestPermissions({ permissions: ["camera"] })).camera);
    }

    /**
     * Opens the picker of kind through input and resolves with the files
     * chosen, in the picker's order; none when it is dismissed or the
     * camera is refused. The WebView opens a picker only within a user
     * gesture, so input.click() runs before any await: call this from the
     * tap's handler. Without the camera permission, the WebView's chooser
     * asks for it itself and keeps waiting for the answer; a refusal
     * dismisses the pick. A camera shot comes back named
     * `IMG_<yyyyMMdd_HHmmss>.jpg`, from its capture time. A camera pick
     * also sweeps, after the click, the empty files earlier cancelled shots
     * left (sweepCaptureTemps, older than CAPTURE_SWEEP_MARGIN_MS).
     */
    async pickFiles(input: HTMLInputElement, kind: PickKind): Promise<File[]> {
        const started = Date.now();
        configure(input, kind);
        const files = await new Promise<File[]>((resolve) => {
            const done = (files: File[]) => {
                input.removeEventListener("change", onChange);
                input.removeEventListener("cancel", onCancel);
                resolve(files);
            };
            const onChange = () => done(Array.from(input.files ?? []));
            const onCancel = () => done([]);
            input.addEventListener("change", onChange);
            input.addEventListener("cancel", onCancel);
            input.click();
            if (kind === "camera") {
                void this.deps.sweepCaptureTemps(started - CAPTURE_SWEEP_MARGIN_MS).catch(() => {});
            }
        });
        if (kind !== "camera") return files;
        return files.map((f) => {
            const at = new Date(f.lastModified || Date.now());
            const shot = new File([f], cameraName(at), { type: f.type || "image/jpeg", lastModified: f.lastModified });
            captureTemps.set(shot, f.name);
            return shot;
        });
    }

    /**
     * Copies file to `out/<localUuid>/<name>` of the account's directory,
     * by chunks (never whole in JS memory). A file the server would refuse
     * (size + UPLOAD_SLACK_BYTES over maxUploadSize) is refused before
     * anything is written. A HEIC/HEIF becomes a JPEG of the same size at
     * quality 92 named `.jpg`, refused if that JPEG passes the limit; one
     * the phone cannot decode (Android before 9) is kept as is. Nothing is
     * left on disk when staging fails or is refused. The camera's own copy
     * of a shot is deleted once the shot is staged or refused; a failed
     * staging keeps it, so the same File can be staged again.
     */
    async stage(fileDir: string, file: File, opts: { maxUploadSize: number }): Promise<OutgoingFile | StageRefusal> {
        const limit = opts.maxUploadSize;
        const fits = (size: number) => size + UPLOAD_SLACK_BYTES <= limit;
        const settle = async <T>(result: T): Promise<T> => {
            const temp = captureTemps.get(file);
            if (temp) await this.deps.removeCaptureTemp(temp).catch(() => {});
            return result;
        };
        if (!fits(file.size)) return settle({ refused: "too_big", limit });
        const { files } = this.deps;
        const localUuid = uuidv4();
        let staged: OutgoingFile = {
            localUuid,
            path: outgoingPath(fileDir, localUuid, file.name),
            name: safeFileName(file.name),
            mimetype: mimetypeOf(file),
            size: 0,
            voice: false,
        };
        const dir = dirOf(staged.path);
        try {
            staged.size = await files.writeBlob(staged.path, file);
            if (isHeic(staged.mimetype)) staged = await this.heicToJpeg(fileDir, staged);
        } catch (e) {
            await files.removeDir(dir).catch(() => {});
            throw e;
        }
        if (!fits(staged.size)) {
            await files.removeDir(dir).catch(() => {});
            return settle({ refused: "too_big", limit });
        }
        return settle(staged);
    }

    /**
     * The photo reduced to fit 1920 px at JPEG quality 80, replacing the
     * staged file (same localUuid, name ending in `.jpg`). Only JPEG, PNG
     * and HEIC/HEIF images are converted; any other file, a failed
     * conversion, or a JPEG the conversion does not make smaller comes back
     * unchanged. A PNG becomes a JPEG even when larger, its transparency
     * laid on white. The original is removed only once its replacement is
     * in place, and no step relies on a rename overwriting a file: a
     * failure at any step leaves the original as it was.
     */
    async compress(file: OutgoingFile): Promise<OutgoingFile> {
        if (!COMPRESSIBLE.has(file.mimetype)) return file;
        const { files } = this.deps;
        const dir = dirOf(file.path);
        // Siblings the app never names otherwise (safeFileName drops leading dots)
        const temp = `${dir}/.compress.jpg`;
        const aside = `${dir}/.original`;
        let answer: JpegAnswer;
        try {
            answer = await this.deps.images.toJpeg({
                from: await files.uri(file.path),
                to: await files.uri(temp),
                maxPx: COMPRESS_MAX_PX,
                quality: COMPRESS_QUALITY,
            });
        } catch {
            await files.remove(temp).catch(() => {});
            return file;
        }
        if (file.mimetype === "image/jpeg" && answer.size >= file.size) {
            await files.remove(temp);
            return file;
        }
        const name = safeFileName(`${stemOf(file.name)}.jpg`);
        const path = `${dir}/${name}`;
        try {
            if (path === file.path) {
                await files.rename(file.path, aside);
                try {
                    await files.rename(temp, path);
                } catch (e) {
                    await files.rename(aside, file.path);
                    throw e;
                }
                await files.remove(aside).catch(() => {});
            } else {
                await files.rename(temp, path);
                await files.remove(file.path).catch(() => {});
            }
        } catch {
            await files.remove(temp).catch(() => {});
            return file;
        }
        return { ...file, path, name, mimetype: "image/jpeg", size: answer.size };
    }

    /** staged converted to a JPEG beside it, the HEIC deleted; kept as is when it cannot be decoded. */
    private async heicToJpeg(fileDir: string, staged: OutgoingFile): Promise<OutgoingFile> {
        const { files } = this.deps;
        const name = safeFileName(`${stemOf(staged.name)}.jpg`);
        const path = outgoingPath(fileDir, staged.localUuid, name);
        let answer: JpegAnswer;
        try {
            answer = await this.deps.images.toJpeg({
                from: await files.uri(staged.path),
                to: await files.uri(path),
                maxPx: 0,
                quality: HEIC_JPEG_QUALITY,
            });
        } catch {
            await files.remove(path).catch(() => {});
            return staged;
        }
        // A HEIC already named .jpg is converted in place (toJpeg writes beside, then renames)
        if (path !== staged.path) await files.remove(staged.path);
        return { ...staged, path, name, mimetype: "image/jpeg", size: answer.size };
    }
}
