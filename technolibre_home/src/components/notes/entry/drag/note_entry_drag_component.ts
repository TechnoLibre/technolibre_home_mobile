import { Component, useState, xml } from "@odoo/owl";

export class NoteEntryDragComponent extends Component {
	static template = xml`
		<div id="note-entry-drag-component">
			<h1>NoteEntryDrag</h1>
		</div>
	`;

	static components = {};

	state: any = undefined;

	setup() {
		this.state = useState({});
	}
}
