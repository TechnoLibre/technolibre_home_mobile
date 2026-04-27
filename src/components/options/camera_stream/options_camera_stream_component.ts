import { onMounted, onWillUnmount, useState, xml } from "@odoo/owl";
import type { PluginListenerHandle } from "@capacitor/core";
import { EnhancedComponent } from "../../../js/enhancedComponent";
import { StreamDeckPlugin } from "../../../plugins/streamDeckPlugin";
import { StreamDeckCameraStreamer } from "../../../services/streamDeckCameraStreamer";

/**
 * Options panel toggle: pump the rear camera onto every connected
 * Stream Deck. Disabled while no deck is plugged in. Pressing any
 * deck key while streaming also stops it (handled by the streamer
 * itself); the toggle reflects that change via onActiveChange.
 */
export class OptionsCameraStreamComponent extends EnhancedComponent {
    static template = xml`
        <li class="options-list__item options-camera-stream">
          <div
              class="options-camera-stream__header"
              role="button"
              tabindex="0"
              t-att-aria-expanded="state.expanded ? 'true' : 'false'"
              t-on-click="toggle"
              t-on-keydown="onHeaderKey">
            <span>📷 Caméra → Stream Deck</span>
            <span t-esc="state.expanded ? '▲' : '▼'"/>
          </div>

          <div t-if="state.expanded" class="options-camera-stream__body">
            <p class="options-camera-stream__hint">
              Diffuse l'image de la caméra arrière sur tous les Stream Deck
              connectés. Une pression sur n'importe quelle touche du deck
              arrête la diffusion.
            </p>

            <div class="options-camera-stream__row">
              <button
                  class="options-camera-stream__button"
                  t-att-class="{ 'options-camera-stream__button--on': state.active }"
                  t-att-disabled="isToggleDisabled"
                  t-on-click="() => this.onToggle()">
                <t t-if="state.active">⏹ Désactiver</t>
                <t t-else="">▶ Activer (<t t-esc="state.deckCount" /> deck<t t-if="state.deckCount !== 1">s</t>)</t>
              </button>
              <button
                  class="options-camera-stream__refresh"
                  t-on-click="() => this.refreshDeckCount()"
                  title="Re-scanner les decks">
                ↻
              </button>
            </div>

            <t t-if="state.error">
              <div class="options-camera-stream__error" t-esc="state.error" />
            </t>
          </div>
        </li>
    `;

    state = useState({
        expanded: false,
        active: false,
        deckCount: 0,
        error: "",
    });

    private _listeners: PluginListenerHandle[] = [];
    private _unsubActive: (() => void) | null = null;

    private get streamer(): StreamDeckCameraStreamer {
        return (this.env as any).streamDeckCameraStreamer;
    }

    setup(): void {
        onMounted(async () => {
            this.state.active = this.streamer.isActive();
            this._unsubActive = this.streamer.onActiveChange((active) => {
                this.state.active = active;
                if (!active) this.state.error = "";
            });
            await this.refreshDeckCount();
            this._listeners.push(
                await StreamDeckPlugin.addListener("deckConnected", () => this.refreshDeckCount()),
            );
            this._listeners.push(
                await StreamDeckPlugin.addListener("deckDisconnected", () => this.refreshDeckCount()),
            );
        });
        onWillUnmount(async () => {
            for (const h of this._listeners) {
                try { await h.remove(); } catch { /* ignore */ }
            }
            this._unsubActive?.();
        });
    }

    get isToggleDisabled(): boolean {
        // A getter avoids the t-att expression mixing JS `===` with Owl
        // `and` that can land an HTML `disabled="false"` attribute (which
        // browsers still treat as disabled).
        return !this.state.active && this.state.deckCount === 0;
    }

    toggle(): void {
        this.state.expanded = !this.state.expanded;
        // Expanding refreshes the count — boot-time scans on hubs can
        // miss a deck that took a beat longer to enumerate, and the
        // initial onMounted poll then sticks at 0.
        if (this.state.expanded) this.refreshDeckCount();
    }

    onHeaderKey(ev: KeyboardEvent): void {
        if (ev.key === "Enter" || ev.key === " ") {
            ev.preventDefault();
            this.toggle();
        }
    }

    async onToggle(): Promise<void> {
        this.state.error = "";
        try {
            if (this.streamer.isActive()) {
                await this.streamer.stop();
            } else {
                await this.streamer.start();
            }
        } catch (e) {
            this.state.error = e instanceof Error ? e.message : String(e);
        }
    }

    async refreshDeckCount(): Promise<void> {
        try {
            // Mirror the diagnostic panel: retryAttach picks up decks
            // that have permission but whose boot-time onDeckAttached
            // failed silently (common with USB hubs and concurrent
            // enumeration of multiple decks).
            try { await StreamDeckPlugin.retryAttach(); } catch { /* ignore */ }
            const r = await StreamDeckPlugin.listDecks();
            this.state.deckCount = r.decks.length;
        } catch {
            this.state.deckCount = 0;
        }
    }
}
