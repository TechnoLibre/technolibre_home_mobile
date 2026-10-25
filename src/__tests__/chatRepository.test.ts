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

  it("a deleted channel keeps its unsent messages as failed, detached from the outbox", async () => {
    await repo.applyDelta(A, delta({
      channels: [{ channelId: 7, name: "Team" }],
      messages: [{ messageId: 1, channelId: 7, body: "x" }],
    }));
    await repo.putPending(pending(A, "u1"));
    await repo.applyDelta(A, delta({ deletedChannelIds: [7] }));
    expect(await repo.channel(A, 7)).toBeNull();
    expect((await repo.messages(A, 7)).map((m) => [m.messageId, m.status, m.outboxOpId, m.body]))
      .toEqual([[null, "failed", null, "hello"]]);
  });

  it("a bus partial of an uncached message without its channel writes nothing", async () => {
    await repo.applyDelta(A, delta({ messages: [{ messageId: 9, body: "edited" }] }));
    expect(await repo.message(A, 9)).toBeNull();
    expect(await repo.messages(A, 0)).toEqual([]);
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

  it("a bare bus record never blanks the queued text on settle", async () => {
    await repo.putPending(pending(A, "u1"));
    // Without its channel the record of an uncached message is left out
    await repo.applyDelta(A, delta({ messages: [{ messageId: 42, writeDate: "w" }] }));
    await repo.settlePending(A, "u1", 42);
    // Once cached, a bare record overlays only what it carries
    await repo.applyDelta(A, delta({ messages: [{ messageId: 42, writeDate: "w" }] }));
    const rows = await repo.messages(A, 7);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      body: "hello", date: "2026-10-25 10:00:00", channelId: 7, authorPartnerId: 3,
      writeDate: "w", status: "sent", outboxOpId: null,
    });
  });

  it("a bus message carrying the client uuid ends like settlePending", async () => {
    await repo.putPending(pending(A, "u1"));
    await repo.applyDelta(A, delta({ messages: [{ messageId: 42, clientUuid: "u1", writeDate: "w" }] }));
    const viaBus = await repo.messages(A, 7);
    expect(viaBus).toHaveLength(1);
    await repo.putPending(pending(B, "u1"));
    await repo.settlePending(B, "u1", 42, { writeDate: "w" });
    const viaSettle = await repo.messages(B, 7);
    expect(viaBus[0]).toMatchObject({ status: "sent", outboxOpId: null, clientUuid: "u1", body: "hello", messageId: 42 });
    expect({ ...viaBus[0], configId: B }).toEqual(viaSettle[0]);
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
    expect(await repo.sourceState(A)).toMatchObject({ configId: A, lastBusId: 0, moduleState: "unknown", isSystem: false, selfPartnerId: null, counterBusId: 0 });
    await repo.setSourceState({ configId: A, lastBusId: 9, isSystem: true, counterBusId: 12 });
    await repo.setSourceState({ configId: A, moduleState: "installed" });
    expect(await repo.sourceState(A)).toMatchObject({ lastBusId: 9, isSystem: true, moduleState: "installed", counterBusId: 12 });
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

  it("a channel counter older than its stored bus id is not taken", async () => {
    await repo.applyDelta(A, delta({ channels: [{ channelId: 7, channelType: "group", unreadCounter: 1, unreadCounterBusId: 2328, needactionCounter: 1, needactionCounterBusId: 2328 }] }));
    expect(await repo.channel(A, 7)).toMatchObject({ unreadCounter: 1, unreadCounterBusId: 2328, needactionCounter: 1, needactionCounterBusId: 2328 });
    // Older from the bus: dropped with its id
    await repo.applyDelta(A, delta({ channels: [{ channelId: 7, unreadCounter: 0, unreadCounterBusId: 2316, needactionCounter: 0, needactionCounterBusId: 2316 }] }), { fromBus: true });
    expect(await repo.channel(A, 7)).toMatchObject({ unreadCounter: 1, unreadCounterBusId: 2328, needactionCounter: 1, needactionCounterBusId: 2328 });
    // Without a bus id: ignored from the bus, taken from an authoritative read
    await repo.applyDelta(A, delta({ channels: [{ channelId: 7, unreadCounter: 9 }] }), { fromBus: true });
    expect((await repo.channel(A, 7))!.unreadCounter).toBe(1);
    await repo.applyDelta(A, delta({ channels: [{ channelId: 7, unreadCounter: 4 }] }));
    expect(await repo.channel(A, 7)).toMatchObject({ unreadCounter: 4, unreadCounterBusId: 2328 });
    // Same or newer id: taken, the mark follows; an id alone moves nothing
    await repo.applyDelta(A, delta({ channels: [{ channelId: 7, unreadCounter: 2, unreadCounterBusId: 2330 }] }), { fromBus: true });
    await repo.applyDelta(A, delta({ channels: [{ channelId: 7, needactionCounterBusId: 2400 }] }), { fromBus: true });
    expect(await repo.channel(A, 7)).toMatchObject({ unreadCounter: 2, unreadCounterBusId: 2330, needactionCounterBusId: 2328 });
    await db.renameSyncConfigId(A, B);
    expect(await repo.channel(B, 7)).toMatchObject({ unreadCounterBusId: 2330, needactionCounterBusId: 2328 });
    // An authoritative read is taken even below the marks, which follow it down
    await repo.applyDelta(B, delta({ channels: [{ channelId: 7, unreadCounter: 3, unreadCounterBusId: 0, needactionCounter: 3, needactionCounterBusId: 0 }] }));
    expect(await repo.channel(B, 7)).toMatchObject({ unreadCounter: 3, unreadCounterBusId: 0, needactionCounter: 3, needactionCounterBusId: 0 });
  });

  it("renameSyncConfigId keeps a pending message and its channel", async () => {
    await repo.applyDelta(A, delta({ channels: [{ channelId: 7, name: "Team" }], partners: [{ configId: A, partnerId: 3, name: "Zoe", imStatus: null }] }));
    await repo.putPending(pending(A, "u1", { outboxOpId: "op-u1" }));
    await repo.setSourceState({ configId: A, lastBusId: 5 });
    await db.renameSyncConfigId(A, B);
    expect(await repo.channels(A)).toEqual([]);
    expect((await repo.channel(B, 7))!.name).toBe("Team");
    const rows = await repo.messages(B, 7);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ configId: B, status: "pending", clientUuid: "u1", outboxOpId: "op-u1" });
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

  it("lastMessages looks up by id and pendingMessages groups queued rows by channel", async () => {
    await repo.applyDelta(A, delta({
      messages: [1, 2].map((id) => ({ messageId: id, channelId: 7, body: "m" + id })),
    }));
    await repo.putPending(pending(A, "u1"));
    await repo.putPending(pending(A, "u2", { channelId: 8 }));
    await repo.putPending(pending(B, "u3"));
    const chans = [{ channelId: 7, lastMessageId: 2 }, { channelId: 8, lastMessageId: null }] as any[];
    const lasts = await repo.lastMessages(A, chans);
    expect(lasts.get(7)?.body).toBe("m2");
    expect(lasts.has(8)).toBe(false);
    const pend = await repo.pendingMessages(A);
    expect([...pend.keys()].sort()).toEqual([7, 8]);
    expect(pend.get(7)).toHaveLength(1);
  });
});
