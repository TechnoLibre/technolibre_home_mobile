import { xml } from "@odoo/owl";

import { EnhancedComponent } from "../../../js/enhancedComponent";

import { NoteEntryAudioComponent } from "./audio/note_entry_audio_component";
import { NoteEntryGeolocationComponent } from "./geolocation/note_entry_geolocation_component";
import { NoteEntryTextComponent } from "./text/note_entry_text_component";

export class NoteEntryComponent extends EnhancedComponent {
	static template = xml`
		<NoteEntryAudioComponent t-if="props.type === 'audio'" id="props.id" params="props.params" editMode="props.editMode" />
		<NoteEntryGeolocationComponent t-elif="props.type === 'geolocation'" id="props.id" params="props.params" editMode="props.editMode" />
		<NoteEntryTextComponent t-elif="props.type === 'text'" id="props.id" params="props.params" editMode="props.editMode" />
	`;

	static components = { NoteEntryAudioComponent, NoteEntryGeolocationComponent, NoteEntryTextComponent };
}
