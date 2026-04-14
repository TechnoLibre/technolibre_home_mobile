import { onMounted, onWillDestroy, useState, xml } from "@odoo/owl";
import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";
import { EnhancedComponent } from "../../js/enhancedComponent";
import { Events } from "../../constants/events";
import { StorageConstants } from "../../constants/storage";

// @ts-ignore
const IS_DEBUG_BUILD = import.meta.env.VITE_DEBUG_DEV === "true";

import { HeadingComponent } from "../heading/heading_component";
import { OptionsClearCacheComponent } from "./clear_cache/options_clear_cache_component";
import { OptionsToggleBiometryComponent } from "./options_toggle_biometry_component.ts/options_toggle_biometry_component";
import { OptionsChangelogComponent } from "./changelog/options_changelog_component";
import { OptionsDeviceInfoComponent } from "./device_info/options_device_info_component";
import { OptionsPermissionsComponent } from "./permissions/options_permissions_component";
import { OptionsMigrationHistoryComponent } from "./migration_history/options_migration_history_component";
import { OptionsSyncComponent } from "./sync/options_sync_component";
import { OptionsRemindersComponent } from "./reminders/options_reminders_component";
import { OptionsGraphicComponent } from "./graphic/options_graphic_component";
import { OptionsErplibreComponent } from "./erplibre/options_erplibre_component";
import { OptionsTranscriptionComponent } from "./transcription/options_transcription_component";
import { OptionsProcessesComponent } from "./processes/options_processes_component";
import { OptionsCodeComponent } from "./code/options_code_component";

export class OptionsComponent extends EnhancedComponent {
	static template = xml`
    <div id="options-component">
      <HeadingComponent title="'Options'" />
      <ul id="options-list" aria-label="Options">
        <OptionsClearCacheComponent />
        <OptionsToggleBiometryComponent />
        <li class="options-list__item" t-if="state.isDebug">
          <a href="#" role="button" aria-label="Base de données" t-on-click.stop.prevent="onDatabaseClick">
            🗄️ Base de données ›
          </a>
        </li>
        <OptionsPermissionsComponent />
        <OptionsDeviceInfoComponent />
        <OptionsMigrationHistoryComponent />
        <OptionsSyncComponent />
        <OptionsRemindersComponent />
        <OptionsGraphicComponent />
        <OptionsChangelogComponent />
        <li class="options-list__item">
          <a href="#" role="button" aria-label="Transcription audio" t-on-click.stop.prevent="onTranscriptionClick">
            🎙️ Transcription audio ›
          </a>
        </li>
        <li class="options-list__item">
          <a href="#" role="button" aria-label="Processus" t-on-click.stop.prevent="onProcessesClick">
            ⚙️ Processus ›
          </a>
        </li>
        <li class="options-list__item">
          <a href="#" role="button" aria-label="Code" t-on-click.stop.prevent="onCodeClick">
            💻 Code ›
          </a>
        </li>
        <li class="options-list__item">
          <a href="#" role="button" aria-label="ERPLibre" t-on-click.stop.prevent="onErplibreClick">
            🏠 ERPLibre ›
          </a>
        </li>
      </ul>
    </div>
  `;

	setup() {
		this.state = useState({ isDebug: IS_DEBUG_BUILD });

		onMounted(async () => {
			if (!IS_DEBUG_BUILD) {
				try {
					const stored = await SecureStoragePlugin.get({ key: StorageConstants.DEV_MODE_UNLOCKED_KEY });
					if (stored.value === "true") this.state.isDebug = true;
				} catch {
					// not unlocked yet
				}
			}
			this.eventBus.addEventListener(Events.DEV_MODE_UNLOCKED, this._onDevModeUnlocked);
		});

		onWillDestroy(() => {
			this.eventBus.removeEventListener(Events.DEV_MODE_UNLOCKED, this._onDevModeUnlocked);
		});
	}

	_onDevModeUnlocked = () => {
		this.state.isDebug = true;
	};

	onDatabaseClick() {
		this.navigate("/options/database");
	}

	onTranscriptionClick() {
		this.navigate("/options/transcription");
	}

	onProcessesClick() {
		this.navigate("/options/processes");
	}

	onCodeClick() {
		this.navigate("/options/code");
	}

	onErplibreClick() {
		this.navigate("/options/erplibre");
	}

	static components = {
		HeadingComponent,
		OptionsClearCacheComponent,
		OptionsToggleBiometryComponent,
		OptionsChangelogComponent,
		OptionsDeviceInfoComponent,
		OptionsPermissionsComponent,
		OptionsMigrationHistoryComponent,
		OptionsSyncComponent,
		OptionsRemindersComponent,
		OptionsGraphicComponent,
		OptionsErplibreComponent,
		OptionsTranscriptionComponent,
		OptionsProcessesComponent,
		OptionsCodeComponent,
	};
}
