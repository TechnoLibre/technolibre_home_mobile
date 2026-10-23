import { Directory, Filesystem } from "@capacitor/filesystem";
import type { Note } from "../models/note";
import { networkService } from "./networkService";

/** localStorage key of the attachment settings. */
const SETTINGS_KEY = "options.sync.attachments";

/**
 * When the note's photos, recordings and videos are sent with it:
 * wifiOnly holds them back on a mobile network (sent on the next push on
 * Wi-Fi); maxMb (null: no limit) leaves out a file larger than it.
 */
export interface AttachmentSettings {
  wifiOnly: boolean;
  maxMb: number | null;
}

export const DEFAULT_ATTACHMENTS: AttachmentSettings = { wifiOnly: false, maxMb: null };

/**
 * Largest file ever sent, whatever the settings: read whole and sent as
 * base64 (a third larger) in one request, a bigger one would exhaust the
 * app's memory and exceed the server's request limit (128 MiB by default).
 */
export const MAX_ATTACHMENT_BYTES = 90 * 1024 * 1024;

/** The settings stored, or the defaults; unreadable storage counts as the defaults. */
export function attachmentSettings(): AttachmentSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null");
    if (!raw) return DEFAULT_ATTACHMENTS;
    const maxMb = raw.maxMb === null || raw.maxMb === undefined ? null : Number(raw.maxMb);
    return {
      wifiOnly: raw.wifiOnly === true,
      maxMb: maxMb !== null && Number.isFinite(maxMb) && maxMb > 0 ? maxMb : null,
    };
  } catch {
    return DEFAULT_ATTACHMENTS;
  }
}

export function setAttachmentSettings(settings: AttachmentSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Not kept: the defaults apply next time
  }
}

/** One media file of a note, as an attachment is created from it. */
export interface MediaFile {
  entryId: string;
  path: string;
  name: string;
  mimetype: string;
}

const MIMETYPES: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", heic: "image/heic",
  m4a: "audio/mp4", mp3: "audio/mpeg", aac: "audio/aac", wav: "audio/wav", ogg: "audio/ogg", webm: "audio/webm",
  mp4: "video/mp4", mov: "video/quicktime", "3gp": "video/3gpp",
};

/** The note's photo, audio and video entries that have a file, in entry order. */
export function mediaFiles(note: Note): MediaFile[] {
  const files: MediaFile[] = [];
  for (const entry of note.entries) {
    if (entry.type !== "photo" && entry.type !== "audio" && entry.type !== "video") continue;
    const path = String((entry.params as any).path ?? "");
    if (!path) continue;
    const name = decodeURIComponent(path.split("/").pop() || `${entry.type}-${entry.id}`);
    const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
    files.push({ entryId: entry.id, path, name, mimetype: MIMETYPES[ext] ?? "application/octet-stream" });
  }
  return files;
}

/** How files are read and the network is known: the device's, replaced in tests. */
export interface AttachmentIO {
  /** The file's size in bytes, null when it cannot be found. */
  size(path: string): Promise<number | null>;
  /** The file's content, base64. */
  read(path: string): Promise<string>;
  /** Whether the device is on Wi-Fi now. */
  onWifi(): Promise<boolean>;
}

/**
 * Where Filesystem finds an entry's file: a web view URL of a native file
 * (http://localhost/_capacitor_file_/…, as the video recorder gives) as
 * that file; an absolute path or file:// URI as is; a relative path (a
 * recording) under the app's data directory.
 */
export function resolveMediaPath(path: string): { path: string; directory?: Directory } {
  const web = path.match(/^https?:\/\/[^/]+\/_capacitor_file_(\/.*)$/);
  if (web) return { path: `file://${decodeURI(web[1])}` };
  if (/^(file|content):/.test(path) || path.startsWith("/")) return { path };
  return { path, directory: Directory.Data };
}

export const deviceAttachmentIO: AttachmentIO = {
  async size(path) {
    try {
      return Number((await Filesystem.stat(resolveMediaPath(path))).size);
    } catch {
      return null;
    }
  },
  async read(path) {
    const { data } = await Filesystem.readFile(resolveMediaPath(path));
    return typeof data === "string" ? data : await blobToBase64(data);
  },
  async onWifi() {
    return (await networkService.status()).connectionType === "wifi";
  },
};

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/**
 * Whether a file goes now: "send"; "wait" (Wi-Fi only and not on Wi-Fi:
 * the next push tries again); "missing" (the file cannot be found);
 * "too_big" (over the size limit, or MAX_ATTACHMENT_BYTES: left out until
 * the limit changes).
 */
export async function fileVerdict(
  file: MediaFile,
  settings: AttachmentSettings,
  io: AttachmentIO
): Promise<{ verdict: "send" | "wait" | "missing" | "too_big"; size: number | null }> {
  if (settings.wifiOnly && !(await io.onWifi())) return { verdict: "wait", size: null };
  const size = await io.size(file.path);
  if (size === null) return { verdict: "missing", size: null };
  const limit = Math.min(MAX_ATTACHMENT_BYTES, settings.maxMb !== null ? settings.maxMb * 1024 * 1024 : Infinity);
  if (size > limit) return { verdict: "too_big", size };
  return { verdict: "send", size };
}
