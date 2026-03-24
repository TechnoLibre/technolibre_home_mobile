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
      message: "=== 2026.03.18.01 ===\nAdded:\n- SQLite backend with AES-256 encryption\n- Biometric protection for DB key (opt-in)\n- Versioned migration system + notification\n- Boot screen with init progress\n- Options sub-pages with breadcrumbs\n- SQLite DB size diagnostic\n- Video: HTML5 overlay playback\n- Video: thumbnail (first frame, cached)\n- Video: thumbnail backfill migration\n- Video: auto-open camera on new entry\n- Photo: capture + fullscreen viewer\n- Photo: auto-open camera on new entry\n- Geolocation: open native map button\nFixed:\n- Stale listeners causing ghost entries\n- Video camera opening on all note views\n- Race condition on photo camera open\n\n=== 2025.12.28.01 ===\nAdded:\n- Application management (add/edit/delete)\n- Notes with text, audio, video, photo,\n  and geolocation entries\n- Tags and labels for notes\n- Data stored in SecureStorage",
    });
  }
}
