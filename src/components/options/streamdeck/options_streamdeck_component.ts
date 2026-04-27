import { onMounted, onWillUnmount, useState, xml } from "@odoo/owl";
import type { PluginListenerHandle } from "@capacitor/core";
import { EnhancedComponent } from "../../../js/enhancedComponent";
import {
    StreamDeckPlugin,
    DeckInfo,
    UsbDeviceDiag,
} from "../../../plugins/streamDeckPlugin";
import {
    streamDeckEventLog,
    StreamDeckEventLogEntry,
} from "../../../services/streamDeckEventLog";

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
        <li class="options-list__item options-streamdeck">
          <div
              class="options-streamdeck__header"
              role="button"
              tabindex="0"
              t-att-aria-expanded="state.expanded ? 'true' : 'false'"
              t-on-click="toggle"
              t-on-keydown="onHeaderKey">
            <span>🎛️ Stream Deck — <t t-esc="state.decks.length" /> connecté<t t-if="state.decks.length !== 1">s</t></span>
            <span t-esc="state.expanded ? '▲' : '▼'"/>
          </div>

          <div t-if="state.expanded" class="options-streamdeck__body">
            <div class="options-streamdeck__toolbar">
              <button class="options-streamdeck__refresh" t-on-click="() => this.refresh()">
                ↻ Rafraîchir
              </button>
              <button class="options-streamdeck__retry"
                      t-att-disabled="state.decks.length === 0"
                      t-on-click="() => this.retryPermission()">
                🔓 Demander permission
              </button>
              <button class="options-streamdeck__refresh"
                      t-on-click="() => this.scanAllUsb()">
                🔍 Scanner USB
              </button>
              <button class="options-streamdeck__refresh"
                      t-att-class="{ 'options-streamdeck__debug--on': state.debugLogging }"
                      t-on-click="() => this.toggleDebugLogging()">
                <t t-if="state.debugLogging">🛑 Debug ON</t>
                <t t-else="">🐞 Debug OFF</t>
              </button>
            </div>

            <t t-if="state.error">
              <div class="options-streamdeck__error" t-esc="state.error" />
            </t>

            <t t-if="state.decks.length === 0">
              <p class="options-streamdeck__hint">
                Aucun Stream Deck détecté.
                Branche un deck en USB OTG, accepte la permission, puis
                rafraîchis. Si rien ne se passe, vérifie que l'event
                « permissionDenied » apparaît dans le journal ci-dessous.
              </p>
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
                    serial: <code t-esc="row.info.deckId" />
                  </span>
                  <span class="options-streamdeck__deck-caret"
                        t-esc="state.expandedDeckId === row.info.deckId ? '▲' : '▼'" />
                </div>
                <div class="options-streamdeck__deck-line">
                  <span><t t-esc="row.info.rows" />×<t t-esc="row.info.cols" /> = <t t-esc="row.info.keyCount" /> touches</span>
                  <span>
                    image <t t-esc="row.info.keyImage.w" />×<t t-esc="row.info.keyImage.h" />
                    (<t t-esc="row.info.keyImage.format" />)
                  </span>
                </div>
                <div class="options-streamdeck__deck-line">
                  <span>productId 0x<t t-esc="row.info.productId.toString(16)" /></span>
                  <span>fw <t t-esc="row.info.firmwareVersion" /></span>
                </div>
                <t t-if="row.info.dialCount &gt; 0">
                  <div class="options-streamdeck__deck-line">
                    <span><t t-esc="row.info.dialCount" /> dials</span>
                  </div>
                </t>
                <t t-if="row.info.lcd">
                  <div class="options-streamdeck__deck-line">
                    <span>LCD <t t-esc="row.info.lcd.w" />×<t t-esc="row.info.lcd.h" /></span>
                  </div>
                </t>
                <div class="options-streamdeck__deck-line">
                  <span>capacités: <t t-esc="row.info.capabilities.join(', ')" /></span>
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
                      💡 Luminosité —
                      <strong t-esc="state.brightness[row.info.deckId] !== undefined ? state.brightness[row.info.deckId] + '%' : '50% (par défaut)'" />
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
                        Inclure les bordures dans l'image (caméra)
                      </label>
                    </div>
                    <p class="options-streamdeck__hint options-streamdeck__hint--inline">
                      Compense les espaces physiques entre les touches.
                      Les pixels qui tombent sur les bordures sont écartés
                      au lieu d'être affichés sur la mauvaise touche.
                    </p>

                    <t t-if="state.borderCompensation[row.info.deckId]">
                      <div class="options-streamdeck__deck-params-header">
                        Largeur bordure (entre colonnes) —
                        <strong t-esc="borderSliderLabel(row.info.deckId, 'w')" />
                      </div>
                      <input type="range" min="0" max="40" step="1"
                             class="options-streamdeck__brightness-slider"
                             t-att-value="borderSliderValue(row.info.deckId, 'w')"
                             t-on-input="(ev) => this.onBorderRatioInput(ev, row.info.deckId, 'w')" />

                      <div class="options-streamdeck__deck-params-header">
                        Hauteur bordure (entre rangées) —
                        <strong t-esc="borderSliderLabel(row.info.deckId, 'h')" />
                      </div>
                      <input type="range" min="0" max="40" step="1"
                             class="options-streamdeck__brightness-slider"
                             t-att-value="borderSliderValue(row.info.deckId, 'h')"
                             t-on-input="(ev) => this.onBorderRatioInput(ev, row.info.deckId, 'h')" />

                      <div class="options-streamdeck__deck-params-row">
                        <button class="options-streamdeck__refresh"
                                t-att-disabled="!state.borderHasOverride[row.info.deckId]"
                                t-on-click="() => this.resetBorderRatio(row.info.deckId)">
                          ↺ Valeurs par défaut du modèle
                        </button>
                      </div>
                    </t>
                  </div>
                </t>
              </div>
            </t>

            <t t-if="state.allUsb.length > 0">
              <div class="options-streamdeck__log">
                <div class="options-streamdeck__log-header">USB devices vus par Android (tous)</div>
                <t t-foreach="state.allUsb" t-as="dev" t-key="dev.deviceName">
                  <div class="options-streamdeck__deck">
                    <div class="options-streamdeck__deck-line">
                      <strong>
                        <t t-if="dev.knownStreamDeck">✅</t>
                        <t t-elif="dev.isElgato">⚠️ Elgato</t>
                        <t t-else="">❓</t>
                        <t t-esc="dev.productName || '(no product name)'" />
                      </strong>
                      <span><t t-esc="dev.manufacturerName" /></span>
                    </div>
                    <div class="options-streamdeck__deck-line">
                      <span>vendor=<code t-esc="dev.vendorIdHex" /></span>
                      <span>product=<code t-esc="dev.productIdHex" /></span>
                    </div>
                    <div class="options-streamdeck__deck-line">
                      <span class="options-streamdeck__deck-serial" t-esc="dev.deviceName" />
                      <span t-if="dev.hasPermission">[permission OK]</span>
                      <span t-else="">[permission ?]</span>
                    </div>
                    <div t-if="dev.isElgato and !dev.hasPermission" class="options-streamdeck__deck-line">
                      <button class="options-streamdeck__retry"
                              t-on-click="() => this.askPermissionForUsb(dev.deviceName)">
                        🔓 Demander permission pour ce device
                      </button>
                    </div>
                    <div t-if="dev.lastAttachError" class="options-streamdeck__error">
                      ❌ Dernière erreur d'attach: <code t-esc="dev.lastAttachError" />
                    </div>
                    <div t-if="dev.knownStreamDeck and dev.hasPermission and !dev.inSession" class="options-streamdeck__deck-line">
                      <span>⚠ permission OK mais session jamais ouverte — voir l'erreur ci-dessus</span>
                    </div>
                  </div>
                </t>
              </div>
            </t>

            <div class="options-streamdeck__log">
              <div class="options-streamdeck__log-header">
                <span>Journal d'événements (<t t-esc="state.events.length" />)</span>
                <button class="options-streamdeck__refresh"
                        t-on-click="() => this.clearLog()">
                  🗑 Vider
                </button>
              </div>
              <div class="options-streamdeck__log-scroll">
                <t t-if="state.events.length === 0">
                  <p class="options-streamdeck__hint">Aucun événement.</p>
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
    });

    // Exposed to the template so the t-foreach over presets stays a
    // simple identifier — Owl AOT precompile is happiest without
    // array literals in attribute values.
    brightnessPresets = [0, 25, 50, 75, 100];

    private _listeners: PluginListenerHandle[] = [];

    private _logUnsubscribe?: () => void;

    setup(): void {
        // Pull existing entries from the singleton ring buffer first, then
        // subscribe so subsequent additions show up live. Both happen on
        // every (re)mount, so navigating away & back reveals the full log.
        this.state.events = streamDeckEventLog.getAll();
        this._logUnsubscribe = streamDeckEventLog.subscribe(() => {
            this.state.events = streamDeckEventLog.getAll();
        });

        onMounted(async () => {
            await this.refresh();
            await this._wireListeners();
        });
        onWillUnmount(async () => {
            for (const h of this._listeners) {
                try { await h.remove(); } catch { /* ignore */ }
            }
            this._logUnsubscribe?.();
        });
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
                this._log("⚠️ aucun device USB — OTG inactif ou câble HS");
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
        try {
            await StreamDeckPlugin.setBrightness({ deckId, percent: clamped });
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

    borderSliderLabel(deckId: string, axis: "w" | "h"): string {
        const r = this.state.borderRatio[deckId];
        if (!r) return "0%";
        return Math.round((axis === "w" ? r.w : r.h) * 100) + "%";
    }

    onBorderRatioInput(ev: Event, deckId: string, axis: "w" | "h"): void {
        const input = ev.target as HTMLInputElement;
        const x100 = parseInt(input.value, 10);
        if (Number.isNaN(x100)) return;
        const v = Math.max(0, Math.min(0.4, x100 / 100));
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
    }

    async retryPermission(): Promise<void> {
        for (const row of this.state.decks) {
            try {
                const r = await StreamDeckPlugin.requestPermission({
                    deckId: row.info.deckId,
                });
                this._log(`requestPermission(${row.info.deckId}) → granted=${r.granted}`);
            } catch (e) {
                this._log(`requestPermission(${row.info.deckId}) ERROR: ${e}`);
            }
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
