import { onWillDestroy, useState, useRef, onMounted, onPatched, xml } from "@odoo/owl";

import { Capacitor } from "@capacitor/core";
import { Camera } from "@capacitor/camera";
import { ScreenOrientation } from "@capacitor/screen-orientation";
import { SafeArea } from "capacitor-plugin-safe-area";
import { VideoRecorder, VideoRecorderCamera, VideoRecorderPreviewFrame, VideoRecorderQuality } from "@capacitor-community/video-recorder";
import type { PluginListenerHandle } from "@capacitor/core";

import { EnhancedComponent } from "../../js/enhancedComponent";
import { Events } from "../../constants/events";
import { VideoNotSupportedOnWebError } from "../../js/errors";
import { OcrPlugin } from "../../plugins/ocrPlugin";
import type { TextBlock } from "../../plugins/ocrPlugin";

import CloseIcon from "../../assets/icon/close.svg";
import FlipCameraAndroidIcon from "../../assets/icon/flip_camera_android.svg";

export class VideoCameraComponent extends EnhancedComponent {
    // Module-level constants exposed to the static template so the xml`...`
    // literal stays interpolation-free and AOT-precompilable.
    closeIcon = CloseIcon;
    flipCameraAndroidIcon = FlipCameraAndroidIcon;

	static template = xml`
		<div id="video-camera-component">
			<!-- OCR text-highlight canvas — always in DOM, drawn only when AI is active -->
			<canvas t-ref="ocr-canvas" id="video-camera__ocr-canvas" />

			<section id="video-camera__top-controls">
				<button
					id="video-camera__ai-toggle"
					t-att-class="{ 'ai-active': state.isAiActive }"
					t-on-click.stop.prevent="toggleAi"
					title="Détection de texte IA"
				>
					<span class="ai-icon">◉</span>
					<span class="ai-label">IA</span>
				</button>
			</section>
			<section id="video-camera__bottom-controls">
				<button id="video-camera__close-camera" t-on-click.stop.prevent="closeCamera">
					<img t-att-src="closeIcon" />
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
					<img t-att-src="flipCameraAndroidIcon" />
				</button>
			</section>
		</div>
	`;

	// ── Canvas ref & OCR state ────────────────────────────────────────────────

	private canvasRef = useRef<HTMLCanvasElement>("ocr-canvas");
	private ocrListener: PluginListenerHandle | null = null;
	private lastBlocks: TextBlock[] = [];

	// ── Lifecycle ─────────────────────────────────────────────────────────────

	setup() {
		this.state = useState({ isRecording: false, isAiActive: false });
		this.initializeVideoRecorder();
		this.listenForEvents();

		onMounted(() => this.setupCanvas());
		onPatched(() => this.redrawCanvas());
		onWillDestroy(() => this.cleanup());
	}

	// ── Public methods ────────────────────────────────────────────────────────

	async flipCamera() {
		await VideoRecorder.flipCamera();
	}

	async onRecordButtonClick() {
		const isRecording = this.state.isRecording;
		this.state.isRecording = !isRecording;

		if (!isRecording) {
			this.startRecording();
		} else {
			await this.stopRecording();
		}
	}

	async toggleAi() {
		if (this.state.isAiActive) {
			await this.stopAi();
		} else {
			await this.startAi();
		}
	}

	async closeCamera() {
		await this.stopAi();
		await VideoRecorder.destroy();
		this.eventBus.trigger(Events.CLOSE_CAMERA, { entryId: this.props.entryId });
	}

	async initializeVideoRecorder() {
		if (Capacitor.getPlatform() === "web") {
			throw new VideoNotSupportedOnWebError();
		}

		const { camera } = await Camera.requestPermissions({ permissions: ["camera"] });
		if (camera !== "granted") {
			await this.closeCamera();
			return;
		}

		const previewFrames: Array<VideoRecorderPreviewFrame> = await this.getPreviewFrames();

		await VideoRecorder.initialize({
			camera: VideoRecorderCamera.BACK,
			quality: VideoRecorderQuality.HIGHEST,
			previewFrames
		});
	}

	// ── Private: recording ────────────────────────────────────────────────────

	private async startRecording() {
		VideoRecorder.startRecording();
	}

	private async stopRecording() {
		const result = await VideoRecorder.stopRecording();
		this.eventBus.trigger(Events.SET_VIDEO_RECORDING, {
			entryId: this.props.entryId,
			path: result.videoUrl
		});
		await this.closeCamera();
	}

	// ── Private: AI / OCR ────────────────────────────────────────────────────

	private async startAi() {
		if (!Capacitor.isNativePlatform()) return;
		this.state.isAiActive = true;
		this.lastBlocks = [];

		this.ocrListener = await OcrPlugin.addListener("textDetected", (data) => {
			this.lastBlocks = data.blocks;
			this.drawBlocks(data.blocks);
		});

		await OcrPlugin.startScan({ intervalMs: 900 });
	}

	private async stopAi() {
		this.state.isAiActive = false;
		this.lastBlocks = [];
		this.clearCanvas();

		if (this.ocrListener) {
			await this.ocrListener.remove();
			this.ocrListener = null;
		}

		if (Capacitor.isNativePlatform()) {
			await OcrPlugin.stopScan();
		}
	}

	private async cleanup() {
		await this.stopAi();
	}

	// ── Private: canvas drawing ───────────────────────────────────────────────

	private setupCanvas() {
		const canvas = this.canvasRef.el;
		if (!canvas) return;
		this.resizeCanvas(canvas);
	}

	private redrawCanvas() {
		if (!this.state.isAiActive || this.lastBlocks.length === 0) return;
		this.drawBlocks(this.lastBlocks);
	}

	private resizeCanvas(canvas: HTMLCanvasElement) {
		// Use physical pixels for crisp rendering on high-DPI screens
		const dpr = window.devicePixelRatio || 1;
		canvas.width  = window.innerWidth  * dpr;
		canvas.height = window.innerHeight * dpr;
		canvas.style.width  = `${window.innerWidth}px`;
		canvas.style.height = `${window.innerHeight}px`;
	}

	private clearCanvas() {
		const canvas = this.canvasRef.el;
		if (!canvas) return;
		const ctx = canvas.getContext("2d");
		if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
	}

	private drawBlocks(blocks: TextBlock[]) {
		const canvas = this.canvasRef.el;
		if (!canvas) return;

		this.resizeCanvas(canvas);
		const ctx = canvas.getContext("2d");
		if (!ctx) return;

		const W = canvas.width;
		const H = canvas.height;

		ctx.clearRect(0, 0, W, H);

		for (const block of blocks) {
			const x = block.x * W;
			const y = block.y * H;
			const w = block.width  * W;
			const h = block.height * H;

			// Semi-transparent yellow highlight
			ctx.fillStyle = "rgba(255, 220, 0, 0.25)";
			ctx.fillRect(x, y, w, h);

			// Gold border
			ctx.strokeStyle = "rgba(255, 200, 0, 0.9)";
			ctx.lineWidth = 2 * (window.devicePixelRatio || 1);
			ctx.strokeRect(x, y, w, h);

			// Label background
			const fontSize = Math.max(11, 11 * (window.devicePixelRatio || 1));
			const labelH   = fontSize + 6;
			const labelW   = Math.min(w, 280 * (window.devicePixelRatio || 1));
			ctx.fillStyle = "rgba(0, 0, 0, 0.72)";
			ctx.fillRect(x, y - labelH, labelW, labelH);

			// Label text
			ctx.fillStyle = "#ffe066";
			ctx.font      = `${fontSize}px sans-serif`;
			const label   = block.text.length > 40 ? block.text.slice(0, 40) + "…" : block.text;
			ctx.fillText(label, x + 3, y - 4);
		}
	}

	// ── Private: misc ─────────────────────────────────────────────────────────

	private listenForEvents() {
		window.addEventListener("orientationchange", this.handleResize.bind(this));
	}

	private async handleResize() {
		await VideoRecorder.destroy();
		await this.initializeVideoRecorder();
	}

	private async getPreviewFrames(): Promise<Array<VideoRecorderPreviewFrame>> {
		const dimensions = this.getDimensions();
		const orientation = await ScreenOrientation.orientation();
		const type: OrientationType = orientation.type;
		const topSafeArea = await this.getTopSafeArea();

		let width, height, x, y;

		if (type === "portrait-primary" || type === "portrait-secondary") {
			width  = dimensions.screenWidth;
			height = dimensions.screenHeight;
			x = 0;
			y = topSafeArea;
		} else {
			width  = dimensions.screenHeight;
			height = dimensions.screenWidth;
			x = width / 2;
			y = topSafeArea;
		}

		const back: VideoRecorderPreviewFrame = {
			id: "back",
			stackPosition: "back",
			width,
			height,
			x,
			y,
			borderRadius: 0
		};

		return [back];
	}

	private getDimensions(): Record<string, any> {
		return { screenWidth: window.innerWidth, screenHeight: window.innerHeight };
	}

	private async getTopSafeArea(): Promise<number> {
		const result = await SafeArea.getSafeAreaInsets();
		return result.insets.top;
	}
}
