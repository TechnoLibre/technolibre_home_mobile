import { onMounted, onWillUnmount, useState, xml } from "@odoo/owl";

import { EnhancedComponent } from "../../js/enhancedComponent";
import { HeadingComponent } from "../heading/heading_component";
import { Events } from "../../constants/events";
import { t } from "../../i18n";
import { mailboxKindOf, type ChatMailboxItem, type MailboxKind } from "../../models/chat";
import { bodyPreview } from "../../services/chat/chatBody";
import { networkService } from "../../services/networkService";
import type { InboxBox } from "../../services/chat/chatInbox";
import type { ChatSource } from "../../services/chat/chatSources";
import { BackEntry } from "./chatBackEntry";
import { formatListTime } from "./chat_list_component";
import { ChatRecordReplyComponent } from "./chat_record_reply_component";

const PREVIEW_MAX = 120;
/** Characters of a waiting reply's text its line shows. */
const PENDING_PREVIEW_MAX = 60;
/** Quiet period that folds a burst of CHAT_CHANGED into one rebuild. */
const CHANGE_DEBOUNCE_MS = 150;
/** How close to the bottom of the list (px) a scroll asks for the next page. */
const NEXT_PAGE_PX = 200;

const KIND_ICONS: Record<MailboxKind, string> = { mention: "💬", record: "📄", assignment: "👤" };
const KIND_LABELS: Record<MailboxKind, string> = {
    mention: "chat.search_kind_mention",
    record: "chat.search_kind_record",
    assignment: "chat.search_kind_assignment",
};

/** One item as the screen shows it. */
export interface MailboxRow {
    key: string;
    configId: string;
    messageId: number;
    /** The conversation a channel message belongs to; null for a record's. */
    channelId: number | null;
    kindIcon: string;
    kindLabel: string;
    /** The record's or the conversation's name. */
    where: string;
    author: string;
    preview: string;
    time: string;
    /** The server's tag, "" when the app has one server. */
    serverLabel: string;
    /** The cached item the row shows, which a tap opens. */
    item: ChatMailboxItem;
    /** « Répondre » is offered: an inbox item of a followed record (not a mention, not an assignment). */
    canReply: boolean;
    /** One line per reply to it still waiting to be sent: ⏳, note or message, the start of its text, its files. */
    pending: string[];
}

/** The line of a reply waiting to be sent (ChatService.pendingRecordReplies). */
export function pendingLine(r: { text: string; note: boolean; files: number }): string {
    const text = r.text.trim();
    let line = "⏳ " + t(r.note ? "chat.record_reply_waiting_note" : "chat.record_reply_waiting_message");
    if (text) line += " — " + (text.length > PENDING_PREVIEW_MAX ? text.slice(0, PENDING_PREVIEW_MAX - 1) + "…" : text);
    if (r.files > 0) line += " · 📎 " + t(r.files === 1 ? "chat.record_reply_files_one" : "chat.record_reply_files_other", { count: r.files });
    return line;
}

/** Where the next page of an account starts, and whether there is one. */
interface Pages {
    src: ChatSource;
    before: number | null;
    more: boolean;
}

interface MailboxState {
    /** The box of the route: /chat/inbox or /chat/starred. */
    box: "inbox" | "starred";
    /** The inbox's tab. */
    tab: InboxBox;
    rows: MailboxRow[];
    /** The accounts with items in the tab shown, each with its « Tout marquer comme lu ». */
    accounts: { configId: string; label: string }[];
    /** The accounts whose notifications Odoo sends by email, each with its notice (the inbox tab only). */
    notices: { configId: string; label: string }[];
    /** The phone has no network: the switch is disabled. */
    networkOff: boolean;
    /** What the last switch of an account answered, when it did not succeed. */
    answers: Record<string, "offline" | "refused">;
    /** The accounts whose switch is running: its button is disabled until the answer. */
    switching: Record<string, boolean>;
    /** A server could not be read: the list is the phone's. */
    offline: boolean;
    loading: boolean;
    error: string;
    /** The row whose reply composer is open; null when none is. */
    reply: MailboxRow | null;
}

/**
 * The mailbox screen, of the inbox (/chat/inbox: tabs « Boîte de
 * réception » and « Historique ») or of the starred box (/chat/starred),
 * over every chat source. It renders from the cache first, then reads the
 * first page of each server (ChatInbox.refresh, ChatService.refreshStarred:
 * read-only routes, nothing marked read) and the next pages as the list
 * scrolls to its end. An item shows its kind (💬 a mention, 📄 a followed
 * record, 👤 an assignment), its record or conversation, its author, the
 * start of its text, its date and, with several servers, its server's tag.
 * An inbox item offers « Marquer comme lu », each account « Tout marquer
 * comme lu »; a starred one ☆ to unstar. A tap on an item opens it
 * (ChatInbox.openItem: its conversation at the message, the note linked to
 * its record, or the message in the web view), marking nothing read.
 * An inbox item of a followed record offers « Répondre », which opens
 * the reply composer (ChatRecordReplyComponent) at the bottom of the
 * screen; a mention is answered in its conversation and an assignment not
 * at all, as the browser's inbox. The replies to an item still waiting to
 * be sent show under it, ⏳ with their file count. On the inbox tab, an
 * account whose Odoo notifications go by email gets a notice saying why
 * nothing arrives here and « Recevoir mes notifications dans Odoo »
 * (ChatService.switchToInbox; disabled offline); a refusal offers
 * « Ouvrir mes préférences ». Every text is shown as text.
 */
export class ChatMailboxComponent extends EnhancedComponent {
    state!: MailboxState;

    static components = { HeadingComponent, ChatRecordReplyComponent };

    static template = xml`
    <div id="chat-mailbox" class="chat-mailbox">
      <HeadingComponent title="title()"/>
      <nav t-if="state.box === 'inbox'" class="chat-mailbox__tabs" role="tablist">
        <button type="button" class="chat-mailbox__tab" role="tab" t-att-aria-selected="state.tab === 'inbox' ? 'true' : 'false'"
                t-att-class="{'chat-mailbox__tab--on': state.tab === 'inbox'}"
                t-on-click="() => this.onTab('inbox')" t-esc="t('chat.inbox_tab_inbox')"/>
        <button type="button" class="chat-mailbox__tab" role="tab" t-att-aria-selected="state.tab === 'history' ? 'true' : 'false'"
                t-att-class="{'chat-mailbox__tab--on': state.tab === 'history'}"
                t-on-click="() => this.onTab('history')" t-esc="t('chat.inbox_tab_history')"/>
      </nav>
      <p t-if="state.offline" class="chat-mailbox__offline" role="status" t-esc="t('chat.mailbox_offline')"/>
      <p t-if="state.error" class="chat-mailbox__error" role="alert" t-esc="state.error"/>
      <div t-if="state.box === 'inbox' and state.tab === 'inbox' and state.accounts.length" class="chat-mailbox__all">
        <button t-foreach="state.accounts" t-as="a" t-key="a.configId" type="button" class="chat-mailbox__mark-all"
                t-on-click="() => this.onMarkAll(a.configId)"
                t-esc="t('chat.inbox_mark_all') + (serverShown() ? ' — ' + a.label : '')"/>
      </div>
      <section t-foreach="state.notices" t-as="n" t-key="n.configId" class="chat-mailbox__notice">
        <p class="chat-mailbox__notice-text" role="status"
           t-esc="(serverShown() ? n.label + ' — ' : '') + t('chat.inbox_email_notice')"/>
        <button type="button" class="chat-mailbox__switch" t-att-disabled="state.networkOff or state.switching[n.configId]"
                t-on-click="() => this.onSwitch(n.configId)" t-esc="t('chat.inbox_switch')"/>
        <p class="chat-mailbox__notice-hint" t-esc="t('chat.inbox_switch_hint')"/>
        <p t-if="state.networkOff or state.answers[n.configId] === 'offline'" class="chat-mailbox__notice-offline" role="status"
           t-esc="t('chat.inbox_switch_offline')"/>
        <t t-if="state.answers[n.configId] === 'refused'">
          <p class="chat-mailbox__notice-refused" role="alert" t-esc="t('chat.inbox_switch_refused')"/>
          <button type="button" class="chat-mailbox__prefs" t-on-click="() => this.onPreferences(n.configId)"
                  t-esc="t('chat.inbox_open_preferences')"/>
        </t>
      </section>
      <ul class="chat-mailbox__list" t-on-scroll="onScroll">
        <li t-foreach="state.rows" t-as="row" t-key="row.key" class="chat-mailbox__item" t-on-click="() => this.onOpen(row)">
          <div class="chat-mailbox__meta">
            <span t-if="state.box === 'inbox'" class="chat-mailbox__kind" role="img" t-att-aria-label="row.kindLabel" t-esc="row.kindIcon"/>
            <span class="chat-mailbox__where" t-esc="row.where"/>
            <span t-if="row.serverLabel" class="chat-mailbox__tag" t-esc="row.serverLabel"/>
            <span class="chat-mailbox__time" t-esc="row.time"/>
          </div>
          <div class="chat-mailbox__author" t-esc="row.author"/>
          <div class="chat-mailbox__preview" t-esc="row.preview"/>
          <p t-foreach="row.pending" t-as="line" t-key="line_index" class="chat-mailbox__pending" role="status" t-esc="line"/>
          <div class="chat-mailbox__actions">
            <button t-if="row.canReply" type="button" class="chat-mailbox__reply"
                    t-on-click.stop="() => this.onReply(row)" t-esc="t('chat.record_reply')"/>
            <button t-if="state.box === 'inbox' and state.tab === 'inbox'" type="button" class="chat-mailbox__mark"
                    t-on-click.stop="() => this.onMarkRead(row)" t-esc="t('chat.inbox_mark_read')"/>
            <button t-if="state.box === 'starred'" type="button" class="chat-mailbox__unstar"
                    t-att-aria-label="t('chat.unstar')" t-on-click.stop="() => this.onUnstar(row)" t-esc="'☆ ' + t('chat.unstar')"/>
          </div>
        </li>
      </ul>
      <p t-if="state.loading" class="chat-mailbox__loading" t-esc="t('chat.loading')"/>
      <p t-if="!state.loading and state.rows.length === 0" class="chat-mailbox__empty" t-esc="emptyText()"/>
      <ChatRecordReplyComponent t-if="state.reply" t-key="state.reply.key" src="replySource()" item="state.reply.item"
                                onDone.bind="onReplyDone" onCancel.bind="onReplyCancel"/>
    </div>`;

    private _sources: ChatSource[] = [];
    /** The app has more than one account, whichever the box shows. */
    private _several = false;
    private _pages = new Map<string, Pages>();
    /** Bumped by every tab change; an answer started under an older value is dropped. */
    private _gen = 0;
    private _paging = false;
    private _debounce: ReturnType<typeof setTimeout> | null = null;
    private _onChanged = () => {
        if (this._debounce !== null) clearTimeout(this._debounce);
        this._debounce = setTimeout(() => {
            this._debounce = null;
            this.loadCache();
        }, CHANGE_DEBOUNCE_MS);
    };

    setup() {
        this.state = useState<MailboxState>({
            box: window.location.pathname.replace(/\/+$/, "").endsWith("/starred") ? "starred" : "inbox",
            tab: "inbox",
            rows: [],
            accounts: [],
            notices: [],
            networkOff: false,
            answers: {},
            switching: {},
            offline: false,
            loading: false,
            error: "",
            reply: null,
        });
        onMounted(async () => {
            this.eventBus.addEventListener(Events.CHAT_CHANGED, this._onChanged);
            void this.watchNetwork();
            await this.loadCache();
            await this.refreshOnline();
        });
        onWillUnmount(() => {
            this.unwatchNetwork();
            this.eventBus.removeEventListener(Events.CHAT_CHANGED, this._onChanged);
            if (this._debounce !== null) clearTimeout(this._debounce);
            this._gen++;
        });
    }

    /** The network's reconnect callbacks; tests give their own. */
    network: Pick<typeof networkService, "onReconnect"> = networkService;
    private _unwatch: Promise<() => void> | null = null;

    /** The network back: the rows and notices read again, so « Recevoir mes notifications dans Odoo » is enabled again. */
    watchNetwork(): Promise<() => void> {
        this._unwatch ??= this.network.onReconnect(() => void this.loadCache());
        return this._unwatch;
    }

    /** Stops watchNetwork, once its listener is in place when it was not yet. */
    unwatchNetwork(): void {
        const pending = this._unwatch;
        this._unwatch = null;
        void pending?.then((stop) => stop());
    }

    title(): string {
        return this.state.box === "starred" ? t("chat.starred_list") : t("chat.inbox_list");
    }

    emptyText(): string {
        if (this.state.box === "starred") return t("chat.starred_empty");
        return this.state.tab === "history" ? t("chat.history_empty") : t("chat.inbox_empty");
    }

    /** Whether the rows carry their server's tag: the app has more than one server. */
    serverShown(): boolean {
        return this._several;
    }

    /**
     * The accounts the box shows: the one `?s=<configId>` names (the list
     * kept to that server, as its counter), else every account, as when the
     * one named is gone.
     */
    private async sources(): Promise<ChatSource[]> {
        const all = await this.chatService.sources({ online: false });
        const only = new URLSearchParams(window.location.search).get("s");
        const kept = only !== null ? all.filter((s) => s.configId === only) : [];
        this._several = all.length > 1;
        this._sources = kept.length > 0 ? kept : all;
        return this._sources;
    }

    /** Builds the rows of the box (and tab) from the cache; no network call. */
    async loadCache(): Promise<void> {
        const gen = this._gen;
        const sources = await this.sources();
        const ids = sources.map((s) => s.configId);
        const items = ids.length === 0 ? []
            : this.state.box === "starred" ? await this.chatService.starred(ids) : await this.chatService.inbox.items(ids, this.state.tab);
        const labels = new Map(sources.map((s) => [s.configId, s.label]));
        const names = new Map<string, Map<number, string>>();
        const pending = new Map<string, Map<number, { text: string; note: boolean; files: number }[]>>();
        for (const id of new Set(items.map((i) => i.configId))) {
            names.set(id, new Map((await this.chatService.repo.partners(id)).map((p) => [p.partnerId, p.name])));
            pending.set(id, await this.chatService.pendingRecordReplies(id));
        }
        const emailed: string[] = [];
        if (this.state.box === "inbox" && this.state.tab === "inbox") {
            for (const s of sources) if ((await this.chatService.repo.sourceState(s.configId)).notificationType === "email") emailed.push(s.configId);
        }
        const networkOff = emailed.length > 0 && !(await this.chatService.isOnline());
        if (gen !== this._gen) return;
        this.state.notices = sources.filter((s) => emailed.includes(s.configId)).map((s) => ({ configId: s.configId, label: s.label }));
        this.state.networkOff = networkOff;
        const tagged = this.serverShown();
        this.state.rows = items.map((i) => ({
            ...this.rowOf(i, names.get(i.configId), tagged ? labels.get(i.configId) ?? "" : ""),
            pending: (pending.get(i.configId)?.get(i.messageId) ?? []).map(pendingLine),
        }));
        this.state.accounts = sources
            .filter((s) => items.some((i) => i.configId === s.configId))
            .map((s) => ({ configId: s.configId, label: s.label }));
    }

    private rowOf(i: ChatMailboxItem, names: Map<number, string> | undefined, serverLabel: string): MailboxRow {
        const kind = mailboxKindOf(i);
        const author = i.authorPartnerId === null ? "" : names?.get(i.authorPartnerId) ?? "";
        return {
            key: `${i.configId}#${i.messageId}`,
            configId: i.configId,
            messageId: i.messageId,
            channelId: i.threadModel === "discuss.channel" ? i.threadId : null,
            kindIcon: KIND_ICONS[kind],
            kindLabel: t(KIND_LABELS[kind]),
            where: i.recordName,
            author: author || t("chat.someone"),
            preview: bodyPreview(i.body, PREVIEW_MAX),
            time: formatListTime(i.date),
            serverLabel,
            item: i,
            canReply: this.state.box === "inbox" && kind === "record",
            pending: [],
        };
    }

    /** Reads the first page of every server, then rebuilds; a server out of reach keeps its cache. */
    async refreshOnline(): Promise<void> {
        const gen = this._gen;
        this.state.loading = true;
        this.state.offline = false;
        this._pages.clear();
        try {
            const sources = this._sources.length ? this._sources : await this.sources();
            const answers = await Promise.allSettled(sources.map((s) => this.readPage(s)));
            if (gen !== this._gen) return;
            if (answers.some((a) => a.status === "rejected")) this.state.error = t("chat.mailbox_failed");
            await this.loadCache();
        } finally {
            if (gen === this._gen) this.state.loading = false;
        }
    }

    /** One page of an account (`before` the id the next page starts below), its cursor kept for the next. */
    private async readPage(src: ChatSource, before?: number): Promise<void> {
        const gen = this._gen;
        let page: { offline: boolean; more: boolean; oldestId: number | null };
        if (this.state.box === "starred") {
            const r = before === undefined ? await this.chatService.refreshStarred(src) : await this.chatService.refreshStarred(src, before);
            page = { offline: r.offline, more: !r.complete && r.oldestId !== null, oldestId: r.oldestId };
        } else {
            page = before === undefined
                ? await this.chatService.inbox.refresh(src, this.state.tab)
                : await this.chatService.inbox.refresh(src, this.state.tab, before);
        }
        if (gen !== this._gen) return;
        if (page.offline) this.state.offline = true;
        this._pages.set(src.configId, { src, before: page.oldestId, more: !page.offline && page.more && page.oldestId !== null });
    }

    /** The list scrolled near its end: the next page of every account that has one. */
    async onScroll(ev: { target: EventTarget | null }): Promise<void> {
        const el = ev.target as HTMLElement | null;
        if (!el || this._paging || el.scrollTop + el.clientHeight < el.scrollHeight - NEXT_PAGE_PX) return;
        const next = [...this._pages.values()].filter((p) => p.more && p.before !== null);
        if (next.length === 0) return;
        this._paging = true;
        try {
            await Promise.allSettled(next.map((p) => this.readPage(p.src, p.before!)));
            await this.loadCache();
        } finally {
            this._paging = false;
        }
    }

    /** A tab of the inbox: its rows from the cache, then its first pages. */
    async onTab(tab: InboxBox): Promise<void> {
        if (this.state.tab === tab) return;
        this._gen++;
        this.state.tab = tab;
        this.state.error = "";
        await this.loadCache();
        await this.refreshOnline();
    }

    private sourceOf(configId: string): ChatSource | undefined {
        return this._sources.find((s) => s.configId === configId);
    }

    /**
     * A tap on an item: opened by ChatInbox.openItem, nothing marked read.
     * A reply composer open meanwhile closes as the screen goes, its mark
     * taken off the entry left (BackEntry.leaveAll), so a back from the
     * next screen lands on this list.
     */
    async onOpen(row: MailboxRow): Promise<void> {
        const src = this.sourceOf(row.configId);
        if (!src) return;
        this.state.error = "";
        try {
            await this.chatService.inbox.openItem(src, row.item, (url) => {
                if (this.state.reply) {
                    BackEntry.leaveAll();
                    this.state.reply = null;
                }
                this.navigate(url);
            });
        } catch (e) {
            console.warn("chat mailbox: open failed", e);
            this.state.error = t("chat.action_error");
        }
    }

    /** The account of the row whose reply composer is open. */
    replySource(): ChatSource | undefined {
        return this.state.reply ? this.sourceOf(this.state.reply.configId) : undefined;
    }

    /** « Répondre » on an item that offers it: its composer opens, in place of another one (whose draft stays). */
    onReply(row: MailboxRow): void {
        if (!row.canReply || !this.sourceOf(row.configId)) return;
        this.state.reply = row;
    }

    /** The reply is queued: the composer closes, the list shows it waiting under its item. */
    async onReplyDone(): Promise<void> {
        this.state.reply = null;
        await this.loadCache();
    }

    /** ✕ or Android's back on the composer: it closes, its draft kept. */
    onReplyCancel(): void {
        this.state.reply = null;
    }

    /**
     * « Recevoir mes notifications dans Odoo »: online only. Done, the type
     * is stored and the notice goes; "offline" or "refused" is kept for the
     * notice to say so.
     */
    async onSwitch(configId: string): Promise<void> {
        const src = this.sourceOf(configId);
        if (!src || this.state.networkOff || this.state.switching[configId]) return;
        this.state.error = "";
        delete this.state.answers[configId];
        this.state.switching[configId] = true;
        try {
            const answer = await this.chatService.switchToInbox(src);
            if (answer !== "done") this.state.answers[configId] = answer;
        } catch (e) {
            console.warn("chat mailbox: switch failed", e);
            this.state.error = t("chat.action_error");
        } finally {
            this.state.switching[configId] = false;
        }
        await this.loadCache();
    }

    /** « Ouvrir mes préférences »: the user's own record of the account, in the web view. */
    async onPreferences(configId: string): Promise<void> {
        const src = this.sourceOf(configId);
        if (!src) return;
        try {
            await this.chatService.openPreferences(src);
        } catch (e) {
            console.warn("chat mailbox: preferences failed", e);
            this.state.error = t("chat.action_error");
        }
    }

    /** « Marquer comme lu »: the item moves to the history at once. */
    async onMarkRead(row: MailboxRow): Promise<void> {
        const src = this.sourceOf(row.configId);
        if (!src) return;
        await this.act(() => this.chatService.markDone(src, [row.messageId]));
    }

    /** « Tout marquer comme lu » of an account: its items up to the newest shown. */
    async onMarkAll(configId: string): Promise<void> {
        const src = this.sourceOf(configId);
        if (!src) return;
        await this.act(() => this.chatService.markAllDone(src));
    }

    /** ☆: the message leaves the starred box at once. */
    async onUnstar(row: MailboxRow): Promise<void> {
        const src = this.sourceOf(row.configId);
        if (!src) return;
        await this.act(() => this.chatService.star(src, row.messageId, false, row.channelId));
    }

    private async act(run: () => Promise<void>): Promise<void> {
        this.state.error = "";
        try {
            await run();
        } catch (e) {
            console.warn("chat mailbox: action failed", e);
            this.state.error = t("chat.action_error");
        }
        await this.loadCache();
    }
}
