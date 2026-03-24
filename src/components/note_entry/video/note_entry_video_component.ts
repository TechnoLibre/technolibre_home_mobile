import { useState, xml } from "@odoo/owl";

import { Capacitor } from "@capacitor/core";
import { NoteEntryVideoParams } from "../../../models/note";

import { EnhancedComponent } from "../../../js/enhancedComponent";
import { Events } from "../../../constants/events";

import VideoOffIcon from "../../../assets/icon/video_off.svg";
import CloseIcon from "../../../assets/icon/close.svg";

export class NoteEntryVideoComponent extends EnhancedComponent {
	static template = xml`
		<div
			class="note-entry__wrapper"
			t-att-class="{
				'not-empty': props.params.path
			}"
		>
			<div class="note-entry__video__thumbnail__wrapper">
				<div class="note-entry__video__thumbnail">
					<img
						t-if="getThumbnailSrc()"
						t-att-src="getThumbnailSrc()"
						class="note-entry__video__thumbnail__img"
					/>
					<img t-else="" src="${VideoOffIcon}" />
				</div>
			</div>
			<div class="note-entry__video__data">
				<button
					class="note-entry__video__button note-entry__video__open-camera"
					t-on-click.stop.prevent="onClickOpenCamera"
				>
					Ouvrir la caméra
				</button>
				<button
					class="note-entry__video__button note-entry__video__open-video"
					t-if="props.params.path"
					t-on-click.stop.prevent="onClickOpenVideo"
				>
					Ouvrir la vidéo
				</button>
			</div>
		</div>
		<div t-if="state.showVideo" class="note-entry__video__overlay">
			<button class="note-entry__video__overlay__close" t-on-click.stop.prevent="onClickCloseVideo">
				<img src="${CloseIcon}" />
			</button>
			<video
				class="note-entry__video__overlay__player"
				t-att-src="state.videoSrc"
				autoplay="true"
				controls="true"
				playsinline="true"
			/>
		</div>
	`;

	setup() {
		this.state = useState({ showVideo: false, videoSrc: "" });
	}

	async onClickOpenCamera() {
		this.eventBus.trigger(Events.OPEN_CAMERA, {
			entryId: this.props.id
		});
	}

	onClickOpenVideo() {
		this.state.videoSrc = Capacitor.convertFileSrc(this.props.params.path);
		this.state.showVideo = true;
	}

	onClickCloseVideo() {
		this.state.showVideo = false;
		this.state.videoSrc = "";
	}

	getThumbnailSrc(): string | undefined {
		const params = this.props.params as NoteEntryVideoParams;
		if (!params.thumbnailPath) return undefined;
		return Capacitor.convertFileSrc(params.thumbnailPath);
	}
}
