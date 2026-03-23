import { xml } from "@odoo/owl";
import { Dialog } from "@capacitor/dialog";
import { EnhancedComponent } from "../../../js/enhancedComponent";

export class OptionsDbSizeComponent extends EnhancedComponent {
	static template = xml`
    <li class="options-list__item">
      <a href="#" t-on-click.stop.prevent="onShowDbSizeClick">
        Taille base SQLite
      </a>
    </li>
  `;

	async onShowDbSizeClick() {
		let message: string;

		try {
			const { pageCount, pageSize, totalBytes } =
				await this.databaseService.getDbSize();

			const kb = (totalBytes / 1024).toFixed(1);
			const mb = (totalBytes / 1024 / 1024).toFixed(3);

			message = [
				`Pages : ${pageCount}`,
				`Taille page : ${pageSize} octets`,
				`Total : ${totalBytes} octets`,
				`       ${kb} Ko`,
				`       ${mb} Mo`,
			].join("\n");
		} catch (error: unknown) {
			message = `Erreur lors de la lecture de la taille:\n${error}`;
		}

		await Dialog.alert({
			title: "SQLite — Taille de la base",
			message,
		});
	}
}
