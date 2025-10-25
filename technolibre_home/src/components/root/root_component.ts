import { onMounted, useState, xml } from "@odoo/owl";

import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { EdgeToEdge } from "@capawesome/capacitor-android-edge-to-edge-support";
import { SplashScreen } from "@capacitor/splash-screen";
import { StatusBar, Style } from "@capacitor/status-bar";

import { Constants } from "../../js/constants";
import { EnhancedComponent } from "../../js/enhancedComponent";
import { StorageGetResult, StorageUtils } from "../../utils/storageUtils";

import { ContentComponent } from "../content/content_component";
import { NavbarComponent } from "../navbar/navbar_component";
import { VideoCameraComponent } from "../video_camera/video_camera_component";
import { events } from "../../js/events";

export class RootComponent extends EnhancedComponent {
	static template = xml`
    <main
			id="main"
			t-att-class="{
				'hidden': state.isCameraOpen
			}"
		>
      <ContentComponent />
      <NavbarComponent />
    </main>
		<VideoCameraComponent
			active="state.isCameraOpen"
		/>
  `;

	static components = { ContentComponent, NavbarComponent, VideoCameraComponent };

	setup() {
		this.state = useState({ title: "This is my title", isCameraOpen: false });
		onMounted(() => {
			SplashScreen.hide();
		});
		this.enableEdgeToEdge();
		this.setupAndroidBackButton();
		this.setDefaultBiometryStorageValue();
		this.setDefaultAppStorageValue();
		this.setDefaultNoteStorageValue();
		this.listenForEvents();
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

	private async setDefaultNoteStorageValue() {
		const getResult: StorageGetResult = await StorageUtils.getValueByKey(Constants.NOTES_STORAGE_KEY);

		if (!getResult.keyExists) {
			await StorageUtils.setKeyValuePair(Constants.NOTES_STORAGE_KEY, []);
		}
	}

	private listenForEvents() {
		this.eventBus.addEventListener(events.OPEN_CAMERA, this.showCamera.bind(this));
		this.eventBus.addEventListener(events.CLOSE_CAMERA, this.hideCamera.bind(this));
	}

	private showCamera(_event: any) {
		this.state.isCameraOpen = true;
	}

	private hideCamera(_event: any) {
		this.state.isCameraOpen = false;
	}
}
