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
		>
			<img src="${DragIcon}" />
		</div>
	`;
}
