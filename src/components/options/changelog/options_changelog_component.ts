import { xml } from "@odoo/owl";
import { Dialog } from "@capacitor/dialog";
import { EnhancedComponent } from "../../../js/enhancedComponent";
import { versionToDisplay } from "../../../services/migrationService";

const CURRENT_VERSION = 2026031801;

export class OptionsChangelogComponent extends EnhancedComponent {
  static template = xml`
    <li class="options-list__item">
      <a href="#" t-on-click.stop.prevent="onChangelogClick">
        Version <t t-esc="currentVersion"/>
      </a>
    </li>
  `;

  get currentVersion() {
    return versionToDisplay(CURRENT_VERSION);
  }

  async onChangelogClick() {
    await Dialog.alert({
      title: `Changelog — ${versionToDisplay(CURRENT_VERSION)}`,
      message: "Added:\n- SQLite database backend\n- Versioned migration system\n- Migration notification popup\n- SQLite AES-256 encryption\n- Biometric protection for database key (opt-in)\n\nChanged:\n- Data is now stored in SQLite instead of SecureStorage",
    });
  }
}
