import { xml } from "@odoo/owl";

import { EnhancedComponent } from "../../../js/enhancedComponent";

import DragIcon from "../../../assets/icon/drag.svg";

export class NoteEntryDragComponent extends EnhancedComponent {
    // Module-level constants exposed to the static template so the xml`...`
    // literal stays interpolation-free and AOT-precompilable.
    dragIcon = DragIcon;

	static template = xml`
		<div
			class="note-entry-drag-component"
			t-att-class="{
				'active': props.editMode
			}"
			t-att-aria-hidden="props.editMode ? 'false' : 'true'"
			t-att-aria-label="props.editMode ? 'Glisser pour réordonner' : null"
		>
			<img t-att-src="dragIcon" alt="" aria-hidden="true" />
		</div>
	`;
}
