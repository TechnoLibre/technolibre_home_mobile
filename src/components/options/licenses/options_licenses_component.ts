import { useState, xml } from "@odoo/owl";

import { EnhancedComponent } from "../../../js/enhancedComponent";
import lamejsLicense from "../../../assets/licenses/breezystack-lamejs.LICENSE.txt?raw";
import lgplText from "../../../assets/licenses/LGPL-3.0.txt?raw";
import gplText from "../../../assets/licenses/GPL-3.0.txt?raw";

/** One bundled third-party library whose licence asks to be named in the app. */
export interface ThirdPartyNotice {
    name: string;
    version: string;
    license: string;
    /** Where the library's source can be read. */
    sourceUrl: string;
    /** The notice from the library's authors, as the package ships it. */
    authorsNotice: string;
    /** The full licence text, and the text of the licence it builds on. */
    licenseText: string;
    baseLicenseName: string;
    baseLicenseText: string;
    /** The work the library derives from, whose authors ask to be acknowledged with a link; absent when none. */
    basedOn?: { name: string; url: string };
}

/**
 * The libraries the app bundles under a licence that requires a notice. The
 * MP3 encoder of the chat voice messages is LGPL-3.0 and is linked as a
 * separate module of the bundle, which the licence allows when the app names
 * it and links to its source.
 */
export const THIRD_PARTY_NOTICES: ThirdPartyNotice[] = [
    {
        name: "@breezystack/lamejs",
        version: "1.2.7",
        license: "LGPL-3.0",
        sourceUrl: "https://github.com/shijinyu/lamejs",
        authorsNotice: lamejsLicense,
        licenseText: lgplText,
        baseLicenseName: "GPL-3.0",
        baseLicenseText: gplText,
        basedOn: { name: "LAME", url: "https://lame.sourceforge.net" },
    },
];

/** The Options entry that lists the bundled third-party libraries with their licence. */
export class OptionsLicensesComponent extends EnhancedComponent {
    static template = xml`
    <li id="licenses" class="options-list__item options-sync">
      <div
        class="options-sync__header"
        role="button"
        tabindex="0"
        t-att-aria-expanded="state.expanded ? 'true' : 'false'"
        aria-controls="options-licenses__body"
        t-on-click="toggleExpanded"
        t-on-keydown="(ev) => (ev.key === 'Enter' || ev.key === ' ') ? toggleExpanded() : null"
      >
        <span t-esc="t('options.licenses')"/>
        <span aria-hidden="true" t-esc="state.expanded ? '▲' : '▼'" />
      </div>
      <div t-if="state.expanded" id="options-licenses__body" class="options-sync__body">
        <p class="options-sync__info" t-esc="t('options.licenses_intro')"/>
        <t t-foreach="notices" t-as="notice" t-key="notice.name">
          <h4 t-esc="notice.name + ' ' + notice.version + ' — ' + notice.license"/>
          <p class="options-sync__info" t-esc="t('options.licenses_use', {name: notice.name, license: notice.license})"/>
          <p class="options-sync__info">
            <a t-att-href="notice.sourceUrl" target="_blank" rel="noreferrer noopener"
               t-esc="t('options.licenses_source') + ' ' + notice.sourceUrl"/>
          </p>
          <p t-if="notice.basedOn" class="options-sync__info">
            <t t-esc="t('options.licenses_based_on', {name: notice.basedOn.name})"/>
            <a t-att-href="notice.basedOn.url" target="_blank" rel="noreferrer noopener" t-esc="notice.basedOn.url"/>
          </p>
          <h5 t-esc="t('options.licenses_authors')"/>
          <pre class="options-licenses__text" t-esc="notice.authorsNotice"/>
          <h5 t-esc="notice.license"/>
          <pre class="options-licenses__text" t-esc="notice.licenseText"/>
          <button class="chat-new__chip" t-att-aria-expanded="state.base ? 'true' : 'false'"
                  t-on-click="toggleBase" t-esc="t('options.licenses_base', {name: notice.baseLicenseName})"/>
          <pre t-if="state.base" class="options-licenses__text" t-esc="notice.baseLicenseText"/>
        </t>
      </div>
    </li>
  `;

    setup() {
        this.state = useState({ expanded: false, base: false });
    }

    get notices(): ThirdPartyNotice[] {
        return THIRD_PARTY_NOTICES;
    }

    toggleBase(): void {
        this.state.base = !this.state.base;
    }

    toggleExpanded(): void {
        this.state.expanded = !this.state.expanded;
    }
}
