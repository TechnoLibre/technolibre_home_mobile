import { markup, onMounted, onWillUnmount, useRef, useState, xml } from "@odoo/owl";

import { EnhancedComponent } from "../../js/enhancedComponent";
import { HeadingComponent } from "../heading/heading_component";
import { Events } from "../../constants/events";
import { t } from "../../i18n";
import { renderBody } from "../../services/chat/chatBody";
import type { ChatSource } from "../../services/chat/chatService";
import type { ChatChannel, ChatMember, ChatMessage, ChatPartner } from "../../models/chat";
import { formatListTime, initialsOf } from "./chat_list_component";

/** Quiet period that folds a burst of CHAT_CHANGED into one refresh. */
const CHANGE_DEBOUNCE_MS = 150;
/** A member counts as typing for this long after the server's timestamp. */
const TYPING_FRESH_MS = 60000;
/** Distance from the edge, in px, that counts as "at the top" or "at the bottom". */
const EDGE_PX = 40;

type MetaKind = "none" | "sent" | "seen" | "pending" | "waiting" | "failed";

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
        .map((m) => names.get(m.partnerId) ?? "?");
    if (who.length === 0) return "";
    if (who.length === 1) return t("chat.typing_one", { name: who[0] });
    return t("chat.typing_many", { names: who.slice(0, -1).join(", "), last: who[who.length - 1] });
}

/**
 * The conversation screen of /chat/:source/:channelId. It renders from the
 * cache and refreshes on CHAT_CHANGED for its own conversation; scrolling to
 * the top pages the history in, reaching the bottom marks it read. Message
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
      <p t-if="!state.found" class="chat-thread__missing" t-esc="t('chat.thread_missing')"/>
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
            <span t-if="row.meta === 'failed'" class="chat-thread__failed" t-esc="'⚠️ ' + t('chat.failed')"/>
            <button t-if="row.meta === 'failed' and row.opId" class="chat-thread__retry"
                    t-on-click="() => this.onRetry(row)" t-esc="t('chat.retry')"/>
          </div>
        </div>
      </div>
      <p t-if="state.typing" class="chat-thread__typing" t-esc="state.typing"/>
      <div class="chat-thread__composer">
        <textarea class="chat-thread__input" rows="1" t-att-placeholder="t('chat.compose_placeholder')"
                  t-att-value="state.text" t-on-input="onInput"/>
        <button class="chat-thread__send" t-att-aria-label="t('chat.send')" t-on-click="onSend">➤</button>
      </div>
    </div>`;

    private configId = "";
    private channelId = 0;
    private source: ChatSource | null = null;
    private _building: Promise<void> | null = null;
    private _again = false;
    private _loadingOlder = false;
    private _debounce: ReturnType<typeof setTimeout> | null = null;
    private _onChanged = (ev: Event) => {
        const d = (ev as CustomEvent).detail ?? {};
        if (d.configId !== this.configId) return;
        if (d.channelId != null && d.channelId !== this.channelId) return;
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
        });
        const params = this.router.getRouteParams(window.location.pathname, "/chat/:source/:channelId");
        this.configId = params.get("source") ?? "";
        this.channelId = Number(params.get("channelId"));
        onMounted(async () => {
            this.eventBus.addEventListener(Events.CHAT_CHANGED, this._onChanged);
            await this.open();
        });
        onWillUnmount(() => {
            this.eventBus.removeEventListener(Events.CHAT_CHANGED, this._onChanged);
            if (this._debounce !== null) clearTimeout(this._debounce);
            const v = this.chatService.viewing;
            if (v && v.configId === this.configId && v.channelId === this.channelId) {
                this.chatService.viewing = null;
            }
            this.source && this.chatService.typing(this.source, this.channelId, false).catch(() => {});
        });
    }

    /** Resolves the source, marks the conversation as viewed, shows the cache, scrolls down and marks read. */
    async open(): Promise<void> {
        const sources = await this.chatService.sources({ online: false });
        this.source = sources.find((s) => s.configId === this.configId) ?? null;
        this.state.serverLabel = this.source?.label ?? "";
        this.chatService.viewing = { configId: this.configId, channelId: this.channelId };
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
        const channel = await repo.channel(this.configId, this.channelId);
        if (!channel) {
            this.state.found = false;
            return;
        }
        const [messages, members, partners, st, ops] = await Promise.all([
            this.chatService.messages(this.configId, this.channelId),
            repo.members(this.configId, this.channelId),
            repo.partners(this.configId),
            repo.sourceState(this.configId),
            this.databaseService.getOutboxOpsForConfig(this.configId),
        ]);
        const names = new Map(partners.map((p) => [p.partnerId, p.name]));
        const self = st.selfPartnerId;
        this.state.found = true;
        this.state.historyComplete = channel.historyComplete;
        this.fillHeader(channel, partners, names);
        const el = this.scroller.el as HTMLElement | null;
        const stick = !el || this.atBottom(el);
        const before = el ? el.scrollHeight - el.scrollTop : 0;
        this.state.rows = messages.map((m) => this.rowOf(m, channel, members, self, ops));
        this.state.typing = typingLine(members, self, names, Date.now());
        // Prepended history keeps the viewport on the same message; new ones follow the bottom
        if (el) {
            if (stick) this.scrollToBottomSoon();
            else this.keepPosition(before);
        }
    }

    private fillHeader(channel: ChatChannel, partners: ChatPartner[], names: Map<number, string>): void {
        const other = channel.channelType === "chat" ? channel.correspondentPartnerId : null;
        this.state.title = other != null ? (names.get(other) ?? channel.name) : channel.name;
        const status = other != null ? partners.find((p) => p.partnerId === other)?.imStatus : null;
        this.state.presence = status === "online" ? "online" : status === "away" ? "away" : other != null ? "offline" : null;
    }

    private rowOf(
        m: ChatMessage,
        channel: ChatChannel,
        members: ChatMember[],
        self: number | null,
        ops: { id: string; dependsOn: string | null }[],
    ): ThreadRow {
        const own = self !== null && m.authorPartnerId === self;
        let meta: MetaKind = "none";
        if (own) {
            if (m.status === "failed") meta = "failed";
            else if (m.status === "pending") {
                const op = ops.find((o) => o.id === m.outboxOpId);
                meta = op?.dependsOn && ops.some((o) => o.id === op.dependsOn) ? "waiting" : "pending";
            } else if (m.messageId !== null) {
                const others = members.filter((x) => x.partnerId !== self);
                const seen =
                    channel.channelType !== "channel" &&
                    others.length > 0 &&
                    others.every((x) => x.seenMessageId !== null && x.seenMessageId >= m.messageId!);
                meta = seen ? "seen" : "sent";
            }
        }
        return {
            key: m.messageId !== null ? "m" + m.messageId : "u" + (m.clientUuid ?? m.outboxOpId ?? m.date),
            own,
            html: markup(renderBody(m.body)),
            time: formatListTime(m.date),
            meta,
            opId: m.outboxOpId,
        };
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

    /** One page of older messages; the scroll position stays on the message that was on screen. */
    async loadOlder(): Promise<void> {
        if (this._loadingOlder || !this.source || this.state.historyComplete) return;
        this._loadingOlder = true;
        try {
            const el = this.scroller.el as HTMLElement | null;
            const before = el ? el.scrollHeight - el.scrollTop : 0;
            const added = await this.chatService.loadOlder(this.source, this.channelId);
            await this.refresh();
            if (added > 0 && el) this.keepPosition(before);
        } catch {
            // Offline or refused: the next scroll to the top tries again
        } finally {
            this._loadingOlder = false;
        }
    }

    async markRead(): Promise<void> {
        if (!this.source) return;
        try {
            await this.chatService.markRead(this.source, this.channelId);
        } catch {
            // Kept in the outbox for the next flush
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
        this.state.text = (ev.target as HTMLTextAreaElement).value;
        if (this.source && this.state.text.trim()) {
            this.chatService.typing(this.source, this.channelId, true).catch(() => {});
        }
    }

    /** Queues the trimmed text; empty or blank text is never sent. */
    async onSend(): Promise<void> {
        const text = this.state.text.trim();
        if (!text || !this.source) return;
        this.state.text = "";
        await this.chatService.send(this.source, this.channelId, text);
        await this.refresh();
        this.scrollToBottomSoon();
    }

    /** Puts a failed post back in the outbox and drains it. */
    async onRetry(row: ThreadRow): Promise<void> {
        if (!row.opId || !this.source) return;
        await this.syncService.outbox.retry(row.opId);
        try {
            await this.chatService.queue.flush(this.source.creds, { force: true });
        } catch {
            // Stays queued for the next flush
        }
        await this.refresh();
    }
}
