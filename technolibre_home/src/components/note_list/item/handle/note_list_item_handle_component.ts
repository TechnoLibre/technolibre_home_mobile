import { Component, useState, xml } from "@odoo/owl";

export class NoteListItemHandleComponent extends Component {
	static template = xml`
		<div id="note-list-item-handle-component">
			<h1>NoteListItemHandle</h1>
		</div>
	`;

	static components = {};

	state: any = undefined;

	setup() {
		this.state = useState({});
	}
}
