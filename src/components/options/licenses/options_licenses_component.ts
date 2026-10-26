import { useState, xml } from "@odoo/owl";

import { EnhancedComponent } from "../../../js/enhancedComponent";
import lamejsLicense from "../../../assets/licenses/breezystack-lamejs.LICENSE.txt?raw";

/** One bundled third-party library whose licence asks to be named in the app. */
export interface ThirdPartyNotice {
    name: string;
    version: string;
    license: string;
    /** Where the library's source can be read. */
    sourceUrl: string;
    /** The licence text the package ships, bundled as an asset. */
    licenseText: string;
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
        licenseText: lamejsLicense,
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
          <pre class="options-licenses__text" t-esc="notice.licenseText"/>
        </t>
      </div>
    </li>
  `;

    setup() {
        this.state = useState({ expanded: false });
    }

    get notices(): ThirdPartyNotice[] {
        return THIRD_PARTY_NOTICES;
    }

    toggleExpanded(): void {
        this.state.expanded = !this.state.expanded;
    }
}
