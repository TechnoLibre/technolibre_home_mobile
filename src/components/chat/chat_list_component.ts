import { onMounted, onWillUnmount, useState, xml } from "@odoo/owl";

import { EnhancedComponent } from "../../js/enhancedComponent";
import { HeadingComponent } from "../heading/heading_component";
import { Events } from "../../constants/events";
import { t } from "../../i18n";
import { bodyPreview } from "../../services/chat/chatBody";
import { serverChoiceMode, type ChoiceMode } from "../../services/chat/chatSources";
import { isBold, unreadOf } from "../../services/chat/chatUnread";
import type { ChatChannel, ChatMessage } from "../../models/chat";

const FILTER_KEY = "chat.filter";
const PREVIEW_MAX = 80;
/** Quiet period that folds a burst of CHAT_CHANGED into one rebuild. */
const CHANGE_DEBOUNCE_MS = 150;

interface ListSource {
    configId: string;
    label: string;
    unread: number;
}

export interface ChatRow {
    configId: string;
    channelId: number;
    title: string;
    serverLabel: string;
    preview: string;
    time: string;
    unread: number;
    bold: boolean;
    typeIcon: "👤" | "👥" | "#";
}

interface ChatListState {
    mode: ChoiceMode;
    sources: ListSource[];
    /** configId of the server kept, null for all of them. */
    filter: string | null;
    rows: ChatRow[];
    query: string;
    refreshing: boolean;
}

/** Epoch ms of an Odoo "YYYY-MM-DD HH:MM:SS" UTC string; NaN when unreadable. */
function utcMs(odooDt: string | null | undefined): number {
    return odooDt ? Date.parse(odooDt.replace(" ", "T") + "Z") : NaN;
}

/** Today: HH:MM; any other day: a short date; both in the device locale. */
export function formatListTime(odooDt: string | null | undefined, now: Date = new Date()): string {
    const ms = utcMs(odooDt);
    if (!Number.isFinite(ms)) return "";
    const d = new Date(ms);
    if (d.toDateString() === now.toDateString()) {
        return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
    return d.toLocaleDateString([], { day: "numeric", month: "short" });
}

function typeIconOf(c: ChatChannel): ChatRow["typeIcon"] {
    return c.channelType === "chat" ? "👤" : c.channelType === "group" ? "👥" : "#";
}

/** Up to two initials of a title, "?" for an empty one. */
export function initialsOf(title: string): string {
    const words = title.trim().split(/\s+/).filter(Boolean);
    return (words.slice(0, 2).map((w) => Array.from(w)[0]).join("") || "?").toUpperCase();
}

/**
 * The mixed conversation list of every chat source. It renders from the
 * cache first (sources decided offline), then reads each server in the
 * background and rebuilds on CHAT_CHANGED.
 */
export class ChatListComponent extends EnhancedComponent {
    state!: ChatListState;

    static components = { HeadingComponent };

    static template = xml`
    <div id="chat-list">
      <HeadingComponent title="t('label.chat')"/>
      <div t-if="state.mode === 'unavailable'" class="chat-list__unavailable">
        <p t-esc="t('chat.unavailable')"/>
        <button class="chat-list__add" t-on-click="onAddServer" t-esc="t('chat.add_server')"/>
      </div>
      <t t-else="">
        <div t-if="state.mode === 'chips'" class="chat-list__chips" role="tablist">
          <button class="chat-list__chip" role="tab" t-att-aria-selected="state.filter === null ? 'true' : 'false'"
                  t-att-class="{'chat-list__chip--on': state.filter === null}"
                  t-on-click="() => this.onFilter(null)">
            <t t-esc="t('chat.all')"/>
            <span t-if="totalUnread() > 0" class="chat-list__pill" t-esc="totalUnread()"/>
          </button>
          <button t-foreach="state.sources" t-as="s" t-key="s.configId" class="chat-list__chip" role="tab"
                  t-att-aria-selected="state.filter === s.configId ? 'true' : 'false'"
                  t-att-class="{'chat-list__chip--on': state.filter === s.configId}"
                  t-on-click="() => this.onFilter(s.configId)">
            <t t-esc="s.label"/>
            <span t-if="s.unread > 0" class="chat-list__pill" t-esc="s.unread"/>
          </button>
        </div>
        <select t-if="state.mode === 'dropdown'" class="chat-list__select"
                t-att-aria-label="t('chat.server_filter')" t-on-change="onSelectChange">
          <option value="" t-att-selected="state.filter === null" t-esc="t('chat.all')"/>
          <option t-foreach="state.sources" t-as="s" t-key="s.configId" t-att-value="s.configId"
                  t-att-selected="state.filter === s.configId" t-esc="s.label"/>
        </select>
        <input class="chat-list__search" type="search" t-att-placeholder="t('chat.search_placeholder')"
               t-att-value="state.query" t-on-input="onQueryInput"/>
        <p t-if="state.refreshing" class="chat-list__refreshing" t-esc="t('chat.loading')"/>
        <ul class="chat-list__rows">
          <li t-foreach="visibleRows()" t-as="row" t-key="row.configId + ':' + row.channelId"
              class="chat-list__row" t-att-class="{'chat-list__row--bold': row.bold}"
              t-on-click="() => this.onRowClick(row)">
            <span class="chat-list__avatar" aria-hidden="true" t-esc="avatarOf(row)"/>
            <span class="chat-list__body">
              <span class="chat-list__top">
                <span class="chat-list__title" t-esc="row.title"/>
                <span class="chat-list__time" t-esc="row.time"/>
              </span>
              <span class="chat-list__bottom">
                <span t-if="state.mode !== 'none'" class="chat-list__tag" t-esc="row.serverLabel"/>
                <span class="chat-list__preview" t-esc="row.preview"/>
                <span t-if="row.unread > 0" class="chat-list__pill" t-esc="row.unread"/>
              </span>
            </span>
          </li>
        </ul>
        <p t-if="!state.refreshing and visibleRows().length === 0" class="chat-list__empty"
           t-esc="t('chat.empty')"/>
      </t>
    </div>`;

    private _building: Promise<void> | null = null;
    private _again = false;
    /** Bumped by every filter change; a build started under an older value is dropped. */
    private _gen = 0;
    private _debounce: ReturnType<typeof setTimeout> | null = null;
    private _onChanged = () => {
        if (this._debounce !== null) clearTimeout(this._debounce);
        this._debounce = setTimeout(() => {
            this._debounce = null;
            this.loadCache();
        }, CHANGE_DEBOUNCE_MS);
    };

    setup() {
        this.state = useState<ChatListState>({
            mode: "none",
            sources: [],
            filter: this.readFilter(),
            rows: [],
            query: "",
            refreshing: false,
        });
        onMounted(async () => {
            this.eventBus.addEventListener(Events.CHAT_CHANGED, this._onChanged);
            await this.loadCache();
            await this.refreshOnline();
        });
        onWillUnmount(() => {
            this.eventBus.removeEventListener(Events.CHAT_CHANGED, this._onChanged);
            if (this._debounce !== null) clearTimeout(this._debounce);
        });
    }

    private readFilter(): string | null {
        try {
            return localStorage.getItem(FILTER_KEY) || null;
        } catch {
            return null;
        }
    }

    private writeFilter(value: string | null): void {
        try {
            if (value === null) localStorage.removeItem(FILTER_KEY);
            else localStorage.setItem(FILTER_KEY, value);
        } catch {
            // The choice lasts for this screen only
        }
    }

    /**
     * Builds the list from the cache; no network call. One build runs at a
     * time: a call made meanwhile folds into a single rerun, so the last
     * request always wins and no build writes over a newer one.
     */
    loadCache(): Promise<void> {
        if (this._building) {
            this._again = true;
            return this._building;
        }
        this._building = (async () => {
            try {
                do {
                    this._again = false;
                    await this.buildRows();
                } while (this._again);
            } finally {
                this._building = null;
            }
        })();
        return this._building;
    }

    private async buildRows(): Promise<void> {
        const gen = this._gen;
        const filter = this.state.filter;
        const sources = await this.chatService.sources({ online: false });
        const known = new Set(sources.map((s) => s.configId));
        const kept = filter !== null && !known.has(filter) ? null : filter;
        const withUnread: ListSource[] = [];
        for (const s of sources) {
            withUnread.push({
                configId: s.configId,
                label: s.label,
                unread: await this.chatService.unreadTotal([s.configId]),
            });
        }
        const channels =
            sources.length === 0 ? [] : await this.chatService.conversations(kept === null ? undefined : [kept]);
        const labelOf = new Map(sources.map((s) => [s.configId, s.label]));
        const byKey = new Map<string, ChatRow>();
        for (const id of new Set(channels.map((c) => c.configId))) {
            const mine = channels.filter((c) => c.configId === id);
            const [partners, lasts, pendings] = await Promise.all([
                this.chatService.repo.partners(id),
                this.chatService.repo.lastMessages(id, mine),
                this.chatService.repo.pendingMessages(id),
            ]);
            const names = new Map(partners.map((p) => [p.partnerId, p.name]));
            for (const c of mine) {
                const queued = pendings.get(c.channelId);
                const last = queued?.[queued.length - 1] ?? lasts.get(c.channelId) ?? null;
                byKey.set(c.configId + ":" + c.channelId, this.rowOf(c, labelOf.get(id) ?? "", names, last));
            }
        }
        // Rows keep the order the service gave
        const ordered = channels.map((c) => byKey.get(c.configId + ":" + c.channelId)!);
        if (gen !== this._gen) return;
        this.state.filter = kept;
        this.state.mode = serverChoiceMode(sources.length);
        this.state.sources = withUnread;
        this.state.rows = ordered;
    }

    private rowOf(c: ChatChannel, serverLabel: string, names: Map<number, string>, last: ChatMessage | null): ChatRow {
        const text = last ? bodyPreview(last.body, PREVIEW_MAX) : "";
        const title =
            c.channelType === "chat" && c.correspondentPartnerId != null
                ? (names.get(c.correspondentPartnerId) ?? c.name)
                : c.name;
        return {
            configId: c.configId,
            channelId: c.channelId,
            title,
            serverLabel,
            preview: last && last.status === "pending" ? "⏳ " + text : text,
            time: formatListTime(last?.date ?? c.lastInterestDt),
            unread: unreadOf(c),
            bold: isBold(c),
            typeIcon: typeIconOf(c),
        };
    }

    /** Reads every server in the background; a failing one keeps its cache. */
    async refreshOnline(): Promise<void> {
        this.state.refreshing = true;
        try {
            const sources = await this.chatService.sources();
            // An unreachable server rejects alone; its cached conversations stay
            await Promise.allSettled(sources.map((s) => this.chatService.load(s)));
            await this.loadCache();
        } finally {
            this.state.refreshing = false;
        }
    }

    totalUnread(): number {
        return this.state.sources.reduce((sum, s) => sum + s.unread, 0);
    }

    /** The rows whose title or preview contain the search text. */
    visibleRows(): ChatRow[] {
        const q = this.state.query.trim().toLowerCase();
        if (!q) return this.state.rows;
        return this.state.rows.filter((r) => r.title.toLowerCase().includes(q) || r.preview.toLowerCase().includes(q));
    }

    avatarOf(row: ChatRow): string {
        return row.typeIcon === "👤" ? initialsOf(row.title) : row.typeIcon;
    }

    async onFilter(configId: string | null): Promise<void> {
        this._gen++;
        this.state.filter = configId;
        this.writeFilter(configId);
        await this.loadCache();
    }

    onSelectChange(ev: Event): void {
        this.onFilter((ev.target as HTMLSelectElement).value || null);
    }

    onQueryInput(ev: Event): void {
        this.state.query = (ev.target as HTMLInputElement).value;
    }

    onRowClick(row: ChatRow): void {
        this.navigate("/chat/" + encodeURIComponent(row.configId) + "/" + row.channelId);
    }

    onAddServer(): void {
        this.navigate("/applications/add");
    }
}
