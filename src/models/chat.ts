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
  /** Bus id the stored unreadCounter is as of; an older counter is not taken. */
  unreadCounterBusId: number;
  /** Bus id the stored needactionCounter is as of; an older counter is not taken. */
  needactionCounterBusId: number;
  /** Shown in the user's list; a hidden direct message is false. A row never read defaults to shown. */
  isPinned: boolean;
  /** Whether the user may rename or edit the channel; null while the server never said. */
  isEditable: boolean | null;
  /** The user's own label of a chat (`custom_channel_name`). */
  customChannelName: string | null;
  memberCount: number | null;
  /** Id of the group that may join; null for everyone. */
  groupPublicId: number | null;
  authorizedGroupFullName: string | null;
  createUid: number | null;
  /** Membership follows an access group, so the user cannot leave it. */
  groupBasedSubscription: boolean;
  parentChannelId: number | null;
  /** Outbox op that creates the channel while it only exists on the phone. */
  createOpId: string | null;
  /**
   * The server refused to create (or join) it: kept, with its texts as not
   * sent, until the user dismisses it.
   */
  createFailed: boolean;
  /**
   * The user left it while texts were still queued: kept, no longer a
   * member, listed with those texts as not sent until the user dismisses it.
   */
  leftUnsent: boolean;
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
  createDate: string | null;
}

export interface ChatPartner {
  configId: string;
  partnerId: number;
  name: string;
  imStatus: string | null;
}

export type ChatModuleState = "installed" | "outdated" | "available" | "absent" | "unknown";

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
  /** Id of Odoo's internal-users group, the default access group of a new channel. */
  internalUserGroupId: number | null;
  /** End of the account-wide mute (`res.users.settings.mute_until_dt`); null when not muted. */
  globalMuteUntil: string | null;
  /** ISO time `globalMuteUntil` was last set from the bus; a load that started earlier does not overwrite it. */
  globalMuteAt: string | null;
  isInternalUser: boolean;
}

/**
 * An action the chat outbox gave up on, kept until the user dismisses it:
 * the server refused it ("refused"), or its conversation is gone or no
 * longer the user's ("vanished"); or the actions a conversation the server
 * took away cancelled (kind chat.dropped). `id` is the outbox row that
 * holds it.
 */
export interface ChatNotice {
  id: string;
  configId: string;
  /** The outbox kind of the action (chat.rename, chat.mute, ...). */
  kind: string;
  channelId: number | null;
  reason: "refused" | "vanished";
  /** The server's message for a refusal; "" otherwise. */
  error: string;
  /** Actions it stands for: those a conversation taken away cancelled (chat.dropped), else 1. */
  count: number;
  /** The conversation's name as cached when the notice was made (chat.dropped); "" otherwise. */
  label: string;
}

/** One notification of the Odoo bus: its bus id and the typed message it carries. */
export interface BusNotification {
  id: number;
  message: { type: string; payload: any };
}
