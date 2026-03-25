import { xml } from "@odoo/owl";

import { EnhancedComponent } from "../../../js/enhancedComponent";
import { HeadingComponent } from "../../heading/heading_component";
import { OptionsDbSizeComponent } from "../db_size/options_db_size_component";
import { OptionsSecureStorageComponent } from "../secure_storage/options_secure_storage_component";
import { OptionsSQLiteTablesComponent } from "../sqlite_tables/options_sqlite_tables_component";

const BREADCRUMBS = [{ label: "Options", url: "/options" }];

export class OptionsDatabaseComponent extends EnhancedComponent {
	static template = xml`
    <div id="options-component">
      <HeadingComponent title="'Base de données'" breadcrumbs="breadcrumbs" />
      <ul id="options-list">
        <OptionsSQLiteTablesComponent />
        <OptionsDbSizeComponent />
        <OptionsSecureStorageComponent />
      </ul>
    </div>
  `;

	static components = {
		HeadingComponent,
		OptionsSQLiteTablesComponent,
		OptionsDbSizeComponent,
		OptionsSecureStorageComponent,
	};

	get breadcrumbs() {
		return BREADCRUMBS;
	}
}
