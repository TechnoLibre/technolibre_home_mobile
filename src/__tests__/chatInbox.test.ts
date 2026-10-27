import { describe, it, expect, beforeEach, vi } from "vitest";
import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";
import { DatabaseService, type NoteLink } from "../services/databaseService";
import { addChatTables } from "../services/migrations/addChatTables";
import { ChatRepository } from "../services/chat/chatRepository";

const opened = vi.hoisted(() => ({ openRecordInApp: vi.fn(async (_app: any) => {}) }));
vi.mock("../utils/openRecordInApp", () => opened);

import { ChatInbox, INBOX_PAGE, noteForRecord } from "../services/chat/chatInbox";
import { RequestNotSentError } from "../services/odoo/odooRpcClient";
import { mailboxKindOf } from "../models/chat";
import type { StoreDelta } from "../services/chat/chatStore";

const A = "https://odoo.example.com|alice|db1";
const B = "https://odoo.example.com|bob|db1";
const CACHED = 7;
const OTHER = 9;

const delta = (p: Partial<StoreDelta>): StoreDelta => ({
  channels: [], deletedChannelIds: [], members: [], deletedMemberIds: [], messages: [], partners: [], attachments: [], deletedAttachmentIds: [],
  inboxCounter: null, selfPartnerId: null, ...p,
});

const message = (id: number, thread: { id: number; model: string }, p: Record<string, any> = {}) => ({
  id, body: `<p>m${id}</p>`, date: `2026-10-26 10:00:${String(id % 60).padStart(2, "0")}`, message_type: "comment",
  author: { id: 4, type: "partner" }, thread, needaction: true, ...p,
});

const link = (p: Partial<NoteLink>): NoteLink => ({
  id: "l-" + Math.random(), noteId: "note-1", configId: A, model: "project.task", resId: 5, kind: "create",
  remoteState: "ok", createdAt: "2026-10-20T10:00:00.000Z", lastSyncedAt: null, ...p,
});

describe("noteForRecord", () => {
  it("a create link names the record by its own model and id", () => {
    const l = link({ noteId: "n-create" });
    expect(noteForRecord([l], A, "project.task", 5)).toBe(l);
    expect(noteForRecord([l], A, "project.task", 6)).toBeNull();
  });

  it("a message link names it by its params", () => {
    const l = link({ noteId: "n-msg", kind: "message", model: "mail.message", resId: 900, params: { resModel: "project.task", resId: 5 } });
    expect(noteForRecord([l], A, "project.task", 5)).toBe(l);
    expect(noteForRecord([l], A, "mail.message", 900)).toBeNull();
  });

  it("an activity link names it by its params", () => {
    const l = link({ noteId: "n-act", kind: "activity", model: "mail.activity", resId: 31, params: { resModel: "res.partner", resId: 70 } });
    expect(noteForRecord([l], A, "res.partner", 70)).toBe(l);
  });

  it("a dismissed link and another account's are ignored", () => {
    expect(noteForRecord([link({ remoteState: "dismissed" })], A, "project.task", 5)).toBeNull();
    expect(noteForRecord([link({ remoteState: "deleted" })], A, "project.task", 5)).toBeNull();
    expect(noteForRecord([link({ configId: B })], A, "project.task", 5)).toBeNull();
  });

  it("a create link wins over a newer message link, else the newest", () => {
    const created = link({ noteId: "n-create", createdAt: "2026-10-20T10:00:00.000Z" });
    const older = link({ noteId: "n-old", kind: "message", model: "mail.message", resId: 900, createdAt: "2026-10-21T10:00:00.000Z", params: { resModel: "project.task", resId: 5 } });
    const newer = link({ noteId: "n-new", kind: "message", model: "mail.message", resId: 901, createdAt: "2026-10-22T10:00:00.000Z", params: { resModel: "project.task", resId: 5 } });
    expect(noteForRecord([older, newer, created], A, "project.task", 5)).toBe(created);
    expect(noteForRecord([older, newer], A, "project.task", 5)).toBe(newer);
  });
});

describe("ChatInbox", () => {
  let db: DatabaseService;
  let repo: ChatRepository;
  let inbox: ChatInbox;
  let online: boolean;
  let answer: (path: string, params: any) => any;
  let routes: { path: string; params: any }[];

  const app = { url: "https://odoo.example.com", username: "alice", password: "pw-demo", database: "db1" } as any;
  const src = (configId = A) => ({ configId, label: "odoo", app, creds: { odooUrl: "https://odoo.example.com" } as any });

  beforeEach(async () => {
    SecureStoragePlugin._store.clear();
    db = new DatabaseService();
    await db.initialize();
    await addChatTables(db);
    repo = new ChatRepository(db);
    online = true;
    routes = [];
    answer = () => ({ data: {}, messages: [] });
    const rpc = {
      callWithAuth: async (_creds: any, fn: (sid: string) => Promise<any>) => fn("sid"),
      jsonRoute: vi.fn(async (_url: string, _sid: string, path: string, params: any) => {
        routes.push({ path, params });
        return answer(path, params);
      }),
    };
    inbox = new ChatInbox(repo, rpc as any, async () => online);
    await repo.applyDelta(A, delta({
      selfPartnerId: 3,
      channels: [{ channelId: CACHED, channelType: "channel", name: "#général-test", isMember: true }],
      partners: [{ configId: A, partnerId: 4, name: "Alice Martin" }],
    }));
  });

  it("the inbox page fills mention, record and assignment items", async () => {
    const page = [
      message(605, { id: CACHED, model: "discuss.channel" }),
      message(604, { id: OTHER, model: "discuss.channel" }),
      message(603, { id: 5, model: "project.task" }, { message_type: "user_notification", record_name: "Tâche démo" }),
      message(602, { id: 70, model: "res.partner" }),
    ];
    answer = (path) => (path === "/mail/inbox/messages" ? {
      data: {
        "mail.message": page,
        "mail.thread": [{ id: 70, model: "res.partner", name: "Fiche démo" }],
        "discuss.channel": [{ id: OTHER, name: "#autre-test" }],
      },
      messages: page.map((m) => m.id),
    } : undefined);
    expect(await inbox.refresh(src(), "inbox")).toEqual({ more: false, offline: false, oldestId: 602 });
    expect(routes).toEqual([{ path: "/mail/inbox/messages", params: { limit: INBOX_PAGE } }]);
    const items = await inbox.items([A], "inbox");
    expect(items.map((i) => [i.messageId, mailboxKindOf(i), i.recordName])).toEqual([
      [605, "mention", "#général-test"],
      [604, "mention", "#autre-test"],
      [603, "assignment", "Tâche démo"],
      [602, "record", "Fiche démo"],
    ]);
    expect(items.every((i) => i.needaction && !i.history && i.authorPartnerId === 4)).toBe(true);
    // A conversation message is cached in its thread only when the phone holds the conversation
    expect(await repo.message(A, 605)).not.toBeNull();
    expect(await repo.message(A, 604)).toBeNull();
    expect(await repo.channel(A, OTHER)).toBeNull();
    expect(await inbox.maxShown(A)).toBe(605);
    expect(await inbox.maxShown(B)).toBeNull();
  });

  it("an inbox page proves the id range it covers", async () => {
    await repo.applyDelta(A, delta({ mailbox: [500, 510, 700].map((messageId) => ({
      messageId, threadModel: "res.partner", threadId: 70, needaction: true,
      date: messageId > 600 ? "2026-10-26 11:00:00" : "2026-10-26 09:00:00",
    })) }));
    const page = Array.from({ length: INBOX_PAGE }, (_, i) => message(600 - i, { id: 70, model: "res.partner" }));
    answer = () => ({ data: { "mail.message": page }, messages: page.map((m) => m.id) });
    // A full page below 650 covers 571..649: 510 and 500 are older, 700 is above it
    expect(await inbox.refresh(src(), "inbox", 650)).toMatchObject({ more: true, oldestId: 571 });
    const ids = (await inbox.items([A], "inbox")).map((i) => i.messageId);
    expect(ids).toEqual(expect.arrayContaining([700, 510, 500]));
    // A short page covers everything below `before`
    answer = () => ({ data: { "mail.message": [] }, messages: [] });
    await inbox.refresh(src(), "inbox", 600);
    expect((await inbox.items([A], "inbox")).map((i) => i.messageId)).toEqual([700, 600]);
    expect((await inbox.items([A], "history")).map((i) => i.messageId)).toContain(510);
  });

  it("offline or a request that never left reads nothing", async () => {
    online = false;
    expect(await inbox.refresh(src(), "inbox")).toEqual({ more: false, offline: true, oldestId: null });
    online = true;
    answer = () => { throw new RequestNotSentError("connection refused"); };
    expect(await inbox.refresh(src(), "history")).toEqual({ more: false, offline: true, oldestId: null });
    expect(routes.map((r) => r.path)).toEqual(["/mail/history/messages"]);
  });

  it("items of several accounts come newest first", async () => {
    await repo.applyDelta(A, delta({ mailbox: [{ messageId: 10, threadModel: "res.partner", threadId: 1, date: "2026-10-26 08:00:00", needaction: true }] }));
    await repo.applyDelta(B, delta({ mailbox: [{ messageId: 3, threadModel: "res.partner", threadId: 1, date: "2026-10-26 09:00:00", needaction: true }] }));
    expect((await inbox.items([A, B], "inbox")).map((i) => [i.configId, i.messageId])).toEqual([[B, 3], [A, 10]]);
  });

  describe("openItem", () => {
    let navigate: ReturnType<typeof vi.fn>;
    const row = (messageId: number, p: Record<string, any>) => ({
      messageId, threadModel: "project.task", threadId: 5, recordName: "Tâche démo", needaction: true, ...p,
    });
    const item = async (messageId: number) => (await repo.mailboxItem(A, messageId))!;

    beforeEach(async () => {
      navigate = vi.fn();
      opened.openRecordInApp.mockClear();
      await repo.applyDelta(A, delta({ mailbox: [
        row(605, { threadModel: "discuss.channel", threadId: CACHED, recordName: "#général-test" }),
        row(604, { threadModel: "discuss.channel", threadId: OTHER, recordName: "#autre-test" }),
        row(603, { messageType: "user_notification" }),
        row(602, { threadModel: "res.partner", threadId: 70, recordName: "Fiche démo" }),
      ] }));
    });

    it("a mention opens the conversation at the message", async () => {
      await inbox.openItem(src(), await item(605), navigate);
      expect(navigate).toHaveBeenCalledWith("/chat/" + encodeURIComponent(A) + "/" + CACHED + "?m=605");
      expect(opened.openRecordInApp).not.toHaveBeenCalled();
    });

    it("a mention of a conversation the phone no longer holds opens the message in the web view", async () => {
      await inbox.openItem(src(), await item(604), navigate);
      expect(navigate).not.toHaveBeenCalled();
      expect(opened.openRecordInApp).toHaveBeenCalledWith({
        label: "#autre-test", appUrl: "https://odoo.example.com", username: "alice", password: "pw-demo",
        model: "discuss.channel", resId: OTHER, path: "/mail/message/604",
      });
    });

    it("a record item with a note opens the note", async () => {
      const asked: string[] = [];
      inbox.noteLinks = async (configId) => {
        asked.push(configId);
        return [link({ noteId: "n-task" }), link({ noteId: "n-partner", kind: "message", model: "mail.message", resId: 900, params: { resModel: "res.partner", resId: 70 } })];
      };
      // An assignment opens by the same rule as a followed record's message
      await inbox.openItem(src(), await item(603), navigate);
      await inbox.openItem(src(), await item(602), navigate);
      expect(navigate.mock.calls).toEqual([["/note/n-task"], ["/note/n-partner"]]);
      expect(asked).toEqual([A, A]);
      expect(opened.openRecordInApp).not.toHaveBeenCalled();
    });

    it("a record item without a note opens /mail/message/<id>", async () => {
      inbox.noteLinks = async () => [link({ noteId: "n-other", resId: 6 })];
      await inbox.openItem(src(), await item(602), navigate);
      expect(navigate).not.toHaveBeenCalled();
      expect(opened.openRecordInApp).toHaveBeenCalledWith({
        label: "Fiche démo", appUrl: "https://odoo.example.com", username: "alice", password: "pw-demo",
        model: "res.partner", resId: 70, path: "/mail/message/602",
      });
    });

    it("opening marks nothing read", async () => {
      for (const id of [605, 604, 603, 602]) await inbox.openItem(src(), await item(id), navigate);
      expect(routes).toEqual([]);
      expect((await inbox.items([A], "inbox")).map((i) => i.messageId)).toEqual([605, 604, 603, 602]);
    });
  });
});
