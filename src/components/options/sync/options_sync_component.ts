import { useState, xml } from "@odoo/owl";

import { EnhancedComponent } from "../../../js/enhancedComponent";

export class OptionsSyncComponent extends EnhancedComponent {
  static template = xml`
    <li class="options-list__item options-sync">
      <div class="options-sync__header" t-on-click="toggleExpanded">
        <span>Synchronisation Odoo</span>
        <span t-esc="state.expanded ? '▲' : '▼'" />
      </div>
      <div t-if="state.expanded" class="options-sync__body">
        <p class="options-sync__info">
          La configuration de synchronisation se fait directement dans la liste
          des <strong>Applications</strong>. Appuyez sur le crayon d'une
          application pour configurer la base de données et les options de
          synchronisation automatique.
        </p>
        <button class="options-sync__btn options-sync__btn--add" t-on-click="goToApps">
          Aller aux Applications ›
        </button>
      </div>
    </li>
  `;

  setup() {
    this.state = useState({ expanded: false });
  }

  toggleExpanded() {
    this.state.expanded = !this.state.expanded;
  }

  goToApps() {
    this.navigate("/applications");
  }
}
