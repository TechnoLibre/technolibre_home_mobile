import { onMounted, onWillUnmount, useState, xml } from "@odoo/owl";

import { EnhancedComponent } from "../../js/enhancedComponent";
import { HeadingComponent } from "../heading/heading_component";
import { Events } from "../../constants/events";
import { getCurrentLocale, t } from "../../i18n";
import { formatBytes } from "../../utils/formatBytes";
import { displayNameOf } from "../../services/chat/chatNames";
import { MUTE_CHOICES, muteText } from "../../services/chat/chatMute";
import { CHAT_JOIN } from "../../services/chat/chatOutbox";
import type { ChatSource } from "../../services/chat/chatSources";
import type { ChatChannel, ChatMember, ChatPartner } from "../../models/chat";
import { SEARCH_DEBOUNCE_MS } from "./chat_new_component";

export { MUTE_CHOICES };

/** Quiet period that folds a burst of CHAT_CHANGED into one refresh. */
const CHANGE_DEBOUNCE_MS = 150;

/**
 * Where the conversation stands with the server: known (""), still being
 * created ("pending") or joined ("joining"), a create a lost answer left
 * undecided ("ambiguous"), or one the server refused ("failed").
 */
type CreateState = "" | "pending" | "joining" | "ambiguous" | "failed";

interface InfoMember {
    partnerId: number;
    name: string;
    presence: "online" | "away" | "offline";
    isSelf: boolean;
    canRemove: boolean;
}

interface InfoState {
    found: boolean;
    title: string;
    channelType: string;
    memberCount: number;
    canRename: boolean;
    editName: boolean;
    nameValue: string;
    nameValid: boolean;
    showDescription: boolean;
    canEditDescription: boolean;
    descValue: string;
    descDirty: boolean;
    members: InfoMember[];
    canInvite: boolean;
    inviting: boolean;
    inviteQuery: string;
    inviteOffline: boolean;
    candidates: ChatPartner[];
    picked: ChatPartner[];
    canLeave: boolean;
    canHide: boolean;
    canMute: boolean;
    muted: boolean;
    muteLabel: string;
    globalMuteLabel: string;
    create: CreateState;
    /** The create can still be given up: blocked, refused, or waiting and not on the wire. */
    canCancelCreate: boolean;
    /** The conversation's files on the phone, as the user reads the size; "" until read. */
    spaceText: string;
    busy: boolean;
    error: string;
}

/**
 * The information screen of /chat/:source/:channelId/info: the name
 * (renamed as Odoo allows per type), the description, the members with
 * their presence, and the actions the conversation and the user's rights
 * offer: invite, remove (a system user on a server with module 1.1), mute,
 * leave or hide. A conversation still being created or joined shows that
 * state and is managed as one the user is a member of: what is changed
 * meanwhile is queued behind the create and moves to the server's id with
 * it. Its creator may rename it and change its description; a create not on
 * the wire, blocked or refused can be given up. It renders from the cache
 * and refreshes on CHAT_CHANGED; every service call that fails shows a
 * notice.
 */
export class ChatInfoComponent extends EnhancedComponent {
    state!: InfoState;

    static components = { HeadingComponent };

    static template = xml`
    <div id="chat-info">
      <HeadingComponent title="t('chat.info')"/>
      <p t-if="state.error" class="chat-info__error" role="alert" t-esc="state.error"/>
      <p t-if="!state.found" class="chat-info__missing" t-esc="t('chat.thread_missing')"/>
      <t t-if="state.found">
        <section class="chat-info__section">
          <h2 t-if="!state.editName" class="chat-info__name" t-esc="state.title"/>
          <button t-if="state.canRename and !state.editName" class="chat-info__btn" t-on-click="onEditName" t-esc="t('chat.info_edit')"/>
          <div t-if="state.editName" class="chat-info__edit">
            <input class="chat-info__input" type="text" t-att-aria-label="t('chat.info_name')"
                   t-att-value="state.nameValue" t-on-input="onNameInput"/>
            <button class="chat-info__btn" t-att-disabled="state.busy or !state.nameValid" t-on-click="onSaveName" t-esc="t('chat.info_save')"/>
            <button class="chat-info__btn" t-on-click="onCancelName" t-esc="t('chat.info_cancel')"/>
          </div>
        </section>

        <section t-if="state.create" class="chat-info__section chat-info__create" role="status">
          <p t-if="state.create === 'pending'" t-esc="t('chat.info_creating')"/>
          <p t-if="state.create === 'joining'" t-esc="t('chat.info_joining')"/>
          <p t-if="state.create === 'ambiguous'" t-esc="t('chat.info_ambiguous')"/>
          <p t-if="state.create === 'failed'" t-esc="t('chat.info_create_failed')"/>
          <button t-if="state.canCancelCreate" class="chat-info__btn chat-info__btn--danger"
                  t-att-disabled="state.busy" t-on-click="onCancelCreate" t-esc="t('chat.info_cancel_create')"/>
        </section>

        <section t-if="state.showDescription" class="chat-info__section">
          <h3 class="chat-info__title" t-esc="t('chat.info_description')"/>
          <t t-if="state.canEditDescription">
            <textarea class="chat-info__textarea" rows="3" t-att-value="state.descValue" t-on-input="onDescriptionInput"/>
            <button class="chat-info__btn" t-att-disabled="state.busy or !state.descDirty" t-on-click="onSaveDescription" t-esc="t('chat.info_save')"/>
          </t>
          <p t-else="" class="chat-info__text" t-esc="state.descValue"/>
        </section>

        <section class="chat-info__section">
          <h3 class="chat-info__title" t-esc="t('chat.info_members', {count: state.memberCount})"/>
          <ul class="chat-info__members">
            <li t-foreach="state.members" t-as="m" t-key="m.partnerId" class="chat-info__member">
              <span class="chat-info__presence" t-att-class="'chat-info__presence--' + m.presence"
                    t-att-title="t('chat.presence_' + m.presence)" t-att-aria-label="t('chat.presence_' + m.presence)"/>
              <span class="chat-info__member-name" t-esc="m.name"/>
              <span t-if="m.isSelf" class="chat-info__you" t-esc="t('chat.info_you')"/>
              <button t-if="m.canRemove" class="chat-info__btn chat-info__btn--danger"
                      t-on-click="() => this.onRemove(m)" t-esc="t('chat.info_remove')"/>
            </li>
          </ul>
          <button t-if="state.canInvite and !state.inviting" class="chat-info__btn" t-on-click="onInviteOpen" t-esc="t('chat.info_invite')"/>
          <div t-if="state.inviting" class="chat-info__invite">
            <input class="chat-info__input" type="search" t-att-placeholder="t('chat.new_search')"
                   t-att-value="state.inviteQuery" t-on-input="onInviteQuery"/>
            <p t-if="state.inviteOffline" class="chat-info__hint" t-esc="t('chat.info_invite_offline')"/>
            <ul class="chat-info__candidates">
              <li t-foreach="state.candidates" t-as="p" t-key="p.partnerId">
                <button class="chat-info__candidate" t-att-aria-pressed="isPicked(p) ? 'true' : 'false'"
                        t-att-class="{'chat-info__candidate--on': isPicked(p)}" t-on-click="() => this.onPick(p)" t-esc="p.name"/>
              </li>
            </ul>
            <p t-if="!state.inviteOffline and state.candidates.length === 0" class="chat-info__hint" t-esc="t('chat.info_invite_none')"/>
            <button class="chat-info__btn" t-att-disabled="state.busy or state.picked.length === 0" t-on-click="onInviteGo" t-esc="t('chat.info_invite_go')"/>
            <button class="chat-info__btn" t-on-click="onInviteClose" t-esc="t('chat.info_cancel')"/>
          </div>
        </section>

        <section t-if="state.globalMuteLabel" class="chat-info__section">
          <p class="chat-info__text" t-esc="state.globalMuteLabel"/>
        </section>
        <section t-if="state.canMute" class="chat-info__section">
          <h3 class="chat-info__title" t-esc="t('chat.info_mute')"/>
          <p class="chat-info__text" t-esc="state.muteLabel"/>
          <div class="chat-info__mutes">
            <button t-foreach="muteChoices" t-as="m" t-key="m.minutes" class="chat-info__btn"
                    t-att-disabled="state.busy" t-on-click="() => this.onMute(m.minutes)" t-esc="t(m.label)"/>
            <button t-if="state.muted" class="chat-info__btn" t-att-disabled="state.busy" t-on-click="onUnmute" t-esc="t('chat.info_unmute')"/>
          </div>
        </section>

        <section t-if="state.spaceText" class="chat-info__section">
          <p class="chat-info__text" t-esc="t('chat.info_space', {size: state.spaceText})"/>
          <button class="chat-info__btn" t-att-disabled="state.busy" t-on-click="onClearSpace" t-esc="t('chat.info_clear_space')"/>
        </section>

        <section t-if="state.canLeave or state.canHide" class="chat-info__section">
          <button t-if="state.canLeave" class="chat-info__btn chat-info__btn--danger" t-att-disabled="state.busy"
                  t-on-click="onLeave" t-esc="t('chat.info_leave')"/>
          <button t-if="state.canHide" class="chat-info__btn" t-att-disabled="state.busy"
                  t-on-click="onHide" t-esc="t('chat.info_hide')"/>
        </section>
      </t>
    </div>`;

    muteChoices = MUTE_CHOICES;

    private configId = "";
    private channelId = 0;
    private source: ChatSource | null = null;
    private destroyed = false;
    private _channel: ChatChannel | null = null;
    private _members: ChatMember[] = [];
    private _debounce: ReturnType<typeof setTimeout> | null = null;
    private _searchTimer: ReturnType<typeof setTimeout> | null = null;
    /** Bumped by every keystroke or close; a candidate search answered under an older value is dropped. */
    private _searchGen = 0;
    private _onChanged = (ev: Event) => {
        const d = (ev as CustomEvent).detail ?? {};
        if (d.configId !== this.configId) return;
        if (this._debounce !== null) clearTimeout(this._debounce);
        this._debounce = setTimeout(() => {
            this._debounce = null;
            void this.refresh();
        }, CHANGE_DEBOUNCE_MS);
    };

    setup() {
        this.state = useState<InfoState>({
            found: true,
            title: "",
            channelType: "",
            memberCount: 0,
            canRename: false,
            editName: false,
            nameValue: "",
            nameValid: true,
            showDescription: false,
            canEditDescription: false,
            descValue: "",
            descDirty: false,
            members: [],
            canInvite: false,
            inviting: false,
            inviteQuery: "",
            inviteOffline: false,
            candidates: [],
            picked: [],
            canLeave: false,
            canHide: false,
            canMute: false,
            muted: false,
            muteLabel: "",
            globalMuteLabel: "",
            create: "",
            canCancelCreate: false,
            spaceText: "",
            busy: false,
            error: "",
        });
        const params = this.router.getRouteParams(window.location.pathname, "/chat/:source/:channelId/info");
        this.configId = params.get("source") ?? "";
        this.channelId = Number(params.get("channelId"));
        onMounted(async () => {
            this.eventBus.addEventListener(Events.CHAT_CHANGED, this._onChanged);
            await this.open();
        });
        onWillUnmount(() => this.teardown());
    }

    teardown(): void {
        this.destroyed = true;
        this._searchGen++;
        this.eventBus.removeEventListener(Events.CHAT_CHANGED, this._onChanged);
        if (this._debounce !== null) clearTimeout(this._debounce);
        if (this._searchTimer !== null) clearTimeout(this._searchTimer);
    }

    /** Resolves the source, shows the cache, then reads the members the cache lacks. */
    async open(): Promise<void> {
        try {
            const sources = await this.chatService.sources({ online: false });
            this.source = sources.find((s) => s.configId === this.configId) ?? null;
            if (this.destroyed) return;
            await this.refresh();
            if (this.source && this.channelId > 0 && this.state.found) {
                await this.chatService.members(this.source, this.channelId);
                if (!this.destroyed) await this.refresh();
            }
        } catch (e) {
            this.fail(e);
        }
    }

    private fail(e: unknown): void {
        console.warn("chat info:", e);
        this.state.error = t("chat.action_error");
    }

    /** Rebuilds the view from the cache. */
    async refresh(): Promise<void> {
        try {
            await this.build();
        } catch (e) {
            this.fail(e);
        }
        await this.loadSpace();
    }

    /** Reads the conversation's files on the phone; a failed read hides the line and nothing else. */
    private async loadSpace(): Promise<void> {
        if (!this.state.found) return;
        try {
            const bytes = await this.chatService.attachments.space(this.configId, this.channelId);
            if (!this.destroyed) this.state.spaceText = formatBytes(bytes, getCurrentLocale());
        } catch (e) {
            console.warn("chat info: space unreadable", e);
            if (!this.destroyed) this.state.spaceText = "";
        }
    }

    /** After the user confirms, removes this conversation's downloaded files; unsent files stay. */
    async onClearSpace(): Promise<void> {
        if (!window.confirm(t("chat.info_clear_space_confirm"))) return;
        this.state.busy = true;
        try {
            await this.chatService.attachments.clear({ configId: this.configId, channelId: this.channelId });
        } catch (e) {
            this.fail(e);
        } finally {
            this.state.busy = false;
        }
        await this.loadSpace();
    }

    private async build(): Promise<void> {
        const repo = this.chatService.repo;
        let channel = await repo.channel(this.configId, this.channelId);
        if (!channel && this.channelId < 0) {
            const real = await this.chatService.realIdOf(this.configId, this.channelId);
            if (real !== null) {
                this.channelId = real;
                channel = await repo.channel(this.configId, real);
            }
        }
        if (this.destroyed) return;
        if (!channel) {
            this.state.found = false;
            return;
        }
        const [members, partners, st, features] = await Promise.all([
            repo.members(this.configId, this.channelId),
            repo.partners(this.configId),
            repo.sourceState(this.configId),
            this.chatService.features(this.configId),
        ]);
        const ops = channel.createOpId ? await this.databaseService.getOutboxOpsForConfig(this.configId) : [];
        if (this.destroyed) return;
        this._channel = channel;
        this._members = members;
        const names = new Map(partners.map((p) => [p.partnerId, p]));
        const self = st.selfPartnerId;
        const type = channel.channelType;
        const now = new Date();
        const op = channel.createOpId ? ops.find((o) => o.id === channel.createOpId) : undefined;
        const create = this.createState(channel, op);
        // A conversation on its way to the server is the user's already: its actions wait for the create
        const usable = channel.isMember && (create === "" || create === "pending" || create === "joining");
        // The server makes the creator of a group or channel able to edit it
        const editable = channel.isEditable === true || (channel.isEditable === null && create === "pending");
        const s = this.state;
        s.found = true;
        s.channelType = type;
        s.title = displayNameOf(channel, members, names, self, getCurrentLocale());
        s.memberCount = Math.max(channel.memberCount ?? 0, members.length);
        s.create = create;
        // Giving up is offered for a create no send may have reached the server with, and for a refused or ambiguous one; a sent create is left instead
        s.canCancelCreate =
            create === "ambiguous" ||
            create === "failed" ||
            (create === "pending" && !!op && op.status !== "running" && !op.params?.createSentAt);
        s.canRename = usable && (type === "chat" || editable);
        s.showDescription = type !== "chat" && (editable || !!channel.description);
        s.canEditDescription = usable && type !== "chat" && editable;
        if (!s.descDirty) s.descValue = channel.description || "";
        s.members = members.map((m) => ({
            partnerId: m.partnerId,
            name: names.get(m.partnerId)?.name || "?",
            presence: this.presenceOf(names.get(m.partnerId)?.imStatus),
            isSelf: m.partnerId === self,
            canRemove: create === "" && usable && features.canRemoveMembers && type !== "chat" && m.partnerId !== self,
        }));
        s.canInvite = usable;
        s.canLeave =
            usable &&
            (type === "channel" || type === "group") &&
            channel.needactionCounter === 0 &&
            !channel.groupBasedSubscription &&
            channel.parentChannelId === null;
        s.canHide = usable && type === "chat";
        const globalText = muteText(st.globalMuteUntil, now, t("chat.info_global_mute", { date: "{date}" }), t("chat.info_global_forever"));
        s.globalMuteLabel = usable ? (globalText ?? "") : "";
        s.canMute = usable && globalText === null;
        const own = muteText(channel.muteUntilDt, now, t("chat.info_muted_until", { date: "{date}" }), t("chat.info_muted_forever"));
        s.muted = own !== null;
        s.muteLabel = own ?? t("chat.info_not_muted");
    }

    private presenceOf(status: string | null | undefined): "online" | "away" | "offline" {
        return status === "online" ? "online" : status === "away" ? "away" : "offline";
    }

    private createState(
        channel: ChatChannel,
        op: { kind?: string; status?: string; params?: Record<string, any> } | undefined,
    ): CreateState {
        if (channel.createFailed) return "failed";
        if (!channel.createOpId) return "";
        if (op?.kind === CHAT_JOIN) return "joining";
        return op?.status === "blocked" && op.params?.blockedReason === "ambiguous" ? "ambiguous" : "pending";
    }

    /** Runs a service call under the busy flag; a failure shows the notice and returns false. */
    private async run(action: () => Promise<unknown>): Promise<boolean> {
        if (this.state.busy) return false;
        this.state.busy = true;
        this.state.error = "";
        try {
            await action();
            return true;
        } catch (e) {
            this.fail(e);
            return false;
        } finally {
            this.state.busy = false;
        }
    }

    // ─── Name and description ─────────────────────────────────────────────

    onEditName(): void {
        const ch = this._channel;
        if (!ch) return;
        this.state.nameValue = ch.channelType === "chat" ? (ch.customChannelName ?? "") : ch.name;
        this.state.nameValid = true;
        this.state.editName = true;
    }

    onNameInput(ev: Event): void {
        const value = (ev.target as HTMLInputElement).value;
        this.state.nameValue = value;
        // A channel is never renamed to nothing; a group may be, and a chat's own label too
        this.state.nameValid = this._channel?.channelType !== "channel" || value.trim() !== "";
    }

    onCancelName(): void {
        this.state.editName = false;
    }

    async onSaveName(): Promise<void> {
        if (!this.source || !this.state.nameValid) return;
        const name = this.state.nameValue.trim();
        const ok = await this.run(() => this.chatService.rename(this.source!, this.channelId, name));
        if (ok) this.state.editName = false;
        await this.refresh();
    }

    onDescriptionInput(ev: Event): void {
        this.state.descValue = (ev.target as HTMLTextAreaElement).value;
        this.state.descDirty = true;
    }

    async onSaveDescription(): Promise<void> {
        if (!this.source) return;
        const text = this.state.descValue.trim();
        const ok = await this.run(() => this.chatService.describe(this.source!, this.channelId, text));
        if (ok) this.state.descDirty = false;
        await this.refresh();
    }

    // ─── Members ──────────────────────────────────────────────────────────

    async onRemove(m: InfoMember): Promise<void> {
        if (!this.source || !window.confirm(t("chat.info_remove_confirm", { name: m.name }))) return;
        await this.run(() => this.chatService.removeMember(this.source!, this.channelId, m.partnerId));
        await this.refresh();
    }

    isPicked(p: ChatPartner): boolean {
        return this.state.picked.some((x) => x.partnerId === p.partnerId);
    }

    async onInviteOpen(): Promise<void> {
        this.state.inviting = true;
        this.state.inviteQuery = "";
        this.state.picked = [];
        this.state.error = "";
        await this.searchCandidates("");
    }

    onInviteClose(): void {
        this._searchGen++;
        this.state.inviting = false;
        this.state.picked = [];
        this.state.candidates = [];
    }

    onInviteQuery(ev: Event): void {
        const term = (ev.target as HTMLInputElement).value;
        this.state.inviteQuery = term;
        const gen = ++this._searchGen;
        if (this._searchTimer !== null) clearTimeout(this._searchTimer);
        this._searchTimer = setTimeout(() => {
            this._searchTimer = null;
            if (gen === this._searchGen) void this.searchCandidates(term);
        }, SEARCH_DEBOUNCE_MS);
    }

    /**
     * People who can be added: the server's candidates for a group or a
     * channel (it knows the access group); a chat takes anybody, as it
     * becomes a group with its correspondent. Members are left out; an answer
     * for an older term is dropped.
     */
    private async searchCandidates(term: string): Promise<void> {
        const src = this.source;
        const ch = this._channel;
        if (!src || !ch) return;
        const gen = ++this._searchGen;
        const clean = term.trim();
        try {
            let partners: ChatPartner[];
            let offline = false;
            if (ch.channelType === "chat") {
                partners = clean
                    ? await this.chatService.people.searchPeople(src, clean)
                    : await this.chatService.people.recentPeople(src.configId);
            } else {
                const r = await this.chatService.people.inviteCandidates(src, this.channelId, clean);
                partners = r.partners;
                offline = r.offline;
            }
            if (gen !== this._searchGen) return;
            const taken = new Set(this._members.map((m) => m.partnerId));
            if (ch.correspondentPartnerId != null) taken.add(ch.correspondentPartnerId);
            this.state.candidates = partners.filter((p) => !taken.has(p.partnerId));
            this.state.inviteOffline = offline;
        } catch (e) {
            if (gen === this._searchGen) this.fail(e);
        }
    }

    onPick(p: ChatPartner): void {
        this.state.picked = this.isPicked(p)
            ? this.state.picked.filter((x) => x.partnerId !== p.partnerId)
            : [...this.state.picked, p];
    }

    /** Invites the people picked; a chat becomes a group, which opens. */
    async onInviteGo(): Promise<void> {
        const src = this.source;
        const ids = this.state.picked.map((p) => p.partnerId);
        if (!src || ids.length === 0) return;
        let result: { configId: string; channelId: number } | null = null;
        const ok = await this.run(async () => {
            result = await this.chatService.invite(src, this.channelId, ids);
        });
        if (!ok) return;
        const made = result as { configId: string; channelId: number } | null;
        if (made && (made.channelId !== this.channelId || made.configId !== this.configId)) {
            this.navigate("/chat/" + encodeURIComponent(made.configId) + "/" + made.channelId);
            return;
        }
        this.onInviteClose();
        await this.refresh();
    }

    // ─── Mute, leave, hide ────────────────────────────────────────────────

    async onMute(minutes: number): Promise<void> {
        if (!this.source) return;
        await this.run(() => this.chatService.mute(this.source!, this.channelId, minutes));
        await this.refresh();
    }

    async onUnmute(): Promise<void> {
        if (!this.source) return;
        await this.run(() => this.chatService.mute(this.source!, this.channelId, false));
        await this.refresh();
    }

    /** Leaves a group or channel after the user confirms, then goes back to the list. */
    async onLeave(): Promise<void> {
        const src = this.source;
        if (!src || !this._channel) return;
        const key = this._channel.channelType === "channel" ? "chat.leave_confirm_channel" : "chat.leave_confirm_group";
        if (!window.confirm(t(key, { name: this.state.title }))) return;
        if (await this.run(() => this.chatService.leave(src, this.channelId))) this.navigate("/chat");
    }

    /** Hides a direct message, asking nothing: its next message shows it again. */
    async onHide(): Promise<void> {
        const src = this.source;
        if (!src) return;
        if (await this.run(() => this.chatService.hide(src, this.channelId))) this.navigate("/chat");
    }

    /** Gives up a conversation whose creation waits, is blocked or refused, after the user confirms. */
    async onCancelCreate(): Promise<void> {
        if (!window.confirm(t("chat.cancel_create_confirm"))) return;
        if (await this.run(() => this.chatService.discardCreate(this.configId, this.channelId))) this.navigate("/chat");
    }
}
