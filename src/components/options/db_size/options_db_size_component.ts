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
			const { pageCount, pageSize, totalBytes, diagnostics } =
				await this.databaseService.getDbSize();

			const kb = (totalBytes / 1024).toFixed(1);
			const mb = (totalBytes / 1024 / 1024).toFixed(2);

			const lines = [
				`Total : ${totalBytes.toLocaleString()} octets`,
				`        ${kb} Ko`,
				`        ${mb} Mo`,
			];
			if (pageCount > 0) {
				lines.push(``, `Pages : ${pageCount}`, `Taille page : ${pageSize} octets`);
			}
			lines.push(``, `--- Diagnostics ---`, ...diagnostics);
			message = lines.join("\n");
		} catch (error: unknown) {
			message = `Erreur lors de la lecture de la taille:\n${error}`;
		}

		await Dialog.alert({
			title: "SQLite — Taille de la base",
			message,
		});
	}
}
