import { xml } from "@odoo/owl";

import { EnhancedComponent } from "../../../../js/enhancedComponent";

import { NoteEntryDeleteComponent } from "../delete/note_entry_delete_component";
import { NoteEntryDragComponent } from "../drag/note_entry_drag_component";

export class NoteEntryTextComponent extends EnhancedComponent {
	static template = xml`
		<div
			class="note-entry-component note-entry-text-component"
			t-att-data-id="props.id"
		>
			<NoteEntryDeleteComponent id="props.id" editMode="props.editMode" deleteEntry.bind="props.deleteEntry" />
			<div class="note-entry__content">
				<textarea
					t-att-id="props.id"
					t-att-disabled="props.params.readonly ? true : false"
					class="note-entry__text"
					placeholder="Text"
					t-model="props.params.text"
				></textarea>
			</div>
			<NoteEntryDragComponent editMode="props.editMode" />
		</div>
	`;

	static components = { NoteEntryDeleteComponent, NoteEntryDragComponent };
}
