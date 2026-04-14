import { xml } from "@odoo/owl";

import { EnhancedComponent } from "../../../js/enhancedComponent";

import DragIcon from "../../../assets/icon/drag.svg";

export class NoteEntryDragComponent extends EnhancedComponent {
	static template = xml`
		<div
			class="note-entry-drag-component"
			t-att-class="{
				'active': props.editMode
			}"
			t-att-aria-hidden="props.editMode ? 'false' : 'true'"
			t-att-aria-label="props.editMode ? 'Glisser pour réordonner' : null"
		>
			<img src="${DragIcon}" alt="" aria-hidden="true" />
		</div>
	`;
}
