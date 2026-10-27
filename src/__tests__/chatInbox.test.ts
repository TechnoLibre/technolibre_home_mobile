import { describe, it, expect, beforeEach, vi } from "vitest";
import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";
import { DatabaseService } from "../services/databaseService";
import { addChatTables } from "../services/migrations/addChatTables";
import { ChatRepository } from "../services/chat/chatRepository";
import { ChatInbox, INBOX_PAGE } from "../services/chat/chatInbox";
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

describe("ChatInbox", () => {
  let db: DatabaseService;
  let repo: ChatRepository;
  let inbox: ChatInbox;
  let online: boolean;
  let answer: (path: string, params: any) => any;
  let routes: { path: string; params: any }[];

  const src = (configId = A) => ({ configId, label: "odoo", app: {} as any, creds: { odooUrl: "https://odoo.example.com" } as any });

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
});
