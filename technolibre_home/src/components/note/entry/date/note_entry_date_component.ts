import { xml } from "@odoo/owl";

import { EnhancedComponent } from "../../../../js/enhancedComponent";

import { NoteEntryDeleteComponent } from "../delete/note_entry_delete_component";
import { NoteEntryDragComponent } from "../drag/note_entry_drag_component";
import { helpers } from "../../../../js/helpers";

export class NoteEntryDateComponent extends EnhancedComponent {
	static template = xml`
		<div
			class="note-entry-component note-entry-date-component"
			t-att-data-id="props.id"
		>
			<NoteEntryDeleteComponent id="props.id" editMode="props.editMode" deleteEntry.bind="props.deleteEntry" />
			<div class="note-entry__content">
				<t t-esc="formatDate(props.params.date)"></t>
			</div>
			<NoteEntryDragComponent editMode="props.editMode" />
		</div>
	`;

	static components = { NoteEntryDeleteComponent, NoteEntryDragComponent };

	formatDate(date: string) {
		return helpers.formatDate(date);
	}
}