import { xml } from "@odoo/owl";

import { EnhancedComponent } from "../../../../js/enhancedComponent";

export class NoteEntryTextComponent extends EnhancedComponent {
	static template = xml`
		<textarea
			t-att-id="props.id"
			t-att-disabled="props.params.readonly ? true : false"
			class="note-entry__text"
			placeholder="Text"
			t-model="props.params.text"
		></textarea>
	`;
}
