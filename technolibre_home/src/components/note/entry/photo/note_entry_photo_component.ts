import { useState, xml } from "@odoo/owl";

import { EnhancedComponent } from "../../../../js/enhancedComponent";
import { NoteEntryDragComponent } from "../drag/note_entry_drag_component";
import { NoteEntryDeleteComponent } from "../delete/note_entry_delete_component";

export class NoteEntryPhotoComponent extends EnhancedComponent {
	static template = xml`
		<div
			class="note-entry-component note-entry-photo-component"
			t-att-data-id="props.id"
			t-att-class="{
				'not-empty': props.params.path
			}"
		>
			<NoteEntryDeleteComponent id="props.id" editMode="props.editMode" deleteEntry.bind="props.deleteEntry" />
			<div
				class="note-entry__content"
			>
				NoteEntryPhotoComponent
			</div>
			<NoteEntryDragComponent editMode="props.editMode" />
		</div>
	`;

	static components = { NoteEntryDragComponent, NoteEntryDeleteComponent };

	state: any = undefined;

	setup() {
		this.state = useState({});
	}
}
