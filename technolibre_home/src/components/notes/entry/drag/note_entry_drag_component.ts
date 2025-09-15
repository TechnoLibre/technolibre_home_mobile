import { Component, useState, xml } from "@odoo/owl";

import DragIcon from "../../../../assets/icon/drag.svg";

export class NoteEntryDragComponent extends Component {
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

	static components = {};

	state: any = undefined;

	setup() {
		this.state = useState({});
	}
}
