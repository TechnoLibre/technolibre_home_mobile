import { useState, xml } from "@odoo/owl";

import { Capacitor } from "@capacitor/core";
import { ScreenOrientation } from "@capacitor/screen-orientation";
import { SafeArea } from "capacitor-plugin-safe-area";
import { VideoRecorder, VideoRecorderCamera, VideoRecorderPreviewFrame, VideoRecorderQuality } from "@capacitor-community/video-recorder";

import { EnhancedComponent } from "../../js/enhancedComponent";
import { events } from "../../js/events";
import { VideoNotSupportedOnWebError } from "../../js/errors";

import CloseIcon from "../../assets/icon/close.svg";
import FlipCameraAndroidIcon from "../../assets/icon/flip_camera_android.svg";

export class VideoCameraComponent extends EnhancedComponent {
	static template = xml`
		<div id="video-camera-component">
			<section id="video-camera__top-controls">
			</section>
			<section id="video-camera__bottom-controls">
				<button id="video-camera__close-camera" t-on-click.stop.prevent="closeCamera">
					<img src="${CloseIcon}" />
				</button>
				<button
					id="video-camera__record"
					t-att-class="{
						'recording': state.isRecording
					}"
					t-on-click.stop.prevent="onRecordButtonClick"
				>
				</button>
				<button id="video-camera__flip-camera" t-on-click.stop.prevent="flipCamera">
					<img src="${FlipCameraAndroidIcon}" />
				</button>
			</section>
		</div>
	`;

	static components = {};

	state: any = undefined;

	setup() {
		this.state = useState({ entryId: undefined, isRecording: false });
		this.initializeVideoRecorder();
		this.listenForEvents();
	}

	async flipCamera() {
		await VideoRecorder.flipCamera();
	}

	onRecordButtonClick() {
		const isRecording = this.state.isRecording;

		this.state.isRecording = !isRecording;

		!isRecording ? this.startRecording() : this.stopRecording();
	}

	private async startRecording() {
		VideoRecorder.startRecording();
	}

	private async stopRecording() {
		const result = await VideoRecorder.stopRecording();
		
		this.eventBus.trigger(events.SET_VIDEO_RECORDING, {
			entryId: this.state.entryId,
			path: result.videoUrl
		});
	}

	async closeCamera() {
		await VideoRecorder.destroy();
		this.eventBus.trigger(events.CLOSE_CAMERA, { entryId: this.state.entryId });
	}

	private listenForEvents() {
		this.eventBus.addEventListener(events.OPEN_CAMERA, this.openCamera.bind(this));
		window.addEventListener("orientationchange", this.handleResize.bind(this));
	}

	private openCamera(event: any) {
		this.state.entryId = event?.detail?.entryId;
	}

	private async handleResize() {
		await VideoRecorder.destroy();
		await this.initializeVideoRecorder();
	}

	async initializeVideoRecorder() {
		if (Capacitor.getPlatform() === "web") {
			throw new VideoNotSupportedOnWebError();
		}

		const previewFrames: Array<VideoRecorderPreviewFrame> = await this.getPreviewFrames();

		await VideoRecorder.initialize({
			camera: VideoRecorderCamera.BACK,
			quality: VideoRecorderQuality.HIGHEST,
			previewFrames
		});
	}

	private async getPreviewFrames(): Promise<Array<VideoRecorderPreviewFrame>> {
		const dimensions = this.getDimensions();

		const orientation = await ScreenOrientation.orientation();
		const type: OrientationType = orientation.type;

		const topSafeArea = await this.getTopSafeArea();

		let width, height, x, y;

		if (type === "portrait-primary" || type === "portrait-secondary") {
			width = dimensions.screenWidth;
			height = dimensions.screenHeight;
			x = 0;
			y = topSafeArea;
		} else {
			width = dimensions.screenHeight;
			height = dimensions.screenWidth;
			x = width / 2;
			y = topSafeArea;
		}

		const back: VideoRecorderPreviewFrame = {
			id: 'back',
			stackPosition: 'back',
			width,
			height,
			x,
			y,
			borderRadius: 0
		};

		return [back];
	}

	private getDimensions(): Record<string, any> {
		const screenWidth = window.innerWidth;
		const screenHeight = window.innerHeight;

		return { screenWidth, screenHeight };
	}

	private async getTopSafeArea(): Promise<number> {
		const result = await SafeArea.getSafeAreaInsets();
		return result.insets.top;
	}
}
