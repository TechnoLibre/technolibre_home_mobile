import { xml } from "@odoo/owl";

// @ts-ignore
const IS_DEBUG = import.meta.env.VITE_DEBUG_DEV === "true";

import { EnhancedComponent } from "../../js/enhancedComponent";

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

export class OptionsComponent extends EnhancedComponent {
	static template = xml`
    <div id="options-component">
      <HeadingComponent title="'Options'" />
      <ul id="options-list">
        <OptionsClearCacheComponent />
        <OptionsToggleBiometryComponent />
        <li class="options-list__item" t-if="isDebug">
          <a href="#" t-on-click.stop.prevent="onDatabaseClick">
            Base de données ›
          </a>
        </li>
        <OptionsPermissionsComponent />
        <OptionsDeviceInfoComponent />
        <OptionsMigrationHistoryComponent />
        <OptionsSyncComponent />
        <OptionsRemindersComponent />
        <OptionsGraphicComponent />
        <OptionsChangelogComponent />
      </ul>
    </div>
  `;

	get isDebug() {
		return IS_DEBUG;
	}

	onDatabaseClick() {
		this.navigate("/options/database");
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
	};
}
