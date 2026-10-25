import type { ChatChannel, ChatMember, ChatPartner } from "../../models/chat";

/**
 * The name a conversation is shown under, in Odoo's order (Thread.displayName):
 * a chat's own label, the correspondent's name, a group without a name as the
 * names of its members (self included, in member-id order) joined by the
 * language's "and", then the stored name. A chat with nobody else in it shows
 * the user's own name. `lang` is the app language ("en" or "fr"); a partner
 * not cached yet, or without a name, is left out of the list.
 */
export function displayNameOf(
  channel: ChatChannel,
  members: ChatMember[],
  partners: Map<number, ChatPartner>,
  selfPartnerId: number | null,
  lang: string,
): string {
  const nameOf = (partnerId: number | null): string =>
    partnerId === null ? "" : (partners.get(partnerId)?.name ?? "");
  if (channel.channelType === "chat") {
    if (channel.customChannelName) return channel.customChannelName;
    const other = nameOf(channel.correspondentPartnerId);
    if (other) return other;
  }
  if (channel.channelType === "group" && !channel.name) {
    const names = [...members]
      .sort((a, b) => a.memberId - b.memberId)
      .map((m) => nameOf(m.partnerId))
      .filter((n) => n !== "");
    if (names.length > 0) return new Intl.ListFormat(lang, { type: "conjunction", style: "long" }).format(names);
  }
  if (channel.name) return channel.name;
  if (channel.channelType === "chat" && channel.correspondentPartnerId === null) return nameOf(selfPartnerId);
  return "";
}
