import { onWillDestroy, useState, xml } from "@odoo/owl";

import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { StatusBar, Style } from "@capacitor/status-bar";

import { EnhancedComponent } from "../../js/enhancedComponent";
import { Events } from "../../constants/events";
import { StorageConstants } from "../../constants/storage";
import { StorageGetResult, StorageUtils } from "../../utils/storageUtils";

import { ContentComponent } from "../content/content_component";
import { NavbarComponent } from "../navbar/navbar_component";
import { VideoCameraComponent } from "../video_camera/video_camera_component";

export class RootComponent extends EnhancedComponent {
	static template = xml`
		<t t-if="state.isLoadingApps or state.isSaving">
			<div class="app-status-overlay">
				<div class="app-status-spinner"></div>
				<t t-if="state.isLoadingApps">Loading…</t>
				<t t-elif="state.isSaving">Saving…</t>
			</div>
		</t>
		<main
			id="main"
			t-att-class="{
				'hidden': state.isCameraOpen
			}"
		>
			<ContentComponent />
			<NavbarComponent />
		</main>
		<t t-if="state.isLoadingApps or state.isSaving">
			<div class="app-status-overlay">
				<div class="app-status-spinner"></div>
				<t t-if="state.isLoadingApps">Loading…</t>
				<t t-elif="state.isSaving">Saving…</t>
			</div>
		</t>
		<div t-if="state.syncBanner" class="sync-banner">
			<span>☁ <t t-esc="state.syncBannerCount"/> modification(s) disponible(s) depuis Odoo</span>
			<button class="sync-banner__btn" t-on-click="onSyncBannerSync">Sync</button>
			<button class="sync-banner__close" t-on-click="onSyncBannerDismiss">✕</button>
		</div>
		<VideoCameraComponent
			t-if="state.isCameraOpen"
			entryId="state.videoEntryId"
		/>
		<div id="video-player__wrapper"></div>
	`;

	static components = { ContentComponent, NavbarComponent, VideoCameraComponent };

	setup() {
		this.state = useState({
			title: "This is my title",
			isCameraOpen: false,
			videoEntryId: undefined,
			syncBanner: false,
			syncBannerCount: 0,
			syncBannerCreds: null as any,
		});
		this.enableEdgeToEdge();
		this.setupAndroidBackButton();
		this.setDefaultBiometryStorageValue();
		this.listenForEvents();
	}

	async onSyncBannerSync() {
		this.state.syncBanner = false;
		if (!this.state.syncBannerCreds) return;
		try {
			await this.syncService.pullNotes(this.state.syncBannerCreds, new Date(0));
			this.eventBus.trigger(Events.RELOAD_NOTES);
		} catch (e) {
			console.warn("[sync banner] pull failed:", e);
		}
	}

	onSyncBannerDismiss() {
		this.state.syncBanner = false;
	}

	private async enableEdgeToEdge() {
		if (Capacitor.getPlatform() === "android") {
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

	private listenForEvents() {
		const onOpenCamera = this.showCamera.bind(this);
		const onCloseCamera = this.hideCamera.bind(this);
		const onSyncChanges = this.showSyncBanner.bind(this);
		this.eventBus.addEventListener(Events.OPEN_CAMERA, onOpenCamera);
		this.eventBus.addEventListener(Events.CLOSE_CAMERA, onCloseCamera);
		this.eventBus.addEventListener(Events.SYNC_CHANGES_DETECTED, onSyncChanges);
		onWillDestroy(() => {
			this.eventBus.removeEventListener(Events.OPEN_CAMERA, onOpenCamera);
			this.eventBus.removeEventListener(Events.CLOSE_CAMERA, onCloseCamera);
			this.eventBus.removeEventListener(Events.SYNC_CHANGES_DETECTED, onSyncChanges);
		});
	}

	private showSyncBanner(event: any) {
		const { count, creds } = event?.detail ?? {};
		this.state.syncBannerCount = count ?? 0;
		this.state.syncBannerCreds = creds ?? null;
		this.state.syncBanner = true;
		// Auto-dismiss after 8 seconds
		setTimeout(() => { this.state.syncBanner = false; }, 8000);
	}

	private showCamera(event: any) {
		this.state.isCameraOpen = true;
		this.state.videoEntryId = event?.detail?.entryId;
	}

	private hideCamera(_event: any) {
		this.state.isCameraOpen = false;
		this.state.videoEntryId = undefined;
	}
}