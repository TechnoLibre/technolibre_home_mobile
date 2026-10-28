/**
 * Records of the mobile chat cache. Every row is keyed by `configId`, the
 * identity of the Odoo account it was read with. Dates are Odoo's
 * "YYYY-MM-DD HH:MM:SS" UTC strings, kept as given.
 */

import type { Mentions } from "../services/chat/chatCompose";

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
  /**
   * Kept on top of the list, a choice local to the phone (not Odoo's
   * is_pinned, which means shown in the sidebar). Filled by the repository's
   * reads from chat_on_top; absent on a channel built elsewhere.
   */
  onTop?: boolean;
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
  /** Server id of the message this one replies to; null for none (or a parent the server dropped). */
  parentId?: number | null;
  /** Client uuid of the replied-to message while it is still queued (no server id yet). */
  parentClientUuid?: string | null;
  /** The partners the message mentions (`recipients`), in the server's order. */
  recipientIds?: number[];
  /** When the message was pinned in its channel (`pinned_at`); null when it is not pinned. */
  pinnedAt?: string | null;
  /** Whether the user starred the message (`starred`, per user on the server). */
  starred?: boolean;
  /** Posted as an internal note (`is_note`: the subtype is mail.mt_note): it never joins its author's run. */
  isNote?: boolean;
}

/** A message as an action names it: by server id once it has one, else by the client uuid of its post. */
export interface MessageTarget {
  messageId: number | null;
  clientUuid: string | null;
}

/** Whether two targets name one message: by the client uuid of its post when both have one, else by server id. */
export function sameTarget(a: MessageTarget, b: MessageTarget): boolean {
  if (a.clientUuid && b.clientUuid) return a.clientUuid === b.clientUuid;
  return a.messageId != null && a.messageId === b.messageId;
}

/** The local key of a message among its account's rows: `m<id>` once the server has it, `u<clientUuid>` before. */
export function messageKeyOf(m: { messageId: number | null; clientUuid: string | null }): string {
  return m.messageId !== null ? `m${m.messageId}` : `u${m.clientUuid}`;
}

/**
 * One reaction group of a message: an emoji (`content`, the exact string
 * the server stores) with how many reacted, whether the user did, and the
 * partners who did in the server's order (guests only counted). Keyed by
 * `messageKey` (see messageKeyOf), so a reaction to a queued message
 * exists before its message has an id. `sequence` orders the groups of a
 * message (the server's lowest reaction id of the group).
 */
export interface ChatReaction {
  configId: string;
  channelId: number;
  messageKey: string;
  messageId: number | null;
  content: string;
  count: number;
  selfReacted: boolean;
  partnerIds: number[];
  guestCount: number;
  sequence: number;
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
  /**
   * The partner's `write_date` as the Store carries it beside its avatar
   * (`res_partner.py` `_to_store`): the `unique` key of its avatar URL, as
   * the browser's `avatarUrl`. Null while no Store gave it.
   */
  writeDate?: string | null;
}

/**
 * A partner's avatar cached on the phone (`/web/image/res.partner/<id>/avatar_128`),
 * one per partner and account: the `unique` key it was fetched with, its
 * file (relative to Directory.Data) and its size.
 */
export interface ChatAvatar {
  configId: string;
  partnerId: number;
  uniqueKey: string;
  path: string;
  bytes: number;
  fetchedAt: string;
}

/**
 * draft: kept in a conversation's composer, not sent yet (no post, no
 * outbox op); queued: given to a post, still on the phone; uploaded: the
 * server holds it as a pending attachment, the post is not answered yet;
 * posted: part of a message (also every attachment read from the server);
 * refused: the server refused the file, kept until the user dismisses it.
 */
export type ChatAttachmentState = "draft" | "queued" | "uploaded" | "posted" | "refused";

/** Where a file of the phone was taken: a pick of that kind, or the voice recorder. */
export type ChatFileOrigin = "camera" | "gallery" | "file" | "voice";

/**
 * One file of a message, or of a conversation's draft. Keyed
 * `configId#a<attachmentId>` once the server has an id,
 * `configId#l<localUuid>` while it only exists on the phone.
 * Paths are relative to the app data directory; the bytes columns are the
 * size of the cached file, 0 when absent. A file of a reply on a record
 * (or of its draft) names the record in threadModel / threadId and has
 * channelId 0, which no conversation has.
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
  /** The record's model for a file of a reply on a record; null (or absent) for a conversation's. */
  threadModel?: string | null;
  /** The record's id for a file of a reply on a record; null (or absent) for a conversation's. */
  threadId?: number | null;
}

/** A record whose chatter a reply goes to: its model, its id and its name as the inbox showed it. */
export interface RecordThread {
  model: string;
  resId: number;
  recordName: string;
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
  moduleLevel: "1.0" | "1.1" | "1.2" | "1.3" | "1.4" | null;
  /** How many messages the user starred (`Store.starred.counter`). */
  starredCounter: number;
  /** Whether Odoo mails the user's notifications or keeps them in the inbox (`notification_type`); null while unknown. */
  notificationType: "email" | "inbox" | null;
}

/**
 * A message of the inbox, history or starred boxes, of any model: the
 * cached shape of what `/mail/{inbox,history,starred}/messages` return.
 * `threadModel`/`threadId` name the record (or channel) it belongs to.
 */
export interface ChatMailboxItem {
  configId: string;
  messageId: number;
  threadModel: string;
  threadId: number;
  recordName: string;
  authorPartnerId: number | null;
  body: string;
  date: string | null;
  messageType: string;
  needaction: boolean;
  starred: boolean;
  history: boolean;
}

/** Why an inbox item reached the user: a channel mention, an assignment notice, or a followed record's message. */
export type MailboxKind = "mention" | "record" | "assignment";

/** The kind of an inbox item (`mail/controllers/thread.py` notifies a channel by mention, a user notification by assignment). */
export function mailboxKindOf(i: ChatMailboxItem): MailboxKind {
  if (i.threadModel === "discuss.channel") return "mention";
  if (i.messageType === "user_notification") return "assignment";
  return "record";
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
  /**
   * "refused": by the server; "vanished": the conversation, or the
   * message acted on, is gone; "changed": the message changed on the
   * server since the action was queued (an edit, refused rather than
   * written over the newer body).
   */
  reason: "refused" | "vanished" | "changed";
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
  /** The message an action on a message names (a reaction, ...), as its op stored it. */
  message?: MessageTarget;
  /**
   * An edit refused as "changed" (chat.edit): its message, the text and
   * picks it would have written, and whether the message was deleted
   * meanwhile (« Reprendre » then makes the text a new message).
   */
  edit?: { target: MessageTarget; text: string; mentions: Mentions; deleted: boolean };
  /**
   * A reply on a record the server refused (chat.record_post): the record,
   * the text, whether it was an internal note, and the local uuids of its
   * files, kept on the phone until the notice is dismissed.
   */
  reply?: { thread: RecordThread; text: string; note: boolean; files: string[] };
}

/** One notification of the Odoo bus: its bus id and the typed message it carries. */
export interface BusNotification {
  id: number;
  message: { type: string; payload: any };
}

/** What an account's notifications show on the lock screen: hidden while locked (the default), never, always. */
export type LockScreen = "hidden_locked" | "never" | "always";

/**
 * An account's closed-app notifications (table chat_push). ntfyUrl null:
 * no ntfy, the account is only polled from Odoo. topic, p256dh and auth
 * are the Web Push subscription native code drew on that ntfy; endpoint
 * is the topic's URL as Odoo reaches it (odooNtfyUrl, else ntfyUrl).
 * vapidKey and registeredAt are those of the last register_devices that
 * Odoo accepted. staleEndpoints are endpoints this phone left that Odoo
 * may still push to: each is unregistered, then dropped from the list.
 */
export interface ChatPushRow {
  configId: string;
  ntfyUrl: string | null;
  odooNtfyUrl: string | null;
  prefix: string | null;
  topic: string | null;
  endpoint: string | null;
  p256dh: string | null;
  auth: string | null;
  vapidKey: string | null;
  registeredAt: string | null;
  staleEndpoints: string[];
  lockScreen: LockScreen;
}
