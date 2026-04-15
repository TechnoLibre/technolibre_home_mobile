import { xml } from "@odoo/owl";
import { EnhancedComponent } from "../../../js/enhancedComponent";
import { getCurrentLocale, setLocale } from "../../../i18n";
import type { Locale } from "../../../i18n";
import { HeadingComponent } from "../../heading/heading_component";

const LOCALES: { key: Locale; flag: string }[] = [
  { key: "fr", flag: "🇨🇦" },
  { key: "en", flag: "🇨🇦" },
];

export class OptionsLanguageComponent extends EnhancedComponent {
  static template = xml`
    <div id="options-language-component">
      <HeadingComponent title="t('heading.language')" backPath="'/options'" />

      <ul class="options-language__list">
        <t t-foreach="locales" t-as="locale" t-key="locale.key">
          <li class="options-language__item">
            <button
              type="button"
              t-att-class="'options-language__btn' + (locale.key === currentLocale ? ' options-language__btn--active' : '')"
              t-att-aria-pressed="locale.key === currentLocale ? 'true' : 'false'"
              t-on-click="() => this.selectLocale(locale.key)"
            >
              <span class="options-language__flag" t-esc="locale.flag" aria-hidden="true" />
              <span class="options-language__name" t-esc="t('language.' + locale.key)" />
              <span t-if="locale.key === currentLocale" class="options-language__check" aria-hidden="true">✓</span>
            </button>
          </li>
        </t>
      </ul>

      <p class="options-language__note" t-esc="t('language.reload_note')" />
    </div>
  `;

  static components = { HeadingComponent };

  locales = LOCALES;
  currentLocale: Locale = getCurrentLocale();

  selectLocale(locale: Locale): void {
    if (locale !== this.currentLocale) {
      setLocale(locale);
    }
  }
}
