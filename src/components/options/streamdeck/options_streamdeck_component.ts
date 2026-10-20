import { onMounted, onWillUnmount, useState, xml } from "@odoo/owl";
import type { EventBus } from "@odoo/owl";
import type { PluginListenerHandle } from "@capacitor/core";
import { EnhancedComponent } from "../../../js/enhancedComponent";
import {
    StreamDeckPlugin,
    DeckInfo,
    UsbDeviceDiag,
    describePermissionResponse,
} from "../../../plugins/streamDeckPlugin";
import {
    streamDeckEventLog,
    StreamDeckEventLogEntry,
} from "../../../services/streamDeckEventLog";
import {
    DECK_POWER_DEFAULTS,
    loadDeckPowerOptions,
    setDeckPowerOption,
} from "../../../services/streamDeckPowerOptions";
import type { DeckPowerOptions } from "../../../plugins/streamDeckPlugin";
import { useFeatureSection } from "../../../utils/featureSection";
import { Events } from "../../../constants/events";
import {
    applyDeckSleepChange,
    deckSleepEffects,
    storedWakeOnKeyPress,
} from "../../../services/deckSleepCoupling";

interface DeckRow {
    info: DeckInfo;
}

type EventLogEntry = StreamDeckEventLogEntry;

/**
 * Options panel that surfaces every connected Stream Deck the
 * StreamDeckPlugin has discovered, plus a rolling log of plugin
 * lifecycle events. Use it to confirm the USB OTG handshake works
 * and the right vendor/product ID is matched.
 */
export class OptionsStreamDeckComponent extends EnhancedComponent {
    static template = xml`
        <li id="streamdeck" class="options-list__item options-streamdeck">
          <div
              class="options-streamdeck__header"
              role="button"
              tabindex="0"
              t-att-aria-expanded="state.expanded ? 'true' : 'false'"
              t-on-click="toggle"
              t-on-keydown="onHeaderKey">
            <span t-esc="headerLabel()"/>
            <span t-esc="state.expanded ? '▲' : '▼'"/>
          </div>

          <div t-if="state.expanded" class="options-streamdeck__body">
            <div class="options-streamdeck__toolbar">
              <button class="options-streamdeck__refresh"
                      t-on-click="() => this.refresh()"
                      t-esc="t('streamdeck.refresh')"/>
              <button class="options-streamdeck__retry"
                      t-on-click="() => this.retryPermission()"
                      t-esc="t('streamdeck.request_permission')"/>
              <button class="options-streamdeck__refresh"
                      t-on-click="() => this.scanAllUsb()"
                      t-esc="t('streamdeck.scan_usb')"/>
              <button class="options-streamdeck__refresh"
                      t-att-class="{ 'options-streamdeck__debug--on': state.debugLogging }"
                      t-on-click="() => this.toggleDebugLogging()">
                <t t-if="state.debugLogging" t-esc="t('streamdeck.debug_on')"/>
                <t t-else="" t-esc="t('streamdeck.debug_off')"/>
              </button>
              <button class="options-streamdeck__refresh"
                      t-att-class="{ 'options-streamdeck__debug--on': state.readerMode !== 'userequest' }"
                      t-on-click="() => this.cycleReaderMode()"
                      t-esc="t('streamdeck.reader_mode', { mode: state.readerMode })"/>
              <button class="options-streamdeck__refresh"
                      t-on-click="() => this.restartSessions()"
                      t-esc="t('streamdeck.restart_sessions')"/>
              <button class="options-streamdeck__refresh"
                      t-att-class="{ 'options-streamdeck__debug--on': state.autoRefresh }"
                      t-on-click="() => this.toggleAutoRefresh()">
                <t t-if="state.autoRefresh" t-esc="t('streamdeck.auto_refresh_on')"/>
                <t t-else="" t-esc="t('streamdeck.auto_refresh_off')"/>
              </button>
            </div>

            <t t-if="state.error">
              <div class="options-streamdeck__error" t-esc="state.error" />
            </t>

            <div class="options-streamdeck__power">
              <div class="options-streamdeck__deck-params-header"
                   t-esc="t('streamdeck.power_title')" />
              <label class="options-streamdeck__checkbox-label">
                <input type="checkbox"
                       t-att-checked="state.power.showOverLockScreen"
                       t-on-change="(ev) => this.togglePowerOption('showOverLockScreen', ev.target.checked, ev.target)" />
                <t t-esc="t('streamdeck.power_show_over_lock_screen')" />
              </label>
              <p class="options-streamdeck__hint options-streamdeck__hint--inline"
                 t-esc="t('streamdeck.power_show_over_lock_screen_hint')" />
              <label class="options-streamdeck__checkbox-label">
                <input type="checkbox"
                       t-att-checked="state.power.keepAwake"
                       t-on-change="(ev) => this.togglePowerOption('keepAwake', ev.target.checked, ev.target)" />
                <t t-esc="t('streamdeck.power_keep_awake')" />
              </label>
              <p class="options-streamdeck__hint options-streamdeck__hint--inline"
                 t-esc="t('streamdeck.power_keep_awake_hint')" />
              <p t-if="state.powerNotice"
                 class="options-streamdeck__hint options-streamdeck__hint--inline"
                 t-esc="state.powerNotice" />
            </div>

            <t t-if="state.decks.length === 0">
              <p class="options-streamdeck__hint" t-esc="t('streamdeck.no_deck_hint')"/>
            </t>

            <t t-foreach="state.decks" t-as="row" t-key="row.info.deckId">
              <div class="options-streamdeck__deck options-streamdeck__deck--clickable"
                   role="button"
                   tabindex="0"
                   t-on-click="() => this.toggleDeckParams(row.info.deckId)"
                   t-on-keydown="(ev) => this.onDeckKey(ev, row.info.deckId)">
                <div class="options-streamdeck__deck-line">
                  <strong t-esc="row.info.model" />
                  <span class="options-streamdeck__deck-serial">
                    <t t-esc="t('streamdeck.deck_serial')"/> <code t-esc="row.info.deckId" />
                  </span>
                  <span class="options-streamdeck__deck-caret"
                        t-esc="state.expandedDeckId === row.info.deckId ? '▲' : '▼'" />
                </div>
                <div class="options-streamdeck__deck-line">
                  <span t-esc="t('streamdeck.deck_keys', { rows: row.info.rows, cols: row.info.cols, count: row.info.keyCount })"/>
                  <span t-esc="t('streamdeck.deck_key_image', { w: row.info.keyImage.w, h: row.info.keyImage.h, format: row.info.keyImage.format })"/>
                </div>
                <div class="options-streamdeck__deck-line">
                  <span t-esc="t('streamdeck.deck_product_id', { id: row.info.productId.toString(16) })"/>
                  <span t-esc="t('streamdeck.deck_firmware', { version: row.info.firmwareVersion })"/>
                </div>
                <div t-if="controlPipeNotice(row.info)" class="options-streamdeck__error"
                     t-esc="controlPipeNotice(row.info)"/>
                <t t-if="row.info.dialCount &gt; 0">
                  <div class="options-streamdeck__deck-line">
                    <span t-esc="t('streamdeck.deck_dials', { count: row.info.dialCount })"/>
                  </div>
                </t>
                <t t-if="row.info.lcd">
                  <div class="options-streamdeck__deck-line">
                    <span t-esc="t('streamdeck.deck_lcd', { w: row.info.lcd.w, h: row.info.lcd.h })"/>
                  </div>
                </t>
                <div class="options-streamdeck__deck-line">
                  <span t-esc="t('streamdeck.deck_capabilities', { list: row.info.capabilities.join(', ') })"/>
                </div>

                <!-- Parameter panel — clicking the deck row toggles it.
                     stop click propagation on inner controls so dragging
                     the slider or hitting a preset doesn't collapse the
                     panel back. -->
                <t t-if="state.expandedDeckId === row.info.deckId">
                  <div class="options-streamdeck__deck-params"
                       t-on-click.stop=""
                       t-on-keydown.stop="">
                    <div class="options-streamdeck__deck-params-header">
                      <t t-esc="t('streamdeck.brightness')"/> <strong t-esc="brightnessLabel(row.info.deckId)" />
                    </div>
                    <div class="options-streamdeck__deck-params-row">
                      <button class="options-streamdeck__refresh"
                              t-on-click="() => this.bumpBrightness(row.info.deckId, -10)">
                        −10
                      </button>
                      <input type="range" min="0" max="100" step="1"
                             class="options-streamdeck__brightness-slider"
                             t-att-value="state.brightness[row.info.deckId] ?? 50"
                             t-on-input="(ev) => this.onBrightnessSlider(ev, row.info.deckId)" />
                      <button class="options-streamdeck__refresh"
                              t-on-click="() => this.bumpBrightness(row.info.deckId, 10)">
                        +10
                      </button>
                    </div>
                    <div class="options-streamdeck__deck-params-row">
                      <t t-foreach="brightnessPresets" t-as="preset" t-key="preset">
                        <button class="options-streamdeck__refresh"
                                t-att-class="{ 'options-streamdeck__debug--on': (state.brightness[row.info.deckId] ?? 50) === preset }"
                                t-on-click="() => this.applyBrightness(row.info.deckId, preset)">
                          <t t-esc="preset" />%
                        </button>
                      </t>
                    </div>

                    <div class="options-streamdeck__deck-params-row">
                      <label class="options-streamdeck__checkbox-label">
                        <input type="checkbox"
                               t-att-checked="state.borderCompensation[row.info.deckId]"
                               t-on-change="(ev) => this.toggleBorderCompensation(row.info.deckId, ev.target.checked)" />
                        <t t-esc="t('streamdeck.border_compensation')"/>
                      </label>
                    </div>
                    <p class="options-streamdeck__hint options-streamdeck__hint--inline"
                       t-esc="t('streamdeck.border_compensation_hint')"/>

                    <t t-if="row.info.lcd">
                      <div class="options-streamdeck__deck-params-header"
                           t-esc="t('streamdeck.lcd_text')"/>
                      <div class="options-streamdeck__deck-params-row">
                        <input type="text"
                               class="options-streamdeck__lcd-text"
                               t-att-value="state.lcdText[row.info.deckId] ?? ''"
                               t-on-input="(ev) => this.onLcdTextInput(ev, row.info.deckId)"
                               t-att-placeholder="t('streamdeck.lcd_text_placeholder')" />
                      </div>

                      <div class="options-streamdeck__deck-params-header">
                        <t t-esc="t('streamdeck.lcd_font_size')"/> <strong t-esc="lcdFontSizeLabel(row.info.deckId)" />
                      </div>
                      <input type="range" min="12" max="96" step="2"
                             class="options-streamdeck__brightness-slider"
                             t-att-value="state.lcdFontSize[row.info.deckId] ?? 48"
                             t-on-input="(ev) => this.onLcdFontSizeInput(ev, row.info.deckId)" />

                      <div class="options-streamdeck__deck-params-header">
                        <t t-esc="t('streamdeck.lcd_scroll_speed')"/> <strong t-esc="lcdScrollSpeedLabel(row.info.deckId)" />
                      </div>
                      <p class="options-streamdeck__hint options-streamdeck__hint--inline"
                         t-esc="t('streamdeck.lcd_scroll_hint')"/>
                      <input type="range" min="0" max="20" step="1"
                             class="options-streamdeck__brightness-slider"
                             t-att-value="state.lcdScrollSpeed[row.info.deckId] ?? 2"
                             t-on-input="(ev) => this.onLcdScrollSpeedInput(ev, row.info.deckId)" />

                      <div class="options-streamdeck__deck-params-row">
                        <label class="options-streamdeck__lcd-color-label">
                          <t t-esc="t('streamdeck.lcd_color')"/>
                          <input type="color"
                                 class="options-streamdeck__lcd-color"
                                 t-att-value="state.lcdColor[row.info.deckId] ?? '#ffffff'"
                                 t-on-input="(ev) => this.onLcdColorInput(ev, row.info.deckId)" />
                        </label>
                      </div>
                    </t>

                    <t t-if="state.borderCompensation[row.info.deckId]">
                      <div class="options-streamdeck__deck-params-header">
                        <t t-esc="t('streamdeck.border_width')"/> <strong t-esc="borderSliderLabel(row.info.deckId, 'w')" />
                      </div>
                      <input type="range" min="0" max="90" step="1"
                             class="options-streamdeck__brightness-slider"
                             t-att-value="borderSliderValue(row.info.deckId, 'w')"
                             t-on-input="(ev) => this.onBorderRatioInput(ev, row.info.deckId, 'w')" />

                      <div class="options-streamdeck__deck-params-header">
                        <t t-esc="t('streamdeck.border_height')"/> <strong t-esc="borderSliderLabel(row.info.deckId, 'h')" />
                      </div>
                      <input type="range" min="0" max="90" step="1"
                             class="options-streamdeck__brightness-slider"
                             t-att-value="borderSliderValue(row.info.deckId, 'h')"
                             t-on-input="(ev) => this.onBorderRatioInput(ev, row.info.deckId, 'h')" />

                      <div class="options-streamdeck__deck-params-row">
                        <button class="options-streamdeck__refresh"
                                t-att-disabled="!state.borderHasOverride[row.info.deckId]"
                                t-on-click="() => this.resetBorderRatio(row.info.deckId)"
                                t-esc="t('streamdeck.border_reset')"/>
                      </div>
                    </t>
                  </div>
                </t>
              </div>
            </t>

            <t t-if="state.allUsb.length > 0">
              <div class="options-streamdeck__log">
                <div class="options-streamdeck__log-header"
                     t-esc="t('streamdeck.usb_header')"/>
                <t t-foreach="state.allUsb" t-as="dev" t-key="dev.deviceName">
                  <div class="options-streamdeck__deck">
                    <div class="options-streamdeck__deck-line">
                      <strong>
                        <t t-if="dev.knownStreamDeck">✅</t>
                        <t t-elif="dev.isElgato" t-esc="t('streamdeck.usb_elgato')"/>
                        <t t-else="">❓</t>
                        <t t-esc="dev.productName || t('streamdeck.usb_no_product_name')" />
                      </strong>
                      <span><t t-esc="dev.manufacturerName" /></span>
                    </div>
                    <div class="options-streamdeck__deck-line">
                      <span><t t-esc="t('streamdeck.usb_vendor')"/><code t-esc="dev.vendorIdHex" /></span>
                      <span><t t-esc="t('streamdeck.usb_product')"/><code t-esc="dev.productIdHex" /></span>
                    </div>
                    <div class="options-streamdeck__deck-line">
                      <span class="options-streamdeck__deck-serial" t-esc="dev.deviceName" />
                      <span t-if="dev.hasPermission" t-esc="t('streamdeck.usb_permission_ok')"/>
                      <span t-else="" t-esc="t('streamdeck.usb_permission_unknown')"/>
                    </div>
                    <div t-if="dev.isElgato and !dev.hasPermission" class="options-streamdeck__deck-line">
                      <button class="options-streamdeck__retry"
                              t-on-click="() => this.askPermissionForUsb(dev.deviceName)"
                              t-esc="t('streamdeck.usb_request_permission')"/>
                    </div>
                    <div t-if="dev.lastAttachError" class="options-streamdeck__error">
                      <t t-esc="t('streamdeck.usb_last_attach_error')"/> <code t-esc="dev.lastAttachError" />
                    </div>
                    <div t-if="dev.knownStreamDeck and dev.hasPermission and !dev.inSession" class="options-streamdeck__deck-line">
                      <span t-esc="t('streamdeck.usb_no_session')"/>
                    </div>
                  </div>
                </t>
              </div>
            </t>

            <div class="options-streamdeck__log">
              <div class="options-streamdeck__log-header">
                <span t-esc="t('streamdeck.log_title', { count: state.events.length })"/>
                <button class="options-streamdeck__refresh"
                        t-on-click="() => this.clearLog()"
                        t-esc="t('streamdeck.log_clear')"/>
              </div>
              <div class="options-streamdeck__log-scroll">
                <t t-if="state.events.length === 0">
                  <p class="options-streamdeck__hint" t-esc="t('streamdeck.log_empty')"/>
                </t>
                <t t-foreach="state.events" t-as="ev" t-key="ev_index">
                  <div class="options-streamdeck__log-row">
                    <span class="options-streamdeck__log-ts" t-esc="ev.ts" />
                    <span t-esc="ev.text" />
                  </div>
                </t>
              </div>
            </div>
          </div>
        </li>
    `;

    state = useState({
        expanded: false,
        decks: [] as DeckRow[],
        allUsb: [] as UsbDeviceDiag[],
        events: [] as EventLogEntry[],
        error: "",
        debugLogging: false,
        readerMode: "userequest" as "userequest" | "bulk" | "polled",
        autoRefresh: false,
        // Mirror of the two native power options; both off until
        // loadPowerOptions reads what the plugin stores.
        power: { ...DECK_POWER_DEFAULTS } as DeckPowerOptions,
        // Line saying why the Sleep section's deck-lit option was turned off.
        powerNotice: "",
        // Which deck row's parameter panel is open (deckId, "" = none).
        // Single-open at a time keeps the diagnostic panel scannable.
        expandedDeckId: "",
        // Per-deck brightness in percent. Stream Deck firmware doesn't
        // expose a getBrightness, so we keep our own state and default
        // to 50% (matches the firmware factory default).
        brightness: {} as Record<string, number>,
        // Per-deck "include bezel in camera stream" toggle. The actual
        // value lives on the camera streamer (singleton); this mirror
        // is only for the checkbox to render reactively.
        borderCompensation: {} as Record<string, boolean>,
        // Per-deck effective bezel ratio (override when set, else
        // per-model default). Mirrored from the streamer for slider
        // rendering. Cleared/refilled on every refresh.
        borderRatio: {} as Record<string, { w: number; h: number }>,
        borderHasOverride: {} as Record<string, boolean>,
        // Per-deck LCD text settings (only relevant on LCD-equipped
        // decks like Plus). Source of truth lives on the LCD text
        // renderer; these mirrors drive the inputs reactively.
        lcdText: {} as Record<string, string>,
        lcdFontSize: {} as Record<string, number>,
        lcdColor: {} as Record<string, string>,
        lcdScrollSpeed: {} as Record<string, number>,
    });

    // Exposed to the template so the t-foreach over presets stays a
    // simple identifier — Owl AOT precompile is happiest without
    // array literals in attribute values.
    brightnessPresets = [0, 25, 50, 75, 100];

    private _listeners: PluginListenerHandle[] = [];

    private _logUnsubscribe?: () => void;

    private _powerListener?: (e: any) => void;

    /** Undefined where the component runs without an Owl env (tests). */
    private get _bus(): EventBus | undefined {
        return this.env?.eventBus;
    }

    /** Auto-refresh tick. Re-runs `refresh()` on a 5 s cadence so the
     *  panel reflects deck (re)connects, USB device list, and last-
     *  attach errors without the user pressing the refresh button. Off by
     *  default — listDecks + listAllUsbDevices are not free, and the
     *  diagnostic UI is the only consumer that benefits from polling. */
    private _autoRefreshTimer?: ReturnType<typeof setInterval>;
    private static readonly AUTO_REFRESH_MS = 5000;

    setup(): void {
        // Pull existing entries from the singleton ring buffer first, then
        // subscribe so subsequent additions show up live. Both happen on
        // every (re)mount, so navigating away & back reveals the full log.
        this.state.events = streamDeckEventLog.getAll();
        this._logUnsubscribe = streamDeckEventLog.subscribe(() => {
            this.state.events = streamDeckEventLog.getAll();
        });
        useFeatureSection("streamdeck", () => { this.state.expanded = true; });
        // Mirrors the power options however they change, including the
        // Sleep section turning keepAwake on along with its deck-lit option.
        this._powerListener = (e: any) => {
            if (e?.detail) this.state.power = { ...e.detail };
        };
        this._bus?.addEventListener(Events.STREAMDECK_POWER_OPTIONS, this._powerListener);

        onMounted(async () => {
            await this.loadPowerOptions();
            await this.refresh();
            await this._wireListeners();
            try {
                const r = await StreamDeckPlugin.getReaderMode();
                this.state.readerMode = r.mode;
            } catch { /* ignore */ }
        });
        onWillUnmount(async () => {
            for (const h of this._listeners) {
                try { await h.remove(); } catch { /* ignore */ }
            }
            this._logUnsubscribe?.();
            this._stopAutoRefresh();
            if (this._powerListener) {
                this._bus?.removeEventListener(
                    Events.STREAMDECK_POWER_OPTIONS, this._powerListener,
                );
            }
        });
    }

    toggleAutoRefresh(): void {
        if (this.state.autoRefresh) {
            this._stopAutoRefresh();
            this.state.autoRefresh = false;
            this._log("auto-refresh → OFF");
        } else {
            this._startAutoRefresh();
            this.state.autoRefresh = true;
            this._log(`auto-refresh → ON (${OptionsStreamDeckComponent.AUTO_REFRESH_MS} ms)`);
        }
    }

    private _startAutoRefresh(): void {
        if (this._autoRefreshTimer) return;
        this._autoRefreshTimer = setInterval(() => {
            // Skip the tick if the panel is collapsed — the user can't
            // see the data anyway and listDecks/listAllUsb are not free
            // (each round-trips through JNI + USB enumeration).
            if (!this.state.expanded) return;
            this.refresh().catch((e) =>
                this._log(`auto-refresh ERROR: ${e instanceof Error ? e.message : e}`),
            );
        }, OptionsStreamDeckComponent.AUTO_REFRESH_MS);
    }

    private _stopAutoRefresh(): void {
        if (!this._autoRefreshTimer) return;
        clearInterval(this._autoRefreshTimer);
        this._autoRefreshTimer = undefined;
    }

    async loadPowerOptions(): Promise<void> {
        this.state.power = await loadDeckPowerOptions();
    }

    /** The checkbox shows what the plugin stored, so a refused change
     *  puts it back and says why. `input` is the checkbox itself: the
     *  state did not change, so no render would uncheck it. Turning
     *  keepAwake off also turns off the Sleep section's deck-lit option,
     *  which depends on it (deckSleepCoupling), and says so. */
    async togglePowerOption(
        name: keyof DeckPowerOptions,
        enabled: boolean,
        input?: { checked: boolean },
    ): Promise<void> {
        this.state.error = "";
        this.state.powerNotice = "";
        try {
            if (name === "keepAwake") {
                await this._toggleKeepAwake(enabled);
            } else {
                this.state.power = await setDeckPowerOption(name, enabled);
            }
            this._log(`power ${name} → ${this.state.power[name] ? "ON" : "OFF"}`);
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            this.state.error = msg;
            this._log(`setPowerOptions ERROR: ${msg}`);
        }
        if (input) input.checked = this.state.power[name];
    }

    private async _toggleKeepAwake(enabled: boolean): Promise<void> {
        const r = await applyDeckSleepChange(
            { wakeOnKeyPress: storedWakeOnKeyPress(), keepAwake: this.state.power.keepAwake },
            { setting: "keepAwake", enabled },
            deckSleepEffects(this._bus),
        );
        if (r.power) this.state.power = r.power;
        if (r.notice) {
            this.state.powerNotice = this.t(r.notice);
            this._log("wakeOnKeyPress → OFF (needs keepAwake)");
        }
        if (r.coupledError) this.state.error = r.coupledError;
    }

    toggle(): void { this.state.expanded = !this.state.expanded; }

    onHeaderKey(ev: KeyboardEvent): void {
        if (ev.key === "Enter" || ev.key === " ") {
            ev.preventDefault();
            this.toggle();
        }
    }

    async refresh(): Promise<void> {
        this.state.error = "";
        try {
            // First: ask the plugin to retry attach on any known deck that
            // has permission but no open session. Catches the case where the
            // boot-time attach failed silently (we missed the event).
            const retry = await StreamDeckPlugin.retryAttach();
            if (retry.retried > 0) {
                this._log(`retryAttach → ${retry.retried} device(s) re-attached`);
            }
            const r = await StreamDeckPlugin.listDecks();
            this.state.decks = r.decks.map((info) => ({ info }));
            this._log(`listDecks → ${r.decks.length} deck(s)`);
            // Mirror the streamer's per-deck border-compensation flags
            // so the checkbox reflects state correctly across re-mounts.
            this.syncBorderCompensationFromStreamer();
            // Always also refresh the all-USB scan so lastAttachError shows up.
            await this.scanAllUsb();
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            this.state.error = msg;
            this._log(`listDecks ERROR: ${msg}`);
        }
    }

    async toggleDebugLogging(): Promise<void> {
        const next = !this.state.debugLogging;
        try {
            const r = await StreamDeckPlugin.setDebugLogging({ enabled: next });
            this.state.debugLogging = r.enabled;
            this._log(`debug logging → ${r.enabled ? "ON" : "OFF"}`);
        } catch (e) {
            this._log(`setDebugLogging ERROR: ${e}`);
        }
    }

    async cycleReaderMode(): Promise<void> {
        // userequest → bulk → polled → userequest
        const cycle: ("userequest" | "bulk" | "polled")[] =
            ["userequest", "bulk", "polled"];
        const idx = cycle.indexOf(this.state.readerMode);
        const next = cycle[(idx + 1) % cycle.length];
        try {
            const r = await StreamDeckPlugin.setReaderMode({ mode: next });
            this.state.readerMode = r.mode;
            this._log(`reader mode → ${r.mode} (restart sessions to apply)`);
        } catch (e) {
            this._log(`setReaderMode ERROR: ${e}`);
        }
    }

    async restartSessions(): Promise<void> {
        try {
            const r = await StreamDeckPlugin.restartSessions();
            this._log(`restartSessions → ${r.restarted} deck(s) re-attached`);
            // listDecks lags briefly — refresh after a beat so the
            // panel shows the new sessions.
            setTimeout(() => this.refresh(), 500);
        } catch (e) {
            this._log(`restartSessions ERROR: ${e}`);
        }
    }

    async scanAllUsb(): Promise<void> {
        try {
            const r = await StreamDeckPlugin.listAllUsbDevices();
            this.state.allUsb = r.devices;
            this._log(
                `listAllUsbDevices → ${r.devices.length} device(s) ` +
                `(${r.devices.filter((d) => d.isElgato).length} Elgato, ` +
                `${r.devices.filter((d) => d.knownStreamDeck).length} known)`,
            );
            if (r.devices.length === 0) {
                this._log(this.t("streamdeck.log_no_usb_device"));
            }
        } catch (e) {
            this._log(`listAllUsbDevices ERROR: ${e}`);
        }
    }

    async askPermissionForUsb(deviceName: string): Promise<void> {
        // Log immediately so the user sees the click register even if the
        // OS dialog is slow to surface (multi-deck setups can take a few
        // hundred ms before the second prompt appears).
        this._log(`requestPermissionForUsb(${deviceName}) → asking…`);
        try {
            const r = await StreamDeckPlugin.requestPermissionForUsb({ deviceName });
            this._log(
                `requestPermissionForUsb(${deviceName}) → granted=${r.granted}` +
                (r.error ? ` error=${r.error}` : ""),
            );
            // Allow the OS dialog + onDeckAttached flow to settle, then
            // refresh both lists.
            setTimeout(async () => {
                await this.refresh();
                await this.scanAllUsb();
            }, 800);
        } catch (e) {
            this._log(`requestPermissionForUsb ERROR: ${e}`);
        }
    }

    toggleDeckParams(deckId: string): void {
        this.state.expandedDeckId = this.state.expandedDeckId === deckId ? "" : deckId;
    }

    onDeckKey(ev: KeyboardEvent, deckId: string): void {
        if (ev.key === "Enter" || ev.key === " ") {
            ev.preventDefault();
            this.toggleDeckParams(deckId);
        }
    }

    async applyBrightness(deckId: string, percent: number): Promise<void> {
        const clamped = Math.max(0, Math.min(100, Math.round(percent)));
        this.state.brightness[deckId] = clamped;
        // Route through the controller so the value is remembered for
        // the post-sleep restore path. Direct StreamDeckPlugin calls
        // bypass that cache and the value gets reset to the default
        // (50%) on the next visibility:visible event.
        const controller = (this.env as any).streamDeckController;
        try {
            await controller.setBrightness(deckId, clamped);
            this._log(`setBrightness(${deckId}) → ${clamped}%`);
        } catch (e) {
            this._log(`setBrightness(${deckId}) ERROR: ${e}`);
        }
    }

    bumpBrightness(deckId: string, delta: number): void {
        const current = this.state.brightness[deckId] ?? 50;
        this.applyBrightness(deckId, current + delta);
    }

    onBrightnessSlider(ev: Event, deckId: string): void {
        const input = ev.target as HTMLInputElement;
        const v = parseInt(input.value, 10);
        if (!Number.isNaN(v)) this.applyBrightness(deckId, v);
    }

    toggleBorderCompensation(deckId: string, on: boolean): void {
        // The camera streamer is the source of truth (it owns the per-
        // deck composite cache). The component just mirrors the value
        // for the checkbox to render — read back after set so a clamp
        // or anything similar in the streamer surfaces here.
        const streamer = (this.env as any).streamDeckCameraStreamer;
        if (!streamer) return;
        streamer.setBorderCompensation(deckId, on);
        this.state.borderCompensation[deckId] = streamer.getBorderCompensation(deckId);
        this._log(`borderCompensation(${deckId}) → ${on ? "on" : "off"}`);
    }

    /** Slider integer value (0–40) for axis 'w' or 'h'. Used directly
     *  by t-att-value so the template never has to do float math. */
    borderSliderValue(deckId: string, axis: "w" | "h"): number {
        const r = this.state.borderRatio[deckId];
        if (!r) return 0;
        return Math.round((axis === "w" ? r.w : r.h) * 100);
    }

    /** Section title with the deck count; French puts the plural on
     *  every count but 1, hence two keys. */
    headerLabel(): string {
        const count = this.state.decks.length;
        return count === 1
            ? this.t("streamdeck.header_one", { count })
            : this.t("streamdeck.header_other", { count });
    }

    /** "" unless the deck answered no feature report at open; then what
     *  is off and that a replug restores it. */
    controlPipeNotice(info: Partial<DeckInfo>): string {
        return info.controlPipeOk === false
            ? this.t("streamdeck.deck_control_pipe_down")
            : "";
    }

    /** The brightness last set from this panel, or the firmware
     *  default named as such while none was set. */
    brightnessLabel(deckId: string): string {
        const v = this.state.brightness[deckId];
        return v !== undefined ? `${v}%` : this.t("streamdeck.brightness_default");
    }

    lcdFontSizeLabel(deckId: string): string {
        return this.t("streamdeck.lcd_font_size_value", {
            size: this.state.lcdFontSize[deckId] ?? 48,
        });
    }

    lcdScrollSpeedLabel(deckId: string): string {
        return this.t("streamdeck.lcd_scroll_speed_value", {
            speed: this.state.lcdScrollSpeed[deckId] ?? 2,
        });
    }

    borderSliderLabel(deckId: string, axis: "w" | "h"): string {
        const r = this.state.borderRatio[deckId];
        if (!r) return "0%";
        return Math.round((axis === "w" ? r.w : r.h) * 100) + "%";
    }

    onBorderRatioInput(ev: Event, deckId: string, axis: "w" | "h"): void {
        const input = ev.target as HTMLInputElement;
        const x100 = parseInt(input.value, 10);
        if (Number.isNaN(x100)) return;
        const v = Math.max(0, Math.min(0.9, x100 / 100));
        const streamer = (this.env as any).streamDeckCameraStreamer;
        if (!streamer) return;
        const row = this.state.decks.find((r) => r.info.deckId === deckId);
        if (!row) return;
        const current = streamer.getEffectiveBorderRatio(deckId, row.info.model);
        const next = axis === "w"
            ? { w: v, h: current.h }
            : { w: current.w, h: v };
        streamer.setBorderRatio(deckId, next.w, next.h);
        this.syncBorderRatio(deckId, row.info.model);
    }

    resetBorderRatio(deckId: string): void {
        const streamer = (this.env as any).streamDeckCameraStreamer;
        if (!streamer) return;
        const row = this.state.decks.find((r) => r.info.deckId === deckId);
        if (!row) return;
        streamer.clearBorderRatio(deckId);
        this.syncBorderRatio(deckId, row.info.model);
        this._log(`borderRatio(${deckId}) → reset to model default`);
    }

    private syncBorderRatio(deckId: string, model: any): void {
        const streamer = (this.env as any).streamDeckCameraStreamer;
        if (!streamer) return;
        this.state.borderRatio[deckId] = streamer.getEffectiveBorderRatio(deckId, model);
        this.state.borderHasOverride[deckId] = streamer.hasBorderRatioOverride(deckId);
    }

    private syncBorderCompensationFromStreamer(): void {
        const streamer = (this.env as any).streamDeckCameraStreamer;
        if (!streamer) return;
        for (const row of this.state.decks) {
            this.state.borderCompensation[row.info.deckId] =
                streamer.getBorderCompensation(row.info.deckId);
            this.syncBorderRatio(row.info.deckId, row.info.model);
        }
        this.syncLcdTextFromRenderer();
    }

    onLcdTextInput(ev: Event, deckId: string): void {
        const input = ev.target as HTMLInputElement;
        const renderer = (this.env as any).streamDeckLcdTextRenderer;
        if (!renderer) return;
        renderer.setText(deckId, input.value);
        this.state.lcdText[deckId] = renderer.getText(deckId);
    }

    onLcdFontSizeInput(ev: Event, deckId: string): void {
        const input = ev.target as HTMLInputElement;
        const px = parseInt(input.value, 10);
        if (Number.isNaN(px)) return;
        const renderer = (this.env as any).streamDeckLcdTextRenderer;
        if (!renderer) return;
        renderer.setFontSize(deckId, px);
        this.state.lcdFontSize[deckId] = renderer.getFontSize(deckId);
    }

    onLcdColorInput(ev: Event, deckId: string): void {
        const input = ev.target as HTMLInputElement;
        const renderer = (this.env as any).streamDeckLcdTextRenderer;
        if (!renderer) return;
        renderer.setColor(deckId, input.value);
        this.state.lcdColor[deckId] = renderer.getColor(deckId);
    }

    onLcdScrollSpeedInput(ev: Event, deckId: string): void {
        const input = ev.target as HTMLInputElement;
        const px = parseInt(input.value, 10);
        if (Number.isNaN(px)) return;
        const renderer = (this.env as any).streamDeckLcdTextRenderer;
        if (!renderer) return;
        renderer.setScrollSpeed(deckId, px);
        this.state.lcdScrollSpeed[deckId] = renderer.getScrollSpeed(deckId);
    }

    private syncLcdTextFromRenderer(): void {
        const renderer = (this.env as any).streamDeckLcdTextRenderer;
        if (!renderer) return;
        for (const row of this.state.decks) {
            if (!row.info.lcd) continue;
            const id = row.info.deckId;
            this.state.lcdText[id] = renderer.getText(id);
            this.state.lcdFontSize[id] = renderer.getFontSize(id);
            this.state.lcdColor[id] = renderer.getColor(id);
            this.state.lcdScrollSpeed[id] = renderer.getScrollSpeed(id);
        }
    }

    /** One request for every attached deck: a deck still waiting for
     *  permission has no deckId yet, so it is not in state.decks. */
    async retryPermission(): Promise<void> {
        this._log("requestPermission() → asking…");
        try {
            const r = await StreamDeckPlugin.requestPermission();
            for (const line of describePermissionResponse(r)) {
                this._log(`requestPermission: ${line}`);
            }
            await this.refresh();
            await this.scanAllUsb();
        } catch (e) {
            this._log(`requestPermission ERROR: ${e}`);
        }
    }

    private async _wireListeners(): Promise<void> {
        // Plugin event → singleton log subscriptions are wired once at app
        // boot in app.ts, so they survive navigation. The component just
        // listens to refresh-relevant events to update the deck/USB lists.
        this._listeners.push(
            await StreamDeckPlugin.addListener("deckConnected", () => this.refresh()),
        );
        this._listeners.push(
            await StreamDeckPlugin.addListener("deckDisconnected", () => this.refresh()),
        );
    }

    clearLog(): void {
        streamDeckEventLog.clear();
    }

    private _log(text: string): void {
        streamDeckEventLog.add(text);
    }
}
