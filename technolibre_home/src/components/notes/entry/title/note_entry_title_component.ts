import { xml } from "@odoo/owl";

import { EnhancedComponent } from "../../../../js/enhancedComponent";

import { NoteEntryDragComponent } from "../drag/note_entry_drag_component";

export class NoteEntryTitleComponent extends EnhancedComponent {
	static template = xml`
		<div class="note-entry-component note-entry-title-component">
			<div class="note-entry__content">
				<h1 class="note-entry__title">NoteEntryTitle</h1>
			</div>
		</div>
	`;

	static components = { NoteEntryDragComponent };
}
