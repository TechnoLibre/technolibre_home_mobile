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

            <!-- Streaming options. Visible whether or not streaming is
                 active so the user can preview/tune defaults before
                 hitting Activer; setters apply live mid-stream when
                 it's running (timer swap, MediaStream swap, etc.). -->
            <div class="options-camera-stream__settings">
              <div class="options-camera-stream__setting">
                <label class="options-camera-stream__setting-label">
                  Qualité JPEG —
                  <strong t-esc="state.qualityLabel" />
                </label>
                <input type="range" min="10" max="100" step="5"
                       class="options-camera-stream__slider"
                       t-att-value="state.qualityX100"
                       t-on-input="onQualityInput" />
                <p class="options-camera-stream__setting-hint">
                  Plus haut = image plus nette mais plus lent à transmettre.
                  Défaut 0.10.
                </p>
              </div>

              <div class="options-camera-stream__setting">
                <label class="options-camera-stream__setting-label">
                  Images par seconde — <strong t-esc="state.fps" /> i/s
                </label>
                <input type="range" min="1" max="30" step="1"
                       class="options-camera-stream__slider"
                       t-att-value="state.fps"
                       t-on-input="onFpsInput" />
                <p class="options-camera-stream__setting-hint">
                  Plafond effectif limité par le temps d'encodage et le
                  drain USB. Défaut 5 i/s.
                </p>
              </div>

              <div class="options-camera-stream__setting">
                <label class="options-camera-stream__setting-label">Caméra</label>
                <div class="options-camera-stream__row">
                  <button class="options-camera-stream__refresh"
                          t-att-class="{ 'options-camera-stream__button--on': state.facingMode === 'environment' }"
                          t-on-click="() => this.applyFacingMode('environment')">
                    📷 Arrière
                  </button>
                  <button class="options-camera-stream__refresh"
                          t-att-class="{ 'options-camera-stream__button--on': state.facingMode === 'user' }"
                          t-on-click="() => this.applyFacingMode('user')">
                    🤳 Avant
                  </button>
                </div>
              </div>

              <div class="options-camera-stream__setting">
                <label class="options-camera-stream__checkbox-label">
                  <input type="checkbox"
                         t-att-checked="state.skipIdentical"
                         t-on-change="onSkipIdenticalChange" />
                  Sauter les images identiques
                </label>
                <p class="options-camera-stream__setting-hint">
                  Hash 32×16 du flux vidéo. Si la scène n'a pas changé,
                  on saute encodage + USB. Gratuit pour scènes statiques.
                </p>
              </div>

              <div class="options-camera-stream__setting">
                <label class="options-camera-stream__checkbox-label">
                  <input type="checkbox"
                         t-att-checked="state.faceDetect"
                         t-on-change="onFaceDetectChange" />
                  Détection de visage (bordure verte)
                </label>
                <p class="options-camera-stream__setting-hint">
                  ML Kit (natif Android). Les touches contenant un visage
                  reçoivent un cadre vert. Détection asynchrone, cadence
                  alignée sur le FPS du stream.
                </p>
              </div>
            </div>
          </div>
        </li>
    `;

    state = useState({
        expanded: false,
        active: false,
        deckCount: 0,
        error: "",
        // Slider works on integers, the streamer wants 0.1–1.0. Keep
        // both representations in state so t-att-value reads cleanly
        // and the label can reuse the float form.
        qualityX100: 10,
        qualityLabel: "0.10",
        fps: 5,
        facingMode: "environment" as "environment" | "user",
        skipIdentical: false,
        faceDetect: false,
    });

    private _listeners: PluginListenerHandle[] = [];
    private _unsubActive: (() => void) | null = null;

    private get streamer(): StreamDeckCameraStreamer {
        return (this.env as any).streamDeckCameraStreamer;
    }

    setup(): void {
        onMounted(async () => {
            this.state.active = this.streamer.isActive();
            // Sync every slider/toggle to whatever the streamer currently
            // has — the singleton survives navigation, so a value tuned
            // earlier shouldn't reset when the panel re-mounts.
            this.syncFromStreamer();
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

    onQualityInput(ev: Event): void {
        const input = ev.target as HTMLInputElement;
        const x100 = parseInt(input.value, 10);
        if (Number.isNaN(x100)) return;
        const q = Math.max(0.1, Math.min(1.0, x100 / 100));
        this.streamer.setQuality(q);
        this.syncFromStreamer();
    }

    onFpsInput(ev: Event): void {
        const input = ev.target as HTMLInputElement;
        const fps = parseInt(input.value, 10);
        if (Number.isNaN(fps)) return;
        this.streamer.setFps(fps);
        this.syncFromStreamer();
    }

    async applyFacingMode(mode: "environment" | "user"): Promise<void> {
        if (this.state.facingMode === mode) return;
        this.state.error = "";
        try {
            await this.streamer.setFacingMode(mode);
        } catch (e) {
            this.state.error = e instanceof Error ? e.message : String(e);
        }
        this.syncFromStreamer();
    }

    onSkipIdenticalChange(ev: Event): void {
        const input = ev.target as HTMLInputElement;
        this.streamer.setSkipIdentical(input.checked);
        this.syncFromStreamer();
    }

    onFaceDetectChange(ev: Event): void {
        const input = ev.target as HTMLInputElement;
        this.streamer.setFaceDetect(input.checked);
        this.syncFromStreamer();
    }

    private syncFromStreamer(): void {
        const q = this.streamer.getQuality();
        this.state.qualityX100 = Math.round(q * 100);
        this.state.qualityLabel = q.toFixed(2);
        this.state.fps = this.streamer.getFps();
        this.state.facingMode = this.streamer.getFacingMode();
        this.state.skipIdentical = this.streamer.getSkipIdentical();
        this.state.faceDetect = this.streamer.getFaceDetect();
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
