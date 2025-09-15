import { Component, useState, xml } from "@odoo/owl";

import { NoteEntryAudioComponent } from "./audio/note_entry_audio_component";
import { NoteEntryTextComponent } from "./text/note_entry_text_component";
import { NoteEntryTitleComponent } from "./title/note_entry_title_component";

export class NoteEntryComponent extends Component {
	static template = xml`
		<NoteEntryAudioComponent t-if="props.type === 'audio'" params="props.params" editMode="props.editMode" />
		<NoteEntryTextComponent t-elif="props.type === 'text'" params="props.params" editMode="props.editMode" />
		<NoteEntryTitleComponent t-elif="props.type === 'title'" params="props.params" editMode="props.editMode" />
	`;

	static components = { NoteEntryAudioComponent, NoteEntryTextComponent, NoteEntryTitleComponent };

	state: any = undefined;

	setup() {
		this.state = useState({});
	}
}
