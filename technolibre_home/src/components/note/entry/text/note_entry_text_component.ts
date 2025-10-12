import { xml } from "@odoo/owl";

import { EnhancedComponent } from "../../../../js/enhancedComponent";

import { NoteEntryDragComponent } from "../drag/note_entry_drag_component";

export class NoteEntryTextComponent extends EnhancedComponent {
	static template = xml`
		<div
			class="note-entry-component note-entry-text-component"
			t-att-data-id="props.id"
		>
			<NoteEntryDragComponent editMode="props.editMode" />
			<div class="note-entry__content">
				<textarea
					t-att-id="props.id"
					t-att-disabled="props.params.readonly ? true : false"
					class="note-entry__text"
					placeholder="Text"
					t-model="props.params.text"
				></textarea>
			</div>
		</div>
	`;

	static components = { NoteEntryDragComponent };
}
