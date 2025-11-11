import { xml } from "@odoo/owl";

import { CapacitorVideoPlayer } from "@chrismclarke/capacitor-video-player";

import { EnhancedComponent } from "../../../js/enhancedComponent";
import { Events } from "../../../constants/events";

import VideoOffIcon from "../../../assets/icon/video_off.svg";

export class NoteEntryVideoComponent extends EnhancedComponent {
	static template = xml`
		<div
			class="note-entry__wrapper"
			t-att-class="{
				'not-empty': props.params.path
			}"
		>
			<div class="note-entry__video__thumbnail__wrapper">
				<div
					class="note-entry__video__thumbnail"
				>
					<img src="${VideoOffIcon}" />
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
	`;

	async onClickOpenCamera() {
		this.eventBus.trigger(Events.OPEN_CAMERA, {
			entryId: this.props.id
		});
	}

	async onClickOpenVideo() {
		await CapacitorVideoPlayer.initPlayer({
			url: this.getNativePath(this.props.params.path),
			playerId: this.getPlayerId(),
			mode: "fullscreen",
			componentTag: "video-player__wrapper"
		});

		await CapacitorVideoPlayer.play({ playerId: this.getPlayerId() });
	}

	getPlayerId() {
		return `${this.props.id}-player`;
	}

	getNativePath(capacitorUrl: string) {
		return capacitorUrl.replace("https://localhost/_capacitor_file_/", "file:///");
	}
}
