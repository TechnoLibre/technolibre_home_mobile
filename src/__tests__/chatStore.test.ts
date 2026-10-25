import { describe, it, expect } from "vitest";
import { parseStore, mergeDeltas } from "../services/chat/chatStore";

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
