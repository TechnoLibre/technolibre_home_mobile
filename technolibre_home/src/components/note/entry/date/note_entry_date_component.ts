import { xml } from "@odoo/owl";

import { EnhancedComponent } from "../../../../js/enhancedComponent";
import { events } from "../../../../js/events";
import { helpers } from "../../../../js/helpers";

export class NoteEntryDateComponent extends EnhancedComponent {
	static template = xml`
		<button
			class="note-entry__date__button"
			t-on-click.stop.prevent="onDateButtonClick"
		>
			<t t-esc="formatDate(props.params.date)"></t>
		</button>
	`;

	formatDate(date: string) {
		return helpers.formatDate(date);
	}

	onDateButtonClick() {
		this.eventBus.trigger(events.DATE_PICKER, {
			entryId: this.props.id
		});
	}
}