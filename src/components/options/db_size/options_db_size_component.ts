import { xml } from "@odoo/owl";
import { Dialog } from "@capacitor/dialog";
import { EnhancedComponent } from "../../../js/enhancedComponent";

export class OptionsDbSizeComponent extends EnhancedComponent {
	static template = xml`
    <li class="options-list__item">
      <a href="#" t-on-click.stop.prevent="onShowDbSizeClick" t-esc="t('button.sqlite_size')" />
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
				this.t("label.total_bytes", { bytes: `${totalBytes.toLocaleString()} (${kb} Ko / ${mb} Mo)` }),
			];
			if (pageCount > 0) {
				lines.push("", this.t("label.page_count", { count: String(pageCount) }), this.t("label.page_size", { size: String(pageSize) }));
			}
			lines.push(``, `--- Diagnostics ---`, ...diagnostics);
			message = lines.join("\n");
		} catch (error: unknown) {
			message = this.t("error.failed_to_read_size", { error: String(error) });
		}

		await Dialog.alert({
			title: this.t("dialog.title.sqlite_size"),
			message,
		});
	}
}
