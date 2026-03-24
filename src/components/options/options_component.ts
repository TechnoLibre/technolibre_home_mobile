import { xml } from "@odoo/owl";

import { EnhancedComponent } from "../../js/enhancedComponent";

import { HeadingComponent } from "../heading/heading_component";
import { OptionsClearCacheComponent } from "./clear_cache/options_clear_cache_component";
import { OptionsToggleBiometryComponent } from "./options_toggle_biometry_component.ts/options_toggle_biometry_component";
import { OptionsChangelogComponent } from "./changelog/options_changelog_component";
import { OptionsDeviceInfoComponent } from "./device_info/options_device_info_component";
import { OptionsPermissionsComponent } from "./permissions/options_permissions_component";
import { OptionsMigrationHistoryComponent } from "./migration_history/options_migration_history_component";

export class OptionsComponent extends EnhancedComponent {
	static template = xml`
    <div id="options-component">
      <HeadingComponent title="'Options'" />
      <ul id="options-list">
        <OptionsClearCacheComponent />
        <OptionsToggleBiometryComponent />
        <li class="options-list__item">
          <a href="#" t-on-click.stop.prevent="() => navigate('/options/database')">
            Base de données ›
          </a>
        </li>
        <OptionsPermissionsComponent />
        <OptionsDeviceInfoComponent />
        <OptionsMigrationHistoryComponent />
        <OptionsChangelogComponent />
      </ul>
    </div>
  `;

	static components = {
		HeadingComponent,
		OptionsClearCacheComponent,
		OptionsToggleBiometryComponent,
		OptionsChangelogComponent,
		OptionsDeviceInfoComponent,
		OptionsPermissionsComponent,
		OptionsMigrationHistoryComponent,
	};
}
