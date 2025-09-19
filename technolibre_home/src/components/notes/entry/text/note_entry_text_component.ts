import { xml } from "@odoo/owl";

import { EnhancedComponent } from "../../../../js/enhancedComponent";

import { NoteEntryDragComponent } from "../drag/note_entry_drag_component";

export class NoteEntryTextComponent extends EnhancedComponent {
	static template = xml`
		<div class="note-entry-component note-entry-text-component">
			<NoteEntryDragComponent editMode="props.editMode" />
			<div class="note-entry__content">
				<p>NoteEntryText</p>
			</div>
		</div>
	`;

	static components = { NoteEntryDragComponent };
}
