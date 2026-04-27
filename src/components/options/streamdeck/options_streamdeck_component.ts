import { onMounted, onWillUnmount, useState, xml } from "@odoo/owl";
import type { PluginListenerHandle } from "@capacitor/core";
import { EnhancedComponent } from "../../../js/enhancedComponent";
import {
    StreamDeckPlugin,
    DeckInfo,
} from "../../../plugins/streamDeckPlugin";

interface DeckRow {
    info: DeckInfo;
}

interface EventLogEntry {
    ts: string;
    text: string;
}

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

            <div class="options-streamdeck__log">
              <div class="options-streamdeck__log-header">Journal d'événements</div>
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
        </li>
    `;

    state = useState({
        expanded: false,
        decks: [] as DeckRow[],
        events: [] as EventLogEntry[],
        error: "",
    });

    private _listeners: PluginListenerHandle[] = [];

    setup(): void {
        onMounted(async () => {
            await this.refresh();
            await this._wireListeners();
        });
        onWillUnmount(async () => {
            for (const h of this._listeners) {
                try { await h.remove(); } catch { /* ignore */ }
            }
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
            const r = await StreamDeckPlugin.listDecks();
            this.state.decks = r.decks.map((info) => ({ info }));
            this._log(`listDecks → ${r.decks.length} deck(s)`);
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            this.state.error = msg;
            this._log(`listDecks ERROR: ${msg}`);
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
        this._listeners.push(
            await StreamDeckPlugin.addListener("deckConnected", (ev) => {
                this._log(`deckConnected: ${ev.deckId}`);
                this.refresh();
            }),
        );
        this._listeners.push(
            await StreamDeckPlugin.addListener("deckDisconnected", (ev) => {
                this._log(`deckDisconnected: ${ev.deckId} (${ev.reason ?? "no reason"})`);
                this.refresh();
            }),
        );
        this._listeners.push(
            await StreamDeckPlugin.addListener("permissionDenied", (ev) => {
                this._log(`permissionDenied: ${ev.reason ?? "no reason"}`);
            }),
        );
    }

    private _log(text: string): void {
        const ts = new Date().toLocaleTimeString();
        this.state.events.unshift({ ts, text });
        if (this.state.events.length > 50) this.state.events.pop();
    }
}
