import { xml } from "@odoo/owl";
import { Dialog } from "@capacitor/dialog";
import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";
import { EnhancedComponent } from "../../../js/enhancedComponent";

export class OptionsSecureStorageComponent extends EnhancedComponent {
	static template = xml`
    <li class="options-list__item">
      <a href="#" t-on-click.stop.prevent="onShowKeysClick">
        Clés SecureStorage
      </a>
    </li>
  `;

	async onShowKeysClick() {
		let message: string;

		try {
			const result = await SecureStoragePlugin.keys();
			const keys: string[] = result.value;

			if (keys.length === 0) {
				message = "Aucune clé présente dans le SecureStorage.";
			} else {
				const entries = await Promise.all(
					keys.map(async (key, i) => {
						try {
							const { value } = await SecureStoragePlugin.get({ key });
							return `${i + 1}. ${key} → ${value}`;
						} catch {
							return `${i + 1}. ${key} → (erreur de lecture)`;
						}
					})
				);
				message = entries.join("\n");
			}
		} catch (error: unknown) {
			message = `Erreur lors de la lecture du SecureStorage:\n${error}`;
		}

		await Dialog.alert({
			title: "SecureStorage — Clés",
			message,
		});
	}
}
