import { xml } from "@odoo/owl";

import { EnhancedComponent } from "../../../../js/enhancedComponent";

import { NoteEntryDragComponent } from "../drag/note_entry_drag_component";

import PlayIcon from "../../../../assets/icon/play.svg";

export class NoteEntryAudioComponent extends EnhancedComponent {
	static template = xml`
		<div
			class="note-entry-component note-entry-audio-component"
			t-att-data-id="props.id"
		>
			<div class="note-entry__content">
				<button
					type="button"
					class="note-entry--audio__play"
					t-on-click.stop.prevent="playAudio"
				>
					<img src="${PlayIcon}" />
				</button>
			</div>
			<NoteEntryDragComponent editMode="props.editMode" />
		</div>
	`;

	static components = { NoteEntryDragComponent };

	playAudio() {
		console.log("Playing audio");
	}
}
