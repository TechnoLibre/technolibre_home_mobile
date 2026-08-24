import { onMounted, useState, xml } from "@odoo/owl";
import { EnhancedComponent } from "../../../js/enhancedComponent";
import { KeepAwakePlugin } from "../../../plugins/keepAwakePlugin";
import { useFeatureSection } from "../../../utils/featureSection";

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
            <span>🌙 Mise en veille</span>
            <span t-esc="state.expanded ? '▲' : '▼'"/>
          </div>
          <div t-if="state.expanded" class="options-camera-stream__body">
            <div class="options-camera-stream__setting">
              <label class="options-camera-stream__checkbox-label">
                <input type="checkbox"
                       t-att-checked="state.enabled"
                       t-on-change="onToggle" />
                Empêcher la mise en veille
              </label>
              <p class="options-camera-stream__setting-hint">
                L'écran du téléphone reste allumé tant que cette option
                est cochée. Utile quand un Stream Deck est branché et
                qu'on ne veut pas que la LCD se ternisse avec le timeout
                d'écran. Pensez à désactiver pour économiser la batterie.
              </p>
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
        error: "",
    });

    setup(): void {
        useFeatureSection("keep-awake", () => { this.state.expanded = true; });
        onMounted(async () => {
            try {
                const stored = localStorage.getItem(STORAGE_KEY);
                const want = stored === "true";
                this.state.enabled = want;
                if (want) {
                    // Re-apply on app start so the flag survives a reboot.
                    await KeepAwakePlugin.setEnabled({ enabled: true });
                }
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
}
