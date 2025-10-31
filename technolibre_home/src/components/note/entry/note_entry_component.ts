import { xml } from "@odoo/owl";

import { EnhancedComponent } from "../../../js/enhancedComponent";

import { NoteEntryAudioComponent } from "./audio/note_entry_audio_component";
import { NoteEntryDateComponent } from "./date/note_entry_date_component";
import { NoteEntryGeolocationComponent } from "./geolocation/note_entry_geolocation_component";
import { NoteEntryPhotoComponent } from "./photo/note_entry_photo_component";
import { NoteEntryTextComponent } from "./text/note_entry_text_component";
import { NoteEntryVideoComponent } from "./video/note_entry_video_component";
import { NoteEntryDragComponent } from "./drag/note_entry_drag_component";
import { NoteEntryDeleteComponent } from "./delete/note_entry_delete_component";

export class NoteEntryComponent extends EnhancedComponent {
	static template = xml`
		<div
			class="note-entry-component"
			t-att-data-id="props.id"
			t-attf-class="note-entry-{{props.type}}-component"
		>
			<NoteEntryDeleteComponent id="props.id" editMode="props.editMode" deleteEntry.bind="props.deleteEntry" />
			<div
				class="note-entry__content"
			>
				<t
					t-component="getComponent()"
					id="props.id"
					params="props.params"
					editMode="props.editMode"
					deleteEntry.bind="props.deleteEntry"
				/>
			</div>
			<NoteEntryDragComponent editMode="props.editMode" />
		</div>
	`;

	static components = {
		NoteEntryDragComponent,
		NoteEntryDeleteComponent,
		NoteEntryAudioComponent,
		NoteEntryDateComponent,
		NoteEntryGeolocationComponent,
		NoteEntryPhotoComponent,
		NoteEntryTextComponent,
		NoteEntryVideoComponent
	};

	getComponent() {
		switch (this.props.type) {
			case "audio":
				return NoteEntryAudioComponent;
			case "date":
				return NoteEntryDateComponent;
			case "geolocation":
				return NoteEntryGeolocationComponent;
			case "photo":
				return NoteEntryPhotoComponent;
			case "text":
				return NoteEntryTextComponent;
			case "video":
				return NoteEntryVideoComponent;
		}
	}
}
