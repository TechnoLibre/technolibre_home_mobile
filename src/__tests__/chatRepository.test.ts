import { describe, it, expect, beforeEach } from "vitest";
import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";
import { DatabaseService } from "../services/databaseService";
import { addChatTables } from "../services/migrations/addChatTables";
import { ChatRepository } from "../services/chat/chatRepository";
import type { StoreDelta } from "../services/chat/chatStore";
import type { ChatMessage } from "../models/chat";

const A = "https://odoo.example.com|alice|db1";
const B = "https://odoo.example.com|bob|db1";

function delta(p: Partial<StoreDelta> = {}): StoreDelta {
  return {
    channels: [],
    deletedChannelIds: [],
    members: [],
    deletedMemberIds: [],
    messages: [],
    partners: [],
    inboxCounter: null,
    selfPartnerId: null,
    ...p,
  };
}

function pending(configId: string, uuid: string, over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    configId,
    channelId: 7,
    messageId: null,
    clientUuid: uuid,
    authorPartnerId: 3,
    body: "hello",
    date: "2026-10-25 10:00:00",
    messageType: "comment",
    status: "pending",
    outboxOpId: "op-" + uuid,
    writeDate: null,
    ...over,
  };
}

describe("ChatRepository", () => {
  let db: DatabaseService;
  let repo: ChatRepository;

  beforeEach(async () => {
    SecureStoragePlugin._store.clear();
    db = new DatabaseService();
    await db.initialize();
    await addChatTables(db);
    repo = new ChatRepository(db);
  });

  it("migration creates the five tables", async () => {
    for (const t of ["chat_channels", "chat_messages", "chat_members", "chat_partners", "chat_sources"]) {
      const cols = await db.rawQuery(`PRAGMA table_info(${t})`);
      expect(cols.length).toBeGreaterThan(3);
    }
    const cols = (await db.rawQuery("PRAGMA table_info(chat_sources)")).map((c) => c.name);
    expect(cols[0]).toBe("config_id");
  });

  it("applyDelta then channels round trips", async () => {
    await repo.applyDelta(A, delta({
      channels: [{ channelId: 7, channelType: "group", name: "Team", unreadCounter: 2, isMember: true, lastMessageId: 10 }],
    }));
    const [c] = await repo.channels(A);
    expect(c).toMatchObject({
      configId: A, channelId: 7, channelType: "group", name: "Team", unreadCounter: 2,
      isMember: true, lastMessageId: 10, localPinned: false, historyComplete: false,
    });
    expect(await repo.channel(A, 7)).toEqual(c);
    expect(await repo.channel(A, 8)).toBeNull();
  });

  it("a partial delta updates only its keys", async () => {
    await repo.applyDelta(A, delta({
      channels: [{ channelId: 7, channelType: "chat", name: "Zoe", unreadCounter: 2, description: "d" }],
    }));
    await repo.applyDelta(A, delta({ channels: [{ channelId: 7, unreadCounter: 0 }] }));
    expect(await repo.channel(A, 7)).toMatchObject({ name: "Zoe", description: "d", unreadCounter: 0, channelType: "chat" });
  });

  it("an empty name never overwrites a cached name", async () => {
    await repo.applyDelta(A, delta({ channels: [{ channelId: 7, name: "Team" }] }));
    await repo.applyDelta(A, delta({ channels: [{ channelId: 7, name: "" }] }));
    expect((await repo.channel(A, 7))!.name).toBe("Team");
  });

  it("lastMessageId only grows and oldestLoadedId only shrinks", async () => {
    await repo.applyDelta(A, delta({ channels: [{ channelId: 7, lastMessageId: 10, oldestLoadedId: 5 }] }));
    await repo.applyDelta(A, delta({ channels: [{ channelId: 7, lastMessageId: 8, oldestLoadedId: 9 }] }));
    expect(await repo.channel(A, 7)).toMatchObject({ lastMessageId: 10, oldestLoadedId: 5 });
    await repo.applyDelta(A, delta({ channels: [{ channelId: 7, lastMessageId: 12, oldestLoadedId: 3 }] }));
    expect(await repo.channel(A, 7)).toMatchObject({ lastMessageId: 12, oldestLoadedId: 3 });
  });

  it("deletions apply after upserts and cascade", async () => {
    await repo.applyDelta(A, delta({
      channels: [{ channelId: 7, name: "Team" }, { channelId: 8, name: "Other" }],
      members: [{ memberId: 1, channelId: 7, partnerId: 3 }, { memberId: 2, channelId: 8, partnerId: 3 }],
      messages: [{ messageId: 1, channelId: 7, body: "x" }, { messageId: 2, channelId: 8, body: "y" }],
    }));
    await repo.applyDelta(A, delta({
      channels: [{ channelId: 7, name: "Renamed" }],
      deletedChannelIds: [7],
      deletedMemberIds: [2],
    }));
    expect((await repo.channels(A)).map((c) => c.channelId)).toEqual([8]);
    expect(await repo.messages(A, 7)).toEqual([]);
    expect(await repo.members(A, 7)).toEqual([]);
    expect(await repo.members(A, 8)).toEqual([]);
    expect(await repo.messages(A, 8)).toHaveLength(1);
  });

  it("a new message defaults to sent, a partial keeps other keys", async () => {
    await repo.applyDelta(A, delta({ messages: [{ messageId: 4, channelId: 7, body: "hi", date: "2026-10-25 09:00:00" }] }));
    await repo.applyDelta(A, delta({ messages: [{ messageId: 4, body: "hi!" }] }));
    const [m] = await repo.messages(A, 7);
    expect(m).toMatchObject({ messageId: 4, body: "hi!", status: "sent", channelId: 7, date: "2026-10-25 09:00:00" });
  });

  it("messages are oldest first with pending last, and page by beforeId", async () => {
    await repo.putPending(pending(A, "u1"));
    await repo.applyDelta(A, delta({
      messages: [3, 1, 2].map((id) => ({ messageId: id, channelId: 7, body: "m" + id })),
    }));
    expect((await repo.messages(A, 7)).map((m) => m.messageId)).toEqual([1, 2, 3, null]);
    const page = await repo.messages(A, 7, { beforeId: 3, limit: 1 });
    expect(page.map((m) => m.messageId)).toEqual([2]);
  });

  it("settlePending moves the row to its message id", async () => {
    await repo.putPending(pending(A, "u1"));
    await repo.settlePending(A, "u1", 42);
    const rows = await repo.messages(A, 7);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ messageId: 42, status: "sent", clientUuid: "u1", body: "hello" });
  });

  it("settlePending when the bus already inserted the message leaves one sent row", async () => {
    await repo.putPending(pending(A, "u1"));
    await repo.applyDelta(A, delta({ messages: [{ messageId: 42, channelId: 7, body: "hello", writeDate: "w" }] }));
    expect(await repo.messages(A, 7)).toHaveLength(2);
    await repo.settlePending(A, "u1", 42);
    const rows = await repo.messages(A, 7);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ messageId: 42, status: "sent", writeDate: "w" });
  });

  it("markFailed flags the pending row", async () => {
    await repo.putPending(pending(A, "u1"));
    await repo.markFailed(A, "u1", "boom");
    expect((await repo.messages(A, 7))[0].status).toBe("failed");
  });

  it("two accounts of one server keep separate rows", async () => {
    await repo.applyDelta(A, delta({ channels: [{ channelId: 7, name: "Mine" }], messages: [{ messageId: 1, channelId: 7, body: "a" }] }));
    await repo.applyDelta(B, delta({ channels: [{ channelId: 7, name: "Other" }], messages: [{ messageId: 1, channelId: 7, body: "b" }] }));
    expect((await repo.channel(A, 7))!.name).toBe("Mine");
    expect((await repo.channel(B, 7))!.name).toBe("Other");
    expect((await repo.messages(A, 7))[0].body).toBe("a");
    expect(await repo.channels()).toHaveLength(2);
  });

  it("sourceState defaults, merges and follows the delta", async () => {
    expect(await repo.sourceState(A)).toMatchObject({ configId: A, lastBusId: 0, moduleState: "unknown", isSystem: false, selfPartnerId: null });
    await repo.setSourceState({ configId: A, lastBusId: 9, isSystem: true });
    await repo.setSourceState({ configId: A, moduleState: "installed" });
    expect(await repo.sourceState(A)).toMatchObject({ lastBusId: 9, isSystem: true, moduleState: "installed" });
    await repo.applyDelta(A, delta({ inboxCounter: 4, selfPartnerId: 3 }));
    expect(await repo.sourceState(A)).toMatchObject({ inboxCounter: 4, selfPartnerId: 3, lastBusId: 9 });
  });

  it("stores partners and members", async () => {
    await repo.applyDelta(A, delta({
      partners: [{ configId: A, partnerId: 3, name: "Zoe", imStatus: "online" }],
      members: [{ memberId: 1, channelId: 7, partnerId: 3, isTyping: true }],
    }));
    expect(await repo.partners(A)).toEqual([{ configId: A, partnerId: 3, name: "Zoe", imStatus: "online" }]);
    expect((await repo.members(A, 7))[0]).toMatchObject({ memberId: 1, partnerId: 3, isTyping: true });
  });

  it("renameSyncConfigId keeps a pending message and its channel", async () => {
    await repo.applyDelta(A, delta({ channels: [{ channelId: 7, name: "Team" }], partners: [{ configId: A, partnerId: 3, name: "Zoe", imStatus: null }] }));
    await repo.putPending(pending(A, "u1"));
    await repo.setSourceState({ configId: A, lastBusId: 5 });
    await db.renameSyncConfigId(A, B);
    expect(await repo.channels(A)).toEqual([]);
    expect((await repo.channel(B, 7))!.name).toBe("Team");
    const rows = await repo.messages(B, 7);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ configId: B, status: "pending", clientUuid: "u1" });
    await repo.settlePending(B, "u1", 50);
    expect((await repo.messages(B, 7))[0].messageId).toBe(50);
    expect((await repo.partners(B))).toHaveLength(1);
    expect((await repo.sourceState(B)).lastBusId).toBe(5);
    expect(await repo.messages(A, 7)).toEqual([]);
  });

  it("dropSource removes every row of that config only", async () => {
    for (const c of [A, B]) {
      await repo.applyDelta(c, delta({
        channels: [{ channelId: 7, name: "T" }],
        members: [{ memberId: 1, channelId: 7, partnerId: 3 }],
        messages: [{ messageId: 1, channelId: 7, body: "x" }],
        partners: [{ configId: c, partnerId: 3, name: "Z", imStatus: null }],
      }));
      await repo.putPending(pending(c, "u1"));
      await repo.setSourceState({ configId: c, lastBusId: 2 });
    }
    await repo.dropSource(A);
    expect(await repo.channels(A)).toEqual([]);
    expect(await repo.messages(A, 7)).toEqual([]);
    expect(await repo.members(A, 7)).toEqual([]);
    expect(await repo.partners(A)).toEqual([]);
    expect((await repo.sourceState(A)).lastBusId).toBe(0);
    expect(await repo.channels(B)).toHaveLength(1);
    expect(await repo.messages(B, 7)).toHaveLength(2);
    expect((await repo.sourceState(B)).lastBusId).toBe(2);
  });
});
