import { describe, it, expect } from "vitest";
import type { ChatChannel } from "../models/chat";
import { isBold, isMuted, sortConversations, totalUnread, unreadOf } from "../services/chat/chatUnread";

const ch = (over: Partial<ChatChannel> = {}): ChatChannel => ({
  configId: "c",
  channelId: 1,
  channelType: "chat",
  name: "n",
  description: "",
  lastInterestDt: null,
  unreadCounter: 0,
  needactionCounter: 0,
  newMessageSeparator: 0,
  seenMessageId: null,
  muteUntilDt: null,
  customNotifications: null,
  isMember: true,
  localPinned: false,
  lastMessageId: null,
  oldestLoadedId: null,
  historyComplete: false,
  correspondentPartnerId: null,
  ...over,
});

const now = new Date("2026-01-01T12:00:00Z");

describe("unreadOf / isBold", () => {
  it("counts unread for chat and group, mentions only for channel", () => {
    expect(unreadOf(ch({ unreadCounter: 3 }))).toBe(3);
    expect(unreadOf(ch({ channelType: "group", unreadCounter: 3 }))).toBe(3);
    const quiet = ch({ channelType: "channel", unreadCounter: 5 });
    expect(unreadOf(quiet)).toBe(0);
    expect(isBold(quiet)).toBe(true);
    expect(unreadOf(ch({ channelType: "channel", needactionCounter: 2 }))).toBe(2);
    expect(isBold(ch({ channelType: "channel" }))).toBe(false);
  });
});

describe("isMuted", () => {
  it("honours a future date, the forever value and no_notif", () => {
    expect(isMuted(ch({ muteUntilDt: "2026-01-01 13:00:00" }), now)).toBe(true);
    expect(isMuted(ch({ muteUntilDt: "9999-12-31 23:59:59" }), now)).toBe(true);
    expect(isMuted(ch({ muteUntilDt: "2026-01-01 11:00:00" }), now)).toBe(false);
    expect(isMuted(ch(), now)).toBe(false);
    expect(isMuted(ch({ customNotifications: "no_notif" }), now)).toBe(true);
  });
});

describe("totalUnread", () => {
  it("adds inbox counters and skips muted conversations", () => {
    const list = [
      ch({ unreadCounter: 3 }),
      ch({ channelId: 2, channelType: "channel", needactionCounter: 2 }),
      ch({ channelId: 3, channelType: "group", unreadCounter: 4, customNotifications: "no_notif" }),
    ];
    expect(totalUnread(list, [1], now)).toBe(6);
  });
});

describe("sortConversations", () => {
  it("puts unread first, each group by recency, a bold channel stays in the second", () => {
    const a = ch({ channelId: 1, unreadCounter: 1, lastInterestDt: "2026-01-01 10:00:00" });
    const b = ch({ channelId: 2, unreadCounter: 1, lastInterestDt: "2026-01-01 11:00:00" });
    const c = ch({ channelId: 3, lastInterestDt: "2026-01-01 09:00:00" });
    const d = ch({ channelId: 4, channelType: "channel", unreadCounter: 7, lastInterestDt: "2026-01-01 11:30:00" });
    const e = ch({ channelId: 5, lastInterestDt: null });
    const ids = sortConversations([c, e, a, d, b]).map((x) => x.channelId);
    expect(ids).toEqual([2, 1, 4, 3, 5]);
  });
});
