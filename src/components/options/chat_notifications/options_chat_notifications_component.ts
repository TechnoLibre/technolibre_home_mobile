import { onMounted, onWillUnmount, useState, xml } from "@odoo/owl";
import { Camera, CameraResultType, CameraSource } from "@capacitor/camera";
import { Dialog } from "@capacitor/dialog";
import { LocalNotifications } from "@capacitor/local-notifications";

import { EnhancedComponent } from "../../../js/enhancedComponent";
import { useFeatureSection } from "../../../utils/featureSection";
import { t } from "../../../i18n";
import type { LockScreen } from "../../../models/chat";
import type { PushHealth } from "../../../plugins/chatPushPlugin";
import { chatSettings, type NotifyLevel } from "../../../services/chat/chatSettings";
import { parseNtfyLink } from "../../../services/chat/chatPushLink";
import { reasonText } from "../../../services/chat/chatPushOpen";

/** How often the status panel reads the native state while it is shown. */
export const STATUS_POLL_MS = 5000;

const LEVELS: NotifyLevel[] = [1, 2, 3, 4, 5];
const LOCK_CHOICES: { value: LockScreen; label: string }[] = [
    { value: "hidden_locked", label: "chat.push_lock_hidden_locked" },
    { value: "never", label: "chat.push_lock_never" },
    { value: "always", label: "chat.push_lock_always" },
];
const STATE_WORDS = new Set([
    "connected", "connecting", "polling", "error", "off", "ok", "waiting", "session_expired", "no_session",
]);

interface AccountCard {
    configId: string;
    label: string;
    ntfyUrl: string | null;
    odooUrl: string;
    lockScreen: LockScreen;
    registeredAt: string | null;
    /** The link typed or pasted, and whether its field is open. */
    paste: string;
    pasteOpen: boolean;
}

const word = (state: string): string => t(STATE_WORDS.has(state) ? "chat.push_state_" + state : "chat.push_state_unknown");

/**
 * The closed-app notification settings of the chat: the level, the ntfy of
 * each account (scanned or pasted link, Odoo-side address, lock screen),
 * and a panel with the native state, read every STATUS_POLL_MS while the
 * section is open. Everything goes through ChatPush; the ntfy token passes
 * from the link to native code and is never kept or logged here.
 */
export class OptionsChatNotificationsComponent extends EnhancedComponent {
    static template = xml`
    <li id="chat-notifications" class="options-list__item options-sync">
      <div
        class="options-sync__header"
        role="button"
        tabindex="0"
        t-att-aria-expanded="state.expanded ? 'true' : 'false'"
        aria-controls="options-chat-notifications__body"
        t-on-click="toggleExpanded"
        t-on-keydown="(ev) => (ev.key === 'Enter' || ev.key === ' ') ? toggleExpanded() : null"
      >
        <span t-esc="t('chat.push_title')"/>
        <span aria-hidden="true" t-esc="state.expanded ? '▲' : '▼'" />
      </div>
      <div t-if="state.expanded" id="options-chat-notifications__body" class="options-sync__body">
        <p t-if="!state.available" class="options-sync__info" t-esc="t('chat.push_unavailable')"/>
        <t t-else="">
          <h4 t-esc="t('chat.push_level')"/>
          <div class="chat-notifications__levels" role="radiogroup" t-att-aria-label="t('chat.push_level')">
            <button t-foreach="levels()" t-as="l" t-key="l.value" type="button" class="chat-notifications__level"
                    role="radio" t-att-aria-checked="state.level === l.value ? 'true' : 'false'"
                    t-att-class="{'chat-notifications__level--on': state.level === l.value}"
                    t-att-disabled="state.busy" t-on-click="() => this.onLevel(l.value)">
              <span class="chat-notifications__level-name" t-esc="t(l.label)"/>
              <span class="chat-notifications__level-desc" t-esc="t(l.description)"/>
            </button>
          </div>
          <div t-if="state.exemptionRefused" class="chat-notifications__refused" role="alert">
            <p class="options-sync__info" t-esc="t('chat.push_exemption_refused')"/>
            <button type="button" class="chat-new__chip" t-on-click="onUseLevel3" t-esc="t('chat.push_use_level_3')"/>
          </div>
          <p t-if="state.permDenied" class="options-sync__info chat-notifications__alarm" role="alert" t-esc="t('chat.push_perm_denied')"/>
          <label class="options-sync__checkbox-label">
            <input type="checkbox" t-att-checked="state.applyOthers" t-on-change="onApplyOthers" />
            <t t-esc="t('chat.push_apply_others')"/>
          </label>
          <section t-foreach="state.accounts" t-as="a" t-key="a.configId" class="chat-notifications__card">
            <h4 t-esc="a.label"/>
            <p class="options-sync__info">
              <t t-esc="t('chat.push_account_ntfy')"/> : <t t-esc="a.ntfyUrl || t('chat.push_ntfy_none')"/>
            </p>
            <p t-if="a.ntfyUrl" class="options-sync__info"
               t-esc="a.registeredAt ? t('chat.push_registered') : t('chat.push_not_registered')"/>
            <div class="chat-new__chips">
              <button type="button" class="chat-new__chip" t-att-disabled="state.busy"
                      t-on-click="() => this.onScan(a.configId)" t-esc="t('chat.push_scan')"/>
              <button type="button" class="chat-new__chip" t-att-disabled="state.busy"
                      t-on-click="() => this.onTogglePaste(a.configId)" t-esc="t('chat.push_paste')"/>
              <button t-if="a.ntfyUrl" type="button" class="chat-new__chip" t-att-disabled="state.busy"
                      t-on-click="() => this.onRemove(a.configId)" t-esc="t('chat.push_remove')"/>
            </div>
            <div t-if="a.pasteOpen" class="chat-notifications__paste">
              <input type="text" class="chat-notifications__field" autocomplete="off" autocapitalize="off" spellcheck="false"
                     t-att-placeholder="t('chat.push_paste_placeholder')" t-att-value="a.paste"
                     t-on-input="(ev) => this.onPasteInput(a.configId, ev)"/>
              <button type="button" class="chat-new__chip" t-att-disabled="state.busy or !a.paste"
                      t-on-click="() => this.onPasteApply(a.configId)" t-esc="t('chat.push_apply')"/>
            </div>
            <label t-if="a.ntfyUrl" class="chat-notifications__label">
              <t t-esc="t('chat.push_odoo_url')"/>
              <input type="url" class="chat-notifications__field" autocomplete="off" autocapitalize="off" spellcheck="false"
                     t-att-value="a.odooUrl" t-on-change="(ev) => this.onOdooUrl(a.configId, ev)"/>
            </label>
            <div class="chat-notifications__lock" role="radiogroup" t-att-aria-label="t('chat.push_lock')">
              <span class="chat-notifications__label" t-esc="t('chat.push_lock')"/>
              <div class="chat-new__chips">
                <button t-foreach="lockChoices" t-as="c" t-key="c.value" type="button" class="chat-new__chip" role="radio"
                        t-att-aria-checked="a.lockScreen === c.value ? 'true' : 'false'"
                        t-att-class="{'chat-new__chip--on': a.lockScreen === c.value}"
                        t-att-disabled="state.busy" t-on-click="() => this.onLockScreen(a.configId, c.value)" t-esc="t(c.label)"/>
              </div>
            </div>
          </section>
          <p t-if="state.message" class="options-sync__info" role="alert" t-esc="state.message"/>
          <h4 t-esc="t('chat.push_status')"/>
          <ul class="chat-notifications__status" role="status">
            <li t-foreach="statusLines()" t-as="line" t-key="line_index" t-esc="line"/>
          </ul>
          <button type="button" class="chat-new__chip" t-att-disabled="state.busy" t-on-click="onCheckNow" t-esc="t('chat.push_check_now')"/>
        </t>
      </div>
    </li>
  `;

    lockChoices = LOCK_CHOICES;
    private destroyed = false;
    private timer: ReturnType<typeof setInterval> | null = null;

    setup() {
        this.state = useState({
            expanded: false,
            available: true,
            realtime: false,
            level: chatSettings().notifyLevel as NotifyLevel,
            accounts: [] as AccountCard[],
            applyOthers: true,
            busy: false,
            message: "",
            permDenied: false,
            exemptionRefused: false,
            health: null as PushHealth | null,
        });
        useFeatureSection("chat-notifications", () => {
            this.state.expanded = true;
            this.startPolling();
        });
        onMounted(() => void this.load());
        onWillUnmount(() => {
            this.destroyed = true;
            this.stopPolling();
        });
    }

    private get native() {
        return this.chatService.push.native;
    }

    toggleExpanded(): void {
        this.state.expanded = !this.state.expanded;
        if (this.state.expanded) this.startPolling();
        else this.stopPolling();
    }

    /** The levels offered: 1 and 2 only on a build with the permanent service. */
    levels(): { value: NotifyLevel; label: string; description: string }[] {
        return LEVELS.filter((l) => l > 2 || this.state.realtime).map((l) => ({
            value: l,
            label: `chat.push_level_${l}`,
            description: `chat.push_level_${l}_desc`,
        }));
    }

    /** Reads what the section shows: the build's capability, the accounts with their ntfy, the native state. */
    async load(): Promise<void> {
        const native = this.native;
        if (!native) {
            this.state.available = false;
            return;
        }
        this.state.available = true;
        try {
            this.state.realtime = (await native.capabilities()).realtime;
        } catch (e) {
            console.warn("chat notifications: capabilities unreadable", e instanceof Error ? e.message : String(e));
            this.state.realtime = false;
        }
        this.state.level = chatSettings().notifyLevel;
        await this.loadAccounts();
        await this.refreshStatus();
    }

    /** The cards, rebuilt from the sources and their push rows; a card keeps what is being typed. */
    private async loadAccounts(): Promise<void> {
        try {
            const [sources, rows] = await Promise.all([this.chatService.sources({ online: false }), this.chatService.repo.pushRows()]);
            if (this.destroyed) return;
            const before = new Map<string, AccountCard>(this.state.accounts.map((a: AccountCard) => [a.configId, a]));
            this.state.accounts = sources.map((s) => {
                const r = rows.find((x) => x.configId === s.configId);
                const old = before.get(s.configId);
                return {
                    configId: s.configId,
                    label: s.label,
                    ntfyUrl: r?.ntfyUrl ?? null,
                    odooUrl: r?.odooNtfyUrl ?? "",
                    lockScreen: r?.lockScreen ?? "hidden_locked",
                    registeredAt: r?.registeredAt ?? null,
                    paste: old?.paste ?? "",
                    pasteOpen: old?.pasteOpen ?? false,
                };
            });
        } catch (e) {
            console.warn("chat notifications: accounts unreadable", e instanceof Error ? e.message : String(e));
        }
    }

    private card(configId: string): AccountCard | undefined {
        return this.state.accounts.find((a: AccountCard) => a.configId === configId);
    }

    /**
     * Allowed when the system says so, asked once if it still can be.
     * Answers whether notifications may show; a failure of the plugin
     * counts as allowed, the native state tells the truth.
     */
    private async ensurePermission(): Promise<boolean> {
        try {
            const { display } = await LocalNotifications.checkPermissions();
            let shown = display;
            if (display === "prompt" || display === "prompt-with-rationale") shown = (await LocalNotifications.requestPermissions()).display;
            return shown === "granted";
        } catch {
            return true;
        }
    }

    /**
     * Chooses a level. Levels 1 to 4 ask for the notification right; 1 and 2
     * also for the battery exemption, and keep the level whatever the answer,
     * saying what the refusal costs and offering level 3.
     */
    async onLevel(level: NotifyLevel): Promise<void> {
        const native = this.native;
        if (!native || this.state.busy) return;
        this.state.busy = true;
        this.state.message = "";
        this.state.exemptionRefused = false;
        try {
            this.state.permDenied = level <= 4 ? !(await this.ensurePermission()) : false;
            if (level <= 2) {
                let exempt = (await native.batteryExempt()).exempt;
                if (!exempt) {
                    const { value } = await Dialog.confirm({ title: t("chat.push_title"), message: t("chat.push_exemption_ask") });
                    if (value) await native.requestBatteryExemption();
                    exempt = (await native.batteryExempt()).exempt;
                }
                this.state.exemptionRefused = !exempt;
            }
            await this.chatService.push.setLevel(level);
            this.state.level = level;
        } catch (e) {
            this.fail(e);
        } finally {
            this.state.busy = false;
        }
        await this.refreshStatus();
    }

    async onUseLevel3(): Promise<void> {
        this.state.exemptionRefused = false;
        await this.onLevel(3);
    }

    onApplyOthers(ev: { target: any }): void {
        this.state.applyOthers = !!ev.target.checked;
    }

    onTogglePaste(configId: string): void {
        const card = this.card(configId);
        if (card) card.pasteOpen = !card.pasteOpen;
    }

    onPasteInput(configId: string, ev: { target: any }): void {
        const card = this.card(configId);
        if (card) card.paste = String(ev.target.value ?? "");
    }

    /** Applies the link typed in the account's field. */
    async onPasteApply(configId: string): Promise<void> {
        const card = this.card(configId);
        if (!card) return;
        await this.applyText(configId, card.paste);
    }

    /** Reads a QR code from a photo (the camera's) and applies the link it carries. */
    async onScan(configId: string): Promise<void> {
        const native = this.native;
        if (!native || this.state.busy) return;
        let path: string | undefined;
        try {
            const photo = await Camera.getPhoto({ quality: 90, allowEditing: false, resultType: CameraResultType.Uri, source: CameraSource.Camera });
            path = photo.path;
        } catch {
            // The user cancelled the camera: nothing to do
            return;
        }
        if (!path) return;
        let text: string | null;
        try {
            text = (await native.decodeQr({ path })).text;
        } catch (e) {
            this.fail(e);
            return;
        }
        if (text === null) {
            this.state.message = t("chat.push_qr_none");
            return;
        }
        await this.applyText(configId, text);
    }

    /**
     * Parses a link and applies it to the account, and to the accounts
     * without an ntfy when « Appliquer aussi aux comptes sans ntfy » is
     * checked. An invalid link changes nothing.
     */
    private async applyText(configId: string, text: string): Promise<void> {
        if (this.state.busy) return;
        const link = parseNtfyLink(text);
        if (!link) {
            this.state.message = t("chat.push_link_bad");
            return;
        }
        this.state.busy = true;
        this.state.message = "";
        try {
            const others = this.state.applyOthers
                ? this.state.accounts.filter((a: AccountCard) => a.configId !== configId && !a.ntfyUrl).map((a: AccountCard) => a.configId)
                : [];
            this.state.permDenied = !(await this.ensurePermission());
            const answer = await this.chatService.push.applyLink([configId, ...others], link);
            if (answer.ok) {
                this.state.message = t("chat.push_applied");
                const card = this.card(configId);
                if (card) {
                    card.paste = "";
                    card.pasteOpen = false;
                }
            } else {
                this.state.message = t("chat.push_apply_failed", { reason: reasonText(answer.reason) });
            }
        } catch (e) {
            this.fail(e);
        } finally {
            this.state.busy = false;
        }
        await this.loadAccounts();
        await this.refreshStatus();
    }

    async onRemove(configId: string): Promise<void> {
        if (this.state.busy) return;
        this.state.busy = true;
        this.state.message = "";
        try {
            await this.chatService.push.removeNtfy(configId);
        } catch (e) {
            this.fail(e);
        } finally {
            this.state.busy = false;
        }
        await this.loadAccounts();
        await this.refreshStatus();
    }

    /** Saves the address of ntfy as Odoo reaches it; blank means the phone's own. */
    async onOdooUrl(configId: string, ev: { target: any }): Promise<void> {
        const value = String(ev.target.value ?? "");
        this.state.message = "";
        try {
            await this.chatService.push.setOdooUrl(configId, value);
        } catch (e) {
            const bad = e instanceof Error && e.message.includes("http(s)");
            if (bad) this.state.message = t("chat.push_odoo_url_bad");
            else this.fail(e);
        }
        await this.loadAccounts();
    }

    async onLockScreen(configId: string, mode: LockScreen): Promise<void> {
        this.state.message = "";
        try {
            await this.chatService.push.setLockScreen(configId, mode);
            const card = this.card(configId);
            if (card) card.lockScreen = mode;
        } catch (e) {
            this.fail(e);
        }
    }

    async onCheckNow(): Promise<void> {
        const native = this.native;
        if (!native || this.state.busy) return;
        this.state.busy = true;
        try {
            await native.checkNow();
        } catch (e) {
            this.fail(e);
        } finally {
            this.state.busy = false;
        }
        await this.refreshStatus();
    }

    /** Reads the native state into the panel; a failed read leaves the last one. */
    async refreshStatus(): Promise<void> {
        const native = this.native;
        if (!native) return;
        try {
            const health = await native.status();
            if (!this.destroyed) this.state.health = health;
        } catch (e) {
            console.warn("chat notifications: status unreadable", e instanceof Error ? e.message : String(e));
        }
    }

    /** Reads the state now, then every STATUS_POLL_MS until stopPolling; once. */
    startPolling(): void {
        if (this.timer !== null || !this.native) return;
        void this.refreshStatus();
        this.timer = setInterval(() => void this.refreshStatus(), STATUS_POLL_MS);
    }

    stopPolling(): void {
        if (this.timer === null) return;
        clearInterval(this.timer);
        this.timer = null;
    }

    /** The panel's lines: each ntfy and each account with its state and reason in words, then the counters of lost messages. */
    statusLines(): string[] {
        const h: PushHealth | null = this.state.health;
        if (!h) return [t("chat.push_status_none")];
        const labelOf = (configId: string): string => this.card(configId)?.label ?? configId.split("|")[0];
        const lines: string[] = [];
        const reasoned = (base: string, reason: string | null, failing: boolean): string =>
            failing || reason ? `${base} — ${reasonText(reason ?? "unreachable")}` : base;
        for (const n of h.ntfys) {
            lines.push(reasoned(t("chat.push_status_ntfy", { url: n.url, state: word(n.state) }), n.reason, n.state === "error"));
        }
        for (const a of h.accounts) {
            const failing = a.state === "error" || a.state === "session_expired" || a.state === "no_session";
            lines.push(reasoned(t("chat.push_status_account", { server: labelOf(a.configId), state: word(a.state) }), a.reason ?? (failing ? a.state : null), failing));
        }
        if (h.faults > 0) lines.push(t("chat.push_status_faults", { n: String(h.faults) }));
        if (h.undecryptable > 0) lines.push(t("chat.push_status_undecryptable", { n: String(h.undecryptable) }));
        return lines;
    }

    private fail(e: unknown): void {
        console.warn("chat notifications:", e instanceof Error ? e.message : String(e));
        this.state.message = t("chat.push_action_failed");
    }
}
