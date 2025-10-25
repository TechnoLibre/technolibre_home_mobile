import { xml } from "@odoo/owl";

import { EnhancedComponent } from "../../../js/enhancedComponent";

import { NoteEntryAudioComponent } from "./audio/note_entry_audio_component";
import { NoteEntryDateComponent } from "./date/note_entry_date_component";
import { NoteEntryGeolocationComponent } from "./geolocation/note_entry_geolocation_component";
import { NoteEntryTextComponent } from "./text/note_entry_text_component";
import { NoteEntryVideoComponent } from "./video/note_entry_video_component";

export class NoteEntryComponent extends EnhancedComponent {
	static template = xml`
		<NoteEntryAudioComponent
			t-if="props.type === 'audio'"
			id="props.id"
			params="props.params"
			editMode="props.editMode"
			deleteEntry.bind="props.deleteEntry"
		/>
		<NoteEntryDateComponent
			t-if="props.type === 'date'"
			id="props.id"
			params="props.params"
			editMode="props.editMode"
			deleteEntry.bind="props.deleteEntry"
		/>
		<NoteEntryGeolocationComponent
			t-elif="props.type === 'geolocation'"
			id="props.id"
			params="props.params"
			editMode="props.editMode"
			deleteEntry.bind="props.deleteEntry"
		/>
		<NoteEntryTextComponent
			t-elif="props.type === 'text'"
			id="props.id"
			params="props.params"
			editMode="props.editMode"
			deleteEntry.bind="props.deleteEntry"
		/>
		<NoteEntryVideoComponent
			t-elif="props.type === 'video'"
			id="props.id"
			params="props.params"
			editMode="props.editMode"
			deleteEntry.bind="props.deleteEntry"
		/>
	`;

	static components = {
		NoteEntryAudioComponent,
		NoteEntryDateComponent,
		NoteEntryGeolocationComponent,
		NoteEntryTextComponent,
		NoteEntryVideoComponent
	};
}
