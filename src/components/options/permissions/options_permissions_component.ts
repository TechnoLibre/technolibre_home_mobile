import { xml } from "@odoo/owl";
import { Dialog } from "@capacitor/dialog";
import { Geolocation } from "@capacitor/geolocation";
import { Camera } from "@capacitor/camera";
import { Capacitor } from "@capacitor/core";
import { SmsGatewayPlugin } from "../../../plugins/smsGatewayPlugin";
import { EnhancedComponent } from "../../../js/enhancedComponent";
import { t } from "../../../i18n";

/** Les permissions SMS sont des booleens, pas un etat a quatre valeurs. */
function etat(accordee: boolean): string {
	return accordee ? t("permission.granted") : t("permission.denied");
}

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
    <li id="permissions" class="options-list__item">
      <a href="#" t-on-click.stop.prevent="onShowPermissionsClick" t-esc="t('button.permissions')" />
    </li>
  `;

	async onShowPermissionsClick() {
		let message: string;

		try {
			const [geo, cam, sms] = await Promise.all([
				Geolocation.checkPermissions().catch(() => null),
				Camera.checkPermissions().catch(() => null),
				// La passerelle SMS ne vit que sur l'appareil : sur le web,
				// le greffon n'existe pas et l'absence n'est pas une panne.
				Capacitor.isNativePlatform()
					? SmsGatewayPlugin.getCapabilities().catch(() => null)
					: Promise.resolve(null),
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

			lines.push("");

			if (sms) {
				lines.push(
					`${this.t("label.sms_send")}    : ${etat(sms.hasSendPermission)}`,
				);
				lines.push(
					`${this.t("label.sms_receive")} : ${etat(sms.hasReceivePermission)}`,
				);
			} else {
				lines.push(this.t("label.sms_unavailable"));
			}

			message = lines.join("\n");

			// Les SMS sont les seules que cet ecran puisse DEMANDER : les
			// autres passent par leur propre greffon, et le droit d'envoyer
			// un SMS ne s'obtenait jusqu'ici que depuis l'ecran de la
			// passerelle — introuvable pour qui cherche ses permissions ici.
			if (sms && !(sms.hasSendPermission && sms.hasReceivePermission)) {
				const { value } = await Dialog.confirm({
					title: this.t("dialog.title.permissions"),
					message: `${message}\n\n${this.t("dialog.sms_permission_ask")}`,
				});
				if (value) {
					const apres = await SmsGatewayPlugin.requestSmsPermissions();
					message = [
						`${this.t("label.sms_send")}    : ${etat(apres.hasSendPermission)}`,
						`${this.t("label.sms_receive")} : ${etat(apres.hasReceivePermission)}`,
					].join("\n");
					if (!apres.hasSendPermission) {
						message += `\n\n${this.t("label.sms_permission_refused")}`;
					}
				}
			}
		} catch (error: unknown) {
			message = `${this.t("label.error")}: ${error}`;
		}

		await Dialog.alert({
			title: this.t("dialog.title.permissions"),
			message,
		});
	}
}
