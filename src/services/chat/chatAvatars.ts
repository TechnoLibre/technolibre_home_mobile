import { v4 as uuidv4 } from "uuid";
import { avatarBasePath, type ChatFiles } from "./chatFiles";
import type { ChatRepository } from "./chatRepository";
import type { ChatSource } from "./chatSources";
import type { ChatTransfer } from "./chatTransfer";

/** Avatars downloaded side by side. */
export const AVATARS_AT_ONCE = 2;

/** The extension a cached avatar takes by its type: the web view serves a file by its name, and an SVG is drawn only as image/svg+xml. */
const EXTENSIONS: Record<string, string> = {
  "image/svg+xml": ".svg",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

/**
 * The server path of a partner's avatar: the browser's `avatarUrl`
 * (`persona_model.js`), `/web/image/res.partner/<id>/avatar_128` with the
 * partner's write date as `unique`, plus `download=true`, which makes a
 * record the session cannot read answer 404 instead of Odoo's
 * placeholder: an expired session (read as the public user) then logs in
 * again rather than caching the placeholder.
 */
export function avatarUrlPath(partnerId: number, uniqueKey: string): string {
  const unique = uniqueKey ? `unique=${encodeURIComponent(uniqueKey)}&` : "";
  return `/web/image/res.partner/${partnerId}/avatar_128?${unique}download=true`;
}

/** The hue (0 to 359) of a partner's initials background: the same for a partner on every screen. */
export function avatarHue(partnerId: number): number {
  return Math.abs(Math.imul(partnerId, 2654435761) >> 0) % 360;
}

interface Job {
  key: string;
  src: ChatSource;
  partnerId: number;
  uniqueKey: string;
  generation: number;
  promise: Promise<string | null>;
  resolve: (path: string | null) => void;
}

/**
 * The authors' avatars on the phone, one file per partner and account
 * under the account's chat directory (`avatars/`), its row in chat_avatars
 * (ChatRepository) with the `unique` key it was fetched with and its bytes.
 *
 * fetch() answers the cached file when its key is the one asked and it is
 * still on disk, else downloads it with the account's session
 * (ChatTransfer), AVATARS_AT_ONCE at a time, the newest request first,
 * whatever the network. One download per partner and key runs at a time:
 * a second ask joins it. A failure (offline, refused, any error) caches
 * nothing and answers null; nothing is remembered of it, so the caller
 * decides when to ask again. The new file replaces the old one, whose file
 * the repository releases. erase() stops an account's downloads: what
 * they bring is not recorded.
 */
export class ChatAvatars {
  private jobs = new Map<string, Job>();
  /** Jobs waiting for a slot, the newest last. */
  private queue: Job[] = [];
  private running = 0;
  /** Transfers on the wire: transfer id → account, so an erase stops them. */
  private transfers = new Map<string, string>();
  /** Per account, the count erase() moves: a download begun before it records nothing. */
  private generations = new Map<string, number>();
  private work = new Set<Promise<unknown>>();

  constructor(
    private repo: ChatRepository,
    private files: ChatFiles,
    private transfer: ChatTransfer,
    private now: () => Date = () => new Date(),
  ) {}

  /** The path of the partner's avatar with uniqueKey on the phone, fetched when needed; null when it could not be. */
  fetch(src: ChatSource, partnerId: number, uniqueKey: string): Promise<string | null> {
    const key = `${src.configId}#${partnerId}#${uniqueKey}`;
    const known = this.jobs.get(key);
    if (known) {
      const i = this.queue.indexOf(known);
      if (i >= 0) this.queue.push(...this.queue.splice(i, 1));
      return known.promise;
    }
    let resolve!: (path: string | null) => void;
    const promise = new Promise<string | null>((r) => { resolve = r; });
    const job: Job = { key, src, partnerId, uniqueKey, generation: this.generationOf(src.configId), promise, resolve };
    this.jobs.set(key, job);
    this.queue.push(job);
    this.pump();
    return promise;
  }

  /** Stops the account's downloads and forgets its queued ones; the files and rows are the caller's to drop. */
  async erase(configId: string): Promise<void> {
    this.generations.set(configId, this.generationOf(configId) + 1);
    for (const job of this.queue.filter((j) => j.src.configId === configId)) {
      this.queue.splice(this.queue.indexOf(job), 1);
      this.jobs.delete(job.key);
      job.resolve(null);
    }
    for (const [id, owner] of [...this.transfers]) {
      if (owner === configId) await this.transfer.cancel(id).catch((e) => console.warn("chat: avatar cancel failed", e));
    }
  }

  /** Resolves once no download runs. */
  async whenIdle(): Promise<void> {
    while (this.work.size > 0) await Promise.allSettled([...this.work]);
  }

  private pump(): void {
    while (this.running < AVATARS_AT_ONCE && this.queue.length > 0) {
      const job = this.queue.pop()!;
      this.running += 1;
      const run = this.run(job).catch((e: unknown) => {
        console.warn("chat: avatar not fetched", e);
        return null;
      }).then((path) => {
        this.jobs.delete(job.key);
        this.running -= 1;
        job.resolve(path);
        this.pump();
      });
      const settled = run.then(() => undefined);
      this.work.add(settled);
      void settled.then(() => this.work.delete(settled));
    }
  }

  private async run(job: Job): Promise<string | null> {
    const { configId } = job.src;
    const stored = (await this.repo.avatars(configId)).find((a) => a.partnerId === job.partnerId);
    if (stored?.uniqueKey === job.uniqueKey && (await this.files.size(stored.path)) !== null) return stored.path;
    if (this.generationOf(configId) !== job.generation) return null;
    const base = avatarBasePath(await this.repo.fileDirOf(configId), job.partnerId, job.uniqueKey);
    if (this.generationOf(configId) !== job.generation) return null;
    const transferId = `av-${uuidv4()}`;
    this.transfers.set(transferId, configId);
    let path = base;
    try {
      const answer = await this.transfer.download(job.src.creds, {
        id: transferId, urlPath: avatarUrlPath(job.partnerId, job.uniqueKey), path: base,
      });
      path = base + (EXTENSIONS[answer.mimetype ?? ""] ?? "");
      if (path !== base) await this.files.rename(base, path);
      if (this.generationOf(configId) !== job.generation) {
        await this.removeQuietly(path);
        return null;
      }
      await this.repo.putAvatar({
        configId, partnerId: job.partnerId, uniqueKey: job.uniqueKey, path, bytes: answer.size,
        fetchedAt: this.now().toISOString(),
      });
      return path;
    } catch (e: unknown) {
      await this.removeQuietly(base);
      if (path !== base) await this.removeQuietly(path);
      console.warn(`chat: avatar of partner ${job.partnerId} not fetched`, e);
      return null;
    } finally {
      this.transfers.delete(transferId);
    }
  }

  private generationOf(configId: string): number {
    return this.generations.get(configId) ?? 0;
  }

  private async removeQuietly(path: string): Promise<void> {
    await this.files.remove(path).catch((e) => console.warn("chat: a partial avatar was not deleted", e));
  }
}
