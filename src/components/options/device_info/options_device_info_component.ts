import { onMounted, onWillDestroy, useState, xml } from "@odoo/owl";
import { Dialog } from "@capacitor/dialog";
import { Device } from "@capacitor/device";
import { App } from "@capacitor/app";
import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";
import { EnhancedComponent } from "../../../js/enhancedComponent";
import { Events } from "../../../constants/events";
import { StorageConstants } from "../../../constants/storage";

const CLICKS_REQUIRED = 10;
const RESET_DELAY_MS = 2000;

export class OptionsDeviceInfoComponent extends EnhancedComponent {
	static template = xml`
    <t>
      <li class="options-list__item">
        <a href="#" t-on-click.stop.prevent="onShowDeviceInfoClick" t-esc="t('button.device_info')" />
      </li>
      <li class="options-list__item">
        <a href="#" t-on-click.stop.prevent="onResourcesClick" t-esc="t('button.system_resources')" />
      </li>
      <li t-if="!state.devModeEnabled"
          class="options-list__item options-list__item--dev-unlock"
          t-att-class="devUnlockClass"
          t-on-click="onDevModeClick">
        <t t-if="state.clicks === 0" t-esc="t('button.unlock_dev_mode')"/>
        <t t-else=""><t t-esc="CLICKS_REQUIRED - state.clicks" /></t>
      </li>
    </t>
  `;

	CLICKS_REQUIRED = CLICKS_REQUIRED;

	state: any;
	_resetTimer: ReturnType<typeof setTimeout> | null = null;

	setup() {
		this.state = useState({ devModeEnabled: false, clicks: 0 });

		onMounted(async () => {
			try {
				const stored = await SecureStoragePlugin.get({ key: StorageConstants.DEV_MODE_UNLOCKED_KEY });
				if (stored.value === "true") this.state.devModeEnabled = true;
			} catch {
				// not set yet
			}
		});

		onWillDestroy(() => {
			if (this._resetTimer) clearTimeout(this._resetTimer);
		});
	}

	get devUnlockClass(): string {
		const c = this.state.clicks;
		if (c === 0) return "";
		if (c >= CLICKS_REQUIRED - 1) return "dev-unlock--imminent";
		if (c >= CLICKS_REQUIRED - 3) return "dev-unlock--warning";
		return "dev-unlock--counting";
	}

	async onDevModeClick() {
		if (this._resetTimer) clearTimeout(this._resetTimer);

		this.state.clicks += 1;

		if (this.state.clicks >= CLICKS_REQUIRED) {
			this.state.clicks = 0;
			this.state.devModeEnabled = true;
			await SecureStoragePlugin.set({
				key: StorageConstants.DEV_MODE_UNLOCKED_KEY,
				value: "true",
			});
			this.eventBus.trigger(Events.DEV_MODE_UNLOCKED, {});
			return;
		}

		this._resetTimer = setTimeout(() => {
			this.state.clicks = 0;
		}, RESET_DELAY_MS);
	}

	onResourcesClick() {
		this.navigate("/options/resources");
	}

	async onShowDeviceInfoClick() {
		let message: string;

		try {
			const [info, lang, appInfo] = await Promise.all([
				Device.getInfo(),
				Device.getLanguageCode(),
				App.getInfo().catch(() => null),
			]);

			const lines: string[] = [
				this.t("label.device_model", { model: info.model }),
				this.t("label.device_manufacturer", { manufacturer: info.manufacturer }),
				this.t("label.device_os", { os: info.operatingSystem, version: info.osVersion }),
				this.t("label.device_platform", { platform: info.platform }),
				this.t("label.device_language", { lang: lang.value }),
			];

			if (appInfo) {
				lines.push("");
				lines.push(this.t("label.app_name", { name: appInfo.name }));
				lines.push(this.t("label.app_version", { version: appInfo.version, build: appInfo.build }));
				lines.push(this.t("label.app_id", { id: appInfo.id }));
			}

			message = lines.join("\n");
		} catch (error: unknown) {
			message = this.t("error.failed_to_read_device_info", { error: String(error) });
		}

		await Dialog.alert({
			title: this.t("dialog.title.device_info"),
			message,
		});
	}
}
