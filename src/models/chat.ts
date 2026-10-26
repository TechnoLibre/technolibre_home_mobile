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

/**
 * queued: still on the phone; uploaded: the server holds it as a pending
 * attachment, the post is not answered yet; posted: part of a message
 * (also every attachment read from the server); refused: the server
 * refused the file, kept until the user dismisses it.
 */
/** "draft": a file kept in a conversation's composer, not sent yet (no post, no outbox op). */
export type ChatAttachmentState = "draft" | "queued" | "uploaded" | "posted" | "refused";

/** Where a file of the phone was taken: a pick of that kind, or the voice recorder. */
export type ChatFileOrigin = "camera" | "gallery" | "file" | "voice";


/**
 * One file of a message, or of a conversation's draft. Keyed
 * `configId#a<attachmentId>` once the server has an id,
 * `configId#l<localUuid>` while it only exists on the phone.
 * Paths are relative to the app data directory; the bytes columns are the
 * size of the cached file, 0 when absent.
 */
export interface ChatAttachment {
  configId: string;
  channelId: number;
  messageId: number | null;
  attachmentId: number | null;
  localUuid: string | null;
  /** Client uuid of the post the file belongs to while that post is queued. */
  postClientUuid: string | null;
  /** Position among the files of one message. */
  seq: number;
  name: string;
  mimetype: string;
  size: number;
  checksum: string | null;
  voice: boolean;
  thumbPath: string | null;
  thumbBytes: number;
  originalPath: string | null;
  originalBytes: number;
  state: ChatAttachmentState;
  error: string | null;
  lastOpenedAt: string | null;
  createdAt: string;
  /**
   * Where a file of the composer was taken (a camera or gallery photo is
   * offered compression at send); null for a server file or when unknown.
   */
  origin?: ChatFileOrigin | null;
}

/** A file picked on the phone, waiting to be uploaded with its post. */
export interface OutgoingFile {
  localUuid: string;
  path: string;
  name: string;
  mimetype: string;
  size: number;
  voice: boolean;
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
  /** Random id of the account's directory under chat/; never derived from the account. */
  fileDir: string | null;
  /** Level of the server module (attachment upload route at "1.2"); null while unknown. */
  moduleLevel: "1.0" | "1.1" | "1.2" | null;
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
  /**
   * A file of a post not sent (chat.file_refused): its name, why, and the
   * server's size limit in bytes when "too_big" was decided against it
   * (null after a 413, whose limit is unknown).
   */
  file?: { name: string; reason: "too_big" | "missing" | "refused" | "not_found"; limit: number | null };
}

/** One notification of the Odoo bus: its bus id and the typed message it carries. */
export interface BusNotification {
  id: number;
  message: { type: string; payload: any };
}
