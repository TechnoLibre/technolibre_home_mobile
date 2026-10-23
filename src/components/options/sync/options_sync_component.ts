import { useState, xml } from "@odoo/owl";

import { EnhancedComponent } from "../../../js/enhancedComponent";
import { isHttpAllowed, setHttpAllowed } from "../../../services/odoo/httpPolicy";

export class OptionsSyncComponent extends EnhancedComponent {
  static template = xml`
    <li id="sync" class="options-list__item options-sync">
      <div
        class="options-sync__header"
        role="button"
        tabindex="0"
        t-att-aria-expanded="state.expanded ? 'true' : 'false'"
        aria-controls="options-sync__body"
        t-on-click="toggleExpanded"
        t-on-keydown="(ev) => (ev.key === 'Enter' || ev.key === ' ') ? toggleExpanded() : null"
      >
        <span t-esc="t('button.odoo_sync')"/>
        <span aria-hidden="true" t-esc="state.expanded ? '▲' : '▼'" />
      </div>
      <div t-if="state.expanded" id="options-sync__body" class="options-sync__body">
        <p class="options-sync__info" t-esc="t('message.sync_config_info')" />
        <label class="options-sync__checkbox-label">
          <input type="checkbox" t-att-checked="state.allowHttp" t-on-change="onToggleHttp" />
          <t t-esc="t('sync.allow_http')"/>
        </label>
        <p class="options-sync__info" t-esc="t('sync.allow_http_hint')" />
        <button class="options-sync__btn options-sync__btn--add" t-on-click="goToApps" t-esc="t('button.go_to_applications')" />
      </div>
    </li>
  `;

  setup() {
    this.state = useState({ expanded: false, allowHttp: isHttpAllowed() });
  }

  /** Allows or refuses http:// servers for every sync request. */
  onToggleHttp(ev: Event) {
    const allowed = (ev.target as HTMLInputElement).checked;
    setHttpAllowed(allowed);
    this.state.allowHttp = isHttpAllowed();
  }

  toggleExpanded() {
    this.state.expanded = !this.state.expanded;
  }

  goToApps() {
    this.navigate("/applications");
  }
}
