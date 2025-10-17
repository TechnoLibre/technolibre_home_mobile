import { xml } from "@odoo/owl";

import { EnhancedComponent } from "../../../../js/enhancedComponent";
import { events } from "../../../../js/events";
import { helpers } from "../../../../js/helpers";

import { NoteEntryDeleteComponent } from "../delete/note_entry_delete_component";
import { NoteEntryDragComponent } from "../drag/note_entry_drag_component";

export class NoteEntryDateComponent extends EnhancedComponent {
	static template = xml`
		<div
			class="note-entry-component note-entry-date-component"
			t-att-data-id="props.id"
		>
			<NoteEntryDeleteComponent
				id="props.id"
				editMode="props.editMode"
				deleteEntry.bind="props.deleteEntry"
			/>
			<div
				class="note-entry__content"
			>
				<button
					class="note-entry__date__button"
					t-on-click.stop.prevent="onDateButtonClick"
				>
					<t t-esc="formatDate(props.params.date)"></t>
				</button>
			</div>
			<NoteEntryDragComponent
				editMode="props.editMode"
			/>
		</div>
	`;

	static components = { NoteEntryDeleteComponent, NoteEntryDragComponent };

	formatDate(date: string) {
		return helpers.formatDate(date);
	}

	onDateButtonClick() {
		this.eventBus.trigger(events.DATE_PICKER, {
			entryId: this.props.id
		});
	}
}