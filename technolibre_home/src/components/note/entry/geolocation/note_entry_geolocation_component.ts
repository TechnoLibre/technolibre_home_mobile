import { xml } from "@odoo/owl";

import { EnhancedComponent } from "../../../../js/enhancedComponent";

import { NoteEntryDragComponent } from "../drag/note_entry_drag_component";

export class NoteEntryGeolocationComponent extends EnhancedComponent {
	static template = xml`
		<div
			class="note-entry-component note-entry-geolocation-component"
			t-att-data-id="props.id"
		>
			<NoteEntryDragComponent editMode="props.editMode" />
			<div class="note-entry__content">
				<p>This is where the geolocation data will be set</p>
			</div>
		</div>
	`;

	static components = { NoteEntryDragComponent };
}
