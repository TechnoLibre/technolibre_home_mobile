import { describe, it, expect, beforeEach } from "vitest";
import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";
import { DatabaseService } from "../services/databaseService";
import { APP_MIGRATIONS } from "../services/migrations";
import { addChatTables } from "../services/migrations/addChatTables";
import { ChatRepository } from "../services/chat/chatRepository";
import type { StoreDelta } from "../services/chat/chatStore";
import type { ChatAttachment, ChatMessage } from "../models/chat";

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
    attachments: [],
    deletedAttachmentIds: [],
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

function outgoing(configId: string, uuid: string, over: Partial<ChatAttachment> = {}): ChatAttachment {
  return {
    configId,
    channelId: 7,
    messageId: null,
    attachmentId: null,
    localUuid: uuid,
    postClientUuid: "post1",
    seq: 0,
    name: "photo.jpg",
    mimetype: "image/jpeg",
    size: 1000,
    checksum: null,
    voice: false,
    thumbPath: null,
    thumbBytes: 0,
    originalPath: `chat/dir/out/${uuid}/photo.jpg`,
    originalBytes: 1000,
    state: "queued",
    error: null,
    lastOpenedAt: null,
    createdAt: "2026-10-26T10:00:00.000Z",
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

  it("a temporary id is never one a settled create stored a pair for", async () => {
    const now = new Date("2026-10-25T10:00:00.000Z");
    const first = await repo.newTemporaryId(A, now);
    expect(first).toBe(-now.getTime());
    await repo.rememberRealId(A, first, 7);
    expect(await repo.newTemporaryId(A, now)).toBe(first - 1);
    expect(await repo.newTemporaryId(B, now)).toBe(first);
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

  describe("attachments", () => {
    let released: string[][];
    beforeEach(() => {
      released = [];
      repo.onFilesReleased = (paths) => { released.push(paths); };
    });

    const server = (id: number, over: any = {}) => ({
      attachmentId: id, channelId: 7, name: `f${id}.png`, mimetype: "image/png", size: 10 * id, checksum: `c${id}`, voice: false, ...over,
    });

    it("fileDirOf creates a random id once and keeps it", async () => {
      const dir = await repo.fileDirOf(A);
      expect(dir).toMatch(/^[0-9a-f-]{36}$/);
      expect(dir).not.toContain("alice");
      expect(await repo.fileDirOf(A)).toBe(dir);
      expect(await repo.fileDirOf(B)).not.toBe(dir);
      expect((await repo.sourceState(A)).fileDir).toBe(dir);
    });

    it("applyDelta stores server attachments, links them to a message, and keeps local fields", async () => {
      await repo.applyDelta(A, delta({
        messages: [{ messageId: 50, channelId: 7, body: "x", attachmentIds: [2, 1] }],
        attachments: [server(1, { voice: true }), server(2)],
      }));
      const map = await repo.attachmentsOf(A, 7, [50], []);
      expect(map.get("m50")!.map((a) => a.attachmentId)).toEqual([2, 1]);
      expect(map.get("m50")![1]).toMatchObject({ voice: true, state: "posted", messageId: 50, checksum: "c1" });
      await repo.setPreview(A, 1, "chat/dir/thumbs/1", 40);
      await repo.setOriginal(A, 1, "chat/dir/files/1/f1.png", 10);
      await repo.touchOpened(A, 1, "2026-10-26T11:00:00.000Z");
      // A later delta overlays the server fields only
      await repo.applyDelta(A, delta({ attachments: [{ attachmentId: 1, name: "renamed.png" }] }));
      const row = (await repo.attachmentsOf(A, 7, [50], [])).get("m50")!.find((a) => a.attachmentId === 1)!;
      expect(row).toMatchObject({
        name: "renamed.png", thumbPath: "chat/dir/thumbs/1", thumbBytes: 40, originalPath: "chat/dir/files/1/f1.png",
        originalBytes: 10, lastOpenedAt: "2026-10-26T11:00:00.000Z", state: "posted",
      });
    });

    it("a message with fewer attachment ids drops the other row and releases its paths", async () => {
      await repo.applyDelta(A, delta({
        messages: [{ messageId: 50, channelId: 7, body: "x", attachmentIds: [1, 2] }],
        attachments: [server(1), server(2)],
      }));
      await repo.setPreview(A, 2, "chat/dir/thumbs/2", 40);
      await repo.applyDelta(A, delta({ messages: [{ messageId: 50, attachmentIds: [1] }] }));
      expect((await repo.attachmentsOf(A, 7, [50], [])).get("m50")!.map((a) => a.attachmentId)).toEqual([1]);
      expect(released).toEqual([["chat/dir/thumbs/2"]]);
    });

    it("deleteAttachments removes rows and releases their paths", async () => {
      await repo.applyDelta(A, delta({
        messages: [{ messageId: 50, channelId: 7, body: "x", attachmentIds: [1] }],
        attachments: [server(1)],
      }));
      await repo.setOriginal(A, 1, "chat/dir/files/1/f1.png", 10);
      expect(await repo.deleteAttachments(A, [1, 99])).toEqual(["chat/dir/files/1/f1.png"]);
      expect(released).toEqual([["chat/dir/files/1/f1.png"]]);
      expect((await repo.attachmentsOf(A, 7, [50], [])).size).toBe(0);
    });

    it("a deleted channel drops its attachments except queued and uploaded ones", async () => {
      await repo.applyDelta(A, delta({
        channels: [{ channelId: 7, name: "T" }],
        messages: [{ messageId: 50, channelId: 7, body: "x", attachmentIds: [1] }],
        attachments: [server(1)],
      }));
      await repo.setOriginal(A, 1, "chat/dir/files/1/f1.png", 10);
      await repo.putOutgoing([outgoing(A, "l1"), outgoing(A, "l2", { state: "uploaded", attachmentId: 9 }), outgoing(A, "l3", { state: "refused" })]);
      await repo.applyDelta(A, delta({ deletedChannelIds: [7] }));
      expect(await repo.attachmentBytes(A, 7)).toBe(2000);
      const left = await repo.outgoingOf(A, "post1");
      expect(left.map((a) => a.localUuid).sort()).toEqual(["l1", "l2"]);
      expect(released.flat().sort()).toEqual(["chat/dir/files/1/f1.png", "chat/dir/out/l3/photo.jpg"]);
    });

    it("outgoingOf lists by seq; setUploaded, setRefused and requeueUpload move the state", async () => {
      await repo.putOutgoing([outgoing(A, "l2", { seq: 1 }), outgoing(A, "l1", { seq: 0 })]);
      expect((await repo.outgoingOf(A, "post1")).map((a) => a.localUuid)).toEqual(["l1", "l2"]);
      await repo.setUploaded(A, "l1", { attachmentId: 31, checksum: "ck", size: 999, mimetype: "image/png", name: "p.png" });
      await repo.setRefused(A, "l2", "too big");
      const [one, two] = await repo.outgoingOf(A, "post1");
      expect(one).toMatchObject({ state: "uploaded", attachmentId: 31, checksum: "ck", size: 999, mimetype: "image/png", name: "p.png" });
      expect(two).toMatchObject({ state: "refused", error: "too big" });
      await repo.requeueUpload(A, "l2");
      expect((await repo.outgoingOf(A, "post1"))[1]).toMatchObject({ state: "queued", error: null });
    });

    it("adoptOutgoing re-keys the rows, merges a row the bus wrote and keeps local paths", async () => {
      await repo.putOutgoing([outgoing(A, "l1", { state: "uploaded", attachmentId: 31, checksum: "old" })]);
      // The bus echo arrived first: a server row, no local path
      await repo.applyDelta(A, delta({
        messages: [{ messageId: 60, channelId: 7, body: "x", attachmentIds: [31] }],
        attachments: [server(31, { checksum: "ck" })],
      }));
      const adopted = await repo.adoptOutgoing(A, "post1", 60);
      expect(adopted).toHaveLength(1);
      expect(adopted[0]).toMatchObject({
        attachmentId: 31, messageId: 60, state: "posted", checksum: "ck", localUuid: "l1",
        originalPath: "chat/dir/out/l1/photo.jpg", originalBytes: 1000,
      });
      expect(await repo.outgoingOf(A, "post1")).toEqual([]);
      const rows = await db.rawQuery("SELECT id FROM chat_attachments WHERE config_id = ?", [A]);
      expect(rows.map((r) => r.id)).toEqual([`${A}#a31`]);
      expect((await repo.attachmentsOf(A, 7, [60], [])).get("m60")).toHaveLength(1);
    });

    it("adoptOutgoing without a bus row re-keys alone; attachmentsOf finds queued rows by post uuid", async () => {
      await repo.putOutgoing([outgoing(A, "l1", { state: "uploaded", attachmentId: 31 })]);
      expect((await repo.attachmentsOf(A, 7, [], ["post1"])).get("upost1")).toHaveLength(1);
      await repo.adoptOutgoing(A, "post1", 61);
      const row = (await repo.attachmentsOf(A, 7, [61], ["post1"])).get("m61")![0];
      expect(row).toMatchObject({ attachmentId: 31, state: "posted", messageId: 61 });
    });

    it("deleteOutgoing removes the rows and returns their paths", async () => {
      await repo.putOutgoing([outgoing(A, "l1"), outgoing(A, "l2")]);
      expect(await repo.deleteOutgoing(A, ["l1"])).toEqual(["chat/dir/out/l1/photo.jpg"]);
      expect((await repo.outgoingOf(A, "post1")).map((a) => a.localUuid)).toEqual(["l2"]);
    });

    it("attachmentBytes sums thumbs and originals per channel and in total; cachedRows orders by last use", async () => {
      await repo.applyDelta(A, delta({
        attachments: [server(1), server(2), server(3, { channelId: 8 })],
      }));
      await repo.setPreview(A, 1, "t1", 5);
      await repo.setOriginal(A, 1, "o1", 20);
      await repo.setOriginal(A, 2, "o2", 30);
      await repo.setOriginal(A, 3, "o3", 100);
      await repo.touchOpened(A, 2, "2026-10-20T00:00:00.000Z");
      expect(await repo.attachmentBytes(A, 7)).toBe(55);
      expect(await repo.attachmentBytes(A)).toBe(155);
      await repo.applyDelta(B, delta({ attachments: [server(1)] }));
      await repo.setOriginal(B, 1, "ob", 1);
      expect(await repo.attachmentBytes(A)).toBe(155);
      expect(await repo.attachmentBytes()).toBe(156);
      // Never opened rows sort by creation; the opened one (2026-10-20) comes first
      const cached = await repo.cachedRows();
      expect(cached[0].attachmentId).toBe(2);
      expect(cached).toHaveLength(4);
    });

    it("clearFiles empties the chosen files and releases them", async () => {
      await repo.applyDelta(A, delta({ attachments: [server(1)] }));
      await repo.setPreview(A, 1, "t1", 5);
      await repo.setOriginal(A, 1, "o1", 20);
      await repo.clearFiles([`${A}#a1`], "original");
      expect(await repo.attachmentBytes(A)).toBe(5);
      await repo.clearFiles([`${A}#a1`], "both");
      expect(await repo.attachmentBytes(A)).toBe(0);
      expect(released.flat()).toEqual(["o1", "t1"]);
      expect(await repo.cachedRows()).toEqual([]);
    });

    it("swapChannelId moves the attachment rows to the real channel", async () => {
      await repo.putOutgoing([outgoing(A, "l1", { channelId: -5 })]);
      await repo.swapChannelId(A, -5, 7);
      expect((await repo.outgoingOf(A, "post1"))[0].channelId).toBe(7);
    });

    it("dropSource removes the attachment rows of that account only", async () => {
      await repo.applyDelta(A, delta({ attachments: [server(1)] }));
      await repo.applyDelta(B, delta({ attachments: [server(1)] }));
      await repo.setOriginal(A, 1, "oa", 3);
      await repo.dropSource(A);
      expect(await db.rawQuery("SELECT * FROM chat_attachments WHERE config_id = ?", [A])).toEqual([]);
      expect(await db.rawQuery("SELECT * FROM chat_attachments WHERE config_id = ?", [B])).toHaveLength(1);
      expect(released.flat()).toEqual(["oa"]);
    });

    it("rename keeps the file directory and moves the attachment rows", async () => {
      const dir = await repo.fileDirOf(A);
      await repo.putOutgoing([outgoing(A, "l1")]);
      await repo.applyDelta(A, delta({ attachments: [server(1)] }));
      await db.renameSyncConfigId(A, B);
      expect(await repo.fileDirOf(B)).toBe(dir);
      expect(await repo.outgoingOf(A, "post1")).toEqual([]);
      expect((await repo.outgoingOf(B, "post1")).map((a) => a.localUuid)).toEqual(["l1"]);
      const ids = (await db.rawQuery("SELECT id FROM chat_attachments")).map((r) => r.id).sort();
      expect(ids).toEqual([`${B}#a1`, `${B}#ll1`].sort());
    });
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

  it("a fresh install has the left-unsent flag after every migration", async () => {
    for (const m of APP_MIGRATIONS) {
      if (![2026031801, 2026032401].includes(m.version)) await m.run(db);
    }
    expect(await columnsOf("chat_channels")).toContain("left_unsent");
  });

  it("migration 2026102603 adds the left-unsent flag to tables without it, and runs twice", async () => {
    // A database that ran 2026102602 before the flag existed
    const raw = (db as any).db;
    await raw.execute("CREATE TABLE IF NOT EXISTS chat_channels (id TEXT PRIMARY KEY NOT NULL, config_id TEXT NOT NULL, channel_id INTEGER NOT NULL, create_failed INTEGER)");
    await db.rawRun("INSERT INTO chat_channels (id, config_id, channel_id) VALUES (?, ?, ?)", ["a#4", "a", 4]);
    expect(await columnsOf("chat_channels")).not.toContain("left_unsent");
    const migration = APP_MIGRATIONS.find((m) => m.version === 2026102603)!;
    expect(migration.description).toBe("Clavardage : conversations quittées avec des messages non envoyés");
    await migration.run(db);
    await migration.run(db);
    expect(await columnsOf("chat_channels")).toContain("left_unsent");
    const repo2 = new ChatRepository(db);
    expect((await repo2.channel("a", 4))!).toMatchObject({ leftUnsent: false });
    await repo2.patchChannel("a", 4, { leftUnsent: true });
    expect((await repo2.channel("a", 4))!).toMatchObject({ leftUnsent: true });
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
  describe("migration 2026102604", () => {
    const migration = () => APP_MIGRATIONS.find((m) => m.version === 2026102604)!;
    const colsOf = async (t: string) => (await db.rawQuery(`PRAGMA table_info(${t})`)).map((c) => c.name);

    it("a fresh install has the table and the columns", async () => {
      for (const m of APP_MIGRATIONS) {
        if (![2026031801, 2026032401].includes(m.version)) await m.run(db);
      }
      expect(await colsOf("chat_attachments")).toEqual(expect.arrayContaining(["id", "post_client_uuid", "thumb_bytes", "state", "created_at"]));
      expect(await colsOf("chat_sources")).toEqual(expect.arrayContaining(["file_dir", "module_level"]));
    });

    it("adds the table and the columns to a database at 2026102603, and a second run changes nothing", async () => {
      const raw = (db as any).db;
      await raw.execute("CREATE TABLE IF NOT EXISTS chat_sources (config_id TEXT PRIMARY KEY NOT NULL)");
      await db.rawRun("INSERT INTO chat_sources (config_id) VALUES (?)", ["a"]);
      expect(await colsOf("chat_sources")).not.toContain("file_dir");
      expect(migration().description).toBe("Clavardage : pièces jointes et leur cache");
      await migration().run(db);
      await db.rawRun("INSERT INTO chat_attachments (id, config_id, channel_id, name, mimetype, size, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", ["a#a1", "a", 1, "n", "m", 1, "posted", "t"]);
      await migration().run(db);
      expect(await colsOf("chat_sources")).toEqual(expect.arrayContaining(["file_dir", "module_level"]));
      expect(await db.rawQuery("SELECT * FROM chat_attachments")).toHaveLength(1);
      expect(await db.rawQuery("SELECT * FROM chat_sources")).toHaveLength(1);
    });
  });
});
