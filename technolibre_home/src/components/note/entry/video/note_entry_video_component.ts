import { useState, xml } from "@odoo/owl";

import { VideoRecorder, VideoRecorderCamera, VideoRecorderPreviewFrame, VideoRecorderQuality } from "@capacitor-community/video-recorder";

import { EnhancedComponent } from "../../../../js/enhancedComponent";

import { NoteEntryDeleteComponent } from "../delete/note_entry_delete_component";
import { NoteEntryDragComponent } from "../drag/note_entry_drag_component";
import { Dialog } from "@capacitor/dialog";
import { Capacitor } from "@capacitor/core";
import { VideoNotSupportedOnWebError } from "../../../../js/errors";

import VideoOffIcon from "../../../../assets/icon/video_off.svg";
import { events } from "../../../../js/events";

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
					<div class="note-entry__video__thumbnail">
						<img src="${VideoOffIcon}" />
					</div>
				</div>
				<div class="note-entry__video__data">
					<div class="note-entry__video__data--new">
						<button
							class="note-entry__video__button"
							t-on-click.stop.prevent="onClickOpenCamera"
						>
							Ouvrir la caméra
						</button>
					</div>
					<div>
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
}
