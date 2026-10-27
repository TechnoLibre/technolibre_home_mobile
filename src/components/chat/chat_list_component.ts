import { onMounted, onWillUnmount, useState, xml } from "@odoo/owl";

import { EnhancedComponent } from "../../js/enhancedComponent";
import { HeadingComponent } from "../heading/heading_component";
import { Events } from "../../constants/events";
import { getCurrentLocale, t } from "../../i18n";
import { attachmentPreview, bodyPreview, draftPreview, isEmptyBody } from "../../services/chat/chatBody";
import { serverChoiceMode, type ChatSource, type ChoiceMode } from "../../services/chat/chatSources";
import { displayNameOf } from "../../services/chat/chatNames";
import { isBold, unreadOf } from "../../services/chat/chatUnread";
import type { ChatChannel, ChatMailboxItem, ChatMessage, ChatNotice } from "../../models/chat";
import { emptyResults, isSearchTerm, mergeHits, type SearchHit, type SearchResults, type ServerResults } from "../../services/chat/chatSearch";
import {
    ChatSearchResultsComponent, conversationLabelKey, partnerLabelKey, type ServerSearchState,
} from "./chat_search_results_component";
import { CHAT_DELETE, sameTarget, targetOf } from "../../services/chat/chatOutbox";
import { formatBytes } from "../../utils/formatBytes";

const FILTER_KEY = "chat.filter";
const PREVIEW_MAX = 80;
/** Quiet period that folds a burst of CHAT_CHANGED into one rebuild. */
const CHANGE_DEBOUNCE_MS = 150;
/** Quiet period after the last key before the phone's search runs. */
const SEARCH_DEBOUNCE_MS = 200;
/** A conversation started from the search opens at once, as from the new conversation screen. */
const AT_ONCE = { background: true };

interface ListSource {
    configId: string;
    label: string;
    unread: number;
    /** The account's starred messages (starredCounter). */
    starred: number;
    /** The account's inbox items as Odoo counts them (inboxCounter, its mentions included). */
    inbox: number;
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
    /** Kept on top of the list by the user. */
    onTop: boolean;
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
    /** For a refused edit, the conversation whose thread takes its text back (« Reprendre »); null otherwise. */
    resume: number | null;
}

/** The server pages of one account for the current search: where the next one starts and whether there is one. */
interface ServerPages {
    src: ChatSource;
    /** Smallest server id shown, the `before` of the next page; null before any hit. */
    before: number | null;
    shown: number;
    count: number | null;
    more: boolean;
}

interface ChatListState {
    mode: ChoiceMode;
    sources: ListSource[];
    /** configId of the server kept, null for all of them. */
    filter: string | null;
    rows: ChatRow[];
    notices: NoticeRow[];
    query: string;
    /** The search's answer while the query is a search term (isSearchTerm), shown in place of the rows; null otherwise. */
    results: SearchResults | null;
    /** How the servers' part of the search stands. */
    server: ServerSearchState;
    /** The servers' matches, summed over the accounts that answered; null when none did. */
    serverCount: number | null;
    /** An account that answered may have a next page (« Plus de résultats »). */
    serverMore: boolean;
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

/** What a notice of a file not sent says: its name and why, the server's limit (formatBytes) when known. */
function fileNoticeText(file: NonNullable<ChatNotice["file"]>): string {
    const name = file.name;
    switch (file.reason) {
        case "too_big":
            return file.limit === null
                ? t("chat.notice_file_too_big_server", { name })
                : t("chat.notice_file_too_big", { name, limit: formatBytes(file.limit, getCurrentLocale()) });
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

    static components = { HeadingComponent, ChatSearchResultsComponent };

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
        <div class="chat-list__cache-status" role="status">
          <button t-if="state.cacheWarn" class="chat-list__cache-warning" t-on-click="onCacheWarning"
                  t-esc="'⚠️ ' + t('chat.list_cache_warning')"/>
        </div>
        <p t-if="state.refreshing" class="chat-list__refreshing" t-esc="t('chat.loading')"/>
        <p t-if="state.error" class="chat-list__failed" role="alert" t-esc="state.error"/>
        <ul t-if="state.notices.length" class="chat-list__notices" role="alert">
          <li t-foreach="state.notices" t-as="n" t-key="n.id" class="chat-list__notice">
            <span t-if="state.mode !== 'none'" class="chat-list__tag" t-esc="n.serverLabel"/>
            <span class="chat-list__failed" t-esc="'⚠️ ' + n.text"/>
            <button t-if="n.resume !== null" class="chat-list__resume" t-on-click="() => this.onResume(n)" t-esc="t('chat.resume')"/>
            <button class="chat-list__dismiss" t-on-click="() => this.onDismissNotice(n)" t-esc="t('chat.dismiss')"/>
          </li>
        </ul>
        <ChatSearchResultsComponent t-if="state.results" results="state.results" term="searchTerm()" server="state.server"
                                    count="state.serverCount" more="state.serverMore" labels="searchLabels()" onConversation.bind="onSearchConversation"
                                    onHit.bind="onHit" onMailbox.bind="onSearchMailbox" onPerson.bind="onSearchPerson"
                                    onJoin.bind="onSearchJoin" onMore.bind="onSearchMore"/>
        <t t-else="">
        <button type="button" class="chat-list__inbox" t-on-click="onInbox">
          <span class="chat-list__inbox-label" t-esc="'📥 ' + t('chat.inbox_list')"/>
          <span t-if="inboxTotal() > 0" class="chat-list__pill chat-list__inbox-count" t-esc="inboxTotal()"/>
        </button>
        <button type="button" class="chat-list__starred" t-on-click="onStarred">
          <span class="chat-list__starred-label" t-esc="'★ ' + t('chat.starred_list')"/>
          <span t-if="starredTotal() > 0" class="chat-list__pill chat-list__starred-count" t-esc="starredTotal()"/>
        </button>
        <ul class="chat-list__rows">
          <li t-foreach="visibleRows()" t-as="row" t-key="row.configId + ':' + row.channelId"
              class="chat-list__row" t-att-class="{'chat-list__row--bold': row.bold}"
              t-on-click="() => this.onRowClick(row)">
            <span class="chat-list__avatar" aria-hidden="true" t-esc="avatarOf(row)"/>
            <span class="chat-list__body">
              <span class="chat-list__top">
                <span t-if="row.onTop" class="chat-list__on-top" role="img" t-att-aria-label="t('chat.on_top')">📌</span>
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
      </t>
    </div>`;

    private _building: Promise<void> | null = null;
    private _again = false;
    /** Bumped by every filter change; a build started under an older value is dropped. */
    private _gen = 0;
    private _debounce: ReturnType<typeof setTimeout> | null = null;
    /** Bumped by every query change; a search answer started under an older value is dropped. */
    private _searchGen = 0;
    private _searchTimer: ReturnType<typeof setTimeout> | null = null;
    /** The names the results show (ChatSearchResultsComponent `labels`) and the term they answer, set with each answer. */
    private _labels = new Map<string, string>();
    private _term = "";
    /** The server pages of the current search, by account; only the accounts that answered. */
    private _pages = new Map<string, ServerPages>();
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
            results: null,
            server: "idle",
            serverCount: null,
            serverMore: false,
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
            if (this._searchTimer !== null) clearTimeout(this._searchTimer);
            this._searchGen++;
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
            const st = await this.chatService.repo.sourceState(s.configId);
            withUnread.push({
                configId: s.configId,
                label: s.label,
                unread: await this.chatService.unreadTotal([s.configId]),
                starred: st.starredCounter ?? 0,
                inbox: st.inboxCounter ?? 0,
            });
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
            // Outbox ops matter to conversations still being created, and to a last message emptied (its delete may be queued)
            const emptied = mine.some((c) => isEmptyBody(lasts.get(c.channelId)?.body ?? "-")
                || (pendings.get(c.channelId) ?? []).some((m) => isEmptyBody(m.body)));
            const ops = mine.some((c) => c.createOpId) || emptied ? await this.databaseService.getOutboxOpsForConfig(id) : [];
            // A message whose delete is queued is hidden at once, its files still there until the server answers
            const deletes = ops.filter((o) => o.kind === CHAT_DELETE && o.status !== "blocked").map(targetOf);
            const deleting = (m: ChatMessage): boolean => deletes.some((d) => sameTarget(d, m));
            const gone = mine.filter((c) => {
                const m = lasts.get(c.channelId);
                return !!m && deleting(m);
            });
            if (gone.length > 0) {
                const skip = new Set(deletes.map((d) => d.messageId).filter((v): v is number => v !== null));
                const again = await this.chatService.repo.lastMessages(id, gone, skip);
                for (const c of gone) {
                    const m = again.get(c.channelId);
                    if (m) lasts.set(c.channelId, m);
                    else lasts.delete(c.channelId);
                }
            }
            const blocked = new Set(ops
                .filter((o) => o.status === "blocked" && o.params?.blockedReason === "ambiguous")
                .map((o) => o.id));
            // The files of last messages without text are read side by side, after the rows
            const filesLines: Promise<void>[] = [];
            for (const c of mine) {
                // A queued post whose delete waits for its post is skipped, as a sent one is
                const queued = pendings.get(c.channelId)?.filter((m) => !deleting(m));
                const last = queued?.[queued.length - 1] ?? lasts.get(c.channelId) ?? null;
                const title = displayNameOf(c, membersOf.get(c.channelId) ?? [], byPartner, state.selfPartnerId, getCurrentLocale());
                const text = last ? bodyPreview(last.body, PREVIEW_MAX) : "";
                const row = this.rowOf(c, labelOf.get(id) ?? "", title, last, text);
                row.ambiguous = !!c.createOpId && blocked.has(c.createOpId);
                byKey.set(c.configId + ":" + c.channelId, row);
                // A draft stands in the last message's place, after the mark of one still on its way; the time, unread and order stay the conversation's
                const draft = drafts.get(c.channelId);
                if (draft) {
                    const line = draft.editing ? t("chat.draft_editing") : draftPreview(draft.text, draft.files, PREVIEW_MAX);
                    row.preview = (last?.status === "pending" ? "⏳ " : "") + line;
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
     * name, the line starts with a capital. A refused reply on a record
     * names the record and its text (its files' count without text, the
     * record alone without either).
     */
    private noticeOf(n: ChatNotice, title: string, serverLabel: string): NoticeRow {
        const name = title || n.label;
        let text: string;
        if (n.file) text = fileNoticeText(n.file);
        else if (n.kind === "chat.dropped") {
            text = t(n.count === 1 ? "chat.notice_dropped_one" : "chat.notice_dropped_other", { count: n.count });
        } else if (n.edit) {
            text = t(n.edit.deleted ? "chat.notice_edit_deleted" : "chat.notice_edit_changed");
        } else if (n.reply) {
            const record = n.reply.thread.recordName;
            const count = n.reply.files.length;
            const said = n.reply.text.trim();
            if (said) text = t("chat.notice_record_post_refused", { record, text: said });
            else if (count === 0) text = t("chat.notice_record_post_refused_empty", { record });
            else text = t(count === 1 ? "chat.notice_record_post_refused_files_one" : "chat.notice_record_post_refused_files_other", { record, count });
        } else {
            const vanished = n.message ? "chat.notice_message_vanished" : "chat.notice_vanished";
            text = t(n.reason === "vanished" ? vanished : "chat.notice_refused", {
                action: t("chat.action_" + n.kind.replace(/^chat\./, "")),
            });
        }
        const line = name ? name + " — " + text : text.charAt(0).toUpperCase() + text.slice(1);
        return { id: n.id, configId: n.configId, serverLabel, text: line, resume: n.edit && n.channelId !== null ? n.channelId : null };
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
            onTop: c.onTop === true,
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

    /** The starred messages of the accounts shown (the filter's, else all), as « ★ Favoris » counts them. */
    starredTotal(): number {
        return this.state.sources
            .filter((s) => this.state.filter === null || s.configId === this.state.filter)
            .reduce((sum, s) => sum + s.starred, 0);
    }

    /** The inbox items of the accounts shown (the filter's, else all), as « 📥 Boîte de réception » counts them. */
    inboxTotal(): number {
        return this.state.sources
            .filter((s) => this.state.filter === null || s.configId === this.state.filter)
            .reduce((sum, s) => sum + s.inbox, 0);
    }

    /** « 📥 Boîte de réception »: the inbox of every account. */
    onInbox(): void {
        this.navigate("/chat/inbox");
    }

    /** « ★ Favoris »: the starred messages of every account. */
    onStarred(): void {
        this.navigate("/chat/starred");
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
        // An answer still on its way was asked under the old filter: it is dropped and asked again
        if (isSearchTerm(this.state.query)) this.scheduleSearch();
    }

    onSelectChange(ev: Event): void {
        this.onFilter((ev.target as HTMLSelectElement).value || null);
    }

    /**
     * A query of SEARCH_MIN characters or more searches the phone
     * SEARCH_DEBOUNCE_MS after the last key, and its answer replaces the
     * rows; a shorter one filters the rows at once.
     */
    onQueryInput(ev: Event): void {
        this.state.query = (ev.target as HTMLInputElement).value;
        this.scheduleSearch();
    }

    /**
     * Restarts the search wait for the current query. Every call moves the
     * generation, so an answer of an older query or filter is dropped; a
     * query that is not a search term clears the results at once.
     */
    private scheduleSearch(): void {
        if (this._searchTimer !== null) clearTimeout(this._searchTimer);
        this._searchTimer = null;
        const gen = ++this._searchGen;
        if (!isSearchTerm(this.state.query)) {
            this.state.results = null;
            this.state.server = "idle";
            return;
        }
        this._searchTimer = setTimeout(() => {
            this._searchTimer = null;
            void this.runSearch(gen);
        }, SEARCH_DEBOUNCE_MS);
    }

    /**
     * Searches the accounts the filter keeps on the phone, then the names
     * the results show: the server of each account when the list shows
     * servers, the title of each listed conversation, the cached people. A
     * failure shows no result. The phone's answer shows at once; each
     * account's server is then asked for its first page (serverPages).
     */
    private async runSearch(gen: number): Promise<void> {
        const term = this.state.query;
        const ids = this.state.filter === null ? this.state.sources.map((s) => s.configId) : [this.state.filter];
        let results: SearchResults;
        const labels = new Map<string, string>();
        try {
            results = await this.chatService.search.local(ids, term);
            if (gen !== this._searchGen) return;
            if (this.state.mode !== "none") for (const s of this.state.sources) labels.set(s.configId, s.label);
            for (const r of this.state.rows) labels.set(conversationLabelKey(r.configId, r.channelId), r.title);
            for (const id of ids) {
                for (const p of await this.chatService.repo.partners(id)) labels.set(partnerLabelKey(id, p.partnerId), p.name);
            }
        } catch (e) {
            console.warn("chat list: search failed", e);
            results = emptyResults();
        }
        if (gen !== this._searchGen) return;
        this._labels = labels;
        this._term = term;
        this._pages = new Map();
        this.state.results = results;
        this.state.serverCount = null;
        this.state.serverMore = false;
        const sources = (await this.chatService.sources({ online: false })).filter((s) => ids.includes(s.configId));
        if (gen !== this._searchGen) return;
        if (sources.length === 0) {
            this.state.server = "idle";
            return;
        }
        await this.serverPages(gen, term, sources.map((src) => ({ src, before: undefined })));
    }

    /**
     * Asks each account's server for a page (ChatSearch.server) side by
     * side and merges what answers into the shown results: the messages
     * and the files after the phone's, once each (mergeHits), the people
     * and channels to join not shown yet. An account counts its hits
     * shown: Odoo may answer a page short of SERVER_PAGE while more match,
     * so a next page is offered while a page brings hits and fewer than its
     * count are shown. The status: « error » when an account asked failed
     * (its next page still offered when it had one), else « done » once an
     * account has answered, else « offline ». An answer of an
     * older query or filter (`gen`) is dropped.
     */
    private async serverPages(gen: number, term: string, asks: { src: ChatSource; before: number | undefined }[]): Promise<void> {
        this.state.server = "loading";
        this.state.serverMore = false;
        const answers = await Promise.allSettled(asks.map((a) => this.chatService.search.server(a.src, term, a.before)));
        if (gen !== this._searchGen || !this.state.results) return;
        let failed = false;
        const found: ServerResults[] = [];
        const answered: string[] = [];
        answers.forEach((a, i) => {
            const src = asks[i].src;
            if (a.status === "rejected") {
                console.warn("chat list: server search failed", a.reason);
                failed = true;
                return;
            }
            const r = a.value;
            if (r.offline) return;
            found.push(r);
            answered.push(src.configId);
            const page = this._pages.get(src.configId) ?? { src, before: null, shown: 0, count: null, more: false };
            const ids = r.hits.map((h) => h.messageId).filter((v): v is number => v !== null);
            if (ids.length > 0) page.before = Math.min(page.before ?? Infinity, ...ids);
            page.shown += r.hits.length;
            page.count = r.count;
            page.more = r.hits.length > 0 && page.count !== null && page.shown < page.count;
            this._pages.set(src.configId, page);
        });
        const shown = this.state.results;
        const hits = found.flatMap((r) => r.hits);
        const people = [...shown.people];
        const joinable = [...shown.joinable];
        answers.forEach((a, i) => {
            if (a.status !== "fulfilled" || a.value.offline) return;
            const configId = asks[i].src.configId;
            for (const partner of a.value.people) {
                if (!people.some((p) => p.configId === configId && p.partner.partnerId === partner.partnerId)) people.push({ configId, partner });
            }
            for (const channel of a.value.joinable) {
                if (!joinable.some((j) => j.configId === configId && j.channel.channelId === channel.channelId)) joinable.push({ configId, channel });
            }
        });
        const results: SearchResults = {
            ...shown,
            people,
            joinable,
            messages: mergeHits(shown.messages, hits.filter((h) => h.fileName === null)),
            files: mergeHits(shown.files, hits.filter((h) => h.fileName !== null)),
        };
        const labels = await this.withServerLabels(new Map(this._labels), results, answered);
        if (gen !== this._searchGen) return;
        this._labels = labels;
        this.state.results = results;
        const pages = [...this._pages.values()];
        this.state.server = failed ? "error" : pages.length > 0 ? "done" : "offline";
        this.state.serverCount = pages.length > 0 ? pages.reduce((sum, p) => sum + (p.count ?? 0), 0) : null;
        this.state.serverMore = pages.some((p) => p.more);
    }

    /**
     * The labels with the names the server's answer brought: the people of
     * the accounts that answered as now cached (the server's authors and
     * people included), and the title of a conversation of a hit the list
     * does not show (a hidden direct chat), from the cache. A read that
     * fails leaves the labels as they were.
     */
    private async withServerLabels(labels: Map<string, string>, results: SearchResults, configIds: string[]): Promise<Map<string, string>> {
        try {
            for (const id of configIds) {
                for (const p of await this.chatService.repo.partners(id)) labels.set(partnerLabelKey(id, p.partnerId), p.name);
            }
            const missing = [...results.messages, ...results.files].filter((h) => !labels.has(conversationLabelKey(h.configId, h.channelId)));
            for (const id of new Set(missing.map((h) => h.configId))) {
                const [channels, partners, membersOf, state] = await Promise.all([
                    this.chatService.repo.channels(id),
                    this.chatService.repo.partners(id),
                    this.chatService.repo.membersBySource(id),
                    this.chatService.repo.sourceState(id),
                ]);
                const byPartner = new Map(partners.map((p) => [p.partnerId, p]));
                for (const c of channels) {
                    const k = conversationLabelKey(id, c.channelId);
                    if (labels.has(k)) continue;
                    labels.set(k, displayNameOf(c, membersOf.get(c.channelId) ?? [], byPartner, state.selfPartnerId, getCurrentLocale()));
                }
            }
        } catch (e) {
            console.warn("chat list: search names unreadable", e);
        }
        return labels;
    }

    searchLabels(): Map<string, string> {
        return this._labels;
    }

    searchTerm(): string {
        return this._term;
    }

    private openThread(configId: string, channelId: number, at = ""): void {
        this.navigate("/chat/" + encodeURIComponent(configId) + "/" + channelId + at);
    }

    /** A message found opens its conversation at it: `?m=<id>`, or `?u=<client uuid>` for one still queued. */
    onHit(hit: SearchHit): void {
        const at = hit.messageId !== null ? "?m=" + hit.messageId : hit.clientUuid ? "?u=" + encodeURIComponent(hit.clientUuid) : "";
        this.openThread(hit.configId, hit.channelId, at);
    }

    onSearchConversation(configId: string, channelId: number): void {
        this.openThread(configId, channelId);
    }

    /**
     * An inbox, history or starred item found opens as on the inbox screen
     * (ChatInbox.openItem: a mention at its message, a record's message its
     * note or the web view); a failure shows a notice.
     */
    async onSearchMailbox(item: ChatMailboxItem): Promise<void> {
        this.state.error = "";
        try {
            const src = (await this.chatService.sources({ online: false })).find((s) => s.configId === item.configId);
            if (!src) return;
            await this.chatService.inbox.openItem(src, item, (url) => this.navigate(url));
        } catch (e) {
            console.warn("chat list: mailbox item not opened", e);
            this.state.error = t("chat.action_error");
        }
    }

    /** The person's direct conversation (startDirect), then its thread; a failure to queue shows a notice. */
    async onSearchPerson(configId: string, partnerId: number): Promise<void> {
        await this.fromSearch(configId, (src) => this.chatService.startDirect(src, partnerId, AT_ONCE));
    }

    /** Joins a channel found, then opens its thread. */
    async onSearchJoin(configId: string, channelId: number): Promise<void> {
        const name = this.state.results?.joinable.find((j) => j.configId === configId && j.channel.channelId === channelId)?.channel.name ?? "";
        await this.fromSearch(configId, (src) => this.chatService.join(src, channelId, name, AT_ONCE));
    }

    /** « Plus de résultats »: the next page of each account that may have one, below the smallest id it showed. */
    async onSearchMore(): Promise<void> {
        const asks = [...this._pages.values()]
            .filter((p) => p.more)
            .map((p) => ({ src: p.src, before: p.before ?? undefined }));
        if (asks.length === 0) return;
        await this.serverPages(this._searchGen, this._term, asks);
    }

    private async fromSearch(
        configId: string,
        action: (src: ChatSource) => Promise<{ configId: string; channelId: number }>,
    ): Promise<void> {
        this.state.error = "";
        try {
            const src = (await this.chatService.sources({ online: false })).find((s) => s.configId === configId);
            if (!src) return;
            const r = await action(src);
            this.openThread(r.configId, r.channelId);
        } catch (e) {
            console.warn("chat list:", e);
            this.state.error = t("chat.action_error");
        }
    }

    onRowClick(row: ChatRow): void {
        this.navigate("/chat/" + encodeURIComponent(row.configId) + "/" + row.channelId);
    }

    /** Removes a conversation the server refused, or one left, with its unsent texts; a failure shows a notice. */
    async onDismiss(row: ChatRow): Promise<void> {
        await this.dismissing(() => this.chatService.discardCreate(row.configId, row.channelId));
    }

    /**
     * « Reprendre » on a refused edit: asked of the service
     * (requestResume), then its conversation opens, whose thread takes the
     * text back.
     */
    onResume(n: NoticeRow): void {
        if (n.resume === null) return;
        this.chatService.requestResume(n.configId, n.id);
        this.navigate("/chat/" + encodeURIComponent(n.configId) + "/" + n.resume);
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
