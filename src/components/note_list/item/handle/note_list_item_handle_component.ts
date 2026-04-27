import { xml } from "@odoo/owl";
import { EnhancedComponent } from "../../../../js/enhancedComponent";

import DragIcon from "../../../../assets/icon/drag.svg";

export class NoteListItemHandleComponent extends EnhancedComponent {
    // Module-level constants exposed to the static template so the xml`...`
    // literal stays interpolation-free and AOT-precompilable.
    dragIcon = DragIcon;

	static template = xml`
		<div
			class="notes-item-handle-component"
			t-att-class="{
				'active': props.editMode
			}"
			t-on-click.stop.prevent="() => {}"
		>
			<img t-att-src="dragIcon" />
		</div>
	`;
}
