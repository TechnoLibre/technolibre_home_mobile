import { describe, it, expect, beforeEach } from "vitest";
import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";
import { DatabaseService } from "../services/databaseService";
import { APP_MIGRATIONS } from "../services/migrations";
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
    await repo.rememberRealId(A, -5, 7);
    await db.renameSyncConfigId(A, B);
    expect(await repo.realIdOf(A, -5)).toBeNull();
    expect(await repo.realIdOf(B, -5)).toBe(7);
    expect(await repo.adoptedIds(B)).toEqual(new Set([7]));
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
      await repo.rememberRealId(c, -5, 7);
    }
    await repo.dropSource(A);
    expect(await repo.realIdOf(A, -5)).toBeNull();
    expect(await repo.realIdOf(B, -5)).toBe(7);
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

describe("ChatRepository lot 2", () => {
  let db: DatabaseService;
  let repo: ChatRepository;
  const LOT2 = {
    chat_channels: ["is_pinned", "is_editable", "custom_channel_name", "member_count", "group_public_id",
      "authorized_group_full_name", "create_uid", "group_based_subscription", "parent_channel_id", "create_op_id",
      "create_failed"],
    chat_members: ["create_date"],
    chat_sources: ["internal_user_group_id", "global_mute_until", "is_internal_user"],
    chat_temp_ids: ["id", "config_id", "temp_id", "real_id"],
  };
  const columnsOf = async (t: string) => (await db.rawQuery(`PRAGMA table_info(${t})`)).map((c) => c.name);

  beforeEach(async () => {
    SecureStoragePlugin._store.clear();
    db = new DatabaseService();
    await db.initialize();
  });

  it("a fresh install has the lot 2 columns after every migration", async () => {
    for (const m of APP_MIGRATIONS) {
      if (![2026031801, 2026032401].includes(m.version)) await m.run(db);
    }
    for (const [t, cols] of Object.entries(LOT2)) expect(await columnsOf(t)).toEqual(expect.arrayContaining(cols));
  });

  it("migration 2026102601 adds the columns to lot 1 tables, keeps their rows, and runs twice", async () => {
    // The lot 1 shape: only the columns lot 1 created
    const raw = (db as any).db;
    await raw.execute("CREATE TABLE IF NOT EXISTS chat_channels (id TEXT PRIMARY KEY NOT NULL, config_id TEXT NOT NULL, channel_id INTEGER NOT NULL)");
    await raw.execute("CREATE TABLE IF NOT EXISTS chat_members (id TEXT PRIMARY KEY NOT NULL, config_id TEXT NOT NULL)");
    await raw.execute("CREATE TABLE IF NOT EXISTS chat_sources (config_id TEXT PRIMARY KEY NOT NULL)");
    await db.rawRun("INSERT INTO chat_channels (id, config_id, channel_id) VALUES (?, ?, ?)", ["a#1", "a", 1]);
    await db.rawRun("INSERT INTO chat_sources (config_id) VALUES (?)", ["a"]);
    const migration = APP_MIGRATIONS.find((m) => m.version === 2026102601)!;
    await migration.run(db);
    await migration.run(db);
    for (const [t, cols] of Object.entries(LOT2)) expect(await columnsOf(t)).toEqual(expect.arrayContaining(cols));
    const [row] = await db.rawQuery("SELECT * FROM chat_channels");
    expect(row).toMatchObject({ channel_id: 1, is_editable: null });
    expect(await db.rawQuery("SELECT * FROM chat_sources")).toHaveLength(1);
    // the mock stores no column defaults; a row read without them takes the code's
    const repo2 = new ChatRepository(db);
    expect((await repo2.channel("a", 1))!).toMatchObject({ isPinned: true, groupBasedSubscription: false });
    expect(await repo2.sourceState("a")).toMatchObject({ isInternalUser: false, globalMuteUntil: null });
  });

  it("migration 2026102602 completes a database that ran 2026102601 without the create columns", async () => {
    // 2026102601 as an earlier lot 2 build ran it: its columns, no create_failed, no chat_temp_ids
    const raw = (db as any).db;
    const first = LOT2.chat_channels.filter((c) => c !== "create_failed").map((c) => `${c} TEXT`).join(", ");
    await raw.execute(`CREATE TABLE IF NOT EXISTS chat_channels (id TEXT PRIMARY KEY NOT NULL, config_id TEXT NOT NULL, channel_id INTEGER NOT NULL, ${first})`);
    await raw.execute("CREATE TABLE IF NOT EXISTS chat_members (id TEXT PRIMARY KEY NOT NULL, config_id TEXT NOT NULL, create_date TEXT)");
    await raw.execute("CREATE TABLE IF NOT EXISTS chat_sources (config_id TEXT PRIMARY KEY NOT NULL, internal_user_group_id INTEGER, global_mute_until TEXT, global_mute_at TEXT, is_internal_user INTEGER)");
    await db.rawRun("INSERT INTO chat_channels (id, config_id, channel_id, create_op_id) VALUES (?, ?, ?, ?)", ["a#-5", "a", -5, "op-1"]);
    expect(await columnsOf("chat_channels")).not.toContain("create_failed");
    expect(await columnsOf("chat_temp_ids")).toEqual([]);
    const migration = APP_MIGRATIONS.find((m) => m.version === 2026102602)!;
    expect(migration.description).toBe("Clavardage : création refusée et identifiants temporaires");
    await migration.run(db);
    await migration.run(db);
    for (const [t, cols] of Object.entries(LOT2)) expect(await columnsOf(t)).toEqual(expect.arrayContaining(cols));
    const repo2 = new ChatRepository(db);
    expect((await repo2.channel("a", -5))!).toMatchObject({ createOpId: "op-1", createFailed: false });
    await repo2.rememberRealId("a", -5, 40);
    expect(await repo2.realIdOf("a", -5)).toBe(40);
  });

  describe("on the chat tables", () => {
    beforeEach(async () => {
      await addChatTables(db);
      repo = new ChatRepository(db);
    });

    it("round trips the lot 2 channel, member and source fields, a new channel shown by default", async () => {
      await repo.applyDelta(A, delta({ channels: [{ channelId: 7 }] }));
      expect((await repo.channel(A, 7))!).toMatchObject({ isPinned: true, isEditable: null, groupBasedSubscription: false });
      await repo.applyDelta(A, delta({
        channels: [{
          channelId: 7, isPinned: false, isEditable: true, customChannelName: "Pal", memberCount: 3, groupPublicId: 12,
          authorizedGroupFullName: "Staff", createUid: 6, groupBasedSubscription: true, parentChannelId: 2, createOpId: "op1",
        }],
        members: [{ memberId: 5, channelId: 7, partnerId: 8, createDate: "2026-01-02 09:00:00" }],
        globalMuteUntil: "2026-02-01 10:00:00",
      }));
      expect((await repo.channel(A, 7))!).toMatchObject({
        isPinned: false, isEditable: true, customChannelName: "Pal", memberCount: 3, groupPublicId: 12,
        authorizedGroupFullName: "Staff", createUid: 6, groupBasedSubscription: true, parentChannelId: 2, createOpId: "op1",
      });
      expect((await repo.members(A, 7))[0].createDate).toBe("2026-01-02 09:00:00");
      await repo.setSourceState({ configId: A, internalUserGroupId: 11, isInternalUser: true });
      expect(await repo.sourceState(A)).toMatchObject({
        internalUserGroupId: 11, isInternalUser: true, globalMuteUntil: "2026-02-01 10:00:00",
      });
      await repo.applyDelta(A, delta({ globalMuteUntil: null }));
      expect((await repo.sourceState(A)).globalMuteUntil).toBeNull();
    });

    it("a partner record keeps what it does not carry", async () => {
      await repo.applyDelta(A, delta({ partners: [{ configId: A, partnerId: 8, name: "Alice", imStatus: "online" }] }));
      await repo.applyDelta(A, delta({ partners: [{ configId: A, partnerId: 8, name: "Alicia" }] }));
      expect((await repo.partners(A))[0]).toMatchObject({ name: "Alicia", imStatus: "online" });
      await repo.applyDelta(A, delta({ partners: [{ configId: A, partnerId: 8, imStatus: "away" }] }));
      expect((await repo.partners(A))[0]).toMatchObject({ name: "Alicia", imStatus: "away" });
      await repo.applyDelta(A, delta({ partners: [{ configId: A, partnerId: 8, imStatus: null }] }));
      expect((await repo.partners(A))[0]).toMatchObject({ name: "Alicia", imStatus: null });
    });

    it("a group renamed to an empty name keeps it empty; other types ignore it", async () => {
      await repo.applyDelta(A, delta({ channels: [
        { channelId: 1, channelType: "group", name: "Team" },
        { channelId: 2, channelType: "channel", name: "general" },
      ] }));
      await repo.applyDelta(A, delta({ channels: [{ channelId: 1, name: "" }, { channelId: 2, name: "" }] }));
      expect((await repo.channel(A, 1))!.name).toBe("");
      expect((await repo.channel(A, 2))!.name).toBe("general");
    });

    it("membersBySource groups an account's members by channel in member-id order", async () => {
      await repo.applyDelta(A, delta({ members: [
        { memberId: 9, channelId: 1, partnerId: 3 }, { memberId: 4, channelId: 1, partnerId: 2 },
        { memberId: 6, channelId: 2, partnerId: 2 },
      ] }));
      await repo.applyDelta(B, delta({ members: [{ memberId: 1, channelId: 1, partnerId: 2 }] }));
      const by = await repo.membersBySource(A);
      expect(by.get(1)!.map((m) => m.memberId)).toEqual([4, 9]);
      expect(by.get(2)!.map((m) => m.memberId)).toEqual([6]);
    });
  });
});
