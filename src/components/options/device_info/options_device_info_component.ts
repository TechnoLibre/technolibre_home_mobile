import { onMounted, onWillDestroy, useState, xml } from "@odoo/owl";
import { Dialog } from "@capacitor/dialog";
import { Device } from "@capacitor/device";
import { App } from "@capacitor/app";
import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";
import { EnhancedComponent } from "../../../js/enhancedComponent";
import { NetworkScanPlugin } from "../../../plugins/networkScanPlugin";
import { Events } from "../../../constants/events";
import { StorageConstants } from "../../../constants/storage";

const CLICKS_REQUIRED = 10;
const RESET_DELAY_MS = 2000;

export class OptionsDeviceInfoComponent extends EnhancedComponent {
	static template = xml`
    <t>
      <li class="options-list__item">
        <a href="#" t-on-click.stop.prevent="onShowDeviceInfoClick">
          📱 Infos appareil
        </a>
      </li>
      <li class="options-list__item">
        <a href="#" t-on-click.stop.prevent="onResourcesClick">
          📊 Ressources système
        </a>
      </li>
      <li t-if="!state.devModeEnabled"
          class="options-list__item options-list__item--dev-unlock"
          t-att-class="devUnlockClass"
          t-on-click="onDevModeClick">
        <t t-if="state.clicks === 0">🔧 Activer mode dev</t>
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
			const [info, lang, appInfo, ifaces] = await Promise.all([
				Device.getInfo(),
				Device.getLanguageCode(),
				App.getInfo().catch(() => null),
				NetworkScanPlugin.listInterfaces().catch(() => ({ interfaces: [] })),
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

			// Network interfaces — show only the ones that are up and
			// have at least one address. Loopback shown last when
			// nothing else is up so the user always gets some readout.
			const upWithAddrs = ifaces.interfaces.filter(
				(i) => i.up && !i.loopback && i.addresses.length > 0,
			);
			if (upWithAddrs.length > 0) {
				lines.push("");
				lines.push("Réseau :");
				for (const iface of upWithAddrs) {
					const label = iface.displayName && iface.displayName !== iface.name
						? `${iface.name} (${iface.displayName})`
						: iface.name;
					lines.push(`  ${label}${iface.mac ? ` — ${iface.mac}` : ""}`);
					for (const a of iface.addresses) {
						lines.push(`    ${a.family === "ipv4" ? "v4" : "v6"} ${a.ip}/${a.prefixLength}`);
					}
				}
			} else if (ifaces.interfaces.length > 0) {
				lines.push("");
				lines.push("Réseau : aucune interface active");
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
