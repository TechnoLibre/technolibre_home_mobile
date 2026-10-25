import { describe, it, expect } from "vitest";
import type { ChatChannel, ChatMember, ChatPartner } from "../models/chat";
import { displayNameOf } from "../services/chat/chatNames";

const CFG = "c";
const ch = (over: Partial<ChatChannel> = {}): ChatChannel =>
  ({ configId: CFG, channelId: 1, channelType: "group", name: "", customChannelName: null, correspondentPartnerId: null, ...over }) as ChatChannel;
const mem = (memberId: number, partnerId: number): ChatMember => ({ configId: CFG, channelId: 1, memberId, partnerId }) as ChatMember;
const partners = new Map<number, ChatPartner>(
  [[1, "Me"], [2, "Alice"], [3, "Bob"], [4, "Cleo"]].map(([id, name]) => [id as number, { configId: CFG, partnerId: id as number, name: name as string, imStatus: null }]),
);

describe("displayNameOf", () => {
  it("a chat shows its custom label, then the correspondent", () => {
    const chat = ch({ channelType: "chat", name: "Me, Alice", correspondentPartnerId: 2 });
    expect(displayNameOf({ ...chat, customChannelName: "Pal" }, [], partners, 1, "en")).toBe("Pal");
    expect(displayNameOf(chat, [], partners, 1, "en")).toBe("Alice");
  });

  it("a nameless group lists its members by member id, self included, in the app language", () => {
    const members = [mem(30, 4), mem(10, 1), mem(20, 3)];
    expect(displayNameOf(ch(), members, partners, 1, "en")).toBe("Me, Bob, and Cleo");
    expect(displayNameOf(ch(), members, partners, 1, "fr")).toBe("Me, Bob et Cleo");
    expect(displayNameOf(ch(), [mem(1, 1), mem(2, 2)], partners, 1, "en")).toBe("Me and Alice");
  });

  it("a named group or a channel keeps its name; a nameless group without members is empty", () => {
    expect(displayNameOf(ch({ name: "Team" }), [mem(1, 2)], partners, 1, "en")).toBe("Team");
    expect(displayNameOf(ch({ channelType: "channel", name: "general" }), [], partners, 1, "en")).toBe("general");
    expect(displayNameOf(ch(), [], partners, 1, "en")).toBe("");
  });

  it("a chat with nobody else shows the user's own name", () => {
    const self = ch({ channelType: "chat", name: "", correspondentPartnerId: null });
    expect(displayNameOf(self, [mem(1, 1)], partners, 1, "en")).toBe("Me");
    expect(displayNameOf({ ...self, name: "Me (you)" }, [mem(1, 1)], partners, 1, "en")).toBe("Me (you)");
  });

  it("a correspondent not cached falls back to the stored name", () => {
    expect(displayNameOf(ch({ channelType: "chat", name: "Zed", correspondentPartnerId: 99 }), [], partners, 1, "en")).toBe("Zed");
  });
});
