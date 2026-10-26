import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";
import { createSyncEnv, installLocalStorage, resetMocks, type SyncEnv } from "../testing/syncTestKit";
import { OdooRpcClient, syncSessionKey, type SyncCredentials } from "../services/odoo/odooRpcClient";
import { OutboxService } from "../services/outboxService";
import { CapabilityService } from "../services/odoo/capabilityService";
import { ChatService, type ChatSource } from "../services/chat/chatService";
import { CHAT_NOTE, CHAT_POST, CHAT_UPLOAD } from "../services/chat/chatOutbox";
import {
  CACHE_WARN_RATIO, LAST_PURGE_KEY, PREVIEW_PX, PREVIEWS_AT_ONCE, PURGE_EVERY_MS,
} from "../services/chat/chatAttachmentCache";
import { setChatSettings, chatSettings } from "../services/chat/chatSettings";
import { setAttachmentSettings } from "../services/attachmentService";
import { originalPath, outgoingPath, previewPath, sourceDir } from "../services/chat/chatFiles";
import type { DownloadAnswer, DownloadRequest } from "../services/chat/chatFiles";
import type { BusNotification, ChatAttachment, ChatMessage } from "../models/chat";
import { fakeChatHttp, memoryChatFiles } from "../testing/chatFakes";

const ALICE = { url: "https://odoo.example.com", username: "alice", password: "pw", database: "db1" };
const BOB = { url: "https://odoo.example.com", username: "bob", password: "pw", database: "db1" };
const MB = 1024 * 1024;
/** A preview of 400 KB: whole bytes, so the sums stay exact. */
const P = 400 * 1024;
const MEMORY_ROOT = "file:///memory/files/";

const sha1 = (bytes: Uint8Array) => createHash("sha1").update(bytes).digest("hex");
const bytesOf = (text: string) => new TextEncoder().encode(text);

/** One transfer held on the wire until released (or cancelled). */
interface Held { id: string; url: string; release: () => void; reject: (e: unknown) => void }

/**
 * The /web/image and /web/content side of a fake Odoo, over memory files:
 * originals and previews by attachment id; `missing` answers 404 for
 * "image:<id>" or "content:<id>"; `holding` writes a partial file at the
 * target and keeps the transfer until release or cancel; `badSha` reports
 * a SHA-1 that matches nothing.
 */
function fileServer(files: ReturnType<typeof memoryChatFiles>) {
  const s = {
    originals: new Map<number, Uint8Array>(),
    previews: new Map<number, Uint8Array>(),
    missing: new Set<string>(),
    holding: false,
    badSha: false,
    held: [] as Held[],
  };
  const download = async (r: DownloadRequest): Promise<DownloadAnswer> => {
    const m = /^\/web\/(image|content)\/(\d+)/.exec(new URL(r.url).pathname)!;
    const kind = m[1];
    const id = Number(m[2]);
    const rel = decodeURI(r.uri.slice(MEMORY_ROOT.length));
    if (s.holding) {
      files.put(rel, new Uint8Array([1]));
      await new Promise<void>((release, reject) => s.held.push({ id: r.id, url: r.url, release, reject }));
    }
    const bytes = (kind === "image" ? s.previews : s.originals).get(id);
    if (!bytes || s.missing.has(`${kind}:${id}`)) return { status: 404, size: 0, sha1: null, mimetype: null };
    files.put(rel, bytes);
    return {
      status: 200, size: bytes.length, sha1: s.badSha ? "0".repeat(40) : sha1(bytes),
      mimetype: kind === "image" ? "image/png" : "application/octet-stream",
    };
  };
  const http = fakeChatHttp({
    download,
    cancel: (id) => {
      const h = s.held.find((x) => x.id === id);
      s.held = s.held.filter((x) => x !== h);
      h?.reject(Object.assign(new Error("cancelled"), { code: "CANCELLED" }));
    },
  });
  const releaseNext = () => s.held.shift()?.release();
  return { s, http, releaseNext, downloads: () => http.calls.filter((c) => c.kind === "download") };
}

/** Lets the pending promise callbacks run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

/** Answers a re-authentication (the first 404 of a transfer logs in again). */
function odooAuth() {
  let next = 2;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const headers = new Headers();
    let result: object = { uid: 2 };
    if (url.endsWith("/web/session/authenticate")) {
      headers.append("set-cookie", `session_id=sid${next++}; Path=/; HttpOnly`);
      result = { uid: 2, server_version_info: [18, 0, 0, "final", 0] };
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200, headers });
  }));
}

describe("ChatAttachmentCache", () => {
  let env: SyncEnv;
  let chat: ChatService;
  let outbox: OutboxService;
  let clock: Date;
  let files: ReturnType<typeof memoryChatFiles>;
  let server: ReturnType<typeof fileServer>;
  let wifi: boolean;
  let src: ChatSource;
  let config: string;

  const sourceOf = (i: number): ChatSource => ({
    configId: env.configIds[i], creds: env.creds[i], app: {} as any, label: `s${i}`,
  });

  /** A server attachment of channel 7 (or `over.channelId`) as the bus or a load stores it. */
  const stored = async (id: number, over: Partial<ChatAttachment> = {}, configId = config): Promise<ChatAttachment> => {
    const bytes = bytesOf(`original ${id}`);
    server.s.originals.set(id, bytes);
    server.s.previews.set(id, bytesOf(`thumb ${id}`));
    await chat.repo.applyDelta(configId, {
      channels: [], deletedChannelIds: [], members: [], deletedMemberIds: [], messages: [], partners: [],
      inboxCounter: null, selfPartnerId: null, deletedAttachmentIds: [],
      attachments: [{
        attachmentId: id, channelId: over.channelId ?? 7, name: over.name ?? `f${id}.png`,
        mimetype: over.mimetype ?? "image/png", size: bytes.length, checksum: sha1(bytes), voice: over.voice ?? false,
      }],
    });
    return (await chat.repo.attachment(configId, id))!;
  };

  /** Records cached files of `bytes` on a stored attachment, as a download would. */
  const cached = async (id: number, o: { original?: number; preview?: number; opened?: string }, configId = config) => {
    const dir = await chat.repo.fileDirOf(configId);
    if (o.original) {
      const path = originalPath(dir, id, `f${id}.png`);
      files.put(path, new Uint8Array([id]));
      await chat.repo.setOriginal(configId, id, path, o.original);
    }
    if (o.preview) {
      const path = previewPath(dir, id);
      files.put(path, new Uint8Array([id]));
      await chat.repo.setPreview(configId, id, path, o.preview);
    }
    if (o.opened) await chat.repo.touchOpened(configId, id, o.opened);
  };

  /** A file of a post still to be sent, on disk under out/. */
  const outgoing = async (localUuid: string, over: Partial<ChatAttachment> = {}): Promise<ChatAttachment> => {
    const dir = await chat.repo.fileDirOf(config);
    const path = outgoingPath(dir, localUuid, "photo.jpg");
    files.put(path, bytesOf(`unsent ${localUuid}`));
    const row: ChatAttachment = {
      configId: config, channelId: 7, messageId: null, attachmentId: null, localUuid, postClientUuid: "post-1",
      seq: 0, name: "photo.jpg", mimetype: "image/jpeg", size: 1000, checksum: null, voice: false,
      thumbPath: null, thumbBytes: 0, originalPath: path, originalBytes: 1000, state: "queued", error: null,
      lastOpenedAt: null, createdAt: "2026-10-26T10:00:00.000Z", ...over,
    };
    await chat.repo.putOutgoing([row]);
    return row;
  };

  const queuedMessage = (clientUuid: string, status: "pending" | "failed"): ChatMessage => ({
    configId: config, channelId: 7, messageId: null, clientUuid, authorPartnerId: 3, body: "<p>hi</p>",
    date: "2026-10-26 10:00:00", messageType: "comment", status, outboxOpId: null, writeDate: null,
  });

  beforeEach(async () => {
    resetMocks();
    installLocalStorage();
    clock = new Date("2026-10-26T10:00:00.000Z");
    wifi = true;
    env = await createSyncEnv([ALICE, BOB]);
    const rpc = new OdooRpcClient();
    outbox = new OutboxService(env.db, () => clock);
    chat = new ChatService(env.db, rpc, outbox, new CapabilityService(env.db, rpc), () => clock);
    files = memoryChatFiles();
    server = fileServer(files);
    chat.useFileIO({ files, http: server.http, onWifi: async () => wifi });
    for (const creds of env.creds as SyncCredentials[]) {
      await SecureStoragePlugin.set({
        key: syncSessionKey(creds),
        value: JSON.stringify({ sessionId: "sid1", odooMajorVersion: 18, createdAt: clock.toISOString() }),
      });
    }
    config = env.configIds[0];
    src = sourceOf(0);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("preview fetches the sized image with unique and download, two at a time", async () => {
    const atts = [];
    for (const id of [1, 2, 3, 4]) atts.push(await stored(id));
    server.s.holding = true;
    const asked = atts.map((a) => chat.attachments.preview(src, a));
    await vi.waitFor(() => expect(server.downloads()).toHaveLength(PREVIEWS_AT_ONCE));
    await settle();
    expect(server.downloads()).toHaveLength(2);
    // The newest request goes first once a slot frees
    server.releaseNext();
    await vi.waitFor(() => expect(server.downloads()).toHaveLength(3));
    server.releaseNext();
    await vi.waitFor(() => expect(server.downloads()).toHaveLength(4));
    server.s.holding = false;
    server.releaseNext();
    server.releaseNext();
    const paths = await Promise.all(asked);
    const urls = server.downloads().map((c) => new URL(c.url));
    expect(urls.map((u) => u.pathname)).toEqual([1, 2, 4, 3].map((id) => `/web/image/${id}/${PREVIEW_PX}x${PREVIEW_PX}`));
    expect(urls[0].searchParams.get("unique")).toBe(atts[0].checksum);
    expect(urls.every((u) => u.searchParams.get("download") === "true")).toBe(true);
    const ids = server.downloads().map((c) => c.id);
    expect(new Set(ids).size).toBe(4);
    const dir = await chat.repo.fileDirOf(config);
    expect(paths).toEqual([1, 2, 3, 4].map((id) => previewPath(dir, id)));
    expect(files.bytes(previewPath(dir, 1))).toEqual(bytesOf("thumb 1"));
    expect((await chat.repo.attachment(config, 1))!.thumbBytes).toBe(bytesOf("thumb 1").length);
    // Cached now: no request
    expect(await chat.attachments.preview(src, (await chat.repo.attachment(config, 1))!)).toBe(previewPath(dir, 1));
    expect(server.downloads()).toHaveLength(4);
  });

  it("a 404 preview caches nothing and offers retry", async () => {
    odooAuth();
    const att = await stored(5);
    server.s.missing.add("image:5");
    expect(await chat.attachments.preview(src, att)).toBeNull();
    const dir = await chat.repo.fileDirOf(config);
    expect(files.bytes(previewPath(dir, 5))).toBeUndefined();
    expect((await chat.repo.attachment(config, 5))!.thumbPath).toBeNull();
    expect(chat.attachments.previewFailed(att)).toBe(true);
    const calls = server.downloads().length;
    // Failed: not asked again until a retry
    expect(await chat.attachments.preview(src, att)).toBeNull();
    expect(server.downloads()).toHaveLength(calls);
    server.s.missing.clear();
    expect(await chat.attachments.retryPreview(src, att)).toBe(previewPath(dir, 5));
    expect(chat.attachments.previewFailed(att)).toBe(false);
    expect(files.bytes(previewPath(dir, 5))).toEqual(bytesOf("thumb 5"));
  });

  it("open downloads, checks sha1, counts the bytes", async () => {
    const att = await stored(7, { name: "report.pdf", mimetype: "application/pdf" });
    const dir = await chat.repo.fileDirOf(config);
    const opened = await chat.attachments.open(src, att);
    expect(opened).toEqual({ kind: "ready", path: originalPath(dir, 7, "report.pdf") });
    const [call] = server.downloads();
    const url = new URL(call.url);
    expect(url.pathname).toBe("/web/content/7");
    expect(url.searchParams.get("unique")).toBe(att.checksum);
    expect(url.searchParams.get("download")).toBe("true");
    expect(files.bytes(originalPath(dir, 7, "report.pdf"))).toEqual(bytesOf("original 7"));
    const row = (await chat.repo.attachment(config, 7))!;
    expect(row.originalBytes).toBe(bytesOf("original 7").length);
    expect(row.lastOpenedAt).toBe(clock.toISOString());
    expect(await chat.attachments.space(config, 7)).toBe(bytesOf("original 7").length);
    // Cached: opened again without a request, its last use stamped
    clock = new Date("2026-10-26T11:00:00.000Z");
    expect(await chat.attachments.open(src, row)).toEqual(opened);
    expect(server.downloads()).toHaveLength(1);
    expect((await chat.repo.attachment(config, 7))!.lastOpenedAt).toBe(clock.toISOString());
  });

  it("a recorded original missing on disk is downloaded again; one gone from the server is gone", async () => {
    const att = await stored(8);
    const dir = await chat.repo.fileDirOf(config);
    // As a sent file whose move into files/ was cut: recorded, not on disk
    await chat.repo.setOriginal(config, 8, originalPath(dir, 8, "f8.png"), 99);
    expect(await chat.attachments.open(src, (await chat.repo.attachment(config, 8))!))
      .toEqual({ kind: "ready", path: originalPath(dir, 8, "f8.png") });
    expect(server.downloads()).toHaveLength(1);
    expect((await chat.repo.attachment(config, 8))!.originalBytes).toBe(bytesOf("original 8").length);

    odooAuth();
    const other = await stored(9);
    server.s.missing.add("content:9");
    expect(await chat.attachments.open(src, other)).toEqual({ kind: "gone" });
    expect(files.bytes(originalPath(dir, 9, "f9.png"))).toBeUndefined();
  });

  it("a sha1 mismatch keeps no file", async () => {
    const att = await stored(10);
    server.s.badSha = true;
    expect(await chat.attachments.open(src, att)).toEqual({ kind: "failed" });
    const dir = await chat.repo.fileDirOf(config);
    expect(files.bytes(originalPath(dir, 10, "f10.png"))).toBeUndefined();
    expect((await chat.repo.attachment(config, 10))!.originalPath).toBeNull();
    expect(await chat.attachments.space()).toBe(0);
  });

  it("wifi only waits for an original, voice included, never for a preview", async () => {
    setAttachmentSettings({ wifiOnly: true, maxMb: null });
    wifi = false;
    const voice = await stored(11, { name: "Voice-2026-10-26-123.mp3", mimetype: "audio/mpeg", voice: true });
    const image = await stored(12);
    expect(await chat.attachments.open(src, voice)).toEqual({ kind: "waiting_wifi" });
    expect(await chat.attachments.open(src, image)).toEqual({ kind: "waiting_wifi" });
    expect(chat.attachments.waitingWifi(voice)).toBe(true);
    expect(server.downloads()).toHaveLength(0);
    const dir = await chat.repo.fileDirOf(config);
    expect(await chat.attachments.preview(src, image)).toBe(previewPath(dir, 12));
    expect(server.downloads()).toHaveLength(1);
    // Still off Wi-Fi: nothing starts
    await chat.attachments.resumeWaiting();
    expect(server.downloads()).toHaveLength(1);
    wifi = true;
    await chat.flushAll();
    await chat.attachments.whenIdle();
    expect(server.downloads().map((c) => new URL(c.url).pathname).slice(1).sort()).toEqual(["/web/content/11", "/web/content/12"]);
    expect((await chat.repo.attachment(config, 11))!.originalPath).toBe(originalPath(dir, 11, voice.name));
    expect(chat.attachments.waitingWifi(voice)).toBe(false);
  });

  it("anyNetwork downloads one held original at once and only that one", async () => {
    setAttachmentSettings({ wifiOnly: true, maxMb: null });
    wifi = false;
    const a = await stored(13);
    const b = await stored(14);
    expect(await chat.attachments.open(src, a)).toEqual({ kind: "waiting_wifi" });
    expect(await chat.attachments.open(src, b)).toEqual({ kind: "waiting_wifi" });
    const dir = await chat.repo.fileDirOf(config);
    expect(await chat.attachments.open(src, a, { anyNetwork: true })).toEqual({ kind: "ready", path: originalPath(dir, 13, "f13.png") });
    expect(server.downloads().map((c) => new URL(c.url).pathname)).toEqual(["/web/content/13"]);
    expect(chat.attachments.waitingWifi(a)).toBe(false);
    expect(chat.attachments.waitingWifi(b)).toBe(true);
    await chat.attachments.resumeWaiting();
    await chat.attachments.whenIdle();
    expect(server.downloads()).toHaveLength(1);
  });

  it("a second open joins the running download; cancel leaves no file", async () => {
    const att = await stored(15);
    server.s.holding = true;
    const first = chat.attachments.open(src, att);
    const second = chat.attachments.open(src, att);
    await vi.waitFor(() => expect(server.downloads()).toHaveLength(1));
    const [call] = server.downloads();
    server.http.emit({ id: call.id!, done: 4, total: 10 });
    expect(chat.attachments.downloadProgress(att)).toEqual({ done: 4, total: 10 });
    await chat.attachments.cancel(att);
    expect(await first).toEqual({ kind: "failed" });
    expect(await second).toEqual({ kind: "failed" });
    const dir = await chat.repo.fileDirOf(config);
    expect(files.bytes(originalPath(dir, 15, "f15.png"))).toBeUndefined();
    expect((await chat.repo.attachment(config, 15))!.originalPath).toBeNull();
    expect(chat.attachments.downloadProgress(att)).toBeNull();
    // A new download takes a new transfer id
    server.s.holding = false;
    expect((await chat.attachments.open(src, att)).kind).toBe("ready");
    const ids = server.downloads().map((c) => c.id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("space per conversation and total", async () => {
    await stored(21);
    await stored(22);
    await stored(23, { channelId: 8 });
    await cached(21, { original: 100, preview: 10 });
    await cached(22, { original: 200 });
    await cached(23, { original: 1000 });
    await stored(21, {}, env.configIds[1]);
    await cached(21, { original: 5 }, env.configIds[1]);
    await outgoing("u1");
    expect(await chat.attachments.space(config, 7)).toBe(310 + 1000);
    expect(await chat.attachments.space(config, 8)).toBe(1000);
    expect(await chat.attachments.space(config)).toBe(2310);
    expect(await chat.attachments.space()).toBe(2315);
  });

  it("purge and clear never touch an outgoing file", async () => {
    await stored(31);
    await cached(31, { original: 3 * MB, preview: MB });
    const queued = await outgoing("u1");
    const uploaded = await outgoing("u2", { state: "uploaded", attachmentId: 32 });
    setChatSettings({ ...chatSettings(), cachePurge: true, cacheLimitMb: 1 });
    await chat.attachments.purge();
    await chat.attachments.clear({ configId: config });
    await chat.attachments.clear({});
    for (const row of [queued, uploaded]) {
      expect(files.bytes(row.originalPath!)).toEqual(bytesOf(`unsent ${row.localUuid}`));
      expect((await chat.repo.outgoingFile(config, row.localUuid!))!.originalPath).toBe(row.originalPath);
    }
    expect((await chat.repo.attachment(config, 31))!.originalPath).toBeNull();
    expect(await chat.attachments.space()).toBe(2000);
  });

  it("a draft file survives purge, clear, the sweep and the startup sweep of staged files", async () => {
    await stored(31);
    await cached(31, { original: 3 * MB });
    const dir = await chat.repo.fileDirOf(config);
    const path = outgoingPath(dir, "d1", "IMG_20261026_101500.jpg");
    files.put(path, bytesOf("kept in the composer"));
    await chat.repo.putDraftFile({
      configId: config, channelId: 7, messageId: null, attachmentId: null, localUuid: "d1", postClientUuid: null,
      seq: 0, name: "IMG_20261026_101500.jpg", mimetype: "image/jpeg", size: 1000, checksum: null, voice: false,
      thumbPath: null, thumbBytes: 0, originalPath: path, originalBytes: 1000, state: "draft", error: null,
      lastOpenedAt: null, createdAt: clock.toISOString(),
    });
    setChatSettings({ ...chatSettings(), cachePurge: true, cacheLimitMb: 1 });
    await chat.attachments.purge();
    await chat.attachments.clear({ configId: config });
    // No op names it and no message holds it: only its draft row keeps it
    await chat.recover();
    expect(files.bytes(path)).toEqual(bytesOf("kept in the composer"));
    expect((await chat.repo.draftOf(config, 7)).files.map((f) => [f.localUuid, f.originalPath])).toEqual([["d1", path]]);
    expect((await chat.repo.attachment(config, 31))!.originalPath).toBeNull();
    expect(await chat.attachments.space(config)).toBe(1000);
  });

  it("clear empties one conversation or everything, rows kept", async () => {
    await stored(41);
    await stored(42, { channelId: 8 });
    await cached(41, { original: 10, preview: 1 });
    await cached(42, { original: 20, preview: 2 });
    await chat.attachments.clear({ configId: config, channelId: 7 });
    expect(await chat.attachments.space(config, 7)).toBe(0);
    expect(await chat.attachments.space(config, 8)).toBe(22);
    const dir = await chat.repo.fileDirOf(config);
    expect(files.bytes(originalPath(dir, 41, "f41.png"))).toBeUndefined();
    expect(files.bytes(previewPath(dir, 41))).toBeUndefined();
    expect(await chat.repo.attachment(config, 41)).not.toBeNull();
    await chat.attachments.clear({});
    expect(await chat.attachments.space()).toBe(0);
    expect(files.bytes(previewPath(dir, 42))).toBeUndefined();
  });

  it("purge off removes nothing; on frees least recently opened originals, then previews, under the limit", async () => {
    for (const id of [51, 52, 53]) await stored(id);
    await cached(51, { original: MB, preview: P, opened: "2026-10-20T00:00:00.000Z" });
    await cached(52, { original: MB, preview: P, opened: "2026-10-19T00:00:00.000Z" });
    await cached(53, { original: MB, preview: P, opened: "2026-10-24T00:00:00.000Z" });
    setChatSettings({ ...chatSettings(), cachePurge: false, cacheLimitMb: 3 });
    expect(await chat.attachments.purge()).toEqual({ freed: 0 });
    expect(await chat.attachments.space()).toBe(3 * MB + 3 * P);

    setChatSettings({ ...chatSettings(), cachePurge: true, cacheLimitMb: 3 });
    expect(await chat.attachments.purge()).toEqual({ freed: 2 * MB });
    const originals = async () => {
      const out: number[] = [];
      for (const id of [51, 52, 53]) if ((await chat.repo.attachment(config, id))!.originalPath) out.push(id);
      return out;
    };
    expect(await originals()).toEqual([53]);
    const dir = await chat.repo.fileDirOf(config);
    expect(files.bytes(originalPath(dir, 52, "f52.png"))).toBeUndefined();
    expect(files.bytes(originalPath(dir, 53, "f53.png"))).toBeDefined();
    expect(localStorage.getItem(LAST_PURGE_KEY)).toBe(clock.toISOString());

    // Originals first, then previews from the least recently opened
    setChatSettings({ ...chatSettings(), cacheLimitMb: 1 });
    expect(await chat.attachments.purge()).toEqual({ freed: MB + P });
    expect(await originals()).toEqual([]);
    expect((await chat.repo.attachment(config, 52))!.thumbPath).toBeNull();
    expect((await chat.repo.attachment(config, 51))!.thumbPath).not.toBeNull();
    expect(await chat.attachments.space()).toBe(2 * P);
  });

  it("maybePurge runs once per 24 h", async () => {
    await stored(61);
    setChatSettings({ ...chatSettings(), cachePurge: true, cacheLimitMb: 1 });
    await cached(61, { original: 2 * MB });
    expect((await chat.attachments.maybePurge())?.freed).toBe(2 * MB);
    await cached(61, { original: 2 * MB });
    clock = new Date(clock.getTime() + PURGE_EVERY_MS - 1000);
    expect(await chat.attachments.maybePurge()).toBeNull();
    expect(await chat.attachments.space()).toBe(2 * MB);
    clock = new Date(clock.getTime() + 1000);
    expect((await chat.attachments.maybePurge())?.freed).toBe(2 * MB);
    // Off: never
    setChatSettings({ ...chatSettings(), cachePurge: false });
    await cached(61, { original: 2 * MB });
    clock = new Date(clock.getTime() + 2 * PURGE_EVERY_MS);
    expect(await chat.attachments.maybePurge()).toBeNull();
    expect(await chat.attachments.space()).toBe(2 * MB);
  });

  it("a purge asked while one runs joins it", async () => {
    await stored(62);
    setChatSettings({ ...chatSettings(), cachePurge: true, cacheLimitMb: 1 });
    await cached(62, { original: 2 * MB });
    const first = chat.attachments.maybePurge();
    const second = chat.attachments.maybePurge();
    const third = chat.attachments.purge();
    const results = await Promise.all([first, second, third]);
    expect(results[1]).toBe(results[0]);
    expect(results[2]).toBe(results[0]);
    expect(results[0]).toEqual({ freed: 2 * MB });
    // Settled: the next one starts afresh
    expect(await chat.attachments.purge()).toEqual({ freed: 0 });
  });

  it("warning at 80 % even with purge off", async () => {
    expect(CACHE_WARN_RATIO).toBe(0.8);
    setChatSettings({ ...chatSettings(), cachePurge: false, cacheLimitMb: 10 });
    await stored(71);
    await cached(71, { original: Math.round(7.9 * MB) });
    expect(await chat.attachments.warning()).toBe(false);
    await cached(71, { original: 8 * MB });
    expect(await chat.attachments.warning()).toBe(true);
  });

  it("erasing an account removes its directory", async () => {
    const other = env.configIds[1];
    await stored(81);
    await cached(81, { original: 10, preview: 1 });
    await outgoing("u1");
    await stored(81, {}, other);
    await cached(81, { original: 10 }, other);
    const dir = await chat.repo.fileDirOf(config);
    const otherDir = await chat.repo.fileDirOf(other);
    const removed: string[] = [];
    const removeDir = files.removeDir;
    files.removeDir = async (rel) => {
      removed.push(rel);
      return removeDir(rel);
    };
    await chat.forgetSource(config);
    expect(removed).toContain(sourceDir(dir));
    expect(files.bytes(originalPath(dir, 81, "f81.png"))).toBeUndefined();
    expect(files.bytes(outgoingPath(dir, "u1", "photo.jpg"))).toBeUndefined();
    expect(files.bytes(originalPath(otherDir, 81, "f81.png"))).toBeDefined();
    expect(await chat.attachments.space(config)).toBe(0);
    expect(await chat.attachments.space(other)).toBe(10);
  });

  it("sweep removes outgoing files nothing needs", async () => {
    const op = await outbox.enqueue({ noteId: CHAT_NOTE, configId: config, kind: CHAT_POST, params: { channelId: 7, text: "" } });
    const upload = await outbox.enqueue({
      noteId: CHAT_NOTE, configId: config, kind: CHAT_UPLOAD, params: { channelId: 7, localUuid: "running" },
    });
    await chat.repo.applyDelta(config, {
      channels: [{ channelId: 7, channelType: "group", name: "Team", isMember: true }], deletedChannelIds: [], members: [],
      deletedMemberIds: [], messages: [], partners: [], inboxCounter: null, selfPartnerId: null, attachments: [], deletedAttachmentIds: [],
    });
    await chat.repo.putPending(queuedMessage("post-left", "failed"));
    await chat.repo.putPending(queuedMessage("post-failed", "failed"));
    const orphan = await outgoing("orphan", { postClientUuid: "post-cancelled" });
    const queued = await outgoing("queued", { postClientUuid: op.clientUuid });
    const running = await outgoing("running", { postClientUuid: "post-cancelled", state: "refused", error: "left" });
    const left = await outgoing("left", { postClientUuid: "post-left", state: "refused", error: "left" });
    const sentWithout = await outgoing("toobig", { postClientUuid: "post-settled", state: "refused", error: "too_big" });
    const failed = await outgoing("failed", { postClientUuid: "post-failed" });
    expect(upload.params.localUuid).toBe(running.localUuid);
    const removed: string[] = [];
    const removeDir = files.removeDir;
    files.removeDir = async (rel) => {
      removed.push(rel);
      return removeDir(rel);
    };
    await chat.recover();
    const row = (uuid: string) => chat.repo.outgoingFile(config, uuid);
    // Nothing needs them: rows and files go, their out/ directory too
    for (const r of [orphan, sentWithout]) {
      expect(await row(r.localUuid!)).toBeNull();
      expect(files.bytes(r.originalPath!)).toBeUndefined();
      expect(removed).toContain(r.originalPath!.slice(0, r.originalPath!.lastIndexOf("/")));
    }
    // Refused by the conversation: the file goes, the row stays beside its failed text
    expect((await row("left"))!.originalPath).toBeNull();
    expect(files.bytes(left.originalPath!)).toBeUndefined();
    // An op still names them, or a failed text of a listed conversation holds them
    for (const r of [queued, running, failed]) {
      expect((await row(r.localUuid!))!.originalPath).toBe(r.originalPath);
      expect(files.bytes(r.originalPath!)).toBeDefined();
    }
    expect(await chat.attachments.space(config)).toBe(3000);
  });

  it("a bus attachment delete removes its files", async () => {
    await stored(91);
    await cached(91, { original: 10, preview: 1 });
    const dir = await chat.repo.fileDirOf(config);
    const bus: BusNotification = { id: 1, message: { type: "ir.attachment/delete", payload: { id: 91 } } };
    await chat.applyBus(config, [bus]);
    expect(await chat.repo.attachment(config, 91)).toBeNull();
    expect(files.bytes(originalPath(dir, 91, "f91.png"))).toBeUndefined();
    expect(files.bytes(previewPath(dir, 91))).toBeUndefined();
  });

  it("a download landing after the attachment was deleted keeps no file", async () => {
    const att = await stored(95);
    server.s.holding = true;
    const opening = chat.attachments.open(src, att);
    await vi.waitFor(() => expect(server.downloads()).toHaveLength(1));
    await chat.repo.deleteAttachments(config, [95]);
    server.s.holding = false;
    server.releaseNext();
    expect(await opening).toEqual({ kind: "gone" });
    const dir = await chat.repo.fileDirOf(config);
    expect(files.bytes(originalPath(dir, 95, "f95.png"))).toBeUndefined();
  });

  it("a file still on its way opens from out/ and asks the server nothing", async () => {
    const uploaded = await outgoing("u2", { state: "uploaded", attachmentId: 32 });
    setAttachmentSettings({ wifiOnly: true, maxMb: null });
    wifi = false;
    expect(await chat.attachments.open(src, uploaded)).toEqual({ kind: "ready", path: uploaded.originalPath });
    expect(await chat.attachments.preview(src, uploaded)).toBeNull();
    expect(chat.attachments.waitingWifi(uploaded)).toBe(false);
    expect(server.downloads()).toHaveLength(0);
  });

  it("recover removes staged out/ directories no row names", async () => {
    const dir = await chat.repo.fileDirOf(config);
    const staged = outgoingPath(dir, "staged", "big.mp4");
    files.put(staged, bytesOf("picked, never sent"));
    const queued = await outgoing("u1", { postClientUuid: (await outbox.enqueue({
      noteId: CHAT_NOTE, configId: config, kind: CHAT_POST, params: { channelId: 7, text: "" },
    })).clientUuid });
    // A sent file whose move into files/ failed: posted, still under out/
    await stored(33);
    const kept = outgoingPath(dir, "sent", "photo.jpg");
    files.put(kept, bytesOf("sent"));
    await chat.repo.setOriginal(config, 33, kept, 4);
    await env.db.rawRun("UPDATE chat_attachments SET local_uuid = ? WHERE attachment_id = ?", ["sent", 33]);
    const otherDir = await chat.repo.fileDirOf(env.configIds[1]);
    const otherStaged = outgoingPath(otherDir, "staged2", "a.jpg");
    files.put(otherStaged, bytesOf("other"));
    await chat.recover();
    expect(files.bytes(staged)).toBeUndefined();
    expect(files.bytes(otherStaged)).toBeUndefined();
    expect(files.bytes(queued.originalPath!)).toBeDefined();
    expect(files.bytes(kept)).toBeDefined();
    expect(await files.list(`${sourceDir(dir)}/out`)).toEqual(expect.arrayContaining(["u1", "sent"]));
    expect(await files.list(`${sourceDir(dir)}/out`)).toHaveLength(2);
  });

  it("erase stops a running preview and a download not yet started; nothing recreates the account", async () => {
    const thumb = await stored(34);
    const original = await stored(35);
    server.s.holding = true;
    const previewing = chat.attachments.preview(src, thumb);
    await vi.waitFor(() => expect(server.downloads()).toHaveLength(1));
    // The open waits on the network check while the account is erased
    setAttachmentSettings({ wifiOnly: true, maxMb: null });
    let answer!: (on: boolean) => void;
    chat.attachments["onWifi"] = () => new Promise<boolean>((r) => { answer = r; });
    const opening = chat.attachments.open(src, original);
    await vi.waitFor(() => expect(answer).toBeDefined());
    await chat.forgetSource(config);
    expect(server.http.calls.filter((c) => c.kind === "cancel").map((c) => c.id)).toEqual([server.downloads()[0].id]);
    expect(await previewing).toBeNull();
    answer(true);
    expect((await opening).kind).not.toBe("ready");
    await chat.attachments.whenIdle();
    expect(server.downloads()).toHaveLength(1);
    expect(await chat.repo.hasSourceState(config)).toBe(false);
  });

  it("release deletes only files under chat/", async () => {
    files.put("notes/x.jpg", bytesOf("note"));
    await chat.attachments.release(["notes/x.jpg", "/data/x.jpg"]);
    expect(files.bytes("notes/x.jpg")).toBeDefined();
  });

  it("a conversation is named with its account", async () => {
    await expect(chat.attachments.space(undefined, 7)).rejects.toThrow(/account/);
    await expect(chat.attachments.clear({ channelId: 7 })).rejects.toThrow(/account/);
  });
});
