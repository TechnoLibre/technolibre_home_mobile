import { v4 as uuidv4 } from "uuid";
import type { ChatAttachment } from "../../models/chat";
import { attachmentSettings } from "../attachmentService";
import type { OutboxOp } from "../databaseService";
import { RequestNotSentError } from "../odoo/odooRpcClient";
import { originalPath, previewPath, sourceDir, type ChatFiles, type TransferProgress } from "./chatFiles";
import { attachmentKey, type ChatRepository } from "./chatRepository";
import { chatSettings } from "./chatSettings";
import type { ChatSource } from "./chatSources";
import { ChatTransferCancelledError, ChatTransferRefusedError, type ChatTransfer } from "./chatTransfer";

/** The chat's files reach this share of the cache limit: the options and the list warn. */
export const CACHE_WARN_RATIO = 0.8;
/** maybePurge runs when the last purge is at least this old. */
export const PURGE_EVERY_MS = 24 * 60 * 60 * 1000;
/** Previews downloaded side by side. */
export const PREVIEWS_AT_ONCE = 2;
/** Side of the box a preview fits in, as /web/image/<id>/<w>x<h> resizes it. */
export const PREVIEW_PX = 512;
/** localStorage key of the last purge's time (ISO). */
export const LAST_PURGE_KEY = "chat.cache.lastPurgeAt";

const MB = 1024 * 1024;

/** What names one server attachment of one account. */
export type AttachmentRef = Pick<ChatAttachment, "configId" | "attachmentId">;

/**
 * How open() ends: the original's path; held until Wi-Fi (Wi-Fi only and
 * off Wi-Fi); gone from the server; failed (network, a SHA-1 that does not
 * match the attachment's checksum, a cancel).
 */
export type OpenResult =
  | { kind: "ready"; path: string }
  | { kind: "waiting_wifi" }
  | { kind: "gone" }
  | { kind: "failed" };

interface PreviewJob {
  key: string;
  src: ChatSource;
  att: ChatAttachment;
  promise: Promise<string | null>;
  resolve: (path: string | null) => void;
}

interface Download {
  configId: string;
  transferId: string;
  done: number;
  total: number | null;
}

const refKey = (a: AttachmentRef): string => `${a.configId}#${a.attachmentId}`;

/** The query of a file URL: `unique` busts Odoo's cache on a new version, `download=true` makes an error a 404. */
function fileQuery(checksum: string | null): string {
  return checksum ? `unique=${encodeURIComponent(checksum)}&download=true` : "download=true";
}

/** The directory a file owns alone (`out/<uuid>/`, `files/<id>/`), removed with it; null for a preview. */
function ownDir(path: string): string | null {
  return /\/(out|files)\/[^/]+\/[^/]+$/.test(path) ? path.slice(0, path.lastIndexOf("/")) : null;
}

/**
 * The attachments' files on the phone, over the rows of ChatRepository
 * (paths and bytes in SQLite, never a folder walk):
 *
 * - Previews (`/web/image/<id>/512x512`) download whatever the network,
 *   PREVIEWS_AT_ONCE at a time, the newest request first. A preview that
 *   fails caches nothing and is not asked again until retryPreview; one
 *   that never reached the server (offline) is asked again at the next
 *   preview().
 * - Originals (`/web/content/<id>`) download on open(): the native side
 *   writes a `.part` file renamed when complete, then the SHA-1 is checked
 *   against the attachment's checksum. With Wi-Fi only and off Wi-Fi, every
 *   original waits (voice included) until resumeWaiting() finds Wi-Fi, or
 *   until open(…, {anyNetwork: true}) takes that one file now. A second
 *   open of a file being downloaded joins the download.
 * - space(), warning(), clear(), purge() count every chat byte of the phone
 *   (the files waiting to be sent too) and free only the files of posted
 *   rows: a file an outbox op reads is never touched.
 * - sweep() drops the files of the phone nothing needs any more;
 *   erase() removes an account's directory.
 *
 * Transfer ids are unique per transfer (the native side refuses one in use).
 */
export class ChatAttachmentCache {
  /** The account's outbox ops, for sweep(); ChatService sets it. Unset, sweep() does nothing. */
  opsOf: ((configId: string) => Promise<OutboxOp[]>) | null = null;

  private previewJobs = new Map<string, PreviewJob>();
  /** Previews waiting for a slot, the newest last. */
  private previewQueue: PreviewJob[] = [];
  private previewsRunning = 0;
  private previewFailures = new Set<string>();

  /** open() calls under way, by attachment: a second one joins. */
  private opening = new Map<string, { promise: Promise<OpenResult>; anyNetwork: boolean }>();
  /** Originals on the wire, by attachment; by transfer id for the progress events. */
  private downloads = new Map<string, Download>();
  private byTransfer = new Map<string, Download>();
  /** Originals held for Wi-Fi, by attachment. */
  private waiting = new Map<string, { src: ChatSource; att: ChatAttachment }>();

  /** Work still settling, for whenIdle. */
  private work = new Set<Promise<unknown>>();
  private progressSource: ((fn: (p: TransferProgress) => void) => () => void) | null = null;
  private progressOff: (() => void) | null = null;

  constructor(
    private repo: ChatRepository,
    private files: ChatFiles,
    private transfer: ChatTransfer,
    private onWifi: () => Promise<boolean>,
    private now: () => Date = () => new Date(),
  ) {}

  // ─── Previews ─────────────────────────────────────────────────────────────

  /**
   * The cached preview's path, or the preview fetched to previewPath; null
   * when it failed (previewFailed), when it never reached the server, or
   * for a file without a server id.
   */
  preview(src: ChatSource, att: ChatAttachment): Promise<string | null> {
    if (att.attachmentId === null) return Promise.resolve(null);
    const key = refKey(att);
    if (this.previewFailures.has(key)) return Promise.resolve(null);
    const known = this.previewJobs.get(key);
    if (known) {
      // Asked again: the newest request again
      const i = this.previewQueue.indexOf(known);
      if (i >= 0) this.previewQueue.push(...this.previewQueue.splice(i, 1));
      return known.promise;
    }
    if (att.thumbPath) {
      const path = att.thumbPath;
      return this.files.size(path).then((size) =>
        size !== null ? path : this.enqueuePreview(src, { ...att, thumbPath: null }));
    }
    return this.enqueuePreview(src, att);
  }

  /** Whether the attachment's preview failed and waits for retryPreview. */
  previewFailed(att: AttachmentRef): boolean {
    return this.previewFailures.has(refKey(att));
  }

  /** Forgets a failed preview and fetches it again. */
  retryPreview(src: ChatSource, att: ChatAttachment): Promise<string | null> {
    this.previewFailures.delete(refKey(att));
    return this.preview(src, att);
  }

  private enqueuePreview(src: ChatSource, att: ChatAttachment): Promise<string | null> {
    const key = refKey(att);
    const known = this.previewJobs.get(key);
    if (known) return known.promise;
    let resolve!: (path: string | null) => void;
    const promise = new Promise<string | null>((r) => { resolve = r; });
    const job: PreviewJob = { key, src, att, promise, resolve };
    this.previewJobs.set(key, job);
    this.previewQueue.push(job);
    this.pumpPreviews();
    return promise;
  }

  private pumpPreviews(): void {
    while (this.previewsRunning < PREVIEWS_AT_ONCE && this.previewQueue.length > 0) {
      const job = this.previewQueue.pop()!;
      this.previewsRunning += 1;
      this.track(this.runPreview(job).catch((e: unknown) => {
        console.warn("chat: preview failed", e);
        return null;
      }).then((path) => {
        // Out of the map before it resolves: a caller acting on the answer starts afresh
        this.previewJobs.delete(job.key);
        this.previewsRunning -= 1;
        job.resolve(path);
        this.pumpPreviews();
      }));
    }
  }

  private async runPreview(job: PreviewJob): Promise<string | null> {
    const { configId } = job.att;
    const id = job.att.attachmentId!;
    const row = await this.repo.attachment(configId, id);
    if (!row) return null;
    if (row.thumbPath) {
      if ((await this.files.size(row.thumbPath)) !== null) return row.thumbPath;
      await this.repo.clearFiles([attachmentKey(configId, id)], "preview");
    }
    const path = previewPath(await this.repo.fileDirOf(configId), id);
    try {
      const answer = await this.transfer.download(job.src.creds, {
        id: `pv-${uuidv4()}`,
        urlPath: `/web/image/${id}/${PREVIEW_PX}x${PREVIEW_PX}?${fileQuery(row.checksum)}`,
        path,
      });
      await this.repo.setPreview(configId, id, path, answer.size);
      if (!(await this.repo.attachment(configId, id))) {
        // Deleted while on the wire: nothing names the file
        await this.removeQuietly(path);
        return null;
      }
      return path;
    } catch (e: unknown) {
      await this.removeQuietly(path);
      if (!(e instanceof RequestNotSentError) && !(e instanceof ChatTransferCancelledError)) {
        this.previewFailures.add(job.key);
      }
      return null;
    }
  }

  // ─── Originals ────────────────────────────────────────────────────────────

  /**
   * The original of an attachment: the cached file when it is still on
   * disk (its last use stamped), else held for Wi-Fi (attachmentSettings()
   * wifiOnly, off Wi-Fi, not anyNetwork), else downloaded to originalPath.
   * A recorded file missing on disk (a sent file whose move into files/
   * was cut) is forgotten and downloaded. A file of the phone without a
   * server id opens from where it waits to be sent.
   */
  open(src: ChatSource, att: ChatAttachment, opts: { anyNetwork?: boolean } = {}): Promise<OpenResult> {
    const anyNetwork = !!opts.anyNetwork;
    if (att.attachmentId === null) return this.openLocal(att);
    const key = refKey(att);
    const known = this.opening.get(key);
    if (known) {
      if (known.anyNetwork || !anyNetwork) return known.promise;
      return known.promise.then((r) => (r.kind === "waiting_wifi" ? this.open(src, att, opts) : r));
    }
    const promise: Promise<OpenResult> = this.openNow(src, att, anyNetwork).finally(() => {
      if (this.opening.get(key)?.promise === promise) this.opening.delete(key);
    });
    this.opening.set(key, { promise, anyNetwork });
    this.track(promise);
    return promise;
  }

  /** Whether the attachment's original waits for Wi-Fi. */
  waitingWifi(att: AttachmentRef): boolean {
    return this.waiting.has(refKey(att));
  }

  /**
   * Starts the originals held for Wi-Fi once they may go (on Wi-Fi, or
   * Wi-Fi only turned off); resolves when they ended. ChatService.flushAll
   * calls it without waiting.
   */
  resumeWaiting(): Promise<void> {
    const run = (async () => {
      if (this.waiting.size === 0) return;
      if (attachmentSettings().wifiOnly && !(await this.onWifi())) return;
      await Promise.all([...this.waiting.values()].map(({ src, att }) => this.open(src, att)));
    })();
    this.track(run);
    return run;
  }

  /** Bytes of the original received so far while it downloads, else null. */
  downloadProgress(att: AttachmentRef): { done: number; total: number | null } | null {
    const d = this.downloads.get(refKey(att));
    return d ? { done: d.done, total: d.total } : null;
  }

  /** Stops the original's download (open() then answers failed and keeps no file) and forgets its Wi-Fi hold. */
  async cancel(att: AttachmentRef): Promise<void> {
    const key = refKey(att);
    this.waiting.delete(key);
    const d = this.downloads.get(key);
    if (d) await this.transfer.cancel(d.transferId);
  }

  /** Resolves once no preview, download or resumeWaiting runs. */
  async whenIdle(): Promise<void> {
    while (this.work.size > 0) await Promise.allSettled([...this.work]);
  }

  /** The transport's progress events, followed from the first download; replaces the previous source. */
  setProgressSource(source: ((fn: (p: TransferProgress) => void) => () => void) | null): void {
    this.progressOff?.();
    this.progressOff = null;
    this.progressSource = source;
  }

  private async openLocal(att: ChatAttachment): Promise<OpenResult> {
    const row = att.localUuid ? await this.repo.outgoingFile(att.configId, att.localUuid) : null;
    if (row?.originalPath && (await this.files.size(row.originalPath)) !== null) {
      return { kind: "ready", path: row.originalPath };
    }
    return { kind: "failed" };
  }

  private async openNow(src: ChatSource, att: ChatAttachment, anyNetwork: boolean): Promise<OpenResult> {
    const { configId } = att;
    const id = att.attachmentId!;
    const key = refKey(att);
    const row = await this.repo.attachment(configId, id);
    if (!row) {
      this.waiting.delete(key);
      return { kind: "gone" };
    }
    if (row.originalPath) {
      if ((await this.files.size(row.originalPath)) !== null) {
        this.waiting.delete(key);
        await this.repo.touchOpened(configId, id, this.now().toISOString());
        return { kind: "ready", path: row.originalPath };
      }
      await this.repo.clearFiles([attachmentKey(configId, id)], "original");
    }
    if (!anyNetwork && attachmentSettings().wifiOnly && !(await this.onWifi())) {
      this.waiting.set(key, { src, att: row });
      return { kind: "waiting_wifi" };
    }
    this.waiting.delete(key);
    return this.download(src, row);
  }

  private async download(src: ChatSource, row: ChatAttachment): Promise<OpenResult> {
    const { configId } = row;
    const id = row.attachmentId!;
    const key = refKey(row);
    const path = originalPath(await this.repo.fileDirOf(configId), id, row.name);
    const d: Download = { configId, transferId: `dl-${uuidv4()}`, done: 0, total: row.size || null };
    this.watchProgress();
    // Registered and started in one step: a cancel() from here on finds the transfer running
    this.downloads.set(key, d);
    this.byTransfer.set(d.transferId, d);
    const transfer = this.transfer.download(src.creds, {
      id: d.transferId,
      urlPath: `/web/content/${id}?${fileQuery(row.checksum)}`,
      path,
    });
    try {
      const answer = await transfer;
      if (row.checksum && (answer.sha1 ?? "").toLowerCase() !== row.checksum.toLowerCase()) {
        console.warn(`chat: attachment ${id} downloaded with another checksum; not kept`);
        await this.removeQuietly(path);
        return { kind: "failed" };
      }
      await this.repo.setOriginal(configId, id, path, answer.size);
      await this.repo.touchOpened(configId, id, this.now().toISOString());
      if (!(await this.repo.attachment(configId, id))) {
        // Deleted while on the wire (the server, an erase): nothing names the file
        await this.removeQuietly(path);
        return { kind: "gone" };
      }
      return { kind: "ready", path };
    } catch (e: unknown) {
      await this.removeQuietly(path);
      if (e instanceof ChatTransferRefusedError && e.reason === "not_found") return { kind: "gone" };
      if (!(e instanceof ChatTransferCancelledError)) console.warn(`chat: attachment ${id} not downloaded`, e);
      return { kind: "failed" };
    } finally {
      if (this.downloads.get(key) === d) this.downloads.delete(key);
      this.byTransfer.delete(d.transferId);
    }
  }

  private watchProgress(): void {
    if (this.progressOff || !this.progressSource) return;
    this.progressOff = this.progressSource((p) => {
      const d = this.byTransfer.get(p.id);
      if (!d) return;
      d.done = p.done;
      if (p.total !== null) d.total = p.total;
    });
  }

  // ─── Space ────────────────────────────────────────────────────────────────

  /** Bytes of the chat's files on the phone (cached and waiting to be sent), per conversation, account or in all. */
  space(configId?: string, channelId?: number): Promise<number> {
    return this.repo.attachmentBytes(configId, channelId);
  }

  /** Whether the chat's files reach CACHE_WARN_RATIO of the limit, the purge on or off. */
  async warning(): Promise<boolean> {
    return (await this.repo.attachmentBytes()) >= CACHE_WARN_RATIO * chatSettings().cacheLimitMb * MB;
  }

  /** Removes the cached originals and previews of one conversation, one account or all; the rows stay. */
  async clear(scope: { configId?: string; channelId?: number }): Promise<void> {
    const keys = (await this.repo.cachedRows())
      .filter((a) => scope.configId === undefined || a.configId === scope.configId)
      .filter((a) => scope.channelId === undefined || a.channelId === scope.channelId)
      .map((a) => attachmentKey(a.configId, a.attachmentId!));
    if (keys.length > 0) await this.repo.clearFiles(keys, "both");
  }

  /**
   * With cachePurge on and the chat's files over cacheLimitMb: removes
   * cached originals, least recently opened first, then previews in the
   * same order, until they are back at the limit. Stamps LAST_PURGE_KEY.
   * Returns the bytes freed (0 with the purge off).
   */
  async purge(): Promise<{ freed: number }> {
    const settings = chatSettings();
    if (!settings.cachePurge) return { freed: 0 };
    const limit = settings.cacheLimitMb * MB;
    let total = await this.repo.attachmentBytes();
    let freed = 0;
    const rows = await this.repo.cachedRows();
    for (const what of ["original", "preview"] as const) {
      for (const a of rows) {
        if (total <= limit) break;
        const bytes = what === "original" ? a.originalBytes : a.thumbBytes;
        if (bytes <= 0) continue;
        await this.repo.clearFiles([attachmentKey(a.configId, a.attachmentId!)], what);
        total -= bytes;
        freed += bytes;
      }
    }
    try {
      localStorage.setItem(LAST_PURGE_KEY, this.now().toISOString());
    } catch {
      // Not kept: the next maybePurge runs again
    }
    return { freed };
  }

  /**
   * purge() when it is on and the last one is PURGE_EVERY_MS old or more
   * (or none, or one stamped ahead of the clock); null when it did not run.
   */
  async maybePurge(): Promise<{ freed: number } | null> {
    if (!chatSettings().cachePurge) return null;
    let last = NaN;
    try {
      last = Date.parse(localStorage.getItem(LAST_PURGE_KEY) ?? "");
    } catch {
      // Unreadable: counts as never
    }
    const now = this.now().getTime();
    if (Number.isFinite(last) && last <= now && now - last < PURGE_EVERY_MS) return null;
    return this.purge();
  }

  // ─── Files nothing needs ──────────────────────────────────────────────────

  /**
   * Drops the account's files of the phone that no outbox op names (a post
   * by its client uuid, an upload by its local uuid): a row whose post has
   * no message left (cancelled, or sent without that file) or whose
   * conversation is no longer cached goes with its file; a file refused by
   * its conversation ("left", "channel") goes and its row stays beside the
   * failed text. Rows are read before the ops: a post queued meanwhile has
   * its op stored before its rows.
   */
  async sweep(configId: string): Promise<void> {
    if (!this.opsOf) return;
    const rows = await this.repo.outgoingRows(configId);
    if (rows.length === 0) return;
    const ops = await this.opsOf(configId);
    const posts = new Set(ops.map((o) => o.clientUuid));
    const uploads = new Set(ops.map((o) => o.params?.localUuid).filter((u): u is string => typeof u === "string"));
    const texts = await this.repo.queuedMessageUuids(configId);
    const channels = new Set((await this.repo.channels(configId)).map((c) => c.channelId));
    const drop: string[] = [];
    const free: string[] = [];
    for (const r of rows) {
      if (!r.localUuid || uploads.has(r.localUuid) || (r.postClientUuid && posts.has(r.postClientUuid))) continue;
      const shown = r.postClientUuid !== null && texts.has(r.postClientUuid) && channels.has(r.channelId);
      if (!shown) drop.push(r.localUuid);
      else if (r.state === "refused" && (r.error === "left" || r.error === "channel") && r.originalPath) free.push(r.localUuid);
    }
    if (drop.length > 0) await this.release(await this.repo.deleteOutgoing(configId, drop));
    if (free.length > 0) await this.release(await this.repo.releaseOutgoing(configId, free));
  }

  /**
   * Removes an account's chat directory (`chat/<fileDir>`): its downloads
   * stop, its queued previews and Wi-Fi holds are forgotten. The rows are
   * the caller's to drop.
   */
  async erase(configId: string): Promise<void> {
    for (const d of [...this.downloads.values()].filter((x) => x.configId === configId)) {
      await this.transfer.cancel(d.transferId).catch((e) => console.warn("chat: download cancel failed", e));
    }
    for (const job of this.previewQueue.filter((j) => j.att.configId === configId)) {
      this.previewQueue.splice(this.previewQueue.indexOf(job), 1);
      this.previewJobs.delete(job.key);
      job.resolve(null);
    }
    const mine = (key: string) => key.startsWith(`${configId}#`);
    for (const key of [...this.waiting.keys()].filter(mine)) this.waiting.delete(key);
    for (const key of [...this.previewFailures].filter(mine)) this.previewFailures.delete(key);
    const fileDir = (await this.repo.sourceState(configId)).fileDir;
    if (fileDir) await this.files.removeDir(sourceDir(fileDir));
  }

  /**
   * Deletes released files (ChatRepository.onFilesReleased), with the
   * `out/<uuid>/` or `files/<id>/` directory each owns; a failed delete is
   * logged, the others still go.
   */
  async release(paths: string[]): Promise<void> {
    for (const path of paths) {
      try {
        await this.files.remove(path);
        const dir = ownDir(path);
        if (dir) await this.files.removeDir(dir);
      } catch (e: unknown) {
        console.warn("chat: a released file was not deleted", e);
      }
    }
  }

  private async removeQuietly(path: string): Promise<void> {
    await this.files.remove(path).catch((e) => console.warn("chat: a partial file was not deleted", e));
  }

  private track(p: Promise<unknown>): void {
    const settled = p.then(() => undefined, () => undefined);
    this.work.add(settled);
    void settled.then(() => this.work.delete(settled));
  }
}
