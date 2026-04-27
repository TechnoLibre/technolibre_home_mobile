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
              <div class="options-streamdeck__deck">
                <div class="options-streamdeck__deck-line">
                  <strong t-esc="row.info.model" />
                  <span class="options-streamdeck__deck-serial">
                    serial: <code t-esc="row.info.deckId" />
                  </span>
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
    });

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
