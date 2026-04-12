import { onMounted, useState, xml } from "@odoo/owl";
import { EnhancedComponent } from "../../../js/enhancedComponent";
import {
  COLOR_THEME_LABELS,
  DEFAULT_GRAPHIC_PREFS,
  FONT_CSS_VALUES,
  FONT_LABELS,
  FONT_SIZE_LABELS,
  FONT_SIZE_STEPS,
  applyGraphicPrefs,
} from "../../../models/graphicPrefs";
import type { ColorTheme, FontFamily } from "../../../models/graphicPrefs";

const FONT_OPTIONS: { key: FontFamily; label: string; cssValue: string }[] = (
  Object.keys(FONT_LABELS) as FontFamily[]
).map((key) => ({ key, label: FONT_LABELS[key], cssValue: FONT_CSS_VALUES[key] }));

const THEME_OPTIONS: { key: ColorTheme; label: string; icon: string }[] = [
  { key: "light",       label: COLOR_THEME_LABELS.light,        icon: "☀️"  },
  { key: "light-warm",  label: COLOR_THEME_LABELS["light-warm"], icon: "🌅" },
  { key: "dark-grey",   label: COLOR_THEME_LABELS["dark-grey"],  icon: "🌆" },
  { key: "dark",        label: COLOR_THEME_LABELS.dark,          icon: "🌙" },
];

export class OptionsGraphicComponent extends EnhancedComponent {
  static template = xml`
    <li class="options-list__item options-graphic">
      <div class="options-graphic__header" t-on-click="toggleExpanded">
        <span>🎨 Apparence</span>
        <span t-esc="state.expanded ? '▲' : '▼'"/>
      </div>

      <div t-if="state.expanded" class="options-graphic__body">

        <div class="options-graphic__section">
          <p class="options-graphic__label">Thème</p>
          <div class="options-graphic__theme-grid">
            <t t-foreach="themeOptions" t-as="opt" t-key="opt.key">
              <button
                type="button"
                t-att-class="'options-graphic__theme-btn' + (state.colorTheme === opt.key ? ' options-graphic__theme-btn--active' : '')"
                t-on-click="() => this.setTheme(opt.key)"
              ><span class="options-graphic__theme-icon" t-esc="opt.icon"/><span t-esc="opt.label"/></button>
            </t>
          </div>
        </div>

        <div class="options-graphic__section">
          <p class="options-graphic__label">Police</p>
          <div class="options-graphic__font-row">
            <t t-foreach="fontOptions" t-as="opt" t-key="opt.key">
              <button
                type="button"
                t-att-class="'options-graphic__font-btn' + (state.fontFamily === opt.key ? ' options-graphic__font-btn--active' : '')"
                t-att-style="'font-family: ' + opt.cssValue"
                t-on-click="() => this.setFont(opt.key)"
              ><t t-esc="opt.label"/></button>
            </t>
          </div>
          <p class="options-graphic__preview" t-att-style="'font-family: ' + currentFontCss">
            Le renard brun saute par-dessus le chien paresseux.
          </p>
        </div>

        <div class="options-graphic__section">
          <p class="options-graphic__label">
            Taille de police — <span t-esc="fontSizeLabel"/>
          </p>
          <div class="options-graphic__size-row">
            <button
              type="button"
              class="options-graphic__size-btn"
              t-att-disabled="state.fontSizeStepIndex &lt;= 0"
              t-on-click="decreaseFont"
            >A−</button>
            <div class="options-graphic__size-dots">
              <t t-foreach="fontSizeSteps" t-as="step" t-key="step_index">
                <span
                  t-att-class="'options-graphic__size-dot' + (step_index === state.fontSizeStepIndex ? ' options-graphic__size-dot--active' : '')"
                  t-on-click="() => this.setFontSizeStep(step_index)"
                />
              </t>
            </div>
            <button
              type="button"
              class="options-graphic__size-btn"
              t-att-disabled="state.fontSizeStepIndex >= fontSizeSteps.length - 1"
              t-on-click="increaseFont"
            >A+</button>
          </div>
        </div>

      </div>
    </li>
  `;

  fontOptions = FONT_OPTIONS;
  fontSizeSteps = FONT_SIZE_STEPS;
  themeOptions = THEME_OPTIONS;

  setup() {
    this.state = useState({
      expanded: false,
      fontFamily: DEFAULT_GRAPHIC_PREFS.fontFamily as FontFamily,
      fontSizeStepIndex: 2, // index of 1.0 in FONT_SIZE_STEPS
      colorTheme: DEFAULT_GRAPHIC_PREFS.colorTheme as ColorTheme,
    });
    onMounted(() => this.loadPrefs());
  }

  private async loadPrefs() {
    const fontFamily = await this.databaseService.getUserGraphicPref("font_family");
    const fontSizeScale = await this.databaseService.getUserGraphicPref("font_size_scale");
    const colorTheme = await this.databaseService.getUserGraphicPref("color_theme");
    if (fontFamily) this.state.fontFamily = fontFamily as FontFamily;
    if (fontSizeScale) {
      const scale = parseFloat(fontSizeScale);
      const idx = FONT_SIZE_STEPS.indexOf(scale);
      if (idx !== -1) this.state.fontSizeStepIndex = idx;
    }
    if (colorTheme === "dark" || colorTheme === "dark-grey" || colorTheme === "light-warm" || colorTheme === "light") {
      this.state.colorTheme = colorTheme;
    }
  }

  toggleExpanded() {
    this.state.expanded = !this.state.expanded;
  }

  async setTheme(key: ColorTheme) {
    this.state.colorTheme = key;
    await this.databaseService.setUserGraphicPref("color_theme", key);
    applyGraphicPrefs({
      fontFamily: this.state.fontFamily,
      fontSizeScale: FONT_SIZE_STEPS[this.state.fontSizeStepIndex],
      colorTheme: key,
    });
  }

  async setFont(key: FontFamily) {
    this.state.fontFamily = key;
    await this.databaseService.setUserGraphicPref("font_family", key);
    applyGraphicPrefs({ fontFamily: key, fontSizeScale: FONT_SIZE_STEPS[this.state.fontSizeStepIndex], colorTheme: this.state.colorTheme });
  }

  async setFontSizeStep(index: number) {
    this.state.fontSizeStepIndex = index;
    await this.databaseService.setUserGraphicPref("font_size_scale", String(FONT_SIZE_STEPS[index]));
    applyGraphicPrefs({ fontFamily: this.state.fontFamily, fontSizeScale: FONT_SIZE_STEPS[index], colorTheme: this.state.colorTheme });
  }

  async increaseFont() {
    if (this.state.fontSizeStepIndex < FONT_SIZE_STEPS.length - 1) {
      await this.setFontSizeStep(this.state.fontSizeStepIndex + 1);
    }
  }

  async decreaseFont() {
    if (this.state.fontSizeStepIndex > 0) {
      await this.setFontSizeStep(this.state.fontSizeStepIndex - 1);
    }
  }

  get currentFontCss(): string {
    return FONT_CSS_VALUES[this.state.fontFamily];
  }

  get fontSizeLabel(): string {
    return FONT_SIZE_LABELS[this.state.fontSizeStepIndex];
  }
}
