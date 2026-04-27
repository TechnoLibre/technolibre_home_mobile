import { onMounted, useState, xml } from "@odoo/owl";
import { EnhancedComponent } from "../../../js/enhancedComponent";
import { CODE_STYLE_ENTRIES } from "../../../services/codeStyleService";

interface CodeStyleRow {
    prefKey: string;
    cssVar: string;
    label: string;
    defaultValue: string;
    /** Currently active value (override if any, otherwise default). */
    current: string;
    /** True iff a user override is in effect. */
    overridden: boolean;
}

/**
 * Collapsible Options panel that lets the user customize the colors used by
 * the Code tool's edit-mode UI (Edit/commit buttons, baseline-drift warning,
 * git file color coding, diff pane, …). Each row is a `<input type="color">`
 * picker tied to a `user_graphic_prefs` row via CodeStyleService.
 *
 * Empty value means "use the SCSS fallback" — i.e. inherit the active theme.
 */
export class OptionsCodeStyleComponent extends EnhancedComponent {
    static template = xml`
        <li class="options-list__item options-code-style">
          <div
              class="options-code-style__header"
              role="button"
              tabindex="0"
              t-att-aria-expanded="state.expanded ? 'true' : 'false'"
              t-on-click="toggle"
              t-on-keydown="onHeaderKey">
            <span>🎨 Style — outil Code</span>
            <span t-esc="state.expanded ? '▲' : '▼'"/>
          </div>

          <div t-if="state.expanded" class="options-code-style__body">
            <p class="options-code-style__hint">
              Chaque couleur surchage le thème actif pour l'outil Code.
              Cliquer ↶ revient au thème par défaut.
            </p>

            <t t-foreach="state.rows" t-as="row" t-key="row.prefKey">
              <div class="options-code-style__row">
                <label class="options-code-style__label" t-esc="row.label" />
                <input
                    type="color"
                    class="options-code-style__picker"
                    t-att-value="row.current"
                    t-on-input="(ev) => this.onChange(row.prefKey, ev.target.value)" />
                <span class="options-code-style__hex" t-esc="row.current" />
                <button
                    type="button"
                    class="options-code-style__reset"
                    t-att-disabled="!row.overridden"
                    t-on-click="() => this.onReset(row.prefKey)">↶</button>
              </div>
            </t>

            <button
                type="button"
                class="options-code-style__reset-all"
                t-on-click="() => this.onResetAll()">
              ⟲ Tout réinitialiser
            </button>
          </div>
        </li>
    `;

    state = useState({
        expanded: false,
        rows: [] as CodeStyleRow[],
    });

    setup(): void {
        onMounted(async () => {
            await this._reload();
        });
    }

    toggle(): void { this.state.expanded = !this.state.expanded; }

    onHeaderKey(ev: KeyboardEvent): void {
        if (ev.key === "Enter" || ev.key === " ") {
            ev.preventDefault();
            this.toggle();
        }
    }

    private async _reload(): Promise<void> {
        const codeStyle = this.env.codeStyleService;
        const rows: CodeStyleRow[] = [];
        for (const entry of CODE_STYLE_ENTRIES) {
            const stored = await this.env.databaseService.getUserGraphicPref(entry.prefKey);
            const overridden = !!stored && /^#[0-9a-fA-F]{3,8}$/.test(stored);
            rows.push({
                prefKey: entry.prefKey,
                cssVar: entry.cssVar,
                label: entry.label,
                defaultValue: entry.defaultValue,
                current: overridden ? stored! : entry.defaultValue,
                overridden,
            });
        }
        this.state.rows = rows;
        // touch codeStyle so TS doesn't complain about an unused local; the real
        // work happens via the service when the user changes a value.
        void codeStyle;
    }

    async onChange(prefKey: string, value: string): Promise<void> {
        await this.env.codeStyleService.setColor(prefKey, value);
        const row = this.state.rows.find((r) => r.prefKey === prefKey);
        if (row) {
            row.current = value;
            row.overridden = true;
        }
    }

    async onReset(prefKey: string): Promise<void> {
        await this.env.codeStyleService.resetColor(prefKey);
        const row = this.state.rows.find((r) => r.prefKey === prefKey);
        if (row) {
            row.current = row.defaultValue;
            row.overridden = false;
        }
    }

    async onResetAll(): Promise<void> {
        await this.env.codeStyleService.resetAll();
        for (const row of this.state.rows) {
            row.current = row.defaultValue;
            row.overridden = false;
        }
    }
}
