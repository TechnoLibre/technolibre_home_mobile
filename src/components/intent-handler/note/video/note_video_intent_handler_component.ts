import { onMounted, useRef, useState, xml } from "@odoo/owl";

import { Capacitor } from "@capacitor/core";

import { EnhancedComponent } from "../../../../js/enhancedComponent";
import { VideoIntent } from "../../../../models/intent";

const ENV = {
    // @ts-ignore
    TITLE: import.meta.env.VITE_TITLE ?? "TITLE",
    // @ts-ignore
    LABEL_NOTE: import.meta.env.VITE_LABEL_NOTE ?? "Note",
    // @ts-ignore
    LOGO_KEY: import.meta.env.VITE_LOGO_KEY ?? "techno",
    // @ts-ignore
    WEBSITE_URL: import.meta.env.VITE_WEBSITE_URL ?? "https://erplibre.ca",
    // @ts-ignore
    DEBUG_DEV: import.meta.env.VITE_DEBUG_DEV === "true",
};

export class NoteVideoIntentHandlerComponent extends EnhancedComponent {
	static template = xml`
		<div id="note-video-intent-handler-component">
			<h1 class="intent__title">Ajouter une video</h1>
			<video
				class="intent__thumbnail"
				t-att-style="videoDataStyle"
				t-att-data-orientation="state.orientation"
				t-ref="video"
				controls=""
			>
				<source t-att-src="state.videoUri"/>
			</video>
			<h3 class="intent__notes__title">${ENV.LABEL_NOTE}s</h3>
			<ul class="intent__notes">
				<li
					class="intent__item intent__item--new"
					t-on-click.stop.prevent="newNoteWithVideo"
				>
					Nouvelle ${ENV.LABEL_NOTE} avec cette video
				</li>
				<li
					class="intent__item"
					t-foreach="state.notes"
					t-as="note"
					t-key="note.id"
					t-att-data-id="note.id"
					t-on-click.stop.prevent="event => this.addVideoToNote(event)"
				>
					<p class="intent__item__title" t-if="note.title">
						<t t-esc="note.title"></t>
					</p>
					<p class="intent__item__title--empty" t-else="">
						Sans titre
					</p>
				</li>
			</ul>
		</div>
	`;

	static components = {};

	state: any = undefined;

	videoRef = useRef("video");

	setup() {
		onMounted(this.onMounted.bind(this));
		this.state = useState({
			videoUri: "",
			orientation: "landscape",
			aspectRatio: 16 / 9,
			notes: []
		});
		this.getVideoUri();
		this.getNotes();
	}

	newNoteWithVideo() {
		const intent = this.props.intent;

		if (!intent || !(intent instanceof VideoIntent)) {
			return;
		}

		this.noteService.intent.newNoteWithVideo(intent);
		this.props.goHome();
	}

	addVideoToNote(event: Event) {
		const id = (event.target as HTMLElement).dataset.id;
		const intent = this.props.intent;

		if (!id || !intent || !(intent instanceof VideoIntent)) {
			return;
		}

		this.noteService.intent.addVideoToNote(id, intent);
		this.props.goHome();
	}

	public async getVideoUri() {
		if (!this.props.intent?.url) {
			return "";
		}

		const result = Capacitor.convertFileSrc(this.props.intent.url);

		this.state.videoUri = result;
	}

	public async getNotes() {
		this.state.notes = await this.noteService.getNotes();
	}

	public get videoDataStyle(): string {
		return `--aspect-ratio: ${this.state.aspectRatio}`;
	}

	public setVideoData() {
		if (!this.videoRef.el) {
			return;
		}

		const video = this.videoRef.el as HTMLVideoElement;
		const width = video.videoWidth;
		const height = video.videoHeight;

		console.log(`${width}x${height}`);

		if (width > height) {
			this.state.orientation = "landscape";
			this.state.aspectRatio = width / height;
		} else {
			this.state.orientation = "portrait";
			this.state.aspectRatio = height / width;
		}
	};

	private onMounted() {
		if (!this.videoRef.el) {
			return;
		}

		this.videoRef.el.addEventListener("loadedmetadata", this.setVideoData.bind(this))
	}
}
