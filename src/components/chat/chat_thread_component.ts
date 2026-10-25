import { markup, onMounted, onWillUnmount, useRef, useState, xml } from "@odoo/owl";

import { EnhancedComponent } from "../../js/enhancedComponent";
import { HeadingComponent } from "../heading/heading_component";
import { Events } from "../../constants/events";
import { getCurrentLocale, t } from "../../i18n";
import { renderBody } from "../../services/chat/chatBody";
import type { ChatSource } from "../../services/chat/chatService";
import { displayNameOf } from "../../services/chat/chatNames";
import type { ChatChannel, ChatMember, ChatMessage, ChatPartner } from "../../models/chat";
import { formatListTime, initialsOf } from "./chat_list_component";

/** Quiet period that folds a burst of CHAT_CHANGED into one refresh. */
const CHANGE_DEBOUNCE_MS = 150;
/** A member counts as typing for this long after the server's timestamp. */
const TYPING_FRESH_MS = 60000;
/** Distance from the edge, in px, that counts as "at the top" or "at the bottom". */
const EDGE_PX = 40;
/** The composer grows to this many lines, then scrolls. */
const MAX_INPUT_ROWS = 5;
/** Server messages rendered at open: the newest ones, however long the cached history. */
export const THREAD_WINDOW = 100;
/** Cached messages a scroll to the top adds to the rendered ones before the server is asked. */
export const THREAD_PAGE = 50;

type MetaKind = "none" | "sent" | "seen" | "pending" | "waiting" | "waiting_create" | "ambiguous" | "failed" | "left";

export interface ThreadRow {
    key: string;
    own: boolean;
    html: unknown;
    time: string;
    meta: MetaKind;
    opId: string | null;
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
}

/** Cheap 32-bit hash (djb2) of a body, so a changed body never reuses a cached render. */
function bodyHash(body: string): string {
    let h = 5381;
    for (let i = 0; i < body.length; i++) h = ((h << 5) + h + body.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36) + "." + body.length;
}

/** Epoch ms of an Odoo UTC date string (space or ISO form); NaN when unreadable. */
function utcMs(dt: string | null | undefined): number {
    if (!dt) return NaN;
    const iso = dt.replace(" ", "T");
    return Date.parse(/Z$|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + "Z");
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
 * rendered as markup.
 */
export class ChatThreadComponent extends EnhancedComponent {
    state!: ThreadState;
    scroller!: { el: HTMLElement | null };

    static components = { HeadingComponent };

    static template = xml`
    <div id="chat-thread">
      <HeadingComponent title="state.title"/>
      <div class="chat-thread__header">
        <span class="chat-thread__avatar" aria-hidden="true" t-esc="initials()"/>
        <span class="chat-thread__server" t-esc="state.serverLabel"/>
        <span t-if="state.presence" class="chat-thread__presence" t-att-class="'chat-thread__presence--' + state.presence"
              t-att-title="t('chat.presence_' + state.presence)" t-att-aria-label="t('chat.presence_' + state.presence)"/>
        <button class="chat-thread__menu-btn" t-att-aria-label="t('nav.options')" t-on-click="onToggleMenu">⋮</button>
        <div t-if="state.menu" class="chat-thread__menu" role="menu">
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
        <div t-foreach="state.rows" t-as="row" t-key="row.key" class="chat-thread__bubble"
             t-att-class="{'chat-thread__bubble--own': row.own}">
          <div class="chat-thread__body"><t t-out="row.html"/></div>
          <div class="chat-thread__meta">
            <span t-esc="row.time"/>
            <span t-if="row.meta === 'sent'" t-att-title="t('chat.sent')">✓</span>
            <span t-if="row.meta === 'seen'" t-att-title="t('chat.seen')">✓✓</span>
            <span t-if="row.meta === 'pending'" t-esc="'⏳ ' + t('chat.pending')"/>
            <span t-if="row.meta === 'waiting'" t-esc="'⏳ ' + t('chat.waiting_previous')"/>
            <span t-if="row.meta === 'waiting_create'" t-esc="'⏳ ' + t('chat.waiting_create')"/>
            <span t-if="row.meta === 'ambiguous'" class="chat-thread__failed" t-esc="'⚠️ ' + t('chat.create_ambiguous')"/>
            <span t-if="row.meta === 'failed'" class="chat-thread__failed" t-esc="'⚠️ ' + t('chat.failed')"/>
            <span t-if="row.meta === 'left'" class="chat-thread__failed" t-esc="'⚠️ ' + t('chat.left_conversation')"/>
            <button t-if="row.meta === 'failed' and row.opId" class="chat-thread__retry"
                    t-on-click="() => this.onRetry(row)" t-esc="t('chat.retry')"/>
          </div>
        </div>
      </div>
      <p t-if="state.typing" class="chat-thread__typing" t-esc="state.typing"/>
      <p t-if="state.error" class="chat-thread__failed" role="alert" t-esc="state.error"/>
      <div t-if="!state.failedCreate" class="chat-thread__composer">
        <textarea class="chat-thread__input" t-att-rows="state.inputRows" t-att-placeholder="t('chat.compose_placeholder')"
                  t-att-value="state.text" t-on-input="onInput"/>
        <button class="chat-thread__send" t-att-aria-label="t('chat.send')" t-on-mousedown.prevent="" t-on-click="onSend">➤</button>
      </div>
    </div>`;

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
    private _html = new Map<string, unknown>();
    private _sig = "";
    private _members: ChatMember[] = [];
    private _names = new Map<number, string>();
    private _self: number | null = null;
    /** Set once a history page brought nothing, so the short-history fill stops. */
    private _noMore = false;
    /** How many of the newest server messages build() renders; scrolling up raises it. */
    private _window = THREAD_WINDOW;
    /** Oldest server message id rendered, null when none is. */
    private _oldestShown: number | null = null;
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
        });
        const params = this.router.getRouteParams(window.location.pathname, "/chat/:source/:channelId");
        this.configId = params.get("source") ?? "";
        this.channelId = Number(params.get("channelId"));
        onMounted(async () => {
            this.eventBus.addEventListener(Events.CHAT_CHANGED, this._onChanged);
            await this.open();
        });
        onWillUnmount(() => this.teardown());
    }

    /** Detaches the listener and timers and stops the typing notice; open() after it does nothing. */
    teardown(): void {
        this.destroyed = true;
        this.eventBus.removeEventListener(Events.CHAT_CHANGED, this._onChanged);
        if (this._debounce !== null) clearTimeout(this._debounce);
        if (this._typingTimer !== null) clearTimeout(this._typingTimer);
        if (this.source) this.chatService.typing(this.source, this.channelId, false).catch(() => {});
    }

    /** Resolves the source, shows the cache, scrolls down and marks read. */
    async open(): Promise<void> {
        const sources = await this.chatService.sources({ online: false });
        this.source = sources.find((s) => s.configId === this.configId) ?? null;
        if (this.destroyed) return;
        this.state.serverLabel = this.source?.label ?? "";
        await this.refresh();
        this.scrollToBottom();
        await this.markRead();
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

    private async build(): Promise<void> {
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
        if (!channel) {
            // Left or deleted: what was still to post stays shown, as not sent
            this.state.found = false;
            const self = (await repo.sourceState(this.configId)).selfPartnerId;
            const kept = (await this.chatService.messages(this.configId, this.channelId))
                .filter((m) => m.messageId === null);
            this._sig = "";
            this.state.rows = kept.map((m) => this.rowOf(m, null, [], self, []));
            return;
        }
        const [messages, members, partners, st] = await Promise.all([
            this.chatService.messages(this.configId, this.channelId, { limit: this._window }),
            repo.members(this.configId, this.channelId),
            repo.partners(this.configId),
            repo.sourceState(this.configId),
        ]);
        // Outbox ops matter only to pending rows, once per build
        const ops = messages.some((m) => m.status === "pending")
            ? await this.databaseService.getOutboxOpsForConfig(this.configId)
            : [];
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
        this.fillHeader(channel, partners, members, st.selfPartnerId);
        this._members = members;
        this._names = names;
        this._self = self;
        this.refreshTyping();
        const el = this.scroller.el as HTMLElement | null;
        const stick = !el || this.atBottom(el);
        const before = el ? el.scrollHeight - el.scrollTop : 0;
        const rows = messages.map((m) => this.rowOf(m, channel!, members, self, ops));
        // A change of members or typing alone leaves the rows, and the DOM, untouched
        const sig = rows.map((r, i) => [r.key, r.meta, r.time, r.opId, this.htmlKey(messages[i])].join("|")).join("\n");
        if (sig === this._sig) return;
        this._sig = sig;
        this.state.rows = rows;
        this._oldestShown = messages.find((m) => m.messageId !== null)?.messageId ?? null;
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
        ops: { id: string; dependsOn: string | null; status?: string; params?: Record<string, any> }[],
    ): ThreadRow {
        const own = self !== null && m.authorPartnerId === self;
        let meta: MetaKind = "none";
        if (own) {
            if (m.status === "failed") meta = channel?.leftUnsent ? "left" : "failed";
            else if (m.status === "pending") {
                const op = ops.find((o) => o.id === m.outboxOpId);
                const create = channel?.createOpId ? ops.find((o) => o.id === channel.createOpId) : undefined;
                if (create?.status === "blocked" && create.params?.blockedReason === "ambiguous") meta = "ambiguous";
                else if (create) meta = "waiting_create";
                else meta = op?.dependsOn && ops.some((o) => o.id === op.dependsOn) ? "waiting" : "pending";
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
        return {
            key: m.messageId !== null ? "m" + m.messageId : "u" + (m.clientUuid ?? m.outboxOpId ?? m.date),
            own,
            html: this.htmlOf(m),
            time: formatListTime(m.date),
            meta,
            opId: m.outboxOpId,
        };
    }

    private htmlOf(m: ChatMessage): unknown {
        const k = this.htmlKey(m);
        let html = this._html.get(k);
        if (html === undefined) {
            html = markup(renderBody(m.body));
            this._html.set(k, html);
        }
        return html;
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

    /** Whether the cache holds a server message older than the oldest one rendered. */
    private async cachedOlder(): Promise<boolean> {
        if (this._oldestShown === null) return false;
        const older = await this.chatService.messages(this.configId, this.channelId, {
            beforeId: this._oldestShown,
            limit: 1,
        });
        return older.length > 0;
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

    // ─── Menu ─────────────────────────────────────────────────────────────

    onToggleMenu(): void {
        this.state.menu = !this.state.menu;
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

    // ─── Composer ─────────────────────────────────────────────────────────

    onInput(ev: Event): void {
        const value = (ev.target as HTMLTextAreaElement).value;
        this.state.text = value;
        this.state.inputRows = Math.min(MAX_INPUT_ROWS, value.split("\n").length);
        if (this.source && value.trim()) {
            this.chatService.typing(this.source, this.channelId, true).catch(() => {});
        }
    }

    /**
     * Queues the trimmed text; empty or blank text is never sent. The
     * composer clears before the first await, so a second tap finds it
     * empty; a failed send puts the text back and shows the error.
     */
    async onSend(): Promise<void> {
        const text = this.state.text.trim();
        if (!text || !this.source) return;
        const raw = this.state.text;
        this.state.text = "";
        this.state.inputRows = 1;
        this.state.error = "";
        const sending = this.chatService.send(this.source, this.channelId, text);
        // The message ends the typing, as Odoo's composer does on a post
        this.chatService.typing(this.source, this.channelId, false).catch(() => {});
        try {
            await sending;
        } catch {
            if (!this.state.text) this.state.text = raw;
            this.state.error = t("chat.send_error");
            return;
        }
        await this.refresh();
        this.scrollToBottomSoon();
    }

    /** Removes a conversation the server refused, or one left, with its unsent texts, and goes back to the list. */
    async onDismiss(): Promise<void> {
        await this.chatService.discardCreate(this.configId, this.channelId);
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
