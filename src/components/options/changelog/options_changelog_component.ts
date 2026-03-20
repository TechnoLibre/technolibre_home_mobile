import { xml } from "@odoo/owl";
import { Dialog } from "@capacitor/dialog";
import { EnhancedComponent } from "../../../js/enhancedComponent";

export class OptionsChangelogComponent extends EnhancedComponent {
  static template = xml`
    <li class="options-list__item">
      <a href="#" t-on-click.stop.prevent="onChangelogClick">
        Version 2026.03
      </a>
    </li>
  `;

  async onChangelogClick() {
    await Dialog.alert({
      title: "Changelog — 2026.03",
      message: "Added:\n- SQLite database backend\n- Versioned migration system\n- Migration notification popup\n\nChanged:\n- Data is now stored in SQLite instead of SecureStorage",
    });
  }
}
