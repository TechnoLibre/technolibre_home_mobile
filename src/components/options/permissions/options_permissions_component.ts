import { xml } from "@odoo/owl";
import { Dialog } from "@capacitor/dialog";
import { Geolocation } from "@capacitor/geolocation";
import { Camera } from "@capacitor/camera";
import { EnhancedComponent } from "../../../js/enhancedComponent";

const STATUS_LABEL: Record<string, string> = {
	granted: "✓ accordée",
	denied: "✗ refusée",
	prompt: "? à demander",
	"prompt-with-rationale": "? à demander (avec justification)",
};

function label(status: string): string {
	return STATUS_LABEL[status] ?? status;
}

export class OptionsPermissionsComponent extends EnhancedComponent {
	static template = xml`
    <li id="permissions" class="options-list__item">
      <a href="#" t-on-click.stop.prevent="onShowPermissionsClick">
        🛡️ Permissions
      </a>
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
				lines.push(`GPS (précis)  : ${label(geo.location)}`);
				lines.push(`GPS (approx.) : ${label(geo.coarseLocation)}`);
			} else {
				lines.push("GPS : indisponible");
			}

			lines.push("");

			if (cam) {
				lines.push(`Caméra   : ${label(cam.camera)}`);
				lines.push(`Photos   : ${label(cam.photos)}`);
			} else {
				lines.push("Caméra : indisponible");
			}

			message = lines.join("\n");
		} catch (error: unknown) {
			message = `Erreur lors de la vérification des permissions:\n${error}`;
		}

		await Dialog.alert({
			title: "Permissions",
			message,
		});
	}
}
