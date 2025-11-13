import { xml } from "@odoo/owl";
import { EnhancedComponent } from "../../../../js/enhancedComponent";

import DragIcon from "../../../../assets/icon/drag.svg";

export class NoteListItemHandleComponent extends EnhancedComponent {
	static template = xml`
		<div
			class="notes-item-handle-component"
			t-att-class="{
				'active': props.editMode
			}"
			t-on-click.stop.prevent="() => {}"
		>
			<img src="${DragIcon}" />
		</div>
	`;
}
