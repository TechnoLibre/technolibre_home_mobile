import { xml } from "@odoo/owl";
import { Dialog } from "@capacitor/dialog";
import { EnhancedComponent } from "../../../js/enhancedComponent";

export class OptionsSQLiteTablesComponent extends EnhancedComponent {
	static template = xml`
    <li class="options-list__item">
      <a href="#" t-on-click.stop.prevent="onShowTablesClick">
        Tables SQLite
      </a>
    </li>
  `;

	async onShowTablesClick() {
		let message: string;

		try {
			const tables: string[] = await this.databaseService.getTableNames();

			if (tables.length === 0) {
				message = "Aucune table présente dans la base SQLite.";
			} else {
				message = tables.map((name, i) => `${i + 1}. ${name}`).join("\n");
			}
		} catch (error: unknown) {
			message = `Erreur lors de la lecture de la base SQLite:\n${error}`;
		}

		await Dialog.alert({
			title: "SQLite — Tables",
			message,
		});
	}
}
