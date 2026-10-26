import { markup, onMounted, onWillUnmount, useRef, useState, xml } from "@odoo/owl";
import { App } from "@capacitor/app";
import { Dialog } from "@capacitor/dialog";

import { EnhancedComponent } from "../../js/enhancedComponent";
import { HeadingComponent } from "../heading/heading_component";
import { Events } from "../../constants/events";
import { getCurrentLocale, t } from "../../i18n";
import { bodyPreview, bodyText, isEdited, isEmptyBody, isEmptyMessage, renderBody } from "../../services/chat/chatBody";
import type { ChatSource } from "../../services/chat/chatService";
import { displayNameOf } from "../../services/chat/chatNames";
import { messageKeyOf } from "../../models/chat";
import type {
    ChatAttachment, ChatChannel, ChatMember, ChatMessage, ChatNotice, ChatPartner, ChatReaction, MessageTarget, OutgoingFile,
} from "../../models/chat";
import { EMPTY_MENTIONS, joinMentions, validMentions, type Mentions } from "../../services/chat/chatCompose";
import {
    adjustPicks, applySuggestion, mentionQuery, picksOf, picksToMentions, type MentionPick, type MentionQuery, type Suggestion,
} from "../../services/chat/chatMentions";
import type { ChatDraft } from "../../services/chat/chatRepository";
import { quickReactions } from "../../services/chat/chatEmoji";
import { CHAT_DELETE, CHAT_UPLOAD, sameTarget, targetOf } from "../../services/chat/chatOutbox";
import { DraftText, joinDraftText } from "../../services/chat/chatDraft";
import { ChatFile } from "../../plugins/chatFilePlugin";
import { formatListTime, initialsOf } from "./chat_list_component";
import {
    ChatComposerAttachComponent,
    ComposerAttach,
    deviceComposerDeps,
    newComposerAttachState,
    type ComposerAttachState,
} from "./chat_composer_attach_component";
import {
    ChatAttachmentsComponent,
    ThreadAttachments,
    viewSig,
    type AttachmentView,
} from "./chat_attachments_component";
import { ChatImageViewerComponent } from "./chat_image_viewer_component";
import { ChatEmojiPickerComponent } from "./chat_emoji_picker_component";
import { ChatMessageMenuComponent, type MessageCan } from "./chat_message_menu_component";
import { ChatReactionsComponent, ChatReactionWhoComponent, reactionViews, type ReactionView } from "./chat_reactions_component";
import { LongPress } from "./chatLongPress";
import { ChatComposerBannerComponent, type ComposerMode } from "./chat_composer_banner_component";
import { ChatSuggestionsComponent } from "./chat_suggestions_component";

/** Quiet period that folds a burst of CHAT_CHANGED into one refresh. */
const CHANGE_DEBOUNCE_MS = 150;
/** A member counts as typing for this long after the server's timestamp. */
const TYPING_FRESH_MS = 60000;
/** Quiet time after the last keystroke before the server is asked for suggestions (Odoo's FETCH_SUGGESTIONS_DELAY). */
const SUGGEST_FETCH_MS = 250;
/** Distance from the edge, in px, that counts as "at the top" or "at the bottom". */
const EDGE_PX = 40;
/** The composer grows to this many lines, then scrolls. */
const MAX_INPUT_ROWS = 5;
/** Server messages rendered at open: the newest ones, however long the cached history. */
export const THREAD_WINDOW = 100;
/** Cached messages a scroll to the top adds to the rendered ones before the server is asked. */
export const THREAD_PAGE = 50;

type MetaKind =
    | "none" | "sent" | "seen" | "pending" | "waiting" | "waiting_create" | "waiting_wifi" | "ambiguous" | "failed" | "left";

/** The outbox ops a build reads, for the pending rows' marks and the deletes still queued. */
type RowOp = { id: string; kind?: string; dependsOn: string | null; status?: string; params?: Record<string, any> };

/**
 * The message a reply quotes, as Odoo's `MessageInReply` shows it: its
 * author and the start of its text (bodyPreview) with the edited mark,
 * « Tap to see the attachments » when it has files only (state
 * "attachments"), « Original message was deleted » once emptied or
 * removed (state "deleted"), « Original message » with no author when it
 * was never loaded. `key` is the row key of the original, which a tap
 * scrolls to while it is rendered; null when there is nothing to reach.
 */
export interface QuoteView {
    key: string | null;
    author: string;
    text: string;
    edited: boolean;
    state: "text" | "attachments" | "deleted";
}

/** The quote of a message emptied or gone: « Original message was deleted », nothing to reach. */
function deletedQuote(): QuoteView {
    return { key: null, author: "", text: t("chat.quote_deleted"), edited: false, state: "deleted" };
}

/** A replied-to message found in the cache, with whether it has files. */
type Parent = { message: ChatMessage; files: boolean };

export interface ThreadRow {
    key: string;
    own: boolean;
    html: unknown;
    /** The body shows something (an attachment-only message has no text bubble). */
    hasBody: boolean;
    time: string;
    meta: MetaKind;
    opId: string | null;
    /** The message's files, in pick order (ThreadAttachments.views). */
    attachments: AttachmentView[];
    /** The message's key among its account's rows (messageKeyOf), which its reactions are stored under. */
    messageKey: string;
    /** The message as an action names it. */
    target: MessageTarget;
    /** Its reaction chips, in the server's order. */
    reactions: ReactionView[];
    /** What its long-press menu offers. */
    can: MessageCan;
    /** The message it replies to; null for none. */
    quote: QuoteView | null;
}

interface ThreadState {
    title: string;
    serverLabel: string;
    presence: "online" | "away" | "offline" | null;
    rows: ThreadRow[];
    typing: string;
    text: string;
    menu: boolean;
    /** Messages added so far by "load all"; null when it is not running. */
    loadingAll: number | null;
    historyComplete: boolean;
    found: boolean;
    /**
     * The server refused to create ("create") or join ("join") the
     * conversation, or the user left it with texts unsent ("left"); "" otherwise.
     */
    failedCreate: "" | "create" | "join" | "left";
    /** Text of the last failed send or retry; "" when none. */
    error: string;
    /** Rows the composer shows, from 1 up to MAX_INPUT_ROWS. */
    inputRows: number;
    /** The emoji picker is open. */
    emoji: boolean;
    /** Row key of the message whose long-press menu is open; null when it is closed. */
    actions: string | null;
    /** Row key of the message the open picker reacts to; null while the picker types into the composer. */
    reactTo: string | null;
    /** The reaction whose « who reacted » sheet is open; null when it is closed. */
    who: ReactionView | null;
    /** « Copied », or the copy's refusal, for FLASH_MS; "" otherwise. */
    flash: string;
    /** Key of the image the viewer shows; null when it is closed. */
    viewer: string | null;
    /** Row key of the message a tap on a quote scrolled to, for HIGHLIGHT_MS; null otherwise. */
    highlight: string | null;
    /** From the ➤ tap until the post is queued: the text takes no input, 📎, 🎤 and ➤ are off. */
    sending: boolean;
    /** The bubble of a send with files, from the tap until its post is queued; null otherwise. */
    preparing: PreparingBubble | null;
    /** What ➤ does: a new message, a reply, or an edit of the user's own message; kept in the draft. */
    mode: ComposerMode;
    /** The quote of the message the mode names, shown in the banner; null in the new-message mode. */
    banner: QuoteView | null;
    /** This conversation's edits refused because the message changed: each offers « Reprendre » and « Ignorer ». */
    resumes: { id: string; text: string }[];
    /** The @ or # suggestions of the word the caret ends; none hides the list. */
    suggestions: Suggestion[];
}

/**
 * What the thread shows of a send with files before its post is queued
 * (the compress question and the compression take seconds): its text, its
 * files (an image as its staged file, once its address is known) and a
 * status line.
 */
interface PreparingBubble {
    text: string;
    label: string;
    files: { key: string; name: string; image: boolean; url: string | null }[];
}

/** Images the web view shows from their staged file in a preparing bubble. */
const SHOWN_IMAGE = /^image\/(jpeg|png|gif|webp)$/;
/**
 * Images a preparing bubble shows at most, the others by name: a staged
 * photo is the full-size original, and the web view decodes each one shown.
 */
const PREPARING_IMAGES = 3;

/** How long « Copied » (or the copy's refusal) stays shown, in ms. */
const FLASH_MS = 1500;
/** How long the original of a tapped quote stays highlighted, in ms. */
const HIGHLIGHT_MS = 1000;
/** The edited mark renderBody adds: it alone does not make a body shown. */
const EDITED_MARK = /<em class="chat-msg__edited">[^<]*<\/em>/g;

/** One query as a string: its delimiter, its place and its term. */
function queryKey(q: MentionQuery): string {
    return q.kind + q.start + ":" + q.term;
}

/** Rows the composer shows for a text, from 1 up to MAX_INPUT_ROWS. */
function rowsOf(text: string): number {
    return Math.min(MAX_INPUT_ROWS, text.split("\n").length);
}

/** Cheap 32-bit hash (djb2) of a body, so a changed body never reuses a cached render. */
function bodyHash(body: string): string {
    let h = 5381;
    for (let i = 0; i < body.length; i++) h = ((h << 5) + h + body.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36) + "." + body.length;
}

/** Whether a rendered body shows anything: text, or an image placeholder. */
function shows(html: string): boolean {
    return html.includes("chat-msg__image") || /\S/.test(html.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " "));
}

/** Epoch ms of an Odoo UTC date string (space or ISO form); NaN when unreadable. */
function utcMs(dt: string | null | undefined): number {
    if (!dt) return NaN;
    const iso = dt.replace(" ", "T");
    return Date.parse(/Z$|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + "Z");
}

/**
 * What the long-press menu offers on a message, as Odoo's message actions:
 * react and reply on a `comment` message of a conversation the user writes
 * in (writable), never on one whose post failed; edit on the user's own
 * `comment` messages, sent or queued (a failed one is not edited); delete
 * on them too, a failed one included (it is dropped with its files); copy
 * on any message whose text (bodyText) is not blank.
 */
export function canOf(m: ChatMessage, own: boolean, writable: boolean, text: string): MessageCan {
    const live = writable && m.messageType === "comment";
    const failed = m.status === "failed";
    return {
        react: live && !failed,
        reply: live && !failed,
        copy: text.trim() !== "",
        edit: live && own && !failed,
        delete: live && own,
    };
}

/** The part of a row's signature its chips, menu and quote add: a change repaints the row. */
function actionsSig(r: ThreadRow): string {
    const can = [r.can.react, r.can.reply, r.can.copy, r.can.edit, r.can.delete].map(Number).join("");
    const q = r.quote;
    const quote = q ? [q.key ?? "", q.author, q.text, q.state, Number(q.edited)].join(":") : "";
    return can + "|" + r.reactions.map((x) => [x.content, x.count, Number(x.self), x.names.join(",")].join(":")).join(";")
        + "|" + quote;
}

/**
 * The names of the members, other than the user, typing now, as one line;
 * "" when nobody is.
 */
export function typingLine(
    members: ChatMember[],
    selfPartnerId: number | null,
    names: Map<number, string>,
    nowMs: number,
): string {
    const who = members
        .filter((m) => m.partnerId !== selfPartnerId && m.isTyping)
        .filter((m) => nowMs - utcMs(m.typingAt) <= TYPING_FRESH_MS)
        .map((m) => names.get(m.partnerId) || "?");
    if (who.length === 0) return "";
    if (who.length === 1) return t("chat.typing_one", { name: who[0] });
    return t("chat.typing_many", { names: who.slice(0, -1).join(", "), last: who[who.length - 1] });
}

/**
 * The conversation screen of /chat/:source/:channelId. It renders from the
 * cache and refreshes on CHAT_CHANGED for its own conversation. It renders
 * the newest THREAD_WINDOW server messages and the queued ones; scrolling
 * to the top first renders THREAD_PAGE more from the cache, and pages the
 * history in from the server once the cache has none older. Reaching the
 * bottom marks it read, and so
 * does a new message arriving while the bottom is in view. Message
 * bodies go through renderBody (whitelisted HTML) and nothing else is
 * rendered as markup. A message's files show under its body
 * (ChatAttachmentsComponent over ThreadAttachments), an image in the
 * viewer; a tick of the files' progress renders again only the rows whose
 * files changed. The composer is the conversation's draft: its text
 * (DraftText) and its chips are kept until sent or removed, and shown
 * again when the conversation opens. Reply and Edit put the composer in
 * their mode (ComposerMode), kept in the draft too, with a banner above
 * it: a reply sends the text as an answer; an edit fills the composer with
 * the message's text, kept apart (editText) from the new message's text,
 * which comes back when the edit is sent or given up. Typing @ or # lists
 * the people or channels to mention (ChatSuggestionsComponent over
 * ChatMentions); a pick is followed by its place in the text and goes
 * with ➤ while its text is whole.
 */
export class ChatThreadComponent extends EnhancedComponent {
    state!: ThreadState;
    scroller!: { el: HTMLElement | null };

    static components = {
        HeadingComponent, ChatComposerAttachComponent, ChatAttachmentsComponent, ChatImageViewerComponent, ChatEmojiPickerComponent,
        ChatMessageMenuComponent, ChatReactionsComponent, ChatReactionWhoComponent, ChatComposerBannerComponent,
        ChatSuggestionsComponent,
    };

    static template = xml`
    <div id="chat-thread">
      <HeadingComponent title="state.title"/>
      <div class="chat-thread__header">
        <button class="chat-thread__info" t-att-aria-label="t('chat.info')" t-on-click="onInfo">
          <span class="chat-thread__avatar" aria-hidden="true" t-esc="initials()"/>
        </button>
        <span class="chat-thread__server" t-esc="state.serverLabel"/>
        <span t-if="state.presence" class="chat-thread__presence" t-att-class="'chat-thread__presence--' + state.presence"
              t-att-title="t('chat.presence_' + state.presence)" t-att-aria-label="t('chat.presence_' + state.presence)"/>
        <button class="chat-thread__menu-btn" t-att-aria-label="t('nav.options')" t-on-click="onToggleMenu">⋮</button>
        <div t-if="state.menu" class="chat-thread__menu" role="menu">
          <button role="menuitem" class="chat-thread__menu-item" t-on-click="onInfo" t-esc="t('chat.info')"/>
          <p t-if="state.historyComplete" class="chat-thread__menu-note" t-esc="t('chat.history_complete')"/>
          <button t-else="" role="menuitem" class="chat-thread__menu-item" t-on-click="onLoadAll">
            <t t-if="state.loadingAll === null" t-esc="t('chat.load_all')"/>
            <t t-else="" t-esc="t('chat.loading_all', {count: state.loadingAll})"/>
          </button>
        </div>
      </div>
      <p t-if="!state.found" class="chat-thread__missing" t-esc="state.rows.length ? t('chat.channel_gone') : t('chat.thread_missing')"/>
      <div t-if="state.failedCreate" class="chat-thread__create-failed" role="alert">
        <p t-esc="state.failedCreate === 'left' ? t('chat.left_failed') : state.failedCreate === 'join' ? t('chat.join_failed') : t('chat.create_failed')"/>
        <button class="chat-thread__dismiss" t-on-click="onDismiss" t-esc="t('chat.dismiss')"/>
      </div>
      <div class="chat-thread__scroll" t-ref="scroller" t-on-scroll="onScroll">
        <div t-foreach="state.rows" t-as="row" t-key="row.key" class="chat-thread__bubble" t-att-data-key="row.key"
             t-att-class="{'chat-thread__bubble--own': row.own, 'chat-thread__bubble--pressed': state.actions === row.key, 'chat-thread__bubble--highlight': state.highlight === row.key}"
             t-on-pointerdown="(ev) => this.onPressDown(row, ev)" t-on-pointermove="onPressMove"
             t-on-pointerup="onPressUp" t-on-pointercancel="onPressCancel"
             t-on-contextmenu.prevent="" t-on-click.capture="onBubbleClick">
          <button t-if="row.quote" type="button" class="chat-thread__quote" t-att-class="'chat-thread__quote--' + row.quote.state"
                  t-att-aria-disabled="row.quote.key ? null : 'true'" t-att-tabindex="row.quote.key ? null : '-1'"
                  t-on-click="() => this.onQuote(row)">
            <b t-if="row.quote.author" class="chat-thread__quote-author" t-esc="row.quote.author"/>
            <span class="chat-thread__quote-text" t-esc="row.quote.text"/>
            <em t-if="row.quote.edited" class="chat-msg__edited" t-esc="' ' + t('chat.edited')"/>
          </button>
          <div t-if="row.hasBody" class="chat-thread__body" t-on-click="onBodyClick"><t t-out="row.html"/></div>
          <ChatAttachmentsComponent t-if="row.attachments.length" row="row" ta="attachments" onImage.bind="openImage"/>
          <ChatReactionsComponent t-if="row.reactions.length" reactions="row.reactions"
                                  onToggle="(content) => this.onChip(row, content)" onWho="(content) => this.onWho(row, content)"/>
          <div class="chat-thread__meta">
            <button t-if="offers(row)" type="button" class="chat-thread__actions" aria-haspopup="dialog"
                    t-att-aria-label="t('chat.message_actions')" t-on-click="() => this.openActions(row.key)">⋯</button>
            <span t-esc="row.time"/>
            <span t-if="row.meta === 'sent'" t-att-title="t('chat.sent')">✓</span>
            <span t-if="row.meta === 'seen'" t-att-title="t('chat.seen')">✓✓</span>
            <span t-if="row.meta === 'pending'" t-esc="'⏳ ' + t('chat.pending')"/>
            <span t-if="row.meta === 'waiting'" t-esc="'⏳ ' + t('chat.waiting_previous')"/>
            <span t-if="row.meta === 'waiting_create'" t-esc="'⏳ ' + t('chat.waiting_create')"/>
            <span t-if="row.meta === 'waiting_wifi'" t-esc="'⏳ ' + t('chat.waiting_wifi')"/>
            <span t-if="row.meta === 'ambiguous'" class="chat-thread__failed" t-esc="'⚠️ ' + t('chat.create_ambiguous')"/>
            <span t-if="row.meta === 'failed'" class="chat-thread__failed" t-esc="'⚠️ ' + t('chat.failed')"/>
            <span t-if="row.meta === 'left'" class="chat-thread__failed" t-esc="'⚠️ ' + t('chat.left_conversation')"/>
            <button t-if="row.meta === 'failed' and row.opId" class="chat-thread__retry"
                    t-on-click="() => this.onRetry(row)" t-esc="t('chat.retry')"/>
          </div>
        </div>
        <div t-if="state.preparing" class="chat-thread__bubble chat-thread__bubble--own chat-thread__bubble--preparing">
          <div t-if="state.preparing.text" class="chat-thread__body" t-esc="state.preparing.text"/>
          <ul class="chat-thread__preparing-files">
            <li t-foreach="state.preparing.files" t-as="file" t-key="file.key">
              <img t-if="file.url" class="chat-thread__preparing-image" decoding="async" width="64" height="64" t-att-src="file.url" t-att-alt="file.name"/>
              <span t-else="" t-esc="'📎 ' + file.name"/>
            </li>
          </ul>
          <p class="chat-thread__preparing" role="status" t-esc="state.preparing.label"/>
        </div>
      </div>
      <p t-if="state.typing" class="chat-thread__typing" t-esc="state.typing"/>
      <p t-if="state.flash" class="chat-thread__flash" role="status" t-esc="state.flash"/>
      <p t-if="state.error" class="chat-thread__failed" role="alert" t-esc="state.error"/>
      <t t-if="!state.failedCreate">
        <ul t-if="state.resumes.length" class="chat-thread__resumes" role="alert">
          <li t-foreach="state.resumes" t-as="n" t-key="n.id" class="chat-thread__resume">
            <span class="chat-thread__resume-text" t-esc="'⚠️ ' + n.text"/>
            <button type="button" class="chat-thread__resume-take" t-att-disabled="state.sending"
                    t-on-click="() => this.onResume(n)" t-esc="t('chat.resume')"/>
            <button type="button" class="chat-thread__resume-ignore" t-on-click="() => this.onIgnore(n)" t-esc="t('chat.ignore')"/>
          </li>
        </ul>
        <ChatComposerBannerComponent t-if="state.mode.kind !== 'new'" mode="state.mode" quote="state.banner" onCancel.bind="onCancelMode"/>
        <div class="chat-thread__attach-slot" t-att-class="{'chat-thread__attach-slot--editing': state.mode.kind === 'edit'}">
          <ChatComposerAttachComponent attach="attach"/>
        </div>
        <ChatSuggestionsComponent t-if="state.suggestions.length" items="state.suggestions" onPick.bind="onSuggestion"/>
        <p class="sr-only" aria-live="polite" aria-atomic="true" t-esc="suggestionsLive()"/>
        <ChatEmojiPickerComponent t-if="state.emoji" countUse="!state.reactTo" onPick.bind="onEmoji" onClose.bind="toggleEmoji"/>
        <div class="chat-thread__composer">
          <button class="chat-thread__attach" t-att-aria-label="t('chat.attach')" t-att-aria-expanded="attachState.sheet ? 'true' : 'false'"
                  t-att-disabled="!attachState.ready or attachState.voice !== 'idle' or state.sending or state.mode.kind === 'edit'"
                  t-on-mousedown.prevent="" t-on-click="() => this.attach.toggleSheet()">📎</button>
          <button class="chat-thread__emoji" t-att-aria-label="t('chat.emoji')" t-att-aria-expanded="state.emoji ? 'true' : 'false'"
                  t-att-disabled="state.sending" t-on-mousedown.prevent="" t-on-click="() => this.toggleEmoji()">😊</button>
          <textarea class="chat-thread__input" t-ref="input" t-att-rows="state.inputRows" t-att-placeholder="t('chat.compose_placeholder')"
                    t-att-value="state.text" t-on-beforeinput="onBeforeInput" t-on-input="onInput"
                    t-on-click="onCaret" t-on-keyup="onCaret"/>
          <button t-if="!attach.hasVoiceChip()" class="chat-thread__mic"
                  t-att-class="{'chat-thread__mic--on': attachState.voice === 'recording'}"
                  t-att-aria-label="attachState.voice === 'recording' ? t('chat.voice_stop_send') : t('chat.voice_record')"
                  t-att-disabled="!attachState.ready or attachState.voice === 'starting' or attachState.voice === 'preparing' or state.sending or state.mode.kind === 'edit'"
                  t-on-mousedown.prevent="" t-on-click="() => this.attach.mic()">
            <t t-esc="attachState.voice === 'recording' ? '⏹' : '🎤'"/>
          </button>
          <button class="chat-thread__send" t-att-aria-label="t('chat.send')" t-att-disabled="attach.busy() or state.sending"
                  t-on-mousedown.prevent="" t-on-click="() => this.onSend()">➤</button>
        </div>
      </t>
      <ChatMessageMenuComponent t-if="state.actions" quick="quick()" active="activeOf()" can="menuCan()"
                                onReact.bind="onMenuReact" onMore.bind="onMenuMore" onReply.bind="onMenuReply" onCopy.bind="onMenuCopy"
                                onEdit.bind="onMenuEdit" onDelete.bind="onMenuDelete" onClose.bind="closeActions"/>
      <ChatReactionWhoComponent t-if="state.who" reaction="state.who" onClose.bind="closeWho"/>
      <ChatImageViewerComponent t-if="state.viewer" ta="attachments" attKey="state.viewer" onClose.bind="closeViewer"/>
    </div>`;

    /** The composer's picks, chips and voice message (ChatComposerAttachComponent shows them). */
    attachState!: ComposerAttachState;
    /** The composer's field, for the caret an emoji is inserted at. */
    input = useRef("input");
    attach!: ComposerAttach;
    /** The composer's text, kept as the conversation's draft. */
    draftText!: DraftText;
    /** The text of the edit in progress, kept as the draft's edit while the mode is "edit". */
    editText!: DraftText;
    /** While editing: the new message's text and reply target, shown again when the edit ends. */
    private _kept = "";
    private _keptReply: MessageTarget | null = null;
    /** The text the edit in progress started from; null when unknown (restored from the draft, or a refused text taken back). */
    private _editStart: string | null = null;
    /** The people and channels picked in the composer, the new message's and the edit's (validMentions keeps those in a text). */
    mentions: Mentions = EMPTY_MENTIONS;
    /** The picks of the text shown, by place (adjustPicks follows them as it is typed into); they go with ➤. */
    picks: MentionPick[] = [];
    /** The conversation as the last build read it; the suggestions need it. */
    private _channel: ChatChannel | null = null;
    /** Counts the suggestion queries, so an answer to an older one is never shown. */
    private _suggestSeq = 0;
    private _suggestTimer: ReturnType<typeof setTimeout> | null = null;
    /** The query the list was last asked for (kind, place, term); null when none. */
    private _queryKey: string | null = null;
    /** A caret moved in the focused field (a drag of its handle included) follows the query (onCaret). */
    private _onSelection = () => {
        const el = this.input.el;
        if (el && el === document.activeElement) this.onCaret();
    };
    /** The appStateChange listener that stores the draft text when the app leaves the front. */
    private _appState: Promise<{ remove: () => Promise<void> }> | undefined;
    /** The files of the shown messages: their views, previews, opening and polling. */
    attachments!: ThreadAttachments;
    private configId = "";
    private channelId = 0;
    private source: ChatSource | null = null;
    private _building: Promise<void> | null = null;
    private _again = false;
    private _loadingOlder = false;
    private _debounce: ReturnType<typeof setTimeout> | null = null;
    private _typingTimer: ReturnType<typeof setTimeout> | null = null;
    destroyed = false;
    /** lastMessageId last sent to markRead, and whether a call is running. */
    private _markedUpTo: number | null = null;
    private _marking = false;
    private _markAgain = false;
    /** Rendered body per message version: renderBody runs for new or edited messages only. */
    private _html = new Map<string, { html: unknown; shows: boolean; text: string }>();
    private _sig = "";
    /** The rows last rendered (not the reactive proxies) and their parts the files do not change. */
    private _rows: ThreadRow[] = [];
    /** The messages of the rows last rendered, by row key (for the menu's copy). */
    private _messages = new Map<string, ChatMessage>();
    private _base: string[] = [];
    /** Mark of an own queued row before the Wi-Fi hold is considered, by row key. */
    private _metaBase = new Map<string, MetaKind>();
    private _members: ChatMember[] = [];
    private _names = new Map<number, string>();
    private _self: number | null = null;
    /** Set once a history page brought nothing, so the short-history fill stops. */
    private _noMore = false;
    /** How many of the newest server messages build() renders; scrolling up raises it. */
    private _window = THREAD_WINDOW;
    /** Oldest server message id rendered, null when none is. */
    private _oldestShown: number | null = null;
    /** oldestLoadedId of the conversation while its history is not complete; null otherwise. */
    private _floor: number | null = null;
    private _lastSeen: number | null = null;
    private _onChanged = (ev: Event) => {
        const d = (ev as CustomEvent).detail ?? {};
        if (d.configId !== this.configId) return;
        // A conversation still under its temporary id hears its account: the swap names the server's id
        if (d.channelId != null && d.channelId !== this.channelId && this.channelId >= 0) return;
        if (this._debounce !== null) clearTimeout(this._debounce);
        this._debounce = setTimeout(() => {
            this._debounce = null;
            this.refresh();
        }, CHANGE_DEBOUNCE_MS);
    };

    setup() {
        this.scroller = useRef("scroller") as { el: HTMLElement | null };
        this.state = useState<ThreadState>({
            title: "",
            serverLabel: "",
            presence: null,
            rows: [],
            typing: "",
            text: "",
            menu: false,
            loadingAll: null,
            historyComplete: false,
            found: true,
            failedCreate: "",
            error: "",
            inputRows: 1,
            emoji: false,
            actions: null,
            reactTo: null,
            who: null,
            flash: "",
            viewer: null,
            highlight: null,
            sending: false,
            preparing: null,
            mode: { kind: "new" },
            banner: null,
            resumes: [],
            suggestions: [],
        });
        const params = this.router.getRouteParams(window.location.pathname, "/chat/:source/:channelId");
        this.configId = params.get("source") ?? "";
        this.channelId = Number(params.get("channelId"));
        this.attachState = useState(newComposerAttachState());
        document.addEventListener("selectionchange", this._onSelection);
        // Draft calls name the screen's id at call time; the service maps a settled temporary id itself
        this.attach = new ComposerAttach(this.attachState, deviceComposerDeps({
            fileDir: () => this.chatService.fileDirOf(this.configId),
            uploadLimit: async () => (this.source ? this.chatService.uploadLimit(this.source) : null),
            send: (extra) => this.onSend(extra),
            draft: {
                keep: (file, seq, origin) => this.chatService.keepDraftFile(this.configId, this.channelId, file, seq, origin),
                drop: (file) => this.chatService.dropDraftFile(this.configId, file),
            },
        }));
        this.draftText = new DraftText((text) => this.chatService.saveDraftText(this.configId, this.channelId, text));
        // The mode is read at the store: every change of mode flushes or discards the edit text first
        this.editText = new DraftText((text) => {
            const mode = this.state.mode;
            if (mode.kind !== "edit") return Promise.resolve();
            return this.chatService.saveDraftEdit(this.configId, this.channelId, { target: mode.target, text });
        });
        this._appState = App.addListener("appStateChange", ({ isActive }) => {
            if (isActive) return;
            this.draftText.flush();
            this.editText.flush();
        });
        this.attachments = new ThreadAttachments({
            cache: () => this.chatService.attachments,
            files: () => this.chatService.queue.files,
            uploadProgress: (localUuid) => this.chatService.queue.uploadProgress(localUuid),
            openWith: (uri, mimetype) => ChatFile.openWith({ uri, mimetype, title: t("chat.open_with") }),
            onTick: () => this.retick(),
            onReload: () => void this.refresh(),
            root: () => this.scroller.el,
        });
        onMounted(async () => {
            this.eventBus.addEventListener(Events.CHAT_CHANGED, this._onChanged);
            await this.open();
        });
        onWillUnmount(() => this.teardown());
    }

    /**
     * Detaches the listeners and timers, stores the draft text (and the
     * edit text) still waiting, stops the typing notice and lets go of the attachments (a
     * recording under way is kept as a draft voice file, the chips stay in
     * the draft); open() after it does nothing.
     */
    teardown(): void {
        this.destroyed = true;
        this.draftText.flush();
        this.editText.flush();
        void Promise.resolve(this._appState).then((h) => h?.remove()).catch(() => {});
        void this.attach.dispose();
        this.attachments.dispose();
        this.eventBus.removeEventListener(Events.CHAT_CHANGED, this._onChanged);
        if (this._debounce !== null) clearTimeout(this._debounce);
        if (this._typingTimer !== null) clearTimeout(this._typingTimer);
        if (this._suggestTimer !== null) clearTimeout(this._suggestTimer);
        document.removeEventListener("selectionchange", this._onSelection);
        if (this._flashTimer !== null) clearTimeout(this._flashTimer);
        if (this._highlightTimer !== null) clearTimeout(this._highlightTimer);
        this.press.cancel();
        if (this.source) this.chatService.typing(this.source, this.channelId, false).catch(() => {});
    }

    /**
     * Resolves the source, opens the attachments once it is known (until
     * then 📎 and 🎤 stay off), shows the cache, scrolls down and marks
     * read; the draft is read meanwhile and shows when it answers (its read
     * waits for a send of this conversation still running elsewhere, which
     * the cached messages never wait for). A « Reprendre » asked in the
     * list for this conversation is taken last, over the draft.
     */
    async open(): Promise<void> {
        const sources = await this.chatService.sources({ online: false });
        this.source = sources.find((s) => s.configId === this.configId) ?? null;
        if (this.destroyed) return;
        this.attachments.source = this.source;
        if (this.source) void this.attach.start();
        this.state.serverLabel = this.source?.label ?? "";
        const draft = this.showDraft();
        await this.refresh();
        this.scrollToBottom();
        await this.markRead();
        await draft;
        await this.resumeAsked();
    }

    /** Rebuilds the view from the cache; one build runs at a time, calls made meanwhile fold into one rerun. */
    refresh(): Promise<void> {
        if (this._building) {
            this._again = true;
            return this._building;
        }
        this._building = (async () => {
            try {
                do {
                    this._again = false;
                    await this.build();
                } while (this._again);
            } finally {
                this._building = null;
            }
        })();
        return this._building;
    }

    /** The rows, then the banner's quote over them (the message it names may have changed). */
    private async build(): Promise<void> {
        await this.buildRows();
        if (!this.destroyed && this.state.mode.kind !== "new") await this.refreshBanner();
    }

    private async buildRows(): Promise<void> {
        const repo = this.chatService.repo;
        let channel = await repo.channel(this.configId, this.channelId);
        const tempId = this.channelId;
        const realId = !channel && tempId < 0 ? await this.chatService.realIdOf(this.configId, tempId) : null;
        if (realId !== null) {
            if (this.destroyed) return;
            // Created meanwhile: the screen moves to the server's id, and the history entry with it while it is still this one
            this.channelId = realId;
            if (decodeURIComponent(window.location.pathname) === "/chat/" + this.configId + "/" + tempId) {
                window.history.replaceState({}, "", "/chat/" + encodeURIComponent(this.configId) + "/" + realId);
            }
            channel = await repo.channel(this.configId, realId);
        }
        this._channel = channel;
        if (!channel) {
            // Left or deleted: what was still to post stays shown, as not sent
            this.state.found = false;
            const self = (await repo.sourceState(this.configId)).selfPartnerId;
            const kept = (await this.chatService.messages(this.configId, this.channelId))
                .filter((m) => m.messageId === null);
            await this.loadAttachments(kept, []);
            if (this.destroyed) return;
            this._metaBase.clear();
            this._sig = "";
            this._messages = new Map(kept.map((m) => [this.keyOf(m), m]));
            this._rows = kept.map((m) => this.rowOf(m, null, [], self, [], new Map(), new Map(), null));
            this._base = this._rows.map(() => "");
            this.state.rows = this._rows;
            this.attachments.watch();
            return;
        }
        const [cachedMessages, members, partners, st, resumes] = await Promise.all([
            this.chatService.messages(this.configId, this.channelId, { limit: this._window }),
            repo.members(this.configId, this.channelId),
            repo.partners(this.configId),
            repo.sourceState(this.configId),
            this.editNotices(),
        ]);
        // The loaded history is contiguous from oldestLoadedId up: a reply's parent cached below it is quoted, not shown
        const floor = channel.historyComplete ? null : channel.oldestLoadedId ?? null;
        const loaded = (m: ChatMessage) => m.messageId === null || floor === null || m.messageId >= floor;
        const inRange = cachedMessages.filter(loaded);
        this._floor = floor;
        // Outbox ops matter to pending rows and to emptied ones (a delete queued empties its body at once), once per build
        const opsRead = cachedMessages.some((m) => m.status === "pending" || isEmptyBody(m.body));
        const ops: RowOp[] = opsRead ? await this.databaseService.getOutboxOpsForConfig(this.configId) : [];
        const keys = inRange.filter((m) => m.messageId !== null || m.clientUuid).map(messageKeyOf);
        const [groups, , outside] = await Promise.all([
            keys.length ? this.chatService.reactions(this.configId, this.channelId, keys) : new Map<string, ChatReaction[]>(),
            this.loadAttachments(cachedMessages, ops),
            this.parentsOutside(cachedMessages),
        ]);
        if (this.destroyed) return;
        // A parent read outside the window may be emptied by a delete the ops of this build did not cover
        const extraOps: RowOp[] = !opsRead && [...outside.values()].some((p) => isEmptyBody(p.message.body))
            ? await this.databaseService.getOutboxOpsForConfig(this.configId)
            : [];
        if (this.destroyed) return;
        const deletes = [...ops, ...extraOps]
            .filter((o) => o.kind === CHAT_DELETE && o.status !== "blocked")
            .map((o) => targetOf(o as { params: Record<string, any> }));
        const deleting = (m: ChatMessage) => deletes.some((d) => sameTarget(d, m));
        // Hidden as the browser hides them: emptied with no file left (isEmptyMessage; the files are counted for an empty body only), or with a delete queued
        const messages = inRange.filter((m) => !deleting(m)
            && !(isEmptyBody(m.body) && isEmptyMessage(m.body, this.attachments.views(this.keyOf(m)).length)));
        const names = new Map(partners.map((p) => [p.partnerId, p.name]));
        const self = st.selfPartnerId;
        this.state.found = true;
        this.state.failedCreate = channel.createFailed
            ? (channel.channelId < 0 ? "create" : "join")
            : channel.leftUnsent ? "left" : "";
        // New history appeared (a gap reset, a newer message): older pages may exist again
        if ((this.state.historyComplete && !channel.historyComplete) || channel.lastMessageId !== this._lastSeen) {
            this._noMore = false;
        }
        this._lastSeen = channel.lastMessageId;
        this.state.historyComplete = channel.historyComplete;
        if (JSON.stringify(resumes) !== JSON.stringify(this.state.resumes)) this.state.resumes = resumes;
        this.fillHeader(channel, partners, members, st.selfPartnerId);
        this._members = members;
        this._names = names;
        this._self = self;
        this.refreshTyping();
        const el = this.scroller.el as HTMLElement | null;
        const stick = !el || this.atBottom(el);
        const before = el ? el.scrollHeight - el.scrollTop : 0;
        this._metaBase.clear();
        const quotes = this.quotesOf(messages, cachedMessages, outside, deleting, names, self, floor, channel.historyComplete);
        const rows = messages.map((m, i) => this.rowOf(m, channel!, members, self, ops, groups, names, quotes[i]));
        // A change of members or typing alone leaves the rows, and the DOM, untouched
        const base = rows.map((r, i) => [r.key, r.time, r.opId, this.htmlKey(messages[i]), actionsSig(r)].join("|"));
        const sig = this.sigOf(base, rows);
        this.attachments.watch();
        if (sig === this._sig) return;
        this._sig = sig;
        this._base = base;
        this._rows = rows;
        this._messages = new Map(messages.map((m) => [this.keyOf(m), m]));
        this.state.rows = rows;
        // Hidden ones count: the next page starts below the oldest message of the window, shown or not
        this._oldestShown = inRange.find((m) => m.messageId !== null)?.messageId ?? null;
        this.pruneHtml(messages);
        // Prepended history keeps the viewport on the same message; new ones follow the bottom
        if (el) {
            if (stick) this.scrollToBottomSoon();
            else this.keepPosition(before);
            this.fillShortHistory();
        }
        // Rows changed where the user looks (bottom in view, or nothing to scroll): read up to the last one
        if (!el || stick || el.scrollHeight <= el.clientHeight) void this.markRead();
    }

    /**
     * Reads the files of the given messages (server ones by id, queued ones
     * by client uuid) into ThreadAttachments, with which posts are queued
     * and which uploads the outbox holds for Wi-Fi.
     */
    private async loadAttachments(messages: ChatMessage[], ops: RowOp[]): Promise<void> {
        const ids = messages.filter((m) => m.messageId !== null).map((m) => m.messageId!);
        const uuids = messages.filter((m) => m.messageId === null && m.clientUuid).map((m) => m.clientUuid!);
        const groups: Map<string, ChatAttachment[]> = ids.length || uuids.length
            ? await this.chatService.repo.attachmentsOf(this.configId, this.channelId, ids, uuids)
            : new Map();
        const pendingRows = new Set(messages.filter((m) => m.status === "pending").map((m) => this.keyOf(m)));
        const heldUploads = new Set(ops
            .filter((o) => o.kind === CHAT_UPLOAD && o.params?.heldFor === "wifi" && typeof o.params?.localUuid === "string")
            .map((o) => o.params!.localUuid as string));
        await this.attachments.load(groups, { pendingRows, heldUploads });
    }

    /** The rows' signature: what a render shows of each, the files' state included. */
    private sigOf(base: string[], rows: ThreadRow[]): string {
        return rows.map((r, i) => base[i] + "|" + r.meta + "|" + viewSig(r.attachments)).join("\n");
    }

    /**
     * Recomputes the rows' files and Wi-Fi marks from memory (no cache
     * read), on a ThreadAttachments tick: a row whose files did not change
     * keeps its object, so its part of the screen is not rendered again.
     */
    retick(): void {
        if (this.destroyed) return;
        const rows = this._rows.map((r) => {
            const attachments = this.attachments.views(r.key);
            const meta = this.wifiMeta(r.key, r.meta);
            if (meta === r.meta && viewSig(attachments) === viewSig(r.attachments)) return r;
            return { ...r, attachments, meta };
        });
        const sig = this.sigOf(this._base, rows);
        if (sig !== this._sig) {
            // A preview that lands makes its row taller: the bottom in view stays in view
            const el = this.scroller.el as HTMLElement | null;
            const stick = !!el && this.atBottom(el);
            this._sig = sig;
            this._rows = rows;
            this.state.rows = rows;
            if (stick) this.scrollToBottomSoon();
        }
        this.attachments.watch();
    }

    /** An own queued row reads « waiting for Wi-Fi » while one of its uploads is held, its own mark otherwise. */
    private wifiMeta(key: string, meta: MetaKind): MetaKind {
        const base = this._metaBase.get(key);
        if (base === undefined) return meta;
        return this.attachments.heldForWifi(key) ? "waiting_wifi" : base;
    }

    private keyOf(m: ChatMessage): string {
        return m.messageId !== null ? "m" + m.messageId : "u" + (m.clientUuid ?? m.outboxOpId ?? m.date);
    }

    /** Drops the cached bodies of messages no longer shown. */
    private pruneHtml(messages: ChatMessage[]): void {
        const live = new Set(messages.map((m) => this.htmlKey(m)));
        for (const k of this._html.keys()) if (!live.has(k)) this._html.delete(k);
    }

    private htmlKey(m: ChatMessage): string {
        return m.messageId !== null
            ? "m" + m.messageId + "|" + (m.writeDate ?? "") + "|" + bodyHash(m.body)
            : "u" + (m.clientUuid ?? m.outboxOpId ?? m.date) + "|" + bodyHash(m.body);
    }

    /** Recomputes the typing line and schedules the next recomputation at the oldest typer's expiry. */
    private refreshTyping(): void {
        if (this._typingTimer !== null) clearTimeout(this._typingTimer);
        this._typingTimer = null;
        const now = Date.now();
        this.state.typing = typingLine(this._members, this._self, this._names, now);
        if (!this.state.typing || this.destroyed) return;
        const stamps = this._members
            .filter((m) => m.partnerId !== this._self && m.isTyping)
            .map((m) => utcMs(m.typingAt) + TYPING_FRESH_MS - now)
            .filter((d) => Number.isFinite(d) && d >= 0);
        if (stamps.length === 0) return;
        this._typingTimer = setTimeout(() => this.refreshTyping(), Math.min(...stamps) + 1);
    }

    /** A history shorter than the screen cannot be scrolled: pages are added until it fills or ends. */
    private fillShortHistory(): void {
        setTimeout(() => {
            const el = this.scroller.el as HTMLElement | null;
            if (this.destroyed || !el || this._noMore) return;
            if (el.scrollHeight <= el.clientHeight) this.loadOlder();
        }, 0);
    }

    private fillHeader(
        channel: ChatChannel,
        partners: ChatPartner[],
        members: ChatMember[],
        self: number | null,
    ): void {
        const other = channel.channelType === "chat" ? channel.correspondentPartnerId : null;
        this.state.title = displayNameOf(channel, members, new Map(partners.map((p) => [p.partnerId, p])), self, getCurrentLocale());
        const status = other != null ? partners.find((p) => p.partnerId === other)?.imStatus : null;
        this.state.presence = status === "online" ? "online" : status === "away" ? "away" : other != null ? "offline" : null;
    }

    private rowOf(
        m: ChatMessage,
        channel: ChatChannel | null,
        members: ChatMember[],
        self: number | null,
        ops: RowOp[],
        groups: Map<string, ChatReaction[]>,
        names: Map<number, string>,
        quote: QuoteView | null,
    ): ThreadRow {
        const own = self !== null && m.authorPartnerId === self;
        const key = this.keyOf(m);
        let meta: MetaKind = "none";
        if (own) {
            if (m.status === "failed") meta = channel?.leftUnsent ? "left" : "failed";
            else if (m.status === "pending") {
                const op = ops.find((o) => o.id === m.outboxOpId);
                const create = channel?.createOpId ? ops.find((o) => o.id === channel.createOpId) : undefined;
                if (create?.status === "blocked" && create.params?.blockedReason === "ambiguous") meta = "ambiguous";
                else if (create) meta = "waiting_create";
                else {
                    meta = this.waitsForEarlier(op, ops) ? "waiting" : "pending";
                    this._metaBase.set(key, meta);
                    if (this.attachments.heldForWifi(key)) meta = "waiting_wifi";
                }
            } else if (m.messageId !== null) {
                const others = members.filter((x) => x.partnerId !== self);
                const seen =
                    channel !== null &&
                    channel.channelType !== "channel" &&
                    others.length > 0 &&
                    others.every((x) => x.seenMessageId !== null && x.seenMessageId >= m.messageId!);
                meta = seen ? "seen" : "sent";
            }
        }
        const body = this.htmlOf(m, self);
        const named = m.messageId !== null || !!m.clientUuid;
        const writable = named && channel !== null && !channel.createFailed && !channel.leftUnsent;
        return {
            key,
            own,
            html: body.html,
            hasBody: body.shows,
            time: formatListTime(m.date),
            meta,
            opId: m.outboxOpId,
            attachments: this.attachments.views(key),
            messageKey: messageKeyOf(m),
            target: { messageId: m.messageId, clientUuid: m.clientUuid },
            reactions: named ? reactionViews(groups.get(messageKeyOf(m)) ?? [], names, self) : [],
            can: canOf(m, own, writable, body.text),
            quote,
        };
    }

    /**
     * The cached parents of the replies that are not among the messages
     * read (older than the window, or below the loaded history), by `m<id>`
     * or `u<clientUuid>` as the reply names them, each with whether it has
     * files; one lookup per parent, one files read for all.
     */
    private async parentsOutside(messages: ChatMessage[]): Promise<Map<string, Parent>> {
        const ids = new Set(messages.map((m) => m.messageId).filter((id) => id !== null));
        const uuids = new Set(messages.map((m) => m.clientUuid).filter((u) => !!u));
        const wanted = new Map<string, MessageTarget>();
        for (const m of messages) {
            if (m.parentId != null && !ids.has(m.parentId)) wanted.set("m" + m.parentId, { messageId: m.parentId, clientUuid: null });
            else if (m.parentId == null && m.parentClientUuid && !uuids.has(m.parentClientUuid)) {
                wanted.set("u" + m.parentClientUuid, { messageId: null, clientUuid: m.parentClientUuid });
            }
        }
        const out = new Map<string, Parent>();
        if (wanted.size === 0) return out;
        const repo = this.chatService.repo;
        const found = await Promise.all([...wanted.values()].map((target) => repo.messageOf(this.configId, target)));
        const hits = [...wanted.keys()].map((k, i) => [k, found[i]] as const).filter((x): x is readonly [string, ChatMessage] => !!x[1]);
        if (hits.length === 0) return out;
        const files = await repo.attachmentsOf(
            this.configId,
            this.channelId,
            hits.filter(([, p]) => p.messageId !== null).map(([, p]) => p.messageId!),
            hits.filter(([, p]) => p.messageId === null && p.clientUuid).map(([, p]) => p.clientUuid!),
        );
        for (const [k, p] of hits) out.set(k, { message: p, files: (files.get(messageKeyOf(p))?.length ?? 0) > 0 });
        return out;
    }

    /** Text and edited mark of quoted bodies, by htmlKey: bodyPreview runs once per parent version. */
    private _quoteText = new Map<string, { text: string; edited: boolean }>();

    /**
     * The quote of each shown message (null for one that replies to
     * nothing). The parent is looked up among all the messages read,
     * hidden ones included, then among `outside` (parentsOutside). A parent
     * emptied with no file, or whose delete is queued, reads deleted; one
     * not cached reads deleted when it would be in the loaded history
     * (complete, or at or above floor) or was a queued post (dropped by its
     * delete), else as never loaded.
     */
    private quotesOf(
        shown: ChatMessage[],
        all: ChatMessage[],
        outside: Map<string, Parent>,
        deleting: (m: ChatMessage) => boolean,
        names: Map<number, string>,
        self: number | null,
        floor: number | null,
        complete: boolean,
    ): (QuoteView | null)[] {
        const byId = new Map(all.filter((m) => m.messageId !== null).map((m) => [m.messageId!, m]));
        const byUuid = new Map(all.filter((m) => !!m.clientUuid).map((m) => [m.clientUuid!, m]));
        const texts = new Map<string, { text: string; edited: boolean }>();
        const deleted = deletedQuote();
        const quotes = shown.map((m): QuoteView | null => {
            if (m.parentId == null && !m.parentClientUuid) return null;
            const local = m.parentId != null ? byId.get(m.parentId) : byUuid.get(m.parentClientUuid!);
            const parent: Parent | undefined = local
                ? { message: local, files: this.attachments.views(this.keyOf(local)).length > 0 }
                : outside.get(m.parentId != null ? "m" + m.parentId : "u" + m.parentClientUuid);
            if (!parent) {
                const removed = m.parentId == null || complete || (floor !== null && m.parentId >= floor);
                return removed ? deleted : { key: null, author: "", text: t("chat.quote_unknown"), edited: false, state: "text" };
            }
            const p = parent.message;
            if (deleting(p) || isEmptyMessage(p.body, parent.files ? 1 : 0)) return deleted;
            return this.quoteOf(p, names, self, texts);
        });
        this._quoteText = texts;
        return quotes;
    }

    /**
     * The quote of a message that is not emptied: its author (the cached
     * name, « You » for the user), « Tap to see the attachments » for files
     * only, else the start of its text with the edited mark, read once per
     * message version (`texts` collects the texts of a build).
     */
    private quoteOf(
        p: ChatMessage,
        names: Map<number, string>,
        self: number | null,
        texts?: Map<string, { text: string; edited: boolean }>,
    ): QuoteView {
        const id = p.authorPartnerId;
        const author = (id !== null && names.get(id)) || (id !== null && id === self ? t("chat.you") : t("chat.someone"));
        const key = this.keyOf(p);
        if (isEmptyBody(p.body)) return { key, author, text: t("chat.quote_attachments"), edited: false, state: "attachments" };
        const k = this.htmlKey(p);
        const cached = texts?.get(k) ?? this._quoteText.get(k) ?? { text: bodyPreview(p.body), edited: isEdited(p.body) };
        texts?.set(k, cached);
        return { key, author, text: cached.text, edited: cached.edited, state: "text" };
    }

    /**
     * Whether a queued post waits for an earlier op of its conversation: its
     * chain is followed through its own uploads (a post depends on its
     * files), to the op before them.
     */
    private waitsForEarlier(op: RowOp | undefined, ops: RowOp[]): boolean {
        let dep = op?.dependsOn ?? null;
        const seen = new Set<string>();
        while (dep !== null && !seen.has(dep)) {
            seen.add(dep);
            const before = ops.find((o) => o.id === dep);
            if (!before) return false;
            if (before.kind !== CHAT_UPLOAD) return true;
            dep = before.dependsOn;
        }
        return false;
    }

    /**
     * The rendered body of a message (renderBody: the edited mark as
     * « (edited) », a mention of the user marked), whether it shows
     * anything besides that mark, and its text; cached per message version.
     */
    private htmlOf(m: ChatMessage, self: number | null): { html: unknown; shows: boolean; text: string } {
        const k = this.htmlKey(m);
        let body = this._html.get(k);
        if (body === undefined) {
            const html = renderBody(m.body, { editedLabel: t("chat.edited"), selfPartnerId: self });
            body = { html: markup(html), shows: shows(html.replace(EDITED_MARK, "")), text: bodyText(m.body) };
            this._html.set(k, body);
        }
        return body;
    }

    initials(): string {
        return initialsOf(this.state.title);
    }

    // ─── Scroll ───────────────────────────────────────────────────────────

    private atBottom(el: HTMLElement): boolean {
        return el.scrollHeight - el.scrollTop - el.clientHeight <= EDGE_PX;
    }

    private scrollToBottom(): void {
        const el = this.scroller.el as HTMLElement | null;
        if (el) el.scrollTop = el.scrollHeight;
    }

    /** After the DOM patched with the new rows. */
    private scrollToBottomSoon(): void {
        setTimeout(() => this.scrollToBottom(), 0);
    }

    /** Re-anchors the scroll after rows were prepended: same distance from the bottom as before. */
    private keepPosition(distanceFromBottom: number): void {
        setTimeout(() => {
            const el = this.scroller.el as HTMLElement | null;
            if (el) el.scrollTop = el.scrollHeight - distanceFromBottom;
        }, 0);
    }

    async onScroll(): Promise<void> {
        // A press that scrolls the list is no long press
        this.press.cancel();
        const el = this.scroller.el as HTMLElement | null;
        if (!el || !this.source) return;
        if (el.scrollTop <= EDGE_PX) await this.loadOlder();
        if (this.atBottom(el)) await this.markRead();
    }

    /**
     * One page of older messages: THREAD_PAGE more rendered from the cache
     * while it holds older ones, else a history page from the server. The
     * scroll position stays on the message that was on screen.
     */
    async loadOlder(): Promise<void> {
        if (this._loadingOlder || !this.source) return;
        this._loadingOlder = true;
        try {
            const el = this.scroller.el as HTMLElement | null;
            const before = el ? el.scrollHeight - el.scrollTop : 0;
            if (await this.cachedOlder()) {
                this._window += THREAD_PAGE;
                await this.refresh();
                if (el) this.keepPosition(before);
                return;
            }
            if (this.state.historyComplete) return;
            const added = await this.chatService.loadOlder(this.source, this.channelId);
            this._window += added;
            await this.refresh();
            if (added === 0) this._noMore = true;
            if (added > 0 && el) this.keepPosition(before);
        } catch {
            // Offline or refused: the next scroll to the top tries again
        } finally {
            this._loadingOlder = false;
        }
    }

    /**
     * Whether the cache holds a server message older than the oldest one
     * rendered, within the loaded history (a parent cached below it is not
     * history to render).
     */
    private async cachedOlder(): Promise<boolean> {
        if (this._oldestShown === null) return false;
        const older = await this.chatService.messages(this.configId, this.channelId, {
            beforeId: this._oldestShown,
            limit: 1,
        });
        return older.length > 0 && (this._floor === null || older[0].messageId! >= this._floor);
    }

    /**
     * Marks the conversation read when its last message is newer than the
     * one last marked; a failed call leaves the mark unset, so the next
     * bottom scroll tries again. One call runs at a time; calls made
     * meanwhile fold into one rerun after it, so a message that landed
     * during the call is marked too.
     */
    async markRead(): Promise<void> {
        if (!this.source) return;
        if (this._marking) {
            this._markAgain = true;
            return;
        }
        this._marking = true;
        try {
            do {
                this._markAgain = false;
                await this.markReadOnce();
            } while (this._markAgain && !this.destroyed);
        } finally {
            this._marking = false;
        }
    }

    private async markReadOnce(): Promise<void> {
        try {
            const last = (await this.chatService.repo.channel(this.configId, this.channelId))?.lastMessageId ?? null;
            if (last === null || (this._markedUpTo !== null && last <= this._markedUpTo)) return;
            await this.chatService.markRead(this.source!, this.channelId);
            this._markedUpTo = last;
        } catch {
            // Not marked: the next bottom scroll sends it again
        }
    }

    // ─── Attachments ──────────────────────────────────────────────────────

    /** Opens the viewer on an image of the screen. */
    openImage(key: string): void {
        this.state.viewer = key;
    }

    closeViewer(): void {
        this.state.viewer = null;
    }

    // ─── Menu ─────────────────────────────────────────────────────────────

    onToggleMenu(): void {
        this.state.menu = !this.state.menu;
    }

    /** Opens the information screen of this conversation. */
    onInfo(): void {
        this.state.menu = false;
        this.navigate("/chat/" + encodeURIComponent(this.configId) + "/" + this.channelId + "/info");
    }

    async onLoadAll(): Promise<void> {
        if (!this.source || this.state.loadingAll !== null) return;
        this.state.loadingAll = 0;
        try {
            await this.chatService.loadAll(this.source, this.channelId, (n) => {
                this.state.loadingAll = n;
            });
        } catch {
            // Partial history stays cached
        } finally {
            this.state.loadingAll = null;
        }
        await this.refresh();
    }

    // ─── Message actions ──────────────────────────────────────────────────

    /** A long press on a bubble opens its menu. */
    private press = new LongPress((key) => this.openActions(key));
    /** « … » was chosen in the menu of this row: the picker opens for it once the menu is gone. */
    private _moreFor: string | null = null;
    private _flashTimer: ReturnType<typeof setTimeout> | null = null;

    /**
     * A press starts on a bubble (touch, pen or the main mouse button). It
     * calls no preventDefault, so the list still scrolls and the text is
     * still selected; the bubble's contextmenu is prevented in the template.
     */
    onPressDown(row: ThreadRow, ev: PointerEvent): void {
        if (ev.button > 0) return;
        this.press.down(row.key, ev.clientX, ev.clientY);
    }

    onPressMove(ev: PointerEvent): void {
        this.press.move(ev.clientX, ev.clientY);
    }

    onPressUp(): void {
        this.press.up();
    }

    onPressCancel(): void {
        this.press.cancel();
    }

    /** The click that ends a long press reaches neither a link of the body nor a file: the menu took the press. */
    onBubbleClick(ev: Event): void {
        if (!this.press.takeFired()) return;
        ev.preventDefault();
        ev.stopPropagation();
    }

    private rowAt(key: string | null): ThreadRow | undefined {
        return key === null ? undefined : this._rows.find((r) => r.key === key);
    }

    /**
     * Whether the menu offers anything on a row. Such a row also has a
     * « Message actions » button (shown on keyboard focus, always read by a
     * screen reader), the way to the menu without a long press.
     */
    offers(row: ThreadRow): boolean {
        return Object.values(row.can).some(Boolean);
    }

    /** Opens the menu of a row, unless another sheet is open or the menu would offer nothing. */
    openActions(key: string): void {
        const row = this.rowAt(key);
        if (!row || this.state.actions !== null || this.state.who || this.state.viewer) return;
        if (!this.offers(row)) return;
        this.state.menu = false;
        this.state.actions = key;
    }

    /** What the open menu offers; nothing once its row is gone. */
    menuCan(): MessageCan {
        const row = this.rowAt(this.state.actions);
        return row ? row.can : { react: false, reply: false, copy: false, edit: false, delete: false };
    }

    /** The menu's quick bar (quickReactions, from the uses counted on this phone). */
    quick(): string[] {
        return quickReactions();
    }

    /** The reactions the user put on the menu's message, pressed in its quick bar. */
    activeOf(): string[] {
        return (this.rowAt(this.state.actions)?.reactions ?? []).filter((r) => r.self).map((r) => r.content);
    }

    /** The menu went (its history entry with it); « … » chosen in it opens the picker for its message. */
    closeActions(): void {
        this.state.actions = null;
        if (this._moreFor === null) return;
        this.state.reactTo = this._moreFor;
        this._moreFor = null;
        this.state.emoji = true;
    }

    /** A quick emoji: put on the message, or taken off when the user already reacted with it. */
    onMenuReact(content: string): Promise<void> {
        const row = this.rowAt(this.state.actions);
        if (!row) return Promise.resolve();
        return this.react(row, content, !row.reactions.some((r) => r.content === content && r.self));
    }

    onMenuMore(): void {
        this._moreFor = this.state.actions;
    }

    /** Reply: the composer answers the menu's message (startReply). */
    onMenuReply(): void {
        const row = this.rowAt(this.state.actions);
        if (row?.can.reply) void this.startReply(row.target);
    }

    /** Edit: the composer takes the menu's message to rewrite it (startEdit). */
    onMenuEdit(): void {
        const row = this.rowAt(this.state.actions);
        if (row?.can.edit) void this.startEdit(row.target);
    }

    /**
     * Copies the message's text as the browser reads a body back (bodyText:
     * line breaks kept, a mention as @Name, a link as its text), then shows
     * « Copied » for FLASH_MS; a clipboard missing or refusing shows that
     * the copy failed. The write starts inside the tap, as the clipboard asks.
     */
    async onMenuCopy(): Promise<void> {
        const m = this.state.actions === null ? undefined : this._messages.get(this.state.actions);
        if (!m) return;
        try {
            await navigator.clipboard.writeText(bodyText(m.body));
            this.showFlash(t("chat.copied"));
        } catch (e) {
            console.warn("chat thread: copy refused", e);
            this.showFlash(t("chat.copy_failed"));
        }
    }

    /** Deletes the message as Odoo does, after the user confirms. */
    async onMenuDelete(): Promise<void> {
        const row = this.rowAt(this.state.actions);
        const source = this.source;
        if (!row || !source) return;
        let yes = false;
        try {
            yes = (await Dialog.confirm({
                message: t("chat.delete_confirm"),
                okButtonTitle: t("chat.delete"),
                cancelButtonTitle: t("chat.cancel"),
            })).value;
        } catch (e) {
            console.warn("chat thread: delete confirmation", e);
        }
        if (!yes || this.destroyed) return;
        try {
            await this.chatService.deleteMessage(source, this.channelId, row.target);
        } catch (e) {
            console.warn("chat thread: delete", e);
            this.state.error = t("chat.action_error");
        }
    }

    /**
     * A pick in the picker opened by « … »: the picker closes and the emoji
     * goes on the message; one the user already put on stays as it is, as
     * Odoo's picker does.
     */
    private pickReaction(codepoints: string): void {
        const row = this.rowAt(this.state.reactTo);
        this.state.reactTo = null;
        this.state.emoji = false;
        if (!row || row.reactions.some((r) => r.content === codepoints && r.self)) return;
        void this.react(row, codepoints, true);
    }

    /** A tap on a chip: the user's own reaction comes off, another one goes on. */
    onChip(row: ThreadRow, content: string): Promise<void> {
        if (!row.can.react) return Promise.resolve();
        return this.react(row, content, !row.reactions.some((r) => r.content === content && r.self));
    }

    /** A long press on a chip: who reacted with it. */
    onWho(row: ThreadRow, content: string): void {
        if (this.state.actions !== null) return;
        this.state.who = row.reactions.find((r) => r.content === content) ?? null;
    }

    closeWho(): void {
        this.state.who = null;
    }

    /** Queues the user's own reaction on or off (ChatService.react); a refusal to queue shows an error. */
    private async react(row: ThreadRow, content: string, on: boolean): Promise<void> {
        if (!this.source) return;
        try {
            await this.chatService.react(this.source, this.channelId, row.target, content, on);
        } catch (e) {
            console.warn("chat thread: reaction", e);
            this.state.error = t("chat.action_error");
        }
    }

    // ─── Quotes and links ─────────────────────────────────────────────────

    private _highlightTimer: ReturnType<typeof setTimeout> | null = null;

    /**
     * A tap on a quote scrolls its original to the middle of the screen and
     * highlights it for HIGHLIGHT_MS, when the original is rendered; a
     * quote with no key (deleted, never loaded) or whose original is not
     * rendered does nothing.
     */
    onQuote(row: ThreadRow): void {
        const key = row.quote?.key ?? null;
        if (key === null || !this._rows.some((r) => r.key === key)) return;
        const el = this.scroller.el as HTMLElement | null;
        const bubble = Array.from(el?.querySelectorAll<HTMLElement>(".chat-thread__bubble") ?? []).find((b) => b.dataset.key === key);
        if (!bubble) return;
        bubble.scrollIntoView?.({ block: "center", behavior: "smooth" });
        if (this._highlightTimer !== null) clearTimeout(this._highlightTimer);
        this.state.highlight = key;
        this._highlightTimer = setTimeout(() => {
            this._highlightTimer = null;
            this.state.highlight = null;
        }, HIGHLIGHT_MS);
    }

    /**
     * A tap in a body, delegated to its anchors that renderBody kept as
     * chips (`data-oe-model`, `data-oe-id`): a partner mention opens the
     * direct message with that person (none for the user's own), a channel
     * link its conversation (openChannel). Other taps go on as they are.
     */
    async onBodyClick(ev: Event): Promise<void> {
        const a = (ev.target as Element | null)?.closest?.("a[data-oe-model][data-oe-id]");
        if (!a) return;
        ev.preventDefault();
        const id = Number(a.getAttribute("data-oe-id"));
        const model = a.getAttribute("data-oe-model");
        const source = this.source;
        if (!source || !Number.isInteger(id)) return;
        try {
            if (model === "res.partner") {
                if (id === this._self) return;
                this.openConversation(await this.chatService.startDirect(source, id, { background: true }));
            } else if (model === "discuss.channel") {
                await this.openChannel(source, id, (a.textContent ?? "").replace(/^#/, ""));
            }
        } catch (e) {
            console.warn("chat thread: link", e);
            this.state.error = t("chat.action_error");
        }
    }

    /**
     * A channel link: the conversation when the user is a member of it in
     * the cache, else, once the user confirms, it is joined (ChatService.join,
     * queued when offline) and opened. A link to this conversation does nothing.
     */
    private async openChannel(source: ChatSource, id: number, label: string): Promise<void> {
        if (id === this.channelId) return;
        const cached = await this.chatService.repo.channel(this.configId, id);
        if (cached?.isMember) {
            this.openConversation({ configId: this.configId, channelId: id });
            return;
        }
        // A sub-channel's link reads « #Parent > Name »: the confirmation shows it whole, the cached row takes its own name
        const name = cached?.name || label.split(" > ").pop() || label;
        const { value } = await Dialog.confirm({
            message: t("chat.join_confirm", { name: "#" + (cached?.name || label) }),
            okButtonTitle: t("chat.join"),
            cancelButtonTitle: t("chat.cancel"),
        });
        if (!value || this.destroyed) return;
        this.openConversation(await this.chatService.join(source, id, name, { background: true }));
    }

    private openConversation(r: { configId: string; channelId: number }): void {
        if (this.destroyed) return;
        this.navigate("/chat/" + encodeURIComponent(r.configId) + "/" + r.channelId);
    }

    private showFlash(text: string): void {
        if (this._flashTimer !== null) clearTimeout(this._flashTimer);
        this.state.flash = text;
        this._flashTimer = setTimeout(() => {
            this._flashTimer = null;
            this.state.flash = "";
        }, FLASH_MS);
    }

    // ─── Composer ─────────────────────────────────────────────────────────

    /**
     * The conversation's draft into the composer: with withText, its text,
     * joined ahead of what was typed before the read answered (and stored
     * so joined), its picks, and its mode while the composer is still in
     * the new-message one: an edit in progress shows its text, the new
     * message's text kept under it; else a reply target shows the reply
     * banner. Its files show as chips with their stored origin
     * (ComposerAttach.restore). A draft that cannot be read leaves the
     * composer as it is.
     */
    private async showDraft(withText = true): Promise<void> {
        let draft: ChatDraft & { lost: string[] };
        try {
            draft = await this.chatService.draft(this.configId, this.channelId);
        } catch (e) {
            console.warn("chat thread: draft unreadable", e);
            return;
        }
        if (this.destroyed) return;
        if (withText) {
            const typed = this.state.text;
            const joined = draft.text ? joinDraftText(draft.text, typed) : typed;
            if (joined !== typed && typed) this.draftText.set(joined);
            this.mentions = joinMentions(draft.mentions ?? EMPTY_MENTIONS, this.mentions);
            const fresh = this.state.mode.kind === "new";
            if (fresh && draft.edit) {
                this._kept = joined;
                this._keptReply = draft.replyTo ?? null;
                this.state.mode = { kind: "edit", target: draft.edit.target };
                this.showText(draft.edit.text);
            } else {
                if (joined !== typed) this.showText(joined);
                if (fresh && draft.replyTo) this.state.mode = { kind: "reply", target: draft.replyTo };
            }
            this.picks = picksOf(this.state.text, this.mentions);
            if (this.state.mode.kind !== "new") void this.refreshBanner();
        }
        this.attach.restore(draft.files.map((a) => ({
            file: { localUuid: a.localUuid!, path: a.originalPath!, name: a.name, mimetype: a.mimetype, size: a.size, voice: a.voice },
            seq: a.seq,
            origin: a.origin ?? null,
        })), draft.lost);
    }

    /**
     * Shows a whole text in the composer (a draft, a mode's text): its
     * picks placed anew from the composer's (picksOf), the suggestions
     * closed.
     */
    private showText(text: string): void {
        this.showValue(text);
        this.picks = picksOf(text, this.mentions);
        this.closeSuggestions();
    }

    /** Shows a text in the field, its height following its lines. */
    private showValue(text: string): void {
        this.state.text = text;
        this.state.inputRows = rowsOf(text);
    }

    private focusInput(): void {
        (this.input.el as HTMLTextAreaElement | null)?.focus?.();
    }

    // ─── Composer modes ───────────────────────────────────────────────────

    /** Counts the banner reads, so an older read never shows over a newer one. */
    private _bannerSeq = 0;

    /**
     * The banner's quote of the message the mode names (quoteOf): the row
     * shown, else the cached message; « Original message was deleted » once
     * it is emptied or gone. Cleared at once for the new-message mode.
     */
    private async refreshBanner(): Promise<void> {
        const seq = ++this._bannerSeq;
        const mode = this.state.mode;
        if (mode.kind === "new") {
            this.state.banner = null;
            return;
        }
        let quote = deletedQuote();
        try {
            const shown = [...this._messages.values()].find((m) => sameTarget(m, mode.target));
            const m = shown ?? (await this.chatService.repo.messageOf(this.configId, mode.target));
            if (m && !isEmptyMessage(m.body, this.attachments.views(this.keyOf(m)).length)) {
                quote = this.quoteOf(m, this._names, this._self);
            }
        } catch (e) {
            console.warn("chat thread: banner quote", e);
        }
        if (seq === this._bannerSeq && !this.destroyed) this.state.banner = quote;
    }

    /** Sets the mode and reads its banner. */
    private setMode(mode: ComposerMode): Promise<void> {
        this.state.mode = mode;
        return this.refreshBanner();
    }

    /** Adds picks to the composer's and stores them with the draft. */
    private addMentions(m: Mentions): void {
        this.mentions = joinMentions(this.mentions, m);
        this.chatService.saveDraftMentions(this.configId, this.channelId, this.mentions)
            .catch((e: unknown) => console.warn("chat thread: picks not stored", e));
    }

    /**
     * Reply: the composer's text answers `target`, kept in the draft
     * (saveDraftReply) until a post takes it. An edit in progress is left
     * first (leaveEditFor); one the user keeps stays, and the reply is
     * recorded under it: its banner comes back once the edit is sent or
     * given up. Refused while a send runs.
     */
    async startReply(target: MessageTarget): Promise<void> {
        if (this.state.sending || this.destroyed) return;
        const left = await this.leaveEditFor();
        if (this.destroyed) return;
        this.chatService.saveDraftReply(this.configId, this.channelId, target)
            .catch((e: unknown) => console.warn("chat thread: reply not stored", e));
        if (!left) {
            if (this.state.mode.kind === "edit") this._keptReply = target;
            return;
        }
        this.focusInput();
        await this.setMode({ kind: "reply", target });
    }

    /**
     * Edit: the composer takes the message's text and picks
     * (ChatService.editDraftOf) to rewrite it. The new message's text,
     * stored at once, and its reply target are kept apart and come back when
     * the edit ends. An edit of another message in progress is left first
     * (leaveEditFor), and one the user keeps stays; the same message's edit
     * stays as it is. The edit is stored in the draft (saveDraftEdit), then
     * its picks (an empty draft's row exists once the edit is in it), and
     * its typing goes to editText. A message no longer cached shows an
     * error. Refused while a send runs, and while a voice message records
     * (its ⏹ is off in edit mode).
     */
    async startEdit(target: MessageTarget): Promise<void> {
        if (this.state.sending || this.destroyed || this.attachState.voice !== "idle") return;
        const current = this.state.mode;
        if (current.kind === "edit" && sameTarget(current.target, target)) return;
        if (!(await this.leaveEditFor())) return;
        let start: { text: string; mentions: Mentions } | null = null;
        try {
            start = await this.chatService.editDraftOf(this.configId, this.channelId, target);
        } catch (e) {
            console.warn("chat thread: edit text unreadable", e);
        }
        if (this.destroyed) return;
        if (!start) {
            this.state.error = t("chat.action_error");
            return;
        }
        const mode = this.state.mode;
        if (this.state.sending || mode.kind === "edit") return;
        this.draftText.flush();
        this._kept = this.state.text;
        this._keptReply = mode.kind === "reply" ? mode.target : null;
        this._editStart = start.text;
        this.state.error = "";
        this.state.banner = null;
        this.state.mode = { kind: "edit", target };
        this.showText(start.text);
        this.editText.set(start.text);
        this.addMentions(start.mentions);
        this.picks = picksOf(start.text, this.mentions);
        this.focusInput();
        await this.refreshBanner();
    }

    /**
     * Leaves the edit in progress for another mode; true when there is
     * none, or it was left. An edit whose text is still the one it started
     * from is given up at once; one typed into, or whose start is unknown,
     * asks first (chat.edit_abandon_confirm): Abandon gives it up, Keep
     * leaves it (false).
     */
    private async leaveEditFor(): Promise<boolean> {
        if (this.state.mode.kind !== "edit") return true;
        if (this.state.text !== this._editStart) {
            let yes = false;
            try {
                yes = (await Dialog.confirm({
                    message: t("chat.edit_abandon_confirm"),
                    okButtonTitle: t("chat.edit_abandon"),
                    cancelButtonTitle: t("chat.edit_keep"),
                })).value;
            } catch (e) {
                console.warn("chat thread: abandon confirmation", e);
            }
            if (!yes || this.destroyed || this.state.sending || this.state.mode.kind !== "edit") return false;
        }
        this.giveUpEdit();
        return true;
    }

    /** Gives the edit in progress up: its text dropped, the draft's edit ended, the new message back. */
    private giveUpEdit(): void {
        this.editText.discard();
        this.chatService.saveDraftEdit(this.configId, this.channelId, null)
            .catch((e: unknown) => console.warn("chat thread: edit not ended in the draft", e));
        this.leaveEdit();
    }

    /** Back from an edit: the new message's text and reply target show again. */
    private leaveEdit(): void {
        const reply = this._keptReply;
        this.showText(this._kept);
        this._kept = "";
        this._keptReply = null;
        this._editStart = null;
        void this.setMode(reply ? { kind: "reply", target: reply } : { kind: "new" });
    }

    /**
     * The banner's ✕, an explicit give-up that asks nothing: an edit is
     * given up (giveUpEdit) and the new message comes back; a reply ends,
     * the text staying. Refused while a send runs.
     */
    onCancelMode(): void {
        if (this.state.sending) return;
        const mode = this.state.mode;
        if (mode.kind === "edit") {
            this.giveUpEdit();
        } else if (mode.kind === "reply") {
            this.chatService.saveDraftReply(this.configId, this.channelId, null)
                .catch((e: unknown) => console.warn("chat thread: reply not ended in the draft", e));
            void this.setMode({ kind: "new" });
        }
    }

    /** This conversation's refused-edit notices (ChatNotice.edit), as the banner slot lists them; none when unreadable. */
    private async editNotices(): Promise<{ id: string; text: string }[]> {
        try {
            return (await this.chatService.notices([this.configId]))
                .filter((n: ChatNotice) => !!n.edit && n.channelId === this.channelId)
                .map((n: ChatNotice) => ({
                    id: n.id,
                    text: t(n.edit!.deleted ? "chat.notice_edit_deleted" : "chat.notice_edit_changed"),
                }));
        } catch (e) {
            console.warn("chat thread: notices unreadable", e);
            return [];
        }
    }

    /**
     * Takes the refused edit whose « Reprendre » was asked for this
     * conversation, if any (ChatService.takeResume, which stores its text
     * in the draft before its notice goes), then reads the draft again
     * (reloadResumed). acceptResume decides first.
     */
    private async resumeAsked(): Promise<void> {
        let edit: ChatNotice["edit"] | null = null;
        let locked = false;
        try {
            edit = await this.chatService.takeResume(this.configId, this.channelId, async (e) => {
                locked = await this.acceptResume(e);
                return locked;
            });
            if (edit && !this.destroyed) await this.reloadResumed();
        } catch (e) {
            console.warn("chat thread: resume", e);
            if (!this.destroyed) this.state.error = t("chat.action_error");
        } finally {
            if (locked) this.state.sending = false;
        }
    }

    /**
     * Whether a refused edit may come back now. One whose message changed
     * takes the composer's edit place: the edit in progress is left first
     * (leaveEditFor), and one the user keeps refuses it, its notice staying.
     * One whose message was deleted only joins the new message's text. Once
     * accepted, the texts waiting are stored and the composer stays locked
     * (sending) until the draft is read again, so nothing typed meanwhile is
     * written over.
     */
    private async acceptResume(edit: NonNullable<ChatNotice["edit"]>): Promise<boolean> {
        if (this.destroyed || this.state.sending) return false;
        if (!edit.deleted && !(await this.leaveEditFor())) return false;
        if (this.destroyed || this.state.sending) return false;
        this.draftText.flush();
        this.editText.flush();
        this.state.sending = true;
        return true;
    }

    /**
     * The composer as the draft holds it after a refused edit was taken
     * back: its edit (the refused text, or the edit in progress), the new
     * message's text and reply target, the picks. A refused text counts as
     * typed: acceptResume left any edit before it, so _editStart is
     * unknown; an edit in progress that only saw a deleted message's text
     * join the new message keeps its start.
     */
    private async reloadResumed(): Promise<void> {
        const draft = await this.chatService.draft(this.configId, this.channelId);
        if (this.destroyed) return;
        this.mentions = draft.mentions ?? EMPTY_MENTIONS;
        if (draft.edit) {
            this._kept = draft.text;
            this._keptReply = draft.replyTo ?? null;
            this.state.mode = { kind: "edit", target: draft.edit.target };
            this.showText(draft.edit.text);
        } else {
            this.showText(draft.text);
            this.state.mode = draft.replyTo ? { kind: "reply", target: draft.replyTo } : { kind: "new" };
        }
        await this.refreshBanner();
    }

    /** « Reprendre » on a notice of the banner slot. */
    async onResume(n: { id: string }): Promise<void> {
        if (this.state.sending) return;
        this.chatService.requestResume(this.configId, n.id);
        await this.resumeAsked();
    }

    /** « Ignorer » on a notice of the banner slot: it is dismissed, its text with it. */
    async onIgnore(n: { id: string }): Promise<void> {
        try {
            await this.chatService.dismissNotice(this.configId, n.id);
        } catch (e) {
            console.warn("chat thread: dismiss", e);
            this.state.error = t("chat.action_error");
        }
    }

    /** Whether the message `target` names has files (an emptied edit of it is then sent, not a delete). */
    private async hasFiles(target: MessageTarget): Promise<boolean> {
        const repo = this.chatService.repo;
        const m = await repo.messageOf(this.configId, target);
        if (!m) return false;
        const groups = await repo.attachmentsOf(
            this.configId,
            this.channelId,
            m.messageId !== null ? [m.messageId] : [],
            m.messageId === null && m.clientUuid ? [m.clientUuid] : [],
        );
        return (groups.get(messageKeyOf(m))?.length ?? 0) > 0;
    }

    /**
     * While a send runs, an edit of the field is refused before it happens
     * (one the IME does not let cancel is undone by onInput). The field
     * keeps no disabled or readonly attribute: either one, set while its
     * text is emptied, makes Android close the keyboard.
     */
    onBeforeInput(ev: Event): void {
        if (this.state.sending && ev.cancelable) ev.preventDefault();
    }

    /**
     * The text typed. An input that still comes while a send runs is
     * undone, the field showing the composer's text again.
     */
    onInput(ev: Event): void {
        const field = ev.target as HTMLTextAreaElement;
        if (this.state.sending) {
            field.value = this.state.text;
            return;
        }
        this.setText(field.value);
        this.suggest(field.selectionStart ?? field.value.length);
    }

    /**
     * The composer's text changed: shown and kept as the draft, the edit's
     * text while editing (told to no one), else the new message's, told to
     * the others as typing.
     */
    private setText(value: string): void {
        const before = this.state.text;
        this.showValue(value);
        this.followPicks(before, value);
        if (this.state.mode.kind === "edit") {
            this.editText.typed(value);
            return;
        }
        this.draftText.typed(value);
        if (this.source && value.trim()) {
            this.chatService.typing(this.source, this.channelId, true).catch(() => {});
        }
    }

    /**
     * The picks of the text once `before` became `after` (adjustPicks). A
     * pick whose text was edited goes from the composer's picks too, unless
     * a pick left or, while editing, the kept new message still holds it;
     * the text waiting is then stored, and the picks after it.
     */
    private followPicks(before: string, after: string): void {
        if (this.picks.length === 0) return;
        const kept = adjustPicks(this.picks, before, after);
        const broken = kept.length < this.picks.length;
        this.picks = kept;
        if (!broken) return;
        const other = this.state.mode.kind === "edit" ? validMentions(this._kept, this.mentions) : EMPTY_MENTIONS;
        this.mentions = joinMentions(picksToMentions(kept), { partners: other.partners, channels: other.channels });
        this.storeMentions();
    }

    /** Stores the text waiting, then the composer's picks: a draft never holds a pick before its text. */
    private storeMentions(): void {
        if (this.state.mode.kind === "edit") this.editText.flush();
        else this.draftText.flush();
        this.chatService.saveDraftMentions(this.configId, this.channelId, this.mentions)
            .catch((e: unknown) => console.warn("chat thread: picks not stored", e));
    }

    /**
     * The suggestions of the word the caret ends (mentionQuery): the
     * cache's at once (ChatMentions.local), then SUGGEST_FETCH_MS after
     * the last keystroke those of the server with them (remote), which take
     * their place. A server that fails or does not answer leaves the
     * cache's; an answer to a query since replaced is not shown. The list
     * shown stays until the new one answers; no query closes it.
     */
    private suggest(caret: number): void {
        const q = mentionQuery(this.state.text, caret);
        const source = this.source;
        const channel = this._channel;
        if (!q || !source || !channel) {
            this.closeSuggestions();
            return;
        }
        const seq = ++this._suggestSeq;
        if (this._suggestTimer !== null) clearTimeout(this._suggestTimer);
        this._queryKey = queryKey(q);
        const mentions = this.chatService.mentions;
        let merged = false;
        const show = (list: Suggestion[]) => {
            if (seq === this._suggestSeq && !this.destroyed) this.state.suggestions = list;
        };
        mentions.local(source, channel, q)
            .then((list: Suggestion[]) => { if (!merged) show(list); })
            .catch((e: unknown) => console.warn("chat thread: suggestions", e));
        this._suggestTimer = setTimeout(() => {
            this._suggestTimer = null;
            mentions.remote(source, channel, q)
                .then((list: Suggestion[]) => {
                    merged = true;
                    show(list);
                })
                .catch(() => {
                    // The cache's list stays
                });
        }, SUGGEST_FETCH_MS);
    }

    /** Hides the suggestions, and voids the answers still to come and the server request still waiting. */
    private closeSuggestions(): void {
        this._suggestSeq++;
        this._queryKey = null;
        if (this._suggestTimer !== null) clearTimeout(this._suggestTimer);
        this._suggestTimer = null;
        if (this.state.suggestions.length) this.state.suggestions = [];
    }

    /**
     * The caret moved without an input (a tap in the field, an arrow key, a
     * drag of its handle): a selection or a caret that ends no query closes
     * the list, a caret that ends another query asks for its suggestions,
     * and the query already asked for is left as it is.
     */
    onCaret(): void {
        if (this.state.sending || this.destroyed) return;
        const field = this.input.el as HTMLTextAreaElement | null;
        if (!field) return;
        const start = field.selectionStart ?? this.state.text.length;
        if (start !== (field.selectionEnd ?? start)) {
            this.closeSuggestions();
            return;
        }
        const q = mentionQuery(this.state.text, start);
        if (q && queryKey(q) === this._queryKey) return;
        this.suggest(start);
    }

    /** What the live region says: how many suggestions the list shows; "" while it is closed. */
    suggestionsLive(): string {
        const count = this.state.suggestions.length;
        return count ? t("chat.suggestions_shown", { count }) : "";
    }

    /**
     * A suggestion picked: the query the caret ends is replaced by its text
     * and a space (applySuggestion), the caret after it, the focus kept in
     * the field. The text is stored at once, then the pick with the
     * composer's (a special one links from the text alone). Refused while a
     * send runs, as typing is, and when the caret no longer ends a query of
     * the suggestion's kind.
     */
    onSuggestion(s: Suggestion): void {
        if (this.state.sending || this.destroyed) return;
        const field = this.input.el as HTMLTextAreaElement | null;
        const text = this.state.text;
        const caret = Math.min(field?.selectionStart ?? text.length, text.length);
        const q = mentionQuery(text, caret);
        this.closeSuggestions();
        if (!q || q.kind !== (s.kind === "channel" ? "#" : "@")) return;
        const picked = applySuggestion(text, q, caret, s);
        this.setText(picked.text);
        this.picks = [...this.picks, picked.pick];
        if (s.kind !== "special") this.mentions = joinMentions(this.mentions, picksToMentions([picked.pick]));
        this.storeMentions();
        if (field) {
            field.value = picked.text;
            field.setSelectionRange(picked.caret, picked.caret);
            field.focus?.();
        }
    }

    /** The composer's 😊, and the picker's close: the picker opens to type, or closes whatever it was for. */
    toggleEmoji(): void {
        this.state.emoji = !this.state.emoji;
        this.state.reactTo = null;
    }

    /**
     * An emoji picked. Opened from a message's « … », it reacts to that
     * message (pickReaction). Otherwise it is inserted at the caret,
     * replacing the selection, and kept in the draft like typed text; the
     * caret ends after it. Refused while a send runs, as typing is.
     */
    onEmoji(codepoints: string): void {
        if (this.state.reactTo !== null) {
            this.pickReaction(codepoints);
            return;
        }
        if (this.state.sending) return;
        const field = this.input.el as HTMLTextAreaElement | null;
        const text = this.state.text;
        const start = Math.min(field?.selectionStart ?? text.length, text.length);
        const end = Math.min(field?.selectionEnd ?? start, text.length);
        const value = text.slice(0, start) + codepoints + text.slice(end);
        this.setText(value);
        const caret = start + codepoints.length;
        if (field) {
            field.value = value;
            field.setSelectionRange(caret, caret);
        }
        this.suggest(caret);
    }

    /**
     * Queues the trimmed text with the chips' files, then extra (the voice
     * message just recorded); nothing is sent when all are empty, nor while
     * a voice message is prepared (it would be overtaken) or another send
     * runs. The composer, text and chips, clears before the first await, so
     * a second tap finds it empty, and stays locked (sending) until the post
     * is queued, the compress question (ComposerAttach.prepare) included:
     * nothing is typed meanwhile. The field refuses input (onBeforeInput,
     * onInput) rather than being disabled, so it keeps the focus and the
     * keyboard stays open. A send
     * with chips shows its bubble at once (showPreparing) until the post is
     * queued and the thread shows it. The text is stored as the draft in that
     * same first step, so a kill during the question loses nothing, and the
     * outbox removes exactly that text from the draft once the post is
     * stored (draftText). From the tap until the post is queued, the
     * conversation's draft is held for another screen
     * (ChatService.sendStarted). A send refused before its post is queued
     * puts the text back (the draft still holds it), shows the error and
     * shows again the chips whose files the outbox left in the draft; a
     * failure after it (the post goes) is only logged. Returns whether the
     * send was taken: false leaves extra to the caller. In reply mode the
     * post answers the mode's message: the banner clears with the text, and
     * the outbox takes the reply target out of the draft with the text. The
     * picks still whole in the text (picks) go with the post. In edit mode ➤ sends the edit (sendEdit), and
     * takes no file.
     */
    async onSend(extra: OutgoingFile[] = []): Promise<boolean> {
        if (!this.source || this.attach.busy() || this.state.sending) return false;
        const mode = this.state.mode;
        if (mode.kind === "edit") return extra.length > 0 ? false : this.sendEdit(this.source, mode.target);
        const text = this.state.text.trim();
        if (!text && extra.length === 0 && this.attachState.chips.length === 0) return false;
        this.state.sending = true;
        this.state.emoji = false;
        this.state.reactTo = null;
        // A second screen of this conversation reads its draft once this post is queued
        const ended = this.chatService.sendStarted(this.configId, this.channelId);
        let queued = false;
        const chips = this.attach.take();
        const raw = this.state.text;
        const kept = this.mentions;
        const mentions = picksToMentions(this.picks);
        this.mentions = EMPTY_MENTIONS;
        this.showText("");
        this.draftText.set(raw);
        this.state.error = "";
        const replyTo = mode.kind === "reply" ? mode.target : null;
        void this.setMode({ kind: "new" });
        const preparing = chips.length > 0 ? this.showPreparing(text, chips) : 0;
        // The message ends the typing, as Odoo's composer does on a post
        this.chatService.typing(this.source, this.channelId, false).catch(() => {});
        try {
            const files = [...(await this.attach.prepare(chips)), ...extra];
            await this.chatService.send(this.source, this.channelId, text, files, {
                draftText: raw,
                mentions,
                replyTo,
                onQueued: () => {
                    queued = true;
                    this.state.sending = false;
                    ended();
                    if (preparing) void this.refresh().finally(() => this.endPreparing(preparing));
                },
            });
        } catch (e) {
            ended();
            this.state.sending = false;
            if (preparing && !queued) this.endPreparing(preparing);
            if (!queued) {
                this.mentions = kept;
                this.showText(raw);
                void this.setMode(mode);
                this.state.error = t("chat.send_error");
                await this.showDraft(false);
                return true;
            }
            // The post is queued: putting its text back would send it twice
            console.warn("chat thread: after a queued post", e);
        }
        ended();
        this.state.sending = false;
        await this.refresh();
        this.scrollToBottomSoon();
        return true;
    }

    /**
     * ➤ in edit mode. An emptied edit of a message without files asks to
     * delete it, as the browser does (deleteFromEdit); one with files sends
     * the empty text. Otherwise the edit's text is stored at the tap, the
     * composer shows the new message again and stays locked until the edit
     * is queued (ChatService.editMessage, which ends the draft's edit then).
     * An edit not queued (the message gone from the cache, a write refused)
     * comes back in the composer with an error; the edit's picks go with it,
     * and the picks left are those of the new message's text.
     */
    private async sendEdit(source: ChatSource, target: MessageTarget): Promise<boolean> {
        if (this.destroyed) return false;
        const raw = this.state.text;
        const text = raw.trim();
        // Locked from the tap: what is typed while the files are looked up is not written over
        this.state.sending = true;
        if (!text) {
            let files = false;
            try {
                files = await this.hasFiles(target);
            } catch (e) {
                console.warn("chat thread: files of the edited message unreadable", e);
            }
            if (!files) {
                this.state.sending = false;
                await this.deleteFromEdit(source, target);
                return true;
            }
        }
        this.state.emoji = false;
        this.state.reactTo = null;
        this.state.error = "";
        this.editText.set(raw);
        const all = this.mentions;
        const mentions = picksToMentions(this.picks);
        this.leaveEdit();
        let queued = false;
        try {
            await this.chatService.editMessage(source, this.channelId, target, text, mentions, {
                fromDraft: true,
                onQueued: () => {
                    queued = true;
                    this.state.sending = false;
                },
            });
        } catch (e) {
            this.state.sending = false;
            if (!queued) {
                console.warn("chat thread: edit not queued", e);
                const mode = this.state.mode;
                this._kept = this.state.text;
                this._keptReply = mode.kind === "reply" ? mode.target : null;
                this.showText(raw);
                this.state.error = t("chat.action_error");
                await this.setMode({ kind: "edit", target });
                return true;
            }
            console.warn("chat thread: after a queued edit", e);
        }
        this.state.sending = false;
        const left = validMentions(this.state.text, all);
        this.mentions = { partners: left.partners, channels: left.channels };
        this.picks = picksOf(this.state.text, this.mentions);
        this.chatService.saveDraftMentions(this.configId, this.channelId, this.mentions)
            .catch((e: unknown) => console.warn("chat thread: picks not stored", e));
        await this.refresh();
        return true;
    }

    /**
     * An emptied edit of a message without files: the delete is asked
     * (chat.delete_confirm); on yes the edit ends and the message is
     * deleted, on no the edit stays as it is.
     */
    private async deleteFromEdit(source: ChatSource, target: MessageTarget): Promise<void> {
        let yes = false;
        try {
            yes = (await Dialog.confirm({
                message: t("chat.delete_confirm"),
                okButtonTitle: t("chat.delete"),
                cancelButtonTitle: t("chat.cancel"),
            })).value;
        } catch (e) {
            console.warn("chat thread: delete confirmation", e);
        }
        const mode = this.state.mode;
        if (!yes || this.destroyed || this.state.sending || mode.kind !== "edit" || !sameTarget(mode.target, target)) return;
        this.giveUpEdit();
        try {
            await this.chatService.deleteMessage(source, this.channelId, target);
        } catch (e) {
            console.warn("chat thread: delete", e);
            this.state.error = t("chat.action_error");
        }
    }

    /** Counts the preparing bubbles shown, so an older send never takes away a newer one's. */
    private _preparingSeq = 0;

    /**
     * Shows the bubble of a send with files (state.preparing): its text,
     * its files by name, « Preparing the photos… » when a photo is among
     * them, « Preparing the files… » otherwise. The first PREPARING_IMAGES
     * images the web view shows get their staged file's address once it is
     * known, drawn in a 64 px box and decoded off the main thread (decoding
     * async). Returns the bubble's number for endPreparing.
     */
    private showPreparing(text: string, chips: { key: string; file: OutgoingFile }[]): number {
        const seq = ++this._preparingSeq;
        const photos = chips.some((c) => c.file.mimetype.startsWith("image/"));
        this.state.preparing = {
            text,
            label: t(photos ? "chat.preparing_photos" : "chat.preparing_files"),
            files: chips.map((c) => ({ key: c.key, name: c.file.name, image: SHOWN_IMAGE.test(c.file.mimetype), url: null })),
        };
        this.scrollToBottomSoon();
        let shown = 0;
        chips.forEach((c, i) => {
            if (!SHOWN_IMAGE.test(c.file.mimetype) || shown++ >= PREPARING_IMAGES) return;
            this.chatService.queue.files.webUrl(c.file.path).then((url: string) => {
                if (this._preparingSeq === seq && this.state.preparing) this.state.preparing.files[i].url = url;
            }).catch(() => {});
        });
        return seq;
    }

    /** Takes the preparing bubble away, unless a later send shows its own. */
    private endPreparing(seq: number): void {
        if (this._preparingSeq === seq) this.state.preparing = null;
    }

    /** Removes a conversation the server refused, or one left, with its unsent texts, and goes back to the list; a failure stays here with a notice. */
    async onDismiss(): Promise<void> {
        this.state.error = "";
        try {
            await this.chatService.discardCreate(this.configId, this.channelId);
        } catch (e) {
            console.warn("chat thread:", e);
            this.state.error = t("chat.action_error");
            return;
        }
        this.navigate("/chat");
    }

    /** Puts a failed post back in the outbox and drains it. */
    async onRetry(row: ThreadRow): Promise<void> {
        if (!row.opId || !this.source) return;
        this.state.error = "";
        try {
            await this.syncService.outbox.retry(row.opId);
            await this.chatService.queue.flush(this.source.creds, { force: true });
        } catch {
            this.state.error = t("chat.send_error");
        }
        await this.refresh();
    }
}
