import { xml } from "@odoo/owl";
import { Dialog } from "@capacitor/dialog";
import { Geolocation } from "@capacitor/geolocation";
import { Camera } from "@capacitor/camera";
import { EnhancedComponent } from "../../../js/enhancedComponent";
import { t } from "../../../i18n";

function label(status: string): string {
	const map: Record<string, string> = {
		granted: t("permission.granted"),
		denied: t("permission.denied"),
		prompt: t("permission.prompt"),
		"prompt-with-rationale": t("permission.prompt_with_rationale"),
	};
	return map[status] ?? status;
}

export class OptionsPermissionsComponent extends EnhancedComponent {
	static template = xml`
    <li class="options-list__item">
      <a href="#" t-on-click.stop.prevent="onShowPermissionsClick" t-esc="t('button.permissions')" />
    </li>
  `;

	async onShowPermissionsClick() {
		let message: string;

		try {
			const [geo, cam] = await Promise.all([
				Geolocation.checkPermissions().catch(() => null),
				Camera.checkPermissions().catch(() => null),
			]);

			const lines: string[] = [];

			if (geo) {
				lines.push(`${this.t("label.gps_precise")}  : ${label(geo.location)}`);
				lines.push(`${this.t("label.gps_approximate")} : ${label(geo.coarseLocation)}`);
			} else {
				lines.push(this.t("label.gps_unavailable"));
			}

			lines.push("");

			if (cam) {
				lines.push(`${this.t("label.camera")}   : ${label(cam.camera)}`);
				lines.push(`${this.t("label.photos")}   : ${label(cam.photos)}`);
			} else {
				lines.push(this.t("label.camera_unavailable"));
			}

			message = lines.join("\n");
		} catch (error: unknown) {
			message = `${this.t("label.error")}: ${error}`;
		}

		await Dialog.alert({
			title: this.t("dialog.title.permissions"),
			message,
		});
	}
}
