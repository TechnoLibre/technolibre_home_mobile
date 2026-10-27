import { onMounted, onWillUnmount, useRef, useState, xml } from "@odoo/owl";
import { App } from "@capacitor/app";

import { EnhancedComponent } from "../../js/enhancedComponent";
import { t } from "../../i18n";
import type { ChatMailboxItem, OutgoingFile, RecordThread } from "../../models/chat";
import { EMPTY_MENTIONS, joinMentions, type Mentions } from "../../services/chat/chatCompose";
import { adjustPicks, picksOf, picksToMentions, type MentionPick, type Suggestion } from "../../services/chat/chatMentions";
import { DraftText, joinDraftText } from "../../services/chat/chatDraft";
import type { ChatDraft } from "../../services/chat/chatRepository";
import type { ChatSource } from "../../services/chat/chatSources";
import { BackEntry } from "./chatBackEntry";
import {
    ChatComposerAttachComponent,
    ComposerAttach,
    deviceComposerDeps,
    newComposerAttachState,
    type ComposerAttachState,
} from "./chat_composer_attach_component";
import { ChatEmojiPickerComponent } from "./chat_emoji_picker_component";
import { ChatSuggestionsComponent } from "./chat_suggestions_component";
import { MentionField, composerRows } from "./mentionField";

interface ReplyState {
    text: string;
    inputRows: number;
    /** « Envoyer comme message aux abonnés »: off, the reply is an internal note. */
    asMessage: boolean;
    /** The confirmation of the message mode is open. */
    asking: boolean;
    /** From the tap on ➤ until the reply is queued or refused: the field takes no input. */
    sending: boolean;
    emoji: boolean;
    suggestions: Suggestion[];
    error: string;
}

/**
 * The reply composer of an inbox item, in its record's chatter
 * (ChatService.replyOnRecord), over the inbox screen at the place of a
 * thread's composer. It is the conversation's composer in its pieces: the
 * files (camera, gallery, any file) and the voice message of
 * ComposerAttach, kept as the record's draft files; the text kept as the
 * record's draft (DraftText); the emoji picker; the field with its @ and #
 * suggestions (MentionField over ChatMentions.local with no conversation,
 * then forRecord), each pick followed by its place (adjustPicks) and sent
 * while its text is whole.
 * The draft is the record's (ChatService.recordDraft): what is typed or
 * picked survives the screen and the app, and comes back when a reply to
 * the same record opens.
 *
 * A reply is an internal note by default. The switch « Envoyer comme
 * message aux abonnés » asks first (chat.record_reply_message_confirm) and
 * stays off on no; the choice holds for the text and the files of the next
 * send. ➤ (or the voice message's stop) stores the text at the tap, clears
 * the composer, holds the record's draft for another screen
 * (recordSendStarted) until the reply is queued, then calls onDone; a
 * reply not queued puts the text and the picks back, with the error, and
 * shows again the files the outbox left in the draft. ✕ and Android's back
 * close it over its own history entry (BackEntry, mark chatReply) and call
 * onCancel; the draft stays.
 */
export class ChatRecordReplyComponent extends EnhancedComponent {
    static props = { src: Object, item: Object, onDone: Function, onCancel: Function };

    static components = { ChatComposerAttachComponent, ChatEmojiPickerComponent, ChatSuggestionsComponent };

    static template = xml`
    <section class="chat-reply" t-att-aria-label="title()">
      <div class="chat-reply__head">
        <span class="chat-reply__title" t-esc="title()"/>
        <button type="button" class="chat-reply__close" t-att-aria-label="t('chat.record_reply_close')"
                t-on-mousedown.prevent="" t-on-click="() => this.close()">✕</button>
      </div>
      <button type="button" role="switch" class="chat-reply__switch" t-att-aria-checked="state.asMessage ? 'true' : 'false'"
              t-att-class="{'chat-reply__switch--on': state.asMessage}" t-att-disabled="state.sending or state.asking"
              t-on-mousedown.prevent="" t-on-click="() => this.onToggleMessage()">
        <span class="chat-reply__switch-knob" aria-hidden="true"/>
        <span t-esc="t('chat.record_reply_as_message')"/>
      </button>
      <p t-if="state.error" class="chat-thread__failed" role="alert" t-esc="state.error"/>
      <ChatComposerAttachComponent attach="attach"/>
      <ChatSuggestionsComponent t-if="state.suggestions.length" items="state.suggestions" onPick.bind="onSuggestion"/>
      <p class="sr-only" aria-live="polite" aria-atomic="true" t-esc="suggestionsLive()"/>
      <ChatEmojiPickerComponent t-if="state.emoji" countUse="true" onPick="onEmojiPick" onClose="onEmojiClose"/>
      <div class="chat-thread__composer">
        <button class="chat-thread__attach" t-att-aria-label="t('chat.attach')" t-att-aria-expanded="attachState.sheet ? 'true' : 'false'"
                t-att-disabled="!attachState.ready or attachState.voice !== 'idle' or state.sending"
                t-on-mousedown.prevent="" t-on-click="() => this.attach.toggleSheet()">📎</button>
        <button class="chat-thread__emoji" t-att-aria-label="t('chat.emoji')" t-att-aria-expanded="state.emoji ? 'true' : 'false'"
                t-att-disabled="state.sending" t-on-mousedown.prevent="" t-on-click="() => this.toggleEmoji()">😊</button>
        <textarea class="chat-thread__input chat-reply__input" t-ref="input" t-att-rows="state.inputRows"
                  t-att-placeholder="state.asMessage ? t('chat.record_reply_message_placeholder') : t('chat.record_reply_note_placeholder')"
                  t-att-value="state.text" t-on-beforeinput="onBeforeInput" t-on-input="onInput"
                  t-on-click="onCaret" t-on-keyup="onCaret"/>
        <button t-if="!attach.hasVoiceChip()" class="chat-thread__mic"
                t-att-class="{'chat-thread__mic--on': attachState.voice === 'recording'}"
                t-att-aria-label="attachState.voice === 'recording' ? t('chat.voice_stop_send') : t('chat.voice_record')"
                t-att-disabled="!attachState.ready or attachState.voice === 'starting' or attachState.voice === 'preparing' or state.sending"
                t-on-mousedown.prevent="" t-on-click="() => this.attach.mic()">
          <t t-esc="attachState.voice === 'recording' ? '⏹' : '🎤'"/>
        </button>
        <button class="chat-thread__send" t-att-aria-label="t('chat.send')" t-att-disabled="attach.busy() or state.sending"
                t-on-mousedown.prevent="" t-on-click="() => this.onSend()">➤</button>
      </div>
    </section>`;

    state!: ReplyState;
    /** The composer's picks, chips and voice message (ChatComposerAttachComponent shows them). */
    attachState!: ComposerAttachState;
    attach!: ComposerAttach;
    /** The composer's text, kept as the record's draft. */
    draftText!: DraftText;
    input = useRef("input");
    /** The people and channels picked, as the draft keeps them. */
    mentions: Mentions = EMPTY_MENTIONS;
    /** The picks of the text shown, by place; they go with ➤. */
    picks: MentionPick[] = [];
    destroyed = false;
    /** The picker's callbacks, the same functions every render (a new one renders its buttons again). */
    onEmojiPick = (codepoints: string) => this.onEmoji(codepoints);
    onEmojiClose = () => this.toggleEmoji();
    /** The field's input and its @ and # suggestions. */
    mention!: MentionField;
    private entry!: BackEntry;
    private thread!: RecordThread;
    /** The appStateChange listener that stores the text when the app leaves the front. */
    private _appState: Promise<{ remove: () => Promise<void> }> | undefined;

    setup() {
        const item = this.props.item as ChatMailboxItem;
        this.thread = { model: item.threadModel, resId: item.threadId, recordName: item.recordName };
        this.state = useState<ReplyState>({
            text: "", inputRows: 1, asMessage: false, asking: false, sending: false, emoji: false, suggestions: [], error: "",
        });
        this.attachState = useState(newComposerAttachState());
        const configId = this.src().configId;
        this.mention = new MentionField({
            field: () => this.input.el as HTMLTextAreaElement | null,
            text: () => this.state.text,
            view: this.state,
            ask: () => {
                const src = this.src();
                return {
                    local: (q) => this.chatService.mentions.local(src, null, q),
                    remote: (q) => this.chatService.mentions.forRecord(src, q),
                };
            },
            busy: () => this.state.sending,
            gone: () => this.destroyed,
            setText: (value) => this.setText(value),
            picked: (pick, s) => {
                this.picks = [...this.picks, pick];
                if (s.kind !== "special") this.mentions = joinMentions(this.mentions, picksToMentions([pick]));
                this.storeMentions();
            },
            label: "chat reply",
        });
        this.attach = new ComposerAttach(this.attachState, deviceComposerDeps({
            fileDir: () => this.chatService.fileDirOf(configId),
            uploadLimit: () => this.chatService.uploadLimit(this.src()),
            send: (extra) => this.onSend(extra),
            draft: {
                keep: (file, seq, origin) => this.chatService.keepRecordDraftFile(configId, this.thread, file, seq, origin),
                drop: (file) => this.chatService.dropDraftFile(configId, file),
            },
        }));
        this.draftText = new DraftText((text) => this.chatService.saveRecordDraftText(configId, this.thread, text));
        this.entry = new BackEntry("chatReply", () => this.props.onCancel());
        this._appState = App.addListener("appStateChange", ({ isActive }) => {
            if (!isActive) this.draftText.flush();
        });
        onMounted(() => this.open());
        onWillUnmount(() => this.teardown());
    }

    private src(): ChatSource {
        return this.props.src as ChatSource;
    }

    title(): string {
        return t("chat.record_reply_title", { record: this.thread.recordName });
    }

    /** Takes the history entry, opens the attachments, then shows the record's draft. */
    async open(): Promise<void> {
        this.entry.open();
        void this.attach.start();
        await this.showDraft();
    }

    /**
     * The composer leaves the screen: the text waiting is stored, a
     * recording under way is kept as a draft voice file, the history entry
     * is gone with it when still the current one (a send closed it).
     */
    teardown(): void {
        this.destroyed = true;
        this.draftText.flush();
        void Promise.resolve(this._appState).then((h) => h?.remove()).catch(() => {});
        void this.attach.dispose();
        this.mention.dispose();
        this.entry.dispose({ goBack: true });
    }

    /** ✕: back over the composer's entry, whose popstate calls onCancel. */
    close(): void {
        this.entry.close();
    }

    /**
     * The record's draft into the composer: with withText, its text joined
     * ahead of what was typed before the read answered (and stored so
     * joined) and its picks; its files as chips (ComposerAttach.restore). A
     * draft that cannot be read leaves the composer as it is.
     */
    private async showDraft(withText = true): Promise<void> {
        let draft: ChatDraft & { lost: string[] };
        try {
            draft = await this.chatService.recordDraft(this.src().configId, this.thread);
        } catch (e) {
            console.warn("chat reply: draft unreadable", e);
            return;
        }
        if (this.destroyed) return;
        if (withText) {
            const typed = this.state.text;
            const joined = draft.text ? joinDraftText(draft.text, typed) : typed;
            if (joined !== typed && typed) this.draftText.set(joined);
            this.mentions = joinMentions(draft.mentions ?? EMPTY_MENTIONS, this.mentions);
            this.showText(joined);
        }
        this.attach.restore(draft.files.map((a) => ({
            file: { localUuid: a.localUuid!, path: a.originalPath!, name: a.name, mimetype: a.mimetype, size: a.size, voice: a.voice },
            seq: a.seq,
            origin: a.origin ?? null,
        })), draft.lost);
    }

    /** A whole text in the field, its picks placed anew from the composer's (picksOf), the suggestions closed. */
    private showText(text: string): void {
        this.showValue(text);
        this.picks = picksOf(text, this.mentions);
        this.mention.close();
    }

    private showValue(text: string): void {
        this.state.text = text;
        this.state.inputRows = composerRows(text);
    }

    /** While a send runs, an edit of the field is refused before it happens (MentionField.beforeInput). */
    onBeforeInput(ev: Event): void {
        this.mention.beforeInput(ev);
    }

    /** The text typed, then its suggestions (MentionField.input); undone while a send runs. */
    onInput(ev: Event): void {
        this.mention.input(ev);
    }

    /** The text changed: shown, its picks followed, kept as the draft. */
    private setText(value: string): void {
        const before = this.state.text;
        this.showValue(value);
        if (this.picks.length > 0) {
            const kept = adjustPicks(this.picks, before, value);
            const broken = kept.length < this.picks.length;
            this.picks = kept;
            if (broken) {
                this.mentions = picksToMentions(kept);
                this.storeMentions();
            }
        }
        this.draftText.typed(value);
    }

    /** Stores the text waiting, then the picks: a draft never holds a pick before its text. */
    private storeMentions(): void {
        this.draftText.flush();
        this.chatService.saveRecordDraftMentions(this.src().configId, this.thread, this.mentions)
            .catch((e: unknown) => console.warn("chat reply: picks not stored", e));
    }

    /** The caret moved without an input: the list follows the query it ends (MentionField.caret). */
    onCaret(): void {
        this.mention.caret();
    }

    suggestionsLive(): string {
        return this.mention.live();
    }

    /** A suggestion picked (MentionField.pick): written over its query, the text stored at once, then the pick. */
    onSuggestion(s: Suggestion): void {
        this.mention.pick(s);
    }

    toggleEmoji(): void {
        this.state.emoji = !this.state.emoji;
    }

    /** An emoji picked: inserted at the caret over the selection, kept like typed text (MentionField.insert). */
    onEmoji(codepoints: string): void {
        this.mention.insert(codepoints);
    }

    /**
     * The switch « Envoyer comme message aux abonnés »: on after a yes to
     * chat.record_reply_message_confirm (a question that fails counts as
     * no), off at once. The text and the files are left as they are.
     */
    async onToggleMessage(): Promise<void> {
        if (this.state.sending || this.state.asking) return;
        if (this.state.asMessage) {
            this.state.asMessage = false;
            return;
        }
        this.state.asking = true;
        try {
            const yes = await this.attach.deps.confirm(t("chat.record_reply_message_confirm", { record: this.thread.recordName }), {
                title: t("chat.record_reply_message_title"),
                ok: t("chat.record_reply_message_ok"),
                cancel: t("chat.record_reply_message_cancel"),
            }).catch(() => false);
            if (yes && !this.destroyed) this.state.asMessage = true;
        } finally {
            this.state.asking = false;
        }
    }

    /**
     * Queues the trimmed text, the chips' files, then extra (the voice
     * message just recorded), as a note or a message by the switch. Nothing
     * is sent when all are empty, while a voice message is prepared or
     * another send runs. The text is stored as the draft at the tap and
     * the composer clears before the first await; the record's draft is
     * held (recordSendStarted) until the reply is queued. Queued: onDone.
     * Refused before its queue: the text and the picks come back with the
     * error, and the files the outbox left in the draft as chips. Returns
     * whether the send was taken: false leaves extra to the caller.
     */
    async onSend(extra: OutgoingFile[] = []): Promise<boolean> {
        if (this.attach.busy() || this.state.sending || this.destroyed) return false;
        const text = this.state.text.trim();
        if (!text && extra.length === 0 && this.attachState.chips.length === 0) return false;
        const { configId } = this.src();
        this.state.sending = true;
        this.state.emoji = false;
        this.state.error = "";
        const ended = this.chatService.recordSendStarted(configId, this.thread);
        const chips = this.attach.take();
        const raw = this.state.text;
        const kept = this.mentions;
        const mentions = picksToMentions(this.picks);
        const note = !this.state.asMessage;
        this.mentions = EMPTY_MENTIONS;
        this.showText("");
        this.draftText.set(raw);
        try {
            const files = [...(await this.attach.prepare(chips)), ...extra];
            await this.chatService.replyOnRecord(this.src(), this.props.item, text, mentions, files, note, raw);
        } catch (e) {
            console.warn("chat reply: not queued", e);
            ended();
            this.state.sending = false;
            if (this.destroyed) return true;
            this.mentions = kept;
            this.showText(raw);
            this.state.error = t("chat.send_error");
            await this.showDraft(false);
            return true;
        }
        ended();
        this.state.sending = false;
        this.props.onDone();
        return true;
    }
}
