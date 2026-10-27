import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";
import { createSyncEnv, installLocalStorage, resetMocks, type SyncEnv } from "../testing/syncTestKit";
import { OdooRpcClient, syncSessionKey, type SyncCredentials } from "../services/odoo/odooRpcClient";
import { OutboxService } from "../services/outboxService";
import { CapabilityService } from "../services/odoo/capabilityService";
import { ChatService, type ChatSource } from "../services/chat/chatService";
import { AVATARS_AT_ONCE, avatarHue, avatarUrlPath } from "../services/chat/chatAvatars";
import { previewPath } from "../services/chat/chatFiles";
import type { DownloadAnswer, DownloadRequest } from "../services/chat/chatFiles";
import { fakeChatHttp, memoryChatFiles } from "../testing/chatFakes";

const ALICE = { url: "https://odoo.example.com", username: "alice", password: "pw", database: "db1" };
const BOB = { url: "https://odoo.example.com", username: "bob", password: "pw", database: "db1" };
const MEMORY_ROOT = "file:///memory/files/";
const KEY = "2026-10-20 08:00:00";
const SVG = new TextEncoder().encode("<?xml version='1.0' encoding='UTF-8' ?><svg height='180' width='180'></svg>");

const settle = () => new Promise((r) => setTimeout(r, 0));

/**
 * The /web/image/res.partner side of a fake Odoo: an SVG for every partner
 * (Odoo's placeholder of a partner without a photo), a PNG for those in
 * `png`; `status` answers that status for every request; `holding` keeps
 * each transfer until released.
 */
function avatarServer(files: ReturnType<typeof memoryChatFiles>) {
  const s = { png: new Set<number>(), status: 200, holding: false, held: [] as (() => void)[] };
  const download = async (r: DownloadRequest): Promise<DownloadAnswer> => {
    const id = Number(/^\/web\/image\/res\.partner\/(\d+)\/avatar_128$/.exec(new URL(r.url).pathname)![1]);
    if (s.holding) await new Promise<void>((release) => s.held.push(release));
    if (s.status !== 200) return { status: s.status, size: 0, sha1: null, mimetype: null };
    const bytes = s.png.has(id) ? new Uint8Array([137, 80, 78, 71, id]) : SVG;
    files.put(decodeURI(r.uri.slice(MEMORY_ROOT.length)), bytes);
    return { status: 200, size: bytes.length, sha1: null, mimetype: s.png.has(id) ? "image/png" : "image/svg+xml" };
  };
  const http = fakeChatHttp({ download, cancel: () => {} });
  return { s, http, downloads: () => http.calls.filter((c) => c.kind === "download") };
}

describe("ChatAvatars", () => {
  let env: SyncEnv;
  let chat: ChatService;
  let files: ReturnType<typeof memoryChatFiles>;
  let server: ReturnType<typeof avatarServer>;
  let src: ChatSource;
  let config: string;
  const clock = new Date("2026-10-26T10:00:00.000Z");

  beforeEach(async () => {
    resetMocks();
    installLocalStorage();
    env = await createSyncEnv([ALICE, BOB]);
    const rpc = new OdooRpcClient();
    chat = new ChatService(env.db, rpc, new OutboxService(env.db, () => clock), new CapabilityService(env.db, rpc), () => clock);
    files = memoryChatFiles();
    server = avatarServer(files);
    chat.useFileIO({ files, http: server.http, onWifi: async () => false });
    for (const creds of env.creds as SyncCredentials[]) {
      await SecureStoragePlugin.set({
        key: syncSessionKey(creds),
        value: JSON.stringify({ sessionId: "sid1", odooMajorVersion: 18, createdAt: clock.toISOString() }),
      });
    }
    config = env.configIds[0];
    src = { configId: config, creds: env.creds[0], app: {} as any, label: "s0" };
  });
  afterEach(() => vi.unstubAllGlobals());

  it("the URL is the browser's avatarUrl, its write date as unique, download=true", () => {
    expect(avatarUrlPath(8, KEY)).toBe("/web/image/res.partner/8/avatar_128?unique=2026-10-20%2008%3A00%3A00&download=true");
    expect(avatarUrlPath(8, "")).toBe("/web/image/res.partner/8/avatar_128?download=true");
  });

  it("the initials' hue comes from the partner id, the same every time", () => {
    expect(avatarHue(8)).toBe(avatarHue(8));
    expect(avatarHue(8)).not.toBe(avatarHue(9));
    for (const id of [1, 8, 9, 1000, 123457]) expect(avatarHue(id)).toBeGreaterThanOrEqual(0);
    for (const id of [1, 8, 9, 1000, 123457]) expect(avatarHue(id)).toBeLessThan(360);
  });

  it("fetches with the session, keeps the file under the account's directory with its type, and its bytes in SQLite", async () => {
    server.s.png.add(9);
    const svg = await chat.avatars.fetch(src, 8, KEY);
    const png = await chat.avatars.fetch(src, 9, KEY);
    const dir = await chat.repo.fileDirOf(config);
    expect(svg).toBe(`chat/${dir}/avatars/8_20261020080000.svg`);
    expect(png).toBe(`chat/${dir}/avatars/9_20261020080000.png`);
    expect(files.bytes(svg!)).toEqual(SVG);
    const [call] = server.downloads();
    expect(call.url).toBe(`https://odoo.example.com${avatarUrlPath(8, KEY)}`);
    expect(call.headers.Cookie).toBe("session_id=sid1");
    expect(await chat.repo.avatars(config)).toEqual([
      { configId: config, partnerId: 8, uniqueKey: KEY, path: svg, bytes: SVG.length, fetchedAt: clock.toISOString() },
      { configId: config, partnerId: 9, uniqueKey: KEY, path: png, bytes: 5, fetchedAt: clock.toISOString() },
    ]);
  });

  it("runs two at a time, one fetch per partner and key however many ask", async () => {
    server.s.holding = true;
    const asked = [8, 8, 9, 9, 10, 11, 8].map((id) => chat.avatars.fetch(src, id, KEY));
    await vi.waitFor(() => expect(server.downloads()).toHaveLength(AVATARS_AT_ONCE));
    await settle();
    expect(server.downloads()).toHaveLength(2);
    server.s.holding = false;
    for (const release of server.s.held.splice(0)) release();
    const paths = await Promise.all(asked);
    expect(paths[0]).toBe(paths[1]);
    expect(paths[0]).toBe(paths[6]);
    expect(server.downloads()).toHaveLength(4);
    // Cached with its key: asked again, nothing goes to the server
    expect(await chat.avatars.fetch(src, 8, KEY)).toBe(paths[0]);
    expect(server.downloads()).toHaveLength(4);
  });

  it("a changed key fetches again, the old file released", async () => {
    const first = await chat.avatars.fetch(src, 8, KEY);
    const next = await chat.avatars.fetch(src, 8, "2026-10-21 09:00:00");
    expect(next).not.toBe(first);
    expect(server.downloads()).toHaveLength(2);
    expect(server.downloads()[1].url).toContain("unique=2026-10-21%2009%3A00%3A00");
    expect(files.bytes(first!)).toBeUndefined();
    expect((await chat.repo.avatars(config)).map((a) => [a.uniqueKey, a.path])).toEqual([["2026-10-21 09:00:00", next]]);
  });

  it("a recorded file missing on disk is fetched again", async () => {
    const path = await chat.avatars.fetch(src, 8, KEY);
    await files.remove(path!);
    expect(await chat.avatars.fetch(src, 8, KEY)).toBe(path);
    expect(server.downloads()).toHaveLength(2);
  });

  it("a failure answers null and keeps nothing; asked again, it is fetched again", async () => {
    server.s.status = 500;
    expect(await chat.avatars.fetch(src, 8, KEY)).toBeNull();
    expect(await chat.repo.avatars(config)).toEqual([]);
    const dir = await chat.repo.fileDirOf(config);
    expect(await files.list(`chat/${dir}/avatars`)).toEqual([]);
    server.s.status = 200;
    expect(await chat.avatars.fetch(src, 8, KEY)).not.toBeNull();
    expect(server.downloads()).toHaveLength(2);
  });

  it("an erase stops the account's fetches: nothing is recorded for it", async () => {
    server.s.holding = true;
    const asked = chat.avatars.fetch(src, 8, KEY);
    await vi.waitFor(() => expect(server.downloads()).toHaveLength(1));
    await chat.forgetSource(config);
    server.s.holding = false;
    for (const release of server.s.held.splice(0)) release();
    expect(await asked).toBeNull();
    expect(await chat.repo.avatars(config)).toEqual([]);
  });

  it("forgetSource removes the account's avatars and their files, the other account's stay", async () => {
    const bob: ChatSource = { configId: env.configIds[1], creds: env.creds[1], app: {} as any, label: "s1" };
    const mine = await chat.avatars.fetch(src, 8, KEY);
    const theirs = await chat.avatars.fetch(bob, 8, KEY);
    await chat.forgetSource(config);
    expect(files.bytes(mine!)).toBeUndefined();
    expect(files.bytes(theirs!)).toEqual(SVG);
    expect(await chat.repo.avatars(env.configIds[1])).toHaveLength(1);
  });

  it("the chat's space counts the avatars, a conversation's does not, and « clear all » removes them", async () => {
    const path = await chat.avatars.fetch(src, 8, KEY);
    const dir = await chat.repo.fileDirOf(config);
    await chat.repo.applyDelta(config, {
      channels: [], deletedChannelIds: [], members: [], deletedMemberIds: [], messages: [], partners: [],
      inboxCounter: null, selfPartnerId: null, deletedAttachmentIds: [],
      attachments: [{ attachmentId: 1, channelId: 7, name: "a.png", mimetype: "image/png", size: 10, checksum: null, voice: false }],
    });
    files.put(previewPath(dir, 1), new Uint8Array(300));
    await chat.repo.setPreview(config, 1, previewPath(dir, 1), 300);
    expect(await chat.attachments.space()).toBe(300 + SVG.length);
    expect(await chat.attachments.space(config)).toBe(300 + SVG.length);
    expect(await chat.attachments.space(config, 7)).toBe(300);
    await chat.attachments.clear({});
    expect(await chat.attachments.space()).toBe(0);
    expect(await chat.repo.avatars(config)).toEqual([]);
    await chat.attachments.whenIdle();
    expect(files.bytes(path!)).toBeUndefined();
  });
});
