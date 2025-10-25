import { useState, xml } from "@odoo/owl";
import { EnhancedComponent } from "../../js/enhancedComponent";
import { events } from "../../js/events";
import { Capacitor } from "@capacitor/core";
import { VideoRecorder, VideoRecorderCamera, VideoRecorderPreviewFrame, VideoRecorderQuality } from "@capacitor-community/video-recorder";
import { VideoNotSupportedOnWebError } from "../../js/errors";
import { helpers } from "../../js/helpers";
import { ScreenOrientation } from "@capacitor/screen-orientation";
import { Dialog } from "@capacitor/dialog";

export class VideoCameraComponent extends EnhancedComponent {
	static template = xml`
		<div
			id="video-camera-component"
			t-att-class="{
				'active': props.active
			}"
		>
			<section id="video-camera__top-controls">
			</section>
			<section id="video-camera__bottom-controls">
				<button id="video-camera__close-camera" t-on-click.stop.prevent="closeCamera">
					Close
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
					Flip
				</button>
			</section>
		</div>
	`;

	static components = {};

	state: any = undefined;

	setup() {
		this.state = useState({ entryId: undefined, isRecording: false });
		this.listenForEvents();
	}

	async flipCamera() {
		await VideoRecorder.flipCamera();
	}

	onRecordButtonClick() {
		this.state.isRecording = !this.state.isRecording;
	}

	async closeCamera() {
		const entryId = this.state.entryId;

		this.state.entryId = undefined;

		this.eventBus.trigger(events.CLOSE_CAMERA, { entryId });
		await VideoRecorder.destroy();
	}

	private listenForEvents() {
		this.eventBus.addEventListener(events.OPEN_CAMERA, this.openCamera.bind(this));
		window.addEventListener("orientationchange", this.handleResize.bind(this));
	}

	private openCamera(event: any) {
		this.state.entryId = event?.detail?.entryId;
		this.initializeVideoRecorder();
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

		const back = previewFrames?.[0];

		VideoRecorder.initialize({
			camera: VideoRecorderCamera.BACK,
			quality: VideoRecorderQuality.HIGHEST,
			previewFrames
		});
	}

	private async getPreviewFrames(): Promise<Array<VideoRecorderPreviewFrame>> {
		const dimensions = this.getDimensions();

		const orientation = await ScreenOrientation.orientation();
		const type: OrientationType = orientation.type;

		let width, height, x, y;

		if (type === "portrait-primary" || type === "portrait-secondary") {
			width = dimensions.screenWidth;
			height = dimensions.screenHeight;
			x = 0;
			y = 0;
		} else {
			width = dimensions.screenHeight;
			height = dimensions.screenWidth;
			x = width / 2;
			y = 0;
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
}
