/**
 * Records of the mobile chat cache. Every row is keyed by `configId`, the
 * identity of the Odoo account it was read with. Dates are Odoo's
 * "YYYY-MM-DD HH:MM:SS" UTC strings, kept as given.
 */

export type ChannelType = "chat" | "group" | "channel";

export interface ChatChannel {
  configId: string;
  channelId: number;
  channelType: ChannelType;
  name: string;
  description: string;
  lastInterestDt: string | null;
  unreadCounter: number;
  needactionCounter: number;
  newMessageSeparator: number;
  seenMessageId: number | null;
  muteUntilDt: string | null;
  customNotifications: string | null;
  isMember: boolean;
  localPinned: boolean;
  lastMessageId: number | null;
  oldestLoadedId: number | null;
  historyComplete: boolean;
  correspondentPartnerId: number | null;
}

/** sent: known to the server; pending: queued in the outbox; failed: the outbox gave up. */
export type ChatMessageStatus = "sent" | "pending" | "failed";

export interface ChatMessage {
  configId: string;
  channelId: number;
  messageId: number | null;
  clientUuid: string | null;
  authorPartnerId: number | null;
  body: string;
  date: string;
  messageType: string;
  status: ChatMessageStatus;
  outboxOpId: string | null;
  writeDate: string | null;
}

export interface ChatMember {
  configId: string;
  channelId: number;
  memberId: number;
  partnerId: number;
  seenMessageId: number | null;
  fetchedMessageId: number | null;
  isTyping: boolean;
  typingAt: string | null;
}

export interface ChatPartner {
  configId: string;
  partnerId: number;
  name: string;
  imStatus: string | null;
}

export type ChatModuleState = "installed" | "available" | "absent" | "unknown";

export interface ChatSourceState {
  configId: string;
  selfPartnerId: number | null;
  lastBusId: number;
  busSeenAt: string | null;
  wsVersion: string | null;
  isSystem: boolean;
  moduleState: ChatModuleState;
  inboxCounter: number;
  loadedAt: string | null;
  /** Highest bus id whose counter changes are applied; a notification at or below it moves no counter. */
  counterBusId: number;
}

/** One notification of the Odoo bus: its bus id and the typed message it carries. */
export interface BusNotification {
  id: number;
  message: { type: string; payload: any };
}
