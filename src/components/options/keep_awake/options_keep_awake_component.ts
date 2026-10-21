import { onMounted, onWillUnmount, useState, xml } from "@odoo/owl";
import type { EventBus } from "@odoo/owl";
import { EnhancedComponent } from "../../../js/enhancedComponent";
import { Events } from "../../../constants/events";
import { KeepAwakePlugin } from "../../../plugins/keepAwakePlugin";
import { useFeatureSection } from "../../../utils/featureSection";
import {
    applyDeckSleepChange,
    deckSleepEffects,
    storedWakeOnKeyPress,
} from "../../../services/deckSleepCoupling";
import { loadDeckPowerOptions } from "../../../services/streamDeckPowerOptions";

const STORAGE_KEY = "options.keepAwake.enabled";

/**
 * Single-toggle option: prevent the phone from going to sleep. Backed
 * by FLAG_KEEP_SCREEN_ON on the activity window — Android keeps the
 * screen on while the flag is set, and by extension the USB host
 * remains at full power so connected Stream Decks don't dim with the
 * screen timeout.
 *
 * The toggle persists in localStorage so the preference survives an
 * app restart; on mount we re-apply the saved value.
 */
export class OptionsKeepAwakeComponent extends EnhancedComponent {
    static template = xml`
        <li id="keep-awake" class="options-list__item">
          <div
              class="options-camera-stream__header"
              role="button"
              tabindex="0"
              t-att-aria-expanded="state.expanded ? 'true' : 'false'"
              t-on-click="toggle"
              t-on-keydown="onHeaderKey">
            <span t-esc="t('section.sleep')"/>
            <span t-esc="state.expanded ? '▲' : '▼'"/>
          </div>
          <div t-if="state.expanded" class="options-camera-stream__body">
            <div class="options-camera-stream__setting">
              <label class="options-camera-stream__checkbox-label">
                <input type="checkbox"
                       t-att-checked="state.enabled"
                       t-on-change="onToggle" />
                <t t-esc="t('sleep.screen_on')"/>
              </label>
              <p class="options-camera-stream__setting-hint"
                 t-esc="t('sleep.screen_on_hint')"/>
            </div>
            <div class="options-camera-stream__setting">
              <label class="options-camera-stream__checkbox-label">
                <input type="checkbox"
                       t-att-checked="state.deckEnabled"
                       t-on-change="onToggleDeck" />
                <t t-esc="t('sleep.deck_awake')"/>
              </label>
              <p class="options-camera-stream__setting-hint"
                 t-esc="t('sleep.deck_awake_hint')"/>
              <p t-if="state.notice"
                 class="options-camera-stream__setting-hint"
                 t-esc="state.notice"/>
            </div>
            <t t-if="state.error">
              <p class="options-camera-stream__error" t-esc="state.error" />
            </t>
          </div>
        </li>
    `;

    state = useState({
        expanded: false,
        enabled: false,
        // "Keep the Stream Deck lit during sleep", i.e. wake-on-key-press;
        // stored apart from the screen-on flag above.
        deckEnabled: false,
        // Line saying why the Stream Deck keepAwake option was turned on.
        notice: "",
        error: "",
    });

    private _deckListener?: (e: any) => void;

    /** Undefined where the component runs without an Owl env (tests). */
    private get _bus(): EventBus | undefined {
        return this.env?.eventBus;
    }

    setup(): void {
        useFeatureSection("keep-awake", () => { this.state.expanded = true; });
        // Mirrors wake-on-key-press however it changes, including the
        // Stream Deck section turning it off along with keepAwake.
        this._deckListener = (e: any) => {
            this.state.deckEnabled = !!e?.detail?.enabled;
        };
        this._bus?.addEventListener(Events.STREAMDECK_KEEP_AWAKE, this._deckListener);
        onWillUnmount(() => {
            if (this._deckListener) {
                this._bus?.removeEventListener(
                    Events.STREAMDECK_KEEP_AWAKE, this._deckListener,
                );
            }
        });
        onMounted(async () => {
            try {
                const stored = localStorage.getItem(STORAGE_KEY);
                const want = stored === "true";
                this.state.enabled = want;
                if (want) {
                    // Re-apply on app start so the flag survives a reboot.
                    await KeepAwakePlugin.setEnabled({ enabled: true });
                }
                // Shown as stored; app boot (restoreDeckSleepAtBoot)
                // arms the plugin and keeps it coupled with keepAwake.
                this.state.deckEnabled = storedWakeOnKeyPress();
            } catch (e) {
                this.state.error = e instanceof Error ? e.message : String(e);
            }
        });
    }

    toggle(): void {
        this.state.expanded = !this.state.expanded;
    }

    onHeaderKey(ev: KeyboardEvent): void {
        if (ev.key === "Enter" || ev.key === " ") {
            ev.preventDefault();
            this.toggle();
        }
    }

    async onToggle(ev: Event): Promise<void> {
        const checked = (ev.target as HTMLInputElement).checked;
        this.state.error = "";
        try {
            const r = await KeepAwakePlugin.setEnabled({ enabled: checked });
            this.state.enabled = r.enabled;
            localStorage.setItem(STORAGE_KEY, r.enabled ? "true" : "false");
        } catch (e) {
            this.state.error = e instanceof Error ? e.message : String(e);
            this.state.enabled = !checked;
        }
    }

    /** Turning it on first turns on the Stream Deck keepAwake power
     *  option it depends on (deckSleepCoupling), and says so; when that
     *  option stays off, this one does too and the error says why. The
     *  checkbox is set back by hand: an unchanged state renders nothing. */
    async onToggleDeck(ev: Event): Promise<void> {
        const box = ev.target as HTMLInputElement;
        const checked = box.checked;
        this.state.error = "";
        this.state.notice = "";
        try {
            const power = await loadDeckPowerOptions();
            const r = await applyDeckSleepChange(
                { wakeOnKeyPress: this.state.deckEnabled, keepAwake: power.keepAwake },
                { setting: "wakeOnKeyPress", enabled: checked },
                deckSleepEffects(this._bus),
            );
            this.state.deckEnabled = r.settings.wakeOnKeyPress;
            if (r.notice) this.state.notice = this.t(r.notice);
            if (r.coupledError) this.state.error = r.coupledError;
        } catch (e) {
            this.state.error = e instanceof Error ? e.message : String(e);
            this.state.deckEnabled = !checked;
        }
        box.checked = this.state.deckEnabled;
    }
}
