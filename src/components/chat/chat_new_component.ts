import { onMounted, onWillUnmount, useState, xml } from "@odoo/owl";

import { EnhancedComponent } from "../../js/enhancedComponent";
import { HeadingComponent } from "../heading/heading_component";
import { t } from "../../i18n";
import { serverChoiceMode, type ChatSource, type ChoiceMode } from "../../services/chat/chatSources";
import type { AccessGroup, JoinableChannel } from "../../services/chat/chatPeople";
import type { ChatPartner } from "../../models/chat";

const FILTER_KEY = "chat.filter";
const SERVER_KEY = "chat.new.server";
/** Quiet period after the last keystroke before the server is asked. */
export const SEARCH_DEBOUNCE_MS = 300;
/** A group is a conversation of at least this many other people. */
const GROUP_MIN = 2;
/** The thread opens as soon as the conversation is queued; the flush runs behind it. */
const AT_ONCE = { background: true };

type NewView = "people" | "group" | "channel" | "join";

interface NewSource {
    configId: string;
    label: string;
}

interface ChatNewState {
    mode: ChoiceMode;
    sources: NewSource[];
    serverId: string | null;
    view: NewView;
    query: string;
    recent: ChatPartner[];
    results: ChatPartner[];
    picked: ChatPartner[];
    groupName: string;
    channelName: string;
    groups: AccessGroup[];
    groupId: number | false;
    joinable: JoinableChannel[];
    offline: boolean;
    busy: boolean;
    error: string;
    /** The screen could not read its sources; a retry is offered. */
    initFailed: boolean;
}

/**
 * The new conversation screen: a server, then people (recent ones, or the
 * server's search once a term is typed) to write to, a group to create, a
 * channel to create, or a public channel to join. Every action opens the
 * thread of the conversation once it is queued, without waiting for the
 * server: its id may still be temporary, and the thread moves to the
 * server's id when the create settles.
 */
export class ChatNewComponent extends EnhancedComponent {
    state!: ChatNewState;

    static components = { HeadingComponent };

    static template = xml`
    <div id="chat-new">
      <HeadingComponent title="t('chat.new')"/>
      <div t-if="state.mode === 'chips'" class="chat-new__chips" role="tablist">
        <button t-foreach="state.sources" t-as="s" t-key="s.configId" class="chat-new__chip" role="tab"
                t-att-aria-selected="state.serverId === s.configId ? 'true' : 'false'"
                t-att-class="{'chat-new__chip--on': state.serverId === s.configId}"
                t-on-click="() => this.onServer(s.configId)" t-esc="s.label"/>
      </div>
      <select t-if="state.mode === 'dropdown'" class="chat-new__select"
              t-att-aria-label="t('chat.server_filter')" t-on-change="onServerChange">
        <option t-foreach="state.sources" t-as="s" t-key="s.configId" t-att-value="s.configId"
                t-att-selected="state.serverId === s.configId" t-esc="s.label"/>
      </select>
      <nav class="chat-new__tabs">
        <button class="chat-new__tab" t-att-class="{'chat-new__tab--on': state.view === 'people'}"
                t-on-click="() => this.onView('people')" t-esc="t('chat.new_people')"/>
        <button class="chat-new__tab" t-att-class="{'chat-new__tab--on': state.view === 'group'}"
                t-on-click="() => this.onView('group')" t-esc="t('chat.new_group')"/>
        <button class="chat-new__tab" t-att-class="{'chat-new__tab--on': state.view === 'channel'}"
                t-on-click="() => this.onView('channel')" t-esc="t('chat.new_channel')"/>
        <button class="chat-new__tab" t-att-class="{'chat-new__tab--on': state.view === 'join'}"
                t-on-click="() => this.onView('join')" t-esc="t('chat.new_join')"/>
      </nav>
      <p t-if="state.error" class="chat-new__error" role="alert" t-esc="state.error"/>
      <button t-if="state.initFailed" class="chat-new__go" t-on-click="init" t-esc="t('chat.new_retry')"/>

      <t t-if="state.view === 'people' or state.view === 'group'">
        <input class="chat-new__search" type="search" t-att-placeholder="t('chat.new_search')"
               t-att-value="state.query" t-on-input="onQueryInput"/>
        <div t-if="state.view === 'group'" class="chat-new__group-form">
          <ul class="chat-new__picked">
            <li t-foreach="state.picked" t-as="p" t-key="p.partnerId" class="chat-new__picked-item">
              <span t-esc="p.name"/>
              <button class="chat-new__remove" t-att-aria-label="t('chat.new_remove')"
                      t-on-click="() => this.onUnpick(p)">✕</button>
            </li>
          </ul>
          <input class="chat-new__name" type="text" t-att-placeholder="t('chat.new_group_name')"
                 t-att-value="state.groupName" t-on-input="onGroupName"/>
          <button t-if="state.picked.length === 1" class="chat-new__go" t-att-disabled="state.busy"
                  t-on-click="onWriteToPicked" t-esc="t('chat.new_write_to', {name: state.picked[0].name})"/>
          <button t-if="state.picked.length !== 1" class="chat-new__go"
                  t-att-disabled="state.busy or !canCreateGroup()" t-on-click="onCreateGroup"
                  t-esc="t('chat.new_create_group')"/>
          <p t-if="state.picked.length === 0" class="chat-new__hint" t-esc="t('chat.new_group_hint')"/>
        </div>
        <h3 t-if="showRecent()" class="chat-new__title" t-esc="t('chat.new_recent')"/>
        <ul class="chat-new__people">
          <li t-foreach="shownPeople()" t-as="p" t-key="p.partnerId">
            <button class="chat-new__person" t-on-click="() => this.onPerson(p)">
              <span class="chat-new__avatar" aria-hidden="true" t-esc="initialOf(p)"/>
              <span class="chat-new__person-name" t-esc="p.name"/>
              <span class="chat-new__presence" t-att-class="'chat-new__presence--' + presenceOf(p)"
                    t-att-title="t('chat.presence_' + presenceOf(p))" t-att-aria-label="t('chat.presence_' + presenceOf(p))"/>
            </button>
          </li>
        </ul>
        <p t-if="shownPeople().length === 0" class="chat-new__empty" t-esc="t('chat.new_no_people')"/>
      </t>

      <div t-if="state.view === 'channel'" class="chat-new__channel-form">
        <input class="chat-new__name" type="text" t-att-placeholder="t('chat.new_channel_name')"
               t-att-value="state.channelName" t-on-input="onChannelName"/>
        <label class="chat-new__label" t-esc="t('chat.new_access')"/>
        <select class="chat-new__access" t-on-change="onAccessChange">
          <option t-foreach="state.groups" t-as="g" t-key="'' + g.id" t-att-value="'' + g.id"
                  t-att-selected="g.id === state.groupId" t-esc="g.fullName"/>
        </select>
        <button class="chat-new__go" t-att-disabled="state.busy or !canCreateChannel()"
                t-on-click="onCreateChannel" t-esc="t('chat.new_create_channel')"/>
      </div>

      <t t-if="state.view === 'join'">
        <p t-if="state.offline" class="chat-new__hint" t-esc="t('chat.new_join_offline')"/>
        <ul class="chat-new__channels">
          <li t-foreach="state.joinable" t-as="c" t-key="c.channelId">
            <button class="chat-new__channel" t-on-click="() => this.onJoin(c)">
              <span class="chat-new__channel-name" t-esc="'# ' + c.name"/>
              <span t-if="c.description" class="chat-new__channel-desc" t-esc="c.description"/>
            </button>
          </li>
        </ul>
        <p t-if="!state.offline and state.joinable.length === 0" class="chat-new__empty"
           t-esc="t('chat.new_no_channel')"/>
      </t>
    </div>`;

    private _timer: ReturnType<typeof setTimeout> | null = null;
    /** Bumped by every keystroke or server change; a search answered under an older value is dropped. */
    private _searchGen = 0;
    /** Bumped by every server change; a load answered under an older value is dropped. */
    private _loadGen = 0;
    private _sources: ChatSource[] = [];

    setup() {
        this.state = useState<ChatNewState>({
            mode: "none",
            sources: [],
            serverId: null,
            view: "people",
            query: "",
            recent: [],
            results: [],
            picked: [],
            groupName: "",
            channelName: "",
            groups: [],
            groupId: false,
            joinable: [],
            offline: false,
            busy: false,
            error: "",
            initFailed: false,
        });
        onMounted(() => this.init());
        onWillUnmount(() => {
            this._searchGen++;
            this._loadGen++;
            if (this._timer !== null) clearTimeout(this._timer);
        });
    }

    private read(key: string): string | null {
        try {
            return localStorage.getItem(key) || null;
        } catch {
            return null;
        }
    }

    private write(key: string, value: string): void {
        try {
            localStorage.setItem(key, value);
        } catch {
            // The choice lasts for this screen only
        }
    }

    /** Reads the sources from the cache and picks the server: the list's filter, else the last used here, else the first. */
    async init(): Promise<void> {
        this.state.initFailed = false;
        this.state.error = "";
        try {
            this._sources = await this.chatService.sources({ online: false });
        } catch (e) {
            this.fail(e);
            this.state.initFailed = true;
            return;
        }
        const ids = this._sources.map((s) => s.configId);
        const pick = [this.read(FILTER_KEY), this.read(SERVER_KEY)].find((id) => id !== null && ids.includes(id));
        this.state.sources = this._sources.map((s) => ({ configId: s.configId, label: s.label }));
        this.state.mode = serverChoiceMode(ids.length);
        this.state.serverId = pick ?? ids[0] ?? null;
        await this.loadServer();
    }

    private source(): ChatSource | null {
        return this._sources.find((s) => s.configId === this.state.serverId) ?? null;
    }

    private fail(e: unknown): void {
        console.warn("chat new:", e);
        this.state.error = t("chat.action_error");
    }

    /** Reloads what depends on the server: recent people, then the data of the current view. */
    private async loadServer(): Promise<void> {
        const src = this.source();
        const gen = ++this._loadGen;
        this._searchGen++;
        if (this._timer !== null) clearTimeout(this._timer);
        this._timer = null;
        this.state.error = "";
        this.state.results = [];
        this.state.picked = [];
        this.state.recent = [];
        this.state.groups = [];
        this.state.groupId = false;
        this.state.joinable = [];
        this.state.offline = false;
        if (!src) return;
        try {
            const recent = await this.chatService.people.recentPeople(src.configId);
            if (gen !== this._loadGen) return;
            this.state.recent = recent;
        } catch (e) {
            this.fail(e);
        }
        await this.loadView();
        if (this.state.query.trim()) await this.search(this.state.query);
    }

    /** Loads what the channel and join views need; the people views need nothing more. */
    private async loadView(): Promise<void> {
        const src = this.source();
        if (!src) return;
        const gen = this._loadGen;
        try {
            if (this.state.view === "channel") {
                // Kept across tab switches; a failed read is retried on the next visit
                if (this.state.groups.length > 0) return;
                const r = await this.chatService.people.accessGroups(src);
                if (gen !== this._loadGen) return;
                this.state.groups = r.groups;
                this.state.groupId = r.defaultId;
            } else if (this.state.view === "join") {
                const r = await this.chatService.people.joinableChannels(src);
                if (gen !== this._loadGen) return;
                this.state.joinable = r.channels;
                this.state.offline = r.offline;
            }
        } catch (e) {
            this.fail(e);
        }
    }

    async onServer(configId: string): Promise<void> {
        this.state.serverId = configId;
        this.write(SERVER_KEY, configId);
        await this.loadServer();
    }

    onServerChange(ev: Event): Promise<void> {
        return this.onServer((ev.target as HTMLSelectElement).value);
    }

    async onView(view: NewView): Promise<void> {
        this.state.view = view;
        this.state.error = "";
        await this.loadView();
    }

    onQueryInput(ev: Event): void {
        this.state.query = (ev.target as HTMLInputElement).value;
        const gen = ++this._searchGen;
        if (this._timer !== null) clearTimeout(this._timer);
        this._timer = null;
        if (!this.state.query.trim()) {
            this.state.results = [];
            return;
        }
        this._timer = setTimeout(() => {
            this._timer = null;
            if (gen === this._searchGen) this.search(this.state.query);
        }, SEARCH_DEBOUNCE_MS);
    }

    /** Asks the server for people matching `term`; an answer for a term typed over meanwhile is dropped. */
    async search(term: string): Promise<void> {
        const src = this.source();
        const clean = term.trim();
        if (!src || !clean) {
            this.state.results = [];
            return;
        }
        const gen = this._searchGen;
        try {
            const found = await this.chatService.people.searchPeople(src, clean);
            if (gen === this._searchGen) this.state.results = found;
        } catch (e) {
            if (gen === this._searchGen) this.fail(e);
        }
    }

    showRecent(): boolean {
        return !this.state.query.trim() && this.shownPeople().length > 0;
    }

    /** Recent people with no term, the search results otherwise; in a group, the people already picked are left out. */
    shownPeople(): ChatPartner[] {
        const list = this.state.query.trim() ? this.state.results : this.state.recent;
        if (this.state.view !== "group") return list;
        const taken = new Set(this.state.picked.map((p) => p.partnerId));
        return list.filter((p) => !taken.has(p.partnerId));
    }

    /** The presence of a person as the info screen shows it: online, away, else offline. */
    presenceOf(p: ChatPartner): "online" | "away" | "offline" {
        return p.imStatus === "online" ? "online" : p.imStatus === "away" ? "away" : "offline";
    }

    initialOf(p: ChatPartner): string {
        return (Array.from(p.name.trim())[0] ?? "?").toUpperCase();
    }

    canCreateGroup(): boolean {
        return new Set(this.state.picked.map((p) => p.partnerId)).size >= GROUP_MIN;
    }

    canCreateChannel(): boolean {
        // Without the groups read, the access would silently be "everyone"
        return this.state.channelName.trim() !== "" && this.state.groups.length > 0;
    }

    onPerson(p: ChatPartner): Promise<void> | void {
        if (this.state.view === "group") {
            if (this.state.picked.some((x) => x.partnerId === p.partnerId)) return;
            this.state.picked = [...this.state.picked, p];
            return;
        }
        return this.run((src) => this.chatService.startDirect(src, p.partnerId, AT_ONCE));
    }

    onUnpick(p: ChatPartner): void {
        this.state.picked = this.state.picked.filter((x) => x.partnerId !== p.partnerId);
    }

    /** One person picked is a direct message, not a group. */
    onWriteToPicked(): Promise<void> {
        const only = this.state.picked[0];
        return this.run((src) => this.chatService.startDirect(src, only.partnerId, AT_ONCE));
    }

    onGroupName(ev: Event): void {
        this.state.groupName = (ev.target as HTMLInputElement).value;
    }

    onCreateGroup(): Promise<void> | void {
        if (!this.canCreateGroup()) return;
        const ids = this.state.picked.map((p) => p.partnerId);
        const name = this.state.groupName.trim();
        return this.run((src) => this.chatService.createGroup(src, ids, name, AT_ONCE));
    }

    onChannelName(ev: Event): void {
        this.state.channelName = (ev.target as HTMLInputElement).value;
    }

    onAccessChange(ev: Event): void {
        const raw = (ev.target as HTMLSelectElement).value;
        this.state.groupId = raw === "false" ? false : Number(raw);
    }

    onCreateChannel(): Promise<void> | void {
        if (!this.canCreateChannel()) return;
        const name = this.state.channelName.trim();
        const groupId = this.state.groupId;
        return this.run((src) => this.chatService.createChannel(src, name, groupId, AT_ONCE));
    }

    onJoin(c: JoinableChannel): Promise<void> {
        return this.run((src) => this.chatService.join(src, c.channelId, c.name, AT_ONCE));
    }

    /** Runs an action on the chosen server, then opens the thread it returns; a failure to queue shows a notice and stays here. */
    private async run(
        action: (src: ChatSource) => Promise<{ configId: string; channelId: number }>,
    ): Promise<void> {
        const src = this.source();
        if (!src || this.state.busy) return;
        this.state.busy = true;
        this.state.error = "";
        try {
            const r = await action(src);
            this.navigate("/chat/" + encodeURIComponent(r.configId) + "/" + r.channelId);
        } catch (e) {
            this.fail(e);
        } finally {
            this.state.busy = false;
        }
    }
}
