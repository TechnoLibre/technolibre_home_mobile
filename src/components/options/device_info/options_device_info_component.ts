import { xml } from "@odoo/owl";
import { Dialog } from "@capacitor/dialog";
import { Device } from "@capacitor/device";
import { App } from "@capacitor/app";
import { EnhancedComponent } from "../../../js/enhancedComponent";

export class OptionsDeviceInfoComponent extends EnhancedComponent {
	static template = xml`
    <li class="options-list__item">
      <a href="#" t-on-click.stop.prevent="onShowDeviceInfoClick">
        Infos appareil
      </a>
    </li>
  `;

	async onShowDeviceInfoClick() {
		let message: string;

		try {
			const [info, lang, appInfo] = await Promise.all([
				Device.getInfo(),
				Device.getLanguageCode(),
				App.getInfo().catch(() => null),
			]);

			const lines: string[] = [
				`Modèle : ${info.model}`,
				`Fabricant : ${info.manufacturer}`,
				`OS : ${info.operatingSystem} ${info.osVersion}`,
				`Plateforme : ${info.platform}`,
				`Langue : ${lang.value}`,
			];

			if (appInfo) {
				lines.push("");
				lines.push(`App : ${appInfo.name}`);
				lines.push(`Version : ${appInfo.version} (build ${appInfo.build})`);
				lines.push(`ID : ${appInfo.id}`);
			}

			message = lines.join("\n");
		} catch (error: unknown) {
			message = `Erreur lors de la lecture des infos appareil:\n${error}`;
		}

		await Dialog.alert({
			title: "Infos appareil",
			message,
		});
	}
}
