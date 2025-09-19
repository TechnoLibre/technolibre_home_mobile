import { onMounted, useState, xml } from "@odoo/owl";

import { SplashScreen } from "@capacitor/splash-screen";
import { App } from "@capacitor/app";
import { EdgeToEdge } from "@capawesome/capacitor-android-edge-to-edge-support";
import { StatusBar, Style } from "@capacitor/status-bar";

import { Constants } from "../../js/constants";
import { EnhancedComponent } from "../../js/enhancedComponent";
import { StorageGetResult, StorageUtils } from "../../utils/storageUtils";

import { ContentComponent } from "../content/content_component";
import { NavbarComponent } from "../navbar/navbar_component";
import { Capacitor } from "@capacitor/core";

export class RootComponent extends EnhancedComponent {
	static template = xml`
    <main id="main">
      <ContentComponent />
      <NavbarComponent />
    </main>
  `;

	static components = { ContentComponent, NavbarComponent };

	setup() {
		this.state = useState({ title: "This is my title" });
		onMounted(() => {
			SplashScreen.hide();
		});
		this.enableEdgeToEdge();
		this.setupAndroidBackButton();
		this.setDefaultBiometryStorageValue();
		this.setDefaultAppStorageValue();
	}

	private async enableEdgeToEdge() {
		if (Capacitor.getPlatform() === "android") {
			await EdgeToEdge.enable();
			await EdgeToEdge.setBackgroundColor({ color: "#000000" });
			StatusBar.setStyle({ style: Style.Dark });
		}
	}

	private setupAndroidBackButton() {
		App.addListener("backButton", data => {
			if (data.canGoBack) {
				window.history.back();
			} else {
				App.exitApp();
			}
		});
	}

	private async setDefaultBiometryStorageValue() {
		const getResult: StorageGetResult = await StorageUtils.getValueByKey(Constants.BIOMETRY_ENABLED_STORAGE_KEY);

		if (!getResult.keyExists) {
			await StorageUtils.setKeyValuePair(Constants.BIOMETRY_ENABLED_STORAGE_KEY, false);
		}
	}

	private async setDefaultAppStorageValue() {
		const getResult: StorageGetResult = await StorageUtils.getValueByKey(Constants.APPLICATIONS_STORAGE_KEY);

		if (!getResult.keyExists) {
			await StorageUtils.setKeyValuePair(Constants.APPLICATIONS_STORAGE_KEY, []);
		}
	}
}
