import { onMounted, onWillUnmount, useState, xml } from "@odoo/owl";

import { EnhancedComponent } from "../../js/enhancedComponent";
import { HeadingComponent } from "../heading/heading_component";
import { Events } from "../../constants/events";
import { getCurrentLocale, t } from "../../i18n";
import { attachmentPreview, bodyPreview, draftPreview } from "../../services/chat/chatBody";
import { serverChoiceMode, type ChoiceMode } from "../../services/chat/chatSources";
import { displayNameOf } from "../../services/chat/chatNames";
import { isBold, unreadOf } from "../../services/chat/chatUnread";
import type { ChatChannel, ChatMessage, ChatNotice } from "../../models/chat";

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
    /** The server refused to create ("create") or join ("join") it, or the user left it with texts unsent ("left"); "" otherwise. */
    failed: "" | "create" | "join" | "left";
    /** Its create is blocked: a lost answer left several server conversations that may be it. */
    ambiguous: boolean;
}

/** An action the outbox gave up on, as the list shows it until dismissed. */
interface NoticeRow {
    id: string;
    configId: string;
    /** The server of the notice, shown as the rows show theirs. */
    serverLabel: string;
    text: string;
}

interface ChatListState {
    mode: ChoiceMode;
    sources: ListSource[];
    /** configId of the server kept, null for all of them. */
    filter: string | null;
    rows: ChatRow[];
    notices: NoticeRow[];
    query: string;
    refreshing: boolean;
    /** At least one server lets the user start a conversation (an internal user, or not read yet). */
    canCreate: boolean;
    /** Text of the last failed dismissal; "" when none. */
    error: string;
    /** The chat's files near the cache limit; read at each build, never at a render. */
    cacheWarn: boolean;
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

/** What a notice of a file not sent says: its name and why, the server's limit in MB when known. */
function fileNoticeText(file: NonNullable<ChatNotice["file"]>): string {
    const name = file.name;
    switch (file.reason) {
        case "too_big":
            return file.limit === null
                ? t("chat.notice_file_too_big_server", { name })
                : t("chat.notice_file_too_big", { name, limit: Number((file.limit / (1024 * 1024)).toFixed(1)) });
        case "missing":
            return t("chat.notice_file_missing", { name });
        case "not_found":
            return t("chat.notice_file_not_found", { name });
        default:
            return t("chat.notice_file_refused", { name });
    }
}

/**
 * The mixed conversation list of every chat source. It renders from the
 * cache first (sources decided offline), then reads each server in the
 * background and rebuilds on CHAT_CHANGED. The notices of every server
 * show whatever the filter, each with its server. New conversations are
 * offered as Odoo offers them, to an internal user: the button hides once
 * every server read says the user is not one.
 */
export class ChatListComponent extends EnhancedComponent {
    state!: ChatListState;

    static components = { HeadingComponent };

    static template = xml`
    <div id="chat-list">
      <HeadingComponent title="t('label.chat')"/>
      <button t-if="state.mode !== 'unavailable' and state.canCreate" class="chat-list__new" t-att-aria-label="t('chat.new')"
              t-on-click="onNew">＋</button>
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
        <button t-if="state.cacheWarn" class="chat-list__cache-warning" role="alert" t-on-click="onCacheWarning"
                t-esc="'⚠️ ' + t('chat.list_cache_warning')"/>
        <p t-if="state.refreshing" class="chat-list__refreshing" t-esc="t('chat.loading')"/>
        <p t-if="state.error" class="chat-list__failed" role="alert" t-esc="state.error"/>
        <ul t-if="state.notices.length" class="chat-list__notices" role="alert">
          <li t-foreach="state.notices" t-as="n" t-key="n.id" class="chat-list__notice">
            <span t-if="state.mode !== 'none'" class="chat-list__tag" t-esc="n.serverLabel"/>
            <span class="chat-list__failed" t-esc="'⚠️ ' + n.text"/>
            <button class="chat-list__dismiss" t-on-click="() => this.onDismissNotice(n)" t-esc="t('chat.dismiss')"/>
          </li>
        </ul>
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
                <span t-if="row.failed" class="chat-list__failed"
                      t-esc="'⚠️ ' + failedText(row)"/>
                <span t-if="row.ambiguous" class="chat-list__failed"
                      t-esc="'⚠️ ' + t('chat.create_ambiguous_short')"/>
                <span class="chat-list__preview" t-esc="row.preview"/>
                <span t-if="row.unread > 0" class="chat-list__pill" t-esc="row.unread"/>
                <button t-if="row.failed" class="chat-list__dismiss" t-on-click.stop="() => this.onDismiss(row)"
                        t-esc="t('chat.dismiss')"/>
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
            notices: [],
            query: "",
            refreshing: false,
            canCreate: true,
            error: "",
            cacheWarn: false,
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
        let canCreate = false;
        for (const s of sources) {
            withUnread.push({
                configId: s.configId,
                label: s.label,
                unread: await this.chatService.unreadTotal([s.configId]),
            });
            const st = await this.chatService.repo.sourceState(s.configId);
            // Not read yet (no load): offered, the load decides
            if (st.isInternalUser || !st.loadedAt) canCreate = true;
        }
        const channels =
            sources.length === 0 ? [] : await this.chatService.conversations(kept === null ? undefined : [kept]);
        const labelOf = new Map(sources.map((s) => [s.configId, s.label]));
        const byKey = new Map<string, ChatRow>();
        for (const id of new Set(channels.map((c) => c.configId))) {
            const mine = channels.filter((c) => c.configId === id);
            const [partners, lasts, pendings, membersOf, state, drafts] = await Promise.all([
                this.chatService.repo.partners(id),
                this.chatService.repo.lastMessages(id, mine),
                this.chatService.repo.pendingMessages(id),
                this.chatService.repo.membersBySource(id),
                this.chatService.repo.sourceState(id),
                this.chatService.draftSummaries(id),
            ]);
            const byPartner = new Map(partners.map((p) => [p.partnerId, p]));
            // Outbox ops matter only to conversations still being created
            const ops = mine.some((c) => c.createOpId) ? await this.databaseService.getOutboxOpsForConfig(id) : [];
            const blocked = new Set(ops
                .filter((o) => o.status === "blocked" && o.params?.blockedReason === "ambiguous")
                .map((o) => o.id));
            // The files of last messages without text are read side by side, after the rows
            const filesLines: Promise<void>[] = [];
            for (const c of mine) {
                const queued = pendings.get(c.channelId);
                const last = queued?.[queued.length - 1] ?? lasts.get(c.channelId) ?? null;
                const title = displayNameOf(c, membersOf.get(c.channelId) ?? [], byPartner, state.selfPartnerId, getCurrentLocale());
                const text = last ? bodyPreview(last.body, PREVIEW_MAX) : "";
                const row = this.rowOf(c, labelOf.get(id) ?? "", title, last, text);
                row.ambiguous = !!c.createOpId && blocked.has(c.createOpId);
                byKey.set(c.configId + ":" + c.channelId, row);
                // A draft stands in the last message's place, after the mark of one still on its way; the time, unread and order stay the conversation's
                const draft = drafts.get(c.channelId);
                if (draft) {
                    row.preview = (last?.status === "pending" ? "⏳ " : "") + draftPreview(draft.text, draft.files, PREVIEW_MAX);
                    continue;
                }
                if (!text && last && last.messageType === "comment") {
                    filesLines.push(this.filesLine(id, c.channelId, last).then((line) => {
                        if (line) row.preview = (last.status === "pending" ? "⏳ " : "") + line;
                    }));
                }
            }
            await Promise.all(filesLines);
        }
        // Rows keep the order the service gave
        const ordered = channels.map((c) => byKey.get(c.configId + ":" + c.channelId)!);
        // A notice waits for the user's eyes: the filter of the rows does not hide it
        const [notices, cacheWarn] = await Promise.all([
            sources.length === 0 ? [] : this.chatService.notices(sources.map((s) => s.configId)),
            this.cacheWarning(),
        ]);
        if (gen !== this._gen) return;
        this.state.cacheWarn = cacheWarn;
        this.state.filter = kept;
        this.state.mode = serverChoiceMode(sources.length);
        this.state.sources = withUnread;
        this.state.canCreate = canCreate;
        this.state.rows = ordered;
        this.state.notices = notices.map((n) =>
            this.noticeOf(n, byKey.get(n.configId + ":" + n.channelId)?.title ?? "", labelOf.get(n.configId) ?? ""));
    }

    /** Whether the chat's files near the cache limit; a failed read counts as no warning. */
    private async cacheWarning(): Promise<boolean> {
        try {
            return await this.chatService.attachments.warning();
        } catch (e) {
            console.warn("chat list: cache warning unreadable", e);
            return false;
        }
    }

    /**
     * The notice's line: the conversation's title when it is listed (else
     * the name the notice kept), then what was not done and why; without a
     * name, the line starts with a capital.
     */
    private noticeOf(n: ChatNotice, title: string, serverLabel: string): NoticeRow {
        const name = title || n.label;
        let text: string;
        if (n.file) text = fileNoticeText(n.file);
        else if (n.kind === "chat.dropped") {
            text = t(n.count === 1 ? "chat.notice_dropped_one" : "chat.notice_dropped_other", { count: n.count });
        } else {
            text = t(n.reason === "vanished" ? "chat.notice_vanished" : "chat.notice_refused", {
                action: t("chat.action_" + n.kind.replace(/^chat\./, "")),
            });
        }
        const line = name ? name + " — " + text : text.charAt(0).toUpperCase() + text.slice(1);
        return { id: n.id, configId: n.configId, serverLabel, text: line };
    }

    failedText(row: ChatRow): string {
        if (row.failed === "left") return t("chat.left_conversation");
        return row.failed === "join" ? t("chat.join_failed_short") : t("chat.create_failed_short");
    }

    /**
     * The preview of a last post without text: its files (attachmentPreview),
     * "" when it has none (a post emptied on the server keeps no file).
     */
    private async filesLine(configId: string, channelId: number, last: ChatMessage): Promise<string> {
        const key = last.messageId !== null ? "m" + last.messageId : last.clientUuid ? "u" + last.clientUuid : null;
        if (!key) return "";
        const groups = await this.chatService.repo.attachmentsOf(
            configId, channelId,
            last.messageId !== null ? [last.messageId] : [],
            last.messageId === null && last.clientUuid ? [last.clientUuid] : [],
        );
        return attachmentPreview(groups.get(key) ?? [], PREVIEW_MAX);
    }

    /** One row; text is the last message's preview line (its body, else its files). */
    private rowOf(c: ChatChannel, serverLabel: string, title: string, last: ChatMessage | null, text: string): ChatRow {
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
            failed: c.createFailed ? (c.channelId < 0 ? "create" : "join") : c.leftUnsent ? "left" : "",
            ambiguous: false,
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

    /** Removes a conversation the server refused, or one left, with its unsent texts; a failure shows a notice. */
    async onDismiss(row: ChatRow): Promise<void> {
        await this.dismissing(() => this.chatService.discardCreate(row.configId, row.channelId));
    }

    async onDismissNotice(n: NoticeRow): Promise<void> {
        await this.dismissing(() => this.chatService.dismissNotice(n.configId, n.id));
    }

    private async dismissing(action: () => Promise<void>): Promise<void> {
        this.state.error = "";
        try {
            await action();
        } catch (e) {
            console.warn("chat list:", e);
            this.state.error = t("chat.action_error");
        }
        await this.loadCache();
    }

    /** Opens Options › Chat, where the files are cleared and the limit is set. */
    onCacheWarning(): void {
        this.navigate("/options#chat");
    }

    onNew(): void {
        this.navigate("/chat/new");
    }

    onAddServer(): void {
        this.navigate("/applications/add");
    }
}
