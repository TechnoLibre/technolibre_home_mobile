import { onMounted, useState, xml } from "@odoo/owl";

import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { EdgeToEdge } from "@capawesome/capacitor-android-edge-to-edge-support";
import { SplashScreen } from "@capacitor/splash-screen";
import { StatusBar, Style } from "@capacitor/status-bar";

import { EnhancedComponent } from "../../js/enhancedComponent";
import { StorageConstants } from "../../constants/storage";
import { StorageGetResult, StorageUtils } from "../../utils/storageUtils";

import { ContentComponent } from "../content/content_component";
import { NavbarComponent } from "../navbar/navbar_component";
import { VideoCameraComponent } from "../video_camera/video_camera_component";
import { Events } from "../../constants/events";

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
			t-if="state.isCameraOpen"
		/>
		<div id="video-player__wrapper"></div>
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
		const getResult: StorageGetResult = await StorageUtils.getValueByKey(StorageConstants.BIOMETRY_ENABLED_STORAGE_KEY);

		if (!getResult.keyExists) {
			await StorageUtils.setKeyValuePair(StorageConstants.BIOMETRY_ENABLED_STORAGE_KEY, false);
		}
	}

	private async setDefaultAppStorageValue() {
		const getResult: StorageGetResult = await StorageUtils.getValueByKey(StorageConstants.APPLICATIONS_STORAGE_KEY);

		if (!getResult.keyExists) {
			await StorageUtils.setKeyValuePair(StorageConstants.APPLICATIONS_STORAGE_KEY, []);
		}
	}

	private async setDefaultNoteStorageValue() {
		const getResult: StorageGetResult = await StorageUtils.getValueByKey(StorageConstants.NOTES_STORAGE_KEY);

		if (!getResult.keyExists) {
			await StorageUtils.setKeyValuePair(StorageConstants.NOTES_STORAGE_KEY, []);
		}
	}

	private listenForEvents() {
		this.eventBus.addEventListener(Events.OPEN_CAMERA, this.showCamera.bind(this));
		this.eventBus.addEventListener(Events.CLOSE_CAMERA, this.hideCamera.bind(this));
	}

	private showCamera(_event: any) {
		this.state.isCameraOpen = true;
	}

	private hideCamera(_event: any) {
		this.state.isCameraOpen = false;
	}
}
