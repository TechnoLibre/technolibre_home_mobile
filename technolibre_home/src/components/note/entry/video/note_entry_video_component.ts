import { useState, xml } from "@odoo/owl";

import { CapacitorVideoPlayer } from "@chrismclarke/capacitor-video-player";

import { EnhancedComponent } from "../../../../js/enhancedComponent";
import { events } from "../../../../js/events";

import { NoteEntryDeleteComponent } from "../delete/note_entry_delete_component";
import { NoteEntryDragComponent } from "../drag/note_entry_drag_component";

import VideoOffIcon from "../../../../assets/icon/video_off.svg";

export class NoteEntryVideoComponent extends EnhancedComponent {
	static template = xml`
		<div
			class="note-entry-component note-entry-video-component"
			t-att-data-id="props.id"
		>
			<NoteEntryDeleteComponent id="props.id" editMode="props.editMode" deleteEntry.bind="props.deleteEntry" />
			<div
				class="note-entry__content"
			>
				<div class="note-entry__video__thumbnail__wrapper">
					<div
						class="note-entry__video__thumbnail"
					>
						<img src="${VideoOffIcon}" />
					</div>
				</div>
				<div class="note-entry__video__data">
					<div class="note-entry__video__data--new" t-if="!props.params.path">
						<button
							class="note-entry__video__button"
							t-on-click.stop.prevent="onClickOpenCamera"
						>
							Ouvrir la caméra
						</button>
					</div>
					<div class="note-entry__video__data--recorded" t-else="">
						<button
							class="note-entry__video__button"
							t-on-click.stop.prevent="onClickOpenVideo"
						>
							Ouvrir la vidéo
						</button>
					</div>
				</div>
			</div>
			<NoteEntryDragComponent editMode="props.editMode" />
		</div>
	`;

	static components = { NoteEntryDeleteComponent, NoteEntryDragComponent };

	state: any = undefined;

	setup() {
		this.state = useState({});
	}

	async onClickOpenCamera() {
		this.eventBus.trigger(events.OPEN_CAMERA, {
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
