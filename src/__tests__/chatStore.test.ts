import { describe, it, expect } from "vitest";
import { parseStore, mergeDeltas, mailboxPartialsOf } from "../services/chat/chatStore";
import { mailboxKindOf, type ChatMailboxItem } from "../models/chat";

const CFG = "cfg1";
const SELF = 3;

const chan = (id: number, type: string, extra: any = {}) => ({
  id,
  channel_type: type,
  name: "n" + id,
  description: false,
  last_interest_dt: "2026-01-02 10:00:00",
  message_needaction_counter: 0,
  ...extra,
});
const thread = (id: number) => ({ id, model: "discuss.channel" });
const partner = (id: number) => ({ id, type: "partner" });

describe("parseStore /mail/data", () => {
  const result = {
    Store: {
      inbox: { counter: 4, id: "inbox", model: "mail.box" },
      self: partner(SELF),
    },
    "res.partner": [
      { id: SELF, name: "Me" },
      { id: 8, name: "Alice" },
    ],
    "discuss.channel": [
      chan(1, "chat", { name: "", message_needaction_counter: 0 }),
      chan(2, "group", { message_unread_counter: 1 }),
      chan(3, "channel", { message_needaction_counter: 2, mute_until_dt: "9999-12-31 00:00:00" }),
    ],
    "discuss.channel.member": [
      { id: 11, thread: thread(1), persona: partner(SELF), message_unread_counter: 5, new_message_separator: 40, seen_message_id: 39, fetched_message_id: false },
      { id: 12, thread: thread(1), persona: partner(8), seen_message_id: 41 },
      { id: 13, thread: thread(2), persona: partner(SELF), message_unread_counter: 0, new_message_separator: 7, seen_message_id: false },
      { id: 14, thread: thread(2), persona: { id: 2, type: "guest" } },
    ],
    "mail.message": [
      { id: 40, body: "<p>a</p>", date: "2026-01-02 09:00:00", message_type: "comment", write_date: "2026-01-02 09:00:00", thread: thread(1), author: partner(8) },
      { id: 50, body: "g", date: "2026-01-02 09:30:00", message_type: "comment", thread: thread(2), author: { id: 9, type: "guest" } },
      { id: 51, body: "x", date: "2026-01-02 09:31:00", message_type: "comment", thread: thread(3), author: false },
      { id: 52, body: "rec", date: "2026-01-02 09:32:00", message_type: "comment", thread: { id: 7, model: "res.partner" }, author: partner(8) },
    ],
  };

  it("builds three channel partials with counters from the self member", () => {
    const d = parseStore(result, CFG, SELF);
    expect(d.channels.map((c) => c.channelId)).toEqual([1, 2, 3]);
    const [c1, c2, c3] = d.channels as any[];
    expect(c1.channelType).toBe("chat");
    expect(c1.unreadCounter).toBe(5);
    expect(c1.newMessageSeparator).toBe(40);
    expect(c1.seenMessageId).toBe(39);
    expect(c1.correspondentPartnerId).toBe(8);
    expect(c1.name).toBe("Alice");
    expect(c1.lastMessageId).toBe(40);
    expect(c2.channelType).toBe("group");
    expect(c2.unreadCounter).toBe(0);
    expect(c2.seenMessageId).toBeNull();
    expect(c2.lastMessageId).toBe(50);
    expect(c3.channelType).toBe("channel");
    expect(c3.needactionCounter).toBe(2);
    expect(c3.muteUntilDt).toBe("9999-12-31 00:00:00");
    expect(c3.unreadCounter).toBeUndefined();
    expect(c3.lastMessageId).toBe(51);
    expect(c3.lastInterestDt).toBe("2026-01-02 10:00:00");
  });

  it("maps messages, guest author to null, skips other threads", () => {
    const d = parseStore(result, CFG, SELF);
    expect(d.messages.map((m) => m.messageId)).toEqual([40, 50, 51]);
    expect(d.messages[0]).toMatchObject({ channelId: 1, authorPartnerId: 8, body: "<p>a</p>", messageType: "comment", date: "2026-01-02 09:00:00" });
    expect(d.messages[1].authorPartnerId).toBeNull();
    expect(d.messages[2].authorPartnerId).toBeNull();
  });

  it("reads inbox, self, partners, members", () => {
    const d = parseStore(result, CFG, null);
    expect(d.inboxCounter).toBe(4);
    expect(d.selfPartnerId).toBe(SELF);
    expect(d.partners).toContainEqual({ configId: CFG, partnerId: 8, name: "Alice" });
    expect(d.members.find((m) => m.memberId === 12)).toMatchObject({ channelId: 1, partnerId: 8, seenMessageId: 41 });
    expect(d.members.find((m) => m.memberId === 14)?.partnerId).toBeUndefined();
    // self resolved from Store.self gives the same channel counters
    expect((d.channels[0] as any).unreadCounter).toBe(5);
  });
});

describe("parseStore deltas", () => {
  it("carries the counters' bus ids, only where the record has them", () => {
    const d = parseStore({
      "discuss.channel": [chan(5, "channel", { message_needaction_counter: 2, message_needaction_counter_bus_id: 2316 })],
      "discuss.channel.member": [
        { id: 21, thread: thread(5), persona: partner(SELF), message_unread_counter: 0, message_unread_counter_bus_id: 2317 },
        { id: 22, thread: thread(6), persona: partner(SELF), message_unread_counter: 4 },
      ],
    }, CFG, SELF);
    const byId = new Map(d.channels.map((c) => [c.channelId, c]));
    expect(byId.get(5)).toMatchObject({ needactionCounter: 2, needactionCounterBusId: 2316, unreadCounter: 0, unreadCounterBusId: 2317 });
    expect(byId.get(6)!.unreadCounter).toBe(4);
    expect(byId.get(6)).not.toHaveProperty("unreadCounterBusId");
    expect(byId.get(6)).not.toHaveProperty("needactionCounterBusId");
  });

  it("insert with only id and name gives exactly those keys", () => {
    const d = parseStore({ "discuss.channel": [{ id: 5, name: "x" }] }, CFG, SELF);
    expect(d.channels).toEqual([{ channelId: 5, name: "x" }]);
    expect(d.inboxCounter).toBeNull();
    expect(d.selfPartnerId).toBe(SELF);
  });

  it("message edit has no author", () => {
    const d = parseStore(
      { "mail.message": [{ id: 9, body: "<p>e</p>", write_date: "2026-02-01 00:00:00" }] },
      CFG,
      SELF,
    );
    expect(d.messages).toEqual([{ messageId: 9, body: "<p>e</p>", writeDate: "2026-02-01 00:00:00" }]);
    expect("authorPartnerId" in d.messages[0]).toBe(false);
  });

  it("member left and channel delete", () => {
    const d = parseStore(
      {
        "discuss.channel": [
          { id: 5, channelMembers: [["DELETE", [{ id: 21 }, 22]]] },
          { id: 6, _DELETE: true },
        ],
        "discuss.channel.member": [{ id: 23, _DELETE: true }],
      },
      CFG,
      SELF,
    );
    expect(d.deletedMemberIds.sort()).toEqual([21, 22, 23]);
    expect(d.deletedChannelIds).toEqual([6]);
    expect(d.channels.map((c) => c.channelId)).toEqual([5]);
    expect(d.members).toEqual([]);
  });

  it("typing insert", () => {
    const d = parseStore(
      { "discuss.channel.member": [{ id: 12, isTyping: true, is_typing_dt: "2026-02-01 00:00:05" }] },
      CFG,
      SELF,
    );
    expect(d.members).toEqual([{ memberId: 12, isTyping: true, typingAt: "2026-02-01 00:00:05" }]);
  });

  it("selfMember relation on the channel, id form", () => {
    const d = parseStore(
      {
        "discuss.channel": [{ id: 5, selfMember: 30 }],
        "discuss.channel.member": [{ id: 30, thread: thread(5), persona: partner(SELF), message_unread_counter: 2 }],
      },
      CFG,
      SELF,
    );
    expect(d.channels[0]).toMatchObject({ channelId: 5, isMember: true, unreadCounter: 2 });
  });

  it("selfMember false marks non member", () => {
    const d = parseStore({ "discuss.channel": [{ id: 5, selfMember: false }] }, CFG, SELF);
    expect(d.channels[0]).toEqual({ channelId: 5, isMember: false });
  });

  it("selfMember inline form", () => {
    const d = parseStore(
      { "discuss.channel": [{ id: 5, selfMember: { id: 30, message_unread_counter: 3, new_message_separator: 8 } }] },
      CFG,
      SELF,
    );
    expect(d.channels[0]).toMatchObject({ unreadCounter: 3, newMessageSeparator: 8, isMember: true });
  });

  it("empty or missing result", () => {
    const d = parseStore({}, CFG, null);
    expect(d.channels).toEqual([]);
    expect(d.selfPartnerId).toBeNull();
  });
});

describe("mergeDeltas", () => {
  it("keeps the later value of a key and unions the rest", () => {
    const a = parseStore({ "discuss.channel": [{ id: 5, name: "old", description: "d" }], Store: { inbox: { counter: 1 } } }, CFG, SELF);
    const b = parseStore({ "discuss.channel": [{ id: 5, name: "new" }, { id: 6, _DELETE: true }], Store: { inbox: { counter: 2 } } }, CFG, null);
    const m = mergeDeltas(a, b);
    expect(m.channels).toEqual([{ channelId: 5, name: "new", description: "d" }]);
    expect(m.deletedChannelIds).toEqual([6]);
    expect(m.inboxCounter).toBe(2);
    expect(m.selfPartnerId).toBe(SELF);
  });
  it("keeps an earlier inbox counter when the later has none", () => {
    const a = parseStore({ Store: { inbox: { counter: 7 } } }, CFG, null);
    const b = parseStore({}, CFG, null);
    expect(mergeDeltas(a, b).inboxCounter).toBe(7);
  });
});

describe("parseStore lot 2 keys", () => {
  it("copies the channel, member and settings keys", () => {
    const d = parseStore({
      Store: { settings: { mute_until_dt: "2026-02-01 10:00:00" } },
      "discuss.channel": [chan(9, "channel", {
        is_pinned: false, is_editable: true, custom_channel_name: "Pal", memberCount: 4,
        group_public_id: { id: 12 }, authorizedGroupFullName: "Staff", create_uid: { id: 6 },
        group_based_subscription: true, parent_channel_id: { id: 2 },
      })],
      "discuss.channel.member": [{ id: 31, thread: thread(9), persona: partner(8), create_date: "2026-01-02 09:00:00" }],
      "res.partner": [{ id: 8, im_status: "away" }, { id: 9, name: "Bob" }],
    }, CFG, SELF);
    expect(d.channels[0]).toMatchObject({
      isPinned: false, isEditable: true, customChannelName: "Pal", memberCount: 4, groupPublicId: 12,
      authorizedGroupFullName: "Staff", createUid: 6, groupBasedSubscription: true, parentChannelId: 2,
    });
    expect(d.members[0].createDate).toBe("2026-01-02 09:00:00");
    expect(d.globalMuteUntil).toBe("2026-02-01 10:00:00");
    expect(d.partners).toEqual([{ configId: CFG, partnerId: 8, imStatus: "away" }, { configId: CFG, partnerId: 9, name: "Bob" }]);
  });

  it("a false value clears, an absent key stays absent", () => {
    const d = parseStore({
      Store: { settings: { mute_until_dt: false } },
      "discuss.channel": [{ id: 4, group_public_id: false, custom_channel_name: false }],
    }, CFG, SELF);
    expect(d.channels[0]).toEqual({ channelId: 4, groupPublicId: null, customChannelName: null });
    expect(d.globalMuteUntil).toBeNull();
    expect(parseStore({}, CFG, SELF).globalMuteUntil).toBeUndefined();
  });
});

describe("parseStore attachments", () => {
  const att = (id: number, extra: any = {}) => ({
    id, checksum: `ck${id}`, filename: `f${id}.png`, mimetype: "image/png", name: `f${id}.png`, size: 100 * id,
    thread: thread(7), type: "binary", url: `/web/content/${id}`, voice: false, ...extra,
  });

  it("reads ir.attachment records of a messages page and the ids a message lists", () => {
    const d = parseStore({
      "mail.message": [{ id: 50, thread: thread(7), body: "x", attachment_ids: [2, { id: 1 }] }],
      "ir.attachment": [att(1, { voice: true }), att(2)],
    }, CFG, SELF);
    expect(d.messages[0].attachmentIds).toEqual([2, 1]);
    expect(d.attachments).toEqual([
      { attachmentId: 1, channelId: 7, checksum: "ck1", mimetype: "image/png", name: "f1.png", size: 100, voice: true },
      { attachmentId: 2, channelId: 7, checksum: "ck2", mimetype: "image/png", name: "f2.png", size: 200, voice: false },
    ]);
  });

  it("reads a post answer, keeps a partial without thread, skips other models and deleted rows", () => {
    const d = parseStore({
      "mail.message": [{ id: 51, thread: thread(7), attachment_ids: [] }],
      "ir.attachment": [
        { id: 3, name: "only-name" },
        att(4, { thread: { id: 9, model: "res.partner" } }),
        { id: 5, _DELETE: true },
      ],
    }, CFG, SELF);
    expect(d.messages[0].attachmentIds).toEqual([]);
    expect(d.attachments).toEqual([{ attachmentId: 3, name: "only-name" }]);
    expect(d.deletedAttachmentIds).toEqual([5]);
  });

  it("mergeDeltas merges attachments by id and unions deleted ids", () => {
    const a = parseStore({ "ir.attachment": [att(1)] }, CFG, SELF);
    const b = parseStore({ "ir.attachment": [{ id: 1, name: "z.png" }, att(2)] }, CFG, SELF);
    b.deletedAttachmentIds = [9];
    const m = mergeDeltas(a, b);
    expect(m.attachments.find((x) => x.attachmentId === 1)).toMatchObject({ name: "z.png", checksum: "ck1" });
    expect(m.attachments).toHaveLength(2);
    expect(m.deletedAttachmentIds).toEqual([9]);
  });
});

describe("parseStore reactions, parents and recipients", () => {
  const guest = (id: number) => ({ id, type: "guest" });

  it("reads a messages page with two reaction groups and a parent", () => {
    const d = parseStore({
      "mail.message": [
        {
          id: 60, thread: thread(7), body: "<p>re</p>", parentMessage: 55,
          reactions: [{ message: 60, content: "👍" }, { message: 60, content: "❤️" }],
          recipients: [partner(8), partner(9)],
        },
        { id: 55, thread: thread(7), body: "<p>origin</p>", reactions: [] },
      ],
      MessageReactions: [
        { content: "👍", count: 2, sequence: 4, message: 60, personas: [partner(8), partner(SELF)] },
        { content: "❤️", count: 2, sequence: 9, message: 60, personas: [guest(2), partner(8)] },
      ],
    }, CFG, SELF);
    expect(d.messages[0]).toMatchObject({ messageId: 60, parentId: 55, recipientIds: [8, 9] });
    expect(d.messages[1]).not.toHaveProperty("parentId");
    expect(d.reactions).toEqual([
      { messageId: 60, content: "👍", count: 2, selfReacted: true, partnerIds: [8, SELF], guestCount: 0, sequence: 4 },
      { messageId: 60, content: "❤️", count: 2, selfReacted: false, partnerIds: [8], guestCount: 1, sequence: 9 },
    ]);
    expect(d.reactionSets).toEqual([
      { messageId: 60, contents: ["👍", "❤️"] },
      { messageId: 55, contents: [] },
    ]);
    expect(d.deletedReactions).toEqual([]);
  });

  it("parentMessage false gives a null parent", () => {
    const d = parseStore({ "mail.message": [{ id: 61, thread: thread(7), parentMessage: false }] }, CFG, SELF);
    expect(d.messages[0].parentId).toBeNull();
  });

  it("reads the bus ADD group without a full set", () => {
    const d = parseStore({
      "mail.message": [{ id: 60, reactions: [["ADD", [{ message: 60, content: "😂" }]]] }],
      MessageReactions: [{ content: "😂", count: 1, sequence: 12, message: 60, personas: [partner(8)] }],
      "res.partner": [{ id: 8, name: "Alice Martin" }],
    }, CFG, SELF);
    expect(d.reactions).toEqual([
      { messageId: 60, content: "😂", count: 1, selfReacted: false, partnerIds: [8], guestCount: 0, sequence: 12 },
    ]);
    expect(d.reactionSets).toEqual([]);
    expect(d.deletedReactions).toEqual([]);
  });

  it("reads DELETE as one object and as a list", () => {
    const one = parseStore({
      "mail.message": [{ id: 60, reactions: [["DELETE", { message: 60, content: "👍" }]] }],
    }, CFG, SELF);
    expect(one.deletedReactions).toEqual([{ messageId: 60, content: "👍" }]);
    const list = parseStore({
      "mail.message": [{ id: 60, reactions: [["DELETE", [{ message: 60, content: "👍" }, { message: 60, content: "🙏" }]]] }],
    }, CFG, SELF);
    expect(list.deletedReactions).toEqual([{ messageId: 60, content: "👍" }, { messageId: 60, content: "🙏" }]);
    expect(list.reactionSets).toEqual([]);
  });

  it("mergeDeltas applies a later set, delete or group over an earlier one", () => {
    const group = (content: string, count = 1) => ({
      content, count, sequence: 1, message: 60, personas: [partner(8)],
    });
    const a = parseStore({ "mail.message": [{ id: 60, reactions: [["ADD", []]] }], MessageReactions: [group("👍"), group("❤️")] }, CFG, SELF);
    const b = parseStore({
      "mail.message": [{ id: 60, reactions: [["DELETE", { message: 60, content: "❤️" }]] }],
      MessageReactions: [],
    }, CFG, SELF);
    const ab = mergeDeltas(a, b);
    expect(ab.reactions!.map((r) => r.content)).toEqual(["👍"]);
    expect(ab.deletedReactions).toEqual([{ messageId: 60, content: "❤️" }]);
    // A group added after its delete exists again
    const c = parseStore({ MessageReactions: [group("❤️", 2)] }, CFG, SELF);
    const abc = mergeDeltas(ab, c);
    expect(abc.reactions!.map((r) => [r.content, r.count])).toEqual([["👍", 1], ["❤️", 2]]);
    expect(abc.deletedReactions).toEqual([]);
    // A later full set drops the earlier groups it does not name
    const d = parseStore({ "mail.message": [{ id: 60, reactions: [{ message: 60, content: "❤️" }] }] }, CFG, SELF);
    const abcd = mergeDeltas(abc, d);
    expect(abcd.reactions!.map((r) => r.content)).toEqual(["❤️"]);
    expect(abcd.reactionSets).toEqual([{ messageId: 60, contents: ["❤️"] }]);
  });

  it("mergeDeltas unions deleted message ids", () => {
    const a = parseStore({}, CFG, SELF);
    a.deletedMessageIds = [1];
    const b = parseStore({}, CFG, SELF);
    b.deletedMessageIds = [2, 1];
    expect(mergeDeltas(a, b).deletedMessageIds).toEqual([1, 2]);
  });
});

describe("parseStore pin, star and the starred counter", () => {
  it("reads pinned_at as a date, then false as unpinned, and starred", () => {
    const pinned = parseStore({
      "mail.message": [{ id: 70, thread: thread(7), pinned_at: "2026-10-26 10:00:00", starred: true }],
    }, CFG, SELF);
    expect(pinned.messages[0]).toMatchObject({ messageId: 70, pinnedAt: "2026-10-26 10:00:00", starred: true });
    const unpinned = parseStore({ "mail.message": [{ id: 70, pinned_at: false, starred: false }] }, CFG, SELF);
    expect(unpinned.messages[0]).toEqual({ messageId: 70, pinnedAt: null, starred: false });
    const absent = parseStore({ "mail.message": [{ id: 70, thread: thread(7), body: "<p>x</p>" }] }, CFG, SELF);
    expect(absent.messages[0]).not.toHaveProperty("pinnedAt");
    expect(absent.messages[0]).not.toHaveProperty("starred");
  });

  it("reads Store.starred.counter, absent when the Store has none", () => {
    expect(parseStore({ Store: { starred: { counter: 4, id: "starred", model: "mail.box" } } }, CFG, SELF).starredCounter)
      .toBe(4);
    expect(parseStore({ Store: { inbox: { counter: 1 } } }, CFG, SELF).starredCounter).toBeUndefined();
  });

  it("mergeDeltas keeps the later starred counter, the earlier when the later has none", () => {
    const a = parseStore({ Store: { starred: { counter: 2 } } }, CFG, SELF);
    const b = parseStore({ Store: { starred: { counter: 5 } } }, CFG, SELF);
    expect(mergeDeltas(a, b).starredCounter).toBe(5);
    expect(mergeDeltas(b, parseStore({}, CFG, SELF)).starredCounter).toBe(5);
  });
});

describe("parseStore the starred box", () => {
  it("reads the starred box a delete sends: its messages unstarred and its counter", () => {
    // _cleanup_side_records: the box's count and the emptied messages leaving it
    const d = parseStore({
      "mail.thread": [
        { counter: 1, counter_bus_id: 1002, id: "starred", messages: [["DELETE", [70, 71]]], model: "mail.box" },
        { counter: 9, id: "inbox", model: "mail.box" },
      ],
    }, CFG, SELF);
    expect(d.starredCounter).toBe(1);
    expect(d.messages).toEqual([{ messageId: 70, starred: false }, { messageId: 71, starred: false }]);
    const added = parseStore({ "mail.thread": [{ id: "starred", model: "mail.box", messages: [["ADD", [72]]] }] }, CFG, SELF);
    expect(added.starredCounter).toBeUndefined();
    expect(added.messages).toEqual([{ messageId: 72, starred: true }]);
  });
});

describe("parseStore mailbox pages", () => {
  const task = { id: 5, model: "project.task" };
  const page = {
    "mail.thread": [{ id: 5, model: "project.task", name: "Tâche démo" }],
    "discuss.channel": [chan(2, "channel", { name: "général-test" })],
    "mail.message": [
      { id: 90, thread: task, body: "<p>Bonjour</p>", date: "2026-10-26 10:00:00", message_type: "comment", needaction: true, starred: false, author: partner(8), record_name: "Tâche démo" },
      { id: 91, thread: thread(2), body: "<p>@Moi</p>", date: "2026-10-26 10:05:00", message_type: "comment", needaction: true, author: partner(8) },
      { id: 92, thread: { id: 6, model: "project.task" }, body: "", date: "2026-10-26 10:06:00", message_type: "user_notification", needaction: true, record_name: "Autre tâche" },
    ],
  };

  it("keeps the messages of other models as mailbox partials and the channel one in messages", () => {
    const d = parseStore(page, CFG, SELF);
    expect(d.mailbox).toEqual([
      { messageId: 90, threadModel: "project.task", threadId: 5, recordName: "Tâche démo", authorPartnerId: 8, body: "<p>Bonjour</p>", date: "2026-10-26 10:00:00", messageType: "comment", needaction: true, starred: false },
      { messageId: 92, threadModel: "project.task", threadId: 6, recordName: "Autre tâche", body: "", date: "2026-10-26 10:06:00", messageType: "user_notification", needaction: true },
    ]);
    expect(d.messages.map((m) => m.messageId)).toEqual([91]);
  });

  it("reads model and res_id when the message has no thread, and the record name of the thread entry", () => {
    const d = parseStore({
      "mail.thread": [{ id: 7, model: "res.partner", name: "Contact démo" }],
      "mail.message": [{ id: 93, model: "res.partner", res_id: 7, needaction: false }],
    }, CFG, SELF);
    expect(d.mailbox).toEqual([{ messageId: 93, threadModel: "res.partner", threadId: 7, recordName: "Contact démo", needaction: false }]);
  });

  it("a message with neither thread nor record gives no partial", () => {
    const d = parseStore({ "mail.message": [{ id: 94, thread: false, body: "x" }] }, CFG, SELF);
    expect(d.mailbox ?? []).toEqual([]);
    expect(d.messages).toEqual([]);
  });

  it("mailboxPartialsOf adds the channel messages of a page with the page flags", () => {
    const d = parseStore(page, CFG, SELF);
    const added = mailboxPartialsOf(d, [90, 91], { needaction: true, history: false });
    expect(added).toEqual([{
      messageId: 91, threadModel: "discuss.channel", threadId: 2, recordName: "général-test", authorPartnerId: 8,
      body: "<p>@Moi</p>", date: "2026-10-26 10:05:00", messageType: "comment", needaction: true, history: false,
    }]);
    expect(mailboxPartialsOf(d, [90], {})).toEqual([]);
  });

  it("mergeDeltas merges two mailbox deltas, the later winning per message and never blanking", () => {
    const a = parseStore(page, CFG, SELF);
    const b = parseStore({ "mail.message": [{ id: 90, thread: task, needaction: false }] }, CFG, SELF);
    const m = mergeDeltas(a, b);
    expect(m.mailbox!.find((x) => x.messageId === 90)).toMatchObject({ body: "<p>Bonjour</p>", needaction: false });
    expect(m.mailbox!.map((x) => x.messageId)).toEqual([90, 92]);
    expect(mergeDeltas(b, a).mailbox!.find((x) => x.messageId === 90)!.needaction).toBe(true);
  });
});

describe("mailboxKindOf", () => {
  const base: ChatMailboxItem = {
    configId: CFG, messageId: 1, threadModel: "project.task", threadId: 5, recordName: "", authorPartnerId: null,
    body: "", date: null, messageType: "comment", needaction: true, starred: false, history: false,
  };
  it("a channel message is a mention, a user notification an assignment, anything else a record message", () => {
    expect(mailboxKindOf({ ...base, threadModel: "discuss.channel" })).toBe("mention");
    expect(mailboxKindOf({ ...base, messageType: "user_notification" })).toBe("assignment");
    expect(mailboxKindOf(base)).toBe("record");
    expect(mailboxKindOf({ ...base, threadModel: "discuss.channel", messageType: "user_notification" })).toBe("mention");
  });
});
