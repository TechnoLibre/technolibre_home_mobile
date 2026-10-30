import { onMounted, onWillUnmount, useState, xml } from "@odoo/owl";
import { App } from "@capacitor/app";
import { Camera, CameraResultType, CameraSource } from "@capacitor/camera";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { LocalNotifications } from "@capacitor/local-notifications";

import { EnhancedComponent } from "../../../js/enhancedComponent";
import { useFeatureSection } from "../../../utils/featureSection";
import { t } from "../../../i18n";
import type { PushHealth } from "../../../plugins/chatPushPlugin";
import {
    CLIMB_THRESHOLDS,
    chatSettings,
    type BrowserMode,
    type ClimbThreshold,
    type NotifyLevel,
} from "../../../services/chat/chatSettings";
import { parseNtfyLink } from "../../../services/chat/chatPushLink";
import { accountReason, reasonText } from "../../../services/chat/chatPushOpen";
import { type AccountCard, OptionsChatPushAccountComponent } from "./options_chat_push_account_component";

/** How often the status panel reads the native state while it is shown. */
export const STATUS_POLL_MS = 5000;

const LEVELS: NotifyLevel[] = [1, 2, 3, 4, 5];
const BROWSER_CHOICES: { value: BrowserMode; label: string }[] = [
    { value: "ring", label: "chat.push_browser_ring" },
    { value: "wait", label: "chat.push_browser_wait" },
    { value: "quiet", label: "chat.push_browser_quiet" },
];
const STATE_WORDS = new Set([
    "connected", "connecting", "polling", "error", "off", "ok", "waiting", "session_expired", "no_session",
]);

/**
 * Deletes a camera photo: the copy the camera plugin answers (in the
 * cache) and the original it keeps under the app's external Pictures
 * directory, which bears the same file name. A file already gone is no
 * failure.
 */
async function forgetPhoto(path: string): Promise<void> {
    const name = path.slice(path.lastIndexOf("/") + 1);
    const targets = [{ path }, ...(name ? [{ path: `Pictures/${name}`, directory: Directory.External }] : [])];
    for (const target of targets) {
        try {
            await Filesystem.deleteFile(target);
        } catch {
            // Already gone, or never there
        }
    }
}

const word = (state: string): string => t(STATE_WORDS.has(state) ? "chat.push_state_" + state : "chat.push_state_unknown");

/**
 * The closed-app notification settings of the chat: the level, with the
 * level native code applies when the battery made it climb; the climbing
 * switch and thresholds; the browser mode; the ntfy of each account
 * (scanned or pasted link, Odoo-side address) followed by its preferences
 * (OptionsChatPushAccountComponent); and a panel with the native state,
 * read every STATUS_POLL_MS while the section is open. Everything goes
 * through ChatPush; the ntfy token passes from the link to native code and
 * is never kept or logged here.
 */
export class OptionsChatNotificationsComponent extends EnhancedComponent {
    static components = { OptionsChatPushAccountComponent };

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
          <p t-if="effectiveLine()" class="options-sync__info" role="status" t-esc="effectiveLine()"/>
          <div t-if="state.exemptionRefused" class="chat-notifications__refused" role="alert">
            <p class="options-sync__info" t-esc="t('chat.push_exemption_refused')"/>
            <button type="button" class="chat-new__chip" t-on-click="onUseLevel3" t-esc="t('chat.push_use_level_3')"/>
          </div>
          <p t-if="state.permDenied" class="options-sync__info chat-notifications__alarm" role="alert" t-esc="t('chat.push_perm_denied')"/>
          <label class="options-sync__checkbox-label">
            <input type="checkbox" t-att-checked="state.climb.auto" t-on-change="onClimbAuto" />
            <t t-esc="t('chat.push_climb_auto')"/>
          </label>
          <label class="chat-notifications__label">
            <t t-esc="t('chat.push_climb_one')"/>
            <select class="chat-notifications__field" t-att-disabled="!state.climb.auto" t-on-change="onClimbOne">
              <option t-foreach="thresholds()" t-as="th" t-key="th.value" t-att-value="th.value"
                      t-att-selected="state.climb.oneBelow === th.value" t-esc="th.label"/>
            </select>
          </label>
          <label class="chat-notifications__label">
            <t t-esc="t('chat.push_climb_two')"/>
            <select class="chat-notifications__field" t-att-disabled="!state.climb.auto" t-on-change="onClimbTwo">
              <option t-foreach="thresholds()" t-as="th" t-key="th.value" t-att-value="th.value"
                      t-att-selected="state.climb.twoBelow === th.value" t-esc="th.label"/>
            </select>
          </label>
          <h4 t-esc="t('chat.push_browser')"/>
          <div class="chat-new__chips" role="radiogroup" t-att-aria-label="t('chat.push_browser')">
            <button t-foreach="browserChoices" t-as="b" t-key="b.value" type="button" class="chat-new__chip" role="radio"
                    t-att-aria-checked="state.browserMode === b.value ? 'true' : 'false'"
                    t-att-class="{'chat-new__chip--on': state.browserMode === b.value}"
                    t-att-disabled="state.busy" t-on-click="() => this.onBrowserMode(b.value)" t-esc="t(b.label)"/>
          </div>
          <label class="options-sync__checkbox-label">
            <input type="checkbox" t-att-checked="state.applyOthers" t-on-change="onApplyOthers" />
            <t t-esc="t('chat.push_apply_others')"/>
          </label>
          <section t-foreach="state.accounts" t-as="a" t-key="a.configId" class="chat-notifications__card">
            <h4 t-esc="a.label"/>
            <p class="options-sync__info" t-esc="t('chat.push_account_ntfy', { url: a.ntfyUrl || t('chat.push_ntfy_none') })"/>
            <p t-if="a.ntfyUrl" class="options-sync__info"
               t-esc="a.registeredAt ? t('chat.push_registered') : t('chat.push_not_registered')"/>
            <p t-if="a.ntfyUrl and a.registrationError" class="options-sync__info chat-notifications__alarm"
               t-esc="t(a.registrationError)"/>
            <p t-if="a.ntfyUrl" class="options-sync__info"
               t-esc="t(a.appPush ? 'chat.push_actions_full' : 'chat.push_actions_no_react')"/>
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
            <OptionsChatPushAccountComponent card="a" push="chatService.push" native="native" pushFlags="a.pushFlags"/>
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

    browserChoices = BROWSER_CHOICES;
    private destroyed = false;
    private timer: ReturnType<typeof setInterval> | null = null;
    /** Whether the battery exemption was requested from this screen, which alone lets a refusal show. */
    private exemptionAsked = false;
    private appState: Promise<{ remove: () => Promise<void> }> | undefined;

    setup() {
        const settings = chatSettings();
        this.state = useState({
            expanded: false,
            available: true,
            realtime: false,
            level: settings.notifyLevel as NotifyLevel,
            climb: { auto: settings.climbAuto, oneBelow: settings.climbOneBelow, twoBelow: settings.climbTwoBelow },
            browserMode: settings.browserMode,
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
        // The exemption dialog is the system's: its answer is read when the app comes back
        this.appState = App.addListener("appStateChange", ({ isActive }) => (isActive ? this.refreshExemption() : undefined));
        onWillUnmount(() => {
            this.destroyed = true;
            this.stopPolling();
            void Promise.resolve(this.appState).then((h) => h?.remove()).catch(() => {});
        });
    }

    get native() {
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
        const settings = chatSettings();
        this.state.level = settings.notifyLevel;
        this.state.climb = { auto: settings.climbAuto, oneBelow: settings.climbOneBelow, twoBelow: settings.climbTwoBelow };
        this.state.browserMode = settings.browserMode;
        await this.loadAccounts();
        await this.refreshExemption();
        await this.refreshStatus();
    }

    /**
     * Whether to say the exemption is refused: a level 1 or 2 chosen on a
     * realtime build, the exemption requested from this screen, and
     * Android not exempting the app now. Read on mount and each time the
     * app comes back to the front; an unreadable state changes nothing.
     */
    async refreshExemption(): Promise<void> {
        const native = this.native;
        if (!native) return;
        if (!this.exemptionAsked || this.state.level > 2 || !this.state.realtime) {
            this.state.exemptionRefused = false;
            return;
        }
        try {
            const exempt = (await native.batteryExempt()).exempt;
            if (!this.destroyed) this.state.exemptionRefused = !exempt;
        } catch (e) {
            console.warn("chat notifications: exemption unreadable", e instanceof Error ? e.message : String(e));
        }
    }

    /** The cards, rebuilt from the sources and their push rows; a card keeps what is being typed. */
    private async loadAccounts(): Promise<void> {
        try {
            const [sources, rows] = await Promise.all([this.chatService.sources({ online: false }), this.chatService.repo.pushRows()]);
            const features = await Promise.all(sources.map((s) => this.chatService.features(s.configId)));
            const browserMode = chatSettings().browserMode;
            if (this.destroyed) return;
            const before = new Map<string, AccountCard>(this.state.accounts.map((a: AccountCard) => [a.configId, a]));
            this.state.accounts = sources.map((s, i) => {
                const r = rows.find((x) => x.configId === s.configId);
                const old = before.get(s.configId);
                return {
                    configId: s.configId,
                    label: s.label,
                    ntfyUrl: r?.ntfyUrl ?? null,
                    odooUrl: r?.odooNtfyUrl ?? "",
                    lockScreen: r?.lockScreen ?? "hidden_locked",
                    registeredAt: r?.registeredAt ?? null,
                    registrationError: this.chatService.push.registrationError(s.configId),
                    appPush: features[i].appPush,
                    pushFlags: features[i].pushFlags,
                    filter: r?.filter ?? "all",
                    inboxNotify: r?.inboxNotify ?? true,
                    inboxMentions: r?.inboxMentions ?? false,
                    quietOn: r?.quietOn ?? false,
                    quietFrom: r?.quietFrom ?? 1320,
                    quietTo: r?.quietTo ?? 420,
                    browserMode,
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
     * also request the battery exemption from the system dialog when the
     * app lacks it, and keep the level whatever the answer. The answer is
     * read when the app resumes (refreshExemption), which then says what a
     * refusal costs and offers level 3.
     */
    async onLevel(level: NotifyLevel): Promise<void> {
        const native = this.native;
        if (!native || this.state.busy) return;
        this.state.busy = true;
        this.state.message = "";
        this.state.exemptionRefused = false;
        try {
            this.state.permDenied = level <= 4 ? !(await this.ensurePermission()) : false;
            if (level <= 2 && !(await native.batteryExempt()).exempt) {
                this.exemptionAsked = true;
                await native.requestBatteryExemption();
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

    /**
     * Reads a QR code from a photo (the camera's) and applies the link it
     * carries. The photo holds the token: it goes once read, whatever the
     * answer (forgetPhoto).
     */
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
        } finally {
            await forgetPhoto(path);
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

    /** The thresholds offered for climbing, 0 worded « none ». */
    thresholds(): { value: ClimbThreshold; label: string }[] {
        return CLIMB_THRESHOLDS.map((v) => ({ value: v, label: v === 0 ? t("chat.push_climb_none") : `${v} %` }));
    }

    private async saveClimb(climb: { auto: boolean; oneBelow: ClimbThreshold; twoBelow: ClimbThreshold }): Promise<void> {
        this.state.message = "";
        try {
            await this.chatService.push.setClimb(climb);
            this.state.climb = climb;
        } catch (e) {
            this.fail(e);
        }
    }

    async onClimbAuto(ev: { target: any }): Promise<void> {
        await this.saveClimb({ ...this.state.climb, auto: !!ev.target.checked });
    }

    /** A value outside CLIMB_THRESHOLDS changes nothing. */
    private thresholdOf(ev: { target: any }): ClimbThreshold | null {
        const v = Number(ev.target.value);
        return CLIMB_THRESHOLDS.includes(v as ClimbThreshold) ? (v as ClimbThreshold) : null;
    }

    async onClimbOne(ev: { target: any }): Promise<void> {
        const v = this.thresholdOf(ev);
        if (v !== null) await this.saveClimb({ ...this.state.climb, oneBelow: v });
    }

    async onClimbTwo(ev: { target: any }): Promise<void> {
        const v = this.thresholdOf(ev);
        if (v !== null) await this.saveClimb({ ...this.state.climb, twoBelow: v });
    }

    /**
     * Saves the browser mode; ChatPush marks every account's device again.
     * The cards then follow the mode the settings hold, whose marks still
     * owed each card shows, even when native code refused the mirror.
     */
    async onBrowserMode(mode: BrowserMode): Promise<void> {
        if (this.state.busy) return;
        this.state.busy = true;
        this.state.message = "";
        try {
            await this.chatService.push.setBrowserMode(mode);
        } catch (e) {
            this.fail(e);
        } finally {
            this.state.busy = false;
        }
        this.state.browserMode = chatSettings().browserMode;
        await this.loadAccounts();
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

    /**
     * « En ce moment : niveau N (why) » while native code applies a level
     * the battery climbed to (climbReason); null otherwise, a build that
     * maps 1 and 2 to 3 included. A threshold reason names the threshold
     * as set.
     */
    effectiveLine(): string | null {
        const h: PushHealth | null = this.state.health;
        if (!h?.climbReason) return null;
        const why = h.climbReason === "saver"
            ? t("chat.push_effective_saver")
            : t("chat.push_effective_below", { pct: String(h.climbReason === "below_two" ? this.state.climb.twoBelow : this.state.climb.oneBelow) });
        return t("chat.push_effective", { level: String(h.effectiveLevel), why });
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
            lines.push(reasoned(t("chat.push_status_account", { server: labelOf(a.configId), state: word(a.state) }), accountReason(a) ?? (failing ? a.state : null), failing));
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
