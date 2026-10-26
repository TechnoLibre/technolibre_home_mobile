import { onMounted, onWillUnmount, useState, xml } from "@odoo/owl";

import { EnhancedComponent } from "../../../js/enhancedComponent";
import { useFeatureSection } from "../../../utils/featureSection";
import { Events } from "../../../constants/events";
import { getCurrentLocale, t } from "../../../i18n";
import { formatBytes } from "../../../utils/formatBytes";
import { MUTE_CHOICES, muteText } from "../../../services/chat/chatMute";
import { serverChoiceMode, type ChatSource, type ChoiceMode } from "../../../services/chat/chatSources";
import { chatSettings, setChatSettings, ChatSettings } from "../../../services/chat/chatSettings";

export class OptionsChatComponent extends EnhancedComponent {
    static template = xml`
    <li id="chat" class="options-list__item options-sync">
      <div
        class="options-sync__header"
        role="button"
        tabindex="0"
        t-att-aria-expanded="state.expanded ? 'true' : 'false'"
        aria-controls="options-chat__body"
        t-on-click="toggleExpanded"
        t-on-keydown="(ev) => (ev.key === 'Enter' || ev.key === ' ') ? toggleExpanded() : null"
      >
        <span t-esc="t('chat.options')"/>
        <span aria-hidden="true" t-esc="state.expanded ? '▲' : '▼'" />
      </div>
      <div t-if="state.expanded" id="options-chat__body" class="options-sync__body">
        <label class="options-sync__checkbox-label">
          <input type="checkbox" t-att-checked="state.settings.sendRead" t-on-change="(ev) => this.onToggle('sendRead', ev)" />
          <t t-esc="t('chat.send_read')"/>
        </label>
        <p class="options-sync__info" t-esc="t('chat.send_read_hint')" />
        <label class="options-sync__checkbox-label">
          <input type="checkbox" t-att-checked="state.settings.sendTyping" t-on-change="(ev) => this.onToggle('sendTyping', ev)" />
          <t t-esc="t('chat.send_typing')"/>
        </label>
        <p class="options-sync__info" t-esc="t('chat.send_typing_hint')" />
        <label class="options-sync__checkbox-label">
          <input type="checkbox" t-att-checked="state.settings.askCompress" t-on-change="(ev) => this.onToggle('askCompress', ev)" />
          <t t-esc="t('chat.ask_compress')"/>
        </label>
        <p class="options-sync__info" t-esc="t('chat.ask_compress_hint')" />
        <h4 t-esc="t('chat.attachment_files')"/>
        <p class="options-sync__info" t-esc="t('chat.cache_space', {size: state.spaceText})" />
        <button class="chat-new__chip" t-att-disabled="state.busy" t-on-click="onClearAll" t-esc="t('chat.cache_clear_all')"/>
        <label class="options-sync__checkbox-label">
          <input type="checkbox" t-att-checked="state.settings.cachePurge" t-on-change="(ev) => this.onToggle('cachePurge', ev)" />
          <t t-esc="t('chat.cache_purge')"/>
        </label>
        <p class="options-sync__info" t-esc="t('chat.cache_purge_hint')" />
        <label class="options-sync__checkbox-label">
          <t t-esc="t('chat.cache_limit')"/>
          <input type="number" min="1" step="1" inputmode="numeric" class="options-chat__limit"
                 t-att-value="state.settings.cacheLimitMb" t-on-change="onLimitChange" />
        </label>
        <p t-if="state.cacheWarn" class="options-sync__info" role="alert"
           t-esc="t('chat.cache_warning', {size: state.spaceText, limit: limitText()})" />
        <h4 t-esc="t('chat.global_mute')"/>
        <p t-if="state.mode === 'unavailable'" class="options-sync__info" t-esc="t('chat.unavailable')"/>
        <t t-else="">
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
          <p class="options-sync__info" t-esc="state.muteLabel"/>
          <div class="chat-new__chips">
            <button t-foreach="muteChoices" t-as="m" t-key="m.minutes" class="chat-new__chip"
                    t-att-disabled="state.busy" t-on-click="() => this.onMute(m.minutes)" t-esc="t(m.label)"/>
            <button t-if="state.muted" class="chat-new__chip" t-att-disabled="state.busy"
                    t-on-click="onUnmute" t-esc="t('chat.global_unmute')"/>
          </div>
          <p t-if="state.error" class="options-sync__info" role="alert" t-esc="state.error"/>
        </t>
      </div>
    </li>
  `;

    muteChoices = MUTE_CHOICES;
    private _sources: ChatSource[] = [];
    private destroyed = false;
    private _onChanged = (ev: Event) => {
        const d = (ev as CustomEvent).detail ?? {};
        if (d.configId === this.state.serverId) void this.refreshMute();
        void this.loadCache();
    };

    setup() {
        this.state = useState({
            expanded: false,
            settings: { ...chatSettings() },
            mode: "unavailable" as ChoiceMode,
            sources: [] as { configId: string; label: string }[],
            serverId: null as string | null,
            muted: false,
            muteLabel: "",
            busy: false,
            error: "",
            spaceText: formatBytes(0, getCurrentLocale()),
            cacheWarn: false,
        });
        useFeatureSection("chat", () => { this.state.expanded = true; });
        onMounted(async () => {
            this.eventBus.addEventListener(Events.CHAT_CHANGED, this._onChanged);
            await Promise.all([this.loadSources(), this.loadCache()]);
        });
        onWillUnmount(() => {
            this.destroyed = true;
            this.eventBus.removeEventListener(Events.CHAT_CHANGED, this._onChanged);
        });
    }

    /** Reads the cached sources and shows the global mute of the first one. */
    async loadSources(): Promise<void> {
        try {
            this._sources = await this.chatService.sources({ online: false });
        } catch (e) {
            this.fail(e);
            return;
        }
        if (this.destroyed) return;
        this.state.sources = this._sources.map((s) => ({ configId: s.configId, label: s.label }));
        this.state.mode = serverChoiceMode(this._sources.length);
        this.state.serverId = this._sources[0]?.configId ?? null;
        await this.refreshMute();
    }

    /** Shows the global mute state of the chosen server, as the cache holds it. */
    async refreshMute(): Promise<void> {
        const id = this.state.serverId;
        if (id === null) return;
        try {
            const st = await this.chatService.repo.sourceState(id);
            if (this.destroyed || id !== this.state.serverId) return;
            const text = muteText(st.globalMuteUntil, new Date(), t("chat.info_global_mute", { date: "{date}" }), t("chat.info_global_forever"));
            this.state.muted = text !== null;
            this.state.muteLabel = text ?? t("chat.global_not_muted");
        } catch (e) {
            this.fail(e);
        }
    }

    onServer(configId: string): void {
        this.state.serverId = configId;
        this.state.error = "";
        void this.refreshMute();
    }

    onServerChange(ev: { target: any }): void {
        this.onServer(ev.target.value);
    }

    /** Mutes the account of the chosen server for `minutes` (-1: until turned back on). */
    async onMute(minutes: number): Promise<void> {
        await this.setMute(minutes);
    }

    /** Turns the account's notifications back on. */
    async onUnmute(): Promise<void> {
        await this.setMute(false);
    }

    private async setMute(minutes: number | false): Promise<void> {
        const src = this._sources.find((s) => s.configId === this.state.serverId);
        if (!src) return;
        this.state.busy = true;
        this.state.error = "";
        try {
            await this.chatService.globalMute(src, minutes);
        } catch (e) {
            this.fail(e);
        } finally {
            this.state.busy = false;
        }
        await this.refreshMute();
    }

    private fail(e: unknown): void {
        console.warn("chat options:", e);
        this.state.error = t("chat.action_error");
    }

    /** Reads the chat's space on the phone and whether it nears the limit. */
    async loadCache(): Promise<void> {
        try {
            const cache = this.chatService.attachments;
            const [bytes, warn] = await Promise.all([cache.space(), cache.warning()]);
            if (this.destroyed) return;
            this.state.spaceText = formatBytes(bytes, getCurrentLocale());
            this.state.cacheWarn = warn;
        } catch (e) {
            console.warn("chat options: cache space unreadable", e);
        }
    }

    /** The limit as the user reads it, in the language's unit. */
    limitText(): string {
        return formatBytes(this.state.settings.cacheLimitMb * 1024 * 1024, getCurrentLocale());
    }

    /**
     * Saves the limit typed in MB when it is a number above 0; anything
     * else is refused and the input goes back to the limit in force.
     */
    async onLimitChange(ev: { target: any }): Promise<void> {
        const raw = String(ev.target.value ?? "").trim();
        const mb = raw === "" ? NaN : Number(raw);
        if (!Number.isFinite(mb) || mb <= 0) {
            ev.target.value = String(this.state.settings.cacheLimitMb);
            return;
        }
        setChatSettings({ ...chatSettings(), cacheLimitMb: mb });
        this.state.settings = { ...chatSettings() };
        await this.loadCache();
    }

    /** After the user confirms, removes the downloaded files of every conversation; unsent files stay. */
    async onClearAll(): Promise<void> {
        if (!window.confirm(t("chat.cache_clear_all_confirm"))) return;
        this.state.busy = true;
        try {
            await this.chatService.attachments.clear({});
        } catch (e) {
            this.fail(e);
        } finally {
            this.state.busy = false;
        }
        await this.loadCache();
    }

    /** Stores one setting, then shows what storage holds. */
    onToggle(key: keyof ChatSettings, ev: { target: any }) {
        setChatSettings({ ...chatSettings(), [key]: !!ev.target.checked });
        this.state.settings = { ...chatSettings() };
    }

    toggleExpanded() {
        this.state.expanded = !this.state.expanded;
    }
}
