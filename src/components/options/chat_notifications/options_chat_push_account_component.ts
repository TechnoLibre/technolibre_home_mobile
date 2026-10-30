import { useState, xml } from "@odoo/owl";

import { EnhancedComponent } from "../../../js/enhancedComponent";
import { t } from "../../../i18n";
import type { LockScreen, PhoneFilter } from "../../../models/chat";
import type { BrowserMode } from "../../../services/chat/chatSettings";

/**
 * One account as the notification options show it: its ntfy and
 * registration, its module level (appPush at 1.5, pushFlags at 1.6), the
 * phone-side preferences of its chat_push row, and the browser mode the
 * phone setting holds. paste and pasteOpen are the link being typed and
 * whether its field is open.
 */
export interface AccountCard {
    configId: string;
    label: string;
    ntfyUrl: string | null;
    odooUrl: string;
    lockScreen: LockScreen;
    registeredAt: string | null;
    /** The i18n key of why the last registration failed (ChatPush.registrationError), null for none. */
    registrationError: string | null;
    /** Whether the server module is at 1.5, which adds the 👍 action and the device mark. */
    appPush: boolean;
    /** Whether the server module is at 1.6, whose push flags the filter and the browser hold read. */
    pushFlags: boolean;
    filter: PhoneFilter;
    inboxNotify: boolean;
    inboxMentions: boolean;
    quietOn: boolean;
    /** Minutes from local midnight. */
    quietFrom: number;
    quietTo: number;
    browserMode: BrowserMode;
    paste: string;
    pasteOpen: boolean;
}

const LOCK_CHOICES: { value: LockScreen; label: string }[] = [
    { value: "hidden_locked", label: "chat.push_lock_hidden_locked" },
    { value: "never", label: "chat.push_lock_never" },
    { value: "always", label: "chat.push_lock_always" },
];
const FILTER_CHOICES: { value: PhoneFilter; label: string }[] = [
    { value: "all", label: "chat.push_filter_all" },
    { value: "mentions_dm", label: "chat.push_filter_mentions_dm" },
    { value: "none", label: "chat.push_filter_none" },
];

/** "HH:MM" of an <input type="time"> as minutes from midnight, null when empty or malformed. */
function minutesOf(value: string): number | null {
    const m = /^(\d{2}):(\d{2})/.exec(value);
    if (!m) return null;
    const minutes = Number(m[1]) * 60 + Number(m[2]);
    return minutes < 1440 && Number(m[2]) < 60 ? minutes : null;
}

/**
 * The preferences of one account in the notification options: lock
 * screen, chat filter, inbox switch and, while the inbox is off, the
 * record-mentions switch, quiet hours, and what the browser mode does on
 * this server given its module level. Each change goes through ChatPush
 * and is written on the card only once saved; without native code
 * (props.native null) nothing is saved, so nothing changes.
 */
export class OptionsChatPushAccountComponent extends EnhancedComponent {
    static props = { card: Object, push: Object, native: [Object, { value: null }], pushFlags: Boolean };

    static template = xml`
    <div class="chat-push-account">
      <div class="chat-notifications__lock" role="radiogroup" t-att-aria-label="t('chat.push_lock')">
        <span class="chat-notifications__label" t-esc="t('chat.push_lock')"/>
        <div class="chat-new__chips">
          <button t-foreach="lockChoices" t-as="c" t-key="c.value" type="button" class="chat-new__chip" role="radio"
                  t-att-aria-checked="props.card.lockScreen === c.value ? 'true' : 'false'"
                  t-att-class="{'chat-new__chip--on': props.card.lockScreen === c.value}"
                  t-on-click="() => this.onLockScreen(c.value)" t-esc="t(c.label)"/>
        </div>
      </div>
      <div role="radiogroup" t-att-aria-label="t('chat.push_filter')">
        <span class="chat-notifications__label" t-esc="t('chat.push_filter')"/>
        <div class="chat-new__chips">
          <button t-foreach="filterChoices" t-as="f" t-key="f.value" type="button" class="chat-new__chip" role="radio"
                  t-att-aria-checked="props.card.filter === f.value ? 'true' : 'false'"
                  t-att-class="{'chat-new__chip--on': props.card.filter === f.value}"
                  t-on-click="() => this.onFilter(f.value)" t-esc="t(f.label)"/>
        </div>
        <p t-if="!props.pushFlags" class="options-sync__info" t-esc="t('chat.push_filter_approx')"/>
      </div>
      <label class="options-sync__checkbox-label">
        <input type="checkbox" t-att-checked="props.card.inboxNotify" t-on-change="onInbox"/>
        <t t-esc="t('chat.push_inbox')"/>
      </label>
      <t t-if="!props.card.inboxNotify">
        <label class="options-sync__checkbox-label chat-push-account__sub">
          <input type="checkbox" t-att-checked="props.card.inboxMentions" t-on-change="onInboxMentions"/>
          <t t-esc="t('chat.push_inbox_mentions')"/>
        </label>
        <p t-if="!props.pushFlags" class="options-sync__info chat-push-account__sub" t-esc="t('chat.push_inbox_mentions_help')"/>
      </t>
      <label class="options-sync__checkbox-label">
        <input type="checkbox" t-att-checked="props.card.quietOn" t-on-change="onQuietOn"/>
        <t t-esc="t('chat.push_quiet')"/>
      </label>
      <t t-if="props.card.quietOn">
        <p class="options-sync__info chat-push-account__sub" t-esc="quietSpan()"/>
        <div class="chat-push-account__times chat-push-account__sub">
          <input type="time" class="chat-push-account__time" t-att-aria-label="t('chat.push_quiet_from')"
                 t-att-value="timeOf(props.card.quietFrom)" t-on-change="onQuietFrom"/>
          <input type="time" class="chat-push-account__time" t-att-aria-label="t('chat.push_quiet_to')"
                 t-att-value="timeOf(props.card.quietTo)" t-on-change="onQuietTo"/>
        </div>
      </t>
      <p t-foreach="browserLines()" t-as="line" t-key="line_index" class="options-sync__info" t-esc="line"/>
      <p t-if="state.message" class="options-sync__info" role="alert" t-esc="state.message"/>
    </div>
  `;

    lockChoices = LOCK_CHOICES;
    filterChoices = FILTER_CHOICES;

    setup() {
        this.state = useState({ message: "" });
    }

    private get card(): AccountCard {
        return this.props.card as AccountCard;
    }

    /** Minutes from midnight as the "HH:MM" an <input type="time"> takes. */
    timeOf(minutes: number): string {
        const pad = (n: number) => String(n).padStart(2, "0");
        return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
    }

    quietSpan(): string {
        return t("chat.push_quiet_span", { from: this.timeOf(this.card.quietFrom), to: this.timeOf(this.card.quietTo) });
    }

    /**
     * What the browser mode does on this server: the mode itself at 1.6;
     * at 1.5 « quiet » is Odoo's own, held until 30 min after the last
     * browser activity, and « wait » rings at once; without the module
     * every mode rings at once. Then « not applied yet » while the
     * device mark is owed (ChatPush.markOwed).
     */
    browserLines(): string[] {
        const mode = this.card.browserMode;
        const lines: string[] = [];
        if (this.props.pushFlags) lines.push(t("chat.push_browser_applies", { mode: t(`chat.push_browser_${mode}`) }));
        else if (this.card.appPush && mode === "quiet") lines.push(t("chat.push_browser_quiet_15"));
        else lines.push(t("chat.push_browser_applies", { mode: t("chat.push_browser_ring") }));
        if (this.props.push.markOwed(this.card.configId)) lines.push(t("chat.push_browser_owed"));
        return lines;
    }

    /** Runs a save; the card takes `after` once it succeeds, a failure is said. */
    private async save(run: () => Promise<void>, after: (card: AccountCard) => void): Promise<void> {
        if (!this.props.native) return;
        this.state.message = "";
        try {
            await run();
            after(this.card);
        } catch (e) {
            console.warn("chat notifications:", e instanceof Error ? e.message : String(e));
            this.state.message = t("chat.push_action_failed");
        }
    }

    async onLockScreen(mode: LockScreen): Promise<void> {
        await this.save(() => this.props.push.setLockScreen(this.card.configId, mode), (c) => { c.lockScreen = mode; });
    }

    private async saveFilter(filter: PhoneFilter, inbox: boolean, inboxMentions: boolean): Promise<void> {
        await this.save(
            () => this.props.push.setFilter(this.card.configId, filter, inbox, inboxMentions),
            (c) => {
                c.filter = filter;
                c.inboxNotify = inbox;
                c.inboxMentions = inboxMentions;
            },
        );
    }

    async onFilter(filter: PhoneFilter): Promise<void> {
        await this.saveFilter(filter, this.card.inboxNotify, this.card.inboxMentions);
    }

    async onInbox(ev: { target: any }): Promise<void> {
        await this.saveFilter(this.card.filter, !!ev.target.checked, this.card.inboxMentions);
    }

    async onInboxMentions(ev: { target: any }): Promise<void> {
        await this.saveFilter(this.card.filter, this.card.inboxNotify, !!ev.target.checked);
    }

    /** Saves the quiet hours; equal bounds while on are refused here, before ChatPush would. */
    private async saveQuiet(on: boolean, from: number, to: number): Promise<void> {
        if (on && from === to) {
            this.state.message = t("chat.push_quiet_equal");
            return;
        }
        await this.save(
            () => this.props.push.setQuietHours(this.card.configId, { on, from, to }),
            (c) => {
                c.quietOn = on;
                c.quietFrom = from;
                c.quietTo = to;
            },
        );
    }

    async onQuietOn(ev: { target: any }): Promise<void> {
        await this.saveQuiet(!!ev.target.checked, this.card.quietFrom, this.card.quietTo);
    }

    /** A cleared time field changes nothing. */
    async onQuietFrom(ev: { target: any }): Promise<void> {
        const from = minutesOf(String(ev.target.value ?? ""));
        if (from !== null) await this.saveQuiet(this.card.quietOn, from, this.card.quietTo);
    }

    async onQuietTo(ev: { target: any }): Promise<void> {
        const to = minutesOf(String(ev.target.value ?? ""));
        if (to !== null) await this.saveQuiet(this.card.quietOn, this.card.quietFrom, to);
    }
}
